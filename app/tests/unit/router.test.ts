import { describe, expect, it } from 'vitest';
import { decideDeterministic, decideRoute, type RouteContext, type RouteTask } from '../../src/main/router';

const task = (alias: string, title: string, extra: Partial<RouteTask> = {}): RouteTask => ({
  taskId: `t-${alias}`,
  alias,
  name: alias,
  title,
  projectId: 'p1',
  projectName: 'shop',
  provider: 'claude',
  status: 'running',
  summary: '',
  pending: [],
  ...extra,
});

const tasks = [
  task('A', 'Backend API v2 endpoints', { name: 'backend' }),
  task('B', 'Frontend dashboard components', { name: 'frontend', provider: 'codex' }),
  task('C', 'Database schema migration', { name: 'database' }),
];
const ctx = (utterance: string, focusedTaskId: string | null = null, ts = tasks): RouteContext => ({
  utterance,
  focusedTaskId,
  tasks: ts,
  projects: [{ projectId: 'p1', name: 'shop' }],
});

describe('router decision matrix', () => {
  it('explicit alias wins over focus', () => {
    const d = decideDeterministic(ctx('Agent A, add a regression test', 't-B'));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-A', confidence: 'high' });
  });

  it('explicit alias in Chinese forms', () => {
    expect(decideDeterministic(ctx('让C先停一下', 't-A'))).toMatchObject({ kind: 'existing', taskId: 't-C' });
    expect(decideDeterministic(ctx('B号把按钮改成蓝色', null))).toMatchObject({ kind: 'existing', taskId: 't-B' });
  });

  it('the English article "a" is not an alias', () => {
    const d = decideDeterministic(ctx('add a regression test for this function', 't-B'));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-B' });
  });

  it('semantic reference to one task overrides visual focus', () => {
    const d = decideDeterministic(ctx('刚才那个数据库 Agent，先不要改 Schema', 't-A'));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-C' });
  });

  it('deictic reference defaults to the focused task', () => {
    const d = decideDeterministic(ctx('这个函数还能优化吗？', 't-A'));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-A', confidence: 'high' });
  });

  it('new task request with provider and project', () => {
    const d = decideDeterministic(ctx('开一个新的 Codex 帮我给 shop 的 frontend 写测试', null));
    expect(d).toMatchObject({ kind: 'create', provider: 'codex', projectId: 'p1' });
  });

  it('ambiguous reference asks instead of guessing', () => {
    const two = [task('A', 'Backend API v2 endpoints'), task('D', 'Backend API rate limiting'), task('B', 'Frontend dashboard')];
    const d = decideDeterministic(ctx('fix that API', 't-B', two));
    expect(d).toMatchObject({ kind: 'clarify' });
    expect(d && d.kind === 'clarify' && d.candidateTaskIds.sort()).toEqual(['t-A', 't-D']);
  });

  it('two experiments match → clarify', () => {
    const ts = [task('A', 'Run tokenizer experiment'), task('D', 'Benchmark experiment for cache')];
    expect(decideDeterministic(ctx('看一下刚刚那个实验', null, ts))).toMatchObject({ kind: 'clarify' });
  });

  it('workspace status questions go to the coordinator', () => {
    expect(decideDeterministic(ctx('哪些 agent 在等我？', 't-A'))).toMatchObject({ kind: 'coordinator' });
    expect(decideDeterministic(ctx("what's pending", null))).toMatchObject({ kind: 'coordinator' });
  });

  it('memory commands go to the coordinator', () => {
    expect(decideDeterministic(ctx('记住：这个项目总是先跑集成测试', 't-A'))).toMatchObject({ kind: 'coordinator' });
  });

  it('sensitive commands are never auto-sent', () => {
    const d = decideDeterministic(ctx('Agent C, run the migration now', 't-A'));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-C', confidence: 'medium' });
  });

  it('unreferenced speech falls back to focused task at medium confidence (no LLM)', async () => {
    const d = await decideRoute(ctx('sounds good, go ahead', 't-B'));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-B', confidence: 'medium' });
  });

  it('unreferenced speech in overview asks for a target', async () => {
    const d = await decideRoute(ctx('sounds good, go ahead', null));
    expect(d).toMatchObject({ kind: 'clarify' });
  });

  it('LLM answers are capped at medium confidence and unknown aliases are ignored', async () => {
    const d = await decideRoute(ctx('sounds good, go ahead', null), async () => ({ target: 'B', candidates: [], reason: 'x' }));
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-B', confidence: 'medium' });
    const u = await decideRoute(ctx('sounds good, go ahead', null), async () => ({ target: 'UNSURE', candidates: ['A', 'Z'], reason: 'x' }));
    expect(u).toMatchObject({ kind: 'clarify', candidateTaskIds: ['t-A'] });
  });

  it('LLM failure falls back safely', async () => {
    const d = await decideRoute(ctx('hmm', 't-A'), async () => {
      throw new Error('offline');
    });
    expect(d).toMatchObject({ kind: 'existing', taskId: 't-A', confidence: 'medium' });
  });
});
