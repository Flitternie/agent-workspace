import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryRecord } from '../../src/shared/types';

// "SSH" runs the same scripts in a local shell, with HOME set to a fake host home and a login banner.
let remoteHome = '';
const sh = (command: string, input?: Buffer) => {
  const r = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: remoteHome, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }, input });
  return { code: r.status ?? 1, stdout: `Last login: yesterday\n${r.stdout.toString()}`, stderr: r.stderr.toString() };
};
vi.mock('../../src/main/util/ssh', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/ssh')>()),
  sshRun: vi.fn(async (_h: string, c: string) => sh(c)),
  sshRunInput: vi.fn(async (_h: string, c: string, input: Buffer) => sh(c, input)),
}));

const wb = await import('../../src/main/memory-writeback');
const { candidatesFrom } = await import('../../src/main/memory-import');
const { BEGIN, END, IMPORT_LINE, MemoryWriteback, notesFor, plan, stripAppText, withImport, withSection, writeScript } = wb;

const note = (body: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({ id: `m-${body.slice(0, 6)}`, scope: 'global', scopeId: 'global', body, source: 'app', approvedForReuse: true, updatedAt: '', ...extra });
const MINE = '# My notes\n\nPrefer short answers.\n';

function home(files: Record<string, string> = {}, dirs = ['.claude', '.codex']): string {
  const h = mkdtempSync(join(tmpdir(), 'amw-wbhome-'));
  for (const d of dirs) mkdirSync(join(h, d), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(h, f), body);
  return h;
}

describe('the app’s text in a CLI file', () => {
  it('adds the import line once, and taking it out gives the file back', () => {
    const once = withImport(MINE);
    expect(once.startsWith(MINE)).toBe(true);
    expect(once).toContain(IMPORT_LINE);
    expect(withImport(once)).toBe(once);
    expect(stripAppText(once)).toBe(MINE);
    expect(stripAppText(withImport(''))).toBe('');
  });

  it('replaces only its own section in AGENTS.md', () => {
    const after = 'Text the user added below later.\n';
    const first = withSection(MINE, ['one']);
    const edited = `${first}\n${after}`;
    const second = withSection(edited, ['one', 'two']);
    expect(second.startsWith(MINE)).toBe(true);
    expect(second.endsWith(after)).toBe(true);
    expect(second.slice(second.indexOf(BEGIN), second.indexOf(END))).toContain('- two');
    expect(stripAppText(first)).toBe(MINE);
  });

  it('does not import its own text back as the user’s notes', () => {
    const claudeMd = withImport('- Reply in Chinese.\n- Keep commits small.\n');
    const agentsMd = withSection('## Testing\nRun the tests.\n', ['Reply in Chinese.']);
    const found = candidatesFrom(undefined, '/h', [{ path: '/h/.claude/CLAUDE.md', content: claudeMd }, { path: '/h/.codex/AGENTS.md', content: agentsMd }], []);
    expect(found.map((c) => c.body).join('\n')).not.toMatch(/agent-workspace|Agent Workspace/);
    expect(found.filter((c) => c.file === '~/.codex/AGENTS.md').map((c) => c.title)).toEqual(['Testing']);
  });
});

describe('what is shared', () => {
  it('approved user memory only, minus notes that came from that very file', () => {
    const records = [
      note('Reply in Chinese.', { importKeys: ['claude-memory|neptune|~/.claude/projects/x/memory/a.md'] }),
      note('From my AGENTS.md', { importKeys: ['instructions|local|~/.codex/AGENTS.md|testing'] }),
      note('Project only', { scope: 'project', scopeId: 'p1' }),
      note('Not approved', { approvedForReuse: false }),
    ];
    expect(notesFor('local', '~/.codex/AGENTS.md', records)).toEqual(['Reply in Chinese.']);
    expect(notesFor('neptune', '~/.codex/AGENTS.md', records)).toEqual(['Reply in Chinese.', 'From my AGENTS.md']);
  });

  it('leaves a CLI that is not set up on the machine alone', () => {
    const files = [{ host: 'local', kind: 'codex-md' as const, path: '/h/.codex/AGENTS.md', file: '~/.codex/AGENTS.md', dirExists: false, exists: false, content: '' }];
    expect(plan(files, [note('x')])[0].next).toBeNull();
  });
});

describe('on this Mac', () => {
  it('links: backs up first (kept for good, and a copy on the machine), then writes', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE, '.codex/AGENTS.md': MINE });
    const w = new MemoryWriteback(mkdtempSync(join(tmpdir(), 'amw-wbdata-')), h);
    const r = await w.write('local', [note('Reply in Chinese.')], 'link');
    expect(r.errors).toEqual([]);
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(withImport(MINE));
    expect(readFileSync(join(h, '.agent-workspace/memory/user.md'), 'utf8')).toContain('- Reply in Chinese.');
    expect(readFileSync(join(h, '.codex/AGENTS.md'), 'utf8')).toContain('- Reply in Chinese.');
    const originals = w.backups().filter((b) => b.original);
    expect(originals.map((b) => b.path).sort()).toEqual([join(h, '.claude/CLAUDE.md'), join(h, '.agent-workspace/memory/user.md'), join(h, '.codex/AGENTS.md')].sort());
    expect(w.backupContent(originals.find((b) => b.path.endsWith('CLAUDE.md'))!.id)).toBe(MINE);
    expect(readdirSync(join(h, '.agent-workspace/backups')).sort()).toEqual([expect.stringMatching(/^AGENTS\.md\.before-agent-workspace\./), expect.stringMatching(/^CLAUDE\.md\.before-agent-workspace\./)]);

    // In sync: nothing to do. A new note: only the app's file and section change.
    expect((await w.write('local', [note('Reply in Chinese.')], 'sync')).written).toEqual([]);
    const claudeBefore = readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8');
    const r2 = await w.write('local', [note('Reply in Chinese.'), note('Short commits.')], 'sync');
    expect(r2.written.sort()).toEqual([join(h, '.agent-workspace/memory/user.md'), join(h, '.codex/AGENTS.md')].sort());
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(claudeBefore);
    expect(readFileSync(join(h, '.codex/AGENTS.md'), 'utf8').startsWith(MINE)).toBe(true);
  });

  it('does not put back an import line the user took out', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE });
    const w = new MemoryWriteback(mkdtempSync(join(tmpdir(), 'amw-wbdata-')), h);
    await w.write('local', [note('a')], 'link');
    writeFileSync(join(h, '.claude/CLAUDE.md'), MINE);
    const r = await w.write('local', [note('a'), note('b')], 'sync');
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(MINE);
    expect(r.errors.join(' ')).toMatch(/line was removed/);
  });

  it('restores any backup (backing up the current file first) and unlinks either way', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE });
    const w = new MemoryWriteback(mkdtempSync(join(tmpdir(), 'amw-wbdata-')), h);
    await w.write('local', [note('a')], 'link');
    writeFileSync(join(h, '.claude/CLAUDE.md'), `${readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')}\nAdded by me later.\n`);
    const original = w.backups().find((b) => b.original && b.path.endsWith('CLAUDE.md'))!;
    await w.restore(original.id);
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(MINE);
    const before = w.backups().filter((b) => b.reason === 'restore');
    expect(w.backupContent(before[0].id)).toContain('Added by me later.');

    await w.write('local', [note('a')], 'link');
    writeFileSync(join(h, '.claude/CLAUDE.md'), `${readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')}Kept.\n`);
    await w.unlink('local', 'remove');
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(`${MINE}\nKept.\n`);
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).not.toContain('agent-workspace');
    expect(existsSync(join(h, '.agent-workspace/memory/user.md'))).toBe(false);
  });

  it('puts files back as they were before linking, including files that did not exist', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE });
    const w = new MemoryWriteback(mkdtempSync(join(tmpdir(), 'amw-wbdata-')), h);
    await w.write('local', [note('a')], 'link');
    expect(existsSync(join(h, '.codex/AGENTS.md'))).toBe(true);
    await w.unlink('local', 'original');
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(MINE);
    expect(existsSync(join(h, '.codex/AGENTS.md'))).toBe(false);
  });

  it('writes nothing when the file changed after it was read', () => {
    const h = home({ 'f.md': 'old\n' });
    const r = spawnSync('/bin/sh', ['-c', writeScript(join(h, 'f.md'), 'not-the-hash', {})], { input: 'new\n' });
    expect(r.status).toBe(3);
    expect(readFileSync(join(h, 'f.md'), 'utf8')).toBe('old\n');
  });
});

