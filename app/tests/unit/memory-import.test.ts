import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryCandidate, MemoryRecord, Project } from '../../src/shared/types';

// "Remote" hosts run the scan script in a local /bin/sh against their own temp HOME
// (after a login banner), so the one-round-trip script is exercised without SSH.
const remoteHomes: Record<string, string> = {};
vi.mock('../../src/main/util/ssh', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/ssh')>()),
  sshHosts: () => Object.keys(remoteHomes),
  sshProbe: async () => ({ state: 'ok' }),
  loadKeychainKeys: async () => {},
  sshRun: (host: string, command: string) =>
    new Promise((resolve) =>
      execFile('/bin/sh', ['-c', `echo 'Welcome to ${host}!'; ${command}`], { env: { ...process.env, HOME: remoteHomes[host] } }, (e, stdout, stderr) =>
        resolve({ code: e ? 1 : 0, stdout, stderr }),
      ),
    ),
  sshRunInput: async (host: string, command: string, input: Buffer) => {
    const r = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: remoteHomes[host] }, input });
    return { code: r.status ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  },
}));

const { bodyHash, candidatesFrom, encodeClaudeCwd, importCandidates, markCandidates, memoryKey, parseFrontmatter, parseScanOutput, scopeForType, splitInstructions, syncUserMemory, tombstone, MAX_BODY } = await import('../../src/main/memory-import');
const { instructionsFor, memoryForTask } = await import('../../src/main/memory');
const { Workspace } = await import('../../src/main/workspace');

const temps: string[] = [];
const temp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function put(home: string, rel: string, text: string) {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), text);
}

const fm = (name: string, type: string, body: string, nested = true) =>
  `---\nname: ${name}\ndescription: "About ${name}"\n${nested ? `metadata:\n  node_type: memory\n  type: ${type}\n  originSessionId: abc` : `type: ${type}`}\n---\n\n${body}\n`;

const cand = (key: string, body: string, scope: 'global' | 'project' = 'global'): MemoryCandidate => ({ key, source: 'instructions', file: key.split('|')[2], title: body.slice(0, 10), body, truncated: false, suggestedScope: scope, alreadyImported: false, dismissed: false });

