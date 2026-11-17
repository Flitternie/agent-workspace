import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every "are you sure?" uses the app's own ConfirmDialog (components/Dialogs.tsx), one look throughout.
// The system's confirm/alert/prompt boxes look foreign and block the window; this keeps them out.
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

describe('dialogs', () => {
  it('asks through ConfirmDialog, never the system confirm/alert/prompt', () => {
    const root = join(__dirname, '../../src/renderer');
    const hits = files(root).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .flatMap((line, i) => (/\b(window\.)?(confirm|alert|prompt)\s*\(/.test(line.replace(/\/\/.*$/, '')) && !/\bConfirmDialog\b/.test(line) ? [`${relative(root, f)}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });
});
