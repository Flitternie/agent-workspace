import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, posix, resolve, sep } from 'node:path';
import type { ModelOption,
  AgentProvider,
  AttentionItem,
  CoordinatorEntry,
  DispatchResult,
  FilePreview,
  ForkPoint,
  MemoryCandidate,
  MemoryRecord,
  MemoryScope,
  MemorySyncStatus,
  NativeSessionInfo,
  PermissionMode,
  Project,
  ProviderCapabilities,
  CodexRemoteControl,
  RemoteHostStatus,
  RouteDecision,
  SessionRecord,
  Settings,
  Task,
  ToolCallInfo,
  TranscriptItem,
  TransientKind,
  WorkspaceSnapshot, BtwEntry, ImageRef, AgentStatus, TaskUsage, ProviderLimits, LimitWindow } from '../shared/types';
import { accountKey, CODING_PROVIDERS, type CodingProvider } from '../shared/types';
import { acpAgent, isAcpProvider } from '../shared/acp-agents';
import { clipOutput } from '../shared/content';
import { CARRY_NOTE, conversationCopy, parseCopy, type SaidLine } from '../shared/conversation-copy';
import { statusGroup, type Group } from '../shared/agent-order';
import { asksUser, clip, headlineFor, summaryFor } from './attention';
import { deltaSize, instructionsFor, memoryDelta, memoryForTask, memoryUpdateText, seenOf } from './memory';
import { bodyHash, candidatesFrom, importCandidates, LOCAL, markCandidates, MEMORY_SCAN_SCRIPT, parseScanOutput, syncUserMemory, tombstone } from './memory-import';
import type { OpenAiClient } from './openai';
import type { LocalStt } from './stt/local';
import { STT_MODEL, ROUTER_MODEL } from './openai';
import type { HistoryImage, ProviderAdapter, ProviderEvent, ProviderSession } from './providers/types';
import { AttachmentStore, MAX_IMAGES } from './attachments';
import { planLimited } from './retry';
import { CONTINUE_PROMPT, DEFAULT_RETRY, RECONNECT_PROMPT, RETRY_LABEL, RETRY_PROMPT, retryDelayMs, type RetryPolicy } from './retry';
import { decideDeterministic, decideRoute, type RouteContext } from './router';
import { aliasFor, JsonStore } from './store';
import { ALIAS_PROBLEM_TEXT, aliasProblem, normalizeAlias } from '../shared/agent-name';
import { cleanLabel, labelLang, labelPrompt, labelRequest, labelRetry, needsNewLabel, titleLabel } from './label';
import { MAIN_AGENT_PROMPT, pickMainProvider, workspaceTools } from './main-agent';
import { gitRoot, WorktreeService } from './worktree';
import { GROUPING_PROMPT, GROUPING_UPDATE_NOTE, GROUPING_VERSION, mergeGrouping, parseGrouping, turnsDigest, turnsOf, type MapGrouping } from '../shared/session-map';
import { localPath, readLocal, readRemote, workDirs, type PreviewWhere } from './preview';
import { run } from './util/exec';
import { DISTILL_SYSTEM, distillPrompt, parseDistill } from './memory-distill';
import { chapterDue, chapterStart, IDLE_NEW } from '../shared/chapters';
import { browsePath, matchFiles, type FileMatch } from '../shared/file-match';
import { MemoryWriteback, notesFor, ownerOf, plan as planWriteback, renderNotes, type BackupEntry, type TargetKind, type TargetState, type WriteResult } from './memory-writeback';
import { parseRemoteScan, remoteScanScript, scanLocal, SkillLibrary, type FoundSkill } from './skills';
import { readResearch, sampleResearch, writeResearch, writeSampleNotes } from './research';
import { ResearchFiles } from './research-files';
import { aboutPrefix, leadBrief, researchBrief, researchTools, roleInstructions } from './research-tools';
import { moveClaudeSession } from './research-move';
import { repoOf } from './worktree';
import { aspectOf, childrenOf, formatValue, isResearchDir, nextResearchColor, parseResearchId, RESEARCH_COLORS, researchColor, researchId, routeFor, taskIdsOf, updateNode, type ResearchDoc, type ResearchNotes, type ResearchSummary } from '../shared/research';
import { loadKeychainKeys, openInTerminal, shq, sshConnect, sshError, sshHostEntries, sshHosts, sshProbe, sshRun, unlockKeys, type SshHostEntry } from './util/ssh';
import { settleStops } from './util/detached';

/** Words that clearly approve (zh / en). */
const APPROVAL = /(批准|允许|同意|可以|行|好的|确认|执行吧|跑吧|\b(yes|yep|allow|approve|approved|go ahead|ok|okay|sure|do it|confirm)\b)/i;

