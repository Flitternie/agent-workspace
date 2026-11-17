// How each kind of file looks in the preview: code, Markdown, CSV, PDF, Word. Screenshots for review
// (AMW_SHOT_TAG names them, e.g. before/after), plus checks that each renders as itself.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import type { Task } from '../../src/shared/types';

const appDir = resolve(__dirname, '../..');
const shots = join(appDir, 'test-results');
mkdirSync(shots, { recursive: true });
const tag = process.env.AMW_SHOT_TAG ?? 'render';
const strict = !process.env.AMW_SHOT_TAG || process.env.AMW_SHOT_TAG === 'after';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronPath = require('electron') as unknown as string;
let app: ElectronApplication | undefined;
afterAll(async () => {
  await app?.close().catch(() => {});
});
const invoke = <T,>(page: Page, channel: string, payload: unknown) =>
  page.evaluate(([c, p]) => (window as unknown as { amw: { invoke(c: string, p: unknown): Promise<unknown> } }).amw.invoke(c as string, p), [channel, payload] as const) as Promise<T>;

const CODE = `import { z } from 'zod';

/** An order line: what was bought, how many, at what price (cents). */
export interface Line {
  sku: string;
  qty: number;
  price: number;
}

const Order = z.object({ id: z.string().uuid(), lines: z.array(z.object({ sku: z.string(), qty: z.number().int().positive(), price: z.number() })) });

// Totals are computed in one place.
export function total(lines: Line[], discount = 0): number {
  const gross = lines.reduce((sum, l) => sum + l.qty * l.price, 0);
  return Math.max(0, Math.round(gross * (1 - discount)));
}

export async function load(id: string): Promise<Line[]> {
  const res = await fetch(\`/api/orders/\${id}\`);
  if (!res.ok) throw new Error(\`order \${id}: \${res.status}\`);
  return Order.parse(await res.json()).lines;
}
`;

const DOC = `# Orders v2 rollout

The dashboard reads orders from the **v2 API**. This note covers what changed, what is left, and the risks.

## What changed

- \`OrderCard\` and \`OrderList\` render the v2 fields
- Totals are computed in one place, see \`src/orders.ts\`

> Charts still read v1. Until they move, the totals on the chart and the cards can disagree by rounding.

| Component | Status | Owner |
| --- | --- | --- |
| OrderCard | done | Alice |
| RevenueChart | todo | Bob |

\`\`\`ts
export const total = (o: Order) => o.items.reduce((sum, i) => sum + i.price, 0);
\`\`\`

### Next

1. Move the charts
2. Remove the v1 client
`;

const CSV = ['sku,name,qty,price,region', ...Array.from({ length: 40 }, (_, i) => `SKU-${1000 + i},"Widget, size ${(i % 5) + 1}",${(i * 7) % 13},${(9.5 + i).toFixed(2)},${['EU', 'US', 'APAC'][i % 3]}`)].join('\n');

