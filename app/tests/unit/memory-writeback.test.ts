import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const { IMPORT_LINE, MemoryWriteback, notesFor, parseNotes, renderNotes, stripAppText, withImport, withSection, writeScript } = wb;

const note = (body: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({ id: `m-${body.slice(0, 6)}`, scope: 'global', scopeId: 'global', body, source: 'app', approvedForReuse: true, updatedAt: '', ...extra });
const MINE = '# My notes\n\nPrefer short answers.\n';
const data = () => mkdtempSync(join(tmpdir(), 'amw-wbdata-'));
const read = (h: string, f: string) => readFileSync(join(h, f), 'utf8');

function home(files: Record<string, string> = {}, dirs = ['.claude', '.codex']): string {
  const h = mkdtempSync(join(tmpdir(), 'amw-wbhome-'));
  for (const d of dirs) mkdirSync(join(h, d), { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(h, f), body);
  return h;
}

describe('the app’s text in a CLI file', () => {
  it('adds the import line once, and taking it out gives the file back (with or without its comment)', () => {
    const once = withImport(MINE, 'me');
    expect(once.startsWith(MINE)).toBe(true);
    expect(withImport(once, 'me')).toBe(once);
    expect(stripAppText(once)).toBe(MINE);
    expect(stripAppText(`${MINE}\n${IMPORT_LINE}\n`)).toBe(MINE);
    expect(withImport(`${MINE}\n${IMPORT_LINE}\n`, 'me')).toBe(`${MINE}\n${IMPORT_LINE}\n`); // a bare line counts: no second import
  });

  it('replaces only its own section in AGENTS.md; text after it stays', () => {
    const after = 'Text the user added below later.\n';
    const second = withSection(`${withSection(MINE, [{ body: 'one' }], 'me')}\n${after}`, [{ body: 'one' }, { body: 'two' }], 'me');
    expect(second.startsWith(MINE)).toBe(true);
    expect(second.endsWith(after)).toBe(true);
    expect(second).toContain('- two');
    expect(stripAppText(withSection(MINE, [{ body: 'one' }], 'me'))).toBe(MINE);
  });

  it('keeps each note’s Markdown (lists, code) and reads it back', () => {
    const text = renderNotes([{ body: '- Use pnpm' }, { title: 'Commands', body: '## Commands\n\n- Build: `npm run build`\n\n```sh\nnpm test\n```' }]);
    expect(text).toBe('- Use pnpm\n\n### Commands\n\n- Build: `npm run build`\n\n```sh\nnpm test\n```');
    expect(parseNotes(text).map((n) => n.body)).toEqual(['Use pnpm', '## Commands\n\n- Build: `npm run build`\n\n```sh\nnpm test\n```']);
  });

  it('is never read back as the user’s notes', () => {
    const claudeMd = withImport('- Reply in Chinese.\n- Keep commits small.\n', 'me');
    const agentsMd = withSection('## Testing\nRun the tests.\n', [{ body: 'Reply in Chinese.' }], 'me');
    const found = candidatesFrom(undefined, '/h', [{ path: '/h/.claude/CLAUDE.md', content: claudeMd }, { path: '/h/.codex/AGENTS.md', content: agentsMd }], []);
    expect(found.map((c) => c.body).join('\n')).not.toMatch(/agent-workspace|Agent Workspace/);
    expect(found.filter((c) => c.file === '~/.codex/AGENTS.md').map((c) => c.title)).toEqual(['Testing']);
  });
});

describe('what is shared', () => {
  it('active, approved user memory; not a CLI’s own notes back to it (unless edited in the app)', () => {
    const fromAgents = 'instructions|local|~/.codex/AGENTS.md|testing';
    const records = [
      note('Reply in Chinese.', { importKeys: ['claude-memory|neptune|~/.claude/projects/x/memory/a.md'] }),
      note('From my AGENTS.md', { importKeys: [fromAgents], importedHash: 'x' }), // edited (hash differs)
      note('Also from it', { importKeys: [fromAgents], importedHash: wbHash('Also from it') }),
      note('Retired', { sourceRemoved: true }),
      note('Project only', { scope: 'project', scopeId: 'p1' }),
      note('Not approved', { approvedForReuse: false }),
    ];
    expect(notesFor('local', '~/.codex/AGENTS.md', records).notes.map((n) => n.body)).toEqual(['Reply in Chinese.', 'From my AGENTS.md']);
    expect(notesFor('neptune', '~/.codex/AGENTS.md', records).notes.map((n) => n.body)).toEqual(['Reply in Chinese.', 'From my AGENTS.md', 'Also from it']);
  });

  it('over the size limit: notes written in the app first, then the newest; the rest are named, not lost', () => {
    const big = (c: string) => c.repeat(9000);
    const records = [
      note(big('a'), { importKeys: ['claude-memory|local|~/.claude/projects/x/memory/old.md'], updatedAt: '2026-01-01T00:00:00Z' }),
      note(big('b'), { importKeys: ['claude-memory|local|~/.claude/projects/x/memory/new.md'], updatedAt: '2026-06-01T00:00:00Z' }),
      note(big('c'), { importKeys: ['claude-memory|local|~/.claude/projects/x/memory/mid.md'], updatedAt: '2026-03-01T00:00:00Z' }),
      note('Written in the app, last.', { updatedAt: '2026-01-02T00:00:00Z' }),
    ];
    const r = notesFor('local', '~/.codex/AGENTS.md', records);
    // In their own order: the app's note and the newest import fit; the oldest import is left out.
    expect(r.notes.map((n) => n.body[0])).toEqual(['b', 'W']);
    expect(r.dropped).toBe(2);
    expect(r.left).toEqual([records[0].id, records[2].id]);
    expect([...r.covered].sort()).toEqual([records[1].id, records[3].id].sort());
  });
});

function wbHash(body: string): string {
  // same as memory-import bodyHash
  return createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

describe('on this Mac: nothing is deleted or overwritten', () => {
  it('links: backs up first (kept for good, plus a copy on the machine), marks its text with its owner', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE, '.codex/AGENTS.md': MINE });
    const w = new MemoryWriteback(data(), h);
    const r = await w.write('local', [note('Reply in Chinese.')], 'link');
    expect(r.errors).toEqual([]);
    expect(read(h, '.claude/CLAUDE.md')).toBe(withImport(MINE, w.owner));
    expect(read(h, '.agent-workspace/memory/user.md')).toContain(`owner=${w.owner}`);
    expect(read(h, '.codex/AGENTS.md').startsWith(MINE)).toBe(true);
    expect(w.backupContent(w.backups().find((b) => b.original && b.path.endsWith('CLAUDE.md'))!.id)).toBe(MINE);
    expect(readdirSync(join(h, '.agent-workspace/backups')).sort()).toEqual([expect.stringMatching(/^AGENTS\.md\.before-agent-workspace\./), expect.stringMatching(/^CLAUDE\.md\.before-agent-workspace\./)]);
    // In sync: nothing to do. A new note: only the app's own text changes.
    expect((await w.write('local', [note('Reply in Chinese.')], 'sync')).written).toEqual([]);
    const claudeBefore = read(h, '.claude/CLAUDE.md');
    expect((await w.write('local', [note('Reply in Chinese.'), note('Short commits.')], 'sync')).written).toHaveLength(2);
    expect(read(h, '.claude/CLAUDE.md')).toBe(claudeBefore);
    expect(read(h, '.codex/AGENTS.md').startsWith(MINE)).toBe(true);
  });

  it('writes through a symlinked CLAUDE.md to its target (dotfiles keep working)', async () => {
    const h = home();
    const dotfiles = mkdtempSync(join(tmpdir(), 'amw-dotfiles-'));
    writeFileSync(join(dotfiles, 'CLAUDE.md'), MINE);
    symlinkSync(join(dotfiles, 'CLAUDE.md'), join(h, '.claude/CLAUDE.md'));
    const w = new MemoryWriteback(data(), h);
    await w.write('local', [note('a')], 'link');
    expect(lstatSync(join(h, '.claude/CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read(dotfiles, 'CLAUDE.md')).toBe(withImport(MINE, w.owner));
  });

  it('leaves the app’s own text alone once it was changed outside the app, until the user chooses', async () => {
    const h = home({ '.codex/AGENTS.md': MINE });
    const w = new MemoryWriteback(data(), h);
    await w.write('local', [note('a')], 'link');
    const tampered = read(h, '.codex/AGENTS.md').replace('\n- a\n', '\n- a\n- typed here by hand\n');
    writeFileSync(join(h, '.codex/AGENTS.md'), tampered);
    const r = await w.write('local', [note('a'), note('b')], 'sync');
    expect(r.notices.join(' ')).toMatch(/changed outside the app/);
    expect(read(h, '.codex/AGENTS.md')).toBe(tampered);
    expect(w.targets('local').find((t) => t.kind === 'codex-md')?.paused).toBe('edited');
    // "Keep those edits": the notes there come back for user memory, then writing resumes.
    expect((await w.resolve('local', 'codex-md', 'adopt')).map((n) => n.body)).toEqual(['a', 'typed here by hand']);
    await w.write('local', [note('a'), note('typed here by hand'), note('b')], 'sync');
    expect(read(h, '.codex/AGENTS.md')).toContain('- b');
  });

  it('does not put back a line or section the user removed by hand; "Put it back" does', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE, '.codex/AGENTS.md': MINE });
    const w = new MemoryWriteback(data(), h);
    await w.write('local', [note('a')], 'link');
    writeFileSync(join(h, '.claude/CLAUDE.md'), MINE);
    writeFileSync(join(h, '.codex/AGENTS.md'), MINE);
    const r = await w.write('local', [note('a'), note('b')], 'sync');
    expect(read(h, '.claude/CLAUDE.md')).toBe(MINE);
    expect(read(h, '.codex/AGENTS.md')).toBe(MINE);
    expect(r.notices.filter((n) => /removed/.test(n))).toHaveLength(2);
    await w.resolve('local', 'claude-md', 'resume');
    await w.write('local', [note('a'), note('b')], 'sync');
    expect(read(h, '.claude/CLAUDE.md')).toBe(withImport(MINE, w.owner));
    expect(read(h, '.codex/AGENTS.md')).toBe(MINE);
  });

  it('never touches text another Agent Workspace keeps (two installs on one machine)', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE });
    const first = new MemoryWriteback(data(), h);
    const second = new MemoryWriteback(data(), h);
    await first.write('local', [note('from the first')], 'link');
    const before = read(h, '.agent-workspace/memory/user.md');
    const r = await second.write('local', [note('from the second')], 'link');
    expect(r.notices.join(' ')).toMatch(/another Agent Workspace/);
    expect(read(h, '.agent-workspace/memory/user.md')).toBe(before);
    await second.unlink('local');
    expect(read(h, '.claude/CLAUDE.md')).toBe(withImport(MINE, first.owner));
  });

  it('writes nothing, and keeps no backup, when the file changed after it was read', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE });
    class Racing extends MemoryWriteback {
      async read(host: string) {
        const files = await super.read(host);
        writeFileSync(join(h, '.claude/CLAUDE.md'), `${MINE}typed meanwhile\n`);
        return files;
      }
    }
    const w = new Racing(data(), h);
    const r = await w.write('local', [note('a')], 'link');
    expect(r.errors.join(' ')).toMatch(/changed since it was read/);
    expect(read(h, '.claude/CLAUDE.md')).toBe(`${MINE}typed meanwhile\n`);
    expect(w.backups().filter((b) => b.path.endsWith('CLAUDE.md'))).toEqual([]);
  });

  it('restores any backup (the current file backed up first) and then stops writing to it', async () => {
    const h = home({ '.codex/AGENTS.md': MINE });
    const w = new MemoryWriteback(data(), h);
    await w.write('local', [note('a')], 'link');
    const original = w.backups().find((b) => b.original && b.path.endsWith('AGENTS.md'))!;
    await w.restore(original.id);
    expect(read(h, '.codex/AGENTS.md')).toBe(MINE);
    expect(w.backupContent(w.backups().find((b) => b.reason === 'restore')!.id)).toContain('- a');
    await w.write('local', [note('a'), note('b')], 'sync');
    expect(read(h, '.codex/AGENTS.md')).toBe(MINE);
  });

  it('unlinks by taking out only what it added: the user’s text stays, a file holding only its text goes', async () => {
    const h = home({ '.claude/CLAUDE.md': MINE });
    const w = new MemoryWriteback(data(), h);
    await w.write('local', [note('a')], 'link');
    expect(existsSync(join(h, '.codex/AGENTS.md'))).toBe(true); // created by the app
    writeFileSync(join(h, '.claude/CLAUDE.md'), `${read(h, '.claude/CLAUDE.md')}\nAdded by me later.\n`);
    await w.unlink('local');
    expect(read(h, '.claude/CLAUDE.md')).toBe(`${MINE}\nAdded by me later.\n`);
    expect(existsSync(join(h, '.agent-workspace/memory/user.md'))).toBe(false);
    expect(existsSync(join(h, '.codex/AGENTS.md'))).toBe(false);
  });

  it('unlinking keeps an app-created file the user has since written in', async () => {
    const h = home();
    const w = new MemoryWriteback(data(), h);
    await w.write('local', [note('a')], 'link');
    writeFileSync(join(h, '.codex/AGENTS.md'), `${read(h, '.codex/AGENTS.md')}\n## Mine\nKeep this.\n`);
    await w.unlink('local');
    expect(read(h, '.codex/AGENTS.md')).toBe('## Mine\nKeep this.\n');
  });

  it('the remote write script refuses when the file changed', () => {
    const h = home({ 'f.md': 'old\n' });
    const r = spawnSync('/bin/sh', ['-c', writeScript(join(h, 'f.md'), 'not-the-hash', {})], { input: 'new\n' });
    expect(r.status).toBe(3);
    expect(read(h, 'f.md')).toBe('old\n');
  });
});

