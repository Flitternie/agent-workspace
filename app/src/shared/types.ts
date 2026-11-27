// Normalized application types shared by the main process and the renderer.
// These are NOT provider wire formats; provider ids are carried alongside.
import type { PermissionKind, PlanInfo, ToolCallInfo, ToolContent } from './content';
import { ACP_IDS, type AcpProvider } from './acp-agents';

export type { DiffHunk, FileDiff, PermissionKind, PlanEntry, PlanInfo, ToolCallInfo, ToolContent, ToolKind } from './content';

/** The real coding agents: Claude Code and Codex natively, and the CLIs reached through ACP (shared/acp-agents.ts). */
export type CodingProvider = 'claude' | 'codex' | AcpProvider;
export type AgentProvider = CodingProvider | 'mock';
/** Every real coding agent, in the order they are offered. */
export const CODING_PROVIDERS: CodingProvider[] = ['claude', 'codex', ...ACP_IDS];
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
  /** SSH alias (from ~/.ssh/config) when the folder is on another machine; unset = this computer. */
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
  /** An old automatic role replaced by a stopgap; a model labels the work when the agent is next used. */
  labelStale?: boolean;
  /** When a model last wrote the label, and how many messages the user sent since (to keep it current). */
  labelAt?: string;
  saidSinceLabel?: number;
  /** When the user last messaged, opened, answered or renamed this agent (orders the sidebar). */
  lastUserActivityAt?: string;
  /** Set aside by the user: out of the Overview and folded into its team's idle row, dot hollow, until it works, asks, fails or is messaged again. Its session keeps running. */
  setAside?: boolean;
  /** Finished a turn the user has not looked at since (a green dot); opening the agent clears it. */
  unread?: boolean;
  /** When the agent entered its current status group (waiting on you / working / anything else); orders the sidebar. */
  statusSince?: string;
  /** Sub-agents of the latest turn, kept after it ends; replaced when the next turn starts. */
  subtasks?: SubtaskInfo[];
  projectId: string;
  title: string;
  provider: AgentProvider;
  status: AgentStatus;
  /** Debounced, human-readable progress line for the Overview card. */
  summary: string;
  cwd: string;
  /** SSH alias the agent runs on (its project's host); unset = this computer. */
  host?: string;
  worktree?: WorktreeInfo;
  /** Set when another task shares this writable directory, or when the task has no worktree (cwdNote). */
  sharedCwdWarning?: string;
  /** Why the task edits its folder directly (no worktree on an SSH host, or creating one failed). */
  cwdNote?: string;
  /** An imported session that kept the folder it was started in. */
  keptOriginalFolder?: boolean;
  sessionLocalId?: string;
  lastError?: string;
  /** Latest checklist the agent published (TodoWrite / tasks / Codex turn plan). */
  plan?: PlanInfo;
  /** Memory records injected into the current native session at start/resume (provenance). */
  injectedMemoryIds?: string[];
  /** The memory this session has been given and at which version (its updatedAt), and what it said: what
   *  the next message brings it is the difference (new, changed, no longer applying). */
  memorySeen?: Record<string, { at: string; body: string }>;
  /** Mock-provider script name; ignored by native providers. */
  mockScript?: string;
  /** Overrides settings.permissionMode for this agent. */
  permissionMode?: PermissionMode;
  /** The agent whose conversation this one was forked from (alias at the time). */
  forkedFrom?: { taskId: string; alias: string };
  /** A failed model request that will be tried again by itself (model at capacity, rate limited…). */
  retry?: RetryState;
  /** The model the user picked for this agent (unset: the CLI's own default). Applies from its next turn and on resume. */
  model?: string;
  /** The model the agent reports it is running on. */
  activeModel?: string;
  /** The agent's guess at what the user will say next; cleared when the user sends. */
  suggestion?: string;
  /** Tokens this agent has used, summed over its sessions (survives restarts and resumes), and its context now. */
  usage?: TaskUsage;
  createdAt: string;
  updatedAt: string;
}

/** Token counts of one or more model requests, as the CLIs report them (normalized). */
export interface UsageTokens {
  /** Input not read from the prompt cache. */
  input: number;
  /** Input written to the prompt cache (Claude). */
  cacheWrite: number;
  /** Input read from the prompt cache. */
  cacheRead: number;
  /** Output, reasoning included. */
  output: number;
  /** Of `output`, reasoning (Codex). */
  reasoning: number;
}

export interface TaskUsage extends UsageTokens {
  /** What these tokens would cost at API prices (Claude Code reports it; on a subscription it is not charged). */
  costUsd?: number;
  /** Tokens in the context window after the latest request, and the window's size. */
  context?: number;
  contextWindow?: number;
  updatedAt: string;
}

