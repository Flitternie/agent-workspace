import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSessionFile } from '../../src/main/providers/session-file';
import { MockAdapter } from '../../src/main/providers/mock';
import { Workspace } from '../../src/main/workspace';

describe('agents mentioned by name', () => {
  it('a name that finds an agent is a mention; a file path stays a file; other @words stay text', async () => {
    const { splitMentions, mentionBefore, agentMentionText } = await import('../../src/shared/file-match');
    const { findAgentIn, agentRefName } = await import('../../src/shared/agent-ref');
    const tasks = [
      { alias: '小王', name: '结账页方案' },
      { alias: 'Bob', name: 'Search page' },
      { alias: 'Eve', name: 'Search page' },
    ];
    const isAgent = (ref: string) => !!findAgentIn(tasks, ref);
    expect(splitMentions('参考 @结账页方案 和 @src/a.ts，问 @nobody', isAgent)).toEqual([
      { text: '参考 ' },
      { text: '@结账页方案', agent: '结账页方案' },
      { text: ' 和 ' },
      { text: '@src/a.ts', path: 'src/a.ts' },
      { text: '，问 @nobody' },
    ]);
    // A name two agents share is not unique: the alias is used instead.
    expect(agentRefName(tasks, tasks[0])).toBe('结账页方案');
    expect(agentRefName(tasks, tasks[1])).toBe('Bob');
    expect(agentMentionText('Search page')).toBe('@"Search page" ');
    expect(splitMentions('see @"Search page Bob"', isAgent)[1]).toEqual({ text: '@"Search page Bob"', agent: 'Search page Bob' });
    expect(mentionBefore('参考 @结账页方案', 9, isAgent)).toBe(3);
    expect(mentionBefore('参考 @nobody', 9, isAgent)).toBeUndefined();
  });
});

describe('session files', () => {
  it('finds Claude Code’s projects/<folder>/<id>.jsonl and Codex’s dated rollout files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amw-sf-'));
    const id = '0f3c2a1b-1111-2222-3333-444455556666';
    mkdirSync(join(root, 'claude', '-Users-me-shop'), { recursive: true });
    writeFileSync(join(root, 'claude', '-Users-me-shop', `${id}.jsonl`), '{}');
    expect(await findSessionFile(join(root, 'claude'), '', id, 2)).toBe(join(root, 'claude', '-Users-me-shop', `${id}.jsonl`));
    mkdirSync(join(root, 'codex', '2026', '11', '27'), { recursive: true });
    const rollout = join(root, 'codex', '2026', '11', '27', `rollout-2026-11-27T10-00-00-${id}.jsonl`);
    writeFileSync(rollout, '{}');
    expect(await findSessionFile(join(root, 'codex'), '', id, 4)).toBe(rollout);
    expect(await findSessionFile(join(root, 'codex'), '', 'missing-session-id', 4)).toBeUndefined();
    // Not an id: never searched for.
    expect(await findSessionFile(join(root, 'claude'), '', '../../etc', 2)).toBeUndefined();
  });
});

describe('an agent dropped on another agent’s box', () => {
  it('points to the file its conversation is in; only on the same machine and once it has one', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-ar-'));
    const adapter = new MockAdapter(join(dataDir, 'mock'), 5);
    const file = join(dataDir, 'sessions', 'conv.jsonl');
    (adapter as unknown as { sessionFile: (id: string) => Promise<string> }).sessionFile = async () => file;
    const ws = new Workspace({ dataDir, adapters: { mock: adapter }, backgroundModel: async () => '' });
    try {
      const repo = mkdtempSync(join(tmpdir(), 'amw-ar-repo-'));
      writeFileSync(join(repo, 'README.md'), 'x');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const p = await ws.addProject(repo);
      const a = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
      const b = await ws.createTask({ projectId: p.projectId, provider: 'mock', isolate: false });
      await expect(ws.agentReference(a.taskId, b.taskId)).rejects.toThrow(/no saved conversation/);
      await ws.send(b.taskId, 'hi', 'text');
      await new Promise((r) => setTimeout(r, 100));
      const bName = ws.snapshot().tasks.find((t) => t.taskId === b.taskId)!.name;
      expect(await ws.agentReference(a.taskId, b.taskId)).toEqual({ path: file, dir: false, name: bName });

      // Mentioned by name in a message: the conversation keeps "@name", the CLI gets the file to read.
      await ws.send(a.taskId, `Follow @${bName} for this.`, 'text');
      await new Promise((r) => setTimeout(r, 100));
      expect(ws.transcript(a.taskId).find((i) => i.role === 'user')!.text).toBe(`Follow @${bName} for this.`);
      const live = (ws as unknown as { live: Map<string, { session: { history?: { messages: Array<{ role: string; text: string }> } } }> }).live;
      expect(live.get(a.taskId)!.session.history!.messages.find((m) => m.role === 'user')!.text).toBe(`Follow @${file} (${bName}'s conversation) for this.`);
      await expect(ws.agentReference(a.taskId, a.taskId)).rejects.toThrow(/itself/);
      // Another machine: the path would not be there.
      (ws as unknown as { store: { data: { tasks: Array<{ taskId: string; host?: string }> } } }).store.data.tasks.find((t) => t.taskId === b.taskId)!.host = 'neptune';
      await expect(ws.agentReference(a.taskId, b.taskId)).rejects.toThrow(/same machine/);
    } finally {
      await ws.shutdown();
    }
  });
});
