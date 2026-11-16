// Word and other office documents in the preview, without bundling an office suite: macOS's own
// `textutil` converts them to HTML (docx, doc, rtf, odt). What comes back is shown in a sandboxed frame
// with no scripts and nothing loaded from anywhere; scripts and event handlers are stripped as well.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Readable defaults around textutil's own styles (it keeps the document's fonts and sizes). */
const BASE_STYLE = `<style>
html { background: #fff; }
body { margin: 0 auto; padding: 20px 24px 40px; max-width: 760px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; color: #15181d; }
table { border-collapse: collapse; margin: 10px 0; }
td, th { border: 1px solid #d0d5dd; padding: 4px 8px; vertical-align: top; }
img { max-width: 100%; }
</style>`;

/** Removes anything that could run: script/iframe/object elements, on* handlers and javascript: URLs. */
export function inertHtml(html: string): string {
  return html
    .replace(/<(script|iframe|object|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(script|iframe|object|embed|link|meta|base|form|noscript|template)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}

export async function documentToHtml(data: Uint8Array, name: string): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Office documents preview on macOS (it uses the system’s converter). Open it in its app instead.');
  const dir = mkdtempSync(join(tmpdir(), 'amw-doc-'));
  try {
    const file = join(dir, `document${extname(name).toLowerCase()}`);
    writeFileSync(file, data);
    const { stdout } = await run('/usr/bin/textutil', ['-convert', 'html', '-stdout', '-noload', '-nostore', file], { timeout: 20_000, maxBuffer: 50_000_000 });
    const html = inertHtml(stdout);
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${BASE_STYLE}`) : `${BASE_STYLE}${html}`;
  } catch (error) {
    throw new Error(`Could not read this document: ${(error as Error).message.split('\n')[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
