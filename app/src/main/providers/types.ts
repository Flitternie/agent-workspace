import type {
  ForkPoint,
  PlanEntry,
  ToolCallInfo,
  ToolContent,
  ToolStatus,
  AgentProvider,
  AttentionOption,
  AttentionQuestion,
  NativeSessionInfo,
  PermissionMode,
  ModelOption,
  ProviderCapabilities,
  RetryKind,
  TranscriptRole,
  TransientKind,
  UsageTokens,
  LimitWindow,
} from '../../shared/types';
import type { WorkspaceTool } from '../main-agent';

/** An image sent with a message: a file on this computer (the app's stored copy) and its format. */
export interface ImageInput {
  path: string;
  mediaType: string;
}

/** An image in a user message of a saved conversation. */
export type HistoryImage = { data: string; mediaType?: string } | { path: string };

/**
 * Normalized provider events. Each event is emitted by one ProviderSession, which
 * the workspace binds to exactly one (taskId, sessionLocalId) when it is created,
 * so a late event from an old session can never attach to the wrong task.
 */
export type ProviderEvent =
  | { type: 'sessionStarted'; nativeSessionId: string; resumed: boolean }
  | {
      type: 'transcriptItem';
      itemId: string;
      role: TranscriptRole;
      text: string;
      streaming?: boolean;
      toolLabel?: string;
      toolStatus?: ToolStatus;
      /** Structured tool call; fields given here replace the stored ones (merge by item id). */
      tool?: Partial<ToolCallInfo>;
      /** true when replaying history on resume, not new activity */
      history?: boolean;
      /** Images in a user message read back from history: base64 bytes, or a file on the agent's machine. */
      images?: HistoryImage[];
    }
  /** Streaming text. For tool items it extends the terminal output. */
  | { type: 'outputDelta'; itemId: string; role: 'assistant' | 'tool' | 'thought'; delta: string }
  /** Full snapshot of the agent's checklist. */
  | { type: 'planUpdated'; entries: PlanEntry[]; explanation?: string }
  | { type: 'turnStarted' }
  /** A sub-agent started, moved on to another step, or finished (fields given are updated). */
  | { type: 'subtask'; id: string; description?: string; status?: 'running' | 'done' | 'failed'; step?: string; result?: string }
  | {
      type: 'turnCompleted';
      status: 'completed' | 'interrupted' | 'failed';
      /** Final assistant message of the turn, if any. */
      finalText?: string;
      error?: string;
      /** Failed because the model was busy (at capacity, overloaded, rate limited): the turn can run again soon. */
      transient?: TransientKind;
      /** The provider already retried the failing request with backoff in this turn (see `retrying`). */
      retried?: boolean;
    }
  /** The provider waits to retry a failed model request within the turn. */
  | { type: 'retrying'; kind: RetryKind; attempt: number; maxAttempts: number; delayMs: number; error?: string }
  | {
      type: 'approvalRequested';
      requestId: string;
      headline: string;
      details: string;
      options: AttentionOption[];
      highRisk?: boolean;
      toolCallId?: string;
      preview?: ToolContent[];
    }
  | {
      type: 'userInputRequested';
      requestId: string;
      headline: string;
      questions: AttentionQuestion[];
      toolCallId?: string;
    }
  /** The provider itself resolved / withdrew a request (e.g. turn ended). */
  | { type: 'requestResolved'; requestId: string; reason: string }
  | { type: 'progress'; text: string }
  /** A predicted next message from the user (Claude Code prompt suggestions, Codex predictions). */
  | { type: 'suggestion'; text: string }
  /** The model the session runs on (at start, and after a switch). */
  | { type: 'model'; model: string }
  /** Tokens used since the last usage event (to add), and/or the context now; history replay never sends it. */
  | { type: 'usage'; add?: Partial<UsageTokens> & { costUsd?: number }; context?: number; contextWindow?: number }
  /** The account's usage limits (rate-limit windows), as just reported. */
  | { type: 'limits'; windows: LimitWindow[]; plan?: string }
  | { type: 'sessionFailed'; error: string }
  | { type: 'sessionDisconnected'; reason: string };

export interface StartArgs {
  cwd: string;
  /** SSH alias to run the CLI on; unset = this computer. */
  host?: string;
  /** Resume this provider-native session instead of creating one. */
  resumeNativeSessionId?: string;
  /** App-owned scoped memory, injected through the provider's instruction channel. */
  developerInstructions?: string;
  /** Mock only. */
  mockScript?: string;
  /** The model to run on; unset = the CLI's default. */
  model?: string;
  /** The workspace skill library, as paths on the machine the CLI runs on. */
  skills?: { pluginDir: string; root: string };
  permissionMode?: PermissionMode;
  /** Main agent only: workspace tools it may call; the session is limited to these plus read-only tools. */
  tools?: WorkspaceTool[];
  title: string;
}

