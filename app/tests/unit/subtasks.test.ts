import { describe, expect, it } from 'vitest';
import { ClaudeSubtasks, CodexSubtasks } from '../../src/main/providers/subtasks';
import { digestSubtasks, orderSubtasks } from '../../src/shared/subtasks';
import type { SubtaskInfo } from '../../src/shared/types';

const title = (name: string, input: Record<string, unknown>) => `${name} ${String(input.file_path ?? input.command ?? '')}`.trim();
const inner = (blocks: unknown[]) => ({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: blocks } });

describe('Claude Code sub-agents', () => {
  it('a foreground Agent call: starts, steps through its tool calls, ends with its report', () => {
    const c = new ClaudeSubtasks();
    expect(c.toolUse('toolu_1', { description: 'Find callers of the old API', subagent_type: 'Explore', prompt: '…' })).toEqual([
      { type: 'subtask', id: 'toolu_1', description: 'Find callers of the old API', status: 'running' },
    ]);
    // The SDK's task_started for the same call adds the task id, nothing new to show.
    expect(c.system({ type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: 'toolu_1', description: 'Find callers of the old API', subagent_type: 'Explore', task_type: 'local_agent' })).toEqual([
      { type: 'subtask', id: 'toolu_1', description: 'Find callers of the old API' },
    ]);
    expect(c.inner('toolu_1', inner([{ type: 'text', text: 'Looking…' }, { type: 'tool_use', id: 'x', name: 'Read', input: { file_path: 'src/api.ts' } }]), title)).toEqual([
      { type: 'subtask', id: 'toolu_1', step: 'Read src/api.ts' },
    ]);
    expect(c.system({ type: 'system', subtype: 'task_progress', task_id: 'a1', description: '', summary: 'Found 7 calls in 3 files', usage: {} })).toEqual([
      { type: 'subtask', id: 'toolu_1', step: 'Found 7 calls in 3 files' },
    ]);
    expect(c.toolResult('toolu_1', '7 calls: …', false)).toEqual([{ type: 'subtask', id: 'toolu_1', status: 'done', step: '', result: '7 calls: …' }]);
    // The notification that follows changes nothing; nor do late steps.
    expect(c.system({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'done' })).toEqual([]);
    expect(c.inner('toolu_1', inner([{ type: 'tool_use', name: 'Read', input: {} }]), title)).toEqual([]);
  });

  it('a background one keeps running past its tool_result and ends on its notification', () => {
    const c = new ClaudeSubtasks();
    c.toolUse('toolu_2', { description: 'Run the slow suite', run_in_background: true });
    expect(c.toolResult('toolu_2', 'Launched in the background', false)).toEqual([]);
    c.system({ type: 'system', subtype: 'task_started', task_id: 'b1', tool_use_id: 'toolu_2', description: 'Run the slow suite', task_type: 'local_agent', is_backgrounded: true });
    expect(c.system({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'failed', summary: 'Two tests failed' })).toEqual([
      { type: 'subtask', id: 'toolu_2', status: 'failed', step: '', result: 'Two tests failed' },
    ]);
  });

  it('as Claude Code really reports a background one: ended by task_updated, then the report in task_notification; the handback is no step', () => {
    const c = new ClaudeSubtasks();
    c.toolUse('toolu_3', { description: 'Read alpha.txt', subagent_type: 'general-purpose' });
    c.system({ type: 'system', subtype: 'task_started', task_id: 't3', tool_use_id: 'toolu_3', description: 'Read alpha.txt', subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent' });
    expect(c.toolResult('toolu_3', 'Async agent launched', false)).toEqual([]);
    // The report is the handback's message; the notification only points at it.
    expect(c.inner('toolu_3', { type: 'assistant', parent_tool_use_id: 'toolu_3', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'Alpha: retries three times.' } }] } }, title)).toEqual([
      { type: 'subtask', id: 'toolu_3', result: 'Alpha: retries three times.' },
    ]);
    expect(c.system({ type: 'system', subtype: 'task_updated', task_id: 't3', patch: { status: 'completed', end_time: 1 } })).toEqual([{ type: 'subtask', id: 'toolu_3', status: 'done', step: '' }]);
    expect(c.system({ type: 'system', subtype: 'task_notification', task_id: 't3', tool_use_id: 'toolu_3', status: 'completed', summary: 'This agent\'s report was delivered to you as a message from "a1" (its SubagentHandback call).' })).toEqual([]);
  });

  it('a background one without a handback: the notification summary is its report', () => {
    const c = new ClaudeSubtasks();
    c.system({ type: 'system', subtype: 'task_started', task_id: 't4', tool_use_id: 'toolu_4', description: 'Run tests', task_type: 'local_agent', is_backgrounded: true });
    c.system({ type: 'system', subtype: 'task_updated', task_id: 't4', patch: { status: 'completed' } });
    expect(c.system({ type: 'system', subtype: 'task_notification', task_id: 't4', status: 'completed', summary: 'All green.' })).toEqual([{ type: 'subtask', id: 'toolu_4', result: 'All green.' }]);
  });

  it('ignores background shells and housekeeping tasks; a stopped sub-agent ends as failed', () => {
    const c = new ClaudeSubtasks();
    expect(c.system({ type: 'system', subtype: 'task_started', task_id: 'sh', description: 'npm test', task_type: 'local_bash' })).toEqual([]);
    expect(c.system({ type: 'system', subtype: 'task_started', task_id: 'w', description: 'watch', task_type: 'local_agent', ambient: true })).toEqual([]);
    expect(c.system({ type: 'system', subtype: 'task_notification', task_id: 'sh', status: 'completed', summary: '' })).toEqual([]);
    // Known only from task_started (no Agent tool_use seen): still a sub-agent.
    expect(c.system({ type: 'system', subtype: 'task_started', task_id: 'k', description: 'Review\nthe diff', subagent_type: 'code-reviewer' })).toEqual([
      { type: 'subtask', id: 'k', description: 'Review', status: 'running' },
    ]);
    expect(c.system({ type: 'system', subtype: 'task_updated', task_id: 'k', patch: { status: 'killed' } })).toEqual([{ type: 'subtask', id: 'k', status: 'failed', step: '', result: 'Stopped.' }]);
  });
});