/** "不行 / 别 / don't": never read as approval. */
const NEGATION = /(不|别|没|勿|\b(no|not|don'?t|never|deny|stop)\b)/i;

const now = () => new Date().toISOString();
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30) || 'task';

interface LiveSession {
  localId: string;
  session: ProviderSession;
  turnActive: boolean;
  /**
   * Connected in the background when the user opened the agent's page, and not used since. Its
   * start-up is not activity: it must not move the agent in the sidebar, flag it or clear it.
   * Holds the status it had, to go back to if the session ends unused.
   */
  warm?: { status: AgentStatus };
  /** The "Resumed native session" note of a background connect, held back until the session is used. */
  resumeNote?: string;
  /** Its place in a research when it connected (research:role); a new place means connecting again (roleInstructions). */
  role?: string;
  /** When it was last connected to or sent to (ms): a research agent idle for long is disconnected. */
  lastUsed?: number;
}

/** A `!command` the user typed is stopped after this long. */
/** A command run with `!`: stopped after this long unless Settings › Advanced says otherwise. */
const SHELL_TIMEOUT_MS = 10 * 60_000;
/** How much of a command's output goes to the agent with the next message. */
const SHELL_CONTEXT_CHARS = 20_000;

/** The two shared-folder warnings; the renderer translates them by the same shapes (bits.tsx warningText). */
const SHARES_FOLDER = /^Shares a writable directory with .+ — edits are not isolated\.$/;
const ORIGINAL_FOLDER = /^Uses its original directory, shared with .+ — not isolated\.$/;

/** Claude Code's own markup for a `!command` and its output in a user turn. */

export function shellContext(command: string, stdout: string, stderr: string): string {
  const cut = (s: string) => (s.length > SHELL_CONTEXT_CHARS ? `…${s.slice(-SHELL_CONTEXT_CHARS)}` : s);
  return `<bash-input>${command}</bash-input>\n<bash-stdout>${cut(stdout.trimEnd())}</bash-stdout><bash-stderr>${cut(stderr.trimEnd())}</bash-stderr>`;
}

export interface WorkspaceOptions {
  dataDir: string;
  adapters: Partial<Record<AgentProvider, ProviderAdapter>>;
  openai?: OpenAiClient;
  log?: (...args: unknown[]) => void;
  demo?: boolean;
  localStt?: LocalStt;
  /** Folders whose sessions are the app's own (test scratch repos) and never offered for import. */
  hiddenSessionDirs?: string[];
  /** Automatic retries of turns that failed because the model was busy (tests use short waits). */
  retry?: Partial<RetryPolicy>;
  /** A research's agent with nothing to do is disconnected after this long (it connects again when used). */
  researchIdleMs?: number;
  /** A permission request left to a research's lead goes to the user if not decided in this long. */
  delegateMs?: number;
  /** Home folder whose native memory files this computer's scan reads (tests); default $HOME. */
  home?: string;
  /** Replaces the CLIs' one-shot answers for background jobs (tests). */
  backgroundModel?: (system: string, prompt: string) => Promise<string>;
  /** How long a label stands before new work may rewrite it (tests use 0). */
  labelRefreshMs?: number;
  /** Waits between attempts to reach a host again after its connection went (ms; the last repeats). */
  reconnectMs?: number[];
  /** Stops trying (quietly) after this long without reaching the host; waking up or a message starts again. */
  reconnectGiveUpMs?: number;
}

/**
 * The local backend (spec 03): task + session registry, durable attention queue,
 * routing, scoped memory and provider lifecycle. Framework-free so it can be
 * tested without Electron; the Electron layer only forwards IPC and events.
 */
export class Workspace {
  readonly store: JsonStore;
  private live = new Map<string, LiveSession>(); // taskId -> live provider session
  /** Remote Control links, for the live session that turned it on (gone with that session). */
  /** Remote Control per agent while its session lives: a Claude session's link, or a Codex agent's pairing. */
  private remote = new Map<string, { localId: string; url?: string; codex?: CodexRemoteControl }>();
  /** `!command` output not yet handed to the agent (providers without their own shell). */
  private shellOutput = new Map<string, string[]>();
  private connecting = new Map<string, Promise<LiveSession>>();
  /** Connects under way in the background (opening a page), whose failures stay quiet. */
  private warming = new Set<string>();
  private capabilities: ProviderCapabilities[] = [];
  private hostStatus = new Map<string, RemoteHostStatus>();
  private capsSeq = 0;
  private changeListeners = new Set<() => void>();
  /** item === null means "the whole transcript was replaced; reload it". */
  private transcriptListeners = new Set<(taskId: string, item: TranscriptItem | null) => void>();
  private worktrees: WorktreeService;
  /** Images sent with messages (and read back from history). */
  readonly attachments: AttachmentStore;
  private log: (...args: unknown[]) => void;
  private retryPolicy: RetryPolicy;
  /** taskId → the try in progress or waiting (2 = first retry) of the last instruction, and its timer while waiting. */
  private retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>();
  /** Hosts whose connection went, with their agents to connect again (true: it was working, carry on). */
  private reconnects = new Map<string, { attempt: number; since: number; timer?: NodeJS.Timeout; tasks: Map<string, boolean> }>();

  /** The skill library loaded into every agent the app starts (see skills.ts). */
  readonly skills: SkillLibrary;
  private writeback: MemoryWriteback;

  constructor(private opts: WorkspaceOptions) {
    this.store = new JsonStore(opts.dataDir);
    this.skills = new SkillLibrary(opts.dataDir);
    this.writeback = new MemoryWriteback(opts.dataDir, opts.home);
    this.worktrees = new WorktreeService(join(opts.dataDir, 'worktrees'));
    this.attachments = new AttachmentStore(join(opts.dataDir, 'attachments'));
    this.log = opts.log ?? (() => {});
    this.retryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
    this.applyModels();
    this.recoverAfterRestart();
    this.migrateLabels();
    this.refreshSharedFolders();
    // Relabelling waits for the CLIs to be detected (refreshCapabilities), so the user's own Claude Code
    // or Codex writes the labels rather than a fallback; tests hand in a model directly.
    if (opts.backgroundModel) setTimeout(() => this.relabelStale(), 0);
    this.idleSweep = setInterval(() => void this.closeIdleResearchAgents(), Math.min(60_000, Math.max(20, (opts.researchIdleMs ?? 15 * 60_000) / 4)));
    this.idleSweep.unref?.();
  }

  private idleSweep?: NodeJS.Timeout;

  /**
   * A research has many agents, most of them done most of the time: each kept connected holds a CLI process (and
   * on a host an SSH session: sshd allows 10 per connection) and goes down with the connection. One with nothing to
   * do for a while is disconnected quietly; it keeps its status, and the next message (or research message)
   * connects it again with its conversation.
   */
  private async closeIdleResearchAgents(): Promise<void> {
    const idleMs = this.opts.researchIdleMs ?? 15 * 60_000;
    const cutoff = Date.now() - idleMs;
    for (const [taskId, live] of [...this.live]) {
      const t = this.findTask(taskId);
      if (!t || t === this.store.data.mainAgent || live.turnActive || this.connecting.has(taskId) || this.hasOpenNative(taskId)) continue;
      if (['running', 'starting'].includes(t.status) || t.retry) continue;
      if (!(t.researchAgent || t.researchManager || this.researchPlace(t))) continue;
      if (Date.parse(t.updatedAt) > cutoff || (live.lastUsed ?? 0) > cutoff) continue;
      this.live.delete(taskId);
      await live.session.close().catch(() => {});
      if (t.status === 'idle') t.status = 'disconnected';
      this.log('closed idle research agent', taskId);
      this.changed();
    }
  }

  /**
   * Rewrites every agent's shared-folder warning from who is in its folder now, so all sharers are
   * named on every side (an imported session too) and an agent that was removed is no longer named.
   * With nobody else there, the agent's own reason for having no worktree (cwdNote) shows instead.
   * Warnings saved by older versions carry that reason in the text itself: it is moved to cwdNote once.
   */
  private refreshSharedFolders(): void {
    const tasks = this.store.data.tasks;
    for (const t of tasks) {
      const w = t.sharedCwdWarning;
      if (!w || t.cwdNote) continue;
      if (ORIGINAL_FOLDER.test(w)) t.keptOriginalFolder = true;
      else if (!SHARES_FOLDER.test(w)) t.cwdNote = w;
    }
    for (const t of tasks) {
      const others = tasks.filter((o) => o !== t && o.cwd === t.cwd && o.host === t.host).map((o) => o.alias);
      const names = others.join(', ');
      t.sharedCwdWarning = !others.length
        ? t.cwdNote
        : t.keptOriginalFolder
          ? `Uses its original directory, shared with ${names} — not isolated.`
          : `Shares a writable directory with ${names} — edits are not isolated.`;
    }
  }

  /** A label stands this long before the agent's newer work may rewrite it. */
  private get labelRefreshMs(): number {
    return this.opts.labelRefreshMs ?? 30 * 60_000;
  }

  private relabelTried = new Set<string>();

  /**
   * Once, on updating: every agent's name from an older version becomes the task's title, shortened,
   * and is marked for a model to label the work (all of them, in the background, most recently used
   * first). Only names the user set since names were marked stay.
   */
  private migrateLabels(): void {
    const d = this.store.data;
    if ((d.labelsVersion ?? 0) >= 1) return;
    for (const t of d.tasks) {
      if (!needsNewLabel(t)) continue;
      t.name = titleLabel(t.title, labelLang(t.alias)) ?? t.alias;
      t.nameSource = 'auto';
      t.labelStale = true;
    }
    d.labelsVersion = 1;
    this.store.save();
  }

  /** Rewrites every stale label, most recently used agents first (the background queue takes one at a time). */
  private relabelStale(): void {
    const stale = this.store.data.tasks
      .filter((t) => t.labelStale && !this.relabelTried.has(t.taskId))
      .sort((a, b) => Date.parse(b.lastUserActivityAt ?? b.updatedAt) - Date.parse(a.lastUserActivityAt ?? a.updatedAt));
    for (const t of stale) this.relabelFromHistory(t);
  }

  /** A model labels a stale agent from its title and the user's first messages. Once per run. */
  private relabelFromHistory(t: Task): void {
    if (!t.labelStale || this.relabelTried.has(t.taskId) || !this.canLabel()) return;
    this.relabelTried.add(t.taskId);
    const id = t.taskId;
    const said = this.store
      .transcript(t.taskId)
      .filter((i) => i.role === 'user' && i.text.trim())
      .slice(0, 4)
      .map((i) => i.text.replace(/\s+/g, ' ').slice(0, 300));
    // Only a label written counts: after a failure (no CLI yet, a bad key) the next chance tries again.
    void this.refineLabel(t, [t.title, ...said].join('\n')).then((ok) => {
      if (!ok) this.relabelTried.delete(id);
    });
  }

  /**
   * Keeps an automatic label current: when a turn ends, if the user has sent the agent a couple of
   * messages since its label was written and it has stood a while, a model relabels it from the
   * user's latest messages and the agent's latest report.
   */
  private maybeRefreshLabel(t: Task): void {
    if (t.nameSource !== 'auto' || t.labelStale || (t.saidSinceLabel ?? 0) < 2 || !this.canLabel()) return;
    if (Date.now() - Date.parse(t.labelAt ?? t.createdAt) < this.labelRefreshMs) return;
    const recent = this.store
      .transcript(t.taskId)
      .filter((i) => i.role === 'user' && i.text.trim())
      .slice(-4)
      .map((i) => i.text.replace(/\s+/g, ' ').slice(0, 300));
    t.saidSinceLabel = 0;
    void this.refineLabel(t, [`Latest work (label this, not the earlier work):`, ...recent, t.summary ? `Latest report: ${t.summary}` : ''].filter(Boolean).join('\n'));
  }

  /** Whether any model can write a label right now. */
  private canLabel(): boolean {
    return !this.opts.demo && (!!this.backgroundAsk() || !!this.opts.openai);
  }

  private keyInfo: WorkspaceSnapshot['voice']['openaiKey'] = { source: null };

  /** Swaps the OpenAI client at runtime (key added, changed or removed in Settings). */
  setOpenAi(client: OpenAiClient | undefined, info: WorkspaceSnapshot['voice']['openaiKey']): void {
    this.opts.openai = client;
    this.keyInfo = info;
    this.applyModels();
    this.changed();
  }

  openAi(): OpenAiClient | undefined {
    return this.opts.openai;
  }

  /** The on-device model in use, if one is selected and downloaded. */
  private localModelId(): string | undefined {
    const m = /^local:(.+)$/.exec(this.store.data.settings.sttModel ?? '')?.[1];
    return m && this.opts.localStt?.installed(m) ? m : undefined;
  }

  private sttReady(): boolean {
    return !!this.localModelId() || !!this.opts.openai;
  }

  /** Speech → text with the chosen model: on-device, or OpenAI with agent names as a spelling hint. */
  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    const tasks = this.store.data.tasks;
    const local = this.localModelId();
    if (local) return this.opts.localStt!.transcribe(local, audio, tasks.map((t) => t.alias));
    if (!this.opts.openai) throw new Error('Speech-to-text is not configured. Download a local model in Settings › Voice, or add an OpenAI key. Typed input still works.');
    const hint = ['Agent Workspace.', ...tasks.map((t) => `${t.alias}${t.name !== t.alias ? ` (${t.name})` : ''}: ${t.title}.`)].join(' ');
    return this.opts.openai.transcribe(audio, mimeType, hint);
  }

  private applyModels(): void {
    const ai = this.opts.openai;
    const s = this.store.data.settings;
    if (!ai) return;
    if (!process.env.AMW_STT_MODEL) ai.sttModel = s.sttModel && !s.sttModel.startsWith('local:') ? s.sttModel : STT_MODEL;
    if (!process.env.AMW_ROUTER_MODEL) ai.routerModel = s.routerModel || ROUTER_MODEL;
  }

  // ---------------------------------------------------------------- lifecycle

  /** Nothing is connected after a restart: be honest about it. */
  private recoverAfterRestart(): void {
    const d = this.store.data;
    // A question the agent asked (natively) stays open: it is answered in a message now, which the resumed
    // session reads with what it asked; the agent still waits on the user. (Approvals expire below.)
    for (const a of d.attention)
      if (a.state === 'open' && a.providerRequestId && a.kind === 'question') {
        a.providerRequestId = undefined;
        a.sessionLocalId = undefined;
        a.questions = undefined;
        a.options = undefined;
      }
    for (const t of [...d.tasks, ...(d.mainAgent ? [d.mainAgent] : [])]) {
      this.handBackRetry(t);
      this.endSubtasks(t, 'The app restarted.');
      if (['running', 'starting'].includes(t.status) || (t.status === 'waiting_for_user' && this.hasOpenNative(t.taskId))) {
        t.status = 'disconnected';
        t.summary = t.summary ? `${t.summary} (app restarted — resume to continue)` : 'App restarted — resume to continue';
      }
    }
    // A lost connection to a host is no error to keep (they reconnect when used): earlier ones, from
    // before agents reconnected by themselves, leave the waiting list.
    for (const t of d.tasks) {
      if (!t.host) continue;
      let cleared = false;
      for (const a of d.attention)
        if (a.taskId === t.taskId && a.state === 'open' && a.kind === 'error' && this.connectionLost(t, `${a.headline} ${a.details ?? ''}`)) {
          a.state = 'resolved';
          a.resolvedAt = now();
          a.resolution = 'Connection errors are not kept; the agent reconnects when used.';
          cleared = true;
        }
      if (t.status === 'failed' && (cleared || this.connectionLost(t, t.lastError))) {
        t.status = 'disconnected';
        t.summary = `Not connected to ${t.host}. Reconnects when you send a message.`;
      }
    }
    // A side question still unanswered when the app quit will not be answered now.
    for (const list of Object.values(d.btw ?? {}))
      for (const e of list) if (!e.answer && !e.error) e.error = 'The app quit before this was answered.';
    // Native approvals die with the provider process: never shown as still answerable.
    for (const a of d.attention) {
      if (a.state === 'open' && a.providerRequestId) {
        a.state = 'expired';
        a.resolvedAt = now();
        a.resolution = 'The provider process ended (app restart) before this was answered.';
      }
    }
    this.store.save();
  }

  /**
   * Looks at the CLIs on this computer again, and (unless `localOnly`) at the SSH hosts, quietly: their
   * rows keep the last result meanwhile. The first-run guide polls with `localOnly` while the user
   * installs or signs in here; hosts have their own slower recheck.
   */
  async refreshCapabilities(opts: { localOnly?: boolean } = {}): Promise<void> {
    // Looks overlap (a recheck while the guide polls, a sign-in ending): the latest one started wins, never an older one finishing late.
    const seq = ++this.capsSeq;
    const caps: ProviderCapabilities[] = [];
    for (const a of Object.values(this.opts.adapters)) {
      if (!a) continue;
      try {
        // Fork support comes from the adapter itself, so the renderer offers it for every provider that has it.
        caps.push({ ...(await a.capabilities()), fork: !!(a.forkSession && a.forkPoints), forkElsewhere: !!(a.readHistory && a.forkPoints) });
      } catch (error) {
        this.log('capabilities failed', a.provider, error);
      }
    }
    if (seq !== this.capsSeq) return;
    this.capabilities = caps;
    this.syncMainAgent();
    this.changed();
    if (!opts.localOnly) void this.refreshHosts({ quiet: true });
    // The CLIs are known now: stale labels from older versions can be rewritten.
    this.relabelStale();
  }

  // ---------------------------------------------------------------- remote hosts

  /** Hosts enabled in Settings that are still in ~/.ssh/config. */
  private enabledHosts(): string[] {
    const known = sshHosts();
    return (this.store.data.settings.remoteHosts ?? []).filter((h) => known.includes(h));
  }

  requireHost(host: string): void {
    if (!this.enabledHosts().includes(host)) throw new Error(`${host} is not enabled in Settings › Remote machines.`);
  }

  /** Background check of every enabled host (keys saved in the Keychain are reloaded first). */
  async refreshHosts(opts: { quiet?: boolean } = {}): Promise<void> {
    const hosts = this.enabledHosts();
    if (!hosts.length) return;
    await loadKeychainKeys();
    await Promise.all(hosts.map((h) => this.checkHost(h, opts).catch((error) => this.log('host check failed', h, error))));
  }

  /** Whether `host` is reachable without prompting, and Claude Code / Codex there. Never prompts. */
  /**
   * Probes a host. `quiet` (a background look, e.g. while the user installs an agent there): the
   * last result stays on screen meanwhile and the UI hears only of a change, so nothing flickers.
   */
  async checkHost(host: string, opts: { quiet?: boolean } = {}): Promise<RemoteHostStatus> {
    const prev = this.hostStatus.get(host);
    const quiet = !!opts.quiet && !!prev && prev.ssh !== 'checking';
    if (!quiet) {
      this.hostStatus.set(host, { host, ssh: 'checking', capabilities: prev?.capabilities ?? [] });
      this.changed();
    }
    const probe = await sshProbe(host);
    const capabilities =
      probe.state === 'ok'
        ? await Promise.all(
            Object.values(this.opts.adapters)
              .filter((a): a is ProviderAdapter => !!a?.remote && !!a.hostCapabilities)
              .map((a) => a.hostCapabilities!(host).catch((error): ProviderCapabilities => ({ provider: a.provider, available: false, detail: (error as Error).message, createSession: false, resumeHistorical: false, importHistory: false, attachExternalRunning: false, readOnlyMonitor: false, structuredApprovals: false, structuredQuestions: false }))),
          )
        : [];
    const status: RemoteHostStatus = { host, ssh: probe.state, error: probe.error, capabilities, checkedAt: now() };
    const same = (a?: RemoteHostStatus) => !!a && JSON.stringify({ ...a, checkedAt: undefined }) === JSON.stringify({ ...status, checkedAt: undefined });
    if (this.enabledHosts().includes(host)) this.hostStatus.set(host, status);
    if (!quiet || !same(prev)) this.changed();
    // A machine that just became reachable may hold user memory we have not seen.
    if (status.ssh === 'ok' && prev?.ssh !== 'ok') void this.syncMemory();
    return status;
  }

  setHostEnabled(host: string, enabled: boolean): void {
    if (!sshHosts().includes(host)) throw new Error(`${host} is not a Host in ~/.ssh/config.`);
    const d = this.store.data.settings;
    d.remoteHosts = [...new Set([...(d.remoteHosts ?? []).filter((h) => h !== host), ...(enabled ? [host] : [])])];
    if (enabled) void loadKeychainKeys().then(() => this.checkHost(host)).catch((error) => this.log('host check failed', host, error));
    else this.hostStatus.delete(host);
    this.changed();
  }

  /**
   * User-initiated: unlocks the host's key (passphrase to ssh-add and the Keychain) or
   * logs in with a password / 2FA / new host key through a native prompt; the login is
   * then shared by every session on that host.
   */
  async connectHost(host: string): Promise<RemoteHostStatus> {
    this.requireHost(host);
    const state = this.hostStatus.get(host)?.ssh;
    const r = state === 'needs_key' ? await unlockKeys(host) : await sshConnect(host);
    const status = await this.checkHost(host);
    if (!r.ok && status.ssh !== 'ok') throw new Error(r.error);
    return status;
  }

  async openHostTerminal(host: string): Promise<void> {
    this.requireHost(host);
    await openInTerminal(host);
  }

  /** Throws when `provider` is known not to work on `host`. */
  private requireOnHost(provider: AgentProvider, host: string): void {
    this.requireHost(host);
    if (!this.opts.adapters[provider]?.remote) throw new Error(`${provider} agents cannot run on SSH hosts.`);
    const status = this.hostStatus.get(host);
    const cap = status?.capabilities.find((c) => c.provider === provider);
    if (status && status.ssh !== 'ok' && status.ssh !== 'checking') throw new Error(status.error ?? `Cannot reach ${host}.`);
    if (cap && !cap.available) throw new Error(cap.detail ?? `${provider} is not installed on ${host}.`);
    const acp = acpAgent(provider);
    if (cap?.auth?.loggedIn === false) throw new Error(`${acp?.label ?? (provider === 'claude' ? 'Claude Code' : 'Codex')} on ${host} is not signed in. Sign in there once (${acp?.login ?? (provider === 'claude' ? 'claude' : 'codex login')}), then recheck.`);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.memSync.timer);
    this.memSync.started = false;
    // Detach first so close-time events are dropped; restart recovery then marks state honestly.
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    clearInterval(this.idleSweep);
    for (const r of this.reconnects.values()) clearTimeout(r.timer);
    this.reconnects.clear();
    const sessions = [...this.live.values()];
    this.live.clear();
    for (const l of sessions) await l.session.close().catch(() => {});
    // CLIs on hosts run detached from their connection: their stops have to reach the host before we go.
    await settleStops();
    this.store.flush();
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onTranscript(cb: (taskId: string, item: TranscriptItem | null) => void): () => void {
    this.transcriptListeners.add(cb);
    return () => this.transcriptListeners.delete(cb);
  }

  /** For state owned outside the workspace (local model downloads) that the snapshot reports. */
  notifyChanged(): void {
    this.changedThrottled();
  }

  /** Each task's status group as last seen, to stamp `statusSince` when it changes. */
  private seenGroup = new Map<string, Group>();

  /**
   * Stamps `statusSince` on tasks whose status moved to another group (waiting / working / rest).
   * Runs before every save and snapshot, so the many places that set a status need not know.
   * The first look after launch only records the group: a stamp from the last run stays valid.
   */
  private stampStatus(): void {
    for (const t of this.store.data.tasks) {
      const g = statusGroup(t.status);
      const seen = this.seenGroup.get(t.taskId);
      if (seen !== undefined && seen !== g) t.statusSince = now();
      else if (!t.statusSince) t.statusSince = t.updatedAt || t.createdAt;
      this.seenGroup.set(t.taskId, g);
    }
  }

  private changed(): void {
    this.stampStatus();
    this.store.save();
    for (const cb of this.changeListeners) cb();
  }

  // ---------------------------------------------------------------- research (trees kept in a project's repos)
  // A research is named by its id (shared/research.ts researchId): its project's for the one at the
  // project's root, "<project>::<folder>" for one in a folder (a project holding several repositories).

  /** The research files: .research/ on this Mac, or fetched from and written to the project's SSH host. */
  private researchFiles = new ResearchFiles(
    (id) => this.researchProject(id),
    (projectId) => this.project(projectId),
    () => {
      this.researchIndex.clear();
      this.researchIds.clear();
      this.changed();
    },
    (...args) => this.log(...args),
  );
  /** Each research's summary (who is in it), read once and kept current on save. */
  private researchIndex = new Map<string, ResearchSummary | null>();
  /** Each project's researches, found once. */
  private researchIds = new Map<string, string[]>();

  /** The project a research id names, its root moved to the research's folder. */
  private researchProject(id: string): Project {
    const { projectId, dir } = parseResearchId(id);
    const p = this.project(projectId);
    if (!dir) return p;
    if (!isResearchDir(dir)) throw new Error(`Not a folder a research can be in: ${dir}`);
    return { ...p, projectId: id, rootPath: p.host ? `${p.rootPath.replace(/\/+$/, '')}/${dir}` : join(p.rootPath, dir) };
  }

  private summarize(id: string, doc: ResearchDoc | null): ResearchSummary | null {
    if (!doc) return null;
    const n = this.researchFiles.notes(id);
    const notesAt = [n.summary?.updatedAt, n.ui?.updatedAt, n.memory?.updatedAt, ...Object.values(n.aspects).map((x) => x.updatedAt), ...Object.values(n.views ?? {}).map((x) => x.updatedAt)].filter((x): x is string => !!x).sort().at(-1);
    const { projectId, dir } = parseResearchId(id);
    return { id, projectId, ...(dir ? { dir } : {}), ...(doc.color != null ? { color: doc.color } : {}), title: doc.title, taskIds: taskIdsOf(doc), updatedAt: doc.updatedAt, notesAt };
  }

  private researchSummaries(): ResearchSummary[] {
    const out: ResearchSummary[] = [];
    for (const p of this.store.data.projects) {
      let ids = this.researchIds.get(p.projectId);
      if (!ids) {
        ids = this.researchFiles.ids(p.projectId);
        this.researchIds.set(p.projectId, ids);
      }
      for (const id of ids) {
        if (!this.researchIndex.has(id)) this.researchIndex.set(id, this.summarize(id, this.researchFiles.doc(id)));
        const r = this.researchIndex.get(id);
        if (r) out.push(r);
      }
    }
    return out;
  }

  private indexResearch(projectId: string, doc: ResearchDoc | null): void {
    this.researchIndex.set(projectId, this.summarize(projectId, doc));
    this.changed();
  }

  /** Resolves when the research can be read as it is (pending writes done; an SSH host's fetched). */
  researchReady(projectId: string): Promise<void> {
    return this.researchFiles.ready(projectId);
  }

  researchGet(projectId: string): ResearchDoc | null {
    return this.researchFiles.doc(projectId);
  }

  /** For the page: once ready (an SSH host's research is fetched first). */
  async researchLoad(projectId: string): Promise<ResearchDoc | null> {
    await this.researchReady(projectId);
    const doc = this.researchGet(projectId);
    this.researchIndex.set(projectId, this.summarize(projectId, doc));
    return doc;
  }

  researchSave(projectId: string, doc: ResearchDoc, by?: string): ResearchDoc {
    const before = this.researchFiles.doc(projectId);
    this.researchFiles.saveDoc(projectId, doc);
    this.indexResearch(projectId, doc);
    if (before) this.reportUp(before, doc, by);
    return doc;
  }

  /**
   * What happens in one part of a research reaches the agent over it, by itself: an experiment's result goes
   * to its aspect's agent; an aspect's changed takeaway goes to the lead. Never to the agent that made the change.
   */
  private reportUp(before: ResearchDoc, after: ResearchDoc, by?: string): void {
    const zh = this.language() === 'zh';
    const done = (s: string) => s === 'pass' || s === 'fail' || s === 'unclear' || s === 'error';
    const tell = (taskId: string | undefined, text: string) => {
      if (!taskId || taskId === by || !this.findTask(taskId)) return;
      void this.send(taskId, text, 'text', { keepAsks: true }).catch(() => {});
    };
    const byAspect = new Map<string, string[]>();
    for (const e of after.nodes.filter((n) => n.type === 'experiment' && done(n.status))) {
      const was = before.nodes.find((n) => n.id === e.id);
      if (was && done(was.status) && was.value === e.value && was.takeaway === e.takeaway) continue;
      const method = after.nodes.find((n) => n.id === e.parent);
      const aspect = after.nodes.find((n) => n.id === method?.parent);
      if (!aspect || !method) continue;
      const result = [e.status, e.value != null ? formatValue(aspect.metric, e.value) : '', e.takeaway ?? e.findings?.at(-1)?.text ?? ''].filter(Boolean).join(' · ');
      byAspect.set(aspect.id, [...(byAspect.get(aspect.id) ?? []), `[${e.id}] ${method.title} / ${e.title}: ${result}`]);
    }
    for (const [aspectId, lines] of byAspect) {
      const aspect = after.nodes.find((n) => n.id === aspectId)!;
      // A method whose experiments all have their results now (some were still running before): time for the notes, unless the policy says not to.
      const whole = after.policy?.autoNotes === false ? [] : after.nodes.filter((m) => m.type === 'method' && m.parent === aspectId).filter((m) => {
        const now = childrenOf(after, m.id);
        return now.length > 0 && now.every((e) => done(e.status)) && childrenOf(before, m.id).some((e) => e.status === 'running');
      });
      const notes = whole.map((m) => (zh ? `「${m.title}」这一批 ${childrenOf(after, m.id).length} 个实验都有结果了。可以用 research_notes 更新「${aspect.title}」的笔记。` : `All ${childrenOf(after, m.id).length} experiments of "${m.title}" have their results. You may want to update the notes for "${aspect.title}" (research_notes).`));
      // To the aspect's agent; with none (the lead runs this aspect itself), to the lead.
      const to = aspect.taskId && this.findTask(aspect.taskId) ? aspect.taskId : after.leadTaskId;
      tell(to, [`${zh ? `「${aspect.title}」里有实验出结果了：` : `Results came in under "${aspect.title}":`}`, ...lines, zh ? '据此决定下一步（再试什么、是否已有结论），并保持这个方面和对应方法的一句话结论是最新的（research_update）。' : 'Decide what follows (what to try next, whether there is a conclusion yet), and keep this aspect’s and the method’s takeaways current (research_update).', ...notes].join('\n'));
    }
    for (const a of after.nodes.filter((n) => n.type === 'aspect' && n.takeaway)) {
      if (before.nodes.find((n) => n.id === a.id)?.takeaway === a.takeaway) continue;
      tell(after.leadTaskId, zh ? `「${a.title}」的结论更新了：${a.takeaway}` : `The takeaway of "${a.title}" changed: ${a.takeaway}`);
    }
  }

  // Notes: .research/summary.md (the lead's) and notes/<aspect>.md (each aspect's agent's).
  researchNotes(projectId: string): ResearchNotes {
    return this.researchFiles.notes(projectId);
  }

  async researchLoadNotes(projectId: string): Promise<ResearchNotes> {
    await this.researchReady(projectId);
    return this.researchNotes(projectId);
  }

  /** When the summary was last asked for, per research (the research's policy says how often at most). */
  private summaryAsked = new Map<string, number>();

  researchWriteNote(projectId: string, scope: string, text: string): void {
    this.researchFiles.saveNote(projectId, scope, text);
    const doc = this.researchFiles.doc(projectId);
    this.indexResearch(projectId, doc);
    if (scope === 'summary' || scope === 'ui' || scope === 'memory' || scope.startsWith('view:') || !doc) return;
    // An aspect's notes moved: the lead folds them into the summary, as often as the policy allows.
    const every = (doc.policy?.summaryEvery ?? 30) * 60_000;
    const lead = doc.leadTaskId ? this.findTask(doc.leadTaskId) : undefined;
    const last = this.summaryAsked.get(projectId) ?? 0;
    if (!every || !lead || Date.now() - last < every) return;
    this.summaryAsked.set(projectId, Date.now());
    const zh = this.language() === 'zh';
    const aspect = doc.nodes.find((n) => n.id === scope)?.title ?? scope;
    void this.send(lead.taskId, zh ? `「${aspect}」的笔记更新了。请用 research_overview 看各方面的笔记，再用 research_notes 把总结（scope "summary"）更新成现在的情况。` : `The notes for "${aspect}" changed. Read the aspects' notes (research_overview) and bring the summary up to date with research_notes (scope "summary").`, 'text', { keepAsks: true }).catch(() => {});
  }

  // ResearchHost: what the research tools need.
  researchList(): Array<{ id: string; projectId: string; project: string; dir?: string; title: string; taskIds: string[] }> {
    return this.researchSummaries().map((r) => ({ id: r.id, projectId: r.projectId, project: this.store.data.projects.find((p) => p.projectId === r.projectId)?.name ?? r.projectId, ...(r.dir ? { dir: r.dir } : {}), title: r.title, taskIds: r.taskIds }));
  }

  allProjects(): Array<{ projectId: string; name: string }> {
    return this.store.data.projects.map((p) => ({ projectId: p.projectId, name: p.name }));
  }

  findTaskById(taskId: string): Task | undefined {
    return this.findTask(taskId);
  }

  language(): 'en' | 'zh' {
    return this.store.data.settings.language === 'zh' ? 'zh' : 'en';
  }

  /** The provider a research starts agents with: mock agents in the demo or a workspace with nothing else; else the first signed-in CLI. */
  private async researchProvider(id?: string, nodeId?: string): Promise<AgentProvider> {
    // Right after launch the CLIs may not be checked yet: checked now rather than refused.
    if (!this.capabilities.length) await this.refreshCapabilities({ localOnly: true });
    // The one chosen for its aspect, else for the research (the user's choice; whether it can start there is checked then).
    const doc = id ? this.researchGet(id) : null;
    const node = doc && nodeId ? doc.nodes.find((n) => n.id === nodeId) : undefined;
    const aspect = node && doc ? (node.type === 'aspect' ? node : aspectOf(doc, node)) : undefined;
    const wanted = aspect?.provider ?? doc?.policy?.provider;
    if (wanted && this.opts.adapters[wanted]) return wanted;
    const onlyMock = Object.keys(this.opts.adapters).every((k) => k === 'mock');
    const order: AgentProvider[] = this.opts.demo || onlyMock ? ['mock', 'claude', 'codex'] : ['claude', 'codex'];
    const p = order.find((x) => this.opts.adapters[x] && (x === 'mock' || this.capabilities.find((c) => c.provider === x)?.available));
    if (!p) throw new Error('No signed-in Claude Code or Codex to start an agent.');
    return p;
  }

  /** Whether an agent is one of a research's (its lead, an aspect's or an experiment's agent). */
  private inAnyResearch(taskId: string): boolean {
    return this.researchSummaries().some((r) => r.taskIds.includes(taskId));
  }

  /** An agent's place in a research: its lead, an aspect's agent, an experiment's, or none. */
  private researchRole(id: string, taskId: string): 'lead' | 'aspect' | 'experiment' | 'none' {
    const doc = this.researchGet(id);
    if (!doc) return 'none';
    if (doc.leadTaskId === taskId) return 'lead';
    const n = doc.nodes.find((x) => x.taskId === taskId);
    return n ? (n.type === 'aspect' ? 'aspect' : 'experiment') : 'none';
  }

  /** The agent's place in its project's research, if it has one: which research, and as what. */
  private researchPlace(task: Task): { id: string; role: 'lead' | 'aspect' | 'experiment' } | undefined {
    for (const r of this.researchSummaries()) {
      if (r.projectId !== task.projectId) continue;
      const role = this.researchRole(r.id, task.taskId);
      if (role !== 'none') return { id: r.id, role };
    }
    return undefined;
  }

  /** One agent of a research tells another something (research_tell): delivered as a message, marked with who sent it. */
  async researchTell(fromTaskId: string | undefined, toTaskId: string, text: string): Promise<string> {
    const to = this.findTask(toTaskId);
    if (!to) throw new Error('That agent is gone.');
    const from = fromTaskId ? this.findTask(fromTaskId)?.alias : undefined;
    const zh = this.language() === 'zh';
    const r = await this.send(to.taskId, `${from ? (zh ? `【来自 ${from}】` : `[From ${from}] `) : ''}${text}`, 'text', { keepAsks: true });
    if (!r.ok) throw new Error(r.error ?? 'Not delivered.');
    return r.queued ? `${to.alias} (its machine cannot be reached right now; the message goes out when it can)` : to.alias;
  }

  /** For a research kept in a folder of its project: which folder its agents work on. */
  private researchWhere(id: string): string {
    const { dir } = parseResearchId(id);
    if (!dir) return '';
    return this.language() === 'zh' ? `这个研究是关于项目里的 ${dir}/ 目录的，你就在这个目录里工作（项目根目录是上一级）。\n\n` : `This research is about the folder ${dir}/ of the project, and you work in it (the project's root is one level up).\n\n`;
  }

  /** Starts an agent for a node (an aspect's, or an experiment's in its own worktree), briefed, and links it. */
  async researchStartAgent(projectId: string, nodeId: string, opts: { isolate: boolean; message?: string }): Promise<Task> {
    await this.researchReady(projectId);
    const doc = this.researchGet(projectId);
    const node = doc?.nodes.find((n) => n.id === nodeId);
    if (!doc || !node) throw new Error('That node is not in the research.');
    const provider = await this.researchProvider(projectId, nodeId);
    const aspect = node.type === 'aspect' ? node : doc.nodes.find((n) => n.id === doc.nodes.find((m) => m.id === node.parent)?.parent);
    const zh = this.language() === 'zh';
    const task = await this.createTask({
      projectId: parseResearchId(projectId).projectId,
      provider,
      title: node.type === 'aspect' ? (zh ? `${node.title}（研究）` : `${node.title} (research)`) : `${aspect?.title ?? ''} · ${node.title}`,
      instruction: `${this.researchWhere(projectId)}${researchBrief(doc, node, this.language(), opts.message, this.researchNotes(projectId))}`,
      isolate: opts.isolate,
      researchAgent: true,
      ...(node.type === 'aspect' ? { researchManager: true } : {}),
      ...(parseResearchId(projectId).dir ? { subdir: parseResearchId(projectId).dir } : {}),
      ...(provider === 'mock' ? { mockScript: 'work' } : {}),
    });
    // Linked on the freshest copy: the tree may have changed while the agent started.
    const fresh = this.researchGet(projectId)!;
    this.researchSave(projectId, updateNode(fresh, nodeId, { taskId: task.taskId, ...(node.status === 'idea' ? { status: 'running' as const } : {}) }));
    return task;
  }

  /** The research's lead: the agent the user lays the tree out with and talks to about all of it. Started by the first message to it. */
  async researchStartLead(projectId: string, message: string): Promise<Task> {
    await this.researchReady(projectId);
    const doc = this.researchGet(projectId);
    if (!doc) throw new Error('This project has no research.');
    const zh = this.language() === 'zh';
    const leadProvider = await this.researchProvider(projectId);
    const task = await this.createTask({
      projectId: parseResearchId(projectId).projectId,
      provider: leadProvider,
      title: zh ? `${doc.title}（研究负责人）` : `${doc.title} (research lead)`,
      instruction: `${this.researchWhere(projectId)}${leadBrief(doc, this.language(), message, this.researchNotes(projectId))}`,
      isolate: false,
      researchManager: true,
      ...(parseResearchId(projectId).dir ? { subdir: parseResearchId(projectId).dir } : {}),
      ...(leadProvider === 'mock' ? { mockScript: 'work' } : {}),
    });
    this.researchSave(projectId, { ...this.researchGet(projectId)!, leadTaskId: task.taskId, updatedAt: new Date().toISOString() });
    return task;
  }

  /**
   * The box on the research page: to the agent of the nearest node over what is selected (an aspect
   * with no agent yet: this message starts it), or to the research's lead (started by its first message).
   */
  async researchMessage(projectId: string, nodeIds: string[], text: string, images?: ImageRef[]): Promise<{ taskId: string; alias: string }> {
    await this.researchReady(projectId);
    const doc = this.researchGet(projectId);
    if (!doc) throw new Error('This project has no research.');
    const nodes = nodeIds.map((id) => doc.nodes.find((n) => n.id === id)).filter((n): n is NonNullable<typeof n> => !!n);
    const route = routeFor(doc, nodes);
    const lang = this.language();
    const deliver = async (taskId: string, body: string) => {
      const r = await this.send(taskId, body, 'text', { images });
      if (!r.ok) throw new Error(r.error ?? 'Not delivered.');
      return { taskId, alias: this.findTask(taskId)?.alias ?? '' };
    };
    if (route.kind === 'experiment') return deliver(route.node.taskId!, text);
    const start = async (t: Task) => {
      // Images come with a first message only through send: right after it starts.
      if (images?.length) await this.send(t.taskId, '', 'text', { images });
      return { taskId: t.taskId, alias: t.alias };
    };
    if (route.kind === 'aspect') {
      const prefix = aboutPrefix(route.about, doc, lang, false);
      const agent = route.aspect.taskId ? this.findTask(route.aspect.taskId) : undefined;
      if (!agent) return start(await this.researchStartAgent(projectId, route.aspect.id, { isolate: false, message: `${prefix}${text}` }));
      return deliver(agent.taskId, `${prefix}${text}`);
    }
    const prefix = aboutPrefix(route.about, doc, lang, false);
    const lead = doc.leadTaskId ? this.findTask(doc.leadTaskId) : undefined;
    if (!lead) return start(await this.researchStartLead(projectId, `${prefix}${text}`));
    return deliver(lead.taskId, `${prefix}${text}`);
  }

  /** Ends a research: its agents are ordinary agents of the project again; its files stay, renamed (ResearchFiles.dissolve). */
  async researchDissolve(id: string): Promise<{ kept: string }> {
    await this.researchReady(id);
    if (!this.researchGet(id)) throw new Error('No research.');
    const kept = await this.researchFiles.dissolve(id);
    this.researchIndex.delete(id);
    this.researchIds.delete(parseResearchId(id).projectId);
    this.changed();
    return { kept };
  }

  /** The CLI a research's agents start on, or an aspect's (null: back to the research's, or the default). */
  async researchSetProvider(id: string, nodeId: string | undefined, provider: AgentProvider | null): Promise<void> {
    await this.researchReady(id);
    const doc = this.researchGet(id);
    if (!doc) throw new Error('No research.');
    if (provider && !this.opts.adapters[provider]) throw new Error(`${providerName(provider)} is not available here.`);
    if (nodeId) {
      const n = doc.nodes.find((x) => x.id === nodeId && x.type === 'aspect');
      if (!n) throw new Error('A CLI is chosen for the research or one of its aspects.');
      this.researchSave(id, updateNode(doc, nodeId, { provider: provider ?? undefined }));
    } else this.researchSave(id, { ...doc, policy: { ...doc.policy, provider: provider ?? undefined }, updatedAt: new Date().toISOString() });
  }

  /**
   * A research's agent goes on in another CLI: a new agent there continues its conversation (the fork onto
   * another CLI, in the same folder) and takes its place in the tree; the old one is set aside.
   */
  async researchSwitchAgent(id: string, taskId: string, provider: AgentProvider): Promise<Task> {
    await this.researchReady(id);
    const role = this.researchRole(id, taskId);
    if (role === 'none') throw new Error('That agent is not in this research.');
    const src = this.task(taskId);
    if (src.provider === provider) return src;
    if (src.host) this.requireOnHost(provider, src.host);
    const t = await this.forkTask(taskId, { provider, isolate: false, name: src.name });
    t.title = src.title;
    t.researchAgent = true;
    if (src.researchManager) t.researchManager = true;
    // The folder (its worktree, if it had one) is the new agent's now.
    t.worktree = src.worktree;
    src.worktree = undefined;
    const doc = this.researchGet(id)!;
    const node = doc.nodes.find((n) => n.taskId === taskId);
    this.researchSave(id, role === 'lead' ? { ...doc, leadTaskId: t.taskId, updatedAt: new Date().toISOString() } : updateNode(doc, node!.id, { taskId: t.taskId }));
    await this.stop(taskId).catch(() => {});
    src.setAside = true;
    const zh = this.language() === 'zh';
    this.appendSystem(taskId, zh ? `已换到 ${providerName(provider)}：由 ${t.alias} 接着做。` : `Moved to ${providerName(provider)}: ${t.alias} carries on.`);
    this.changed();
    return t;
  }

  /** A folder research's agents that still work at the project root (started before its agents ran in its folder). */
  researchAgentsAtRoot(id: string): Task[] {
    const { projectId, dir } = parseResearchId(id);
    const doc = this.researchGet(id);
    if (!dir || !doc) return [];
    const root = this.project(projectId).rootPath.replace(/\/+$/, '');
    return taskIdsOf(doc)
      .map((t) => this.findTask(t))
      .filter((t): t is Task => !!t && !t.worktree && t.cwd.replace(/\/+$/, '') === root);
  }

  /**
   * Moves them into the research's folder with their conversations: a Claude session is copied to the folder's
   * place, without the root's memory it was given (research-move.ts); a Codex thread just resumes there. One that is
   * working, or that a question of its CLI waits on, is left for later.
   */
  async researchMoveAgents(id: string): Promise<{ moved: string[]; busy: string[] }> {
    await this.researchReady(id);
    const { projectId, dir } = parseResearchId(id);
    if (!dir) throw new Error('This research is the whole project: its agents already work there.');
    const project = this.project(projectId);
    const root = project.rootPath.replace(/\/+$/, '');
    const target = project.host ? `${root}/${dir}` : join(root, dir);
    const moved: string[] = [];
    const busy: string[] = [];
    for (const task of this.researchAgentsAtRoot(id)) {
      const live = this.live.get(task.taskId);
      if (this.connecting.has(task.taskId) || live?.turnActive || ['running', 'starting'].includes(task.status) || this.hasOpenNative(task.taskId)) {
        busy.push(task.alias);
        continue;
      }
      const native = this.currentSession(task)?.nativeSessionId;
      if (task.provider === 'claude' && native) await moveClaudeSession(task.host, native, task.cwd, target);
      if (live) {
        this.live.delete(task.taskId);
        await live.session.close().catch(() => {});
      }
      task.cwd = target;
      const s = this.currentSession(task);
      if (s) s.cwd = target;
      this.appendSystem(task.taskId, this.language() === 'zh' ? `已移到研究文件夹 ${target}，对话保留；项目根目录的记忆不再带上。` : `Moved into the research's folder ${target} with its conversation; the project root's memory no longer comes with it.`);
      moved.push(task.alias);
      if (live) this.warm(task.taskId);
    }
    this.changed();
    return { moved, busy };
  }

  /** The conversations as the lead is asked to bring them in: read each, lay out a few broad aspects, attach. */
  private bringIn(tasks: Task[]): string {
    const names = tasks.map((t) => `${t.alias}${t.title ? ` (${t.title})` : ''}`).join(', ');
    return this.language() === 'zh'
      ? `请把这些已有的对话整理进这个研究：${names}。先用 research_read 读每个对话，按内容定出少数几个大的方面和各自的方法（同类的放在一起；为某个方法做的前期验证放在该方法下面），把得到的数字和结论记到实验上（research_record，含一句话结论），再用 research_attach 把每个对话挂到它对应的节点。最后写一份总结（research_notes，scope "summary"），并用一两句话告诉我整理成了什么样。`
      : `Bring these existing conversations into this research: ${names}. Read each with research_read; lay out a few broad aspects and their methods from what they did (things of one kind together; an early check for a method goes under that method); record the numbers and conclusions on experiments (research_record, with a one-line takeaway); attach each conversation to its node with research_attach. Then write the summary (research_notes, scope "summary") and tell me in a line or two what it came to.`;
  }

  /** A research made from conversations the user picked: created, then its lead reads them and builds the tree. */
  async researchFromTasks(projectId: string, taskIds: string[], title?: string, dir?: string): Promise<{ researchId: string }> {
    const tasks = taskIds.map((id) => this.findTask(id)).filter((t): t is Task => !!t);
    if (!tasks.length) throw new Error('Pick at least one conversation.');
    if (tasks.some((t) => t.projectId !== projectId)) throw new Error('A research holds conversations of one project.');
    const name = title?.trim() || tasks[0].title || tasks[0].alias;
    await this.researchCreate(projectId, name, '', false, dir);
    const d = dir?.trim().replace(/^\.\/+|\/+$/g, '');
    const id = researchId(projectId, d || undefined);
    await this.researchStartLead(id, this.bringIn(tasks));
    return { researchId: id };
  }

  /** More conversations into a research that exists: its lead is asked (and started if it has none yet). */
  async researchAddTasks(id: string, taskIds: string[]): Promise<void> {
    await this.researchReady(id);
    const doc = this.researchGet(id);
    if (!doc) throw new Error('No research.');
    const taken = new Set(taskIdsOf(doc));
    const tasks = taskIds.map((t) => this.findTask(t)).filter((t): t is Task => !!t && !taken.has(t.taskId) && t.projectId === parseResearchId(id).projectId);
    if (!tasks.length) throw new Error('Those conversations are already in it, or belong to another project.');
    const lead = doc.leadTaskId ? this.findTask(doc.leadTaskId) : undefined;
    if (!lead) await this.researchStartLead(id, this.bringIn(tasks));
    else {
      const r = await this.send(lead.taskId, this.bringIn(tasks), 'text');
      if (!r.ok) throw new Error(r.error ?? 'Not delivered.');
    }
  }

  /** The page puts a template in place as a node's view (to be edited from there, by an agent or by hand). */
  async researchSetView(id: string, key: string, text: string): Promise<void> {
    await this.researchReady(id);
    const doc = this.researchGet(id);
    if (!doc) throw new Error('No research.');
    if (key !== 'goal' && !doc.nodes.some((n) => n.id === key)) throw new Error('That node is not in the research.');
    this.researchWriteNote(id, `view:${key}`, text);
  }

  /** A research at the project's root, or in one of its folders (`dir`, relative). */
  async researchCreate(projectId: string, title: string, goal: string, sample: boolean, dir?: string): Promise<ResearchDoc> {
    const d = dir?.trim().replace(/^\.\/+|\/+$/g, '');
    if (d && !isResearchDir(d)) throw new Error(`Not a folder in the project: ${dir}`);
    const id = researchId(projectId, d || undefined);
    const used = this.researchSummaries().map((r) => (r.color != null ? r.color : RESEARCH_COLORS.indexOf(researchColor(r) as (typeof RESEARCH_COLORS)[number])));
    const created = await this.researchFiles.create(id, title, goal, sample, this.language());
    const doc = { ...created, color: nextResearchColor(used) };
    this.researchFiles.saveDoc(id, doc);
    this.researchIds.delete(projectId);
    this.indexResearch(id, doc);
    return doc;
  }

  snapshot(): WorkspaceSnapshot {
    this.stampStatus();
    const d = this.store.data;
    return {
      research: this.researchSummaries().map((r) => {
        const atRoot = this.researchAgentsAtRoot(r.id).length;
        return atRoot ? { ...r, atRoot } : r;
      }),
      projects: d.projects,
      tasks: d.tasks,
      sessions: d.sessions,
      // A research agent's request its lead is deciding is the lead's for now, not the user's.
      attention: d.attention.filter((a) => !(a.state === 'open' && a.delegatedTo)),
      memory: d.memory,
      memorySync: { running: this.memSync.running, last: d.memorySync },
      memoryShare: Object.fromEntries(Object.entries(d.settings.memoryLinks ?? {}).map(([h, l]) => [h, { ...l, ...this.shareResults.get(h), paused: this.writeback.targets(h).filter((t) => t.paused).map((t) => ({ kind: t.kind, why: t.paused! })) }])),
      coordinator: d.coordinator.slice(-50),
      capabilities: this.capabilities,
      remoteHosts: this.enabledHosts().map((host) => this.hostStatus.get(host) ?? { host, ssh: 'checking', capabilities: [] }),
      settings: d.settings,
      voice: {
        sttAvailable: this.sttReady(),
        routerLlmAvailable: !!this.opts.openai,
        sttModel: this.localModelId() ? d.settings.sttModel : this.opts.openai?.sttModel,
        routerModel: this.opts.openai?.routerModel,
        // Meeting-style: the mic is open from launch unless disabled (tests, kiosk use).
        autoListen: this.sttReady() && process.env.AMW_NO_AUTOLISTEN !== '1' && d.settings.autoListen,
        cloudAvailable: !!this.opts.openai,
        openaiKey: this.keyInfo,
        localModels: this.opts.localStt?.states() ?? [],
      },
      dataDir: this.opts.dataDir,
      main: d.mainAgent,
      demo: !!this.opts.demo,
      connectedTaskIds: [...this.live.keys()],
      remoteControl: Object.fromEntries(this.liveRemote().flatMap(([id, r]) => (r.url ? [[id, r.url]] : []))),
      codexRemote: Object.fromEntries(this.liveRemote().flatMap(([id, r]) => (r.codex ? [[id, r.codex]] : []))),
      // Read from the cached groupings only: nothing is asked of a model to fill it.
      limits: d.limits ?? {},
      workTitles: Object.fromEntries(Object.entries(d.sessionMaps ?? {}).flatMap(([id, g]) => (g.version === GROUPING_VERSION && g.tasks.length ? [[id, g.tasks.at(-1)!.title]] : []))),
    };
  }

  transcript(taskId: string): TranscriptItem[] {
    return this.store.transcript(taskId);
  }

  // ---------------------------------------------------------------- projects

  async addProject(rootPath: string, name?: string, host?: string): Promise<Project> {
    if (host) return this.addRemoteProject(host, rootPath, name);
    const path = resolve(rootPath);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
    const root = (await gitRoot(path)) ?? path;
    const existing = this.store.data.projects.find((p) => !p.host && p.rootPath === root);
    if (existing) return existing;
    const project: Project = {
      projectId: `p-${randomUUID().slice(0, 8)}`,
      name: name?.trim() || basename(root),
      rootPath: root,
      isGitRepo: !!(await gitRoot(root)),
      createdAt: now(),
    };
    this.store.data.projects.push(project);
    this.changed();
    return project;
  }

  /** A folder on an SSH host; agents there run that host's own CLI (Codex for now). */
  private async addRemoteProject(host: string, rootPath: string, name?: string): Promise<Project> {
    this.requireHost(host);
    const path = rootPath.trim().replace(/\/+$/, '') || '/';
    if (!path.startsWith('/') && path !== '~' && !path.startsWith('~/')) throw new Error(`Use an absolute path on ${host} (or one starting with ~/).`);
    const dir = path === '~' ? '~' : path.startsWith('~/') ? `~/${shq(path.slice(2))}` : shq(path);
    // Markers: a login shell may print a banner before our output.
    const r = await sshRun(host, `cd ${dir} && printf '__AMW_DIR__%s\\n' "$(pwd -P)" && printf '__AMW_GIT__%s\\n' "$(git rev-parse --show-toplevel 2>/dev/null)"`);
    if (r.code === 255) throw new Error(sshError(host, r.stderr));
    const found = /__AMW_DIR__(.*)/.exec(r.stdout)?.[1]?.trim();
    if (r.code !== 0 || !found) throw new Error(`Not a directory on ${host}: ${path}`);
    const git = /__AMW_GIT__(.*)/.exec(r.stdout)?.[1]?.trim();
    const root = git || found;
    const existing = this.store.data.projects.find((p) => p.host === host && p.rootPath === root);
    if (existing) return existing;
    const project: Project = {
      projectId: `p-${randomUUID().slice(0, 8)}`,
      name: name?.trim() || basename(root),
      rootPath: root,
      host,
      isGitRepo: !!git,
      createdAt: now(),
    };
    this.store.data.projects.push(project);
    this.changed();
    return project;
  }

  sshHosts(): SshHostEntry[] {
    return sshHostEntries();
  }

  // ---------------------------------------------------------------- tasks

  /** A worker task, or the main agent. */
  private findTask(taskId: string): Task | undefined {
    const d = this.store.data;
    return d.tasks.find((x) => x.taskId === taskId) ?? (d.mainAgent?.taskId === taskId ? d.mainAgent : undefined);
  }

  private task(taskId: string): Task {
    const t = this.findTask(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    return t;
  }

  private project(projectId: string): Project {
    const p = this.store.data.projects.find((x) => x.projectId === projectId);
    if (!p) throw new Error(`Unknown project ${projectId}`);
    return p;
  }

  /** A new agent's id and alias, taken when its caller first needs them (create names a worktree after the id). */
  private newTaskIds(): { taskId: string; alias: string } {
    const d = this.store.data;
    const alias = aliasFor(d.aliasCounter++, d.settings.language);
    return { taskId: `t-${randomUUID().slice(0, 8)}`, alias };
  }

  /**
   * Adds a new agent, and the session record of the saved conversation it continues, if any. Create,
   * import and fork all come through here, so aliases, session records and shared-folder warnings stay
   * the same for each; what differs between them is passed in. The caller saves (`changed`) once it
   * has said what it needs to.
   */
  private addTask(
    ids: { taskId: string; alias: string },
    o: {
      projectId: string;
      provider: AgentProvider;
      host?: string;
      cwd: string;
      worktree?: Task['worktree'];
      name: string;
      nameSource?: Task['nameSource'];
      title: string;
      status: Task['status'];
      summary: string;
      /** The saved conversation it continues; none for an agent that starts fresh. */
      session?: { nativeSessionId: string; integrationMode: SessionRecord['integrationMode'] };
      /** Why it edits a folder it did not ask to share (no worktree); a sharer's warning replaces it, as the larger risk. */
      cwdWarning?: string;
      /** An imported session keeps the folder it was started in, and is warned about sharing in those words. */
      keepsOriginalFolder?: boolean;
      /** Names an unnamed agent after its work (create and import); a fork takes its name from the original. */
      label?: { title: string; instruction?: string; refine?: boolean };
      permissionMode?: PermissionMode;
      forkedFrom?: Task['forkedFrom'];
      mockScript?: string;
    },
  ): Task {
    const d = this.store.data;
    const { taskId, alias } = ids;
    const record: SessionRecord | undefined = o.session && {
      localId: `s-${randomUUID().slice(0, 8)}`,
      taskId,
      provider: o.provider,
      nativeSessionId: o.session.nativeSessionId,
      cwd: o.cwd,
      integrationMode: o.session.integrationMode,
      createdAt: now(),
    };
    const task: Task = {
      taskId,
      alias,
      name: o.name,
      nameSource: o.nameSource,
      projectId: o.projectId,
      title: o.title,
      provider: o.provider,
      status: o.status,
      summary: o.summary,
      cwd: o.cwd,
      host: o.host,
      worktree: o.worktree,
      cwdNote: o.cwdWarning,
      keptOriginalFolder: o.keepsOriginalFolder || undefined,
      sessionLocalId: record?.localId,
      permissionMode: o.permissionMode,
      forkedFrom: o.forkedFrom,
      mockScript: o.mockScript,
      createdAt: now(),
      updatedAt: now(),
    };
    if (record) d.sessions.push(record);
    d.tasks.push(task);
    this.refreshSharedFolders();
    if (o.label) this.autoLabel(task, o.label.title, o.label.instruction, { refine: o.label.refine });
    return task;
  }

  async createTask(args: {
    projectId: string;
    provider: AgentProvider;
    /** What the task is; empty when the user starts an agent without saying yet (its first message says). */
    title?: string;
    /** Who chose `name` (default: the user, who typed it). */
    nameSource?: 'auto' | 'user';
    name?: string;
    instruction?: string;
    isolate: boolean;
    mockScript?: string;
    /** A research's lead or an aspect's agent (Task.researchManager). */
    researchManager?: boolean;
    /** A folder of the project to work in (a research kept in a folder: its agents work there, with their own CLI memory). */
    subdir?: string;
    /** Started by a research (Task.researchAgent). */
    researchAgent?: boolean;
    /** Images that go with the first instruction (the main agent passing on the user's). */
    images?: ImageRef[];
  }): Promise<Task> {
    const project = this.project(args.projectId);
    if (!this.opts.adapters[args.provider]) throw new Error(`Provider ${args.provider} is not available.`);
    if (project.host) this.requireOnHost(args.provider, project.host);
    const ids = this.newTaskIds();
    const { taskId } = ids;
    if (args.subdir && !isResearchDir(args.subdir)) throw new Error(`Not a folder of the project: ${args.subdir}`);
    const at = (base: string, sub?: string) => (!sub ? base : project.host ? `${base.replace(/\/+$/, '')}/${sub}` : join(base, sub));
    // Where it works: the project's folder, or one of its folders (a research's); isolated, a worktree of the
    // repository that folder is in (the project's own, or one inside it), here or on the project's host.
    const target = at(project.rootPath, args.subdir);
    let cwd = target;
    let worktree: Task['worktree'];
    let sharedCwdWarning: string | undefined;
    if (args.isolate) {
      const slug = `${slugify(args.name || args.title || args.instruction?.slice(0, 60) || 'agent')}-${taskId.slice(2)}`;
      try {
        const repo = await repoOf(project.host, target);
        if (repo) {
          worktree = project.host ? await this.worktrees.createRemote(project.host, repo.root, slug) : await this.worktrees.create(repo.root, project.projectId, slug);
          cwd = at(worktree.path, repo.prefix || undefined);
        }
      } catch (error) {
        sharedCwdWarning = `Worktree not created (${(error as Error).message}); this task edits ${cwd}${project.host ? ` on ${project.host}` : ''} directly.`;
      }
    }
    const title = (args.title ?? '').trim() || (args.instruction ?? '').trim().slice(0, 80);
    const task = this.addTask(ids, {
      projectId: project.projectId,
      provider: args.provider,
      host: project.host,
      cwd,
      worktree,
      name: args.name?.trim() || ids.alias,
      nameSource: args.name?.trim() ? (args.nameSource ?? 'user') : 'auto',
      title,
      status: 'idle',
      summary: 'Not started yet.',
      cwdWarning: sharedCwdWarning,
      label: !args.name?.trim() && title ? { title: args.title ?? '', instruction: args.instruction } : undefined,
      mockScript: args.mockScript,
    });
    if (args.researchManager) task.researchManager = true;
    if (args.researchAgent || args.researchManager) task.researchAgent = true;
    this.changed();
    if (args.instruction?.trim()) {
      const r = await this.send(taskId, args.instruction, 'initial', { images: args.images });
      if (!r.ok) throw new Error(r.error);
    }
    return task;
  }

  /** Shows an imported session's past conversation right away, before anything is resumed. */
  /** Shows a saved conversation before it is resumed, and returns it (undefined when it could not be read). */
  private async previewHistory(task: Task, provider: AgentProvider, nativeSessionId: string): Promise<TranscriptItem[] | undefined> {
    const adapter = this.opts.adapters[provider];
    if (!adapter?.readHistory) return undefined;
    try {
      const events = await adapter.readHistory(nativeSessionId, task.cwd, task.host);
      if (this.live.has(task.taskId) || !this.store.data.tasks.includes(task)) return undefined; // resumed meanwhile, or removed
      const items: TranscriptItem[] = [];
      for (const e of events) {
        if (e.type !== 'transcriptItem') continue;
        const copied = copiedItems(task.taskId, e);
        if (copied) {
          items.push(...copied);
          continue;
        }
        const i = items.findIndex((h) => h.id === e.itemId);
        const item = mergeItem(i === -1 ? undefined : items[i], { id: e.itemId, taskId: task.taskId, role: e.role, text: e.text, toolLabel: e.toolLabel, toolStatus: e.toolStatus, createdAt: now() }, e.tool);
        if (i === -1) items.push(item);
        else items[i] = item;
      }
      if (!items.length) return items;
      // A preview: long sessions show their latest part; resuming restores everything.
      this.store.setTranscript(task.taskId, items.slice(-400));
      for (const cb of this.transcriptListeners) cb(task.taskId, null);
      const last = [...items].reverse().find((x) => x.role === 'assistant' && x.text.trim());
      if (last) task.summary = summaryFor(last.text);
      this.changed();
      return items;
    } catch (error) {
      this.log('history preview failed', provider, error);
      return undefined;
    }
  }

  /**
   * Gives an unnamed agent a label for its work: its title, shortened, now; then, unless `refine` is
   * false, a model's label from the title and instruction. A name the user sets always wins.
   */
  private autoLabel(task: Task, title: string, instruction = '', opts: { refine?: boolean } = {}): void {
    const stopgap = titleLabel(title, labelLang(task.alias)) ?? titleLabel(instruction, labelLang(task.alias));
    if (stopgap) task.name = stopgap;
    task.nameSource = 'auto';
    if (opts.refine !== false) void this.refineLabel(task, `${title}\n${instruction}`.trim());
  }

  /** Replaces an automatic label with a model's label for `text`, unless the name changed meanwhile. */
  private refineLabel(task: Task, text: string): Promise<boolean> {
    if (!text.trim() || this.opts.demo) return Promise.resolve(false);
    // No model to ask yet (the CLIs are still being detected right after launch, or signed out): the
    // stopgap stays for now and is marked, so detecting them (or opening the agent) names it then.
    if (!this.canLabel()) {
      task.labelStale = true;
      return Promise.resolve(false);
    }
    const lang = labelLang(task.alias);
    const auto = task.name;
    const project = this.store.data.projects.find((p) => p.projectId === task.projectId)?.name;
    return this.suggestLabel(project ? `Project (do not repeat it): ${project}\n${text}` : text, lang)
      .then((label) => {
        const t = this.store.data.tasks.find((x) => x.taskId === task.taskId);
        if (!t || t.name !== auto || t.nameSource === 'user') return false;
        // Nothing usable came back: keep the stopgap, marked for a later try.
        if (!label) {
          t.labelStale = true;
          return false;
        }
        t.name = label;
        t.nameSource = 'auto';
        t.labelStale = undefined;
        t.labelAt = now();
        t.saidSinceLabel = 0;
        this.changed();
        return true;
      })
      .catch((error) => {
        this.log('label suggestion failed', error);
        const t = this.store.data.tasks.find((x) => x.taskId === task.taskId);
        if (t && t.nameSource !== 'user' && t.name === auto) t.labelStale = true;
        return false;
      });
  }

  /**
   * A few words for one of the user's long messages to the main agent (its lanes show them),
   * from the user's own CLI in the background, kept so each message is asked about once.
   * Undefined when no model can answer (the lanes show the message, shortened).
   */
  async shortLabel(text: string): Promise<string | undefined> {
    const key = text.trim().slice(0, 2000);
    const kept = this.store.data.shortLabels?.[key];
    if (kept) return kept;
    if (this.opts.demo) return undefined;
    const lang = this.store.data.settings.language === 'zh' ? 'zh' : 'en';
    const label = await this.suggestLabel(key, lang).catch(() => undefined);
    if (!label) return undefined;
    const all = { ...(this.store.data.shortLabels ?? {}), [key]: label };
    // Bounded: the oldest go first.
    const keys = Object.keys(all);
    this.store.data.shortLabels = keys.length > 500 ? Object.fromEntries(keys.slice(-500).map((k) => [k, all[k]])) : all;
    this.store.save();
    return label;
  }

  /** A label from the user's own Claude Code or Codex (no extra key), else OpenAI when configured. */
  private async suggestLabel(text: string, lang: 'en' | 'zh'): Promise<string | undefined> {
    const ask = this.backgroundAsk();
    if (ask) {
      try {
        const prompt = labelRequest(text);
        const first = await ask(labelPrompt(lang), prompt);
        const label = cleanLabel(first, lang);
        if (label) return label;
        const second = cleanLabel(await ask(labelPrompt(lang), `${prompt}\n\n${labelRetry(lang, first)}`), lang);
        if (second) return second;
      } catch (error) {
        this.log('background label failed', error);
      }
    }
    const ai = this.opts.openai;
    return ai ? cleanLabel(await ai.suggestLabel(text, lang), lang) : undefined;
  }

  /**
   * One-shot answers for background jobs from the user's own CLI, one at a time: the main agent's
   * provider first, then any installed and signed-in one. Undefined when none can answer.
   */
  private backgroundAsk(): ((system: string, prompt: string) => Promise<string>) | undefined {
    const model = this.opts.backgroundModel;
    if (model) return (system, prompt) => this.serial(() => model(system, prompt));
    const setting = this.store.data.settings.mainAgent;
    const order: Array<'claude' | 'codex'> = setting === 'claude' || setting === 'codex' ? [setting, setting === 'claude' ? 'codex' : 'claude'] : ['claude', 'codex'];
    const adapter = order.map((p) => (this.providerReady(p) ? this.opts.adapters[p] : undefined)).find((a) => a?.oneShot);
    if (!adapter?.oneShot) return undefined;
    return (system, prompt) => this.serial(() => adapter.oneShot!(system, prompt));
  }

  private backgroundQueue: Promise<unknown> = Promise.resolve();

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const result = this.backgroundQueue.then(job);
    this.backgroundQueue = result.catch(() => {});
    return result;
  }

  permissionModeOf(task: Task): PermissionMode {
    return task.permissionMode ?? this.store.data.settings.permissionMode ?? 'auto';
  }

  /** Changes one agent's permission mode; a live session switches without restarting. */
  async setPermissionMode(taskId: string, mode: PermissionMode): Promise<void> {
    const t = this.task(taskId);
    t.permissionMode = mode;
    t.updatedAt = now();
    this.changed();
    await this.live.get(taskId)?.session.setPermissionMode?.(mode);
  }

  // ---------------------------------------------------------------- session map

  /**
   * The session's turns grouped into tasks, with titles, by a model (the background labeller): which
   * turns worked toward one goal is a judgement about meaning. Cached per agent with the number of
   * turns it covers; asked again only when there are new turns. Null with no model at hand (the map
   * then groups by structure).
   */
  async sessionMapGrouping(taskId: string): Promise<MapGrouping | null> {
    const items = this.store.transcript(taskId);
    const turns = turnsOf(items).length;
    const cache = (this.store.data.sessionMaps ??= {});
    const cached = cache[taskId] as MapGrouping | undefined;
    const current = cached?.version === GROUPING_VERSION ? cached : undefined;
    if (!turns) return null;
    if (current && current.turns === turns) return current;
    if (!this.canLabel()) return current ?? null;
    const ask = this.backgroundAsk();
    if (!ask) return current ?? null;
    const pending = this.mapAsks.get(taskId);
    if (pending) return pending;
    const job = (async () => {
      try {
        // Few new turns: only the latest task is looked at again (earlier ones stay as they were);
        // many, or none cached yet: the whole session.
        const last = current?.tasks.at(-1);
        let grouping: MapGrouping | null;
        if (current && last && turns - current.turns <= 15) {
          const note = GROUPING_UPDATE_NOTE(last.start, current.tasks.slice(0, -1).map((t) => t.title));
          const fresh = parseGrouping(await ask(GROUPING_PROMPT, `${note}\n\n${turnsDigest(items, last.start)}`), turns, last.start);
          grouping = fresh ? mergeGrouping(current, fresh) : null;
        } else grouping = parseGrouping(await ask(GROUPING_PROMPT, turnsDigest(items)), turns);
        if (grouping) {
          cache[taskId] = grouping;
          // Its last task's title is what the sidebar and header show for the agent: send a new snapshot.
          this.changed();
        }
        return grouping ?? current ?? null;
      } catch (error) {
        this.log('session map grouping failed', error);
        return current ?? null;
      } finally {
        this.mapAsks.delete(taskId);
      }
    })();
    this.mapAsks.set(taskId, job);
    return job;
  }

  private mapAsks = new Map<string, Promise<MapGrouping | null>>();

  // ---------------------------------------------------------------- side questions ("btw")

  /** This agent's side questions, oldest first. */
  btwList(taskId: string): BtwEntry[] {
    return this.store.data.btw?.[taskId] ?? [];
  }

  /**
   * Asks the agent a side question: answered from its conversation so far (Claude Code's side
   * questions; a read-only side thread in Codex), never entering that conversation or interrupting a
   * turn under way. Starts its session if needed. Resolves with the entry, answered or failed.
   */
  async askBtw(taskId: string, question: string): Promise<BtwEntry> {
    const task = this.task(taskId);
    const all = (this.store.data.btw ??= {});
    const list = (all[taskId] ??= []);
    const entry: BtwEntry = { id: `b-${randomUUID().slice(0, 8)}`, question: question.trim(), askedAt: now() };
    const history = list.filter((e) => e.answer).map((e) => ({ question: e.question, response: e.answer! }));
    list.push(entry);
    all[taskId] = list.slice(-20);
    this.store.save();
    try {
      const live = this.live.get(taskId) ?? (await this.connect(taskId));
      if (!live.session.askSide) throw new Error(`${providerName(task.provider)} does not take side questions.`);
      entry.answer = await live.session.askSide(entry.question, history);
    } catch (error) {
      entry.error = (error as Error).message;
    }
    entry.answeredAt = now();
    this.store.save();
    return entry;
  }

  clearBtw(taskId: string): void {
    if (this.store.data.btw) delete this.store.data.btw[taskId];
    this.store.save();
  }

  /** The user did something with this agent: it moves up in the sidebar (and is no longer set aside). */
  private touched(t: Task): void {
    t.lastUserActivityAt = now();
    t.setAside = undefined;
    // An old role name: label the work now that it is in use again.
    if (t.labelStale) this.relabelFromHistory(t);
  }

  /**
   * The user opened this agent's view. Looking is not working with it, so the order stays as it is
   * (a click must not reshuffle the list under the pointer); an old name is relabelled now, though.
   */
  /**
   * Set aside (or back): out of the Overview and folded into its team's idle row until it works,
   * asks, fails or is messaged. Nothing is stopped; it is about what the user is paying attention to.
   */
  setAside(taskId: string, on: boolean): void {
    const t = this.task(taskId);
    if (this.store.data.mainAgent?.taskId === taskId) throw new Error('The main agent cannot be set aside.');
    t.setAside = on || undefined;
    this.changed();
  }

  markViewed(taskId: string): void {
    const t = this.findTask(taskId);
    if (t?.labelStale) this.relabelFromHistory(t);
    // Seen: its result is no longer new (the dot turns grey). It stays where it is; seeing is not setting aside.
    if (t?.unread) {
      t.unread = undefined;
      this.changed();
    }
  }

  rename(taskId: string, name: string): void {
    const t = this.task(taskId);
    this.touched(t);
    t.name = name.trim() || t.alias;
    // Cleared, the name is the app's to choose again.
    t.nameSource = name.trim() ? 'user' : 'auto';
    t.labelStale = undefined;
    t.updatedAt = now();
    this.changed();
  }

  /**
   * The agent's name (its alias, the handle the user says or types). One agent per name, case
   * apart, and none of the router's words. What was already said under the old name stays as it was.
   */
  renameAgent(taskId: string, alias: string): void {
    const t = this.task(taskId);
    if (taskId.startsWith('t-main-')) throw new Error('The main agent keeps its name.');
    const next = normalizeAlias(alias);
    const problem = aliasProblem(next, this.store.data.tasks, taskId);
    if (problem) throw new Error(ALIAS_PROBLEM_TEXT[problem]);
    const before = t.alias;
    if (next === before) return;
    // No label of its own yet: its name was the label, and follows.
    if (t.name === before) t.name = next;
    t.alias = next;
    // Forks name where they came from by the name it has now.
    for (const o of this.store.data.tasks) if (o.forkedFrom?.taskId === taskId) o.forkedFrom = { ...o.forkedFrom, alias: next };
    this.touched(t);
    t.updatedAt = now();
    this.changed();
  }

  renameProject(projectId: string, name: string): Project {
    const p = this.project(projectId);
    const next = name.replace(/\s+/g, ' ').trim();
    if (!next) throw new Error('A project name cannot be empty.');
    if (next === p.name) return p;
    p.name = next.slice(0, 200);
    this.changed();
    return p;
  }

  async remove(taskId: string): Promise<string> {
    const t = this.task(taskId);
    await this.stop(taskId);
    let note = 'Task removed.';
    if (t.worktree) {
      const r = await this.worktrees.removeIfClean(t.worktree);
      note = r.removed ? 'Task removed; its clean worktree was deleted.' : `Task removed; worktree kept at ${t.worktree.path} because ${r.reason}.`;
    }
    const d = this.store.data;
    d.tasks = d.tasks.filter((x) => x.taskId !== taskId);
    this.refreshSharedFolders();
    d.attention = d.attention.filter((a) => a.taskId !== taskId);
    d.memory = d.memory.filter((m) => !(m.scope === 'task' && m.scopeId === taskId));
    if (d.carried) delete d.carried[taskId];
    this.coordinatorSay(note);
    this.changed();
    return note;
  }

  // ---------------------------------------------------------------- sessions

  private currentSession(task: Task): SessionRecord | undefined {
    return this.store.data.sessions.find((s) => s.localId === task.sessionLocalId);
  }

  /**
   * Connects the task to its provider: resumes the recorded native session, or creates one.
   * Anything but a background connect is a use of the session: a warm one stops being quiet.
   */
  private connect(taskId: string, background = false): Promise<LiveSession> {
    const existing = this.live.get(taskId);
    if (existing) return Promise.resolve(background ? existing : this.claim(taskId, existing));
    const pending = this.connecting.get(taskId);
    if (pending) {
      if (background) return pending;
      // A background connect that fails says nothing; asked for by the user, try again out loud.
      const quiet = this.warming.has(taskId);
      return pending.then(
        (l) => this.claim(taskId, l),
        (error) => (quiet ? this.connect(taskId) : Promise.reject(error)),
      );
    }
    if (background) this.warming.add(taskId);
    const p = this.doConnect(taskId, background).finally(() => {
      this.connecting.delete(taskId);
      this.warming.delete(taskId);
    });
    this.connecting.set(taskId, p);
    return background ? p : p.then((l) => this.claim(taskId, l));
  }

  /** A session connected in the background is being used: from now on it is like any other. */
  private claim(taskId: string, live: LiveSession): LiveSession {
    if (!live.warm) return live;
    live.warm = undefined;
    if (live.resumeNote) this.appendSystem(taskId, live.resumeNote);
    live.resumeNote = undefined;
    return live;
  }

  /**
   * The user opened this agent's page: connect it now, in the background, so the first message
   * does not wait for the session to start. Opening is not using: the agent keeps its place, its
   * set-aside flag, unread mark, summary and status, and a failure stays quiet (sending surfaces it).
   * Only sessions there is something to resume; not the main agent (its chapters start their own
   * sessions) nor agents on other hosts (a remote process is not cheap to start on a whim).
   */
  warm(taskId: string): void {
    const t = this.findTask(taskId);
    if (!t || t === this.store.data.mainAgent || t.host || this.live.has(taskId) || this.connecting.has(taskId)) return;
    if (!this.opts.adapters[t.provider] || !this.currentSession(t)?.nativeSessionId) return;
    void this.connect(taskId, true).catch((error) => this.log('background connect failed', taskId, error));
  }

  private async doConnect(taskId: string, background = false): Promise<LiveSession> {
    const task = this.task(taskId);
    const adapter = this.opts.adapters[task.provider];
    if (!adapter) throw new Error(`Provider ${task.provider} is not available.`);
    const prev = this.currentSession(task);
    // What a background connect leaves as it found it, whatever start-up does.
    const before = background ? { status: task.status, summary: task.summary, lastError: task.lastError, updatedAt: task.updatedAt } : undefined;
    const resumeId = prev?.nativeSessionId || undefined;
    const record: SessionRecord = {
      localId: `s-${randomUUID().slice(0, 8)}`,
      taskId,
      provider: task.provider,
      nativeSessionId: resumeId ?? '',
      cwd: task.cwd,
      integrationMode: resumeId ? 'resumed' : 'managed',
      createdAt: now(),
    };
    this.store.data.sessions.push(record);
    task.sessionLocalId = record.localId;
    if (!before) {
      task.status = 'starting';
      task.lastError = undefined;
    }
    const injected = this.memoryGiven(task);
    task.injectedMemoryIds = injected.map((m) => m.id);
    task.memorySeen = seenOf(injected);
    this.changed();

    const isMain = task === this.store.data.mainAgent;
    const skills = isMain ? undefined : await this.skillsFor(task);
    // Its project's researches are known before it starts (a host's are listed first), so it gets their tools.
    if (!isMain) await this.researchFiles.listed(task.projectId).catch(() => {});
    const inResearch = !isMain && this.researchSummaries().some((r) => r.projectId === task.projectId);
    // A research's lead and aspect agents hand work out through the research (research_try: agents the page shows
    // and the user can talk to), so they go without the CLI's own hidden sub-agents.
    // (Known from how it was started, or, for a conversation attached later, from its place in the tree.)
    const manages = inResearch && (!!task.researchManager || this.researchSummaries().some((r) => r.projectId === task.projectId && ['lead', 'aspect'].includes(this.researchRole(r.id, task.taskId))));
    // Its place in a research and how it works there, with every connect (an attached conversation never had a brief).
    const place = isMain ? undefined : this.researchPlace(task);
    const doc = place ? this.researchGet(place.id) : null;
    const roleText = place && doc ? roleInstructions(doc, place.role, task.taskId, this.language(), this.researchNotes(place.id)) : undefined;
    const history: TranscriptItem[] = [];
    let replaying = true;
    const session = adapter.createSession(
      {
        cwd: task.cwd,
        host: task.host,
        title: task.title,
        resumeNativeSessionId: resumeId,
        // The main agent gets its role and the workspace tools; it never edits code itself.
        developerInstructions: isMain ? [MAIN_AGENT_PROMPT, instructionsFor(task, injected)].filter(Boolean).join('\n\n') : [roleText, instructionsFor(task, injected)].filter(Boolean).join('\n\n') || undefined,
        mockScript: task.mockScript,
        model: task.model,
        permissionMode: isMain ? 'ask' : this.permissionModeOf(task),
        tools: isMain ? [...workspaceTools(this), ...researchTools(this, { kind: 'main' })] : undefined,
        // In a project with a research, any agent may read the tree; what it may change is decided per call (its place in it).
        extraTools: inResearch ? researchTools(this, { kind: 'agent', taskId: task.taskId }) : undefined,
        ...(manages ? { disallowedTools: ['Agent', 'Task'] } : {}),
        // The tree, notes and views are changed through the research tools, never by editing the files; and a
        // research's agents never write the CLI's own memory (kept by folder, read by every session there):
        // what holds for the research goes in its memory (research_memory).
        // Folders its research works in besides its own (scratch space on another disk).
        ...(place && doc?.policy?.extraDirs?.length ? { additionalDirectories: doc.policy.extraDirs } : {}),
        ...(inResearch ? { denyEdit: ['**/.research/**', ...(task.researchAgent || manages || this.inAnyResearch(task.taskId) ? ['~/.claude/projects/**/memory/**', '~/.claude/**/CLAUDE.md', '~/.codex/**'] : [])] } : {}),
        skills,
        // As the interactive CLI has them (each use still asks first). The browser is the user's own
        // Chrome, on this Mac; the main agent only coordinates.
        chrome: !isMain && !task.host,
        artifacts: !isMain,
      },
      (event) => {
        if (replaying && event.type === 'transcriptItem' && event.history) {
          const copied = copiedItems(taskId, event);
          if (copied) {
            for (const c of copied) if (!history.some((h) => h.id === c.id)) history.push(c);
            return;
          }
          const prev = history.findIndex((h) => h.id === event.itemId);
          const images = this.historyImages(event.images, task.host);
          const item = mergeItem(prev === -1 ? undefined : history[prev], { id: event.itemId, taskId, role: event.role, text: event.text, ...(images ? { images } : {}), toolLabel: event.toolLabel, toolStatus: event.toolStatus, createdAt: now() }, event.tool);
          if (prev === -1) history.push(item);
          else history[prev] = item;
          return;
        }
        this.handleEvent(taskId, record.localId, event);
      },
    );
    const live: LiveSession = { localId: record.localId, session, turnActive: false, lastUsed: Date.now(), ...(before ? { warm: { status: before.status } } : {}), ...(place ? { role: `${place.id}:${place.role}` } : {}) };
    this.live.set(taskId, live);
    try {
      await session.start();
    } catch (error) {
      this.live.delete(taskId);
      if (before) {
        // Nothing the user asked for failed: no error, no attention; the agent is as it was.
        this.store.data.sessions = this.store.data.sessions.filter((s) => s !== record);
        task.sessionLocalId = prev?.localId;
        Object.assign(task, before);
        this.changed();
        throw error;
      }
      const message = (error as Error).message;
      task.lastError = message;
      if (this.connectionLost(task, message)) {
        // The host is out of reach for now: tried again by itself, no error to dismiss.
        this.scheduleReconnect(task, false);
        this.changed();
        throw error;
      }
      task.status = 'failed';
      task.summary = `Could not ${resumeId ? 'resume' : 'start'} the ${providerName(task.provider)} session: ${clip(message, 140)}`;
      if (!this.trouble(task, 'failed', message)) this.addAttention({ taskId, kind: 'error', headline: task.summary, details: message });
      this.changed();
      throw error;
    } finally {
      replaying = false;
    }
    const note = history.length ? `Resumed native ${task.provider} session ${record.nativeSessionId} (${history.length} items restored).` : resumeId ? `Resumed native ${task.provider} session ${resumeId}.` : undefined;
    // The native session is authoritative for history; replace the display cache with it.
    if (history.length) {
      this.store.setTranscript(taskId, [...history, ...(note && !before ? [{ id: `sys-${randomUUID()}`, taskId, role: 'system' as const, text: note, createdAt: now() }] : [])]);
      for (const cb of this.transcriptListeners) cb(taskId, null);
    } else if (note && !before) {
      this.appendSystem(taskId, note);
    }
    if (before) {
      // Only "Not connected" is no longer true; a failure, a report or a question stays as it was.
      live.resumeNote = note;
      task.updatedAt = before.updatedAt;
      if (task.status === 'disconnected') task.status = 'idle';
      this.changed();
      return live;
    }
    // Connected by the user's hand: no longer waiting to be reconnected.
    this.dropReconnect(taskId);
    this.resolveConnectionErrors(taskId);
    if (task.status === 'starting') task.status = 'idle';
    task.summary = resumeId ? 'Session resumed with its previous conversation.' : task.summary;
    this.changed();
    return live;
  }

  async resume(taskId: string): Promise<void> {
    await this.connect(taskId);
  }

  /**
   * Picks up what was said elsewhere meanwhile (a session the user went on with in the terminal or
   * another Claude Code / Codex app): the live session, which knows nothing of it, is closed quietly and the native session
   * resumed again in the background, which replays its history into the view. Like opening the page,
   * it changes nothing else about the agent. Not while it is working or waiting on the user.
   */
  async sync(taskId: string): Promise<void> {
    const t = this.task(taskId);
    if (t === this.store.data.mainAgent) throw new Error('The main agent has no session to sync.');
    if (!this.currentSession(t)?.nativeSessionId) throw new Error('This agent has no session to sync yet.');
    const l = this.live.get(taskId);
    if (this.connecting.has(taskId)) throw new Error('Still connecting; try again in a moment.');
    if (l && (l.turnActive || this.hasOpenNative(taskId))) throw new Error('Busy: sync when it has finished and nothing waits on you.');
    if (l) {
      this.live.delete(taskId);
      await l.session.close().catch(() => {});
    }
    await this.connect(taskId, true);
  }

  async stop(taskId: string): Promise<void> {
    this.cancelRetry(taskId);
    this.dropReconnect(taskId);
    const l = this.live.get(taskId);
    if (!l) return;
    this.live.delete(taskId);
    await l.session.close().catch(() => {});
    const t = this.findTask(taskId);
    if (t) {
      t.status = 'disconnected';
      t.summary = 'Stopped. Resume to continue the same native session.';
      this.expireNative(taskId, l.localId, 'Session stopped before this was answered.');
      this.changed();
    }
  }

  async interrupt(taskId: string): Promise<void> {
    const l = this.live.get(taskId);
    if (!l) throw new Error('This task is not connected.');
    if (this.cancelRetry(taskId)) {
      // Nothing runs between tries; stopping means not trying again.
      const task = this.task(taskId);
      task.status = 'idle';
      task.summary = 'Interrupted. Waiting for your next instruction.';
      this.appendSystem(taskId, 'Automatic retry cancelled.');
      this.changed();
      return;
    }
    await l.session.interrupt();
  }

  /**
   * Runs a failed turn again (the Retry button). The agent carries on from its own
   * history, so the instruction is not sent twice, and gets fresh automatic retries.
   */
  async retry(taskId: string): Promise<void> {
    const task = this.task(taskId);
    this.cancelRetry(taskId);
    const live = await this.connect(taskId);
    if (live.turnActive) return;
    this.appendSystem(taskId, 'Retrying the failed turn.');
    await live.session.send(CONTINUE_PROMPT);
    for (const a of this.store.data.attention) if (a.taskId === taskId && a.state === 'open' && a.retryable) this.closeAttention(a, 'resolved', 'Retried.');
    task.lastError = undefined;
    task.summary = 'Retrying the failed turn…';
    this.changed();
  }

  /**
   * Native sessions an agent in the workspace works on, so "Continue a session" does not offer
   * them twice. Only agents still here: a removed agent's session can be brought back.
   */
  private attachedSessionIds(): Set<string> {
    const here = new Set([...this.store.data.tasks.map((t) => t.taskId), ...(this.store.data.mainAgent ? [this.store.data.mainAgent.taskId] : [])]);
    return new Set(this.store.data.sessions.filter((s) => here.has(s.taskId) && s.nativeSessionId).map((s) => s.nativeSessionId));
  }

  async discoverSessions(projectId: string, provider: CodingProvider): Promise<NativeSessionInfo[]> {
    const adapter = this.opts.adapters[provider];
    if (!adapter) throw new Error(`Provider ${provider} is not available.`);
    const project = this.project(projectId);
    if (project.host && !adapter.remote) return [];
    const known = this.attachedSessionIds();
    const found = await adapter.discoverSessions({ cwd: project.rootPath, host: project.host });
    return found.filter((s) => !known.has(s.nativeSessionId));
  }

  /**
   * Recent Claude Code and Codex sessions saved on an SSH host (including those the
   * Claude and ChatGPT desktop apps created there through their SSH connections).
   */
  /**
   * The folders inside `dir` on this computer or on `host` (for typing a path with completion). `~` is the
   * home folder there. Returns the folder as resolved and its subfolders' names (dot-folders included;
   * the caller decides). A path that is not a folder gives no names.
   */
  /** Each agent folder's file list, kept briefly: an @-mention searches it on every keystroke. */
  private fileLists = new Map<string, { at: number; files: Promise<string[]> }>();

  /**
   * Files in an agent's folder (on its host) matching what is typed after @ in its message box. In a
   * git repository the files git knows (tracked and untracked, not ignored), otherwise a walk that
   * skips dependency and build folders; at most 50,000.
   */
  async searchFiles(taskId: string, query: string): Promise<FileMatch[]> {
    const task = this.task(taskId);
    const browse = browsePath(query);
    // The main agent has no folder of its own to search; it can still be given a file by its full path (~/ or /) to pass on.
    if (task === this.store.data.mainAgent) return browse && !browse.parent.startsWith('..') ? this.browseFiles(homedir(), undefined, browse.parent, browse.prefix) : [];
    if (browse) return this.browseFiles(task.cwd, task.host, browse.parent, browse.prefix);
    const key = `${task.host ?? ''}|${task.cwd}`;
    let entry = this.fileLists.get(key);
    if (!entry || Date.now() - entry.at > 15_000) {
      entry = { at: Date.now(), files: this.listFiles(task.cwd, task.host) };
      this.fileLists.set(key, entry);
      entry.files.catch(() => this.fileLists.delete(key));
    }
    // ./ is the agent's own folder, written explicitly: the same list, the paths kept as typed.
    if (query.startsWith('./')) return matchFiles(await entry.files, query.slice(2)).map((m) => ({ ...m, path: `./${m.path}` }));
    return matchFiles(await entry.files, query);
  }

  /**
   * Files dropped on an agent's message box, as @-mentions: relative to the agent's folder when
   * inside it, else from ~ or /, a folder ending in /. The agent reads them where it is, so an agent
   * on an SSH host (the files are on this computer) refuses. The main agent gets full paths, to pass on.
   */
  droppedFiles(taskId: string, paths: string[]): FileMatch[] {
    const task = this.task(taskId);
    const main = task === this.store.data.mainAgent;
    if (task.host) throw new Error(`These files are on this computer; ${task.alias} runs on ${task.host} and cannot read them. Copy them there, or mention a file on ${task.host} with @.`);
    const home = homedir();
    return paths.map((p) => {
      const abs = resolve(p);
      let dir = false;
      try {
        dir = statSync(abs).isDirectory();
      } catch {
        /* gone already: mentioned as a file */
      }
      const inside = main ? undefined : abs === task.cwd ? '.' : abs.startsWith(task.cwd + sep) ? abs.slice(task.cwd.length + 1) : undefined;
      const shown = inside ?? (abs === home || abs.startsWith(home + sep) ? `~${abs.slice(home.length)}` : abs);
      const path = shown.split(sep).join('/');
      return { path: dir && !path.endsWith('/') ? `${path}/` : path, dir };
    });
  }

  /**
   * A folder outside the agent's own, browsed one level at a time from what is typed after @
   * (../, /, ~/): its entries starting with `prefix`, folders first, written as typed (../lib/a.ts).
   * Hidden entries only when the prefix starts with a dot.
   */
  private async browseFiles(cwd: string, host: string | undefined, parent: string, prefix: string): Promise<FileMatch[]> {
    let entries: Array<{ name: string; dir: boolean }> = [];
    if (host) {
      this.requireHost(host);
      const script = `cd -- ${shq(cwd)} 2>/dev/null; d=${shq(parent)}; case "$d" in "~"|"~/"*) d="$HOME\${d#?}";; esac; cd -- "$d" 2>/dev/null || exit 3; ls -1Ap | head -2000`;
      const r = await sshRun(host, `sh -c ${shq(script)}`, 15_000);
      if (r.code === 3) return [];
      if (r.code !== 0) throw new Error(sshError(host, r.stderr));
      entries = r.stdout.split('\n').filter(Boolean).map((l) => ({ name: l.replace(/\/$/, ''), dir: l.endsWith('/') }));
    } else {
      const abs = parent.startsWith('~/') ? join(homedir(), parent.slice(2)) : resolve(cwd, parent);
      try {
        entries = readdirSync(abs, { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory() || (e.isSymbolicLink() && (() => { try { return statSync(join(abs, e.name)).isDirectory(); } catch { return false; } })()),
        }));
      } catch {
        return [];
      }
    }
    const want = prefix.toLowerCase();
    return entries
      .filter((e) => e.name.toLowerCase().startsWith(want) && (want.startsWith('.') || !e.name.startsWith('.')))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((e) => ({ path: `${parent}${e.name}${e.dir ? '/' : ''}`, dir: e.dir }));
  }

  private async listFiles(cwd: string, host?: string): Promise<string[]> {
    const MAX = 50_000;
    const SKIP = ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'target', '.cache'];
    if (host) {
      this.requireHost(host);
      const prune = SKIP.map((d) => `-name ${shq(d)}`).join(' -o ');
      const script = `cd -- ${shq(cwd)} || exit 3; if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then git ls-files -co --exclude-standard | head -${MAX}; else find . \\( ${prune} \\) -prune -o -type f -print 2>/dev/null | sed 's|^\\./||' | head -${MAX}; fi`;
      const r = await sshRun(host, `sh -c ${shq(script)}`, 20_000);
      if (r.code === 3) return [];
      if (r.code !== 0 && !r.stdout) throw new Error(sshError(host, r.stderr));
      return r.stdout.split('\n').filter(Boolean);
    }
    const git = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd, timeoutMs: 15_000 });
    if (git.code === 0) return git.stdout.split('\n').filter(Boolean).slice(0, MAX);
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      if (out.length >= MAX) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX) return;
        if (e.isDirectory()) {
          if (!SKIP.includes(e.name)) walk(join(dir, e.name), `${rel}${e.name}/`);
        } else if (e.isFile()) out.push(`${rel}${e.name}`);
      }
    };
    walk(cwd, '');
    return out;
  }

  async listDirs(dir: string, host?: string): Promise<{ dir: string; names: string[] }> {
    if (!host) {
      const home = homedir();
      const abs = resolve(dir === '~' || dir.startsWith('~/') ? home + dir.slice(1) : dir);
      try {
        const names = readdirSync(abs, { withFileTypes: true })
          .filter((e) => e.isDirectory() || (e.isSymbolicLink() && (() => { try { return statSync(join(abs, e.name)).isDirectory(); } catch { return false; } })()))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        return { dir: abs, names: names.slice(0, 500) };
      } catch {
        return { dir: abs, names: [] };
      }
    }
    this.requireHost(host);
    // On the machine: expand ~, list the subfolders (names ending in /), first line the folder as resolved.
    const script = `d=${shq(dir)}; case "$d" in "~"|"~/"*) d="$HOME\${d#?}";; esac; cd -- "$d" 2>/dev/null || exit 3; pwd; ls -1Ap | grep '/$' | head -500`;
    const r = await sshRun(host, `sh -c ${shq(script)}`, 15_000);
    if (r.code === 3) return { dir, names: [] };
    if (r.code !== 0) throw new Error(sshError(host, r.stderr));
    const [resolved, ...rest] = r.stdout.split('\n');
    return { dir: resolved.trim() || dir, names: rest.map((l) => l.replace(/\/$/, '')).filter(Boolean) };
  }

  /**
   * A project's folders a research can be kept in (one level down): which are repositories, which have one
   * already. For choosing where a new research goes; one round trip on a host.
   */
  async researchFolders(projectId: string): Promise<Array<{ name: string; git: boolean; research: boolean }>> {
    const p = this.project(projectId);
    if (!p.host) {
      try {
        return readdirSync(p.rootPath, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') && isResearchDir(e.name) && (e.isDirectory() || (e.isSymbolicLink() && (() => { try { return statSync(join(p.rootPath, e.name)).isDirectory(); } catch { return false; } })())))
          .map((e) => ({ name: e.name, git: existsSync(join(p.rootPath, e.name, '.git')), research: existsSync(join(p.rootPath, e.name, '.research', 'research.json')) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 500);
      } catch {
        return [];
      }
    }
    this.requireHost(p.host);
    const script = `cd ${shq(p.rootPath)} 2>/dev/null || exit 0; for d in */; do d="\${d%/}"; [ -d "$d" ] || continue; g=0; r=0; [ -e "$d/.git" ] && g=1; [ -f "$d/.research/research.json" ] && r=1; printf '%s\\t%s\\t%s\\n' "$g" "$r" "$d"; done | head -500`;
    const r = await sshRun(p.host, `sh -c ${shq(script)}`, 20_000);
    if (r.code !== 0) throw new Error(sshError(p.host, r.stderr));
    return r.stdout
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((x) => x.length === 3 && isResearchDir(x[2]))
      .map(([g, rs, name]) => ({ name, git: g === '1', research: rs === '1' }));
  }

  async discoverHostSessions(host: string): Promise<NativeSessionInfo[]> {
    this.requireHost(host);
    // Tests: the fixture's sessions on this host (see discoverAllSessions).
    if (process.env.AMW_DISCOVER_FIXTURE) return (JSON.parse(readFileSync(process.env.AMW_DISCOVER_FIXTURE, 'utf8')) as NativeSessionInfo[]).filter((s) => s.host === host);
    const known = this.attachedSessionIds();
    const caps = this.hostStatus.get(host)?.capabilities;
    const adapters = Object.values(this.opts.adapters).filter((a): a is ProviderAdapter => !!a?.remote && caps?.find((c) => c.provider === a.provider)?.available !== false);
    const results = await Promise.allSettled(adapters.map((a) => a.discoverSessions({ limit: 60, host })));
    if (results.length && results.every((r) => r.status === 'rejected')) throw (results[0] as PromiseRejectedResult).reason;
    const lists = results.map((r) => (r.status === 'fulfilled' ? r.value : []));
    return lists
      .flat()
      .filter((s) => s.cwd && !known.has(s.nativeSessionId))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /**
   * Recent Claude Code and Codex sessions from every folder on this machine,
   * newest first, minus ones already imported and the app's own scratch dirs.
   */
  async discoverAllSessions(): Promise<NativeSessionInfo[]> {
    // Tests read a fixture (a JSON list) instead of this computer's real Claude Code / Codex sessions.
    if (process.env.AMW_DISCOVER_FIXTURE) return (JSON.parse(readFileSync(process.env.AMW_DISCOVER_FIXTURE, 'utf8')) as NativeSessionInfo[]).filter((s) => !s.host);
    const known = this.attachedSessionIds();
    const own = [this.opts.dataDir, ...(this.opts.hiddenSessionDirs ?? []), tmpdir(), '/var/folders', '/private/var/folders', '/private/tmp', '/tmp'].map((p) => resolve(p));
    const lists = await Promise.all(
      CODING_PROVIDERS.map(async (p) => {
        const adapter = this.opts.adapters[p];
        if (!adapter || !this.capabilities.find((c) => c.provider === p)?.available) return [];
        try {
          return await adapter.discoverSessions({ limit: 60 });
        } catch (error) {
          this.log('discover failed', p, error);
          return [];
        }
      }),
    );
    return lists
      .flat()
      .filter((s) => s.cwd && !known.has(s.nativeSessionId) && !own.some((dir) => resolve(s.cwd).startsWith(dir)))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /** Adopts a provider session created outside the app (historical resume, not live attach). */
  async importSession(args: { projectId?: string; provider: CodingProvider; nativeSessionId: string; cwd: string; host?: string; title: string }): Promise<Task> {
    if (args.host) this.requireOnHost(args.provider, args.host);
    if (args.projectId) args = { ...args, host: this.project(args.projectId).host };
    else if (args.host) {
      const inside = this.store.data.projects.find((p) => p.host === args.host && (args.cwd === p.rootPath || args.cwd.startsWith(p.rootPath + '/')));
      args = { ...args, projectId: (inside ?? (await this.addProject(args.cwd, undefined, args.host))).projectId };
    } else {
      // From the machine-wide list: the session's folder becomes (or joins) a project.
      if (!existsSync(args.cwd)) throw new Error(`The session's folder no longer exists: ${args.cwd}`);
      const inside = this.store.data.projects.find((p) => !p.host && (args.cwd === p.rootPath || args.cwd.startsWith(p.rootPath + sep)));
      args = { ...args, projectId: (inside ?? (await this.addProject(args.cwd))).projectId };
    }
    const ids = this.newTaskIds();
    const title = clip(args.title, 120);
    const task = this.addTask(ids, {
      projectId: args.projectId!,
      provider: args.provider,
      host: args.host,
      cwd: args.cwd,
      name: ids.alias,
      title,
      status: 'disconnected',
      summary: 'Imported with its full history. Send a message to continue.',
      session: { nativeSessionId: args.nativeSessionId, integrationMode: 'resumed' },
      keepsOriginalFolder: true,
      // A keyword guess (or the project's name) now; the model refines it once it can read the conversation.
      label: { title, instruction: '', refine: false },
    });
    this.changed();
    void this.previewHistory(task, args.provider, args.nativeSessionId).then((items) => {
      const said = (items ?? [])
        .filter((i) => i.role === 'user' && i.text.trim())
        .slice(0, 4)
        .map((i) => i.text.replace(/\s+/g, ' ').slice(0, 300));
      void this.refineLabel(task, [task.title, ...said].join('\n'));
    });
    return task;
  }

  // ---------------------------------------------------------------- forking

  /** The task's saved conversation, if its provider can fork it here (onto another CLI: if it can read it back). */
  private forkSource(taskId: string, onto?: AgentProvider) {
    const task = this.task(taskId);
    if (task === this.store.data.mainAgent) throw new Error('The main agent cannot be forked.');
    const adapter = this.opts.adapters[task.provider];
    const elsewhere = !!onto && onto !== task.provider;
    if (!adapter?.forkPoints || !(elsewhere ? adapter.readHistory : adapter.forkSession))
      throw new Error(`${providerName(task.provider)} conversations cannot be forked${elsewhere ? ' onto another CLI' : ''} yet.`);
    if (elsewhere && !this.opts.adapters[onto]) throw new Error(`${providerName(onto)} is not available here.`);
    // Onto another CLI the conversation is read and passed on as text, which works on a host too.
    if (task.host && !elsewhere) throw new Error('Conversations on SSH hosts cannot be forked yet.');
    const nativeSessionId = this.currentSession(task)?.nativeSessionId;
    if (!nativeSessionId) throw new Error(`${task.alias} has no saved conversation to fork yet.`);
    return { task, adapter: adapter as Required<Pick<typeof adapter, 'forkPoints'>> & typeof adapter, nativeSessionId };
  }

  /**
   * A saved conversation as said, for another CLI to continue: the transcript as shown (each message,
   * tools by their titles) up to just before the fork point's prompt, read back through the provider.
   */
  private async carryOver(src: Task, adapter: ProviderAdapter, nativeSessionId: string, upToMessageId?: string): Promise<{ items: TranscriptItem[]; lines: SaidLine[] }> {
    const events = await adapter.readHistory!(nativeSessionId, src.cwd, src.host);
    let items: TranscriptItem[] = [];
    for (const e of events) {
      if (e.type !== 'transcriptItem') continue;
      const copied = copiedItems(src.taskId, e);
      if (copied) {
        items.push(...copied);
        continue;
      }
      const i = items.findIndex((h) => h.id === e.itemId);
      const item = mergeItem(i === -1 ? undefined : items[i], { id: e.itemId, taskId: src.taskId, role: e.role, text: e.text, toolLabel: e.toolLabel, toolStatus: e.toolStatus, createdAt: now() }, e.tool);
      if (i === -1) items.push(item);
      else items[i] = item;
    }
    if (upToMessageId) {
      const points = await adapter.forkPoints!(nativeSessionId, src.cwd);
      const cut = forkCut(items, points, upToMessageId);
      if (cut === undefined) throw new Error('That point of the conversation was not found; fork it as it is now instead.');
      items = items.slice(0, cut);
    }
    const lines = items.flatMap((i): SaidLine[] => {
      if (i.role === 'user' || i.role === 'assistant') return i.text.trim() ? [{ role: i.role, text: i.text }] : [];
      if (i.role === 'tool') {
        const title = i.tool?.title || i.toolLabel || i.text.split('\n')[0];
        return title?.trim() ? [{ role: 'tool', text: title }] : [];
      }
      return [];
    });
    if (!lines.length) throw new Error(`There is nothing to fork in ${src.alias}'s conversation yet.`);
    return { items, lines };
  }

  /** Where the task's conversation can be forked: before each of the user's earlier prompts, oldest first. */
  async forkPoints(taskId: string): Promise<ForkPoint[]> {
    // On a host a conversation is carried over as it is now (onto another CLI): no earlier points.
    if (this.task(taskId).host) return [];
    const { task, adapter, nativeSessionId } = this.forkSource(taskId);
    return adapter.forkPoints(nativeSessionId, task.cwd);
  }

  /**
   * A new agent that continues a copy of this agent's conversation, from now or from just before
   * an earlier prompt; the original agent and its conversation are untouched. With `isolate`, the
   * copy works in its own worktree with the original's files as they are now: its last commit plus
   * its uncommitted changes (only the conversation is rewound, never files).
   */
  async forkTask(
    taskId: string,
    opts: { upToMessageId?: string; isolate: boolean; instruction?: string; name?: string; permissionMode?: PermissionMode; provider?: AgentProvider },
  ): Promise<Task> {
    const { task: src, adapter, nativeSessionId } = this.forkSource(taskId, opts.provider);
    // Onto another CLI: a new agent there, given the conversation as text with its first message.
    const onto = opts.provider && opts.provider !== src.provider ? opts.provider : undefined;
    if (src.host && onto) this.requireOnHost(onto, src.host);
    // Mid-turn, the saved conversation can end on a tool call with no result yet.
    if (this.live.get(src.taskId)?.turnActive || ['running', 'starting'].includes(src.status))
      throw new Error(`${src.alias} is still working. Fork it once this turn ends.`);
    const project = this.project(src.projectId);
    const title = clip(`${src.title} (fork)`, 120);
    let cwd = src.cwd;
    let worktree: Task['worktree'];
    // Its own worktree of the repository the original works in (the project's, or one inside it; here or on its host).
    const repo = opts.isolate ? await repoOf(src.host, src.cwd) : null;
    if (repo) {
      const head = await this.worktrees.headOf(src.host, src.cwd).catch((e: Error) => {
        throw new Error(`${src.alias}: ${e.message}`);
      });
      const slug = `${slugify(`${src.name} fork`)}-${randomUUID().slice(0, 8)}`;
      worktree = src.host ? await this.worktrees.createRemote(src.host, repo.root, slug, head) : await this.worktrees.create(repo.root, project.projectId, slug, head);
      // The same subfolder as the original (an imported session can work in one), so its paths still hold.
      cwd = repo.prefix ? (src.host ? `${worktree.path}/${repo.prefix}` : join(worktree.path, repo.prefix)) : worktree.path;
    }
    let forkId = '';
    let carried: { items: TranscriptItem[]; lines: SaidLine[] } | undefined;
    try {
      if (onto) carried = await this.carryOver(src, adapter, nativeSessionId, opts.upToMessageId);
      else forkId = await adapter.forkSession!(nativeSessionId, { cwd: src.cwd, targetCwd: cwd, upToMessageId: opts.upToMessageId, title });
    } catch (error) {
      if (worktree) await this.worktrees.removeIfClean(worktree);
      throw error;
    }
    // After the fork exists, so a failed fork still leaves a clean worktree to remove. Its conversation
    // remembers the original's edits, so its files must have them too.
    const copied = worktree ? (src.host ? await this.worktrees.copyChangesRemote(src.host, src.cwd, worktree.path) : await this.worktrees.copyChanges(src.cwd, worktree.path)) : undefined;
    const ids = this.newTaskIds();
    const { taskId: newId, alias } = ids;
    const point = opts.upToMessageId ? 'from an earlier point' : 'as it is now';
    const on = onto ? ` on ${providerName(onto)}` : '';
    const task = this.addTask(ids, {
      projectId: src.projectId,
      provider: onto ?? src.provider,
      host: src.host,
      cwd,
      worktree,
      // A custom name is a voice handle, so the fork gets its own.
      name: opts.name?.trim() || (src.name === src.alias ? alias : this.forkName(src.name, labelLang(alias))),
      nameSource: 'auto',
      title,
      status: onto ? 'idle' : 'disconnected',
      summary: `Forked from ${src.alias}'s conversation ${point}${on}. Send a message to continue.`,
      session: onto ? undefined : { nativeSessionId: forkId, integrationMode: 'resumed' },
      permissionMode: 'permissionMode' in opts ? opts.permissionMode : src.permissionMode,
      forkedFrom: { taskId: src.taskId, alias: src.alias },
      mockScript: src.mockScript,
    });
    const notes = [
      `${alias} continues ${src.alias}'s conversation ${point}${on}${worktree ? ` in its own worktree (${worktree.branch}) with ${src.alias}'s files as they are now` : ''}.`,
      ...(copied?.error
        ? [`${src.alias}'s uncommitted changes were not fully copied (${copied.error}); check ${alias}'s files before relying on them.`]
        : copied?.files
          ? [`${src.alias}'s uncommitted changes were copied too (${copied.files} file${copied.files === 1 ? '' : 's'}).`]
          : []),
    ];
    this.coordinatorSay(`Forked ${src.alias} as ${alias}${on}. ${notes.join(' ')}`);
    if (carried) {
      // Shown as it was; the new CLI receives it with the first message.
      (this.store.data.carried ??= {})[newId] = carried.lines;
      this.store.setTranscript(newId, carried.items.slice(-400).map((i) => ({ ...i, taskId: newId, streaming: false })));
      for (const cb of this.transcriptListeners) cb(newId, null);
      const last = [...carried.items].reverse().find((x) => x.role === 'assistant' && x.text.trim());
      if (last) task.summary = summaryFor(last.text);
    }
    this.changed();
    if (!onto && src.provider !== 'mock') void this.previewHistory(task, src.provider, forkId);
    const instruction = opts.instruction?.trim();
    // A fork with its own instruction is new work: label that work, not the original's.
    if (instruction && !opts.name?.trim()) void this.refineLabel(task, `${instruction}\n(branched off: ${src.name})`);
    if (instruction) {
      const r = await this.send(newId, instruction, 'text');
      // The fork itself exists, so keep it (failing here would invite a duplicate); keep the instruction to resend.
      if (!r.ok) {
        this.appendSystem(newId, `The first instruction was not sent. Resend it when ${alias} is reachable:\n\n${instruction}`);
        this.coordinatorSay(`${alias} was forked, but its first instruction was not delivered: ${r.error}`);
        this.changed();
      }
    }
    return task;
  }

  /** "Order API" -> "Order API fork" ("订单接口 分叉"), then "… 2", … — unique among the agents. */
  private forkName(name: string, lang: 'en' | 'zh'): string {
    const taken = new Set(this.store.data.tasks.map((t) => t.name.trim().toLowerCase()));
    const base = `${name.trim()} ${lang === 'zh' ? '分叉' : 'fork'}`;
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
    return candidate;
  }

  /**
   * The memory a session of this task is given: its scope's notes, less user notes the CLI already reads
   * from its own files on a linked machine (unless a file there is paused and may be out of date: then
   * rather twice than missing; and only the notes that fit in those files).
   */
  private memoryGiven(task: Task, covered = new Map<string, Set<string>>()): MemoryRecord[] {
    const machine = task.host ?? LOCAL;
    // An ACP CLI reads its own rules file (shared/acp-agents.ts `memory`), if the app writes one there.
    const acp = acpAgent(task.provider);
    if (acp && !acp.memory) return memoryForTask(task, this.store.data.memory);
    const file = acp?.memory?.file ?? (task.provider === 'codex' ? '~/.codex/AGENTS.md' : '~/.claude/CLAUDE.md');
    // (Worked out once per machine and file when asked for many agents at once.)
    let inFiles = covered.get(`${machine}|${file}`);
    if (!inFiles) {
      const link = this.store.data.settings.memoryLinks?.[machine];
      const targets = this.writeback.targets(machine);
      // An ACP CLI's file is written only where its folder exists: only then does it hold the notes.
      const written = !acp?.memory || targets.some((t) => t.kind === acp.memory!.kind && t.added);
      const viaFiles = !!link && !link.unlinking && !targets.some((t) => t.paused) && written;
      inFiles = viaFiles ? notesFor(machine, file, this.store.data.memory).covered : new Set<string>();
      covered.set(`${machine}|${file}`, inFiles);
    }
    return memoryForTask(task, this.store.data.memory).filter((m) => !(m.scope === 'global' && inFiles.has(m.id)));
  }

  /** The agents a note reaches from their next message: those of its scope with a session to give it to. */
  memoryReach(id: string): Array<{ taskId: string; alias: string; idle: boolean }> {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m) return [];
    const covered = new Map<string, Set<string>>();
    return [...this.store.data.tasks, ...(this.store.data.mainAgent ? [this.store.data.mainAgent] : [])]
      .filter((t) => !t.setAside && t.memorySeen && this.memoryGiven(t, covered).some((x) => x.id === id) && (!t.memorySeen[id] || t.memorySeen[id].at !== m.updatedAt))
      .map((t) => ({ taskId: t.taskId, alias: t.alias, idle: t.status !== 'running' && t.status !== 'starting' && !this.hasOpenNative(t.taskId) }));
  }

  /** "Tell them now": idle agents a note reaches get a short message (the update rides along with it). */
  async tellMemoryNow(id: string): Promise<number> {
    const zh = this.store.data.settings.language === 'zh';
    const idle = this.memoryReach(id).filter((r) => r.idle);
    for (const r of idle) await this.send(r.taskId, zh ? '我更新了工作区记忆，记下即可，不用做别的。' : 'I updated the workspace memory. Just note it; nothing else to do.', 'text');
    return idle.length;
  }

  // ---------------------------------------------------------------- messaging

  /**
   * To the main agent: the request the user had unfolded in "waiting on you" while writing, as a hint
   * of what the message answers. Not shown in the conversation; never an approval.
   */
  private openRequestNote(task: Task, attentionId?: string): string {
    if (!attentionId || task !== this.store.data.mainAgent) return '';
    const a = this.store.data.attention.find((x) => x.id === attentionId && x.state === 'open');
    const agent = a && this.findTask(a.taskId);
    if (!a || !agent || agent === task) return '';
    const kind = a.kind === 'approval' ? 'permission request' : a.kind;
    return `[Open request: the user had this unfolded while writing: request_id ${a.id} · ${agent.alias} · ${kind}: ${clip(a.headline, 200)}. Their message is most likely about it. This note is not their words and is not an approval.]`;
  }

  /**
   * Images in a user message read back from a CLI's history, kept in the app's store so the
   * conversation shows them. A file on an SSH host is not fetched (it shows as an image that
   * could not be kept); bytes from history and files on this computer are.
   */
  private historyImages(images: HistoryImage[] | undefined, host: string | undefined): ImageRef[] | undefined {
    if (!images?.length) return undefined;
    const refs = images
      .map((img) => ('data' in img ? this.attachments.saveFromHistory(img) : host ? undefined : this.attachments.saveFromHistory(img)))
      .map((r, i) => r ?? { id: '', mediaType: '', name: 'path' in images[i] ? basename((images[i] as { path: string }).path) : undefined });
    return refs;
  }

  /** Delivers text to exactly this task's native session. Never re-routed. */
  /** `keepAsks`: not the user's reply (a research's own message between its agents): what the agent asked the user stays open. */
  async send(taskId: string, text: string, via: TranscriptItem['via'], opts: { interrupt?: boolean; images?: ImageRef[]; openRequest?: string; keepAsks?: boolean } = {}): Promise<DispatchResult> {
    const task = this.task(taskId);
    const images = opts.images?.length ? opts.images.slice(0, MAX_IMAGES) : undefined;
    const missing = images?.find((r) => !this.attachments.has(r.id));
    if (missing) return { ok: false, taskId, error: `Image ${missing.name ?? missing.id} is no longer stored; add it again.` };
    // What an image-only message is about, where a line of text is needed (summary, title, replies).
    const about = text.trim() || (images ? `[${images.length === 1 ? 'image' : `${images.length} images`}]` : '');
    if (task === this.store.data.mainAgent) {
      this.mainTurns++;
      // Back after a long pause, or a long chapter: start a new one before this message.
      const due = this.store.data.settings.mainChapters !== 'off' ? chapterDue(this.store.transcript(taskId), Date.now()) : null;
      if (due) await this.newMainChapter(due);
    }
    // A new message carries on from a failed turn by itself; no retry on top of it.
    this.cancelRetry(taskId);
    try {
      // An earlier conversation given a place in a research since it connected (attached): it connects again to be
      // told it. (One the research started was told in its brief.)
      const was = this.live.get(taskId);
      if (was && !was.turnActive && !this.hasOpenNative(taskId) && task !== this.store.data.mainAgent && !task.researchAgent && !task.researchManager) {
        const place = this.researchPlace(task);
        if ((place ? `${place.id}:${place.role}` : undefined) !== was.role) {
          this.live.delete(taskId);
          await was.session.close().catch(() => {});
        }
      }
      const live = await this.connect(taskId);
      live.lastUsed = Date.now();
      const busy = live.turnActive;
      // Memory saved, changed or removed since the session was given its notes reaches it with this message.
      const given = this.memoryGiven(task);
      const delta = memoryDelta(given, task.memorySeen ?? seenOf(given.filter((m) => task.injectedMemoryIds?.includes(m.id))));
      const update = deltaSize(delta) ? memoryUpdateText(delta) : '';
      if (update) this.appendSystem(taskId, `Memory sent with this message: ${deltaSize(delta)}`, { memoryUpdate: [...delta.added.map((m) => m.body), ...delta.changed.map((m) => m.body), ...delta.removed.map((b) => `✕ ${b}`)] });
      const item: TranscriptItem = { id: `u-${randomUUID()}`, taskId, role: 'user', text, ...(images ? { images } : {}), via, createdAt: now(), ...(busy ? { delivery: opts.interrupt ? 'interrupt' : 'steer' } : {}) };
      this.upsertTranscript(taskId, item);
      task.suggestion = undefined;
      // A new request starts a new set of sub-agents; ones still working (in the background) stay.
      // Not on every turn start: Claude Code starts turns of its own to report background sub-agents.
      if (!busy && task.subtasks) task.subtasks = task.subtasks.filter((s) => s.status === 'running').length ? task.subtasks.filter((s) => s.status === 'running') : undefined;
      // Commands the user ran with `!` since the last message reach the agent with this one.
      const ran = this.shellOutput.get(taskId) ?? [];
      // The first message of a new chapter carries the hand-over (what is going on now) to the fresh session;
      // then any memory update, the commands run with `!`, and the message itself.
      const handover = task === this.store.data.mainAgent ? this.pendingHandover : undefined;
      this.pendingHandover = task === this.store.data.mainAgent ? undefined : this.pendingHandover;
      const openNote = this.openRequestNote(task, opts.openRequest);
      // An agent continuing a conversation from another CLI gets it with its first message.
      const carried = this.store.data.carried?.[taskId];
      const message = [handover, update, ...ran, openNote, text].filter(Boolean).join('\n\n');
      const delivery = await live.session.send(carried ? conversationCopy(carried, `${CARRY_NOTE}\n\n${message}`) : message, {
        interrupt: opts.interrupt,
        ...(images ? { images: images.map((r) => ({ path: this.attachments.path(r.id), mediaType: r.mediaType })) } : {}),
      });
      this.shellOutput.delete(taskId);
      if (carried) delete this.store.data.carried![taskId];
      if (update) {
        task.memorySeen = seenOf(given);
        task.injectedMemoryIds = given.map((m) => m.id);
      }
      if (delivery === 'turn' && item.delivery) this.upsertTranscript(taskId, { ...item, delivery: undefined });
      // A delivered reply answers this task's heuristic asks (not native approvals, which need their own decision),
      // and takes the place of retrying a failed turn.
      for (const a of this.store.data.attention)
        if (!opts.keepAsks && a.taskId === taskId && a.state === 'open' && !a.providerRequestId && !a.members && (a.kind !== 'error' || a.retryable))
          this.closeAttention(a, 'resolved', `Replied: ${clip(about, 80)}`);
      // Going again: no longer among its group's troubles.
      this.untrouble(taskId);
      live.turnActive = true;
      if (!this.hasOpenNative(taskId)) task.status = 'running';
      // Steering adds to the work in progress; the summary keeps describing it.
      if (delivery !== 'steer') task.summary = `Working on: ${clip(about, 120)}`;
      task.updatedAt = now();
      // Everything sent here comes from the user (typed, spoken, the main agent on their behalf).
      this.touched(task);
      // Started without saying what for: this first message is what the task is, and what its label describes.
      if (!task.title.trim() && delivery !== 'steer') {
        task.title = clip(about.replace(/\s+/g, ' ').trim(), 80);
        if (task.nameSource !== 'user' && text.trim()) this.autoLabel(task, task.title, text);
      }
      // The first instruction is what the first label describes; later messages may change the work.
      if (via !== 'initial') task.saidSinceLabel = (task.saidSinceLabel ?? 0) + 1;
      this.changed();
      return { ok: true, taskId, delivery };
    } catch (error) {
      const message = (error as Error).message;
      // A research's own message (a result reported up, research_tell) to an agent whose host cannot be reached:
      // it waits, and goes out when the host answers.
      if (opts.keepAsks && this.connectionLost(task, message)) {
        this.queued.set(taskId, [...(this.queued.get(taskId) ?? []), text]);
        if (!this.live.has(taskId)) this.scheduleReconnect(task, false);
        this.changed();
        return { ok: true, taskId, queued: true };
      }
      this.appendSystem(taskId, `Message not delivered: ${message}`);
      this.changed();
      return { ok: false, taskId, error: message };
    }
  }

  /**
   * Runs a command the user typed as `!command` in the agent's folder (on its host), as in
   * the CLIs: no permission prompt, since the user typed it. Codex runs it in its own shell
   * and records it; otherwise it runs here and the output goes along with the next message.
   */
  async runShell(taskId: string, command: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.task(taskId);
    if (task === this.store.data.mainAgent) return { ok: false, error: 'Commands run in an agent’s folder; the main agent has none. Open an agent first.' };
    // Codex has its own `!`; connecting for it is needed anyway. Others need no session to run a command.
    if (task.provider === 'codex' || this.live.get(taskId)?.session.shell) {
      try {
        const live = await this.connect(taskId);
        if (live.session.shell) {
          await live.session.shell(command, this.commandTimeoutMs());
          return { ok: true };
        }
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
    const id = `sh-${randomUUID()}`;
    const first = command.split('\n')[0];
    const terminal = { type: 'terminal' as const, command, cwd: task.cwd, output: '' };
    const tool: ToolCallInfo = { name: 'Bash', kind: 'execute', title: `! ${first}`, locations: [], content: [terminal], byUser: true };
    this.upsertTranscript(taskId, { id, taskId, role: 'tool', text: '', toolStatus: 'running', tool, createdAt: now() });
    this.changed();
    const timeoutMs = this.commandTimeoutMs();
    const r = task.host
      ? await sshRun(task.host, `cd ${shq(task.cwd)} && { ${command}\n}`, timeoutMs)
      : process.platform === 'win32'
        ? await run('cmd.exe', ['/d', '/s', '/c', command], { cwd: task.cwd, timeoutMs })
        : await run(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd: task.cwd, timeoutMs });
    const output = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n');
    this.upsertTranscript(taskId, { id, taskId, role: 'tool', text: '', toolStatus: r.code === 0 ? 'completed' : 'failed', createdAt: now() }, { content: [{ ...terminal, output: clipOutput(output), exitCode: r.code }] });
    const pending = this.shellOutput.get(taskId) ?? [];
    pending.push(shellContext(command, r.stdout, r.stderr));
    this.shellOutput.set(taskId, pending.slice(-5));
    this.changed();
    return { ok: true };
  }

  /**
   * Each CLI's model list (per machine): the last one read, or the read under way. It changes with the
   * CLI and with the account (a new plan, another sign-in), so the picker asks again each time it opens.
   */
  private modelLists = new Map<string, Promise<ModelOption[]>>();
  private modelReads = new Set<string>();

  /** The models this agent's CLI offers, for the picker in its header: the last list read, or (`fresh`) read again now. */
  listModels(taskId: string, fresh = false): Promise<ModelOption[]> {
    const task = this.task(taskId);
    const adapter = this.opts.adapters[task.provider];
    if (!adapter?.listModels) return Promise.resolve([]);
    const key = `${task.provider}|${task.host ?? ''}`;
    let list = this.modelLists.get(key);
    // One read at a time: a fresh ask while one is under way gets that one.
    if (!list || (fresh && !this.modelReads.has(key))) {
      // Some CLIs (ACP) offer their models per session: one not started yet is started quietly for it
      // (its own session, which its first message then uses; nothing is sent).
      const ask = adapter.listModels.bind(adapter);
      list = ask(task.host).catch(async (error) => {
        if (this.live.has(taskId) || !isAcpProvider(task.provider)) throw error;
        await this.connect(taskId, true);
        return ask(task.host);
      });
      const previous = this.modelLists.get(key);
      this.modelLists.set(key, list);
      this.modelReads.add(key);
      const read = list;
      // A failure is not kept: the last good list stays.
      read.then(
        () => this.modelReads.delete(key),
        () => {
          this.modelReads.delete(key);
          if (this.modelLists.get(key) === read) {
            if (previous) this.modelLists.set(key, previous);
            else this.modelLists.delete(key);
          }
        },
      );
    }
    return list;
  }

  /**
   * The model for this agent from its next turn (unset: the CLI's default). Kept on the
   * task, so a resumed session runs on it too; a running turn keeps its model.
   */
  /** Remote Control entries whose session is still the agent's live one (it ends with the session). */
  private liveRemote(): Array<[string, { localId: string; url?: string; codex?: CodexRemoteControl }]> {
    return [...this.remote].filter(([id, r]) => this.live.get(id)?.localId === r.localId);
  }

  /**
   * Remote Control for a local agent: on connects its session (starting it if needed) so a phone can
   * drive it; off disconnects the phone, the session keeps running here. Claude Code: the Claude app and
   * claude.ai/code (resolves with the link). Codex: the ChatGPT app, paired with a code (in the snapshot);
   * on again while on asks Codex for a fresh code. Agents on SSH hosts and the main agent go without.
   */
  async setRemoteControl(taskId: string, on: boolean): Promise<string | undefined> {
    const task = this.task(taskId);
    const codex = task.provider === 'codex';
    if ((task.provider !== 'claude' && task.provider !== 'mock' && !codex) || task.host || this.store.data.mainAgent?.taskId === taskId)
      throw new Error('Remote Control is for Claude Code and Codex agents on this computer.');
    let live = this.live.get(taskId);
    if (!live) {
      if (!on) return undefined;
      live = await this.connect(taskId);
    }
    if (!live.session.setRemoteControl) throw new Error('This session cannot turn on Remote Control.');
    const res = await live.session.setRemoteControl(on, task.name);
    if (!on) this.remote.delete(taskId);
    else if (codex) this.remote.set(taskId, { localId: live.localId, codex: res.codex });
    else this.remote.set(taskId, { localId: live.localId, url: res.url ?? 'https://claude.ai/code' });
    this.changed();
    return res.url;
  }

  /** Codex Remote Control: unpairs one of the devices paired with this computer. */
  async revokeRemoteDevice(taskId: string, clientId: string): Promise<void> {
    const live = this.live.get(taskId);
    const entry = this.remote.get(taskId);
    if (!live || !entry?.codex || entry.localId !== live.localId || !live.session.revokeRemoteDevice) throw new Error('Remote Control is not on for this agent.');
    await live.session.revokeRemoteDevice(clientId);
  }

  async setModel(taskId: string, model: string | undefined): Promise<void> {
    const task = this.task(taskId);
    task.model = model;
    if (!model) task.activeModel = undefined;
    task.updatedAt = now();
    const live = this.live.get(taskId);
    if (live?.session.setModel) await live.session.setModel(model);
    this.changed();
  }

  /** The library for an agent on this computer, or its copy on the agent's host (copied when it changed). */
  private async skillsFor(task: Task): Promise<{ pluginDir: string; root: string } | undefined> {
    try {
      return task.host ? await this.skills.ensureOnHost(task.host) : this.skills.localLoad();
    } catch (error) {
      // The agent still starts, just without the workspace skills.
      this.appendSystem(task.taskId, `Workspace skills not loaded: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Last scan's results, so an import names a found skill by key rather than by path. */
  private foundSkills = new Map<string, FoundSkill>();

  /** Skills in the CLIs' own folders on this computer and on every reachable enabled host. */
  async scanSkills(): Promise<{ found: FoundSkill[]; errors: Array<{ host: string; error: string }> }> {
    const errors: Array<{ host: string; error: string }> = [];
    const found: FoundSkill[] = [...scanLocal()];
    await Promise.all(
      this.enabledHosts().map(async (host) => {
        if (this.hostStatus.get(host)?.ssh !== 'ok') return errors.push({ host, error: this.hostStatus.get(host)?.error ?? `${host} is not connected.` });
        const r = await sshRun(host, remoteScanScript(), 60_000);
        if (r.code !== 0) return errors.push({ host, error: r.code === 255 ? sshError(host, r.stderr) : `Could not list skills on ${host}.` });
        found.push(...parseRemoteScan(host, r.stdout));
      }),
    );
    this.foundSkills = new Map(found.map((f) => [f.key, f]));
    return { found, errors };
  }

  async importSkill(key: string): Promise<void> {
    const found = this.foundSkills.get(key);
    if (!found) throw new Error('That skill is no longer in the list. Scan again.');
    await this.skills.import(found);
    await this.skillsChanged();
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    this.skills.setEnabled(name, enabled);
    await this.skillsChanged();
  }

  async removeSkill(name: string): Promise<void> {
    this.skills.remove(name);
    await this.skillsChanged();
  }

  /** After the library changed: copy it to hosts with running agents and tell running sessions. */
  async skillsChanged(): Promise<void> {
    const hosts = new Set<string>();
    for (const [taskId] of this.live) {
      const host = this.findTask(taskId)?.host;
      if (host) hosts.add(host);
    }
    for (const host of hosts) await this.skills.ensureOnHost(host).catch((e: Error) => this.log('skills sync', host, e.message));
    await Promise.all([...this.live.values()].map((l) => l.session.reloadSkills?.()));
    this.changed();
  }

  /**
   * A memory note drafted from one of the user's own messages, read with the conversation
   * around it (the user asked: "Remember" on that message). Only a draft: the user edits,
   * picks user or project memory and saves. Without a CLI to ask (or if it fails), the
   * draft is the message itself, marked so.
   */
  async distillMemory(taskId: string, itemId: string): Promise<{ title: string; body: string; scope: 'global' | 'project'; worth: boolean; reason: string; similar?: { id: string; title: string; body: string }; fallback?: string }> {
    const task = this.task(taskId);
    const items = this.store.transcript(taskId);
    const at = items.findIndex((i) => i.id === itemId);
    if (at === -1 || items[at].role !== 'user') throw new Error('That message is no longer in the conversation.');
    const message = items[at].text;
    const talk = (i: TranscriptItem) => (i.role === 'user' || i.role === 'assistant') && !!i.text.trim();
    const before = items.slice(0, at).filter(talk).slice(-6);
    const after = items.slice(at + 1).filter(talk).slice(0, 2);
    const project = this.store.data.projects.find((p) => p.projectId === task.projectId);
    const existing = this.store.data.memory
      .filter((m) => !m.sourceRemoved && (m.scope === 'global' || (m.scope === 'project' && m.scopeId === task.projectId)))
      .slice(-40)
      .map((m) => ({ id: m.id, scope: (m.scope === 'global' ? 'user' : 'project') as 'user' | 'project', title: m.title || m.body.split('\n')[0].slice(0, 80), text: m.body }));
    const raw = { title: message.split('\n')[0].slice(0, 60), body: message.trim(), scope: 'global' as const, worth: true, reason: '' };
    // The demo asks no model: a canned draft shows the shape of a real one.
    if (this.opts.demo)
      return {
        title: raw.title.replace(/\.$/, ''),
        body: `${message.trim()}\n\n**Why:** said while correcting the agent's work in this conversation.\n**How to apply:** follow it whenever this kind of change comes up again.`,
        scope: task.projectId && task !== this.store.data.mainAgent ? 'project' : 'global',
        worth: true,
        reason: 'A convention for this project (demo draft, no model asked).',
      };
    const ask = this.backgroundAsk();
    if (!ask) return { ...raw, fallback: 'No Claude Code or Codex is signed in to draft the note; here is your message to edit.' };
    try {
      const answer = await ask(
        DISTILL_SYSTEM,
        distillPrompt({
          message,
          around: [...before.map((i) => ({ role: i.role as 'user' | 'assistant', text: i.text })), { role: 'user', text: message, isTarget: true }, ...after.map((i) => ({ role: i.role as 'user' | 'assistant', text: i.text }))],
          existing,
          projectName: project?.name,
        }),
      );
      const r = parseDistill(answer, existing.map((e) => e.id));
      const similar = r.similarId ? this.store.data.memory.find((m) => m.id === r.similarId) : undefined;
      return {
        title: r.title || raw.title,
        body: r.body || raw.body,
        scope: r.scope === 'project' && task.projectId && task !== this.store.data.mainAgent ? 'project' : 'global',
        worth: r.worth,
        reason: r.reason,
        ...(similar ? { similar: { id: similar.id, title: similar.title || similar.body.split('\n')[0], body: similar.body } } : {}),
      };
    } catch (error) {
      this.log('distill failed', error);
      return { ...raw, fallback: `Could not draft the note (${(error as Error).message}); here is your message to edit.` };
    }
  }

  // ---------------------------------------------------------------- provider events

  /** Sub-agents still marked running end (as failed) when their agent's turn or session does. */
  private endSubtasks(task: Task, why: string): void {
    for (const s of task.subtasks ?? [])
      if (s.status === 'running') {
        s.status = 'failed';
        s.step = '';
        s.result ??= why;
        s.endedAt = now();
      }
  }

  handleEvent(taskId: string, sessionLocalId: string, event: ProviderEvent): void {
    const task = this.findTask(taskId);
    const live = this.live.get(taskId);
    // Late events from a replaced or stopped session must not touch the task.
    if (!task || task.sessionLocalId !== sessionLocalId || !live || live.localId !== sessionLocalId) {
      this.log('dropped stale event', taskId, sessionLocalId, event.type);
      return;
    }
    if (event.type === 'remoteControl') {
      // Pairing and connection news, not activity: kept beside the session, never on the task.
      const entry = this.remote.get(taskId);
      if (entry?.localId !== sessionLocalId) return;
      if (event.state) entry.codex = event.state;
      else this.remote.delete(taskId);
      return this.changed();
    }
    let quiet = false;
    if (live.warm) {
      // A background connect ending before it was used: back to "Not connected", nothing to report.
      if (event.type === 'sessionFailed' || event.type === 'sessionDisconnected') {
        this.live.delete(taskId);
        this.expireNative(taskId, sessionLocalId, 'Provider session ended.');
        this.log('background session ended', taskId, event.type === 'sessionFailed' ? event.error : event.reason);
        if (task.status === 'idle') task.status = live.warm.status;
        return this.changed();
      }
      // Its start-up (the model, its id, history) is not activity; anything else (a turn of its own) is.
      quiet = event.type === 'sessionStarted' || event.type === 'model' || (event.type === 'transcriptItem' && !!event.history);
      if (!quiet) this.claim(taskId, live);
    }
    if (!quiet) task.updatedAt = now();
    // The provider's own retry is over once anything else happens.
    if (task.retry?.by === 'provider' && event.type !== 'retrying') task.retry = undefined;
    switch (event.type) {
      case 'sessionStarted': {
        const rec = this.store.data.sessions.find((s) => s.localId === sessionLocalId);
        if (rec) {
          rec.nativeSessionId = event.nativeSessionId;
          rec.integrationMode = event.resumed ? 'resumed' : 'managed';
        }
        break;
      }
      case 'transcriptItem': {
        const images = this.historyImages(event.images, task.host);
        this.upsertTranscript(
          taskId,
          { id: event.itemId, taskId, role: event.role, text: event.text, ...(images ? { images } : {}), toolLabel: event.toolLabel, toolStatus: event.toolStatus, streaming: false, createdAt: now() },
          event.tool,
        );
        if (event.role === 'assistant' && !event.history) task.summary = summaryFor(event.text);
        return this.changedThrottled();
      }
      case 'outputDelta': {
        const items = this.store.transcript(taskId);
        let item = items.find((i) => i.id === event.itemId);
        if (!item) {
          item = { id: event.itemId, taskId, role: event.role, text: '', streaming: true, createdAt: now() };
          items.push(item);
        }
        const term = item.tool?.content.find((c) => c.type === 'terminal');
        if (term && term.type === 'terminal') term.output = clipOutput(term.output + event.delta);
        else item.text += event.delta;
        this.store.touchTranscript(taskId);
        this.emitTranscript(taskId, item);
        return;
      }
      case 'model':
        task.activeModel = event.model;
        break;
      case 'suggestion':
        task.suggestion = clip(event.text, 500);
        break;
      case 'usage':
        task.usage = addUsage(task.usage, event);
        return this.changedThrottled();
      case 'limits': {
        // Per account: the same provider signed in on another machine has limits of its own.
        this.store.data.limits = withLimits(this.store.data.limits ?? {}, task, event.windows, event.plan);
        return this.changedThrottled();
      }
      case 'turnStarted':
        // Working again: back among the active.
        task.setAside = undefined;
        task.suggestion = undefined;
        live.turnActive = true;
        if (!this.hasOpenNative(taskId)) task.status = 'running';
        break;
      case 'planUpdated':
        task.plan = event.entries.length ? { entries: event.entries, explanation: event.explanation, updatedAt: now() } : undefined;
        return this.changedThrottled();
      case 'progress':
        task.summary = clip(event.text, 200);
        return this.changedThrottled();
      case 'subtask': {
        const list = (task.subtasks ??= []);
        let s = list.find((x) => x.id === event.id);
        if (!s) {
          s = { id: event.id, description: event.description ?? 'Sub-agent', status: 'running', startedAt: now() };
          list.push(s);
        }
        if (event.description) s.description = clip(event.description, 120);
        if (event.step !== undefined) {
          s.step = clip(event.step, 160);
          if (s.step) s.steps = [...(s.steps ?? []), { at: now(), text: s.step }].slice(-50);
        }
        if (event.result !== undefined) s.result = clip(event.result, 4000);
        if (event.status && event.status !== s.status) {
          s.status = event.status;
          if (event.status !== 'running') s.endedAt = now();
        }
        return this.changedThrottled();
      }
      case 'retrying':
        task.retry = { kind: event.kind, attempt: event.attempt, maxAttempts: event.maxAttempts, at: new Date(Date.now() + event.delayMs).toISOString(), by: 'provider', error: event.error };
        task.summary = `${RETRY_LABEL[event.kind]}, retrying (attempt ${event.attempt}${event.maxAttempts ? `/${event.maxAttempts}` : ''})`;
        break;
      case 'approvalRequested':
        if (!this.findOpenByRequest(taskId, event.requestId)) {
          this.addAttention({
            taskId,
            sessionLocalId,
            providerRequestId: event.requestId,
            kind: 'approval',
            headline: clip(event.headline, 200),
            details: event.details,
            options: event.options,
            highRisk: event.highRisk,
            toolCallId: event.toolCallId,
            preview: event.preview,
          });
        }
        if (event.toolCallId) this.markTool(taskId, event.toolCallId, 'awaiting_approval');
        task.status = 'waiting_for_user';
        task.summary = `Waiting for your approval: ${clip(event.headline, 140)}`;
        break;
      case 'userInputRequested':
        if (!this.findOpenByRequest(taskId, event.requestId)) {
          this.addAttention({
            taskId,
            sessionLocalId,
            providerRequestId: event.requestId,
            kind: 'question',
            headline: clip(event.headline, 200),
            details: event.questions.map((q) => q.question).join('\n'),
            questions: event.questions,
            toolCallId: event.toolCallId,
          });
        }
        task.status = 'waiting_for_user';
        task.summary = `Asked: ${clip(event.headline, 160)}`;
        break;
      case 'requestResolved': {
        const a = this.findOpenByRequest(taskId, event.requestId);
        if (a) this.closeAttention(a, 'expired', `Withdrawn by the provider (${event.reason}).`);
        if (!this.hasOpenNative(taskId) && live.turnActive) task.status = 'running';
        break;
      }
      case 'turnCompleted': {
        live.turnActive = false;
        // Stopped or failed turns take their sub-agents with them (background ones that outlive a finished turn report their own end).
        if (event.status !== 'completed') this.endSubtasks(task, event.status === 'interrupted' ? 'Stopped with the turn.' : 'Ended with the failed turn.');
        if (task !== this.store.data.mainAgent) this.maybeRefreshLabel(task);
        // Text that was still streaming when the turn ended (e.g. cut off by a steer) is final now; tell the UI.
        for (const it of this.store.transcript(taskId))
          if (it.streaming) {
            it.streaming = false;
            for (const cb of this.transcriptListeners) cb(taskId, { ...it });
          }
        if (event.status === 'failed') {
          // The model was busy: try the same turn again after a wait, unless the provider already did.
          const tried = this.retries.get(taskId)?.attempt ?? 1;
          if (event.transient && !event.retried && tried < this.retryPolicy.attempts) this.scheduleRetry(task, live.localId, event.transient, event.error, tried + 1);
          else this.turnFailed(task, event.error, event.transient, tried);
          break;
        }
        this.retries.delete(taskId);
        if (event.status === 'interrupted') {
          task.status = 'idle';
          task.summary = 'Interrupted. Waiting for your next instruction.';
          break;
        }
        const text = event.finalText?.trim() ?? '';
        if (task === this.store.data.mainAgent) {
          task.status = 'done';
          task.unread = true;
          task.summary = text ? summaryFor(text) : 'Finished.';
          break;
        }
        // Supersede this task's older completion notes; other tasks' items are never touched.
        for (const a of this.store.data.attention)
          if (a.taskId === taskId && a.state === 'open' && a.kind === 'completion') this.closeAttention(a, 'resolved', 'Superseded by a newer report.');
        if (text && asksUser(text)) {
          task.status = 'waiting_for_user';
          task.summary = summaryFor(text);
          this.addAttention({ taskId, kind: 'question', headline: headlineFor(text), details: text });
        } else {
          task.status = this.hasOpenNative(taskId) ? 'waiting_for_user' : 'done';
          task.unread = true;
          task.summary = text ? summaryFor(text) : 'Finished the turn.';
          this.addAttention({ taskId, kind: 'completion', headline: text ? headlineFor(text) : 'Finished the turn.', details: text });
        }
        break;
      }
      case 'sessionFailed':
      case 'sessionDisconnected': {
        const reason = event.type === 'sessionFailed' ? event.error : event.reason;
        // Waiting on the user's answer to its question is not working: the question stays, answered in a message
        // the resumed session reads (as after a restart).
        const natives = this.store.data.attention.filter((a) => a.taskId === taskId && a.state === 'open' && a.providerRequestId);
        const asking = task.status === 'waiting_for_user' && natives.length > 0 && natives.every((a) => a.kind === 'question');
        if (asking)
          for (const a of natives) {
            a.providerRequestId = undefined;
            a.sessionLocalId = undefined;
            a.questions = undefined;
            a.options = undefined;
          }
        const working = !asking && (live.turnActive || ['running', 'starting'].includes(task.status) || !!task.retry);
        this.endSubtasks(task, 'The agent disconnected.');
        this.live.delete(taskId);
        if (this.connectionLost(task, reason)) {
          // The connection to its host went (not the agent): reconnected by itself, and a turn it was in
          // carries on then. No error to dismiss meanwhile.
          const carry = !asking && (live.turnActive || task.retry?.by === 'app');
          this.cancelRetry(taskId);
          task.lastError = reason;
          this.expireNative(taskId, sessionLocalId, `Provider session ended: ${reason}`);
          this.scheduleReconnect(task, carry);
          if (asking) task.status = 'waiting_for_user';
          break;
        }
        // Its session ended while it had nothing to do: nothing for the user to handle; the next message connects it again.
        if (!working && !this.hasOpenNative(taskId)) {
          this.cancelRetry(taskId);
          task.lastError = reason;
          if (task.status === 'idle') task.status = 'disconnected';
          this.log('idle session ended', taskId, reason);
          break;
        }
        this.handBackRetry(task);
        task.status = event.type === 'sessionFailed' ? 'failed' : 'disconnected';
        task.lastError = reason;
        task.summary = `${event.type === 'sessionFailed' ? 'Session failed' : 'Disconnected'}: ${clip(reason, 140)}`;
        this.expireNative(taskId, sessionLocalId, `Provider session ended: ${reason}`);
        if (event.type === 'sessionFailed' && !this.trouble(task, 'failed', reason)) this.addAttention({ taskId, kind: 'error', headline: task.summary, details: reason });
        break;
      }
    }
    this.changed();
  }

  private throttle?: NodeJS.Timeout;
  private changedThrottled(): void {
    if (this.throttle) return;
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      this.changed();
    }, 120);
  }

  // ---------------------------------------------------------------- reconnecting

  /**
   * Whether a failure is the connection to the agent's host rather than the agent: it mends itself
   * once the host answers again. Not when the user has to act (a login, a key, a host key).
   */
  private connectionLost(task: Task, reason: string | undefined): boolean {
    if (!task.host || !reason) return false;
    if (/needs a login|unlocked key|host key|not signed in|not installed|no longer exists|refused another SSH session/i.test(reason)) return false;
    return /ssh|ended unexpectedly|connection|could not resolve|unreachable|no route to host|timed out|cannot reach|is not connected|exited \(255\)|code 255/i.test(reason);
  }

  private scheduleReconnect(task: Task, working: boolean): void {
    const host = task.host!;
    const r = this.reconnects.get(host) ?? { attempt: 0, since: Date.now(), tasks: new Map<string, boolean>() };
    r.tasks.set(task.taskId, (r.tasks.get(task.taskId) ?? false) || working);
    this.reconnects.set(host, r);
    task.status = 'disconnected';
    task.summary = `Lost the connection to ${host}; reconnecting…`;
    if (!r.timer) this.armReconnect(host);
  }

  private armReconnect(host: string, delayMs?: number): void {
    const r = this.reconnects.get(host);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    // Soon at first (a blip), then further apart (a machine that is off): every 10 minutes at most.
    const waits = this.opts.reconnectMs ?? [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000];
    r.timer = setTimeout(() => void this.runReconnect(host), delayMs ?? waits[Math.min(r.attempt, waits.length - 1)]);
  }

  /** The computer woke up (or the screen unlocked): try every waiting host again shortly, from the start. */
  reconnectNow(): void {
    for (const [host, r] of this.reconnects) {
      r.attempt = 0;
      r.since = Date.now();
      this.armReconnect(host, 3000);
    }
    // Those that stopped trying start again too.
    for (const [host, ids] of this.givenUp) {
      this.givenUp.delete(host);
      for (const id of ids) {
        const task = this.findTask(id);
        if (task && task.status === 'disconnected' && !this.live.has(id)) this.scheduleReconnect(task, false);
      }
      const r = this.reconnects.get(host);
      if (r) this.armReconnect(host, 3000);
    }
  }

  /** Hosts tried for a day without an answer: their agents wait, quietly, for a wake-up or a message. */
  private givenUp = new Map<string, Set<string>>();

  private async runReconnect(host: string): Promise<void> {
    const r = this.reconnects.get(host);
    if (!r) return;
    r.timer = undefined;
    r.attempt++;
    const status = await this.checkHost(host, { quiet: true }).catch(() => undefined);
    if (status && ['needs_key', 'needs_login', 'unknown_host_key'].includes(status.ssh)) {
      // Only the user can let it in: one note on the first agent, and the rest wait for them.
      this.reconnects.delete(host);
      const first = [...r.tasks.keys()].map((id) => this.findTask(id)).find(Boolean);
      if (first) this.addAttention({ taskId: first.taskId, kind: 'error', headline: `Cannot reconnect to ${host}: ${clip(status.error ?? 'it needs a login', 140)}`, details: status.error ?? '' });
      this.changed();
      return;
    }
    if (status?.ssh === 'ok') {
      for (const [taskId, working] of [...r.tasks]) {
        const task = this.findTask(taskId);
        if (!task || this.live.has(taskId)) {
          r.tasks.delete(taskId);
          continue;
        }
        try {
          const live = await this.connect(taskId, true);
          r.tasks.delete(taskId);
          this.resolveConnectionErrors(taskId);
          this.appendSystem(taskId, `Reconnected to ${host}.`);
          // Research messages that waited for it go out now.
          const waiting = this.queued.get(taskId);
          this.queued.delete(taskId);
          for (const text of waiting ?? []) await this.send(taskId, text, 'text', { keepAsks: true }).catch(() => {});
          if (working) {
            // Carries on with the turn the connection cut short.
            this.claim(taskId, live);
            task.summary = 'Reconnected; carrying on with the turn.';
            await live.session.send(RECONNECT_PROMPT).catch((error) => this.turnFailed(task, (error as Error).message, undefined, 1));
          } else task.summary = 'Reconnected.';
        } catch (error) {
          const message = (error as Error).message;
          if (!this.connectionLost(task, message)) {
            // Reachable, but the agent itself cannot start: that is for the user.
            r.tasks.delete(taskId);
            task.status = 'failed';
            task.lastError = message;
            task.summary = `Could not reconnect: ${clip(message, 140)}`;
            this.addAttention({ taskId, kind: 'error', headline: task.summary, details: message });
          }
        }
      }
    }
    if (!r.tasks.size) this.reconnects.delete(host);
    else if (Date.now() - r.since > (this.opts.reconnectGiveUpMs ?? 24 * 3600_000)) {
      // A day without an answer (the machine is off): stop trying; the agent says so, no error.
      this.reconnects.delete(host);
      this.givenUp.set(host, new Set(r.tasks.keys()));
      for (const id of r.tasks.keys()) {
        const task = this.findTask(id);
        if (task) task.summary = `Cannot reach ${host}. Reconnects when you send a message, or when the computer wakes.`;
      }
    } else this.armReconnect(host);
    this.changed();
  }

  /** No longer waiting to be reconnected (stopped, removed, or connected by the user). */
  private dropReconnect(taskId: string): void {
    for (const ids of this.givenUp.values()) ids.delete(taskId);
    for (const [host, r] of this.reconnects) {
      if (!r.tasks.delete(taskId) || r.tasks.size) continue;
      clearTimeout(r.timer);
      this.reconnects.delete(host);
    }
  }

  /** Errors about a connection that is back are over. */
  private resolveConnectionErrors(taskId: string): void {
    const task = this.findTask(taskId);
    if (!task) return;
    for (const a of this.store.data.attention)
      if (a.taskId === taskId && a.state === 'open' && a.kind === 'error' && this.connectionLost(task, `${a.headline} ${a.details ?? ''}`)) this.closeAttention(a, 'resolved', 'Reconnected.');
  }

  // ---------------------------------------------------------------- retries

  /** Runs a turn that failed because the model was busy again after a backoff wait. */
  private scheduleRetry(task: Task, sessionLocalId: string, kind: TransientKind, error: string | undefined, attempt: number): void {
    const { attempts } = this.retryPolicy;
    const delay = retryDelayMs(attempt - 1, this.retryPolicy);
    const timer = setTimeout(() => void this.runRetry(task.taskId, sessionLocalId, attempt), delay);
    this.retries.set(task.taskId, { attempt, timer });
    // Still at work on the instruction: Interrupt (or Stop, or a new message) cancels the wait.
    task.status = 'running';
    task.retry = { kind, attempt, maxAttempts: attempts, at: new Date(Date.now() + delay).toISOString(), by: 'app', error };
    task.summary = `${RETRY_LABEL[kind]}, retrying (attempt ${attempt}/${attempts})`;
    this.appendSystem(task.taskId, `${RETRY_LABEL[kind]}: ${clip(error ?? 'unknown error', 200)} Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${attempts}).`);
  }

  private async runRetry(taskId: string, sessionLocalId: string, attempt: number): Promise<void> {
    const state = this.retries.get(taskId);
    const task = this.findTask(taskId);
    const live = this.live.get(taskId);
    if (!state || state.attempt !== attempt || !state.timer || !task) return;
    if (live?.localId !== sessionLocalId) {
      // The session it was for is gone: keep it one click away rather than "retrying now" forever.
      this.handBackRetry(task);
      this.changed();
      return;
    }
    state.timer = undefined;
    task.retry = undefined;
    try {
      // turnStarted marks the turn active.
      await live.session.send(RETRY_PROMPT);
    } catch (error) {
      this.turnFailed(task, (error as Error).message, undefined, attempt - 1);
    }
    this.changed();
  }

  /** A waiting retry that can no longer run by itself (session gone, app restarted) stays one click away. */
  private handBackRetry(task: Task): void {
    const waiting = task.retry?.by === 'app' ? task.retry : undefined;
    this.cancelRetry(task.taskId);
    task.retry = undefined;
    if (waiting) this.turnFailed(task, waiting.error, waiting.kind === 'error' ? undefined : waiting.kind, waiting.attempt - 1);
  }

  /** Forgets the tries of the last instruction and drops a waiting retry; returns whether one was waiting. */
  private cancelRetry(taskId: string): boolean {
    const state = this.retries.get(taskId);
    this.retries.delete(taskId);
    if (!state?.timer) return false;
    clearTimeout(state.timer);
    const task = this.findTask(taskId);
    if (task) task.retry = undefined;
    return true;
  }

  /** A turn failed for good: say so, and keep running it again one click away. */
  private turnFailed(task: Task, error: string | undefined, transient: TransientKind | undefined, attempts: number): void {
    this.retries.delete(task.taskId);
    task.retry = undefined;
    task.status = 'failed';
    task.lastError = error;
    const why = clip(error ?? 'unknown error', 160);
    task.summary = attempts > 1 ? `Turn failed after ${attempts} attempts: ${why}` : `Turn failed: ${why}`;
    // The full message only when the headline had to shorten it.
    this.addAttention({ taskId: task.taskId, kind: 'error', headline: task.summary, details: error && why !== error.replace(/\s+/g, ' ').trim() ? error : '', retryable: true, transient });
    // A research agent stopped by its plan's limit: its lead hears of it, to move it to another CLI, wait, or ask.
    if (planLimited(error)) this.tellLeadOfLimit(task, why);
  }

  private tellLeadOfLimit(task: Task, why: string): void {
    const place = this.researchPlace(task);
    if (!place || place.role === 'lead') return;
    const lead = this.researchGet(place.id)?.leadTaskId;
    if (!lead || !this.findTask(lead)) return;
    const zh = this.language() === 'zh';
    const cli = providerName(task.provider);
    void this.send(
      lead,
      zh
        ? `【额度用尽】${task.alias} 在 ${cli} 上因为额度用完停下了（${why}）。用 research_usage 看各 CLI 的余量，再决定：用 research_switch 把它换到有余量的 CLI 接着做、等额度重置，或者问用户。`
        : `[Plan limit] ${task.alias} stopped on ${cli}: its plan's limit is reached (${why}). See what each CLI has left with research_usage, then move it to one with room (research_switch), wait for the reset, or ask the user.`,
      'text',
      { keepAsks: true },
    ).catch(() => {});
  }

  /** What each CLI account on the research's machine has left (as last seen), and what its agents have used. For research_usage. */
  researchUsage(id: string): string {
    const { projectId } = parseResearchId(id);
    const host = this.project(projectId).host;
    const nowMs = Date.now();
    const dur = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 48 * 3600_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 86_400_000)} d`);
    const span = (w: LimitWindow) => (w.mins === 300 ? '5-hour' : w.mins === 10080 ? 'weekly' : w.mins ? dur(w.mins * 60_000) : w.key);
    const lines: string[] = [`Usage limits on ${host ?? 'this computer'} (as each CLI last reported them):`];
    const accounts = Object.values(this.store.data.limits ?? {}).filter((l) => (l.host ?? undefined) === host && l.provider);
    for (const l of accounts) {
      lines.push(`- ${providerName(l.provider!)}${l.plan ? ` (${l.plan})` : ''}, seen ${dur(nowMs - Date.parse(l.at))} ago:`);
      for (const w of l.windows) {
        const resets = w.resetsAt ? (w.resetsAt > nowMs ? `, resets in ${dur(w.resetsAt - nowMs)}` : ', reset since') : '';
        lines.push(`  ${span(w)}${w.label ? ` [${w.label}]` : ''}${w.overage ? ' (beyond the plan)' : ''}: ${w.usedPercent}% used${resets}`);
      }
    }
    const seen = new Set(accounts.map((l) => l.provider));
    const caps = host ? (this.hostStatus.get(host)?.capabilities ?? []) : this.capabilities;
    const unseen = caps.filter((c) => c.available && c.provider !== 'mock' && !seen.has(c.provider)).map((c) => providerName(c.provider));
    if (unseen.length) lines.push(`- No usage reported yet: ${unseen.join(', ')}.`);
    if (!accounts.length && !unseen.length) lines.push('- Nothing reported yet.');
    const doc = this.researchGet(id);
    const agents = doc ? taskIdsOf(doc).map((t) => this.findTask(t)).filter((t): t is Task => !!t) : [];
    if (agents.length) {
      lines.push('', 'Used by this research’s agents (tokens: input + output; cache reads apart):');
      for (const t of agents) {
        const u = t.usage;
        const used = u ? `${Math.round((u.input + u.cacheWrite + u.output) / 1000)}k${u.cacheRead ? `, ${Math.round(u.cacheRead / 1000)}k cached` : ''}${u.costUsd ? `, ~$${u.costUsd.toFixed(2)} at API prices` : ''}` : 'nothing yet';
        lines.push(`- ${t.alias} (${providerName(t.provider)}): ${used}`);
      }
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- attention

  /** Research messages (results reported up, research_tell) to agents whose host could not be reached: sent once reconnected. */
  private queued = new Map<string, string[]>();

  /** Where an agent's session troubles are reported: its research's one item, its host's (connection lost), or its own. */
  private troubleGroup(task: Task, lost: boolean): string | undefined {
    const place = this.researchPlace(task);
    if (place) return `research:${place.id}`;
    if (task.researchAgent || task.researchManager) return `research:${task.projectId}`;
    return lost && task.host ? `host:${task.host}` : undefined;
  }

  /**
   * An agent's session trouble, into its group's one item (made if there is none): lost (cut off from its host while it
   * worked: it carries on when the host is back) or failed. Returns false when it has no group (reported on its own).
   */
  private trouble(task: Task, why: 'lost' | 'failed', reason: string): boolean {
    const group = this.troubleGroup(task, why === 'lost');
    if (!group) return false;
    let item = this.store.data.attention.find((a) => a.state === 'open' && a.group === group);
    if (!item) item = this.addAttention({ taskId: task.taskId, kind: 'error', group, members: [], headline: '', details: '' });
    item.members = [...(item.members ?? []).filter((m) => m.taskId !== task.taskId), { taskId: task.taskId, why, reason, ...(task.host ? { host: task.host } : {}) }];
    this.retitle(item);
    return true;
  }

  /** A group item's headline and details from who is in it. */
  private retitle(item: AttentionItem): void {
    const zh = this.language() === 'zh';
    const members = item.members ?? [];
    const names = (why: 'lost' | 'failed') => members.filter((m) => m.why === why).map((m) => this.findTask(m.taskId)?.alias ?? m.taskId).join(zh ? '、' : ', ');
    const research = item.group?.startsWith('research:') ? this.researchGet(item.group.slice('research:'.length))?.title : undefined;
    const host = members.find((m) => m.why === 'lost')?.host ?? (item.group?.startsWith('host:') ? item.group.slice(5) : '');
    const parts: string[] = [];
    if (names('lost')) parts.push(zh ? `与 ${host} 的连接断开，${names('lost')} 的工作被打断，恢复后自动继续` : `lost the connection to ${host}; ${names('lost')} will carry on when it is back`);
    if (names('failed')) parts.push(zh ? `${names('failed')} 的会话出错` : `${names('failed')}: session failed`);
    const what = parts.join(zh ? '；' : '; ');
    item.headline = research ? (zh ? `研究「${research}」：${what}` : `Research "${research}": ${what}`) : zh ? what : what.charAt(0).toUpperCase() + what.slice(1);
    item.details = members.map((m) => `${this.findTask(m.taskId)?.alias ?? m.taskId}: ${m.reason}`).join('\n');
    if (!members.some((m) => m.taskId === item.taskId) && members.length) item.taskId = members[0].taskId;
  }

  /** Drops an agent from its group's item (it carried on, or the user sent it something); the item closes when empty. */
  private untrouble(taskId: string, why?: 'lost' | 'failed'): void {
    for (const a of this.store.data.attention) {
      if (a.state !== 'open' || !a.members?.some((m) => m.taskId === taskId && (!why || m.why === why))) continue;
      a.members = a.members.filter((m) => !(m.taskId === taskId && (!why || m.why === why)));
      if (a.members.length) this.retitle(a);
      else this.closeAttention(a, 'resolved', 'All carried on.');
    }
  }

  /** Requests a lead is deciding, given back to the user if it has not in time. */
  private delegated = new Map<string, NodeJS.Timeout>();

  /**
   * A research agent's permission request, when its research leaves them to its lead: sent to the lead to decide
   * (research_approve) instead of being put to the user. Not the lead's own, nor a high-risk one; one the lead has
   * not decided in a while goes to the user.
   */
  private delegateToLead(a: AttentionItem): boolean {
    const task = this.findTask(a.taskId);
    if (!task || a.highRisk || !a.providerRequestId) return false;
    const place = this.researchPlace(task);
    if (!place || place.role === 'lead') return false;
    const doc = this.researchGet(place.id);
    const lead = doc?.leadTaskId ? this.findTask(doc.leadTaskId) : undefined;
    if (doc?.policy?.approvals !== 'lead' || !lead || lead === task) return false;
    a.delegatedTo = lead.taskId;
    const zh = this.language() === 'zh';
    const what = [a.headline, ...(a.preview ?? []).flatMap((c) => (c.type === 'terminal' ? [`$ ${(c as { command?: string }).command ?? ''}`] : c.type === 'diff' ? [`(${(c as { diff?: { path?: string } }).diff?.path ?? 'file'})`] : []))].filter(Boolean).join('\n');
    const text = zh
      ? `【权限请求 ${a.id}】${task.alias}（${this.researchGet(place.id)?.nodes.find((n) => n.taskId === task.taskId)?.title ?? ''}）想要：\n${clip(what, 1500)}\n\n用 research_approve（request "${a.id}"）决定：allow 批准、deny 拒绝（说明理由，它会收到），拿不准就 ask_user 交给用户。`
      : `[Permission request ${a.id}] ${task.alias} (${this.researchGet(place.id)?.nodes.find((n) => n.taskId === task.taskId)?.title ?? ''}) wants to:\n${clip(what, 1500)}\n\nDecide with research_approve (request "${a.id}"): allow, deny (say why; it is told), or ask_user when unsure.`;
    void this.send(lead.taskId, text, 'text', { keepAsks: true }).then((r) => {
      if (!r.ok) this.undelegate(a.id, `The lead could not be told: ${r.error ?? ''}`);
    });
    const timer = setTimeout(() => this.undelegate(a.id, 'The lead did not decide in time.'), this.opts.delegateMs ?? 10 * 60_000);
    timer.unref?.();
    this.delegated.set(a.id, timer);
    return true;
  }

  /** A delegated request goes to the user after all (the lead asked, could not be reached, or took too long). */
  private undelegate(attentionId: string, why: string): void {
    clearTimeout(this.delegated.get(attentionId));
    this.delegated.delete(attentionId);
    const a = this.store.data.attention.find((x) => x.id === attentionId);
    if (!a || a.state !== 'open' || !a.delegatedTo) return;
    a.delegatedTo = undefined;
    this.appendSystem(a.taskId, `${this.language() === 'zh' ? '权限请求交给你决定' : 'Permission request passed to you'}: ${why}`);
    this.changed();
  }

  /** The lead's decision on a request delegated to it (research_approve). */
  async researchApprove(leadTaskId: string, attentionId: string, decision: 'allow' | 'deny' | 'ask_user', note?: string): Promise<string> {
    const a = this.store.data.attention.find((x) => x.id === attentionId);
    if (!a || a.delegatedTo !== leadTaskId) throw new Error(`No request ${attentionId} waiting on you.`);
    if (a.state !== 'open') throw new Error(`Request ${attentionId} is already ${a.state}.`);
    const lead = this.findTask(leadTaskId);
    const zh = this.language() === 'zh';
    if (decision === 'ask_user') {
      this.undelegate(attentionId, zh ? `负责人 ${lead?.alias ?? ''} 交给你${note ? `：${note}` : ''}` : `the lead ${lead?.alias ?? ''} passed it on${note ? `: ${note}` : ''}`);
      return 'Passed to the user.';
    }
    const opt = decision === 'allow' ? (a.options?.find((o) => o.kind === 'allow_once') ?? a.options?.find((o) => !declinedOption(o))) : (a.options?.find((o) => o.kind === 'reject_once') ?? a.options?.find((o) => declinedOption(o)));
    if (!opt) throw new Error(`Request ${attentionId} has no ${decision} option; use ask_user.`);
    clearTimeout(this.delegated.get(attentionId));
    this.delegated.delete(attentionId);
    await this.respondAttention(attentionId, opt.id);
    this.appendSystem(a.taskId, zh ? `负责人 ${lead?.alias ?? ''}${decision === 'allow' ? '批准' : '拒绝'}了：${clip(a.headline, 200)}${note ? `（${note}）` : ''}` : `The lead ${lead?.alias ?? ''} ${decision === 'allow' ? 'allowed' : 'denied'}: ${clip(a.headline, 200)}${note ? ` (${note})` : ''}`);
    // A refusal's reason reaches the agent, so it can do otherwise.
    if (decision === 'deny' && note) await this.send(a.taskId, zh ? `【来自 ${lead?.alias ?? '负责人'}】没有批准「${clip(a.headline, 120)}」：${note}` : `[From ${lead?.alias ?? 'the lead'}] Not allowed (${clip(a.headline, 120)}): ${note}`, 'text', { keepAsks: true }).catch(() => {});
    return decision === 'allow' ? 'Allowed.' : 'Denied.';
  }

  private addAttention(a: Omit<AttentionItem, 'id' | 'state' | 'createdAt'>): AttentionItem {
    // One error per agent: the latest says what is wrong now.
    if (a.kind === 'error') for (const o of this.store.data.attention) if (o.taskId === a.taskId && o.state === 'open' && o.kind === 'error') this.closeAttention(o, 'resolved', 'Superseded by a newer error.');
    const item: AttentionItem = { ...a, id: `a-${randomUUID().slice(0, 8)}`, state: 'open', createdAt: now() };
    this.store.data.attention.push(item);
    if (item.kind === 'approval' && this.delegateToLead(item)) return item;
    // Anything but a finished report needs the user: an agent they set aside comes back.
    const target = this.findTask(a.taskId);
    if (target && a.kind !== 'completion') target.setAside = undefined;
    // The main agent's conversation lists what workers need from the user (a note, not a model turn).
    const main = this.store.data.mainAgent;
    const worker = this.store.data.tasks.find((t) => t.taskId === a.taskId);
    if (main && worker && (a.kind === 'question' || a.kind === 'approval'))
      this.appendSystem(main.taskId, `${worker.alias} is waiting on you (${a.kind === 'approval' ? 'permission' : 'question'}): ${clip(a.headline, 200)}`);
    return item;
  }

  private closeAttention(a: AttentionItem, state: AttentionItem['state'], resolution: string): void {
    const wasOpen = a.state === 'open';
    a.state = state;
    a.resolvedAt = now();
    a.resolution = resolution;
    // One state for every view: however it was settled (card, direct message, main agent),
    // the main agent's conversation records that it no longer waits on the user.
    const main = this.store.data.mainAgent;
    const worker = this.store.data.tasks.find((t) => t.taskId === a.taskId);
    if (wasOpen && main && worker && (a.kind === 'question' || a.kind === 'approval'))
      this.appendSystem(main.taskId, `${worker.alias}'s request is settled: ${clip(resolution, 160)}`);
  }

  private findOpenByRequest(taskId: string, requestId: string): AttentionItem | undefined {
    return this.store.data.attention.find((a) => a.taskId === taskId && a.providerRequestId === requestId && a.state === 'open');
  }

  private hasOpenNative(taskId: string): boolean {
    return this.store.data.attention.some((a) => a.taskId === taskId && a.state === 'open' && !!a.providerRequestId);
  }

  private expireNative(taskId: string, sessionLocalId: string, why: string): void {
    for (const a of this.store.data.attention)
      if (a.taskId === taskId && a.state === 'open' && a.providerRequestId && a.sessionLocalId === sessionLocalId) this.closeAttention(a, 'expired', why);
  }

  /** Answers a native approval / question through the provider's own request id. */
  async respondAttention(attentionId: string, decision?: string, answers?: Record<string, string>): Promise<void> {
    const a = this.store.data.attention.find((x) => x.id === attentionId);
    if (!a) throw new Error('Unknown attention item.');
    const answered = this.findTask(a.taskId);
    if (answered) this.touched(answered);
    if (a.state !== 'open') throw new Error(`This request is already ${a.state}.`);
    if (!a.providerRequestId) throw new Error('This report is answered by replying to the agent.');
    const live = this.live.get(a.taskId);
    if (!live || live.localId !== a.sessionLocalId) {
      this.closeAttention(a, 'expired', 'The session that asked this is no longer connected.');
      this.changed();
      throw new Error('That provider session is no longer connected; the request expired.');
    }
    if (a.kind === 'approval' && !a.options?.some((o) => o.id === decision)) throw new Error('Choose one of the provider-offered decisions.');
    await live.session.respond(a.providerRequestId, { decision, answers });
    const label = a.kind === 'approval' ? (a.options?.find((o) => o.id === decision)?.label ?? decision) : `Answered: ${clip(Object.values(answers ?? {}).join(', '), 80)}`;
    this.closeAttention(a, 'resolved', String(label));
    const task = this.task(a.taskId);
    if (!this.hasOpenNative(a.taskId)) task.status = live.turnActive ? 'running' : task.status;
    // The decision as data too (the session map shows it), not only as words.
    const chosen = a.kind === 'approval' ? String(label) : Object.values(answers ?? {}).join(', ');
    // The decision space: every option that was offered, the ones picked marked.
    const picked = new Set([decision, ...Object.values(answers ?? {}).flatMap((v) => String(v).split(/\s*,\s*/))].filter(Boolean).map(String));
    const offered = a.kind === 'approval' ? (a.options ?? []) : (a.questions ?? []).flatMap((q) => q.options);
    const options = offered.slice(0, 8).map((o) => ({ label: clip(o.label, 60), chosen: picked.has(o.id) || picked.has(o.label) }));
    this.appendSystem(a.taskId, `${a.kind === 'approval' ? 'Approval decision' : 'Answer'} sent to ${providerName(task.provider)}: ${label}`, {
      decision: { kind: a.kind === 'approval' ? 'approval' : 'answer', label: clip(chosen, 200), about: clip(a.headline, 200), ...(options.length ? { options } : {}), ...(a.kind === 'approval' && declinedOption(a.options?.find((o) => o.id === decision)) ? { declined: true } : {}) },
    });
    this.changed();
  }

  dismissAttention(attentionId: string): void {
    const a = this.store.data.attention.find((x) => x.id === attentionId);
    if (!a || a.state !== 'open') return;
    // Dismissing a native request does not answer it; the provider keeps waiting.
    if (a.providerRequestId) throw new Error('Native requests must be answered (allow/deny), not dismissed.');
    this.closeAttention(a, 'dismissed', 'Dismissed by user.');
    const task = this.task(a.taskId);
    if (task.status === 'waiting_for_user' && !this.store.data.attention.some((x) => x.taskId === a.taskId && x.state === 'open' && x.kind === 'question'))
      task.status = 'done';
    this.changed();
  }

  // ---------------------------------------------------------------- transcript

  private upsertTranscript(taskId: string, item: TranscriptItem, tool?: Partial<ToolCallInfo>): void {
    const items = this.store.transcript(taskId);
    const i = items.findIndex((x) => x.id === item.id);
    const merged = mergeItem(i === -1 ? undefined : items[i], item, tool);
    if (i === -1) items.push(merged);
    else items[i] = merged;
    this.store.touchTranscript(taskId);
    this.emitTranscript(taskId, merged);
  }

  /** A pending approval shows on its tool row, not as a separate transcript entry. */
  private markTool(taskId: string, toolCallId: string, status: TranscriptItem['toolStatus']): void {
    const item = this.store.transcript(taskId).find((x) => x.id === toolCallId && x.role === 'tool');
    if (!item || item.toolStatus === 'completed' || item.toolStatus === 'failed') return;
    item.toolStatus = status;
    this.store.touchTranscript(taskId);
    this.emitTranscript(taskId, item);
  }

  private appendSystem(taskId: string, text: string, extra: Partial<TranscriptItem> = {}): void {
    this.upsertTranscript(taskId, { id: `sys-${randomUUID()}`, taskId, role: 'system', text, createdAt: now(), ...extra });
  }

  private emitTranscript(taskId: string, item: TranscriptItem): void {
    for (const cb of this.transcriptListeners) cb(taskId, item);
  }

  // ---------------------------------------------------------------- routing

  routeContext(utterance: string, focusedTaskId: string | null): RouteContext {
    const d = this.store.data;
    return {
      utterance,
      focusedTaskId,
      projects: d.projects.map((p) => ({ projectId: p.projectId, name: p.name })),
      tasks: d.tasks.map((t) => ({
        taskId: t.taskId,
        alias: t.alias,
        name: t.name,
        nameSource: t.nameSource,
        title: t.title,
        projectId: t.projectId,
        projectName: d.projects.find((p) => p.projectId === t.projectId)?.name ?? '',
        provider: t.provider,
        status: t.status,
        summary: t.summary,
        pending: d.attention.filter((a) => a.taskId === t.taskId && a.state === 'open').map((a) => a.headline),
      })),
    };
  }

  /**
   * `namedOnly`: the main agent handles everything else, so only report an agent
   * named explicitly (no classifier call, no guessing).
   */
  async decideRoute(utterance: string, focusedTaskId: string | null, namedOnly = false): Promise<RouteDecision> {
    if (namedOnly) {
      const d = decideDeterministic(this.routeContext(utterance, null));
      // A named agent keeps its decision, including the sensitive-command confirmation.
      return d?.kind === 'existing' && /^explicitly named/.test(d.reason) ? d : { kind: 'coordinator', reason: 'for the main agent' };
    }
    const ai = this.opts.openai;
    return decideRoute(this.routeContext(utterance, focusedTaskId), ai ? (ctx) => ai.routeClassify(ctx) : undefined);
  }

  /** Sends a confirmed voice/coordinator utterance. The visual focus is never changed here. */
  async dispatch(
    utterance: string,
    target:
      | { kind: 'existing'; taskId: string }
      | { kind: 'coordinator' }
      | { kind: 'create'; projectId: string; provider: AgentProvider; title: string },
    focusedTaskId: string | null = null,
    opts: { interrupt?: boolean; typed?: boolean } = {},
  ): Promise<DispatchResult & { reply?: string }> {
    if (target.kind === 'existing') return this.send(target.taskId, utterance, opts.typed ? 'text' : 'voice', { interrupt: opts.interrupt });
    if (target.kind === 'create') {
      try {
        const task = await this.createTask({ projectId: target.projectId, provider: target.provider, title: target.title, instruction: utterance, isolate: true });
        this.coordinatorSay(`Started ${task.alias} (${task.provider}) for "${task.title}".`, utterance);
        return { ok: true, taskId: task.taskId };
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    }
    const reply = this.coordinatorAnswer(utterance, focusedTaskId);
    this.coordinatorSay(reply, utterance);
    this.changed();
    return { ok: true, reply };
  }

  private coordinatorSay(text: string, userText?: string): void {
    const d = this.store.data;
    if (userText) d.coordinator.push({ id: `c-${randomUUID().slice(0, 8)}`, createdAt: now(), role: 'user', text: userText } satisfies CoordinatorEntry);
    d.coordinator.push({ id: `c-${randomUUID().slice(0, 8)}`, createdAt: now(), role: 'coordinator', text });
    if (d.coordinator.length > 200) d.coordinator.splice(0, d.coordinator.length - 200);
  }

  /** Workspace-level answers, computed locally from the registry (no worker transcript is touched). */
  private coordinatorAnswer(utterance: string, focusedTaskId: string | null): string {
    const d = this.store.data;
    const memory = /^(记住|请记住|保存|remember|save)\s*[:：,，]?\s*/i;
    if (memory.test(utterance)) {
      const body = utterance.replace(memory, '').trim();
      const focused = d.tasks.find((t) => t.taskId === focusedTaskId);
      const global = /全局|所有项目|all (my )?projects|globally|\bglobal\b|everywhere|always for me/i.test(utterance);
      const projectScoped = /项目|仓库|repo|project/i.test(utterance);
      let scope: MemoryScope = 'task';
      let scopeId = focused?.taskId ?? '';
      if (global) {
        scope = 'global';
        scopeId = 'global';
      } else if (projectScoped && focused) {
        scope = 'project';
        scopeId = focused.projectId;
      } else if (projectScoped && d.projects.length === 1) {
        scope = 'project';
        scopeId = d.projects[0].projectId;
      }
      if (!scopeId) return 'Not saved: open a task first (or say "for this project" / "globally") so I know the scope.';
      const rec = this.addMemory({ scope, scopeId, body, originTaskId: focused?.taskId, approvedForReuse: scope !== 'task', source: 'voice' });
      const where = scope === 'global' ? 'global preferences' : scope === 'project' ? `project "${d.projects.find((p) => p.projectId === scopeId)?.name}"` : `${focused?.alias}'s task notes`;
      return `Saved to ${where}: "${clip(rec.body, 100)}". New sessions in that scope will load it; running sessions are not rewritten.`;
    }
    const open = d.attention.filter((a) => a.state === 'open');
    const lines = d.tasks.map((t) => {
      const items = open.filter((a) => a.taskId === t.taskId);
      return `${t.alias} (${t.name !== t.alias ? `${t.name}, ` : ''}${t.provider}) — ${t.status.replace(/_/g, ' ')}${items.length ? `; waiting on: ${items.map((a) => a.headline).join(' | ')}` : ''}`;
    });
    if (!lines.length) return 'No tasks yet. Say "start a new Claude task for …" or use New task.';
    return `${open.length} open item(s) across ${d.tasks.length} task(s):\n${lines.join('\n')}`;
  }

  // ---------------------------------------------------------------- memory

  addMemory(m: Omit<MemoryRecord, 'id' | 'updatedAt'>): MemoryRecord {
    const rec: MemoryRecord = { ...m, id: `m-${randomUUID().slice(0, 8)}`, updatedAt: now() };
    this.store.data.memory.push(rec);
    this.changed();
    this.schedulePush();
    return rec;
  }

  updateMemory(id: string, patch: { body?: string; title?: string; approvedForReuse?: boolean }): void {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m) throw new Error('Unknown memory record.');
    if (patch.body !== undefined) m.body = patch.body;
    if (patch.title !== undefined) m.title = patch.title;
    if (patch.approvedForReuse !== undefined) m.approvedForReuse = patch.approvedForReuse;
    m.updatedAt = now();
    this.changed();
    this.schedulePush();
  }

  deleteMemory(id: string): void {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (m) tombstone(this.store.data, m);
    this.store.data.memory = this.store.data.memory.filter((m) => m.id !== id);
    this.changed();
    this.schedulePush();
  }

  /** Explicit promotion: copies a note upward with provenance; the original stays. */
  promoteMemory(id: string, scope: 'project' | 'global'): MemoryRecord {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m) throw new Error('Unknown memory record.');
    let scopeId = 'global';
    if (scope === 'project') {
      const origin = m.originTaskId ?? (m.scope === 'task' ? m.scopeId : undefined);
      const task = this.store.data.tasks.find((t) => t.taskId === origin);
      if (m.scope === 'project') scopeId = m.scopeId;
      else if (task) scopeId = task.projectId;
      else throw new Error('Cannot tell which project this note belongs to.');
    }
    return this.addMemory({ scope, scopeId, body: m.body, originTaskId: m.originTaskId ?? (m.scope === 'task' ? m.scopeId : undefined), approvedForReuse: true, source: `promoted from ${m.scope} note ${m.id}` });
  }

  // ---------------------------------------------------------------- memory import / sync

  private lastScan = new Map<string, MemoryCandidate>();
  private memSync: { started: boolean; running: boolean; queued: boolean; timer?: NodeJS.Timeout } = { started: false, running: false, queued: false };

  /** One machine's native memory files in one round trip (read-only), as candidates. */
  private async scanMachine(host?: string): Promise<MemoryCandidate[]> {
    const r = host
      ? await sshRun(host, `sh -c ${shq(MEMORY_SCAN_SCRIPT)}`, 30_000)
      : await run('/bin/sh', ['-c', this.opts.home ? `HOME=${shq(this.opts.home)}; unset XDG_CONFIG_HOME\n${MEMORY_SCAN_SCRIPT}` : MEMORY_SCAN_SCRIPT], { timeoutMs: 30_000 });
    const out = parseScanOutput(r.stdout);
    if (!out.complete) throw new Error(host ? sshError(host, r.stderr) : r.stderr.trim() || 'Could not read the memory files.');
    return candidatesFrom(host, out.home, out.files, this.store.data.projects, out.shared);
  }

  /** This computer and every reachable enabled host; hosts that are not connected are reported, not waited for. */
  async scanMemoryImports(): Promise<{ candidates: MemoryCandidate[]; scanned: string[]; errors: Array<{ host: string; error: string }> }> {
    const errors: Array<{ host: string; error: string }> = [];
    const ready: Array<string | undefined> = [undefined];
    for (const h of this.enabledHosts()) {
      const st = this.hostStatus.get(h);
      if (st?.ssh === 'ok') ready.push(h);
      else errors.push({ host: h, error: st?.ssh === 'checking' || !st ? 'Still connecting.' : (st.error ?? 'Not connected.') });
    }
    const results = await Promise.all(
      ready.map((h) =>
        this.scanMachine(h)
          .then((candidates) => ({ host: h ?? LOCAL, candidates }))
          .catch((error: Error) => {
            errors.push({ host: h ?? LOCAL, error: error.message });
            return null;
          }),
      ),
    );
    const ok = results.filter((x) => x !== null);
    const candidates = markCandidates(ok.flatMap((x) => x.candidates), this.store.data);
    this.lastScan = new Map(candidates.map((c) => [c.key, c]));
    return { candidates, scanned: ok.map((x) => x.host), errors };
  }

  /** Explicit import of scanned notes (approved); re-importing a note updates its record. */
  importMemory(items: Array<{ key: string; scope: 'global' | 'project'; projectId?: string }>): number {
    const picks = items.map((i) => {
      const candidate = this.lastScan.get(i.key);
      if (!candidate) throw new Error('A picked note is no longer in the scan results. Scan again.');
      if (i.scope === 'project' && !this.store.data.projects.some((p) => p.projectId === i.projectId)) throw new Error('Pick a project for project memory.');
      return { candidate, scope: i.scope, scopeId: i.scope === 'project' ? i.projectId! : 'global' };
    });
    const n = importCandidates(this.store.data, picks).length;
    this.changed();
    this.schedulePush();
    return n;
  }

  /** Starts automatic user-memory sync: now and every `intervalMs` (and when a host becomes reachable). */
  startMemorySync(intervalMs = 10 * 60_000): void {
    this.memSync.started = true;
    clearInterval(this.memSync.timer);
    this.memSync.timer = setInterval(() => void this.syncMemory(), intervalMs);
    this.memSync.timer.unref?.();
    void this.syncMemory();
  }

  /**
   * Imports and refreshes user-level notes from every reachable machine (never project
   * notes: those stay manual). `manual` runs it even before startMemorySync (Sync now).
   */
  async syncMemory(manual = false): Promise<MemorySyncStatus | undefined> {
    // Linking a machine is the switch: with none linked, this reads nothing that matters.
    if (!manual && !this.memSync.started) return undefined;
    if (this.memSync.running) {
      this.memSync.queued = true;
      return undefined;
    }
    this.memSync.running = true;
    this.changed();
    try {
      const scan = await this.scanMemoryImports();
      // Only linked machines take part; others are linked once, from Settings › Memory.
      const linked = (h: string | undefined) => !!this.store.data.settings.memoryLinks?.[h ?? LOCAL];
      const counts = syncUserMemory(
        this.store.data,
        scan.candidates.filter((c) => linked(c.host)),
        scan.scanned.filter((h) => linked(h === LOCAL ? undefined : h)),
      );
      await this.pushMemory();
      this.store.data.memorySync = { at: now(), ...counts, hosts: scan.scanned, errors: scan.errors };
      this.lastScan = new Map(markCandidates([...this.lastScan.values()], this.store.data).map((c) => [c.key, c]));
    } catch (error) {
      this.log('memory sync failed', error);
    } finally {
      this.memSync.running = false;
      this.changed();
    }
    if (this.memSync.queued) {
      this.memSync.queued = false;
      void this.syncMemory(manual);
    }
    return this.store.data.memorySync;
  }

  // ---------------------------------------------------------------- user memory in the CLIs' files

  private shareResults = new Map<string, { lastWrite?: string; errors?: string[]; notices?: string[] }>();
  private pushTimer?: NodeJS.Timeout;
  /** Writes to the CLIs' files run one at a time (a link, a push, a restore never overlap). */
  private shareQueue: Promise<unknown> = Promise.resolve();
  private shareSerial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.shareQueue.then(fn, fn);
    this.shareQueue = next.catch(() => undefined);
    return next;
  }

  private reachable(host: string): boolean {
    return host === LOCAL || this.hostStatus.get(host)?.ssh === 'ok';
  }

  /** Soon after user memory changed in the app: the linked machines get it. */
  private schedulePush(): void {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.pushMemory(), 2000);
    this.pushTimer.unref?.();
  }

  /**
   * Writes the shared user memory to every linked, reachable machine (offline ones catch
   * up later), and finishes unlinking machines that were offline when the user unlinked them.
   */
  pushMemory(): Promise<void> {
    return this.shareSerial(() => this.doPush());
  }

  private async doPush(): Promise<void> {
    const links = this.store.data.settings.memoryLinks ?? {};
    for (const [h, link] of Object.entries(links)) {
      if (!this.reachable(h)) continue;
      if (link.unlinking) {
        await this.finishUnlink(h).catch((e: Error) => this.shareResults.set(h, { errors: [e.message] }));
        continue;
      }
      const r = await this.writeback.write(h, this.store.data.memory, 'sync').catch((e: Error) => ({ written: [], notices: [], errors: [e.message] }));
      this.shareResults.set(h, { lastWrite: r.written.length ? now() : this.shareResults.get(h)?.lastWrite, errors: r.errors.length ? r.errors : undefined, notices: r.notices.length ? r.notices : undefined });
    }
    this.changed();
  }

  /** Notes on a machine that linking would bring in: its user-level instruction files (Claude Code memory is project memory: not brought in). */
  private async incoming(host: string): Promise<MemoryCandidate[]> {
    const found = (await this.scanMachine(host === LOCAL ? undefined : host)).filter((c) => c.suggestedScope === 'global');
    return markCandidates(found, this.store.data).filter((c) => !c.alreadyImported && !c.dismissed);
  }

  /**
   * What linking a machine would do: the notes that would join the shared user memory,
   * and each of its CLI files before and after (nothing is changed).
   */
  async linkPreview(host: string): Promise<{ incoming: MemoryCandidate[]; files: Array<{ path: string; kind: string; exists: boolean; before: string; after: string | null }>; blocked: string[] }> {
    const incoming = await this.incoming(host);
    const after = [...this.store.data.memory, ...incoming.map((c, i) => ({ id: `preview-${i}`, scope: 'global' as const, scopeId: 'global', body: c.body, title: c.title, source: c.key, importKeys: [c.key], importedHash: bodyHash(c.body), approvedForReuse: true, updatedAt: now() }))];
    const files = await this.writeback.read(host);
    // Text another Agent Workspace keeps there is never overwritten: say so up front.
    const blocked = files.filter((f) => { const o = ownerOf(f.kind, f.content); return o && o !== this.writeback.owner; }).map((f) => f.file);
    const plan = planWriteback(files, after, this.writeback.owner, this.writeback.label);
    return { incoming, blocked, files: plan.map(({ file, next }) => ({ path: file.path, kind: file.kind, exists: file.exists, before: file.content, after: blocked.includes(file.file) ? null : next })) };
  }

  /**
   * The first sync with a machine: its notes join the shared user memory (instruction
   * files once, as notes the app then owns), its files
   * are backed up and the shared memory is written there.
   */
  linkMachine(host: string): Promise<{ added: number } & WriteResult> {
    return this.shareSerial(() => this.doLink(host));
  }

  private async doLink(host: string): Promise<{ added: number } & WriteResult> {
    const fresh = await this.incoming(host);
    const r = await this.writeback.write(host, [...this.store.data.memory, ...fresh.map((c, i) => ({ id: `link-${i}`, scope: 'global' as const, scopeId: 'global', body: c.body, title: c.title, source: c.key, importKeys: [c.key], importedHash: bodyHash(c.body), approvedForReuse: true, updatedAt: now() }))], 'link');
    // Nothing could be written (and nothing was): not linked, the notes stay where they are.
    if (!r.written.length && (r.errors.length || r.notices.length)) return { added: 0, ...r };
    const added = importCandidates(this.store.data, fresh.map((candidate) => ({ candidate, scope: 'global' as const, scopeId: 'global' }))).length;
    this.store.data.settings.memoryLinks = { ...this.store.data.settings.memoryLinks, [host]: { linkedAt: now() } };
    this.shareResults.set(host, { lastWrite: r.written.length ? now() : undefined, errors: r.errors.length ? r.errors : undefined, notices: r.notices.length ? r.notices : undefined });
    this.changed();
    // Machines linked earlier get the notes this one brought.
    if (added) this.schedulePush();
    return { added, ...r };
  }

  /**
   * Stops sharing with a machine: only the app's line, section and user.md are taken out
   * (backed up first). If the machine is offline, it stops getting updates now and is
   * cleaned up when it connects again.
   */
  async unlinkMachine(host: string): Promise<{ pending: boolean; notices: string[] }> {
    if (!this.reachable(host)) {
      const links = { ...this.store.data.settings.memoryLinks };
      if (links[host]) links[host] = { ...links[host], unlinking: true };
      this.store.data.settings.memoryLinks = links;
      this.changed();
      return { pending: true, notices: [] };
    }
    const notices = await this.shareSerial(() => this.finishUnlink(host));
    return { pending: false, notices };
  }

  private async finishUnlink(host: string): Promise<string[]> {
    const notices = await this.writeback.unlink(host);
    const links = { ...this.store.data.settings.memoryLinks };
    delete links[host];
    this.store.data.settings.memoryLinks = links;
    this.shareResults.delete(host);
    this.changed();
    return notices;
  }

  /** For a file the app stopped writing: write again, or first bring the notes found there into user memory. */
  async resolveShare(host: string, kind: TargetKind, how: 'resume' | 'adopt'): Promise<number> {
    const notes = await this.shareSerial(() => this.writeback.resolve(host, kind, how));
    // Compared as written in the file: unchanged blocks are skipped; a block whose title is a
    // note's title is that note, edited there (the user chose to keep it); the rest is new.
    const user = this.store.data.memory.filter((m) => m.scope === 'global');
    const known = new Set(user.map((m) => renderNotes([{ title: m.title, body: m.body }])));
    const titleOf = (block: string) => /^### (.*)$/m.exec(block)?.[1];
    let added = 0;
    for (const n of notes) {
      const block = renderNotes([n]);
      if (known.has(block)) continue;
      const title = titleOf(block);
      const same = title ? user.find((m) => titleOf(renderNotes([{ title: m.title, body: m.body }])) === title) : undefined;
      if (same) {
        const text = n.body.replace(/^#{1,6}\s+.*\n+/, '');
        const heading = /^(#{1,6}\s+.*)\n/.exec(same.body)?.[1];
        Object.assign(same, { body: heading ? `${heading}\n\n${text}` : text, updatedAt: now() });
        continue;
      }
      this.store.data.memory.push({ id: `m-${randomUUID().slice(0, 8)}`, scope: 'global', scopeId: 'global', body: n.body, title: n.title, source: 'user', approvedForReuse: true, updatedAt: now() });
      added++;
    }
    this.changed();
    void this.pushMemory();
    return added;
  }

  /** A note whose source changed after it was edited here: take the source's text, or keep this one. */
  resolveConflict(id: string, take: 'source' | 'mine'): void {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m || m.sourceBody === undefined) return;
    if (take === 'source') Object.assign(m, { body: m.sourceBody, importedHash: bodyHash(m.sourceBody) });
    // Keep the app's text: the source's current text counts as seen, so it is not offered again
    // (the note stays "edited", so later syncs leave it alone too).
    else m.importedHash = bodyHash(m.sourceBody);
    delete m.sourceBody;
    m.updatedAt = now();
    this.changed();
    this.schedulePush();
  }

  /** A retired note (its source was deleted on its machine) back into use. */
  restoreNote(id: string): void {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m) return;
    // It now belongs to the app: no source to follow (or retire it again).
    Object.assign(m, { sourceRemoved: false, importKeys: (m.importKeys ?? []).filter((k) => !k.startsWith('claude-memory|')), updatedAt: now() });
    this.changed();
    this.schedulePush();
  }

  shareTargets(host?: string): TargetState[] {
    return this.writeback.targets(host);
  }

  memoryBackups(host?: string): BackupEntry[] {
    return this.writeback.backups(host).slice().reverse();
  }

  memoryBackupContent(id: string): string {
    return this.writeback.backupContent(id);
  }

  async restoreMemoryBackup(id: string): Promise<void> {
    await this.shareSerial(() => this.writeback.restore(id));
    this.changed();
  }

  updateSettings(patch: Partial<Settings>): void {
    if (patch.memorySync && this.store.data.settings.memorySync === false) queueMicrotask(() => void this.syncMemory(true));
    Object.assign(this.store.data.settings, patch);
    this.applyModels();
    if ('mainAgent' in patch) this.syncMainAgent();
    this.changed();
  }

  // ---------------------------------------------------------------- main agent

  private providerReady(p: AgentProvider): boolean {
    const c = this.capabilities.find((x) => x.provider === p);
    return !!c?.available && c.auth?.loggedIn !== false;
  }

  /**
   * Keeps the main agent in line with Settings: created on the chosen (or first
   * ready) CLI, replaced when the choice changes, removed when turned off.
   */
  private syncMainAgent(): void {
    const d = this.store.data;
    if (!this.capabilities.length) return; // not probed yet: keep what we have
    const setting = (process.env.AMW_MAIN_AGENT as Settings['mainAgent']) || d.settings.mainAgent;
    const want = pickMainProvider(setting, (p) => this.providerReady(p));
    const cur = d.mainAgent;
    if (cur && cur.provider === want) return;
    if (cur) {
      void this.stop(cur.taskId).catch(() => {});
      d.mainAgent = undefined;
    }
    if (want) {
      const cwd = join(this.opts.dataDir, 'main-agent');
      mkdirSync(cwd, { recursive: true });
      d.mainAgent = {
        taskId: `t-main-${randomUUID().slice(0, 6)}`,
        alias: 'Main',
        name: 'Main',
        projectId: '',
        title: 'Main agent',
        provider: want,
        status: 'idle',
        summary: 'Ready. Tell me what you need; I will pass it to the right agent.',
        cwd,
        createdAt: now(),
        updatedAt: now(),
      };
    }
    this.changed();
  }

  // MainAgentHost: what the main agent's tools can do.
  private mainTurns = 0;
  private pendingHandover?: string;

  /**
   * A new chapter of the main agent's conversation: its session ends (the next message starts a
   * fresh one), a marker goes in the conversation (the earlier part stays to read), and the
   * next message carries a hand-over of what is going on now, not the whole past.
   */
  async newMainChapter(reason: 'manual' | 'idle' | 'long'): Promise<void> {
    const main = this.store.data.mainAgent;
    if (!main) throw new Error('The main agent is off.');
    const items = this.store.transcript(main.taskId);
    if (!items.slice(chapterStart(items)).some((x) => x.role === 'user')) return; // nothing to close
    await this.stop(main.taskId).catch(() => {});
    main.sessionLocalId = undefined;
    main.summary = '';
    this.appendSystem(main.taskId, 'New chapter', { chapter: { reason } });
    this.pendingHandover = this.handover();
    this.changed();
  }

  /** What is going on now, for the main agent's fresh session. */
  private handover(): string {
    const d = this.store.data;
    const open = d.attention.filter((a) => a.state === 'open' && a.kind !== 'completion');
    const now = Date.now();
    const going = d.tasks.filter((t) => !t.setAside && (t.status === 'running' || t.status === 'starting' || open.some((a) => a.taskId === t.taskId) || now - Date.parse(t.updatedAt) < IDLE_NEW));
    const project = (id: string) => d.projects.find((p) => p.projectId === id)?.name ?? '';
    const lines = going.map((t) => `- ${t.alias} (${project(t.projectId)}, ${t.name || t.title}): ${t.status}${open.some((a) => a.taskId === t.taskId) ? ', waiting on the user' : ''}${t.summary ? ` — ${clip(t.summary, 140)}` : ''}`);
    return [
      '[A new chapter of your conversation with the user starts here. The earlier conversation is not carried over; use the workspace tools for anything else.]',
      lines.length ? `What is going on now:\n${lines.join('\n')}` : 'No agent is working or waiting right now.',
    ].join('\n');
  }

  private commandTimeoutMs(): number {
    const min = this.store.data.settings.commandTimeoutMin;
    return min ? min * 60_000 : SHELL_TIMEOUT_MS;
  }

  mainLimits(): { calls?: number; forks?: number } {
    const s = this.store.data.settings;
    return { calls: s.mainCallsPerTurn, forks: s.mainForksPerTurn };
  }

  mainTurn(): number {
    return this.mainTurns;
  }

  /** Runs read-only git / ls commands in a folder here or on its SSH host; output clipped for the main agent. */
  private async peek(host: string | undefined, dir: string, commands: string[][]): Promise<string[]> {
    if (host) {
      const sep = '__AMW_PEEK__';
      const script = commands.map((c) => `${c.map(shq).join(' ')} 2>/dev/null; printf '\\n${sep}\\n'`).join('; ');
      const r = await sshRun(host, `cd ${shq(dir)} && { ${script}; }`, 20_000);
      if (r.code !== 0 && !r.stdout) throw new Error(sshError(host, r.stderr));
      return r.stdout.split(`\n${sep}\n`).map((x) => x.trim());
    }
    return Promise.all(commands.map(async ([cmd, ...args]) => (await run(cmd, args, { cwd: dir, timeoutMs: 15_000 })).stdout.trim()));
  }

  async projectOverview(projectId: string): Promise<string> {
    const p = this.store.data.projects.find((x) => x.projectId === projectId);
    if (!p) return 'Unknown project.';
    const [files, branch, status, log, readme] = await this.peek(p.host, p.rootPath, [
      ['ls', '-1Ap'],
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      ['git', 'status', '--porcelain'],
      ['git', 'log', '-5', '--format=%h %s (%cr)'],
      ['sh', '-c', 'for f in README.md readme.md README.rst README.txt README; do [ -f "$f" ] && head -c 1500 "$f" && break; done'],
    ]).catch((e: Error) => [`Could not read the folder: ${e.message}`]);
    const top = files.split('\n').filter(Boolean);
    return [
      `${p.name} — ${p.host ? `${p.host}:` : ''}${p.rootPath}`,
      branch ? `branch ${branch}; ${status ? status.split('\n').length : 0} uncommitted file(s)` : 'not a git repository',
      `top level (${top.length}): ${top.slice(0, 60).join('  ')}${top.length > 60 ? '  …' : ''}`,
      ...(log ? [`recent commits:\n${log}`] : []),
      ...(readme ? [`README (start):\n${clip(readme, 1500)}`] : []),
    ].join('\n');
  }

  async agentChanges(taskId: string): Promise<string> {
    const t = this.task(taskId);
    const dir = t.worktree?.path ?? t.cwd;
    const base = t.worktree?.baseRef ?? 'HEAD';
    const [stat, status, log] = await this.peek(t.host, dir, [
      ['git', 'diff', '--stat=100', base],
      ['git', 'status', '--short'],
      ['git', 'log', '--oneline', '-20', `${base}..HEAD`],
    ]).catch((e: Error) => [`Could not read ${t.alias}'s folder: ${e.message}`]);
    const untracked = status?.split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3)) ?? [];
    if (!stat && !untracked.length && !log) return `${t.alias} has not changed any files${t.worktree ? ` on ${t.worktree.branch}` : ''}.`;
    return [
      `${t.alias} in ${dir}${t.worktree ? ` (branch ${t.worktree.branch})` : ' (shared folder: changes may include others\u2019)'}`,
      ...(stat ? [clip(stat, 2500)] : []),
      ...(untracked.length ? [`new files: ${untracked.slice(0, 30).join(', ')}`] : []),
      ...(log ? [`commits:\n${log}`] : []),
    ].join('\n');
  }

  listAgents() {
    const d = this.store.data;
    return d.tasks.map((t) => ({
      task: t,
      projectName: d.projects.find((p) => p.projectId === t.projectId)?.name ?? '',
      pending: d.attention.filter((a) => a.taskId === t.taskId && a.state === 'open' && a.kind !== 'completion').map((a) => clip(a.headline, 160)),
      connected: this.live.has(t.taskId),
    }));
  }

  listProjects() {
    return this.store.data.projects.map((p) => ({ projectId: p.projectId, name: p.name, rootPath: p.host ? `${p.host}:${p.rootPath} (over SSH)` : p.rootPath }));
  }

  findAgent(name: string): Task | undefined {
    const n = name.trim().toLowerCase();
    const tasks = this.store.data.tasks;
    const exact = tasks.find((t) => t.alias.toLowerCase() === n || `${t.name} ${t.alias}`.toLowerCase() === n || `${t.name}${t.alias}`.toLowerCase() === n);
    if (exact) return exact;
    const byRole = tasks.filter((t) => t.name.toLowerCase() === n);
    return byRole.length === 1 ? byRole[0] : undefined;
  }

  transcriptText(taskId: string, limit: number): string {
    return this.store
      .transcript(taskId)
      .filter((i) => i.role !== 'thought')
      .slice(-limit)
      .map((i) => {
        if (i.role === 'tool') {
          const out = (i.tool?.content ?? [])
            .map((c) => (c.type === 'diff' ? `diff ${c.diff.path} +${c.diff.added}/-${c.diff.removed}` : c.type === 'terminal' ? `$ ${c.command}\n${clip(c.output, 600)}` : ''))
            .filter(Boolean)
            .join('\n');
          return `[tool${i.toolStatus ? ` ${i.toolStatus}` : ''}] ${i.tool?.title ?? i.toolLabel ?? ''}${out ? `\n${out}` : ''}`;
        }
        const who = i.role === 'user' ? (i.via === 'main' ? 'main agent' : 'user') : i.role;
        return `[${who}] ${clip(i.text, 1500)}`;
      })
      .join('\n\n');
  }

  sendFromMain(taskId: string, text: string, interrupt: boolean, withImages = false) {
    return this.send(taskId, text, 'main', { interrupt, images: withImages ? this.userImages() : undefined });
  }

  /** The images in the user's latest message to the main agent: what it passes on when it says so (send_to_agent / create_agent / fork_agent with images). */
  private userImages(): ImageRef[] | undefined {
    const main = this.store.data.mainAgent;
    if (!main) return undefined;
    const last = this.store.transcript(main.taskId).findLast((i) => i.role === 'user' && i.via !== 'main');
    return last?.images?.filter((r) => r.id && this.attachments.has(r.id));
  }

  /**
   * The main agent forks an agent to branch off work: the whole conversation as it is now, or from
   * just before an earlier prompt (matched by its start). In its own worktree when the project is a
   * git repository, and never with more permissions than the workspace default, which only the user can raise.
   */
  async forkFromMain(taskId: string, args: { instruction: string; beforePrompt?: string; label?: string; withImages?: boolean; provider?: AgentProvider }): Promise<{ task: Task; delivery: DispatchResult }> {
    const src = this.task(taskId);
    let upToMessageId: string | undefined;
    // Whitespace as read_agent and the error below show it: collapsed.
    const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    const want = args.beforePrompt ? norm(args.beforePrompt) : '';
    if (want) {
      const points = await this.forkPoints(taskId);
      const hits = points.filter((p) => norm(p.prompt).startsWith(want));
      const listed = points.map((p) => `"${clip(p.prompt.replace(/\s+/g, ' '), 80)}"`).join(', ');
      if (hits.length !== 1)
        throw new Error(
          `${hits.length ? 'Several' : 'None'} of ${src.alias}'s earlier prompts start with "${args.beforePrompt!.trim()}". ` +
            (points.length ? `Its earlier prompts: ${listed}.` : `${src.alias} has no earlier prompt to fork before; omit before_prompt to fork it as it is now.`),
        );
      upToMessageId = hits[0].upToMessageId;
    }
    const RANK: Record<PermissionMode, number> = { ask: 0, edits: 1, auto: 2 };
    const fallback = this.store.data.settings.permissionMode ?? 'auto';
    const permissionMode = src.permissionMode && RANK[src.permissionMode] <= RANK[fallback] ? src.permissionMode : undefined;
    const task = await this.forkTask(taskId, { upToMessageId, isolate: true, name: args.label, permissionMode, provider: args.provider });
    if (!args.label?.trim()) void this.refineLabel(task, `${args.instruction}\n(branched off: ${src.name})`);
    return { task, delivery: await this.send(task.taskId, args.instruction, 'main', { images: args.withImages ? this.userImages() : undefined }) };
  }

  async createFromMain(args: { projectId: string; provider: AgentProvider; title: string; instruction?: string; label?: string; withImages?: boolean }): Promise<Task> {
    const { withImages, ...rest } = args;
    return this.createTask({ ...rest, name: args.label, nameSource: 'auto', isolate: true, images: withImages ? this.userImages() : undefined });
  }

  async stopFromMain(taskId: string): Promise<void> {
    await this.interrupt(taskId);
  }

  saveMemory(scope: 'project' | 'global', body: string, projectId?: string): void {
    this.addMemory({ scope, scopeId: scope === 'project' ? projectId! : 'global', body, approvedForReuse: true, source: 'main agent' });
  }

  listRequests() {
    const d = this.store.data;
    return d.attention
      .filter((a) => a.state === 'open' && a.kind !== 'completion' && d.tasks.some((t) => t.taskId === a.taskId))
      .map((a) => ({ item: a, agent: d.tasks.find((t) => t.taskId === a.taskId)!.alias }));
  }

  /** The user's latest message to the main agent: the only source of a permission decision it may pass on. */
  lastUserWordsToMain(): string {
    const main = this.store.data.mainAgent;
    if (!main) return '';
    return [...this.store.transcript(main.taskId)].reverse().find((i) => i.role === 'user' && i.via !== 'main')?.text ?? '';
  }

  async answerFromMain(attentionId: string, args: { choice?: string; answer?: string; userWords?: string }): Promise<string> {
    const a = this.store.data.attention.find((x) => x.id === attentionId);
    if (!a || a.state !== 'open') return 'That request is no longer open (answered, expired or unknown). Call list_requests.';
    const task = this.task(a.taskId);
    if (!a.providerRequestId) {
      // The agent asked in its reply: answering means replying to it.
      if (!args.answer?.trim()) return 'Pass answer: the reply to send to the agent.';
      const r = await this.send(a.taskId, args.answer, 'main');
      return r.ok ? `Replied to ${task.alias}.` : `Not delivered: ${r.error}`;
    }
    if (a.kind === 'question') {
      const qs = a.questions ?? [];
      if (!args.answer?.trim() || !qs.length) return 'Pass answer (for several questions, one answer per line in order).';
      const parts = qs.length > 1 ? args.answer.split('\n').map((s) => s.trim()) : [args.answer.trim()];
      await this.respondAttention(attentionId, 'answer', Object.fromEntries(qs.map((q, i) => [q.id, parts[i] ?? ''])));
      return `Answered ${task.alias}'s question.`;
    }
    // Permission request: refusing is always allowed; allowing must be the user's own, explicit words.
    const opt = (a.options ?? []).find((o) => o.id === args.choice || o.label.toLowerCase() === String(args.choice ?? '').toLowerCase());
    if (!opt) return `Choose one of: ${(a.options ?? []).map((o) => `${o.id} (${o.label})`).join(', ')}.`;
    const refusing = (opt.kind ?? '').startsWith('reject') || /deny|decline|cancel|keep planning/i.test(`${opt.id} ${opt.label}`);
    if (!refusing) {
      const said = this.lastUserWordsToMain();
      const words = (args.userWords ?? '').trim();
      const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ');
      if (!words || !norm(said).includes(norm(words)))
        return 'Not allowed: quote, in user_words, the user’s own words from their latest message that approve this. If they have not said so, ask them.';
      if (!APPROVAL.test(words) || NEGATION.test(words)) return 'Those words do not clearly approve the request. Ask the user to confirm, or have them approve it on the agent’s card.';
    }
    await this.respondAttention(attentionId, opt.id);
    return `${opt.label} — sent to ${task.alias}.`;
  }

  availableProviders(): AgentProvider[] {
    return CODING_PROVIDERS.filter((p) => this.providerReady(p));
  }

  // ---------------------------------------------------------------- file preview

  /** Folders a task's files may be previewed from: its cwd, its worktree, its project. */
  private previewRoots(t: Task): string[] {
    // The main agent talks about every agent's files: any project or agent folder on this computer.
    if (t === this.store.data.mainAgent)
      return [t.cwd, ...this.store.data.projects.filter((p) => !p.host).map((p) => p.rootPath), ...this.store.data.tasks.filter((x) => !x.host).flatMap((x) => [x.cwd, x.worktree?.path])].filter((r): r is string => !!r);
    const project = this.store.data.projects.find((p) => p.projectId === t.projectId);
    return [t.cwd, t.worktree?.path, project?.rootPath].filter((r): r is string => !!r);
  }

  /** Where to look for a file an agent named, and which files it may show without asking. */
  private previewWhere(t: Task, allowOutside?: boolean): PreviewWhere {
    return { cwd: t.cwd, bases: workDirs(this.store.transcript(t.taskId), t.cwd, t.host ? posix : undefined), roots: this.previewRoots(t), allowOutside };
  }

  async previewFile(taskId: string, path: string, allowOutside?: boolean): Promise<FilePreview> {
    const t = this.task(taskId);
    const where = this.previewWhere(t, allowOutside);
    return t.host ? readRemote(t.host, path, where) : readLocal(path, where);
  }

  /** The checked local path to hand to the default app (this computer only). */
  /** The folder "Open with…" opens for an agent: its worktree or folder (the main agent's own too). On this computer only. */
  agentFolder(taskId: string): string {
    const t = this.task(taskId);
    if (t.host) throw new Error(`${t.alias} works on ${t.host}; its folder is there.`);
    return t.cwd;
  }

  previewLocalPath(taskId: string, path: string, allowOutside?: boolean): string {
    const t = this.task(taskId);
    if (t.host) throw new Error(`The file is on ${t.host}; it can only be previewed here.`);
    return localPath(path, this.previewWhere(t, allowOutside));
  }

  // ---------------------------------------------------------------- demo

  /** Creates a self-contained demo repo and three mock agents matching the spec's script. */
  async seedDemo(demoRepoPath: string): Promise<void> {
    const project = await this.addProject(demoRepoPath, 'demo-shop');
    // A filled-in research to look at (no agents behind it).
    if (!readResearch(project)) {
      const sample = sampleResearch(this.language());
      writeResearch(project, sample);
      writeSampleNotes(project, sample, this.language());
      this.researchIndex.delete(project.projectId);
    }
    // Labels come from the titles (the demo asks no model).
    const mk = (provider: AgentProvider, title: string, mockScript: string, instruction: string) =>
      this.createTask({ projectId: project.projectId, provider, title, mockScript, instruction, isolate: true });
    if (this.store.data.settings.language === 'zh') {
      await mk('mock', '后端 API v2 接口', 'ask:旧的 /v1/orders 接口还有测试在用。要保留一层兼容适配，还是把测试改成 v2？', '把订单接口迁移到 API v2。');
      await mk('mock', '前端看板组件', 'work', '实现看板组件。');
      await mk('mock', '数据库结构迁移', 'ask:这次迁移会删除旧的 `orders.notes` 列，里面有 1,204 行数据，有丢数据的风险。直接执行，还是先加一步数据回填？', '为新的订单表写数据库迁移。');
      return;
    }
    await mk('mock', 'Backend API v2 endpoints', 'ask:Legacy tests depend on the old /v1/orders API. Should I keep a compatibility adapter, or update the tests to v2?', 'Migrate the orders endpoints to API v2.');
    await mk('mock', 'Frontend dashboard components', 'work', 'Build the dashboard components.');
    await mk('mock', 'Database schema migration', 'ask:The schema migration drops the legacy `orders.notes` column, which has data in 1,204 rows. That is a data-loss risk. Should I proceed, or add a backfill step first?', 'Write the schema migration for the new orders table.');
  }
}

