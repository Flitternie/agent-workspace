import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { codeLanguage, openableKind, previewKind, resolvePosix } from '../../src/shared/preview';

// The "remote" reader runs its shell commands here instead of over SSH, so the
// realpath / size / base64 script itself is exercised without any host.
vi.mock('../../src/main/util/ssh', async (orig) => ({
  ...(await orig<typeof import('../../src/main/util/ssh')>()),
  sshRun: (_host: string, command: string) =>
    new Promise((resolve) =>
      execFile('/bin/sh', ['-c', `echo 'login banner'; ${command}`], { maxBuffer: 64 << 20 }, (e, stdout, stderr) =>
        resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout, stderr }),
      ),
    ),
}));

const { checkContained, isInside, isPrivate, localPath, readLocal, readRemote, workDirs, MAX_BYTES } = await import('../../src/main/preview');

/** The agent works in `cwd` with `roots` (its folder, worktree, project). */
const w = (cwd: string, extra: { bases?: string[]; roots?: string[]; allowOutside?: boolean } = {}) => ({ cwd, bases: extra.bases ?? [], roots: extra.roots ?? [cwd], allowOutside: extra.allowOutside });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'amw-preview-')));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, 'docs', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, 'run.sh'), 'echo hi\n');
  writeFileSync(join(root, 'tool.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(base, 'outside.txt'), 'nope');
  symlinkSync(join(base, 'outside.txt'), join(root, 'escape.txt'));
  symlinkSync(join(root, 'tool.bin'), join(root, 'innocent.txt'));
  return { base, root };
}

describe('preview path containment', () => {
  it('accepts the root and paths below it; others need a confirmation, credentials never open', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c/d.md', '/a/b')).toBe(true);
    expect(isInside('/a/bc/d.md', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
    expect(isInside('/x/b/d.md', '/a/b')).toBe(false);
    expect(isInside('/a/b/..foo', '/a/b')).toBe(true); // a file named "..foo" is inside
    expect(() => checkContained('/etc/passwd', ['/a/b', '/c'], path.posix)).toThrow(/outside the agent/);
    expect(() => checkContained('/etc/x.md', ['/a/b'], path.posix, { allowOutside: true })).not.toThrow();
    expect(() => checkContained('/c/x.md', ['/a/b', '/c'], path.posix)).not.toThrow();
    for (const f of ['/h/.ssh/config.txt', '/h/.aws/x.json', '/h/.config/gh/hosts.yml', '/h/proj/auth.json', '/h/.codex/auth.json', '/h/Library/Keychains/x.txt'])
      expect(() => checkContained(f, ['/h'], path.posix, { allowOutside: true, home: '/h' }), f).toThrow(/private location/);
    expect(isPrivate('/h/proj/notes.md', '/h', path.posix)).toBe(false);
  });

  it('resolves relative paths and .. against the cwd before checking', () => {
    const { root } = fixture();
    expect(localPath('../README.md', w(join(root, 'docs'), { roots: [root] }))).toBe(join(root, 'README.md'));
    expect(() => localPath('../outside.txt', w(root))).toThrow(/outside the agent/);
    expect(() => localPath('/etc/hosts', w(root))).toThrow(/outside the agent/);
    expect(() => localPath('missing.md', w(root))).toThrow(/not found/);
  });

  it('follows symlinks: a link out of the folder needs a confirmation, the target type decides', () => {
    const { root } = fixture();
    expect(() => readLocal('escape.txt', w(root))).toThrow(/outside the agent/);
    expect(readLocal('escape.txt', w(root, { allowOutside: true })).text).toBe('nope');
    expect(() => readLocal('innocent.txt', w(root))).toThrow(/cannot be previewed/);
  });

  it('reads text, code and images, and refuses other types', () => {
    const { root } = fixture();
    expect(readLocal('README.md', w(root))).toMatchObject({ kind: 'markdown', text: '# hi\n', path: join(root, 'README.md') });
    expect(readLocal('docs/a.png', w(root)).dataUrl).toBe('data:image/png;base64,iVBORw==');
    expect(readLocal('run.sh', w(root))).toMatchObject({ kind: 'code', text: 'echo hi\n' });
    expect(() => readLocal('tool.bin', w(root))).toThrow(/cannot be previewed/);
  });

  it('caps the size', async () => {
    const { root } = fixture();
    writeFileSync(join(root, 'big.log'), Buffer.alloc(MAX_BYTES.text + 1, 'a'));
    expect(() => readLocal('big.log', w(root))).toThrow(/too large/);
    await expect(readRemote('host', 'big.log', w(root))).rejects.toThrow(/too large/);
  });
});

/** ~/projects with a repo symlinked in from another disk, as on the user's server. */
function linkedRepo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'amw-linked-')));
  const projects = join(base, 'home/projects');
  const disk = join(base, 'mnt/disk/projects/trace');
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(disk, 'slides'), { recursive: true });
  mkdirSync(join(disk, 'outputs/deck'), { recursive: true });
  writeFileSync(join(disk, 'slides/related_work_comparison.html'), '<h1>rw</h1>');
  writeFileSync(join(disk, 'outputs/deck/notes.md'), '# deck');
  symlinkSync(disk, join(projects, 'trace'));
  return { projects, disk };
}

