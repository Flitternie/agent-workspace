import type { MapGrouping } from '../shared/session-map';
import type { ResearchDoc } from '../shared/research';
import type { FileMatch } from '../shared/file-match';
import type { IpcChannel, IpcInput } from '../shared/ipc';
import type { FoundSkill, LibrarySkill } from '../shared/skills';
import type {
  ModelOption,
  AttentionItem,
  DispatchResult,
  FilePreview,
  ForkPoint,
  ImageRef,
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
  WorkspaceSnapshot, BtwEntry } from '../shared/types';

interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  pathForFile(file: File): string;
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
  'research:get': ResearchDoc | null;
  'research:save': ResearchDoc;
  'research:create': ResearchDoc;
  'research:message': { taskId: string; alias: string };
  'attachment:save': ImageRef;
  'task:interrupt': void;
  'task:models': ModelOption[];
  'task:setModel': void;
  'task:shell': { ok: boolean; error?: string };
  'memory:linkPreview': { incoming: MemoryCandidate[]; files: Array<{ path: string; kind: string; exists: boolean; before: string; after: string | null }>; blocked: string[] };
  'memory:link': { added: number; written: string[]; notices: string[]; errors: string[] };
  'memory:unlink': { pending: boolean; notices: string[] };
  'memory:resolveShare': number;
  'memory:resolveConflict': void;
  'memory:restoreNote': void;
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
  'task:viewed': void;
  'task:setPermissionMode': void;
  'task:remove': string;
  'sessions:discover': NativeSessionInfo[];
  'sessions:discoverAll': NativeSessionInfo[];
  'session:map': MapGrouping | null;
  'btw:list': BtwEntry[];
  'btw:ask': BtwEntry;
  'btw:clear': void;
  'files:search': FileMatch[];
  'files:dropped': FileMatch[];
  'fs:listDirs': { dir: string; names: string[] };
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
  'memory:distill': { title: string; body: string; scope: 'global' | 'project'; worth: boolean; reason: string; similar?: { id: string; title: string; body: string }; fallback?: string };
  'label:short': string | undefined;
  'main:newChapter': void;
  'memory:update': void;
  'memory:reach': Array<{ taskId: string; alias: string; idle: boolean }>;
  'memory:tellNow': number;
  'memory:delete': void;
  'memory:promote': MemoryRecord;
  'memory:scanImports': { candidates: MemoryCandidate[]; scanned: string[]; errors: Array<{ host: string; error: string }> };
  'memory:import': number;
  'memory:syncNow': MemorySyncStatus | undefined;
  'settings:update': void;
  'capabilities:refresh': void;
  'provider:login': { url?: string; code?: string };
  'provider:loginCancel': void;
  'provider:loginApiKey': { ok: boolean; error?: string };
  'apps:detect': { claude: boolean; chatgpt: boolean };
  'apps:installed': Array<{ id: string; name: string; kind: 'editor' | 'git' | 'terminal' | 'files'; lines: boolean; icon?: string }>;
  'apps:open': void;
  'task:setAside': void;
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