describe('on an SSH host', () => {
  it('reads (through symlinks), links and unlinks through the same scripts, banner and all', async () => {
    remoteHome = home({}, ['.claude']); // no Codex there
    const dot = mkdtempSync(join(tmpdir(), 'amw-rdot-'));
    writeFileSync(join(dot, 'CLAUDE.md'), MINE);
    symlinkSync(join(dot, 'CLAUDE.md'), join(remoteHome, '.claude/CLAUDE.md'));
    const w = new MemoryWriteback(data(), '/nonexistent');
    const files = await w.read('neptune');
    expect(files.map((f) => [f.kind, f.file, f.dirExists, f.exists])).toEqual([
      ['claude-md', '~/.claude/CLAUDE.md', true, true],
      ['claude-user', '~/.agent-workspace/memory/user.md', true, false],
      ['codex-md', '~/.codex/AGENTS.md', false, false],
    ]);
    expect(files[0].path).toBe(realpathSync(join(dot, 'CLAUDE.md')));
    const r = await w.write('neptune', [note('Reply in Chinese.')], 'link');
    expect(r.errors).toEqual([]);
    expect(lstatSync(join(remoteHome, '.claude/CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(read(dot, 'CLAUDE.md')).toBe(withImport(MINE, w.owner));
    expect(read(remoteHome, '.agent-workspace/memory/user.md')).toContain('- Reply in Chinese.');
    expect(existsSync(join(remoteHome, '.codex'))).toBe(false);
    await w.unlink('neptune');
    expect(read(dot, 'CLAUDE.md')).toBe(MINE);
    expect(existsSync(join(remoteHome, '.agent-workspace/memory/user.md'))).toBe(false);
  });
});

describe('linking a machine from the workspace', () => {
  it('brings its notes in, gives app agents user memory once, follows Claude memory, never deletes', async () => {
    const { Workspace } = await import('../../src/main/workspace');
    const { memoryForTask } = await import('../../src/main/memory');
    const memFile = '.claude/projects/-w-proj/memory/lang.md';
    const h = home({ '.claude/CLAUDE.md': MINE, '.codex/AGENTS.md': '## Style\nShort replies.\n' });
    mkdirSync(join(h, '.claude/projects/-w-proj/memory'), { recursive: true });
    writeFileSync(join(h, memFile), '---\nname: lang\ndescription: Reply in Chinese\ntype: feedback\n---\n\nUser-facing replies in Chinese.\n');
    const ws = new Workspace({ dataDir: data(), adapters: {}, home: h });
    try {
      const preview = await ws.linkPreview('local');
      expect(preview.incoming.map((c) => c.title).sort()).toEqual(['My notes', 'Style', 'lang']);
      expect(read(h, '.claude/CLAUDE.md')).toBe(MINE); // preview changes nothing

      const r = await ws.linkMachine('local');
      expect(r).toMatchObject({ added: 3, errors: [] });
      const userMd = read(h, '.agent-workspace/memory/user.md');
      expect(userMd).toContain('Short replies.'); // from AGENTS.md, for Claude
      expect(userMd).not.toContain('Prefer short answers'); // Claude reads its own CLAUDE.md
      expect(read(h, '.codex/AGENTS.md').startsWith('## Style\nShort replies.\n')).toBe(true);
      expect(read(h, '.codex/AGENTS.md')).toContain('Prefer short answers');

      // App agents on this Mac get user memory from the files, not a second time.
      const task = { taskId: 't1', projectId: 'p', host: undefined } as Parameters<typeof memoryForTask>[0];
      expect(memoryForTask(task, ws.snapshot().memory).filter((m) => m.scope === 'global')).toHaveLength(3);

      // Claude memory edited there: followed. Deleted there: retired, kept, no longer shared.
      writeFileSync(join(h, memFile), '---\nname: lang\ndescription: Reply in Chinese\ntype: feedback\n---\n\nUser-facing replies in Chinese; code in English.\n');
      expect((await ws.syncMemory(true))?.updated).toBe(1);
      expect(read(h, '.agent-workspace/memory/user.md')).toContain('code in English');
      rmSync(join(h, memFile));
      expect((await ws.syncMemory(true))?.removed).toBe(1);
      expect(ws.snapshot().memory.find((m) => m.title === 'lang')?.sourceRemoved).toBe(true);
      expect(read(h, '.agent-workspace/memory/user.md')).not.toContain('code in English');

      await ws.unlinkMachine('local');
      expect(read(h, '.claude/CLAUDE.md')).toBe(MINE);
      expect(read(h, '.codex/AGENTS.md')).toBe('## Style\nShort replies.\n');
      expect(ws.snapshot().memoryShare.local).toBeUndefined();
      expect(ws.snapshot().memory).toHaveLength(3); // unlinking deletes no note
    } finally {
      await ws.shutdown();
    }
  });
});

describe('keeping edits made in the app’s section', () => {
  it('adds only what was typed there, not the notes it already held', async () => {
    const { Workspace } = await import('../../src/main/workspace');
    const h = home({ '.claude/CLAUDE.md': '# My notes\n\nPrefer short answers.\n' });
    const ws = new Workspace({ dataDir: data(), adapters: {}, home: h });
    try {
      ws.addMemory({ scope: 'global', scopeId: 'global', title: 'lang', body: 'Reply in Chinese\n\nUser-facing replies in Chinese.', source: 'user', approvedForReuse: true });
      await ws.linkMachine('local');
      const agents = read(h, '.codex/AGENTS.md');
      writeFileSync(join(h, '.codex/AGENTS.md'), agents.replace('<!-- agent-workspace:user-memory:end -->', '- typed by hand\n\n<!-- agent-workspace:user-memory:end -->'));
      await ws.pushMemory();
      expect(ws.snapshot().memoryShare.local?.paused?.map((p) => p.why)).toEqual(['edited']);
      const before = ws.snapshot().memory.length;
      // The line typed under the last block ("My notes") is an edit of that note, not a second copy of it.
      expect(await ws.resolveShare('local', 'codex-md', 'adopt')).toBe(0);
      expect(ws.snapshot().memory.length).toBe(before);
      expect(ws.snapshot().memory.find((m) => m.title === 'My notes')?.body).toBe('# My notes\n\nPrefer short answers.\n\n- typed by hand');
      expect(ws.snapshot().memory.find((m) => m.title === 'lang')?.body).toBe('Reply in Chinese\n\nUser-facing replies in Chinese.');
    } finally {
      await ws.shutdown();
    }
  });
});