describe('finding the file an agent meant', () => {
  it('accepts the real path of a repo symlinked into the agent’s folder', () => {
    const { projects, disk } = linkedRepo();
    expect(readLocal(join(disk, 'slides/related_work_comparison.html'), w(projects)).text).toBe('<h1>rw</h1>');
  });

  it('tries a relative path where the agent worked (most recent first), then searches by its ending', () => {
    const { projects, disk } = linkedRepo();
    expect(localPath('slides/related_work_comparison.html', w(projects, { bases: [disk] }))).toBe(join(disk, 'slides/related_work_comparison.html'));
    expect(localPath('notes.md', w(projects, { bases: [join(disk, 'outputs/deck'), disk] }))).toBe(join(disk, 'outputs/deck/notes.md'));
    // No record of where it worked: found below its folder, through the symlink.
    expect(localPath('slides/related_work_comparison.html', w(projects))).toBe(join(disk, 'slides/related_work_comparison.html'));
  });

  it('does the same through the remote (shell) reader, in one round trip', async () => {
    const { projects, disk } = linkedRepo();
    await expect(readRemote('host', join(disk, 'slides/related_work_comparison.html'), w(projects))).resolves.toMatchObject({ kind: 'html', text: '<h1>rw</h1>' });
    await expect(readRemote('host', 'slides/related_work_comparison.html', w(projects, { bases: [disk] }))).resolves.toMatchObject({ kind: 'html' });
    await expect(readRemote('host', 'slides/related_work_comparison.html', w(projects))).resolves.toMatchObject({ kind: 'html' });
    const { root } = fixture();
    await expect(readRemote('host', 'README.md', w(root, { roots: [root, '/no/such/root'] }))).resolves.toMatchObject({ kind: 'markdown', text: '# hi\n' });
    await expect(readRemote('host', 'docs/a.png', w(root))).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,iVBORw==' });
    await expect(readRemote('host', 'escape.txt', w(root))).rejects.toThrow(/outside the agent/);
    await expect(readRemote('host', 'escape.txt', w(root, { allowOutside: true }))).resolves.toMatchObject({ text: 'nope' });
    await expect(readRemote('host', 'missing.md', w(root))).rejects.toThrow(/not found/);
    await expect(readRemote('host', 'innocent.txt', w(root))).rejects.toThrow(/cannot be previewed/);
  });

  it('reads the folders an agent worked in from its tool calls', () => {
    const term = (command: string, cwd?: string) => ({ id: command, taskId: 't', role: 'tool' as const, text: '', createdAt: '', tool: { name: 'Bash', kind: 'execute' as const, title: '', locations: [], content: [{ type: 'terminal' as const, command, cwd, output: '' }] } });
    const read = (p: string) => ({ id: p, taskId: 't', role: 'tool' as const, text: '', createdAt: '', tool: { name: 'Read', kind: 'read' as const, title: '', locations: [{ path: p }], content: [] } });
    const items = [term('cd /mnt/disk/projects/trace && git log'), read('/mnt/disk/projects/trace/outputs/deck/a.html'), term('cd outputs/deck; ls && cd "/x y"')];
    expect(workDirs(items, '/home/me/projects', path.posix)).toEqual(['/x y', '/home/me/projects/outputs/deck', '/mnt/disk/projects/trace/outputs/deck', '/mnt/disk/projects/trace']);
  });
});

describe('preview kinds and renderer paths', () => {
  it('maps extensions', () => {
    expect(previewKind('a/README.MD')).toBe('markdown');
    expect(previewKind('x.htm')).toBe('html');
    expect(previewKind('logo.svg')).toBe('image');
    expect(previewKind('data.json')).toBe('text');
    expect(previewKind('main.ts')).toBe('code');
    expect(previewKind('a.tsx')).toBe('code');
    expect(previewKind('photo.heic')).toBeUndefined();
    expect(previewKind('Makefile')).toBeUndefined();
  });

  it('colours source and structured text; only documents open in the default app', () => {
    expect(codeLanguage('src/app.tsx')).toBe('typescript');
    expect(codeLanguage('run.sh')).toBe('bash');
    expect(codeLanguage('config.yml')).toBe('yaml');
    expect(codeLanguage('notes.txt')).toBeUndefined();
    expect(openableKind('report.md')).toBe(true);
    expect(openableKind('run.sh')).toBe(false); // its default app might run it
    expect(openableKind('tool.bin')).toBe(false);
  });

  it('resolves like path.posix.resolve', () => {
    for (const [b, p] of [['/a/b', 'c.md'], ['/a/b', '../c/./d.md'], ['/a', '/x/y.md'], ['/a', '../../..'], ['/a/', 'b//c']])
      expect(resolvePosix(b, p)).toBe(path.posix.resolve(b, p));
  });
});