function repo(): string {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 'amw-render-'))), 'shop');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/orders.ts'), CODE);
  writeFileSync(join(dir, 'notes.md'), DOC);
  writeFileSync(join(dir, 'orders.csv'), CSV);
  // A Word document, made by macOS's own converter.
  writeFileSync(join(dir, 'plan.html'), '<h1>Quarterly Plan</h1><p>This document describes the <b>v2 orders</b> rollout and its <i>risks</i>.</p><h2>Milestones</h2><ul><li>Cards migrated</li><li>Charts next</li></ul><table border="1"><tr><th>Component</th><th>Status</th></tr><tr><td>OrderCard</td><td>done</td></tr><tr><td>RevenueChart</td><td>todo</td></tr></table>');
  execFileSync('textutil', ['-convert', 'docx', join(dir, 'plan.html'), '-output', join(dir, 'plan.docx')]);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('preview rendering', () => {
  it('shows code, Markdown, CSV, PDF and Word documents as themselves', async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir],
      cwd: appDir,
      env: { ...env, AMW_MAIN_AGENT: 'off', AMW_DATA_DIR: mkdtempSync(join(tmpdir(), 'amw-render-data-')), AMW_MOCK_DELAY_MS: '50', AMW_NO_OPENAI: '1', AMW_NO_AUTOLISTEN: '1' },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForSelector('.app');
    await invoke(page, 'settings:update', { onboarding: { dismissed: true } });
    const root = repo();
    // A PDF, printed by Chromium itself.
    const pdf = await app.evaluate(async ({ BrowserWindow }, html) => {
      const w = new BrowserWindow({ show: false });
      await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const data = await w.webContents.printToPDF({});
      w.destroy();
      return Buffer.from(data).toString('base64');
    }, '<h1 style="font-family:sans-serif">Q3 Report</h1><p style="font-family:sans-serif">Revenue grew 12% on the v2 dashboard.</p>');
    writeFileSync(join(root, 'report.pdf'), Buffer.from(pdf, 'base64'));
    const p = await invoke<{ projectId: string }>(page, 'project:add', { rootPath: root, name: 'shop' });
    const a = await invoke<Task>(page, 'task:create', { projectId: p.projectId, provider: 'mock', title: 'Files', name: 'Files', mockScript: 'ask:ok', instruction: 'Show files.', isolate: false });
    await expect.poll(() => page.getByTestId('agent-card').count(), { timeout: 30_000 }).toBe(1);
    const row = page.locator('[data-testid="rail-item"],[data-testid="needs-item"]').filter({ hasText: 'Files' }).first();

    const show = async (path: string) => {
      await page.evaluate(([id, p]) => localStorage.setItem(`amw.preview.${id}`, JSON.stringify({ path: p })), [a.taskId, path] as const);
      await page.getByRole('button', { name: /^Overview/ }).click();
      await row.click();
      await expect.poll(() => page.getByTestId('file-preview').getAttribute('data-path')).toBe(path);
      await page.waitForTimeout(1200);
    };
    const shot = (name: string) => page.screenshot({ path: join(shots, `${tag}-${name}.png`) });

    await show('src/orders.ts');
    await shot('code');
    if (strict) {
      // Coloured by Shiki, one row per line with its number.
      await expect.poll(() => page.locator('[data-testid="preview-code"] [data-line]').count()).toBe(CODE.replace(/\n$/, '').split('\n').length);
      await expect.poll(() => page.locator('[data-testid="preview-code"] [data-line="13"] span[style*="color"]').count()).toBeGreaterThan(0);
      // Its styles apply (a lost brace in styles.css once nested them away): monospace rows, a gutter apart from the code.
      const look = await page.locator('[data-testid="preview-code"] [data-line="1"]').evaluate((row) => ({ font: getComputedStyle(row).fontFamily, flex: getComputedStyle(row).display, gutter: getComputedStyle(row.querySelector('.ln')!).position }));
      expect(look.font).toMatch(/mono|Menlo|Monaco|Courier/i);
      expect(look).toMatchObject({ flex: 'flex', gutter: 'sticky' });
    }
    await show('notes.md');
    await shot('markdown');
    await show('orders.csv');
    await shot('csv');
    if (strict) {
      await expect.poll(() => page.locator('[data-testid="preview-table"] th:not(.rn)').allInnerTexts()).toEqual(['sku', 'name', 'qty', 'price', 'region']);
      expect(await page.locator('[data-testid="preview-table"] tbody tr').count()).toBe(40);
      expect(await page.locator('[data-testid="preview-table"] tbody tr').first().locator('td:not(.rn)').nth(1).innerText()).toBe('Widget, size 1');
    }
    await show('report.pdf');
    await shot('pdf');
    if (strict) await expect.poll(() => page.locator('[data-testid="preview-pdf"]').count()).toBe(1);
    await show('plan.docx');
    await shot('docx');
    if (strict) {
      const frame = page.frameLocator('[data-testid="preview-frame"]');
      await expect.poll(() => frame.locator('body').innerText()).toContain('Quarterly Plan');
      // Its formatting comes through (bold, italic), and nothing in it runs.
      await expect.poll(() => frame.locator('b', { hasText: 'v2 orders' }).count()).toBe(1);
      expect(await frame.locator('i', { hasText: 'risks' }).count()).toBe(1);
      expect(await page.getByTestId('preview-frame').getAttribute('sandbox')).toBe('');
    }
    void existsSync;
    void copyFileSync;
  }, 120_000);
});