describe('Codex sub-agents', () => {
  const spawn = (status: string, receivers: string[], prompt = 'Check the changelog\nfor v2 changes') => ({
    type: 'collabAgentToolCall',
    id: 'c1',
    tool: 'spawnAgent',
    status,
    senderThreadId: 'main',
    receiverThreadIds: receivers,
    prompt,
    agentsStates: {},
  });

  it('spawn_agent starts one per receiver thread; its thread items are steps; wait reports the ending', () => {
    const c = new CodexSubtasks();
    expect(c.item(spawn('inProgress', []))).toEqual([]);
    expect(c.item(spawn('completed', ['th-1', 'th-2']))).toEqual([
      { type: 'subtask', id: 'th-1', description: 'Check the changelog', status: 'running' },
      { type: 'subtask', id: 'th-2', description: 'Check the changelog', status: 'running' },
    ]);
    expect(c.owns('th-1')).toBe(true);
    expect(c.owns('main')).toBe(false);
    const name = (item: Record<string, unknown>) => (item.type === 'commandExecution' ? `$ ${String(item.command)}` : undefined);
    expect(c.inner('th-1', 'item/started', { item: { type: 'commandExecution', command: 'rg v2' } }, name)).toEqual([{ type: 'subtask', id: 'th-1', step: '$ rg v2' }]);
    c.inner('th-2', 'item/completed', { item: { type: 'agentMessage', text: 'Only pagination changed.' } }, name);
    expect(
      c.item({ type: 'collabAgentToolCall', id: 'c2', tool: 'wait', status: 'completed', receiverThreadIds: ['th-1', 'th-2'], agentsStates: { 'th-1': { status: 'errored', message: 'boom' }, 'th-2': { status: 'completed', message: null } } }),
    ).toEqual([
      { type: 'subtask', id: 'th-1', status: 'failed', step: '', result: 'boom' },
      { type: 'subtask', id: 'th-2', status: 'done', step: '', result: 'Only pagination changed.' },
    ]);
    // Closing them afterwards changes nothing.
    expect(c.item({ type: 'collabAgentToolCall', id: 'c3', tool: 'closeAgent', status: 'completed', receiverThreadIds: ['th-1'], agentsStates: { 'th-1': { status: 'shutdown', message: null } } })).toEqual([]);
  });

  it('subAgentActivity items mark starts and ends (what codex-cli 0.162 sends, without spawnAgent items)', () => {
    const c = new CodexSubtasks();
    expect(c.item({ type: 'subAgentActivity', id: 'a', kind: 'started', agentThreadId: 'th-8', agentPath: '/root/read_alpha' })[0]).toMatchObject({ description: 'Read alpha' });
    expect(c.item({ type: 'subAgentActivity', id: 'x', kind: 'started', agentThreadId: 'th-9', agentPath: 'root/reviewer' })).toEqual([
      { type: 'subtask', id: 'th-9', description: 'Reviewer', status: 'running' },
    ]);
    expect(c.item({ type: 'subAgentActivity', id: 'y', kind: 'interrupted', agentThreadId: 'th-9', agentPath: 'root/reviewer' })).toEqual([
      { type: 'subtask', id: 'th-9', status: 'failed', step: '', result: 'Interrupted.' },
    ]);
  });
});

describe('many sub-agents', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 10, 18, 12, min)).toISOString();
  const sub = (id: string, status: SubtaskInfo['status'], started: number, ended?: number): SubtaskInfo => ({ id, description: id, status, startedAt: at(started), ...(ended !== undefined ? { endedAt: at(ended) } : {}) });

  it('lists the working ones first, then failures, then the finished, each in start order; counts the rest', () => {
    const list = [sub('d-old', 'done', 0, 7), sub('r-late', 'running', 5), sub('f', 'failed', 2, 3), sub('r-early', 'running', 1), sub('d-new', 'done', 2, 6)];
    expect(orderSubtasks(list).map((s) => s.id)).toEqual(['r-early', 'r-late', 'f', 'd-old', 'd-new']);
    const d = digestSubtasks(list, 3);
    expect(d.shown.map((s) => s.id)).toEqual(['r-early', 'r-late', 'f']);
    expect(d.hidden).toEqual({ total: 2, running: 0, failed: 0, done: 2 });
    expect(d.running).toBe(2);
  });

  it('with dozens, the short list is all working ones and says how many more work', () => {
    const list = Array.from({ length: 40 }, (_, i) => sub(`s${i}`, i % 4 === 0 ? 'done' : 'running', i, i % 4 === 0 ? i + 1 : undefined));
    const d = digestSubtasks(list, 8);
    expect(d.shown).toHaveLength(8);
    expect(d.shown.every((s) => s.status === 'running')).toBe(true);
    expect(d.hidden).toEqual({ total: 32, running: 22, failed: 0, done: 10 });
  });
});
