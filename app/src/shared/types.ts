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
  projectId: string;
  title: string;
  provider: AgentProvider;
  status: AgentStatus;
  /** Debounced, human-readable progress line for the Overview card. */
  summary: string;
  cwd: string;
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
  createdAt: string;
  updatedAt: string;
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
  via?: 'text' | 'voice' | 'card' | 'initial';
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
  title: string;
  updatedAt?: string;
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
  /** Speech-to-text model (OpenAI id). */
  sttModel?: string;
  /** Model that decides which agent a spoken message is for (and names roles). */
  routerModel?: string;
  /** Silence after speech before a spoken message is sent (pauses shorter than this continue it). */
  voicePauseMs?: number;
  /** UI language; set from the system locale on first launch. */
  language?: Language;
}

export type Language = 'en' | 'zh';

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
  projects: Project[];
  tasks: Task[];
  sessions: SessionRecord[];
  attention: AttentionItem[];
  memory: MemoryRecord[];
  coordinator: CoordinatorEntry[];
  capabilities: ProviderCapabilities[];
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
