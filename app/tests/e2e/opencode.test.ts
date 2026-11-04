// Opt-in real OpenCode journey: AMW_E2E_OPENCODE=1 npm run test:e2e -- opencode
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
let app: ElectronApplication | undefined;
const invoke = (page: Page, channel: string, payload: unknown = {}) => page.evaluate(
  ([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c, p),
  [channel, payload] as const,
);
afterAll(async () => { await app?.close().catch(() => {}); });

it.runIf(process.env.AMW_E2E_OPENCODE === '1')('OpenCode picker, worktree edits, approval, question, interruption and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'amw-opencode-real-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'amw-opencode-app-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# OpenCode smoke\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', 'commit', '-qm', 'init'], { cwd: root });
  const launch = async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !['ELECTRON_RUN_AS_NODE', 'AMW_MODE'].includes(k))) as Record<string, string>;
    app = await electron.launch({ executablePath: require('electron') as string, args: [appDir], cwd: appDir, env: { ...env, AMW_DATA_DIR: dataDir, AMW_MAIN_AGENT: 'off', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' } });
    const page = await app.firstWindow();
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { language: 'en' });
    return page;
  };
  let page = await launch();
  const snapshot = async () => await invoke(page, 'workspace:snapshot') as WorkspaceSnapshot;
  await expect.poll(async () => (await snapshot()).capabilities.find((c) => c.provider === 'opencode')?.available).toBe(true);
  const project = await invoke(page, 'project:add', { rootPath: root, name: 'OpenCode smoke' }) as { projectId: string };
  await page.getByTestId('new-task').click();
  await page.getByTestId('project-select').selectOption(project.projectId);
  await page.getByRole('radio', { name: /OpenCode/ }).check();
  await page.getByPlaceholder('e.g. Schema migration for orders').fill('OpenCode smoke');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await expect.poll(async () => (await snapshot()).tasks[0]?.status).toBe('idle');
  const task = (await snapshot()).tasks[0];
  const send = (text: string) => invoke(page, 'task:send', { taskId: task.taskId, text, via: 'text' });
  // Regression: the first message starts a fresh provider session. 2.x serves
  // HTML for the old /agent path, which must never be mistaken for JSON.
  expect(await send('Remember the codeword LIME-73. Use your file editing tool to create hello.txt containing exactly Hello from OpenCode. Do not run shell commands. Then reply CREATED.')).toMatchObject({ ok: true });
  await expect.poll(async () => (await snapshot()).tasks[0]?.status, { timeout: 180_000 }).toBe('done');
  expect(task.provider).toBe('opencode'); expect(task.cwd).not.toBe(root); expect(task.worktree).toBeDefined();
  expect(readFileSync(join(task.cwd, 'hello.txt'), 'utf8').trim()).toBe('Hello from OpenCode');
  expect(existsSync(join(root, 'hello.txt'))).toBe(false);
  await expect.poll(() => page.getByTestId('diff').count()).toBeGreaterThan(0);
  await invoke(page, 'task:setPermissionMode', { taskId: task.taskId, mode: 'edits' });
  const pending = async (kind: string) => (await snapshot()).attention.find((a) => a.taskId === task.taskId && a.kind === kind && a.state === 'open' && a.providerRequestId);
  await send('Use your shell tool to run exactly: echo APPROVAL-CHECK. If denied, reply DENIED and do not retry.');
  await expect.poll(async () => !!await pending('approval'), { timeout: 180_000 }).toBe(true);
  await page.locator('[data-attention-kind="approval"]').getByRole('button', { name: 'Deny', exact: true }).first().click();
  await expect.poll(async () => (await snapshot()).tasks[0].status, { timeout: 180_000 }).toBe('done');
  await send('Use the question tool to ask me to choose Red or Blue, with one question. Wait for my answer, then reply CHOSEN followed by my choice.');
  await expect.poll(async () => !!await pending('question'), { timeout: 180_000 }).toBe(true);
  const question = (await pending('question'))!;
  await invoke(page, 'attention:respond', { attentionId: question.id, answers: { [question.questions![0].id]: 'Blue' } });
  await expect.poll(async () => (await snapshot()).tasks[0].summary, { timeout: 180_000 }).toContain('Blue');
  await send('Use your shell tool to run sleep 30. Then reply WAITED.');
  await expect.poll(async () => !!await pending('approval'), { timeout: 180_000 }).toBe(true);
  await invoke(page, 'task:interrupt', { taskId: task.taskId });
  expect((await snapshot()).tasks[0].status).toBe('idle');
  const nativeID = (await snapshot()).sessions.at(-1)!.nativeSessionId;
  await app!.close(); page = await launch();
  await send('What was the codeword? Reply with just that codeword.');
  await expect.poll(async () => (await snapshot()).tasks[0].summary, { timeout: 180_000 }).toContain('LIME-73');
  expect((await snapshot()).sessions.at(-1)).toMatchObject({ nativeSessionId: nativeID, integrationMode: 'resumed' });
  await invoke(page, 'task:setPermissionMode', { taskId: task.taskId, mode: 'auto' });
  expect(await send('Use your shell tool to run exactly: echo OPENCODE-AUTO-OK. Then reply with that output.')).toMatchObject({ ok: true });
  await expect.poll(async () => (await snapshot()).tasks[0].status, { timeout: 180_000 }).toBe('done');
  expect((await snapshot()).tasks[0].summary).toContain('OPENCODE-AUTO-OK');
  expect(await pending('approval')).toBeUndefined();
}, 600_000);