/** Merge-by-id: later events refine a tool call (label, status, applied diff, output). */
function mergeItem(prev: TranscriptItem | undefined, item: TranscriptItem, tool?: Partial<ToolCallInfo>): TranscriptItem {
  const baseTool = prev?.tool ?? (tool ? { name: '', kind: 'other' as const, title: '', locations: [], content: [] } : undefined);
  const mergedTool = tool && baseTool ? { ...baseTool, ...Object.fromEntries(Object.entries(tool).filter(([, v]) => v !== undefined)) } : baseTool;
  const next: TranscriptItem = prev
    ? { ...prev, ...item, text: item.text || prev.text, toolLabel: item.toolLabel ?? prev.toolLabel, toolStatus: item.toolStatus ?? prev.toolStatus, createdAt: prev.createdAt }
    : { ...item, toolStatus: item.toolStatus ?? (item.role === 'tool' ? 'running' : undefined) };
  if (mergedTool) {
    next.tool = mergedTool;
    if (!next.toolLabel || tool?.title) next.toolLabel = mergedTool.title || next.toolLabel;
  }
  return next;
}

/** Adds a usage event to an agent's totals (kept across its sessions); context is replaced, not added. */
export function addUsage(prev: TaskUsage | undefined, event: Extract<ProviderEvent, { type: 'usage' }>): TaskUsage {
  const u: TaskUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, ...prev, updatedAt: now() };
  const a = event.add;
  if (a) {
    for (const k of ['input', 'cacheWrite', 'cacheRead', 'output', 'reasoning'] as const) u[k] += Math.max(0, a[k] ?? 0);
    if (a.costUsd !== undefined) u.costUsd = (u.costUsd ?? 0) + Math.max(0, a.costUsd);
  }
  if (event.context !== undefined) u.context = event.context;
  if (event.contextWindow !== undefined) u.contextWindow = event.contextWindow;
  return u;
}

