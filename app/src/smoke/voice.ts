// Voice pipeline smoke test against the real OpenAI API:
// TTS (test fixture only) -> our STT client -> router (rules + LLM classifier).
//   node out/smoke/voice.cjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadOpenAiKey, OpenAiClient, ROUTER_MODEL, STT_MODEL } from '../main/openai';
import { decideRoute, type RouteContext } from '../main/router';

const key = loadOpenAiKey(process.cwd());
if (!key) {
  console.error('No OpenAI key found');
  process.exit(1);
}
const ai = new OpenAiClient(key);

async function speak(text: string): Promise<Uint8Array> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'alloy', input: text, response_format: 'wav' }),
  });
  if (!res.ok) throw new Error(`TTS failed ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

const tasks: RouteContext['tasks'] = [
  { taskId: 't-A', alias: 'Alice', name: 'backend', title: 'Backend API v2 endpoints', projectId: 'p', projectName: 'demo-shop', provider: 'claude', status: 'waiting_for_user', summary: 'Asked about legacy /v1/orders tests', pending: ['Keep a compatibility adapter?'] },
  { taskId: 't-B', alias: 'Bob', name: 'frontend', title: 'Frontend dashboard components', projectId: 'p', projectName: 'demo-shop', provider: 'codex', status: 'running', summary: 'Building the checkout page buttons and cards', pending: [] },
  { taskId: 't-C', alias: 'Charlie', name: 'database', title: 'Database schema migration', projectId: 'p', projectName: 'demo-shop', provider: 'claude', status: 'waiting_for_user', summary: 'Migration drops orders.notes', pending: ['Data-loss risk; proceed?'] },
];
// The same agents as a Chinese-UI workspace names them.
const tasksZh = tasks.map((t, i) => ({ ...t, alias: ['小王', '小李', '小张'][i] }));
const ctx = (utterance: string, focusedTaskId: string | null, zh = false): RouteContext => ({ utterance, focusedTaskId, tasks: zh ? tasksZh : tasks, projects: [{ projectId: 'p', name: 'demo-shop' }] });

(async () => {
  console.log(`STT ${STT_MODEL}, router ${ROUTER_MODEL}`);
  const hint = 'Agent Meeting Workspace. ' + tasks.map((t) => `${t.alias} (${t.name}): ${t.title}.`).join(' ');
  const cases: Array<{ say: string; focus: string | null; expect: string; zh?: boolean }> = [
    { say: 'Alice, add a regression test for the orders endpoint.', focus: 't-B', expect: 'existing:t-A' },
    { say: '刚才那个数据库的 Agent，先不要改 schema。', focus: 't-A', expect: 'existing:t-C' },
    { say: 'Make the checkout buttons on that page a bit bigger.', focus: null, expect: 'existing:t-B' },
    // No rule matches "persistence": only the LLM classifier can resolve this (capped at medium).
    { say: 'Whoever is handling persistence should hold off for now.', focus: 't-B', expect: 'existing:t-C' },
    { say: '小张，迁移先停一下，等我确认。', focus: 't-A', expect: 'existing:t-C', zh: true },
    { say: '小王，帮我把订单接口的测试跑一遍。', focus: 't-B', expect: 'existing:t-A', zh: true },
    { say: '让小李把结算按钮调大一点。', focus: 't-A', expect: 'existing:t-B', zh: true },
    // Leading stop word + name (used by tests/e2e/voice-live as voice-7.wav).
    { say: '等一下，Charlie，先别删那个表。', focus: 't-A', expect: 'existing:t-C' },
  ];
  let failures = 0;
  for (const c of cases) {
    const audio = await speak(c.say);
    writeFileSync(join(process.cwd(), '.cache', `voice-${cases.indexOf(c)}.wav`), audio);
    const t0 = Date.now();
    const heard = await ai.transcribe(audio, 'audio/wav', c.zh ? 'Agent Meeting Workspace. ' + tasksZh.map((t) => `${t.alias} (${t.name}): ${t.title}.`).join(' ') : hint);
    const t1 = Date.now();
    const d = await decideRoute(ctx(heard, c.focus, c.zh), (x) => ai.routeClassify(x));
    const t2 = Date.now();
    const got = d.kind === 'existing' ? `existing:${d.taskId}` : d.kind;
    const ok = got === c.expect;
    if (!ok) failures++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} said: ${c.say}\n     heard: ${heard}  (${t1 - t0} ms)\n     route: ${JSON.stringify(d)}  (${t2 - t1} ms)`);
  }
  process.exit(failures ? 1 : 0);
})();