describe('on an SSH host', () => {
  it('reads, links and syncs through the same scripts, banner and all', async () => {
    remoteHome = home({ '.claude/CLAUDE.md': MINE }, ['.claude']); // no Codex there
    const w = new MemoryWriteback(mkdtempSync(join(tmpdir(), 'amw-wbdata-')), '/nonexistent');
    const files = await w.read('neptune');
    expect(files.map((f) => [f.kind, f.file, f.dirExists, f.exists])).toEqual([
      ['claude-md', '~/.claude/CLAUDE.md', true, true],
      ['claude-user', '~/.agent-workspace/memory/user.md', true, false],
      ['codex-md', '~/.codex/AGENTS.md', false, false],
    ]);
    const r = await w.write('neptune', [note('Reply in Chinese.')], 'link');
    expect(r.errors).toEqual([]);
    expect(readFileSync(join(remoteHome, '.claude/CLAUDE.md'), 'utf8')).toBe(withImport(MINE));
    expect(readFileSync(join(remoteHome, '.agent-workspace/memory/user.md'), 'utf8')).toContain('- Reply in Chinese.');
    expect(existsSync(join(remoteHome, '.codex'))).toBe(false);
    expect(readdirSync(join(remoteHome, '.agent-workspace/backups'))).toEqual([expect.stringMatching(/^CLAUDE\.md\.before-agent-workspace\./)]);
    expect(w.backupContent(w.backups().find((b) => b.original && b.path.endsWith('CLAUDE.md'))!.id)).toBe(MINE);

    await w.unlink('neptune', 'original');
    expect(readFileSync(join(remoteHome, '.claude/CLAUDE.md'), 'utf8')).toBe(MINE);
    expect(existsSync(join(remoteHome, '.agent-workspace/memory/user.md'))).toBe(false);
  });
});

