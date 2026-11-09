import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// "SSH" runs the same scripts in a local shell with HOME set to a fake host home.
let remoteHome = '';
const sh = (command: string, input?: Buffer) => {
  const r = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, HOME: remoteHome }, input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: `Welcome banner\n${r.stdout.toString()}`, stderr: r.stderr.toString() };
};
vi.mock('../../src/main/util/ssh', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/ssh')>()),
  sshRun: vi.fn(async (_host: string, command: string) => sh(command)),
  sshRunInput: vi.fn(async (_host: string, command: string, input: Buffer) => sh(command, input)),
}));

const { folderHash, HASH_SH, parseFrontmatter, parseRemoteScan, remoteScanScript, scanLocal, SkillLibrary } = await import('../../src/main/skills');

function skill(dir: string, name: string, description: string, extra: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`);
  for (const [f, body] of Object.entries(extra)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
}

describe('skill files', () => {
  it('reads name and description, including folded ones', () => {
    expect(parseFrontmatter('---\nname: pdf\ndescription: "Read PDFs"\nallowed-tools: Bash\n---\nbody')).toEqual({ name: 'pdf', description: 'Read PDFs' });
    expect(parseFrontmatter('---\nname: x\ndescription: >\n  Two\n  lines\n---\n')).toEqual({ name: 'x', description: 'Two lines' });
    expect(parseFrontmatter('# no frontmatter')).toEqual({});
  });

  it('hashes a folder the same here and in the shell script used on hosts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amw-hash-'));
    skill(dir, 'h', 'd', { 'scripts/run.sh': 'echo hi\n', 'ref/b.md': 'B', 'ref/a b.md': 'A', '.DS_Store': 'x', '.git/HEAD': 'y' });
    const shell = execFileSync('/bin/sh', ['-c', HASH_SH], { cwd: dir, encoding: 'utf8' }).trim();
    expect(shell).toMatch(/^[0-9a-f]{64}$/);
    expect(folderHash(dir)).toBe(shell);
    writeFileSync(join(dir, '.DS_Store'), 'changed'); // hidden files do not count
    expect(folderHash(dir)).toBe(shell);
    writeFileSync(join(dir, 'ref/b.md'), 'B2');
    expect(folderHash(dir)).not.toBe(shell);
  });
});

describe('finding skills', () => {
  it('lists the CLIs’ skill folders on this Mac, skipping hidden ones and folders without SKILL.md', () => {
    const home = mkdtempSync(join(tmpdir(), 'amw-home-'));
    skill(join(home, '.claude/skills/writing'), 'writing-style', 'How I write');
    skill(join(home, '.codex/skills/linkedin'), 'linkedin', 'Profiles');
    skill(join(home, '.codex/skills/.system/creator'), 'creator', 'bundled');
    mkdirSync(join(home, '.claude/skills/synced/bucket'), { recursive: true });
    const found = scanLocal(home);
    expect(found.map((f) => [f.source, f.name]).sort()).toEqual([
      ['claude', 'writing-style'],
      ['codex', 'linkedin'],
    ]);
  });

  it('lists skills on a host in one round trip, banner and all', () => {
    remoteHome = mkdtempSync(join(tmpdir(), 'amw-rhome-'));
    skill(join(remoteHome, '.claude/skills/tacc'), 'tacc-vista', 'Run jobs on TACC');
    const r = sh(remoteScanScript());
    const found = parseRemoteScan('neptune', r.stdout);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ host: 'neptune', source: 'claude', name: 'tacc-vista', description: 'Run jobs on TACC', hash: folderHash(join(remoteHome, '.claude/skills/tacc')) });
  });
});

describe('the library', () => {
  let lib: InstanceType<typeof SkillLibrary>;
  beforeEach(() => {
    lib = new SkillLibrary(mkdtempSync(join(tmpdir(), 'amw-data-')));
    remoteHome = mkdtempSync(join(tmpdir(), 'amw-rhome-'));
  });

  it('starts empty, as a Claude Code plugin folder', () => {
    expect(lib.list()).toEqual([]);
    expect(lib.localLoad()).toBeUndefined();
    expect(JSON.parse(readFileSync(join(lib.pluginDir, '.claude-plugin/plugin.json'), 'utf8')).name).toBe('workspace');
  });

  it('imports from this Mac (following symlinks, without hidden files), disables, removes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'amw-home-'));
    const real = mkdtempSync(join(tmpdir(), 'amw-real-'));
    skill(real, 'writing-style', 'How I write', { 'examples.md': 'e', '.git/HEAD': 'x' });
    mkdirSync(join(home, '.claude/skills'), { recursive: true });
    symlinkSync(real, join(home, '.claude/skills/writing'));
    const [found] = scanLocal(home);
    await lib.import(found);
    expect(existsSync(join(lib.root, 'writing-style/examples.md'))).toBe(true);
    expect(existsSync(join(lib.root, 'writing-style/.git'))).toBe(false);
    expect(lib.list()).toMatchObject([{ name: 'writing-style', enabled: true, hash: found.hash, origin: { source: 'claude' } }]);
    expect(lib.localLoad()).toEqual({ pluginDir: lib.pluginDir, root: lib.root });

    lib.setEnabled('writing-style', false);
    expect(lib.list()[0].enabled).toBe(false);
    expect(lib.localLoad()).toBeUndefined();
    lib.setEnabled('writing-style', true);
    lib.remove('writing-style');
    expect(lib.list()).toEqual([]);
    expect(existsSync(real)).toBe(true); // the original is untouched
  });

  it('imports from a host and copies the library to a host only when it changed', async () => {
    skill(join(remoteHome, '.codex/skills/tacc'), 'tacc-vista', 'Run jobs', { 'scripts/submit.sh': '#!/bin/sh\n' });
    const [found] = parseRemoteScan('neptune', sh(remoteScanScript()).stdout);
    await lib.import(found);
    expect(readFileSync(join(lib.root, 'tacc-vista/scripts/submit.sh'), 'utf8')).toBe('#!/bin/sh\n');
    expect(lib.list()[0].hash).toBe(found.hash);

    const load = await lib.ensureOnHost('neptune');
    expect(load).toEqual({ pluginDir: join(remoteHome, '.agent-workspace/skills'), root: join(remoteHome, '.agent-workspace/skills/skills') });
    expect(existsSync(join(load!.root, 'tacc-vista/SKILL.md'))).toBe(true);
    expect(existsSync(join(load!.pluginDir, '.claude-plugin/plugin.json'))).toBe(true);
    expect(readFileSync(join(load!.pluginDir, '.amw-hash'), 'utf8')).toBe(lib.libraryHash());

    const ssh = await import('../../src/main/util/ssh');
    const copies = () => vi.mocked(ssh.sshRunInput).mock.calls.length;
    const before = copies();
    await lib.ensureOnHost('neptune');
    expect(copies()).toBe(before); // unchanged: no copy

    lib.setEnabled('tacc-vista', false);
    expect(await lib.ensureOnHost('neptune')).toBeUndefined(); // nothing enabled: nothing to load
    skill(join(lib.root, 'second'), 'second', 'Another');
    await lib.ensureOnHost('neptune');
    expect(copies()).toBe(before + 1);
    expect(existsSync(join(load!.root, 'second/SKILL.md'))).toBe(true);
    expect(existsSync(join(load!.root, 'tacc-vista'))).toBe(false); // disabled ones are not copied
  });
});
