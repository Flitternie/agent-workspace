// Normalized application types shared by the main process and the renderer.
// These are NOT provider wire formats; provider ids are carried alongside.
import type { PermissionKind, PlanInfo, ToolCallInfo, ToolContent } from './content';

export type { DiffHunk, FileDiff, PermissionKind, PlanEntry, PlanInfo, ToolCallInfo, ToolContent, ToolKind } from './content';

export type AgentProvider = 'claude' | 'codex' | 'mock';
export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_for_user'
  | 'done'
  | 'failed'
  | 'disconnected';
export type AttentionKind = 'question' | 'approval' | 'review' | 'completion' | 'error';
export type AttentionState = 'open' | 'resolved' | 'dismissed' | 'expired';
export type IntegrationMode = 'managed' | 'resumed' | 'external_readonly' | 'live_attached';

export interface Project {
  projectId: string;
  name: string;
  rootPath: string;
  /** SSH alias (from ~/.ssh/config) when the folder is on another machine; unset = this Mac. */
  host?: string;
  isGitRepo: boolean;
  createdAt: string;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  parentRepo: string;
}

export interface Task {
  taskId: string;
  /** Short spoken/visual handle, e.g. "A". Stable for the life of the task. */
  alias: string;
  name: string;
  /** Who set the name: 'user' names are never changed automatically. Unset on older tasks. */
  nameSource?: 'auto' | 'user';
  projectId: string;
  title: string;
  provider: AgentProvider;
  status: AgentStatus;
  /** Debounced, human-readable progress line for the Overview card. */
  summary: string;
  cwd: string;
  /** SSH alias the agent runs on (its project's host); unset = this Mac. */
  host?: string;
  worktree?: WorktreeInfo;
  /** Set when another task shares this writable directory. */
  sharedCwdWarning?: string;
  sessionLocalId?: string;
  lastError?: string;
  /** Latest checklist the agent published (TodoWrite / tasks / Codex turn plan). */
  plan?: PlanInfo;
  /** Memory records injected into the current native session at start/resume (provenance). */
  injectedMemoryIds?: string[];
  /** Mock-provider script name; ignored by native providers. */
  mockScript?: string;
  /** Overrides settings.permissionMode for this agent. */
  permissionMode?: PermissionMode;
  /** The agent whose conversation this one was forked from (alias at the time). */
  forkedFrom?: { taskId: string; alias: string };
  /** A failed model request that will be tried again by itself (model at capacity, rate limited…). */
  retry?: RetryState;
  /** The agent's guess at what the user will say next; cleared when the user sends. */
  suggestion?: string;
  createdAt: string;
  updatedAt: string;
}

/** Why a model request is retried: the model is at capacity / overloaded, the account is rate limited, or another error the provider retries. */
export type RetryKind = 'capacity' | 'rate_limit' | 'error';
/** A failure that passes on its own, so trying again soon can work. */
export type TransientKind = Exclude<RetryKind, 'error'>;

export interface RetryState {
  kind: RetryKind;
  /** The coming try out of `maxAttempts`. */
  attempt: number;
  maxAttempts: number;
  /** When it starts (ISO). */
  at: string;
  /** app: the workspace runs the failed turn again; provider: the CLI retries within its turn. */
  by: 'app' | 'provider';
  error?: string;
}

export type PreviewKind = 'markdown' | 'html' | 'image' | 'text';

/** A file an agent wrote, read for the preview column. `path` is the resolved absolute path. */
export interface FilePreview {
  path: string;
  kind: PreviewKind;
  size: number;
  /** markdown / html / text */
  text?: string;
  /** image */
  dataUrl?: string;
  /** html: where the sandboxed frame loads it (its own CSP, see main/index.ts). */
  frameUrl?: string;
}

/** A place an agent's conversation can be forked: just before one of the user's earlier prompts. */
export interface ForkPoint {
  /** Last message kept in the fork (the one before `prompt`). */
  upToMessageId: string;
  /** The user prompt the fork leaves out, and everything after it. */
  prompt: string;
}

export interface SessionRecord {
  localId: string;
  taskId: string;
  provider: AgentProvider;
  /** Provider-native id (Claude session id / Codex thread id). Empty until known. */
  nativeSessionId: string;
  cwd: string;
  integrationMode: IntegrationMode;
  createdAt: string;
}

export interface AttentionOption {
  id: string;
  label: string;
  description?: string;
  /** ACP-style meaning of a permission option, for consistent styling. */
  kind?: PermissionKind;
}

export interface AttentionQuestion {
  id: string;
  question: string;
  header?: string;
  options: AttentionOption[];
  multiSelect?: boolean;
  isSecret?: boolean;
  /** Free-text answer allowed besides the options. */
  allowOther?: boolean;
}

