import type { IpcChannel, IpcInput } from '../shared/ipc';
import type {
  AttentionItem,
  DispatchResult,
  MemoryRecord,
  NativeSessionInfo,
  Project,
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

interface Outputs {
  'workspace:snapshot': WorkspaceSnapshot;
  'transcript:get': TranscriptItem[];
  'project:pickDirectory': string | null;
  'project:add': Project;
  'task:create': Task;
  'task:send': DispatchResult;
  'task:interrupt': void;
  'task:resume': void;
  'task:stop': void;
  'task:rename': void;
  'task:remove': string;
  'sessions:discover': NativeSessionInfo[];
  'task:importSession': Task;
  'attention:respond': void;
  'attention:dismiss': void;
  'voice:ensureMic': boolean;
  'voice:transcribe': { text: string };
  'route:decide': RouteDecision;
  'route:dispatch': DispatchResult & { reply?: string };
  'memory:add': MemoryRecord;
  'memory:update': void;
  'memory:delete': void;
  'memory:promote': MemoryRecord;
  'settings:update': void;
  'capabilities:refresh': void;
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