/** One rate-limit window of an account (e.g. 5 hours, a week). */
export interface LimitWindow {
  /** The provider's name for it ("five_hour", "seven_day", "primary"…). */
  key: string;
  /** Length in minutes, when known (300 = 5 hours, 10080 = a week). */
  mins?: number;
  /** Usage beyond the plan (Claude's "…_overage" windows), not the plan's own limit. */
  overage?: boolean;
  usedPercent: number;
  /** When it resets, ms since the epoch. */
  resetsAt?: number;
  /** Which models it covers, when an account has windows per group of models (Antigravity: "Gemini", "Claude and GPT"). */
  label?: string;
}

/** A provider account's usage limits as last seen, and when. */
export interface ProviderLimits {
  /** Whose limits: the provider, and the machine its CLI runs on (unset: this computer). One account each. */
  provider?: AgentProvider;
  host?: string;
  windows: LimitWindow[];
  /** When they were seen (ISO). */
  at: string;
  /** Codex: the account's plan ("plus", "pro"…). */
  plan?: string;
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

export type PreviewKind = 'markdown' | 'html' | 'image' | 'text' | 'code' | 'pdf' | 'document';

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
  /** pdf / document: the bytes, main process only (served to the frame, never sent to the window). */
  data?: Uint8Array;
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

/** An image a message carries, stored once in the app's data folder (main/attachments.ts). */
export interface ImageRef {
  /** Content-addressed file name: 24 hex characters and the format's extension. */
  id: string;
  mediaType: string;
  /** The file's name, when it came from one. */
  name?: string;
}

export interface TranscriptItem {
  /** Stable id (provider item id where available) used for upsert / dedup. */
  id: string;
  taskId: string;
  role: TranscriptRole;
  text: string;
  /** Images the user message carried (shown with it; an image that could not be kept shows as missing). */
  images?: ImageRef[];
  /** How the user message arrived. */
  via?: 'text' | 'voice' | 'card' | 'initial' | 'main';
  /** User messages sent while the agent was working. */
  delivery?: 'steer' | 'interrupt';
  toolLabel?: string;
  toolStatus?: ToolStatus;
  /** Structured tool call (role 'tool'). */
  tool?: ToolCallInfo;
  /** A decision the user made here (role 'system'): an approval given or a question answered. */
  decision?: { kind: 'approval' | 'answer'; label: string; about?: string; /** An approval refused (the option chosen is a reject / deny / decline). */ declined?: boolean; /** Every option offered, the chosen ones marked: the decision space. */ options?: Array<{ label: string; chosen: boolean }> };
  streaming?: boolean;
  /** A system item that starts a new chapter of the main agent's conversation (and why). */
  chapter?: { reason: 'manual' | 'idle' | 'long' };
  createdAt: string;
  /** A system note that memory went with the next message: what was sent (a removed note marked ✕). */
  memoryUpdate?: string[];
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
  /** Retired: its source file is gone from the machine it came from. Not shared or given to agents; kept so it can be restored. */
  sourceRemoved?: boolean;
  /** The source changed after the note was edited in the app: the source's text, for the user to choose. */
  sourceBody?: string;
}

/** A note found in a CLI's native memory or instruction files, offered for import. */
export interface MemoryCandidate {
  key: string;
  source: 'claude-memory' | 'instructions';
  /** SSH alias; unset = this computer. */
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
  /** Machines scanned ('local' = this computer). */
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
  /** Saved conversations on this computer can be forked (the adapter implements forkPoints / forkSession). */
  fork?: boolean;
  /** Its saved conversations can be forked onto another CLI (the adapter reads them back: readHistory). */
  forkElsewhere?: boolean;
  /** Answers side questions ("btw") without entering the conversation; unset = yes. */
  sideQuestions?: boolean;
  /** Login state read from the CLI's own status command (never its credentials). */
  auth?: { loggedIn: boolean; method?: string };
  /** Codex: Remote Control (pairing with the ChatGPT app) can be offered here (signed in with ChatGPT). */
  remoteControl?: boolean;
}

/**
 * Codex Remote Control for one live agent: its app-server paired (or pairing) with the ChatGPT app.
 * `code` is the short-lived manual pairing code, shown until a device claims it or it expires.
 */
export interface CodexRemoteControl {
  /** The app-server's link to the ChatGPT service (Codex's RemoteControlConnectionStatus). */
  status: 'connecting' | 'connected' | 'errored' | 'disabled';
  /** A device claimed the current code. */
  paired: boolean;
  code?: string;
  /** What the QR code carries (scanned in the ChatGPT app instead of typing `code`). */
  qr?: string;
  /** When `code` stops working (ISO). */
  expiresAt?: string;
  /** This computer, as the ChatGPT app lists it. */
  serverName?: string;
  /** Devices paired with this computer (Codex's remote-control clients). */
  devices?: Array<{ id: string; name: string; lastSeenAt?: string }>;
}

export interface NativeSessionInfo {
  provider: AgentProvider;
  nativeSessionId: string;
  cwd: string;
  /** SSH alias the session lives on; unset = this computer. */
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
      provider?: CodingProvider;
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

/** A sub-agent the agent started in this turn (Claude Code's Task tool, a Codex sub-agent). */
export interface SubtaskInfo {
  id: string;
  description: string;
  status: 'running' | 'done' | 'failed';
  /** What it is doing right now ("Reading src/api/legacy.ts"). */
  step?: string;
  /** Every step so far, oldest first (the last 50). */
  steps?: Array<{ at: string; text: string }>;
  /** What it reported back to its agent, once done. */
  result?: string;
  startedAt: string;
  endedAt?: string;
}

export interface Settings {
  /** First-run guide: shown on a fresh workspace until finished or skipped; reopened from Settings. */
  onboarding?: { started?: boolean; dismissed?: boolean; voiceSkipped?: boolean; remoteSkipped?: boolean; languageChosen?: boolean };
  /** Overview tiles: 1, 2, 4, 6 or 9; unset or 0 = automatic (every agent that is busy or recently was). */
  overviewSlots?: number;
  /** When true every voice route needs a click, even if high confidence. */
  alwaysConfirmVoice: boolean;
  /** Open the mic on launch, like joining a call. */
  autoListen: boolean;
  /** Default permission mode for new agents. */
  permissionMode?: PermissionMode;
  /** Which CLI runs the main agent; unset = the first one installed and signed in. */
  /** The main agent's CLI (any coding provider), or off. */
  mainAgent?: CodingProvider | 'off';
  /** Start a new chapter of the main agent's conversation by itself after a long pause or a long chapter (default on). */
  mainChapters?: 'auto' | 'off';
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
   * Machines whose CLIs share user memory ('local' = this computer), linked once (files backed
   * up, notes merged); from then on the shared user memory is kept in sync there.
   */
  memoryLinks?: Record<string, { linkedAt: string; /** Unlinked while offline: cleaned up when it connects. */ unlinking?: boolean }>;
  // Advanced; unset = the defaults below.
  /** Latest turns shown in full (1–5); 0 = every turn. Default 1. */
  openTurns?: number;
  /** Tool calls on opening a conversation: folded, only the failed ones open, or all open. Default folded. */
  toolsOpen?: ToolsOpen;
  /** Days without activity before an agent folds into its team's idle row; 0 = never. Default 3. */
  idleAfterDays?: number;
  /** The main agent's tool calls per message from the user. Default 30. */
  mainCallsPerTurn?: number;
  /** Agents the main agent may fork per message from the user. Default 3. */
  mainForksPerTurn?: number;
  /** Minutes before a command run with `!` is stopped. Default 10. */
  commandTimeoutMin?: number;
  /** Keep the computer from sleeping on its own while an agent works. Default on. */
  keepAwake?: boolean;
}

export type ToolsOpen = 'folded' | 'failed' | 'all';

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
  memoryShare: Record<string, { linkedAt: string; unlinking?: boolean; lastWrite?: string; errors?: string[]; notices?: string[]; paused?: Array<{ kind: string; why: string }> }>;
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
  /** Live Claude sessions with Remote Control on: taskId → the session's link (claude.ai/code, the Claude app). */
  remoteControl: Record<string, string>;
  /** Live Codex agents with Remote Control on: taskId → pairing and connection state (the ChatGPT app). */
  codexRemote: Record<string, CodexRemoteControl>;
  /**
   * Per agent: the title of the last task on its session map (the model's grouping, as cached). What an
   * agent is on, for the sidebar row and the agent's header; absent until a map has been made.
   */
  workTitles: Record<string, string>;
  /** Per provider: its account's usage limits as last seen (Claude Code: after a turn; Codex: also at start). */
  /** Usage limits per account, keyed by `accountKey` (a provider on a machine: accounts differ between machines). */
  limits: Record<string, ProviderLimits>;
}

export interface DispatchResult {
  ok: boolean;
  taskId?: string;
  error?: string;
  /** turn: started work; steer: added to the running turn; interrupt: stopped it and started over. */
  delivery?: 'turn' | 'steer' | 'interrupt';
}

/** A model an agent's CLI offers (Claude Code's supportedModels, Codex's model/list). */
export interface ModelOption {
  id: string;
  label: string;
  description?: string;
  /** The CLI's default when none is picked. */
  isDefault?: boolean;
  /** The full model id an alias stands for (Claude Code's `opus` → `claude-opus-…`), to recognise the running model. */
  resolves?: string;
}

/**
 * A side question ("btw") to an agent: answered from its conversation so far without entering it or
 * interrupting the turn under way (Claude Code's side questions; a read-only side thread in Codex).
 */
export interface BtwEntry {
  id: string;
  question: string;
  /** Set once answered. */
  answer?: string;
  error?: string;
  askedAt: string;
  answeredAt?: string;
}

/** One provider account: a provider's CLI on one machine ("claude" on this computer, "codex@neptune"). */
export const accountKey = (t: { provider: AgentProvider; host?: string }) => (t.host ? `${t.provider}@${t.host}` : t.provider);