describe('parsing', () => {
  it('reads frontmatter with the type at the top or under metadata', () => {
    expect(parseFrontmatter(fm('a', 'feedback', 'Body.')).meta).toMatchObject({ name: 'a', description: 'About a', 'metadata.type': 'feedback', 'metadata.node_type': 'memory' });
    expect(parseFrontmatter(fm('b', 'project', 'x', false)).meta.type).toBe('project');
    expect(parseFrontmatter(fm('a', 'user', 'Body text.')).body.trim()).toBe('Body text.');
    expect(parseFrontmatter("---\nname: 'it''s'\ndescription: >\n  folded\n  text\n---\nhi").meta).toMatchObject({ name: "it's", description: 'folded text' });
    expect(parseFrontmatter('no frontmatter').meta).toEqual({});
  });

  it('maps memory types to user or project memory', () => {
    expect(['user', 'feedback', 'project', 'reference', undefined].map(scopeForType)).toEqual(['global', 'global', 'project', 'project', 'project']);
  });

  it('encodes a folder the way Claude Code names its project dir', () => {
    expect(encodeClaudeCwd('/Users/lynie/projects/agent_workspace')).toBe('-Users-lynie-projects-agent-workspace');
    expect(encodeClaudeCwd('/Users/lynie/projects/agent_workspace/app/.cache/x')).toBe('-Users-lynie-projects-agent-workspace-app--cache-x');
    expect(encodeClaudeCwd('/srv/repo/')).toBe('-srv-repo');
  });

  it('splits instruction files by section and drops empty ones', () => {
    const doc = '# Shared config\n\n## OpenRouter\n\nUse the key file.\n\n```\n# not a heading\n```\n\n## Empty\n\n## Style\n- short\n';
    expect(splitInstructions(doc)).toEqual([
      { section: 'openrouter', title: 'OpenRouter', body: '## OpenRouter\n\nUse the key file.\n\n```\n# not a heading\n```' },
      { section: 'style', title: 'Style', body: '## Style\n- short' },
    ]);
    expect(splitInstructions('Intro line\n# A\none\n# B\ntwo').map((s) => s.section)).toEqual(['preamble', 'a', 'b']);
    expect(splitInstructions('- Reply in Chinese\n- Run tests\n  before committing\n').map((s) => [s.section, s.body])).toEqual([
      ['item-reply-in-chinese', '- Reply in Chinese'],
      ['item-run-tests', '- Run tests\n  before committing'],
    ]);
    expect(splitInstructions('Just one paragraph.')).toEqual([{ section: 'all', title: '', body: 'Just one paragraph.' }]);
    expect(splitInstructions('  \n\n')).toEqual([]);
  });

  it('builds candidates, matches projects by folder and host, and caps long bodies', () => {
    const projects: Project[] = [
      { projectId: 'p1', name: 'aw', rootPath: '/Users/me/projects/agent_workspace', isGitRepo: true, createdAt: '' },
      { projectId: 'p2', name: 'aw-remote', rootPath: '/home/me/aw', host: 'devbox', isGitRepo: true, createdAt: '' },
    ];
    const files = [
      { path: '/Users/me/.claude/projects/-Users-me-projects-agent-workspace/memory/style.md', content: fm('style', 'project', 'Use tabs.') },
      { path: '/Users/me/.claude/projects/-home-me-aw/memory/remote.md', content: fm('remote', 'reference', 'Docs at x.') },
      { path: '/Users/me/.claude/projects/-Users-me-other/memory/chinese.md', content: fm('chinese', 'feedback', 'Reply in Chinese.') },
      { path: '/Users/me/AGENTS.md', content: `## Long\n${'x'.repeat(MAX_BODY + 50)}` },
    ];
    const c = candidatesFrom(undefined, '/Users/me', files, projects);
    expect(c.map((x) => [x.file, x.suggestedScope, x.projectId, x.folderHint])).toEqual([
      ['~/.claude/projects/-Users-me-projects-agent-workspace/memory/style.md', 'project', 'p1', undefined],
      ['~/.claude/projects/-home-me-aw/memory/remote.md', 'project', undefined, '-home-me-aw'], // p2 is on devbox, not this Mac
      ['~/.claude/projects/-Users-me-other/memory/chinese.md', 'global', undefined, undefined],
      ['~/AGENTS.md', 'global', undefined, undefined],
    ]);
    expect(c[2]).toMatchObject({ key: 'claude-memory|local|~/.claude/projects/-Users-me-other/memory/chinese.md|', title: 'chinese', body: 'About chinese\n\nReply in Chinese.', memoryType: 'feedback' });
    expect(c[3]).toMatchObject({ key: 'instructions|local|~/AGENTS.md|long', truncated: true });
    expect(c[3].body.length).toBe(MAX_BODY);
    expect(candidatesFrom('devbox', '/home/me', [{ path: '/home/me/.claude/projects/-home-me-aw/memory/remote.md', content: fm('remote', 'reference', 'x') }], projects)[0].projectId).toBe('p2');
  });

  it('ignores banner lines and needs the end marker', () => {
    const out = `Welcome!\n__AMW_MEM_HOME__\t/h\n__AMW_MEM_FILE__\t/h/AGENTS.md\t${Buffer.from('hi\n').toString('base64')}\nnoise\n`;
    expect(parseScanOutput(out)).toEqual({ home: '/h', files: [{ path: '/h/AGENTS.md', content: 'hi\n' }], complete: false });
    expect(parseScanOutput(`${out}__AMW_MEM_DONE__\n`).complete).toBe(true);
  });
});