describe('linking a machine from the workspace', () => {
  it('merges its notes, writes the shared memory, follows later changes, and unlinks back to the original', async () => {
    const { Workspace } = await import('../../src/main/workspace');
    const h = home({ '.claude/CLAUDE.md': MINE, '.codex/AGENTS.md': '## Style\nShort replies.\n' });
    const ws = new Workspace({ dataDir: mkdtempSync(join(tmpdir(), 'amw-wbws-')), adapters: {}, home: h });

    const preview = await ws.linkPreview('local');
    expect(preview.incoming.map((c) => c.title).sort()).toEqual(['My notes', 'Style']);
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(MINE); // preview changes nothing

    const r = await ws.linkMachine('local');
    expect(r).toMatchObject({ added: 2, errors: [] });
    expect(ws.snapshot().memoryShare.local?.linkedAt).toBeTruthy();
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(withImport(MINE));
    // Each CLI gets the note from the other one's file, not its own back.
    const userMd = readFileSync(join(h, '.agent-workspace/memory/user.md'), 'utf8');
    expect(userMd).toContain('- Style: Short replies.');
    expect(userMd).not.toContain('Prefer short answers');
    const agentsMd = readFileSync(join(h, '.codex/AGENTS.md'), 'utf8');
    expect(agentsMd.startsWith('## Style\nShort replies.\n')).toBe(true);
    expect(agentsMd).toContain('- My notes: Prefer short answers.');
    expect(agentsMd).not.toContain('- Style');

    ws.addMemory({ scope: 'global', scopeId: 'global', body: 'Reply in Chinese.', source: 'app', approvedForReuse: true });
    await ws.pushMemory();
    expect(readFileSync(join(h, '.agent-workspace/memory/user.md'), 'utf8')).toContain('Reply in Chinese.');
    expect(readFileSync(join(h, '.codex/AGENTS.md'), 'utf8')).toContain('- Reply in Chinese.');

    await ws.unlinkMachine('local', 'original');
    expect(readFileSync(join(h, '.claude/CLAUDE.md'), 'utf8')).toBe(MINE);
    expect(readFileSync(join(h, '.codex/AGENTS.md'), 'utf8')).toBe('## Style\nShort replies.\n');
    expect(ws.snapshot().memoryShare.local).toBeUndefined();
  });
});

describe('note lines', () => {
  it('turns a leading heading into "Heading: text" and keeps one line', () => {
    expect(wb.noteLine('# My notes\n\nPrefer short answers.')).toBe('My notes: Prefer short answers.');
    expect(wb.noteLine('Reply in\nChinese.')).toBe('Reply in Chinese.');
    expect(wb.noteLine('Reply in Chinese\n\nUser-facing replies in Chinese.')).toBe('Reply in Chinese. User-facing replies in Chinese.');
    expect(wb.noteLine('用中文回复\n\n代码保持英文。')).toBe('用中文回复。 代码保持英文。');
  });
});