export interface AttentionItem {
  id: string;
  taskId: string;
  /** Native request id. If set, only a provider-specific response resolves this item. */
  providerRequestId?: string;
  /** Local session that produced the native request; stale sessions cannot answer it. */
  sessionLocalId?: string;
  kind: AttentionKind;
  state: AttentionState;
  headline: string;
  details: string;
  /** Approval decisions offered by the provider (e.g. allow once / deny). */
  options?: AttentionOption[];
  questions?: AttentionQuestion[];
  /** Transcript tool item this request is about (Claude toolUseID / Codex itemId). */
  toolCallId?: string;
  /** What will happen if approved: diff, command, plan… rendered like the tool call. */
  preview?: ToolContent[];
  /** Provider asked that this not be approvable by a stray keystroke. */
  highRisk?: boolean;
  /** A failed turn the user can run again with one click. */
  retryable?: boolean;
  /** It failed because the model was busy (at capacity, overloaded, rate limited). */
  transient?: TransientKind;
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
}

export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system' | 'thought' | 'plan';

export interface TranscriptItem {
  /** Stable id (provider item id where available) used for upsert / dedup. */
  id: string;
  taskId: string;
  role: TranscriptRole;
  text: string;
  /** How the user message arrived. */
  via?: 'text' | 'voice' | 'card' | 'initial' | 'main';
  /** User messages sent while the agent was working. */
  delivery?: 'steer' | 'interrupt';
  toolLabel?: string;
  toolStatus?: ToolStatus;
  /** Structured tool call (role 'tool'). */
  tool?: ToolCallInfo;
  streaming?: boolean;
  createdAt: string;
}

export type ToolStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'declined' | 'interrupted';

export type MemoryScope = 'global' | 'project' | 'task' | 'session';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  /** 'global' for global scope, otherwise projectId / taskId / sessionLocalId. */
  scopeId: string;
  body: string;
  originTaskId?: string;
  source: string;
  approvedForReuse: boolean;
  updatedAt: string;
  /** Short heading for imported notes (memory name, file section). */
  title?: string;
  /** Imported: every native source with this text (`source|host|file|section`, see memory-import). */
  importKeys?: string[];
  /** Hash of the body as last imported; a different body hash means the user edited it, so sync leaves it alone. */
  importedHash?: string;
  /** Every source file of an imported note is gone (kept until the user deletes it). */
  sourceRemoved?: boolean;
}

/** A note found in a CLI's native memory or instruction files, offered for import. */
export interface MemoryCandidate {
  key: string;
  source: 'claude-memory' | 'instructions';
  /** SSH alias; unset = this Mac. */
  host?: string;
  /** Path as found, `~/`-relative when under the home folder. */
  file: string;
  title: string;
  body: string;
  /** The body was cut to fit one note. */
  truncated: boolean;
  suggestedScope: 'global' | 'project';
  /** The app project whose folder this Claude memory belongs to (project-type notes only). */
  projectId?: string;
  /** Claude memory type (user | feedback | project | reference). */
  memoryType?: string;
  /** For project notes without a matching app project: the folder Claude recorded (decoded best-effort). */
  folderHint?: string;
  alreadyImported: boolean;
  /** The user deleted the imported note in the app; sync will not bring it back. */
  dismissed: boolean;
}

/** A backup of a CLI file taken before the app changed it (main/memory-writeback.ts). */
export interface MemoryBackup {
  id: string;
  host: string;
  path: string;
  at: string;
  reason: 'link' | 'sync' | 'restore' | 'unlink';
  existed: boolean;
  size: number;
  /** The file as it was before the machine was linked: never pruned. */
  original?: boolean;
}

export interface MemorySyncStatus {
  at: string;
  added: number;
  updated: number;
  removed: number;
  /** Machines scanned ('local' = this Mac). */
  hosts: string[];
  errors: Array<{ host: string; error: string }>;
}

export interface ProviderCapabilities {
  provider: AgentProvider;
  available: boolean;
  version?: string;
  detail?: string;
  createSession: boolean;
  resumeHistorical: boolean;
  importHistory: boolean;
  attachExternalRunning: boolean;
  readOnlyMonitor: boolean;
  structuredApprovals: boolean;
  structuredQuestions: boolean;
  /** Login state read from the CLI's own status command (never its credentials). */
  auth?: { loggedIn: boolean; method?: string };
}

export interface NativeSessionInfo {
  provider: AgentProvider;
  nativeSessionId: string;
  cwd: string;
  /** SSH alias the session lives on; unset = this Mac. */
  host?: string;
  title: string;
  updatedAt?: string;
  /**
   * Started by an agent inside another task (`claude -p`, `codex exec`, a Codex sub-agent
   * thread), not by a person or an app; hidden from pickers by default.
   */
  automated?: boolean;
}

export type RouteDecision =
  | { kind: 'existing'; taskId: string; confidence: 'high' | 'medium'; reason: string; /** Chosen because it is the agent in view or selected, not because it was named. */ context?: boolean }
  | {
      kind: 'create';
      proposedTitle: string;
      projectId?: string;
      provider?: 'claude' | 'codex';
      reason: string;
    }
  | { kind: 'coordinator'; reason: string }
  | { kind: 'clarify'; candidateTaskIds: string[]; question: string };

