import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { distillPrompt, parseDistill } from '../../src/main/memory-distill';
import { Workspace } from '../../src/main/workspace';
import type { Task, TranscriptItem } from '../../src/shared/types';

describe('drafting a note from a message', () => {
  it('reads the model’s JSON, fenced or not, and keeps only known similar ids', () => {
    const r = parseDistill('Here:\n```json\n{"worth": true, "title": "No bullet lists in prose.", "body": "Write prose.\\n\\n**Why:** ...", "scope": "user", "similarId": "m-1", "reason": "A style preference"}\n```', ['m-1']);
    expect(r).toEqual({ worth: true, title: 'No bullet lists in prose', body: 'Write prose.\n\n**Why:** ...', scope: 'user', similarId: 'm-1', reason: 'A style preference' });
    expect(parseDistill('{"worth": false, "title": "", "body": "", "scope": "project", "similarId": "m-9", "reason": "one-off"}', ['m-1'])).toMatchObject({ worth: false, scope: 'project', similarId: undefined });
    expect(() => parseDistill('no json here', [])).toThrow(/did not return/);
  });

  it('marks the message in its conversation and lists notes that could overlap', () => {
    const p = distillPrompt({
      message: '不要用 bullet point 写，用论文的写法',
      around: [
        { role: 'assistant', text: '- point one\n- point two' },
        { role: 'user', text: '不要用 bullet point 写，用论文的写法', isTarget: true },
      ],
      existing: [{ id: 'm-1', scope: 'user', title: 'short-replies', text: 'Keep replies short.' }],
      projectName: 'proposal',
    });
    expect(p).toContain('Project: proposal');
    expect(p).toContain('>>> THE MESSAGE TO REMEMBER <<<\n[user] 不要用 bullet point');
    expect(p).toContain('id=m-1 (user) short-replies');
  });
});

function workspaceWith(answer: (system: string, prompt: string) => Promise<string>) {
  const ws = new Workspace({ dataDir: mkdtempSync(join(tmpdir(), 'amw-distill-')), adapters: {}, backgroundModel: answer });
  const task = { taskId: 't-1', alias: 'Alice', name: 'Alice', projectId: 'p-1', title: 't', provider: 'mock', status: 'idle', summary: '', cwd: '/tmp', createdAt: '', updatedAt: '' } as Task;
  ws.store.data.tasks.push(task);
  ws.store.data.projects.push({ projectId: 'p-1', name: 'proposal', rootPath: '/tmp', createdAt: '' } as never);
  const say = (id: string, role: 'user' | 'assistant', text: string) => ws.store.transcript('t-1').push({ id, taskId: 't-1', role, text, createdAt: '' } as TranscriptItem);
  say('a1', 'assistant', '- point one\n- point two');
  say('u1', 'user', '不要用 bullet point 写，用论文的写法');
  say('a2', 'assistant', '好的，改成段落。');
  return ws;
}

describe('the workspace’s draft', () => {
  it('asks with the conversation around the message and returns the draft, with a similar note', async () => {
    let seen = '';
    const ws = workspaceWith(async (_s, prompt) => {
      seen = prompt;
      return JSON.stringify({ worth: true, title: '论文式写法', body: '写成段落，不用列表。\n\n**Why:** 用户要求。\n**How to apply:** 写长文时。', scope: 'user', similarId: ws.store.data.memory[0].id, reason: '写作偏好' });
    });
    ws.addMemory({ scope: 'global', scopeId: 'global', title: 'no-bullets', body: 'No bullet lists.', source: 'user', approvedForReuse: true });
    const d = await ws.distillMemory('t-1', 'u1');
    expect(seen).toContain('[assistant] - point one');
    expect(seen).toContain('[assistant] 好的，改成段落。');
    expect(d).toMatchObject({ title: '论文式写法', scope: 'global', worth: true, similar: { title: 'no-bullets' } });
    expect(d.fallback).toBeUndefined();
  });

  it('says when the model thinks it is a one-off, and falls back to the message when the model fails', async () => {
    const oneOff = workspaceWith(async () => '{"worth": false, "title": "x", "body": "y", "scope": "project", "similarId": null, "reason": "只针对这次任务"}');
    expect(await oneOff.distillMemory('t-1', 'u1')).toMatchObject({ worth: false, scope: 'project', reason: '只针对这次任务' });
    const broken = workspaceWith(async () => 'sorry');
    const d = await broken.distillMemory('t-1', 'u1');
    expect(d.body).toBe('不要用 bullet point 写，用论文的写法');
    expect(d.fallback).toMatch(/Could not draft/);
  });
});
