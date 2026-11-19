import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AttachmentStore, imageType, MAX_IMAGE_BYTES } from '../../src/main/attachments';
import { claudeUserContent, historyImages } from '../../src/main/providers/claude';
import { codexInput } from '../../src/main/providers/codex';
import { codexItem } from '../../src/main/providers/codex-content';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';
import { execFileSync } from 'node:child_process';

// A 1×1 PNG and a 1×1 JPEG header (enough for the format check).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

const dir = () => mkdtempSync(join(tmpdir(), 'amw-att-'));

describe('attachment store', () => {
  it('knows formats by their bytes, not their names', () => {
    expect(imageType(PNG)).toBe('image/png');
    expect(imageType(JPEG)).toBe('image/jpeg');
    expect(imageType(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
  });

  it('keeps an image once, named by its content, and refuses what is not one or too large', () => {
    const store = new AttachmentStore(dir());
    const a = store.save(PNG, 'shot.png');
    const b = store.save(PNG);
    expect(a.id).toMatch(/^[0-9a-f]{24}\.png$/);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ mediaType: 'image/png', name: 'shot.png' });
    expect(store.has(a.id)).toBe(true);
    expect(store.read(a.id).equals(PNG)).toBe(true);
    expect(() => store.save(Buffer.from('hello'))).toThrow(/Not a PNG/);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expect(() => store.save(big)).toThrow(/too large/);
    // One read back from history is kept whatever its size: the CLI already took it.
    expect(store.saveFromHistory({ data: big.toString('base64') })?.mediaType).toBe('image/png');
    expect(store.saveFromHistory({ data: Buffer.from('nope').toString('base64') })).toBeUndefined();
  });

  it('only serves names it could have made (no paths)', () => {
    const store = new AttachmentStore(dir());
    expect(store.has('../../etc/passwd')).toBe(false);
    expect(() => store.path('../x.png')).toThrow();
    expect(AttachmentStore.validId('0123456789abcdef01234567.jpg')).toBe(true);
  });
});

describe('images to the CLIs', () => {
  const file = () => {
    const p = join(dir(), 'a.png');
    writeFileSync(p, PNG);
    return p;
  };

  it('Claude gets base64 image blocks, then the text (none when there is no text)', async () => {
    const path = file();
    const content = await claudeUserContent('What is this?', [{ path, mediaType: 'image/png' }]);
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } },
      { type: 'text', text: 'What is this?' },
    ]);
    expect(await claudeUserContent('  ', [{ path, mediaType: 'image/png' }])).toHaveLength(1);
  });

  it('reads Claude image blocks back from a saved session', () => {
    expect(historyImages([{ type: 'text', text: '[Image #1] see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'image', source: { type: 'url', url: 'https://x' } }])).toEqual([
      { data: 'AAAA', mediaType: 'image/png' },
    ]);
  });

  it('Codex gets a file on this Mac and a data URL over SSH', async () => {
    const path = file();
    expect(await codexInput('Look', [{ path, mediaType: 'image/png' }], false)).toEqual([
      { type: 'text', text: 'Look', text_elements: [] },
      { type: 'localImage', path },
    ]);
    expect(await codexInput('', [{ path, mediaType: 'image/png' }], true)).toEqual([{ type: 'image', url: `data:image/png;base64,${PNG.toString('base64')}` }]);
    expect(await codexInput('Just text', [], false)).toEqual([{ type: 'text', text: 'Just text', text_elements: [] }]);
  });

  it('reads Codex images back from a thread: local files and data URLs', () => {
    const v = codexItem(
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'see' }, { type: 'localImage', path: '/tmp/a.png' }, { type: 'image', url: 'data:image/jpeg;base64,QUJD' }, { type: 'image', url: 'https://example.com/x.png' }] },
      { history: true, completed: true, cwd: '/tmp' },
    );
    expect(v).toMatchObject({ role: 'user', text: 'see', images: [{ path: '/tmp/a.png' }, { data: 'QUJD', mediaType: 'image/jpeg' }] });
    // An image-only message still shows.
    expect(codexItem({ id: 'u2', type: 'userMessage', content: [{ type: 'localImage', path: '/tmp/a.png' }] }, { history: true, completed: true, cwd: '/tmp' })?.images).toHaveLength(1);
  });
});

describe('sending images', () => {
  const opened: Workspace[] = [];
  afterEach(async () => {
    for (const ws of opened.splice(0)) await ws.shutdown();
  });
  const setup = async () => {
    const dataDir = dir();
    const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), 5) }, backgroundModel: async () => '' });
    opened.push(ws);
    const repo = dir();
    writeFileSync(join(repo, 'README.md'), '# test\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const p = await ws.addProject(repo);
    return { ws, p };
  };

  it('a message carries its images to the agent and keeps them in the conversation; one with only images is about them', async () => {
    const { ws, p } = await setup();
    const task = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
    const ref = ws.attachments.save(PNG, 'shot.png');
    const r = await ws.send(task.taskId, '', 'text', { images: [ref] });
    expect(r.ok).toBe(true);
    const user = ws.transcript(task.taskId).find((i) => i.role === 'user')!;
    expect(user.images).toEqual([ref]);
    expect(ws.snapshot().tasks.find((t) => t.taskId === task.taskId)!.title).toBe('[image]');
    // The mock notes what reached it.
    const session = (ws as unknown as { live: Map<string, { session: { history?: { messages: Array<{ role: string; text: string }> } } }> }).live.get(task.taskId)!.session;
    expect(session.history!.messages.find((m) => m.role === 'user')!.text).toBe('[1 image: image/png]');
  });

  it('refuses images that are no longer stored', async () => {
    const { ws, p } = await setup();
    const task = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
    const r = await ws.send(task.taskId, 'see', 'text', { images: [{ id: '0123456789abcdef01234567.png', mediaType: 'image/png' }] });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no longer stored/) });
    expect(ws.transcript(task.taskId).some((i) => i.role === 'user')).toBe(false);
  });
});