export interface CoordinatorEntry {
  id: string;
  createdAt: string;
  role: 'user' | 'coordinator';
  text: string;
}

export interface Settings {
  /** When true every voice route needs a click, even if high confidence. */
  alwaysConfirmVoice: boolean;
  /** Open the mic on launch, like joining a call. */
  autoListen: boolean;
  /** Default permission mode for new agents. */
  permissionMode?: PermissionMode;
  /** Which CLI runs the main agent; unset = the first one installed and signed in. */
  mainAgent?: 'claude' | 'codex' | 'off';
  /** Speech-to-text model (OpenAI id). */
  sttModel?: string;
  /** Model that decides which agent a spoken message is for (and names roles). */
  routerModel?: string;
  /** Silence after speech before a spoken message is sent (pauses shorter than this continue it). */
  voicePauseMs?: number;
  /** How the microphone opens; unset = open (always on until muted). */
  micMode?: MicMode;
  /** Keys for the microphone, e.g. "Alt+Space"; unset = the platform default. */
  micShortcut?: string;
  /** UI language; set from the system locale on first launch. */
  language?: Language;
  /** SSH aliases (from ~/.ssh/config) whose agents and sessions the app uses. */
  remoteHosts?: string[];
  /** Keep user memory in sync with the CLIs' native user-level memory; unset = on. */
  memorySync?: boolean;
  /**
   * Machines whose CLIs share user memory ('local' = this Mac), linked once (files backed
   * up, notes merged); from then on the shared user memory is kept in sync there.
   */
  memoryLinks?: Record<string, { linkedAt: string }>;
}

/**
 * An enabled SSH host. `ssh`: whether a background (no-prompt) connection works —
 * needs_key: a passphrase-protected key is not in the SSH agent; needs_login: the
 * server wants a password / 2FA; unknown_host_key: its host key is not trusted yet.
 */
export interface RemoteHostStatus {
  host: string;
  ssh: 'checking' | 'ok' | 'needs_key' | 'needs_login' | 'unknown_host_key' | 'unreachable';
  error?: string;
  /** Claude Code and Codex as installed and signed in on that host. */
  capabilities: ProviderCapabilities[];
  checkedAt?: string;
}

export type Language = 'en' | 'zh';

/** open: always on until muted · toggle: press to start, press to send · hold: talk while held · both: tap or hold. */
export type MicMode = 'open' | 'toggle' | 'hold' | 'both';

/** A downloadable on-device speech model (Settings › Voice). */
export interface LocalModelState {
  id: string;
  label: string;
  sizeMb: number;
  languages: string;
  note: string;
  /** 1–5 ratings shown as dots. */
  accuracy: number;
  speed: number;
  installed: boolean;
  /** 0–1 while downloading. */
  progress?: number;
  error?: string;
}

/**
 * How much an agent may do without asking. Never a bypass:
 * - auto: the provider's own reviewer decides (Claude Code auto mode, Codex auto_review);
 *   only what it will not approve comes to the user.
 * - edits: file edits in the workspace are fine; commands and anything else ask.
 * - ask: every action that changes something asks.
 */
export type PermissionMode = 'auto' | 'edits' | 'ask';

export interface WorkspaceSnapshot {
  /** Demo entry: mock agents are offered and seeded. */
  demo: boolean;
  /** The main agent the user talks to by default (not one of `tasks`). */
  main?: Task;
  projects: Project[];
  tasks: Task[];
  sessions: SessionRecord[];
  attention: AttentionItem[];
  memory: MemoryRecord[];
  /** Last automatic user-memory sync (Settings › Memory). */
  memorySync: { running: boolean; last?: MemorySyncStatus };
  /** Per linked machine: the last write of user memory into its CLI files. */
  memoryShare: Record<string, { linkedAt: string; lastWrite?: string; errors?: string[] }>;
  coordinator: CoordinatorEntry[];
  capabilities: ProviderCapabilities[];
  /** Enabled SSH hosts and what works on them. */
  remoteHosts: RemoteHostStatus[];
  settings: Settings;
  voice: {
    sttAvailable: boolean;
    routerLlmAvailable: boolean;
    /** OpenAI id, or `local:<id>` for an on-device model. */
    sttModel?: string;
    routerModel?: string;
    autoListen: boolean;
    cloudAvailable: boolean;
    localModels: LocalModelState[];
    /** Where the OpenAI key comes from; the key itself never reaches the renderer. */
    openaiKey: { source: 'env' | 'saved' | 'file' | null; last4?: string };
  };
  dataDir: string;
  /** Tasks with a live provider session right now (others resume on demand). */
  connectedTaskIds: string[];
}

export interface DispatchResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  /** turn: started work; steer: added to the running turn; interrupt: stopped it and started over. */
  delivery?: 'turn' | 'steer' | 'interrupt';
}
