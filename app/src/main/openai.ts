import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LlmRouteAnswer, RouteContext } from './router';

// OpenAI is used for two opt-in helpers only: speech-to-text and the routing
// classifier. The key never leaves the main process. Only the utterance and
// compact task metadata (names, titles, one-line summaries) are sent for routing,
// never transcripts or file contents.

export const STT_MODEL = process.env.AMW_STT_MODEL ?? 'gpt-4o-transcribe';
export const ROUTER_MODEL = process.env.AMW_ROUTER_MODEL ?? 'gpt-4.1-mini';

/** OPENAI_API_KEY, else AMW_OPENAI_KEY_FILE, else an `openai.key` file in this folder or a parent. */
export function loadOpenAiKey(startDir: string): string | undefined {
  if (process.env.AMW_NO_OPENAI === '1') return undefined;
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim();
  const candidates: string[] = [];
  if (process.env.AMW_OPENAI_KEY_FILE) candidates.push(process.env.AMW_OPENAI_KEY_FILE);
  let dir = resolve(startDir);
  for (let i = 0; i < 4; i++) {
    candidates.push(join(dir, 'openai.key'));
    dir = dirname(dir);
  }
  for (const file of candidates) {
    if (existsSync(file)) {
      const key = readFileSync(file, 'utf8').trim();
      if (key) return key;
    }
  }
  return undefined;
}

export class OpenAiClient {
  constructor(private key: string) {}

  async transcribe(audio: Uint8Array, mimeType: string, prompt?: string): Promise<string> {
    const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType || 'audio/webm' }), `utterance.${ext}`);
    form.append('model', STT_MODEL);
    if (prompt) form.append('prompt', prompt.slice(0, 800));
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }

  async chatJson<T>(system: string, user: string, schema: Record<string, unknown>, name: string): Promise<T> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ROUTER_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Classifier failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return JSON.parse(json.choices?.[0]?.message?.content ?? 'null') as T;
  }

  async routeClassify(ctx: RouteContext): Promise<LlmRouteAnswer | null> {
    const focused = ctx.tasks.find((t) => t.taskId === ctx.focusedTaskId);
    const tasks = ctx.tasks
      .map(
        (t) =>
          `- alias ${t.alias} | name "${t.name}" | project "${t.projectName}" | ${t.provider} | ${t.status} | title: ${t.title} | latest: ${t.summary.slice(0, 160)}${t.pending.length ? ` | waiting on: ${t.pending.join('; ').slice(0, 200)}` : ''}`,
      )
      .join('\n');
    const system = [
      'You route a user\'s spoken instruction to exactly one coding-agent task in a workspace, or decide it is a new task, a workspace (coordinator) question, or unclear.',
      'The task the user is currently looking at is a hint for words like "this" or "here", not a requirement.',
      'If two or more tasks plausibly match, answer UNSURE and list them as candidates. Never guess between close candidates.',
    ].join(' ');
    const user = `Focused task: ${focused ? focused.alias : 'none (overview)'}\nTasks:\n${tasks}\n\nUtterance: ${ctx.utterance}`;
    return this.chatJson<LlmRouteAnswer>(
      system,
      user,
      {
        type: 'object',
        additionalProperties: false,
        required: ['target', 'candidates', 'reason'],
        properties: {
          target: { type: 'string', description: 'task alias, or NEW, COORDINATOR, UNSURE' },
          candidates: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
        },
      },
      'route',
    );
  }
}