/** An account's latest limits recorded (an account: the task's provider on its machine), the others kept. */
export function withLimits(all: Record<string, ProviderLimits>, task: Pick<Task, 'provider' | 'host'>, windows: LimitWindow[], plan?: string): Record<string, ProviderLimits> {
  const key = accountKey(task);
  return { ...all, [key]: { ...mergeLimits(all[key], windows, plan), provider: task.provider, ...(task.host ? { host: task.host } : {}) } };
}

/** The latest limits replace the windows they name; windows not mentioned are kept. */
export function mergeLimits(prev: ProviderLimits | undefined, windows: LimitWindow[], plan?: string): ProviderLimits {
  const keep = (prev?.windows ?? []).filter((w) => !windows.some((n) => n.key === w.key));
  return { windows: [...windows, ...keep].sort((a, b) => (a.mins ?? Infinity) - (b.mins ?? Infinity)), at: now(), ...((plan ?? prev?.plan) ? { plan: plan ?? prev?.plan } : {}) };
}

/** An approval option that refuses (by its kind, or for providers without kinds by its label). */
export function declinedOption(o: { kind?: string; label: string } | undefined): boolean {
  if (!o) return false;
  return o.kind ? o.kind.startsWith('reject') : /^(deny|reject|decline|no\b|don.t)/i.test(o.label.trim());
}

