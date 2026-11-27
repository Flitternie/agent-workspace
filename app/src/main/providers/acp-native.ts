// What an ACP CLI is given besides the protocol itself, through its own configuration: the workspace
// skill library (shared/acp-agents.ts `skills`). Pure, so it is tested without a CLI.
//
//   config     OpenCode 2 and later: `skills.paths` in OPENCODE_CONFIG_CONTENT (merged with the
//              user's own value and the registry's). OpenCode 1.x: its config is not known to take
//              that key, so the agent is told where the skills are instead (it reads SKILL.md itself).
//   workspace  Antigravity: the library's folder joins the session (ACP additionalDirectories); it
//              reads `<folder>/.agents/skills/<name>/SKILL.md` there (real copies: skills.ts).
import type { AcpAgentSpec } from '../../shared/acp-agents';
import type { SkillsLoad } from '../../shared/skills';

export interface AcpNative {
  /** Environment for the CLI's process (merged over the registry's and the user's, JSON key by key). */
  env: Record<string, string>;
  /** Folders added to the session (session/new and session/load `additionalDirectories`). */
  additionalDirectories: string[];
  /** Said with the app's instructions when the CLI has no way of its own. */
  instructions?: string;
}

const OPENCODE_CONFIG = 'OPENCODE_CONFIG_CONTENT';

/** The major version in a CLI's `--version` line ("2.4.2", "opencode 1.19.6"); undefined when none. */
export function majorVersion(version: string | undefined): number | undefined {
  const m = /(\d+)\.\d+/.exec(version ?? '');
  return m ? Number(m[1]) : undefined;
}

export function acpNative(spec: AcpAgentSpec, skills: SkillsLoad | undefined, version?: string): AcpNative {
  const out: AcpNative = { env: {}, additionalDirectories: [] };
  if (!skills) return out;
  if (spec.skills === 'config') {
    const major = majorVersion(version);
    // Unknown (a test's command, or not checked yet): the current CLI.
    if (major === undefined || major >= 2) out.env[OPENCODE_CONFIG] = JSON.stringify({ skills: { paths: [skills.root] } });
    else out.instructions = skillsNote(skills.root);
  } else if (spec.skills === 'workspace') out.additionalDirectories.push(skills.pluginDir);
  return out;
}

/** For a CLI that cannot be pointed at the library: where it is, so it reads a skill when one fits. */
export function skillsNote(root: string): string {
  return `Workspace skills are in ${root}: one folder per skill, each with a SKILL.md whose frontmatter says what it is for. When a task matches a skill's description, read its SKILL.md and follow it.`;
}

/**
 * One environment value over another: JSON objects merge key by key, one level deep (so
 * `{"permission":{…}}` and `{"skills":{…}}` both survive, and nested keys of the same name merge);
 * anything else, `mine` wins.
 */
export function mergeEnvValue(theirs: string | undefined, mine: string): string {
  if (!theirs) return mine;
  try {
    const a = JSON.parse(theirs) as unknown;
    const b = JSON.parse(mine) as unknown;
    const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!obj(a) || !obj(b)) return mine;
    const deep: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) deep[k] = obj(v) && obj(deep[k]) ? { ...(deep[k] as object), ...v } : v;
    return JSON.stringify(deep);
  } catch {
    return mine;
  }
}

/** Layers of environment values, later ones over earlier ones (see mergeEnvValue). */
export function mergeEnv(base: Record<string, string | undefined>, ...layers: Array<Readonly<Record<string, string>> | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers)
    for (const [k, v] of Object.entries(layer ?? {})) out[k] = mergeEnvValue(out[k] ?? base[k], v);
  return out;
}
