// Real-CLI smoke test for native adapters. Uses the user's installed Claude Code /
// Codex and their existing login; makes a few tiny model calls in a throwaway repo.
//   node out/smoke/providers.cjs [claude|codex|all]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../main/providers/claude';
import { CodexAdapter } from '../main/providers/codex';
import type { ProviderAdapter, ProviderEvent, ProviderSession } from '../main/providers/types';

const which = process.argv[2] ?? 'all';
const root = process.env.AMW_SMOKE_DIR ?? tmpdir();

function makeRepo(): string {
  const dir = mkdtempSync(join(root, 'amw-smoke-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# smoke test repo\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=smoke', 'commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

class Recorder {
  events: ProviderEvent[] = [];
  private waiters: Array<{ pred: (e: ProviderEvent) => boolean; resolve: (e: ProviderEvent) => void }> = [];
  push = (e: ProviderEvent) => {
    this.events.push(e);
    if (e.type !== 'outputDelta') console.log('   event', e.type, summary(e));
    this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true));
  };
  wait<T extends ProviderEvent['type']>(type: T, ms = 180_000): Promise<Extract<ProviderEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      this.waiters.push({
        pred: (e) => e.type === type,
        resolve: (e) => {
          clearTimeout(t);
          resolve(e as Extract<ProviderEvent, { type: T }>);
        },
      });
    });
  }
}

function summary(e: ProviderEvent): string {
  const s = JSON.stringify(e);
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

async function scenario(adapter: ProviderAdapter): Promise<void> {
  console.log(`\n=== ${adapter.provider}`);
  console.log('capabilities', await adapter.capabilities());
  const cwd = makeRepo();
  console.log('repo', cwd);
  const rec = new Recorder();
  let session: ProviderSession = adapter.createSession({ cwd, title: 'smoke' }, rec.push);
  await session.start();
  const id = session.nativeSessionId();
  console.log('native id', id);

  console.log('1) plain turn');
  await session.send('Remember the codeword PINEAPPLE-42. Reply with exactly the word READY and nothing else. Do not use tools.');
  const t1 = await rec.wait('turnCompleted');
  console.log('   final:', t1.finalText);

  console.log('2) approval request is surfaced and a denial is honoured');
  // Network + a write outside the workspace root need approval under both providers' default policies.
  const outside = join(cwd, '..', `outside-${Date.now()}.html`);
  await session.send(
    `Use your shell tool to run exactly: curl -s https://example.com -o ${outside} . If the sandbox blocks it, request escalated permissions to run it. If that is denied, reply DENIED and do not retry.`,
  );
  const ask = await Promise.race([rec.wait('approvalRequested'), rec.wait('turnCompleted').then(() => null)]);
  if (ask) {
    console.log('   approval:', ask.headline, ask.options.map((o) => o.id));
    await session.respond(ask.requestId, { decision: ask.options.find((o) => /deny|decline/.test(o.id))?.id ?? 'deny' });
    const t2 = await rec.wait('turnCompleted');
    console.log('   after deny final:', t2.finalText?.slice(0, 200));
  } else {
    console.log('   !! turn completed without an approval request (provider policy auto-allowed or refused)');
  }
  console.log('   file exists after deny?', existsSync(outside), existsSync(outside) ? '!! NOT HONOURED' : 'OK');

  await session.close();
  await new Promise((r) => setTimeout(r, 1500));

  console.log('3) resume with prior context');
  const rec2 = new Recorder();
  session = adapter.createSession({ cwd, title: 'smoke', resumeNativeSessionId: id }, rec2.push);
  await session.start();
  const replayed = rec2.events.filter((e) => e.type === 'transcriptItem' && e.history).length;
  console.log('   replayed history items:', replayed, 'native id now', session.nativeSessionId());
  await session.send('What was the codeword I asked you to remember? Reply with only the codeword.');
  const t3 = await rec2.wait('turnCompleted');
  console.log('   final:', t3.finalText, /PINEAPPLE-42/.test(t3.finalText ?? '') ? 'RESUME OK' : 'RESUME FAILED');

  const found = await adapter.discoverSessions({ cwd });
  console.log('4) discovered sessions for cwd:', found.length, found.some((s) => s.nativeSessionId === id) ? '(includes ours)' : '(ours missing)');
  await session.close();
}

(async () => {
  const adapters: ProviderAdapter[] = [];
  if (which === 'claude' || which === 'all') adapters.push(new ClaudeAdapter());
  if (which === 'codex' || which === 'all') adapters.push(new CodexAdapter());
  for (const a of adapters) {
    try {
      await scenario(a);
    } catch (error) {
      console.error(`!! ${a.provider} smoke failed:`, error);
      process.exitCode = 1;
    }
  }
  setTimeout(() => process.exit(), 500);
})();
