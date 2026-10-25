import type {
  PlanEntry,
  ToolCallInfo,
  ToolContent,
  ToolStatus,
  AgentProvider,
  AttentionOption,
  AttentionQuestion,
  NativeSessionInfo,
  PermissionMode,
  ProviderCapabilities,
  TranscriptRole,
} from '../../shared/types';
import type { WorkspaceTool } from '../main-agent';

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
    }
  /** Streaming text. For tool items it extends the terminal output. */
  | { type: 'outputDelta'; itemId: string; role: 'assistant' | 'tool' | 'thought'; delta: string }
  /** Full snapshot of the agent's checklist. */
  | { type: 'planUpdated'; entries: PlanEntry[]; explanation?: string }
  | { type: 'turnStarted' }
  | {
      type: 'turnCompleted';
      status: 'completed' | 'interrupted' | 'failed';
      /** Final assistant message of the turn, if any. */
      finalText?: string;
      error?: string;
    }
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
  | { type: 'sessionFailed'; error: string }
  | { type: 'sessionDisconnected'; reason: string };

export interface StartArgs {
  cwd: string;
  /** SSH alias to run the CLI on; unset = this Mac. */
  host?: string;
  /** Resume this provider-native session instead of creating one. */
  resumeNativeSessionId?: string;
  /** App-owned scoped memory, injected through the provider's instruction channel. */
  developerInstructions?: string;
  /** Mock only. */
  mockScript?: string;
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
  send(text: string, opts?: { interrupt?: boolean }): Promise<Delivery>;
  /** Answers a native approval / question by its provider request id. */
  respond(requestId: string, response: ApprovalResponse): Promise<void>;
  interrupt(): Promise<void>;
  /** Changes what the agent may do without asking; applies from the next action (Claude) or turn (Codex). */
  setPermissionMode?(mode: PermissionMode): Promise<void>;
  close(): Promise<void>;
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
  /** The CLI as installed and signed in on `host` (reached without prompts). */
  hostCapabilities?(host: string): Promise<ProviderCapabilities>;
  createSession(args: StartArgs, onEvent: (event: ProviderEvent) => void): ProviderSession;
}
