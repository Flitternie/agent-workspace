import type { IpcChannel, IpcInput } from '../shared/ipc';
import type {
  ModelOption,
  AttentionItem,
  DispatchResult,
  FilePreview,
  ForkPoint,
  MemoryRecord,
  NativeSessionInfo,
  Project,
  RemoteHostStatus,
  RouteDecision,
  Task,
  TranscriptItem,
  WorkspaceSnapshot,
} from '../shared/types';

interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  onWorkspace(cb: (s: WorkspaceSnapshot) => void): () => void;
  onTranscript(cb: (update: { items: TranscriptItem[]; resets: string[] }) => void): () => void;
}

declare global {
  interface Window {
    amw: Bridge;
  }
}

export interface Outputs {
  'workspace:snapshot': WorkspaceSnapshot;
  'transcript:get': TranscriptItem[];
  'project:pickDirectory': string | null;
  'project:add': Project;
  'ssh:hosts': Array<{ host: string; hostName?: string; user?: string }>;
  'ssh:setEnabled': void;
  'ssh:check': RemoteHostStatus;
  'ssh:install': { ok: boolean; error?: string };
  'ssh:login': { url?: string; code?: string };
  'ssh:loginCode': void;
  'ssh:loginCancel': void;
  'ssh:connect': RemoteHostStatus;
  'ssh:terminal': void;
  'task:create': Task;
  'task:send': DispatchResult;
  'task:interrupt': void;
  'task:models': ModelOption[];
  'task:setModel': void;
  'task:shell': { ok: boolean; error?: string };
  'task:forkPoints': ForkPoint[];
  'task:fork': Task;
  'task:retry': void;
  'task:resume': void;
  'task:stop': void;
  'task:rename': void;
  'task:viewed': void;
  'task:setPermissionMode': void;
  'task:remove': string;
  'sessions:discover': NativeSessionInfo[];
  'sessions:discoverAll': NativeSessionInfo[];
  'sessions:discoverHost': NativeSessionInfo[];
  'task:importSession': Task;
  'attention:respond': void;
  'attention:dismiss': void;
  'voice:ensureMic': boolean;
  'voice:transcribe': { text: string };
  'route:decide': RouteDecision;
  'route:dispatch': DispatchResult & { reply?: string };
  'file:preview': FilePreview;
  'file:open': void;
  'memory:add': MemoryRecord;
  'memory:update': void;
  'memory:delete': void;
  'memory:promote': MemoryRecord;
  'settings:update': void;
  'capabilities:refresh': void;
  'provider:login': { url?: string; code?: string };
  'provider:loginCancel': void;
  'provider:loginApiKey': { ok: boolean; error?: string };
  'apps:detect': { claude: boolean; chatgpt: boolean };
  'apps:installed': Array<{ id: string; name: string; kind: 'editor' | 'git' | 'terminal' | 'files'; lines: boolean; icon?: string }>;
  'apps:open': void;
  'task:remoteControl': string | undefined;
  'file:stat': { mtimeMs: number; size: number } | null;
  'models:list': string[];
  'openai:setKey': { ok: boolean; error?: string; overriddenByEnv?: boolean };
  'openai:clearKey': void;
  'stt:download': void;
  'stt:cancel': void;
  'stt:delete': void;
  'demo:seed': void;
}

export function call<C extends IpcChannel>(channel: C, payload: IpcInput<C>): Promise<Outputs[C]> {
  return window.amw.invoke(channel, payload) as Promise<Outputs[C]>;
}

/** Electron prefixes handler errors; keep only the useful message. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export type { AttentionItem };
