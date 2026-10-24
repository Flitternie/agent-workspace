// Bundles the Electron main process, preload and smoke scripts with esbuild.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', '@anthropic-ai/claude-agent-sdk'],
  logLevel: 'warning',
};
await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'out/main/index.cjs' });
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'out/preload/index.cjs' });
for (const name of ['providers', 'voice'])
  if (existsSync(`src/smoke/${name}.ts`))
    await build({ ...common, entryPoints: [`src/smoke/${name}.ts`], outfile: `out/smoke/${name}.cjs` });
console.log('main/preload built');
