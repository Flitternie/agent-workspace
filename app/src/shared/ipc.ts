import { z } from 'zod';

// Every renderer -> main call goes through one of these named channels. The main
// process validates the payload with the schema before acting on it; the preload
// refuses any channel not listed here. There is deliberately no generic exec.

const id = z.string().min(1).max(200);
const text = z.string().max(100_000);

export const ipcSchemas = {
  'workspace:snapshot': z.object({}),
  'transcript:get': z.object({ taskId: id }),
  'project:pickDirectory': z.object({}),
  'project:add': z.object({ rootPath: z.string().min(1).max(4096), name: z.string().max(200).optional() }),
  'task:create': z.object({
    projectId: id,
    provider: z.enum(['claude', 'codex', 'mock']),
    title: z.string().min(1).max(500),
    name: z.string().max(100).optional(),
    instruction: text.optional(),
    isolate: z.boolean(),
    mockScript: z.string().max(50).optional(),
  }),
  'task:send': z.object({ taskId: id, text: text.min(1), via: z.enum(['text', 'card']), interrupt: z.boolean().optional() }),
  'task:interrupt': z.object({ taskId: id }),
  'task:resume': z.object({ taskId: id }),
  'task:stop': z.object({ taskId: id }),
  'task:rename': z.object({ taskId: id, name: z.string().min(1).max(100) }),
  'task:setPermissionMode': z.object({ taskId: id, mode: z.enum(['auto', 'edits', 'ask']) }),
  'task:remove': z.object({ taskId: id }),
  'sessions:discover': z.object({ projectId: id, provider: z.enum(['claude', 'codex']) }),
  'sessions:discoverAll': z.object({}),
  'task:importSession': z.object({
    projectId: id.optional(),
    provider: z.enum(['claude', 'codex']),
    nativeSessionId: id,
    cwd: z.string().min(1).max(4096),
    title: z.string().min(1).max(500),
  }),
  'attention:respond': z.object({
    attentionId: id,
    decision: z.string().max(100).optional(),
    answers: z.record(z.string(), z.string().max(10_000)).optional(),
  }),
  'attention:dismiss': z.object({ attentionId: id }),
  'voice:ensureMic': z.object({}),
  // One utterance; 16 kHz mono WAV caps at ~1 MB per 30 s.
  'voice:transcribe': z.object({ audio: z.instanceof(Uint8Array).refine((a) => a.byteLength <= 8_000_000, 'Audio clip too large'), mimeType: z.string().max(100) }),
  'route:decide': z.object({ utterance: text.min(1), focusedTaskId: id.nullable() }),
  'route:dispatch': z.object({
    utterance: text.min(1),
    focusedTaskId: id.nullable(),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('existing'), taskId: id }),
      z.object({ kind: z.literal('coordinator') }),
      z.object({
        kind: z.literal('create'),
        projectId: id,
        provider: z.enum(['claude', 'codex', 'mock']),
        title: z.string().min(1).max(500),
      }),
    ]),
    interrupt: z.boolean().optional(),
    /** Typed into the bar rather than spoken. */
    typed: z.boolean().optional(),
  }),
  'memory:add': z.object({
    scope: z.enum(['global', 'project', 'task']),
    scopeId: id,
    body: z.string().min(1).max(10_000),
    originTaskId: id.optional(),
    approvedForReuse: z.boolean(),
  }),
  'memory:update': z.object({
    id,
    body: z.string().min(1).max(10_000).optional(),
    approvedForReuse: z.boolean().optional(),
  }),
  'memory:delete': z.object({ id }),
  'memory:promote': z.object({ id, scope: z.enum(['project', 'global']) }),
  'settings:update': z.object({ alwaysConfirmVoice: z.boolean().optional(), autoListen: z.boolean().optional(), language: z.enum(['en', 'zh']).optional(), permissionMode: z.enum(['auto', 'edits', 'ask']).optional(), sttModel: z.string().regex(/^[\w.:-]{1,80}$/).optional(), routerModel: z.string().regex(/^[\w.:-]{1,80}$/).optional(), voicePauseMs: z.number().int().min(800).max(8000).optional() }),
  'capabilities:refresh': z.object({}),
  'models:list': z.object({}),
  'openai:setKey': z.object({ key: z.string().min(20).max(400).regex(/^\S+$/) }),
  'openai:clearKey': z.object({}),
  'stt:download': z.object({ id }),
  'stt:cancel': z.object({ id }),
  'stt:delete': z.object({ id }),
  'demo:seed': z.object({}),
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcSchemas)[C]>;
export const IPC_CHANNELS = Object.keys(ipcSchemas) as IpcChannel[];

export const EVENT_WORKSPACE = 'event:workspace';
export const EVENT_TRANSCRIPT = 'event:transcript';
