import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeTransient } from '../../src/main/providers/claude';
import { codexTransient } from '../../src/main/providers/codex';
import { MockAdapter } from '../../src/main/providers/mock';
import { cleanUserText } from '../../src/main/providers/user-text';
import { DEFAULT_RETRY, RETRY_PROMPT, retryDelayMs, transientKind, type RetryPolicy } from '../../src/main/retry';
import { Workspace } from '../../src/main/workspace';

const CAPACITY = 'Selected model is at capacity. Please try a different model.';

describe('backoff', () => {
  it('doubles each wait up to the cap, with half of it jittered', () => {
    const policy: RetryPolicy = { attempts: 6, baseMs: 1000, maxMs: 5000 };
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, policy, () => 1))).toEqual([1000, 2000, 4000, 5000, 5000]);
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(n, policy, () => 0))).toEqual([500, 1000, 2000, 2500, 2500]);
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs(3, policy);
      expect(d).toBeGreaterThanOrEqual(2000);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });

  it('spends about one to two minutes on the default retries', () => {
    const total = (r: () => number) => Array.from({ length: DEFAULT_RETRY.attempts - 1 }, (_, i) => retryDelayMs(i + 1, DEFAULT_RETRY, r)).reduce((a, b) => a + b, 0);
    expect(total(() => 0)).toBeGreaterThanOrEqual(55_000);
    expect(total(() => 1)).toBeLessThanOrEqual(120_000);
  });
});

describe('transient errors', () => {
  it('retries capacity, overload and rate limits, but not plan limits or other failures', () => {
    expect(transientKind(CAPACITY)).toBe('capacity');
    expect(transientKind('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')).toBe('capacity');
    expect(transientKind('503 Service Unavailable')).toBe('capacity');
    expect(transientKind('', 503)).toBe('capacity');
    expect(transientKind('429 Too Many Requests')).toBe('rate_limit');
    expect(transientKind('', 429)).toBe('rate_limit');
    expect(transientKind("You've hit your usage limit. Upgrade to Pro or try again later.")).toBeUndefined();
    expect(transientKind('Claude AI usage limit reached|1767225600')).toBeUndefined();
    expect(transientKind('429: insufficient_quota')).toBeUndefined();
    expect(transientKind('Codex ran out of room in the model context window.')).toBeUndefined();
    expect(transientKind('API Error: 500 Internal server error')).toBeUndefined();
    expect(transientKind(undefined)).toBeUndefined();
  });

  it('reads Codex error codes first and the message only for unknown ones', () => {
    expect(codexTransient({ message: CAPACITY, codexErrorInfo: 'serverOverloaded' })).toBe('capacity');
    expect(codexTransient({ message: 'Rate limit reached', codexErrorInfo: 'rateLimitExceeded' })).toBe('rate_limit');
    expect(codexTransient({ message: 'stream failed', codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } } })).toBe('capacity');
    expect(codexTransient({ message: 'exceeded retry limit, last status: 429', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } })).toBe('rate_limit');
    expect(codexTransient({ message: CAPACITY, codexErrorInfo: null })).toBe('capacity');
    expect(codexTransient({ message: CAPACITY, codexErrorInfo: 'other' })).toBe('capacity');
    // Known codes that waiting a minute cannot fix, whatever the message says.
    expect(codexTransient({ message: 'You hit a rate limit for your plan', codexErrorInfo: 'usageLimitExceeded' })).toBeUndefined();
    expect(codexTransient({ message: 'too long', codexErrorInfo: 'contextWindowExceeded' })).toBeUndefined();
    expect(codexTransient({ message: 'unauthorized', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } })).toBeUndefined();
    expect(codexTransient(null)).toBeUndefined();
  });

  it('reads Claude API error codes, keeping plan limits out', () => {
    expect(claudeTransient('overloaded', 'API Error: Repeated 529 Overloaded errors')).toBe('capacity');
    expect(claudeTransient('rate_limit', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')).toBe('rate_limit');
    expect(claudeTransient('rate_limit', 'Claude AI usage limit reached|1767225600')).toBeUndefined();
    expect(claudeTransient(undefined, 'error_during_execution')).toBeUndefined();
  });

  it('hides the retry prompt when a saved conversation is shown', () => {
    expect(cleanUserText(RETRY_PROMPT)).toBe('');
    expect(cleanUserText(`${RETRY_PROMPT}\nand also this`)).toBe('and also this');
  });
});

