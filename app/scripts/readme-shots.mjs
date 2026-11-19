// Screenshots for the README (and the project page): the Overview, the main agent with its Team Map,
// and an agent with its Session Map, in English and Chinese. Real Claude Code and Codex agents (your
// own, signed in) do small tasks in a scratch repository, so no real project or data shows; their
// wording differs from run to run, and a run takes a few minutes and a little usage.
//
//   npm run build && node scripts/readme-shots.mjs [en|zh]     → ../docs/assets/<lang>/*.png
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appDir = resolve(import.meta.dirname, '..');
const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['en', 'zh'];

// What the agents are asked (small, real tasks in the scratch repository).
const TEXT = {
  en: {
    agents: [
      { provider: 'claude', title: 'Orders API validation', mode: 'ask', instruction: 'In src/api/orders.ts, validate the body of createOrder: items must be non-empty and quantities positive integers. Keep the change small.' },
      { provider: 'codex', title: 'Revenue card', instruction: 'Add a RevenueCard component in src/dashboard that shows the total revenue of the orders it is given, and use it in Dashboard.tsx. Keep it small.' },
      { provider: 'claude', title: 'Order history index', instruction: 'We need an index for order history queries (by customer_id, newest first). Before writing a migration in src/db, ask me one question: plain or concurrent index? Then stop and wait.' },
    ],
    toAgent: ['Format the amount as currency with Intl.NumberFormat.', 'Something else now: add an "Export CSV" button to the dashboard that downloads the orders.', 'Last one: show a loading skeleton in the dashboard while orders load.'],
    fork: 'Instead of a total, try a sparkline of daily revenue.',
    toMain: [
      'Pass these on: the revenue card agent should also show the change from last week; the migration agent should use a concurrent index; the sparkline agent should keep the chart under 40px tall.',
      'How is everyone doing?',
    ],
    overview: 'Overview',
  },
  zh: {
    agents: [
      { provider: 'claude', title: '订单接口校验', mode: 'ask', instruction: '在 src/api/orders.ts 里给 createOrder 的请求体加校验：items 不能为空，数量必须是正整数。改动尽量小。' },
      { provider: 'codex', title: '营收卡片', instruction: '在 src/dashboard 里加一个 RevenueCard 组件，显示传入订单的总营收，并在 Dashboard.tsx 里用上。改动尽量小。' },
      { provider: 'claude', title: '订单历史索引', instruction: '订单历史查询（按 customer_id、最新在前）需要一个索引。在 src/db 写迁移之前，先问我一个问题：普通索引还是并发索引？问完就停下等我。' },
    ],
    toAgent: ['金额用 Intl.NumberFormat 格式化成货币。', '换个事：在看板上加一个「导出 CSV」按钮，下载订单数据。', '最后一个：订单加载时在看板上显示骨架屏。'],
    fork: '不显示总额，改成每日营收的迷你折线图试试。',
    toMain: ['帮我转达：营收卡片那个 agent 再显示和上周相比的变化；索引那个 agent 用并发索引；折线图那个 agent 把图控制在 40px 高以内。', '大家进展怎么样？'],
    overview: '总览',
  },
};

