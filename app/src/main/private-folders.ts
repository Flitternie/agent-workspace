import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';

/**
 * Folders under the home directory that macOS guards with a privacy prompt (Photos, Music,
 * Contacts, Calendars, other apps' data…) and that never hold code. An agent searching from
 * a broad folder (`rg` / Grep / Glob over ~) would walk into them, and macOS would ask, once
 * per kind of data, for Agent Workspace to read them. Agents on this Mac are told not to.
 * Desktop, Documents, Downloads and iCloud Drive are left alone: projects live there.
 */
const PRIVATE = [
  'Pictures',
  'Movies',
  'Music',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Mail',
  'Library/Messages',
  'Library/Calendars',
  'Library/Application Support/AddressBook',
  'Library/Safari',
];

/** Absolute paths agents in `cwd` should not read; none outside macOS, and none that holds `cwd`. */
export function privateFolders(cwd: string, platform = process.platform, home = homedir()): string[] {
  if (platform !== 'darwin') return [];
  return PRIVATE.map((p) => join(home, p)).filter((dir) => {
    const r = relative(dir, cwd);
    return !(r === '' || (!r.startsWith('..') && !isAbsolute(r)));
  });
}
