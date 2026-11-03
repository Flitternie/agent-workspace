import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { childEnv, findExecutable, needsShell, run } from '../util/exec';

/** OpenCode's public HTTP/SSE API, owned by one local provider session. */
export class OpenCodeServer {
  private proc?: ChildProcessWithoutNullStreams;
  private url = '';
  private authorization: string;
  private lifetime = new AbortController();
  private stream?: AbortController;
  closed = false;
  apiVersion: 1 | 2 = 1;
  onExit: (reason: string) => void = () => {};

  constructor(private cwd: string, private password = randomBytes(32).toString('hex')) {
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  }

  async start(): Promise<void> {
    const exe = findExecutable('opencode');
    if (!exe) throw new Error('OpenCode CLI not found on PATH. Install opencode and recheck in Settings.');
    const version = await run(exe, ['--version'], { timeoutMs: 15_000 });
    const major = /\bv?(\d+)\.\d+\.\d+/.exec(version.stdout)?.[1];
    if (version.code !== 0 || !['1', '2'].includes(major ?? '')) throw new Error('Could not identify a supported OpenCode CLI version (1.x or 2.x). Check opencode --version.');
    this.apiVersion = major === '2' ? 2 : 1;
    const proc = spawn(needsShell(exe) ? `"${exe}"` : exe, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: this.cwd,
      // 2.x prefers OPENCODE_PASSWORD over the legacy variable. Override both
      // so a password inherited from the user's shell cannot change this server.
      env: { ...childEnv(), OPENCODE_PASSWORD: this.password, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_ENABLE_QUESTION_TOOL: 'true' },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
      shell: needsShell(exe),
    });
    this.proc = proc;
    // Diagnostics can contain credentials. Only the announced loopback URL is retained.
    proc.stderr.resume();
    const lines = createInterface({ input: proc.stdout });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('OpenCode server did not start within 30 seconds.')), 30_000);
        const fail = (reason: string) => {
          clearTimeout(timer);
          reject(new Error(reason));
          if (!this.closed) {
            this.close();
            this.onExit(reason);
          }
        };
        proc.once('error', (error) => fail(error.message));
        proc.once('exit', (code, signal) => fail(`OpenCode server exited (${signal ?? code}).`));
        lines.on('line', (line: string) => {
          const match = /\bhttp:\/\/127\.0\.0\.1:(\d+)\b/.exec(line);
          if (!match || this.url) return;
          this.url = match[0];
          clearTimeout(timer);
          resolve();
        });
      });
      if (this.apiVersion === 2) await this.request('/api/info');
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<{ response: Response; url: URL }> {
    if (this.closed || !this.url) throw new Error('OpenCode server is not connected.');
    const url = new URL(path, this.url);
    if (this.apiVersion === 1) url.searchParams.set('directory', this.cwd);
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: this.authorization, 'Content-Type': 'application/json', Accept: 'application/json', ...init.headers },
      signal: AbortSignal.any([this.lifetime.signal, init.signal ?? AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) {
      throw this.responseError(url, init.method ?? 'GET', response, 'request failed', await responsePreview(response));
    }
    return { response, url };
  }

  async request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const { response, url } = await this.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 204) return;
    if (!/^application\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get('content-type') ?? ''))
      throw this.responseError(url, method, response, 'expected JSON', await responsePreview(response));
    const text = await response.text();
    try { return JSON.parse(text); }
    catch { throw this.responseError(url, method, response, 'invalid JSON', text); }
  }

  private responseError(url: URL, method: string, response: Response, reason: string, body: string): Error {
    const preview = body.replaceAll(this.authorization, '[redacted]').replaceAll(this.password, '[redacted]').slice(0, 512);
    return new Error(`OpenCode ${method} ${url.href}: ${reason} (HTTP ${response.status}, Content-Type: ${response.headers.get('content-type') ?? 'missing'}). Body: ${JSON.stringify(preview)}`);
  }

  /** Subscribe before sending a prompt so even a fast reply cannot be missed. */
  async subscribe(onEvent: (event: unknown) => void): Promise<void> {
    this.stream = new AbortController();
    const timer = setTimeout(() => this.stream?.abort(), 30_000);
    let result: { response: Response; url: URL };
    try {
      result = await this.fetch(this.apiVersion === 2 ? '/api/event' : '/event', { signal: this.stream.signal, headers: { Accept: 'text/event-stream' } });
    } finally {
      clearTimeout(timer);
    }
    const { response, url } = result;
    if (!/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? ''))
      throw this.responseError(url, 'GET', response, 'expected an SSE event stream', await responsePreview(response));
    if (!response.body) throw new Error('OpenCode did not return an event stream.');
    void readOpenCodeEvents(response.body, onEvent).then(
      () => this.disconnected('OpenCode event stream closed.'),
      () => this.disconnected('OpenCode event stream disconnected.'),
    );
  }

  private disconnected(reason: string): void {
    if (this.closed) return;
    this.close();
    this.onExit(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.stream?.abort();
    const proc = this.proc;
    if (!proc) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal);
        else proc.kill(signal);
      } catch { /* already gone */ }
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 2000);
    timer.unref();
  }
}

/** Read only enough of unexpected responses to diagnose HTML/proxy errors. */
async function responsePreview(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < 512) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, 512 - size);
      chunks.push(chunk); size += chunk.length;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** SSE frames may span chunks, contain CRLF, comments and multiple data lines. */
export async function readOpenCodeEvents(body: ReadableStream<Uint8Array>, emit: (event: unknown) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const line = (value: string) => {
    if (!value) {
      if (data.length) {
        const json = data.join('\n');
        data = [];
        emit(JSON.parse(json));
      }
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 8 * 1024 * 1024) throw new Error('OpenCode event exceeded the stream limit.');
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
