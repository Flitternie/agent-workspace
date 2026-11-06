import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { previewKind, resolvePosix } from '../../src/shared/preview';

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

const { checkContained, isInside, localPath, readLocal, readRemote, MAX_BYTES } = await import('../../src/main/preview');

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'amw-preview-')));
  const root = join(base, 'repo');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hi\n');
  writeFileSync(join(root, 'docs', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, 'run.sh'), 'echo hi\n');
  writeFileSync(join(base, 'secret.txt'), 'nope');
  symlinkSync(join(base, 'secret.txt'), join(root, 'escape.txt'));
  symlinkSync(join(root, 'run.sh'), join(root, 'innocent.txt'));
  return { base, root };
}

describe('preview path containment', () => {
  it('accepts the root and paths below it, nothing beside or above', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/c/d.md', '/a/b')).toBe(true);
    expect(isInside('/a/bc/d.md', '/a/b')).toBe(false);
    expect(isInside('/a', '/a/b')).toBe(false);
    expect(isInside('/x/b/d.md', '/a/b')).toBe(false);
    expect(isInside('/a/b/..foo', '/a/b')).toBe(true); // a file named "..foo" is inside
    expect(() => checkContained('/etc/passwd', ['/a/b', '/c'], path.posix)).toThrow(/inside this agent/);
    expect(() => checkContained('/c/x.md', ['/a/b', '/c'], path.posix)).not.toThrow();
  });

  it('resolves relative paths and .. against the cwd before checking', () => {
    const { root } = fixture();
    expect(localPath(join(root, 'docs'), '../README.md', [root])).toBe(join(root, 'README.md'));
    expect(() => localPath(root, '../secret.txt', [root])).toThrow(/inside this agent/);
    expect(() => localPath(root, '/etc/hosts', [root])).toThrow(/inside this agent/);
    expect(() => localPath(root, 'missing.md', [root])).toThrow(/not found/);
  });

  it('follows symlinks: a link out of the folder is refused, the target type decides', () => {
    const { root } = fixture();
    expect(() => readLocal(root, 'escape.txt', [root])).toThrow(/inside this agent/);
    expect(() => readLocal(root, 'innocent.txt', [root])).toThrow(/cannot be previewed/);
  });

  it('reads text and images, and refuses other types', () => {
    const { root } = fixture();
    expect(readLocal(root, 'README.md', [root])).toMatchObject({ kind: 'markdown', text: '# hi\n', path: join(root, 'README.md') });
    expect(readLocal(root, 'docs/a.png', [root]).dataUrl).toBe('data:image/png;base64,iVBORw==');
    expect(() => readLocal(root, 'run.sh', [root])).toThrow(/cannot be previewed/);
  });

  it('applies the same rules through the remote (shell) reader', async () => {
    const { root } = fixture();
    await expect(readRemote('host', root, 'README.md', [root, '/no/such/root'])).resolves.toMatchObject({ kind: 'markdown', text: '# hi\n' });
    await expect(readRemote('host', root, 'docs/a.png', [root])).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,iVBORw==' });
    await expect(readRemote('host', root, 'escape.txt', [root])).rejects.toThrow(/inside this agent/);
    await expect(readRemote('host', root, '../secret.txt', [root])).rejects.toThrow(/inside this agent/);
    await expect(readRemote('host', root, 'docs', [root])).rejects.toThrow(/cannot be previewed/);
    await expect(readRemote('host', root, 'innocent.txt', [root])).rejects.toThrow(/cannot be previewed/);
  });

  it('caps the size', async () => {
    const { root } = fixture();
    writeFileSync(join(root, 'big.log'), Buffer.alloc(MAX_BYTES.text + 1, 'a'));
    expect(() => readLocal(root, 'big.log', [root])).toThrow(/too large/);
    await expect(readRemote('host', root, 'big.log', [root])).rejects.toThrow(/too large/);
  });
});

describe('preview kinds and renderer paths', () => {
  it('maps extensions', () => {
    expect(previewKind('a/README.MD')).toBe('markdown');
    expect(previewKind('x.htm')).toBe('html');
    expect(previewKind('logo.svg')).toBe('image');
    expect(previewKind('data.json')).toBe('text');
    expect(previewKind('main.ts')).toBeUndefined();
    expect(previewKind('Makefile')).toBeUndefined();
  });

  it('resolves like path.posix.resolve', () => {
    for (const [b, p] of [['/a/b', 'c.md'], ['/a/b', '../c/./d.md'], ['/a', '/x/y.md'], ['/a', '../../..'], ['/a/', 'b//c']])
      expect(resolvePosix(b, p)).toBe(path.posix.resolve(b, p));
  });
});
