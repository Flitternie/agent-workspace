// What OpenCode and Antigravity are given through their own configuration (skills), their account
// limits (Antigravity's `/usage` as JSON), and the workspace skill library's `.agents` copy.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acpAgent } from '../../src/shared/acp-agents';
import { AcpAdapter } from '../../src/main/providers/acp';
import { AcpLimitsReader, parseAcpLimits, parseAcpLimitsOutput, planOf } from '../../src/main/providers/acp-limits';
import { acpNative, majorVersion, mergeEnv } from '../../src/main/providers/acp-native';
import type { ProviderEvent, ProviderSession } from '../../src/main/providers/types';
import { SkillLibrary } from '../../src/main/skills';

const FAKE = join(__dirname, '../fixtures/fake-acp-agent.mjs');
const opencode = acpAgent('opencode')!;
const antigravity = acpAgent('antigravity')!;
const skills = { pluginDir: '/lib/plugin', root: '/lib/plugin/skills' };
const sessions: ProviderSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
});

// What `agy -p /usage --output-format json` printed on a free account (Antigravity 1.5.18).
const AGY_USAGE = {
  conversation_id: '',
  status: 'SUCCESS',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        { name: 'Gemini Models', buckets: [{ id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9612647891044617, reset_time: '2026-12-03T20:45:16Z' }] },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
            { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '1970-01-01T00:00:00Z' },
          ],
        },
      ],
    },
  },
};

describe('skills through the CLI’s own configuration', () => {
  it('OpenCode 2: the library’s skills folder in skills.paths, merged with the permission rules and the user’s own config', () => {
    const native = acpNative(opencode, skills, '2.4.2');
    expect(native.additionalDirectories).toEqual([]);
    expect(JSON.parse(native.env.OPENCODE_CONFIG_CONTENT)).toEqual({ skills: { paths: ['/lib/plugin/skills'] } });
    const env = new AcpAdapter(opencode).agentEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'x/y', skills: { urls: ['https://s'] } }) }, native.env);
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'x/y',
      permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
      skills: { urls: ['https://s'], paths: ['/lib/plugin/skills'] },
    });
    // Version not known (a test's command): the current CLI.
    expect(acpNative(opencode, skills).env.OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it('OpenCode 1.x: no config key it may not know; the agent is told where the skills are', () => {
    const native = acpNative(opencode, skills, 'opencode 1.19.6');
    expect(native.env).toEqual({});
    expect(native.instructions).toContain('/lib/plugin/skills');
  });

  it('Antigravity: the library folder joins the session (its .agents/skills is read there)', () => {
    expect(acpNative(antigravity, skills, '1.5.18')).toEqual({ env: {}, additionalDirectories: ['/lib/plugin'] });
  });

  it('no skills enabled: nothing', () => {
    expect(acpNative(opencode, undefined, '2.4.2')).toEqual({ env: {}, additionalDirectories: [] });
    expect(acpNative(antigravity, undefined)).toEqual({ env: {}, additionalDirectories: [] });
  });

  it('versions and environment layers', () => {
    expect(majorVersion('2.4.2')).toBe(2);
    expect(majorVersion('opencode 1.19.6')).toBe(1);
    expect(majorVersion(undefined)).toBeUndefined();
    expect(mergeEnv({ A: 'theirs', B: '{"x":1}' }, { A: 'mine' }, { B: '{"y":2}' })).toEqual({ A: 'mine', B: '{"x":1,"y":2}' });
    expect(mergeEnv({ B: 'not json' }, { B: '{"y":2}' })).toEqual({ B: '{"y":2}' });
  });

  it('the library keeps a real copy in .agents/skills (no links), refreshed when a skill changes', () => {
    const lib = new SkillLibrary(mkdtempSync(join(tmpdir(), 'amw-skl-')));
    expect(lib.localLoad()).toBeUndefined();
    mkdirSync(join(lib.root, 'helper', '.git'), { recursive: true });
    writeFileSync(join(lib.root, 'helper', 'SKILL.md'), '---\ndescription: helps\n---\nv1\n');
    writeFileSync(join(lib.root, 'helper', '.git', 'HEAD'), 'x');
    const load = lib.localLoad()!;
    const copy = join(load.pluginDir, '.agents', 'skills', 'helper');
    expect(lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toContain('v1');
    expect(existsSync(join(copy, '.git'))).toBe(false);
    writeFileSync(join(lib.root, 'helper', 'SKILL.md'), '---\ndescription: helps\n---\nv2\n');
    lib.localLoad();
    expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toContain('v2');
  });
});