export interface ApprovalResponse {
  /** Option id from the approval event (provider-specific decision). */
  decision?: string;
  /** Question id -> answer text for userInputRequested. */
  answers?: Record<string, string>;
}

/** How a message reached the agent. */
export type Delivery = 'turn' | 'steer' | 'interrupt';

export interface ProviderSession {
  readonly provider: AgentProvider;
  /** Known after sessionStarted. */
  nativeSessionId(): string | undefined;
  start(): Promise<void>;
  /**
   * Sends a user message. Idle: starts a turn. Working: steers the current turn
   * (read at the next safe point, no restart), or with `interrupt` stops the turn
   * and starts a new one with this message. Resolves with what actually happened.
   */
  send(text: string, opts?: { interrupt?: boolean; images?: ImageInput[] }): Promise<Delivery>;
  /** Answers a native approval / question by its provider request id. */
  respond(requestId: string, response: ApprovalResponse): Promise<void>;
  interrupt(): Promise<void>;
  /**
   * Runs a command the user typed as `!command` through the provider's own shell, recorded in
   * its conversation (Codex). Without it, the workspace runs the command and hands the output
   * over with the next message.
   */
  shell?(command: string, timeoutMs?: number): Promise<void>;
  /** Runs the following turns on `model` (unset: the CLI's default). */
  setModel?(model: string | undefined): Promise<void>;
  /** The skill library changed (same paths, new contents): pick it up without a restart. */
  reloadSkills?(): Promise<void>;
  /** Changes what the agent may do without asking; applies from the next action (Claude) or turn (Codex). */
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  /**
   * Remote Control (Claude Code): this live session also shows in the Claude app and at claude.ai/code,
   * driven from the phone while it keeps running here. Resolves with the session's link when on.
   */
  setRemoteControl?(on: boolean, name?: string): Promise<{ url?: string }>;
  /**
   * A side question ("btw"): answered from this conversation without entering it or interrupting a
   * turn under way. `history` holds the earlier side questions and answers, oldest first.
   */
  askSide?(question: string, history: Array<{ question: string; response: string }>): Promise<string>;
  close(): Promise<void>;
}

export interface ForkSessionOpts {
  /** Where the original session is found. */
  cwd: string;
  /** Where the fork will work; unset = `cwd`. */
  targetCwd?: string;
  /** Last message (fork point id from forkPoints) kept in the fork; unset = the whole session. */
  upToMessageId?: string;
  title?: string;
}

export interface ProviderAdapter {
  readonly provider: AgentProvider;
  capabilities(): Promise<ProviderCapabilities>;
  /** Runs sessions on SSH hosts (see StartArgs.host). */
  readonly remote?: boolean;
  /** Saved sessions for one folder, or across every folder when `cwd` is omitted; on `host` when given. */
  discoverSessions(filter: { cwd?: string; limit?: number; host?: string }): Promise<NativeSessionInfo[]>;
  /** Read a saved session's transcript without starting or resuming it (history events only). */
  readHistory?(nativeSessionId: string, cwd: string, host?: string): Promise<ProviderEvent[]>;
  /** The models the CLI offers (on `host` when given), for the model picker. */
  listModels?(host?: string): Promise<ModelOption[]>;
  /** The CLI as installed and signed in on `host` (reached without prompts). */
  hostCapabilities?(host: string): Promise<ProviderCapabilities>;
  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession;
  /**
   * One short answer from the provider's own CLI, under the user's existing login: a light model,
   * no tools, none of the user's settings or hooks, and nothing saved as a session. For small
   * background jobs such as naming an agent; slow to start (seconds), so never on a hot path.
   */
  oneShot?(system: string, prompt: string): Promise<string>;
  /** The user's earlier prompts in a saved session, oldest first: the session can be forked just before each. */
  forkPoints?(nativeSessionId: string, cwd: string): Promise<ForkPoint[]>;
  /**
   * Copies a saved session (all of it, or up to and including `upToMessageId`) into a new
   * session and returns its id; the original is left as it is. `cwd` is where the original is
   * found; `targetCwd` is where the fork will work (its own worktree, or `cwd` when unset).
   * Providers that record a session's folder (Codex) give the fork that folder; Claude Code's
   * fork resumes from any git worktree of the same repository and ignores it.
   */
  forkSession?(nativeSessionId: string, opts: ForkSessionOpts): Promise<string>;
}
