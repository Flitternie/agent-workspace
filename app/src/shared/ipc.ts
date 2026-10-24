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
  'task:send': z.object({ taskId: id, text: text.min(1), via: z.enum(['text', 'card']) }),
  'task:interrupt': z.object({ taskId: id }),
  'task:resume': z.object({ taskId: id }),
  'task:stop': z.object({ taskId: id }),
  'task:rename': z.object({ taskId: id, name: z.string().min(1).max(100) }),
  'task:remove': z.object({ taskId: id }),
  'sessions:discover': z.object({ projectId: id, provider: z.enum(['claude', 'codex']) }),
  'task:importSession': z.object({
    projectId: id,
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
  'voice:transcribe': z.object({ audio: z.instanceof(Uint8Array), mimeType: z.string().max(100) }),
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
  'settings:update': z.object({ alwaysConfirmVoice: z.boolean().optional() }),
  'demo:seed': z.object({}),
} as const;

export type IpcChannel = keyof typeof ipcSchemas;
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcSchemas)[C]>;
export const IPC_CHANNELS = Object.keys(ipcSchemas) as IpcChannel[];

export const EVENT_WORKSPACE = 'event:workspace';
export const EVENT_TRANSCRIPT = 'event:transcript';
