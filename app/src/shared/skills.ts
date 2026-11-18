// Skill library types shared by the main process and the UI (see main/skills.ts).

export type SkillSource = 'claude' | 'codex' | 'agents';

export interface SkillInfo {
  name: string;
  description: string;
  /** Hash of the folder's files (same on every machine, see folderHash / HASH_SH). */
  hash: string;
}

export interface FoundSkill extends SkillInfo {
  /** Stable id for importing: host (or ''), source and folder. */
  key: string;
  host?: string;
  source: SkillSource;
  path: string;
}

export interface LibrarySkill extends SkillInfo {
  enabled: boolean;
  origin?: { host?: string; source: SkillSource; path: string };
  importedAt?: string;
}

export interface SkillsLoad {
  /** The plugin folder on the machine the CLI runs on (Claude Code `plugins`). */
  pluginDir: string;
  /** Its skills folder (Codex `skills/extraRoots/set`). */
  root: string;
}