const FILES = {
  'README.md': '# shop\n\nA small storefront: an orders API, a dashboard and the database schema.\n',
  'package.json': JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'src/api/orders.ts': `export interface OrderItem { sku: string; quantity: number; price: number }
export interface Order { id: string; customerId: string; items: OrderItem[]; createdAt: string }

const orders: Order[] = [];

export function createOrder(body: { customerId: string; items: OrderItem[] }): Order {
  const order = { id: crypto.randomUUID(), customerId: body.customerId, items: body.items, createdAt: new Date().toISOString() };
  orders.push(order);
  return order;
}

export function listOrders(customerId: string): Order[] {
  return orders.filter((o) => o.customerId === customerId);
}
`,
  'src/dashboard/Dashboard.tsx': `import type { Order } from '../api/orders';
import { Card } from './Card';

export function Dashboard({ orders }: { orders: Order[] }) {
  return (
    <main>
      <Card title="Orders">{orders.length}</Card>
    </main>
  );
}
`,
  'src/dashboard/Card.tsx': `import type { ReactNode } from 'react';

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="card-body">{children}</div>
    </section>
  );
}
`,
  'src/db/schema.sql': `CREATE TABLE orders (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
};

/** Rounds a screenshot's corners (transparent outside), drawn on a canvas in the app's own page. */
async function roundCorners(page, file, radius = 44) {
  const png = readFileSync(file).toString('base64');
  const out = await page.evaluate(async ([png, radius]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${png}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.roundRect(0, 0, img.width, img.height, radius);
    ctx.clip();
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  }, [png, radius]);
  writeFileSync(file, Buffer.from(out, 'base64'));
}

async function shoot(lang) {
  const t = TEXT[lang];
  const out = resolve(appDir, '..', 'docs', 'assets', lang);
  mkdirSync(out, { recursive: true });
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'amw-shots-')));
  const repo = join(scratch, 'shop');
  for (const [f, body] of Object.entries(FILES)) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=demo@local', '-c', 'user.name=demo', 'commit', '-qm', 'init'], { cwd: repo });

  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['ELECTRON_RUN_AS_NODE', 'CLAUDECODE'].includes(k)) env[k] = v;
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--force-device-scale-factor=2', appDir],
    // Off screen (no window pops up while it runs), at a fixed size.
    cwd: appDir,
    env: { ...env, AMW_BACKGROUND: '1', AMW_MAIN_AGENT: 'claude', AMW_DATA_DIR: join(scratch, 'data'), AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
  });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 900));
    await page.waitForSelector('.app');
    const inv = (c, p) => page.evaluate(([c, p]) => window.amw.invoke(c, p), [c, p]);
    const snap = () => inv('workspace:snapshot', {});
    const until = async (pred, ms = 120_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await pred()) return;
        await page.waitForTimeout(500);
      }
      throw new Error('timed out');
    };
    const statusOf = async (id) => {
      const s = await snap();
      return (s.main?.taskId === id ? s.main : s.tasks.find((x) => x.taskId === id))?.status;
    };
    const settled = (id, ms) => until(async () => !['running', 'starting'].includes(await statusOf(id)), ms);
    await inv('settings:update', { onboarding: { dismissed: true }, language: lang });
    await until(async () => !!(await snap()).main, 30_000);
    const main = (await snap()).main;

    const p = await inv('project:add', { rootPath: repo, name: 'shop' });
    const tasks = [];
    for (const a of t.agents) {
      const task = await inv('task:create', { projectId: p.projectId, provider: a.provider, title: a.title, name: a.title, isolate: true });
      if (a.mode) await inv('task:setPermissionMode', { taskId: task.taskId, mode: a.mode });
      await inv('task:send', { taskId: task.taskId, text: a.instruction, via: 'text' });
      tasks.push(task);
    }
    await page.waitForTimeout(3000);
    for (const x of tasks) await settled(x.taskId, 600_000);

    // The Session Map's agent: a few turns, and a fork from before the last one.
    const card = tasks[1];
    for (const text of t.toAgent) {
      await inv('task:send', { taskId: card.taskId, text, via: 'text' });
      await page.waitForTimeout(2000);
      await settled(card.taskId, 600_000);
    }
    const points = await inv('task:forkPoints', { taskId: card.taskId });
    if (points.length) await inv('task:fork', { taskId: card.taskId, upToMessageId: points.at(-1).upToMessageId, isolate: true, instruction: t.fork });

    // The main agent hands work out: its Team Map gets a lane per agent.
    for (const text of t.toMain) {
      await inv('task:send', { taskId: main.taskId, text, via: 'text' });
      await page.waitForTimeout(3000);
      await settled(main.taskId, 600_000);
    }
    await page.waitForTimeout(5000);

    // 1. The Overview.
    await page.getByRole('button', { name: t.overview }).first().click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out, 'overview.png') });

    // 2. The main agent, its Team Map beside the conversation.
    await page.getByTestId('main-agent-row').click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(out, 'team-map.png') });

    // 3. An agent with its Session Map (grouped by the background model).
    await page.locator(`[data-testid="rail-item"][data-alias="${card.alias}"],[data-testid="needs-item"][data-alias="${card.alias}"]`).first().click();
    // The grouping is asked for when the map opens; until it comes back the map shows one task.
    await until(async () => (await page.getByTestId('map-task').count()) >= 2, 180_000).catch(() => console.log(`${lang}: the session map stayed one task`));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(out, 'session-map.png') });
    for (const f of ['overview.png', 'team-map.png', 'session-map.png']) await roundCorners(page, join(out, f));
    console.log(`${lang}: done → ${out}`);
  } finally {
    await app.close();
  }
}

for (const lang of langs) await shoot(lang);