describe('import and sync', () => {
  const state = () => ({ memory: [] as MemoryRecord[], memoryTombstones: [] as string[] });
  const A = memoryKey('instructions', undefined, '~/AGENTS.md', 'style');
  const B = memoryKey('instructions', 'devbox', '~/AGENTS.md', 'style');

  it('imports explicitly and updates instead of duplicating on re-import', () => {
    const s = state();
    importCandidates(s, [{ candidate: cand(A, 'Use tabs.'), scope: 'global', scopeId: 'global' }]);
    importCandidates(s, [{ candidate: cand(A, 'Use spaces.'), scope: 'global', scopeId: 'global' }]);
    expect(s.memory).toHaveLength(1);
    expect(s.memory[0]).toMatchObject({ body: 'Use spaces.', approvedForReuse: true, importKeys: [A], source: A });
    expect(markCandidates([cand(A, 'Use spaces.'), cand(B, 'other')], s).map((c) => c.alreadyImported)).toEqual([true, false]);
  });

  it('adds new notes and updates ones whose source changed', () => {
    const s = state();
    expect(syncUserMemory(s, [cand(A, 'Use tabs.'), cand('x|local|f|p', 'Project note', 'project')], ['local'])).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(s.memory).toHaveLength(1); // project notes are never synced automatically
    expect(syncUserMemory(s, [cand(A, 'Use tabs.')], ['local'])).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(syncUserMemory(s, [cand(A, 'Use two spaces.')], ['local'])).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(s.memory).toHaveLength(1);
    expect(s.memory[0]).toMatchObject({ body: 'Use two spaces.', scope: 'global', approvedForReuse: true, importedHash: bodyHash('Use two spaces.') });
  });

  it('leaves notes the user edited alone', () => {
    const s = state();
    syncUserMemory(s, [cand(A, 'Use tabs.')], ['local']);
    s.memory[0].body = 'Use tabs, except in YAML.';
    expect(syncUserMemory(s, [cand(A, 'Use tabs!')], ['local'])).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(s.memory).toHaveLength(1);
    expect(s.memory[0].body).toBe('Use tabs, except in YAML.');
  });

  it('never re-imports a note the user deleted (by key or by text)', () => {
    const s = state();
    syncUserMemory(s, [cand(A, 'Use tabs.')], ['local']);
    tombstone(s, s.memory[0]);
    s.memory = [];
    expect(syncUserMemory(s, [cand(A, 'Use tabs, changed.'), cand(B, 'Use tabs.')], ['local', 'devbox'])).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(s.memory).toEqual([]);
    expect(markCandidates([cand(B, 'Use tabs.')], s)[0].dismissed).toBe(true);
    // An explicit import brings it back.
    importCandidates(s, [{ candidate: cand(A, 'Use tabs, changed.'), scope: 'global', scopeId: 'global' }]);
    expect(s.memory).toHaveLength(1);
  });

  it('collapses the same text from several machines into one record', () => {
    const s = state();
    expect(syncUserMemory(s, [cand(A, 'Use  tabs.'), cand(B, 'Use tabs.\n')], ['local', 'devbox']).added).toBe(1);
    expect(s.memory).toHaveLength(1);
    expect(s.memory[0].importKeys).toEqual([A, B]);
    // devbox diverges: its text becomes its own note, the original keeps this Mac's key.
    expect(syncUserMemory(s, [cand(A, 'Use tabs.'), cand(B, 'Use spaces.')], ['local', 'devbox'])).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(s.memory.map((m) => [m.body, m.importKeys])).toEqual([
      ['Use  tabs.', [A]],
      ['Use spaces.', [B]],
    ]);
  });

  it('marks a note whose sources are gone, only for machines that were scanned', () => {
    const s = state();
    syncUserMemory(s, [cand(A, 'Use tabs.'), cand(B, 'Use tabs.')], ['local', 'devbox']);
    expect(syncUserMemory(s, [], ['local']).removed).toBe(0); // devbox was not reachable: still a source
    expect(syncUserMemory(s, [], ['local', 'devbox']).removed).toBe(1);
    expect(s.memory[0].sourceRemoved).toBe(true);
    syncUserMemory(s, [cand(B, 'Use tabs.')], ['devbox']);
    expect(s.memory[0].sourceRemoved).toBe(false);
  });
});