describe('account limits', () => {
  it('Antigravity’s /usage: the default models’ windows lead, the other group’s are named; used = 1 − remaining', () => {
    const l = parseAcpLimits(AGY_USAGE)!;
    expect(l.windows).toEqual([
      { key: 'seven_day', mins: 10080, usedPercent: 4, resetsAt: Date.parse('2026-12-03T20:45:16Z'), label: 'Gemini' },
      { key: 'acp:3p-weekly', mins: 10080, usedPercent: 0, label: 'Claude and GPT' },
      { key: 'acp:3p-5h', mins: 300, usedPercent: 0, label: 'Claude and GPT' },
    ]);
    expect(parseAcpLimitsOutput(`some log line\n${JSON.stringify(AGY_USAGE)}\n`)?.windows).toHaveLength(3);
    expect(parseAcpLimitsOutput('Error: not signed in')).toBeUndefined();
    expect(parseAcpLimits({ status: 'ERROR' })).toBeUndefined();
    expect(planOf({ _meta: { antigravity: { tier: { name: 'Antigravity Starter Quota', id: 'free-tier' } } } })).toBe('Antigravity Starter Quota');
    expect(planOf({})).toBeUndefined();
  });

  it('read at most once a minute per machine, one read at a time', async () => {
    let calls = 0;
    const reader = new AcpLimitsReader(async () => {
      calls++;
      return { code: 0, stdout: JSON.stringify(AGY_USAGE) };
    });
    const [a, b] = await Promise.all([reader.read(), reader.read()]);
    expect(a).toEqual(b);
    expect(await reader.read()).toBeUndefined(); // too soon
    expect((await reader.read('neptune'))?.windows).toHaveLength(3); // another machine
    expect(calls).toBe(2);
  });

  it('an Antigravity session reports them with its plan after it starts and after a turn; OpenCode reports none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'amw-acpn-'));
    process.env.FAKE_ACP_DIR = join(dir, 'store');
    const logFile = join(dir, 'log.jsonl');
    process.env.FAKE_ACP_LOG = logFile;
    const events: ProviderEvent[] = [];
    const adapter = new AcpAdapter(antigravity, { command: ['node', FAKE] });
    const session = adapter.createSession({ cwd: dir, title: 't', permissionMode: 'ask', skills }, (e) => events.push(e));
    sessions.push(session);
    await session.start();
    const limits = () => events.filter((e): e is Extract<ProviderEvent, { type: 'limits' }> => e.type === 'limits');
    await expect.poll(() => limits().length).toBe(1);
    expect(limits()[0].plan).toBe('Fake Tier');
    expect(limits()[0].windows.map((w) => [w.key, w.usedPercent, w.label])).toEqual([
      ['five_hour', 25, 'Fake'],
      ['seven_day', 10, 'Fake'],
      ['acp:other-weekly', 0, 'Other'],
    ]);
    // The skill library's folder went with session/new.
    const sent = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
    expect(sent.find((m) => m.method === 'session/new')?.params?.additionalDirectories).toEqual(['/lib/plugin']);

    const oc: ProviderEvent[] = [];
    const ocSession = new AcpAdapter(opencode, { command: ['node', FAKE] }).createSession({ cwd: dir, title: 't', permissionMode: 'ask', skills }, (e) => oc.push(e));
    sessions.push(ocSession);
    await ocSession.start();
    await ocSession.send('hello');
    await expect.poll(() => oc.some((e) => e.type === 'turnCompleted')).toBe(true);
    expect(oc.some((e) => e.type === 'limits')).toBe(false);
    // (OpenCode's skills go through its config, not the session.)
    const sent2 = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
    expect(sent2.filter((m) => m.method === 'session/new').at(-1)?.params?.additionalDirectories).toBeUndefined();
  });
});
