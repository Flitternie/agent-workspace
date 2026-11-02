import { describe, expect, it } from 'vitest';
import { privateFolders } from '../../src/main/private-folders';

describe('private folders', () => {
  it('keeps agents on a Mac out of photos, music and other apps’ data, but not out of their own folder', () => {
    const dirs = privateFolders('/Users/me/code/app', 'darwin', '/Users/me');
    expect(dirs).toContain('/Users/me/Pictures');
    expect(dirs).toContain('/Users/me/Library/Containers');
    expect(dirs).not.toContain('/Users/me/Documents');
    // A project kept inside one of them can still be read.
    const inMusic = privateFolders('/Users/me/Music/plugin-dev', 'darwin', '/Users/me');
    expect(inMusic).not.toContain('/Users/me/Music');
    expect(inMusic).toContain('/Users/me/Pictures');
    expect(privateFolders('/Users/me/MusicApp', 'darwin', '/Users/me')).toContain('/Users/me/Music');
    expect(privateFolders('/home/me/app', 'linux', '/home/me')).toEqual([]);
  });
});
