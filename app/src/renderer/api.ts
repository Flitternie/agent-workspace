import type { IpcChannel, IpcInput } from '../shared/ipc';
import type { FoundSkill, LibrarySkill } from '../shared/skills';
import type {
  AttentionItem,
  DispatchResult,
  FilePreview,
  ForkPoint,
  MemoryBackup,
  MemoryCandidate,
  MemoryRecord,
  MemorySyncStatus,
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

interface Outputs {
  'workspace:snapshot': WorkspaceSnapshot;
  'transcript:get': TranscriptItem[];
  'project:pickDirectory': string | null;
  'project:add': Project;
  'ssh:hosts': Array<{ host: string; hostName?: string; user?: string }>;
  'ssh:setEnabled': void;
  'ssh:check': RemoteHostStatus;
  'ssh:connect': RemoteHostStatus;
  'ssh:terminal': void;
  'task:create': Task;
  'task:send': DispatchResult;
  'task:interrupt': void;
  'task:shell': { ok: boolean; error?: string };
  'memory:linkPreview': { incoming: MemoryCandidate[]; files: Array<{ path: string; kind: string; exists: boolean; before: string; after: string | null }> };
  'memory:link': { added: number; written: string[]; errors: string[] };
  'memory:unlink': void;
  'memory:backups': MemoryBackup[];
  'memory:backupContent': string;
  'memory:restoreBackup': void;
  'skills:list': LibrarySkill[];
  'skills:scan': { found: FoundSkill[]; errors: Array<{ host: string; error: string }> };
  'skills:import': void;
  'skills:setEnabled': void;
  'skills:remove': void;
  'task:forkPoints': ForkPoint[];
  'task:fork': Task;
  'task:retry': void;
  'task:resume': void;
  'task:stop': void;
  'task:rename': void;
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
  'memory:scanImports': { candidates: MemoryCandidate[]; scanned: string[]; errors: Array<{ host: string; error: string }> };
  'memory:import': number;
  'memory:syncNow': MemorySyncStatus | undefined;
  'settings:update': void;
  'capabilities:refresh': void;
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