/** A provider as people know it (Claude Code, Codex, OpenCode…), for messages. */
export function providerName(provider: string): string {
  return acpAgent(provider)?.label ?? ({ claude: 'Claude Code', codex: 'Codex', mock: 'Mock' } as Record<string, string>)[provider] ?? provider;
}

/**
 * A saved user message that carries a copied conversation (a fork onto another CLI, or one where the
 * CLI copies sessions as text) is shown as that conversation, then the message that came with it.
 */
function copiedItems(taskId: string, e: Extract<ProviderEvent, { type: 'transcriptItem' }>): TranscriptItem[] | undefined {
  const copy = e.role === 'user' ? parseCopy(e.text) : undefined;
  if (!copy) return undefined;
  const at = now();
  const items: TranscriptItem[] = copy.lines.flatMap((l, i) =>
    l.role === 'tool' ? [] : [{ id: `${e.itemId}-copy-${i}`, taskId, role: l.role, text: l.text, createdAt: at }],
  );
  if (copy.rest) items.push({ id: e.itemId, taskId, role: 'user', text: copy.rest, createdAt: at });
  return items;
}

/**
 * Where a conversation is cut for a fork onto another CLI: just before the user message that the fork
 * point names (its prompt; the same text asked again counts in order). Fork points start at the second prompt.
 */
export function forkCut(items: Pick<TranscriptItem, 'role' | 'text'>[], points: ForkPoint[], upToMessageId: string): number | undefined {
  const at = points.findIndex((p) => p.upToMessageId === upToMessageId);
  if (at === -1) return undefined;
  const same = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
  const prompt = points[at].prompt;
  const nth = points.slice(0, at).filter((p) => same(p.prompt, prompt)).length;
  const users = items.flatMap((i, n) => (i.role === 'user' ? [n] : []));
  return users.slice(1).filter((n) => same(items[n].text, prompt))[nth];
}