// ---------------------------------------------------------------- workspace

const DELAY = 5;
const opened: Workspace[] = [];

afterEach(async () => {
  for (const ws of opened.splice(0)) await ws.shutdown();
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'amw-test-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

function open(retry: Partial<RetryPolicy>, dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'))): Workspace {
  const ws = new Workspace({ dataDir, adapters: { mock: new MockAdapter(join(dataDir, 'mock-sessions'), DELAY) }, retry });
  opened.push(ws);
  return ws;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await sleep(DELAY);
  }
}

async function start(ws: Workspace, mockScript: string) {
  const project = await ws.addProject(repo());
  const t = await ws.createTask({ projectId: project.projectId, provider: 'mock', title: 'api', isolate: false, mockScript, instruction: 'Migrate the API.' });
  const task = () => ws.snapshot().tasks.find((x) => x.taskId === t.taskId)!;
  const errors = () => ws.snapshot().attention.filter((a) => a.taskId === t.taskId && a.kind === 'error');
  /** What the provider itself received, in order (its saved native history). */
  const received = () => {
    const native = ws.snapshot().sessions.filter((s) => s.taskId === t.taskId).at(-1)!.nativeSessionId;
    const saved = JSON.parse(readFileSync(join(ws.snapshot().dataDir, 'mock-sessions', `${native}.json`), 'utf8')) as { messages: Array<{ role: string; text: string }> };
    return saved.messages.filter((m) => m.role === 'user').map((m) => m.text);
  };
  const userItems = () => ws.transcript(t.taskId).filter((i) => i.role === 'user');
  /** The turn ended normally (the mock's reply may end with a question for the user). */
  const finished = () => ['done', 'waiting_for_user'].includes(task().status);
  return { t, task, errors, received, userItems, finished };
}

describe('automatic retry of a turn the model was too busy for', () => {
  it('shows the wait, retries with the same turn, and never repeats the instruction', async () => {
    const ws = open({ baseMs: 200, maxMs: 400 });
    const { t, task, errors, received, userItems } = await start(ws, 'capacity:2');
    await until(() => !!task().retry);
    expect(task().status).toBe('running');
    expect(task().retry).toMatchObject({ kind: 'capacity', attempt: 2, maxAttempts: 5, by: 'app', error: CAPACITY });
    expect(Date.parse(task().retry!.at)).toBeGreaterThan(Date.now());
    expect(task().summary).toBe('Model at capacity, retrying (attempt 2/5)');

    await until(() => task().status === 'done');
    expect(task().retry).toBeUndefined();
    expect(errors()).toEqual([]);
    expect(received()).toEqual(['Migrate the API.', RETRY_PROMPT, RETRY_PROMPT]);
    expect(userItems().map((i) => i.text)).toEqual(['Migrate the API.']);
    const notes = ws.transcript(t.taskId).filter((i) => i.role === 'system' && /Retrying in \d+s/.test(i.text));
    expect(notes.map((n) => /attempt (\d\/\d)/.exec(n.text)?.[1])).toEqual(['2/5', '3/5']);
  });

  it('gives up after the last attempt with a clear, retryable error; Retry runs it again', async () => {
    const ws = open({ attempts: 3, baseMs: 10, maxMs: 20 });
    const { t, task, errors, received, userItems, finished } = await start(ws, 'capacity:3');
    await until(() => task().status === 'failed');
    expect(task().retry).toBeUndefined();
    expect(task().summary).toBe(`Turn failed after 3 attempts: ${CAPACITY}`);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({ state: 'open', retryable: true, transient: 'capacity', details: '' });
    expect(received()).toEqual(['Migrate the API.', RETRY_PROMPT, RETRY_PROMPT]);

    await ws.retry(t.taskId);
    await until(finished);
    expect(errors()[0]).toMatchObject({ state: 'resolved', resolution: 'Retried.' });
    expect(received()).toEqual(['Migrate the API.', RETRY_PROMPT, RETRY_PROMPT, RETRY_PROMPT]);
    expect(userItems()).toHaveLength(1);
  });

  it('interrupt cancels a waiting retry', async () => {
    const ws = open({ baseMs: 300, maxMs: 300 });
    const { t, task, errors, received } = await start(ws, 'capacity:5');
    await until(() => !!task().retry);
    await ws.interrupt(t.taskId);
    expect(task().retry).toBeUndefined();
    expect(task().status).toBe('idle');
    await sleep(500);
    expect(received()).toEqual(['Migrate the API.']);
    expect(task().status).toBe('idle');
    expect(errors()).toEqual([]);
    expect(ws.transcript(t.taskId).some((i) => i.role === 'system' && i.text === 'Automatic retry cancelled.')).toBe(true);
  });

  it('stop cancels a waiting retry', async () => {
    const ws = open({ baseMs: 300, maxMs: 300 });
    const { t, task, errors, received } = await start(ws, 'capacity:5');
    await until(() => !!task().retry);
    await ws.stop(t.taskId);
    expect(task().retry).toBeUndefined();
    expect(task().status).toBe('disconnected');
    await sleep(500);
    expect(received()).toEqual(['Migrate the API.']);
    expect(task().status).toBe('disconnected');
    expect(errors()).toEqual([]);
  });

  it('a new message replaces the waiting retry instead of adding to it', async () => {
    const ws = open({ baseMs: 300, maxMs: 300 });
    const { t, task, received, finished } = await start(ws, 'capacity:1');
    await until(() => !!task().retry);
    await ws.send(t.taskId, 'Keep the old endpoint too.', 'text');
    expect(task().retry).toBeUndefined();
    await until(finished);
    await sleep(500);
    expect(received()).toEqual(['Migrate the API.', 'Keep the old endpoint too.']);
  });

  it('a manual Retry after the final failure starts a fresh round of automatic retries', async () => {
    const ws = open({ attempts: 2, baseMs: 10, maxMs: 10 });
    const { t, task, errors, received, finished } = await start(ws, 'capacity:3');
    await until(() => task().status === 'failed');
    await ws.retry(t.taskId);
    // Its own failure is attempt 1 of a new round, so one more automatic retry follows and succeeds.
    await until(finished);
    expect(received()).toEqual(['Migrate the API.', RETRY_PROMPT, RETRY_PROMPT, RETRY_PROMPT]);
    expect(errors().filter((a) => a.state === 'open')).toEqual([]);
  });

  it('keeps a waiting retry one click away when the provider process goes away', async () => {
    const ws = open({ baseMs: 300, maxMs: 300 });
    const { t, task, errors, received, finished } = await start(ws, 'capacity:1');
    await until(() => !!task().retry);
    ws.handleEvent(t.taskId, task().sessionLocalId!, { type: 'sessionDisconnected', reason: 'Codex app-server exited (1).' });
    expect(task().retry).toBeUndefined();
    expect(task().status).toBe('disconnected');
    expect(errors()).toEqual([expect.objectContaining({ state: 'open', retryable: true, transient: 'capacity', headline: `Turn failed: ${CAPACITY}` })]);
    await sleep(500);
    expect(received()).toEqual(['Migrate the API.']);
    // Retry resumes the same native session and carries on (the resumed mock counts its capacity failure again).
    await ws.retry(t.taskId);
    await until(finished);
    expect(received()).toEqual(['Migrate the API.', RETRY_PROMPT, RETRY_PROMPT]);
  });

  it('keeps a waiting retry one click away across an app restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'amw-test-data-'));
    const ws1 = open({ baseMs: 60_000, maxMs: 60_000 }, dataDir);
    const { t, task } = await start(ws1, 'capacity:1');
    await until(() => !!task().retry);
    await ws1.shutdown();

    const ws2 = open({ baseMs: 10, maxMs: 10 }, dataDir);
    const after = () => ws2.snapshot().tasks.find((x) => x.taskId === t.taskId)!;
    expect(after().retry).toBeUndefined();
    expect(after().status).toBe('failed');
    const error = ws2.snapshot().attention.find((a) => a.taskId === t.taskId && a.kind === 'error')!;
    expect(error).toMatchObject({ state: 'open', retryable: true, transient: 'capacity' });
    await ws2.retry(t.taskId);
    await until(() => ['done', 'waiting_for_user'].includes(after().status));
  });

  it('shows the provider’s own retries, and does not retry again on top of them', async () => {
    const ws = open({ baseMs: 10, maxMs: 10 });
    const { t, task, errors } = await start(ws, 'work');
    await until(() => task().status === 'done');
    const local = task().sessionLocalId!;
    ws.handleEvent(t.taskId, local, { type: 'turnStarted' });
    ws.handleEvent(t.taskId, local, { type: 'retrying', kind: 'capacity', attempt: 3, maxAttempts: 10, delayMs: 8000 });
    expect(task().retry).toMatchObject({ kind: 'capacity', attempt: 3, maxAttempts: 10, by: 'provider' });
    expect(task().summary).toBe('Model at capacity, retrying (attempt 3/10)');
    // Output means its retry went through.
    ws.handleEvent(t.taskId, local, { type: 'outputDelta', itemId: 'x', role: 'assistant', delta: 'Back' });
    expect(task().retry).toBeUndefined();

    ws.handleEvent(t.taskId, local, { type: 'retrying', kind: 'capacity', attempt: 10, maxAttempts: 10, delayMs: 8000 });
    ws.handleEvent(t.taskId, local, { type: 'turnCompleted', status: 'failed', error: 'API Error: Repeated 529 Overloaded errors', transient: 'capacity', retried: true });
    expect(task().retry).toBeUndefined();
    expect(task().status).toBe('failed');
    expect(errors().filter((a) => a.state === 'open')).toEqual([expect.objectContaining({ retryable: true, transient: 'capacity' })]);
  });

  it('a failure that waiting cannot fix is not retried, but can still be retried by hand', async () => {
    const ws = open({ baseMs: 10, maxMs: 10 });
    const { t, task, errors } = await start(ws, 'work');
    await until(() => task().status === 'done');
    const local = task().sessionLocalId!;
    ws.handleEvent(t.taskId, local, { type: 'turnStarted' });
    ws.handleEvent(t.taskId, local, { type: 'turnCompleted', status: 'failed', error: 'Codex ran out of room in the model context window.' });
    expect(task().retry).toBeUndefined();
    expect(task().status).toBe('failed');
    expect(task().summary).toBe('Turn failed: Codex ran out of room in the model context window.');
    const error = errors().find((a) => a.state === 'open')!;
    expect(error.retryable).toBe(true);
    expect(error.transient).toBeUndefined();
    expect(error.details).toBe('');
    // A message too long for the headline keeps its full text in the details.
    const long = `Sandbox error: ${'x'.repeat(200)}`;
    ws.handleEvent(t.taskId, local, { type: 'turnStarted' });
    ws.handleEvent(t.taskId, local, { type: 'turnCompleted', status: 'failed', error: long });
    expect(errors().at(-1)!.details).toBe(long);
  });
});