describe('workspace scan over SSH (local sh, temp HOME)', () => {
  it('scans this Mac and a host in one round trip, syncs user notes, keeps project notes manual, and injects them', async () => {
    const local = temp('amw-home-local-');
    const remote = temp('amw-home-remote-');
    const repo = temp('amw-repo-');
    put(local, `.claude/projects/${encodeClaudeCwd(repo)}/memory/MEMORY.md`, '- [index](x.md)');
    put(local, `.claude/projects/${encodeClaudeCwd(repo)}/memory/build.md`, fm('build', 'project', 'Run make before pushing.'));
    put(local, `.claude/projects/${encodeClaudeCwd(repo)}/memory/lang.md`, fm('lang', 'feedback', 'Reply in Chinese.'));
    put(local, '.codex/AGENTS.md', '# Me\n\n## Tests\nAlways run the tests.\n');
    put(remote, 'AGENTS.md', '## Tests\nAlways run the tests.\n\n## Remote\nUse tmux.\n');
    remoteHomes.devbox = remote;

    const dataDir = temp('amw-data-');
    const ws = new Workspace({ dataDir, adapters: {}, home: local });
    try {
      const project = await ws.addProject(repo, 'repo');
      ws.setHostEnabled('devbox', true);
      await ws.checkHost('devbox');
      const scan = await ws.scanMemoryImports();
      expect(scan.errors).toEqual([]);
      expect(scan.scanned.sort()).toEqual(['devbox', 'local']);
      expect(scan.candidates.map((c) => [c.host ?? 'local', c.file, c.title, c.suggestedScope, c.projectId]).sort()).toEqual(
        [
          ['devbox', '~/AGENTS.md', 'Remote', 'global', undefined],
          ['devbox', '~/AGENTS.md', 'Tests', 'global', undefined],
          ['local', `~/.claude/projects/${encodeClaudeCwd(repo)}/memory/build.md`, 'build', 'project', project.projectId],
          ['local', `~/.claude/projects/${encodeClaudeCwd(repo)}/memory/lang.md`, 'lang', 'global', undefined],
          ['local', '~/.codex/AGENTS.md', 'Tests', 'global', undefined],
        ].sort(),
      );

      // Only linked machines sync (linking itself is covered in memory-writeback.test.ts).
      ws.updateSettings({ memorySync: true, memoryLinks: { local: { linkedAt: 'earlier' }, devbox: { linkedAt: 'earlier' } } });
      const status = await ws.syncMemory(true);
      expect(status).toMatchObject({ added: 3, updated: 0, removed: 0, errors: [] }); // Tests ×2 collapse into one
      const user = ws.snapshot().memory.filter((m) => m.scope === 'global');
      expect(user.find((m) => m.title === 'Tests')?.importKeys).toHaveLength(2);
      expect(ws.snapshot().memory.some((m) => m.scope === 'project')).toBe(false);

      const build = (await ws.scanMemoryImports()).candidates.find((c) => c.title === 'build')!;
      expect(ws.importMemory([{ key: build.key, scope: 'project', projectId: project.projectId }])).toBe(1);
      expect((await ws.scanMemoryImports()).candidates.every((c) => c.alreadyImported)).toBe(true);

      const task = { taskId: 't1', projectId: project.projectId } as Parameters<typeof memoryForTask>[0];
      const text = instructionsFor(task, memoryForTask(task, ws.snapshot().memory))!;
      expect(text).toContain('[user preference] About lang Reply in Chinese.');
      expect(text).toContain('[project convention] About build Run make before pushing.');
      expect(text).toContain('[user preference] ## Remote Use tmux.');

      // Deleted in the app: stays deleted after the next sync.
      const remoteNote = ws.snapshot().memory.find((m) => m.title === 'Remote')!;
      ws.deleteMemory(remoteNote.id);
      expect((await ws.syncMemory(true))?.added).toBe(0);
      expect(ws.snapshot().memory.some((m) => m.title === 'Remote')).toBe(false);
    } finally {
      await ws.shutdown();
      delete remoteHomes.devbox;
    }
  });
});
