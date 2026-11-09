import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type {
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
  RemoteHostStatus,
  RouteDecision,
  SessionRecord,
  Settings,
  Task,
  ToolCallInfo,
  TranscriptItem,
  TransientKind,
  WorkspaceSnapshot,
} from '../shared/types';
import { clipOutput } from '../shared/content';
import { asksUser, clip, headlineFor, summaryFor } from './attention';
import { instructionsFor, memoryForTask } from './memory';
import { candidatesFrom, importCandidates, LOCAL, markCandidates, MEMORY_SCAN_SCRIPT, parseScanOutput, syncUserMemory, tombstone } from './memory-import';
import type { OpenAiClient } from './openai';
import type { LocalStt } from './stt/local';
import { STT_MODEL, ROUTER_MODEL } from './openai';
import type { ProviderAdapter, ProviderEvent, ProviderSession } from './providers/types';
import { CONTINUE_PROMPT, DEFAULT_RETRY, RETRY_LABEL, RETRY_PROMPT, retryDelayMs, type RetryPolicy } from './retry';
import { decideDeterministic, decideRoute, type RouteContext } from './router';
import { aliasFor, JsonStore } from './store';
import { cleanRole, guessRole, projectRole, rolePrompt, roleRetry } from './role';
import { MAIN_AGENT_PROMPT, pickMainProvider, workspaceTools } from './main-agent';
import { gitRoot, WorktreeService } from './worktree';
import { localPath, readLocal, readRemote } from './preview';
import { run } from './util/exec';
import { MemoryWriteback, plan as planWriteback, type BackupEntry } from './memory-writeback';
import { parseRemoteScan, remoteScanScript, scanLocal, SkillLibrary, type FoundSkill } from './skills';
import { loadKeychainKeys, openInTerminal, shq, sshConnect, sshError, sshHostEntries, sshHosts, sshProbe, sshRun, unlockKeys, type SshHostEntry } from './util/ssh';

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
}

/** A `!command` the user typed is stopped after this long. */
const SHELL_TIMEOUT_MS = 10 * 60_000;
/** How much of a command's output goes to the agent with the next message. */
const SHELL_CONTEXT_CHARS = 20_000;

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
  /** Home folder whose native memory files this Mac's scan reads (tests); default $HOME. */
  home?: string;
  /** Replaces the CLIs' one-shot answers for background jobs (tests). */
  backgroundModel?: (system: string, prompt: string) => Promise<string>;
}

/**
 * The local backend (spec 03): task + session registry, durable attention queue,
 * routing, scoped memory and provider lifecycle. Framework-free so it can be
 * tested without Electron; the Electron layer only forwards IPC and events.
 */
export class Workspace {
  readonly store: JsonStore;
  private live = new Map<string, LiveSession>(); // taskId -> live provider session
  /** `!command` output not yet handed to the agent (providers without their own shell). */
  private shellOutput = new Map<string, string[]>();
  private connecting = new Map<string, Promise<LiveSession>>();
  private capabilities: ProviderCapabilities[] = [];
  private hostStatus = new Map<string, RemoteHostStatus>();
  private changeListeners = new Set<() => void>();
  /** item === null means "the whole transcript was replaced; reload it". */
  private transcriptListeners = new Set<(taskId: string, item: TranscriptItem | null) => void>();
  private worktrees: WorktreeService;
  private log: (...args: unknown[]) => void;
  private retryPolicy: RetryPolicy;
  /** taskId → the try in progress or waiting (2 = first retry) of the last instruction, and its timer while waiting. */
  private retries = new Map<string, { attempt: number; timer?: NodeJS.Timeout }>();

  /** The skill library loaded into every agent the app starts (see skills.ts). */
  readonly skills: SkillLibrary;
  private writeback: MemoryWriteback;

  constructor(private opts: WorkspaceOptions) {
    this.store = new JsonStore(opts.dataDir);
    this.skills = new SkillLibrary(opts.dataDir);
    this.writeback = new MemoryWriteback(opts.dataDir, opts.home);
    this.worktrees = new WorktreeService(join(opts.dataDir, 'worktrees'));
    this.log = opts.log ?? (() => {});
    this.retryPolicy = { ...DEFAULT_RETRY, ...opts.retry };
    this.applyModels();
    this.recoverAfterRestart();
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
    for (const t of [...d.tasks, ...(d.mainAgent ? [d.mainAgent] : [])]) {
      this.handBackRetry(t);
      if (['running', 'starting'].includes(t.status) || (t.status === 'waiting_for_user' && this.hasOpenNative(t.taskId))) {
        t.status = 'disconnected';
        t.summary = t.summary ? `${t.summary} (app restarted — resume to continue)` : 'App restarted — resume to continue';
      }
    }
    // Native approvals/questions die with the provider process: never show them as still answerable.
    for (const a of d.attention) {
      if (a.state === 'open' && a.providerRequestId) {
        a.state = 'expired';
        a.resolvedAt = now();
        a.resolution = 'The provider process ended (app restart) before this was answered.';
      }
    }
    this.store.save();
  }

  async refreshCapabilities(): Promise<void> {
    const caps: ProviderCapabilities[] = [];
    for (const a of Object.values(this.opts.adapters)) {
      if (!a) continue;
      try {
        caps.push(await a.capabilities());
      } catch (error) {
        this.log('capabilities failed', a.provider, error);
      }
    }
    this.capabilities = caps;
    this.syncMainAgent();
    this.changed();
    void this.refreshHosts();
  }

  // ---------------------------------------------------------------- remote hosts

  /** Hosts enabled in Settings that are still in ~/.ssh/config. */
  private enabledHosts(): string[] {
    const known = sshHosts();
    return (this.store.data.settings.remoteHosts ?? []).filter((h) => known.includes(h));
  }

  private requireHost(host: string): void {
    if (!this.enabledHosts().includes(host)) throw new Error(`${host} is not enabled in Settings › Remote machines.`);
  }

  /** Background check of every enabled host (keys saved in the Keychain are reloaded first). */
  async refreshHosts(): Promise<void> {
    const hosts = this.enabledHosts();
    if (!hosts.length) return;
    await loadKeychainKeys();
    await Promise.all(hosts.map((h) => this.checkHost(h).catch((error) => this.log('host check failed', h, error))));
  }

  /** Whether `host` is reachable without prompting, and Claude Code / Codex there. Never prompts. */
  async checkHost(host: string): Promise<RemoteHostStatus> {
    const prev = this.hostStatus.get(host);
    this.hostStatus.set(host, { host, ssh: 'checking', capabilities: prev?.capabilities ?? [] });
    this.changed();
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
    if (this.enabledHosts().includes(host)) this.hostStatus.set(host, status);
    this.changed();
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
    if (cap?.auth?.loggedIn === false) throw new Error(`${provider === 'claude' ? 'Claude Code' : 'Codex'} on ${host} is not signed in. Sign in there once (${provider === 'claude' ? 'claude' : 'codex login'}), then recheck.`);
  }

  async shutdown(): Promise<void> {
    clearInterval(this.memSync.timer);
    this.memSync.started = false;
    // Detach first so close-time events are dropped; restart recovery then marks state honestly.
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    const sessions = [...this.live.values()];
    this.live.clear();
    for (const l of sessions) await l.session.close().catch(() => {});
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

  private changed(): void {
    this.store.save();
    for (const cb of this.changeListeners) cb();
  }

  snapshot(): WorkspaceSnapshot {
    const d = this.store.data;
    return {
      projects: d.projects,
      tasks: d.tasks,
      sessions: d.sessions,
      attention: d.attention,
      memory: d.memory,
      memorySync: { running: this.memSync.running, last: d.memorySync },
      memoryShare: Object.fromEntries(Object.entries(d.settings.memoryLinks ?? {}).map(([h, l]) => [h, { ...l, ...this.shareResults.get(h) }])),
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

  async createTask(args: {
    projectId: string;
    provider: AgentProvider;
    title: string;
    /** Who chose `name` (default: the user, who typed it). */
    nameSource?: 'auto' | 'user';
    name?: string;
    instruction?: string;
    isolate: boolean;
    mockScript?: string;
  }): Promise<Task> {
    const project = this.project(args.projectId);
    if (!this.opts.adapters[args.provider]) throw new Error(`Provider ${args.provider} is not available.`);
    if (project.host) this.requireOnHost(args.provider, project.host);
    const d = this.store.data;
    const alias = aliasFor(d.aliasCounter++, d.settings.language);
    const taskId = `t-${randomUUID().slice(0, 8)}`;
    let cwd = project.rootPath;
    let worktree: Task['worktree'];
    let sharedCwdWarning: string | undefined;
    if (args.isolate && project.isGitRepo && project.host) {
      sharedCwdWarning = `Worktrees are not created on SSH hosts yet; this task edits ${cwd} on ${project.host} directly.`;
    } else if (args.isolate && project.isGitRepo) {
      try {
        worktree = await this.worktrees.create(project.rootPath, project.projectId, `${slugify(args.name || args.title)}-${taskId.slice(2)}`);
        cwd = worktree.path;
      } catch (error) {
        sharedCwdWarning = `Worktree not created (${(error as Error).message}); this task edits ${cwd} directly.`;
      }
    }
    const sharers = d.tasks.filter((t) => t.cwd === cwd && t.host === project.host);
    if (sharers.length) {
      sharedCwdWarning = `Shares a writable directory with ${sharers.map((t) => t.alias).join(', ')} — edits are not isolated.`;
      for (const s of sharers) s.sharedCwdWarning = `Shares a writable directory with ${alias} — edits are not isolated.`;
    }
    const task: Task = {
      taskId,
      alias,
      name: args.name?.trim() || alias,
      nameSource: args.name?.trim() ? (args.nameSource ?? 'user') : 'auto',
      projectId: project.projectId,
      title: args.title.trim(),
      provider: args.provider,
      status: 'idle',
      summary: 'Not started yet.',
      cwd,
      host: project.host,
      worktree,
      sharedCwdWarning,
      mockScript: args.mockScript,
      createdAt: now(),
      updatedAt: now(),
    };
    d.tasks.push(task);
    if (!args.name?.trim()) this.autoRole(task, args.title, args.instruction);
    this.changed();
    if (args.instruction?.trim()) {
      const r = await this.send(taskId, args.instruction, 'initial');
      if (!r.ok) throw new Error(r.error);
    }
    return task;
  }

  /** Shows an imported session's past conversation right away, before anything is resumed. */
  /** Shows a saved conversation before it is resumed, and returns it (undefined when it could not be read). */
  private async previewHistory(task: Task, provider: 'claude' | 'codex', nativeSessionId: string): Promise<TranscriptItem[] | undefined> {
    const adapter = this.opts.adapters[provider];
    if (!adapter?.readHistory) return undefined;
    try {
      const events = await adapter.readHistory(nativeSessionId, task.cwd, task.host);
      if (this.live.has(task.taskId) || !this.store.data.tasks.includes(task)) return undefined; // resumed meanwhile, or removed
      const items: TranscriptItem[] = [];
      for (const e of events) {
        if (e.type !== 'transcriptItem') continue;
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
   * Gives an unnamed agent a one-word role in the language of its name: a keyword guess (else the
   * project's name) now, then, unless `refine` is false, a model's suggestion. A name the user sets wins.
   */
  private autoRole(task: Task, title: string, instruction = '', opts: { refine?: boolean } = {}): void {
    const lang = /[\u4e00-\u9fff]/.test(task.alias) ? 'zh' : 'en';
    // The title says what the agent is for; the instruction only breaks ties.
    const guess = guessRole(title, lang) ?? guessRole(instruction, lang) ?? projectRole(this.store.data.projects.find((p) => p.projectId === task.projectId)?.name ?? '');
    if (guess) task.name = guess;
    task.nameSource = 'auto';
    if (opts.refine !== false) this.refineRole(task, `${title}\n${instruction}`.trim());
  }

  /** Replaces an automatic role with a model's suggestion from `text`, unless the name changed meanwhile. */
  private refineRole(task: Task, text: string): void {
    if (!text.trim() || this.opts.demo) return;
    const lang = /[\u4e00-\u9fff]/.test(task.alias) ? 'zh' : 'en';
    const auto = task.name;
    void this.suggestRole(text, lang)
      .then((role) => {
        const t = this.store.data.tasks.find((x) => x.taskId === task.taskId);
        if (!role || !t || t.name !== auto || t.nameSource === 'user') return;
        t.name = role;
        t.nameSource = 'auto';
        this.changed();
      })
      .catch((error) => this.log('role suggestion failed', error));
  }

  /** A role from the user's own Claude Code or Codex (no extra key), else OpenAI when configured. */
  private async suggestRole(text: string, lang: 'en' | 'zh'): Promise<string | undefined> {
    const ask = this.backgroundAsk();
    if (ask) {
      try {
        const prompt = `${lang === 'zh' ? '这个 Agent 在做的事：' : 'What the agent is doing:'}\n${text.slice(0, 1500)}`;
        const first = await ask(rolePrompt(lang), prompt);
        const role = cleanRole(first, lang);
        if (role) return role;
        const second = cleanRole(await ask(rolePrompt(lang), `${prompt}\n\n${roleRetry(lang, first)}`), lang);
        if (second) return second;
      } catch (error) {
        this.log('background role failed', error);
      }
    }
    const ai = this.opts.openai;
    return ai ? cleanRole(await ai.suggestRole(text, lang), lang) : undefined;
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

  rename(taskId: string, name: string): void {
    const t = this.task(taskId);
    t.name = name.trim() || t.alias;
    // Cleared, the name is the app's to choose again.
    t.nameSource = name.trim() ? 'user' : 'auto';
    t.updatedAt = now();
    this.changed();
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
    d.attention = d.attention.filter((a) => a.taskId !== taskId);
    d.memory = d.memory.filter((m) => !(m.scope === 'task' && m.scopeId === taskId));
    this.coordinatorSay(note);
    this.changed();
    return note;
  }

  // ---------------------------------------------------------------- sessions

  private currentSession(task: Task): SessionRecord | undefined {
    return this.store.data.sessions.find((s) => s.localId === task.sessionLocalId);
  }

  /** Connects the task to its provider: resumes the recorded native session, or creates one. */
  private connect(taskId: string): Promise<LiveSession> {
    const existing = this.live.get(taskId);
    if (existing) return Promise.resolve(existing);
    const pending = this.connecting.get(taskId);
    if (pending) return pending;
    const p = this.doConnect(taskId).finally(() => this.connecting.delete(taskId));
    this.connecting.set(taskId, p);
    return p;
  }

  private async doConnect(taskId: string): Promise<LiveSession> {
    const task = this.task(taskId);
    const adapter = this.opts.adapters[task.provider];
    if (!adapter) throw new Error(`Provider ${task.provider} is not available.`);
    const prev = this.currentSession(task);
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
    task.status = 'starting';
    task.lastError = undefined;
    const injected = memoryForTask(task, this.store.data.memory);
    task.injectedMemoryIds = injected.map((m) => m.id);
    this.changed();

    const isMain = task === this.store.data.mainAgent;
    const skills = isMain ? undefined : await this.skillsFor(task);
    const history: TranscriptItem[] = [];
    let replaying = true;
    const session = adapter.createSession(
      {
        cwd: task.cwd,
        host: task.host,
        title: task.title,
        resumeNativeSessionId: resumeId,
        // The main agent gets its role and the workspace tools; it never edits code itself.
        developerInstructions: isMain ? [MAIN_AGENT_PROMPT, instructionsFor(task, injected)].filter(Boolean).join('\n\n') : instructionsFor(task, injected),
        mockScript: task.mockScript,
        permissionMode: isMain ? 'ask' : this.permissionModeOf(task),
        tools: isMain ? workspaceTools(this) : undefined,
        skills,
      },
      (event) => {
        if (replaying && event.type === 'transcriptItem' && event.history) {
          const prev = history.findIndex((h) => h.id === event.itemId);
          const item = mergeItem(prev === -1 ? undefined : history[prev], { id: event.itemId, taskId, role: event.role, text: event.text, toolLabel: event.toolLabel, toolStatus: event.toolStatus, createdAt: now() }, event.tool);
          if (prev === -1) history.push(item);
          else history[prev] = item;
          return;
        }
        this.handleEvent(taskId, record.localId, event);
      },
    );
    const live: LiveSession = { localId: record.localId, session, turnActive: false };
    this.live.set(taskId, live);
    try {
      await session.start();
    } catch (error) {
      this.live.delete(taskId);
      const message = (error as Error).message;
      task.status = 'failed';
      task.lastError = message;
      task.summary = `Could not ${resumeId ? 'resume' : 'start'} ${task.provider} session: ${clip(message, 140)}`;
      this.addAttention({ taskId, kind: 'error', headline: task.summary, details: message });
      this.changed();
      throw error;
    } finally {
      replaying = false;
    }
    // The native session is authoritative for history; replace the display cache with it.
    if (history.length) {
      this.store.setTranscript(taskId, [
        ...history,
        { id: `sys-${randomUUID()}`, taskId, role: 'system', text: `Resumed native ${task.provider} session ${record.nativeSessionId} (${history.length} items restored).`, createdAt: now() },
      ]);
      for (const cb of this.transcriptListeners) cb(taskId, null);
    } else if (resumeId) {
      this.appendSystem(taskId, `Resumed native ${task.provider} session ${resumeId}.`);
    }
    if (task.status === 'starting') task.status = 'idle';
    task.summary = resumeId ? 'Session resumed with its previous conversation.' : task.summary;
    this.changed();
    return live;
  }

  async resume(taskId: string): Promise<void> {
    await this.connect(taskId);
  }

  async stop(taskId: string): Promise<void> {
    this.cancelRetry(taskId);
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

  async discoverSessions(projectId: string, provider: 'claude' | 'codex'): Promise<NativeSessionInfo[]> {
    const adapter = this.opts.adapters[provider];
    if (!adapter) throw new Error(`Provider ${provider} is not available.`);
    const project = this.project(projectId);
    if (project.host && !adapter.remote) return [];
    const known = new Set(this.store.data.sessions.map((s) => s.nativeSessionId));
    const found = await adapter.discoverSessions({ cwd: project.rootPath, host: project.host });
    return found.filter((s) => !known.has(s.nativeSessionId));
  }

  /**
   * Recent Claude Code and Codex sessions saved on an SSH host (including those the
   * Claude and ChatGPT desktop apps created there through their SSH connections).
   */
  async discoverHostSessions(host: string): Promise<NativeSessionInfo[]> {
    this.requireHost(host);
    const known = new Set(this.store.data.sessions.map((s) => s.nativeSessionId));
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
    const known = new Set(this.store.data.sessions.map((s) => s.nativeSessionId));
    const own = [this.opts.dataDir, ...(this.opts.hiddenSessionDirs ?? []), tmpdir(), '/var/folders', '/private/var/folders', '/private/tmp', '/tmp'].map((p) => resolve(p));
    const lists = await Promise.all(
      (['claude', 'codex'] as const).map(async (p) => {
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
  async importSession(args: { projectId?: string; provider: 'claude' | 'codex'; nativeSessionId: string; cwd: string; host?: string; title: string }): Promise<Task> {
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
    const projectId = args.projectId!;
    const d = this.store.data;
    const alias = aliasFor(d.aliasCounter++, d.settings.language);
    const taskId = `t-${randomUUID().slice(0, 8)}`;
    const record: SessionRecord = {
      localId: `s-${randomUUID().slice(0, 8)}`,
      taskId,
      provider: args.provider,
      nativeSessionId: args.nativeSessionId,
      cwd: args.cwd,
      integrationMode: 'resumed',
      createdAt: now(),
    };
    const sharers = d.tasks.filter((t) => t.cwd === args.cwd && t.host === args.host);
    const task: Task = {
      taskId,
      alias,
      name: alias,
      projectId,
      title: clip(args.title, 120),
      provider: args.provider,
      status: 'disconnected',
      summary: 'Imported with its full history. Send a message to continue.',
      cwd: args.cwd,
      host: args.host,
      sharedCwdWarning: sharers.length ? `Uses its original directory, shared with ${sharers.map((t) => t.alias).join(', ')} — not isolated.` : undefined,
      sessionLocalId: record.localId,
      createdAt: now(),
      updatedAt: now(),
    };
    d.sessions.push(record);
    d.tasks.push(task);
    // A keyword guess (or the project's name) now; the model refines it once it can read the conversation.
    this.autoRole(task, task.title, '', { refine: false });
    this.changed();
    void this.previewHistory(task, args.provider, args.nativeSessionId).then((items) => {
      const said = (items ?? [])
        .filter((i) => i.role === 'user' && i.text.trim())
        .slice(0, 4)
        .map((i) => i.text.replace(/\s+/g, ' ').slice(0, 300));
      this.refineRole(task, [task.title, ...said].join('\n'));
    });
    return task;
  }

  // ---------------------------------------------------------------- forking

  /** The task's saved conversation, if its provider can fork it here. */
  private forkSource(taskId: string) {
    const task = this.task(taskId);
    if (task === this.store.data.mainAgent) throw new Error('The main agent cannot be forked.');
    const adapter = this.opts.adapters[task.provider];
    if (!adapter?.forkSession || !adapter.forkPoints) throw new Error(`${task.provider} conversations cannot be forked yet.`);
    if (task.host) throw new Error('Conversations on SSH hosts cannot be forked yet.');
    const nativeSessionId = this.currentSession(task)?.nativeSessionId;
    if (!nativeSessionId) throw new Error(`${task.alias} has no saved conversation to fork yet.`);
    return { task, adapter: adapter as Required<Pick<typeof adapter, 'forkSession' | 'forkPoints'>>, nativeSessionId };
  }

  /** Where the task's conversation can be forked: before each of the user's earlier prompts, oldest first. */
  async forkPoints(taskId: string): Promise<ForkPoint[]> {
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
    opts: { upToMessageId?: string; isolate: boolean; instruction?: string; name?: string; permissionMode?: PermissionMode },
  ): Promise<Task> {
    const { task: src, adapter, nativeSessionId } = this.forkSource(taskId);
    // Mid-turn, the saved conversation can end on a tool call with no result yet.
    if (this.live.get(src.taskId)?.turnActive || ['running', 'starting'].includes(src.status))
      throw new Error(`${src.alias} is still working. Fork it once this turn ends.`);
    const project = this.project(src.projectId);
    const d = this.store.data;
    const title = clip(`${src.title} (fork)`, 120);
    let cwd = src.cwd;
    let worktree: Task['worktree'];
    if (opts.isolate && project.isGitRepo) {
      const head = await run('git', ['-C', src.cwd, 'rev-parse', '--verify', 'HEAD']);
      if (head.code !== 0) throw new Error(`Could not read ${src.alias}'s last commit: ${head.stderr.trim()}`);
      const id = randomUUID().slice(0, 8);
      worktree = await this.worktrees.create(project.rootPath, project.projectId, `${slugify(`${src.name} fork`)}-${id}`, head.stdout.trim());
      // The same subfolder as the original (an imported session can work in one), so its paths still hold.
      const prefix = (await run('git', ['-C', src.cwd, 'rev-parse', '--show-prefix'])).stdout.trim().replace(/\/+$/, '');
      cwd = prefix ? join(worktree.path, prefix) : worktree.path;
    }
    let forkId: string;
    try {
      forkId = await adapter.forkSession(nativeSessionId, { cwd: src.cwd, upToMessageId: opts.upToMessageId, title });
    } catch (error) {
      if (worktree) await this.worktrees.removeIfClean(worktree);
      throw error;
    }
    // After the fork exists, so a failed fork still leaves a clean worktree to remove. Its conversation
    // remembers the original's edits, so its files must have them too.
    const copied = worktree ? await this.worktrees.copyChanges(src.cwd, worktree.path) : undefined;
    const alias = aliasFor(d.aliasCounter++, d.settings.language);
    const newId = `t-${randomUUID().slice(0, 8)}`;
    const record: SessionRecord = { localId: `s-${randomUUID().slice(0, 8)}`, taskId: newId, provider: src.provider, nativeSessionId: forkId, cwd, integrationMode: 'resumed', createdAt: now() };
    const sharers = d.tasks.filter((t) => t.cwd === cwd && t.host === src.host);
    for (const s of sharers) s.sharedCwdWarning = `Shares a writable directory with ${alias} — edits are not isolated.`;
    const point = opts.upToMessageId ? 'from an earlier point' : 'as it is now';
    const task: Task = {
      taskId: newId,
      alias,
      // A custom name is a voice handle, so the fork gets its own.
      name: opts.name?.trim() || (src.name === src.alias ? alias : this.forkName(src.name)),
      nameSource: 'auto',
      projectId: src.projectId,
      title,
      provider: src.provider,
      status: 'disconnected',
      summary: `Forked from ${src.alias}'s conversation ${point}. Send a message to continue.`,
      cwd,
      worktree,
      sharedCwdWarning: sharers.length ? `Shares a writable directory with ${sharers.map((t) => t.alias).join(', ')} — edits are not isolated.` : undefined,
      sessionLocalId: record.localId,
      permissionMode: 'permissionMode' in opts ? opts.permissionMode : src.permissionMode,
      forkedFrom: { taskId: src.taskId, alias: src.alias },
      mockScript: src.mockScript,
      createdAt: now(),
      updatedAt: now(),
    };
    d.sessions.push(record);
    d.tasks.push(task);
    const notes = [
      `${alias} continues ${src.alias}'s conversation ${point}${worktree ? ` in its own worktree (${worktree.branch}) with ${src.alias}'s files as they are now` : ''}.`,
      ...(copied?.error
        ? [`${src.alias}'s uncommitted changes were not fully copied (${copied.error}); check ${alias}'s files before relying on them.`]
        : copied?.files
          ? [`${src.alias}'s uncommitted changes were copied too (${copied.files} file${copied.files === 1 ? '' : 's'}).`]
          : []),
    ];
    this.coordinatorSay(`Forked ${src.alias} as ${alias}. ${notes.join(' ')}`);
    this.changed();
    if (src.provider !== 'mock') void this.previewHistory(task, src.provider, forkId);
    const instruction = opts.instruction?.trim();
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

  /** "backend" -> "backend fork", then "backend fork 2", … — unique among the agents. */
  private forkName(name: string): string {
    const taken = new Set(this.store.data.tasks.map((t) => t.name.trim().toLowerCase()));
    const base = `${name.trim()} fork`;
    let candidate = base;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`;
    return candidate;
  }

  // ---------------------------------------------------------------- messaging

  /** Delivers text to exactly this task's native session. Never re-routed. */
  async send(taskId: string, text: string, via: TranscriptItem['via'], opts: { interrupt?: boolean } = {}): Promise<DispatchResult> {
    const task = this.task(taskId);
    if (task === this.store.data.mainAgent) this.mainTurns++;
    // A new message carries on from a failed turn by itself; no retry on top of it.
    this.cancelRetry(taskId);
    try {
      const live = await this.connect(taskId);
      const busy = live.turnActive;
      const item: TranscriptItem = { id: `u-${randomUUID()}`, taskId, role: 'user', text, via, createdAt: now(), ...(busy ? { delivery: opts.interrupt ? 'interrupt' : 'steer' } : {}) };
      this.upsertTranscript(taskId, item);
      task.suggestion = undefined;
      // Commands the user ran with `!` since the last message reach the agent with this one.
      const ran = this.shellOutput.get(taskId) ?? [];
      const delivery = await live.session.send(ran.length ? `${ran.join('\n')}\n\n${text}` : text, opts);
      this.shellOutput.delete(taskId);
      if (delivery === 'turn' && item.delivery) this.upsertTranscript(taskId, { ...item, delivery: undefined });
      // A delivered reply answers this task's heuristic asks (not native approvals, which need their own decision),
      // and takes the place of retrying a failed turn.
      for (const a of this.store.data.attention)
        if (a.taskId === taskId && a.state === 'open' && !a.providerRequestId && (a.kind !== 'error' || a.retryable))
          this.closeAttention(a, 'resolved', `Replied: ${clip(text, 80)}`);
      live.turnActive = true;
      if (!this.hasOpenNative(taskId)) task.status = 'running';
      // Steering adds to the work in progress; the summary keeps describing it.
      if (delivery !== 'steer') task.summary = `Working on: ${clip(text, 120)}`;
      task.updatedAt = now();
      this.changed();
      return { ok: true, taskId, delivery };
    } catch (error) {
      const message = (error as Error).message;
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
          await live.session.shell(command);
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
    const r = task.host
      ? await sshRun(task.host, `cd ${shq(task.cwd)} && { ${command}\n}`, SHELL_TIMEOUT_MS)
      : process.platform === 'win32'
        ? await run('cmd.exe', ['/d', '/s', '/c', command], { cwd: task.cwd, timeoutMs: SHELL_TIMEOUT_MS })
        : await run(process.env.SHELL || '/bin/sh', ['-lc', command], { cwd: task.cwd, timeoutMs: SHELL_TIMEOUT_MS });
    const output = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n');
    this.upsertTranscript(taskId, { id, taskId, role: 'tool', text: '', toolStatus: r.code === 0 ? 'completed' : 'failed', createdAt: now() }, { content: [{ ...terminal, output: clipOutput(output), exitCode: r.code }] });
    const pending = this.shellOutput.get(taskId) ?? [];
    pending.push(shellContext(command, r.stdout, r.stderr));
    this.shellOutput.set(taskId, pending.slice(-5));
    this.changed();
    return { ok: true };
  }

  /** The library for an agent on this Mac, or its copy on the agent's host (copied when it changed). */
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

  /** Skills in the CLIs' own folders on this Mac and on every reachable enabled host. */
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

  // ---------------------------------------------------------------- provider events

  handleEvent(taskId: string, sessionLocalId: string, event: ProviderEvent): void {
    const task = this.findTask(taskId);
    const live = this.live.get(taskId);
    // Late events from a replaced or stopped session must not touch the task.
    if (!task || task.sessionLocalId !== sessionLocalId || !live || live.localId !== sessionLocalId) {
      this.log('dropped stale event', taskId, sessionLocalId, event.type);
      return;
    }
    task.updatedAt = now();
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
      case 'transcriptItem':
        this.upsertTranscript(
          taskId,
          { id: event.itemId, taskId, role: event.role, text: event.text, toolLabel: event.toolLabel, toolStatus: event.toolStatus, streaming: false, createdAt: now() },
          event.tool,
        );
        if (event.role === 'assistant' && !event.history) task.summary = summaryFor(event.text);
        return this.changedThrottled();
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
      case 'suggestion':
        task.suggestion = clip(event.text, 500);
        break;
      case 'turnStarted':
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
      case 'retrying':
        task.retry = { kind: event.kind, attempt: event.attempt, maxAttempts: event.maxAttempts, at: new Date(Date.now() + event.delayMs).toISOString(), by: 'provider', error: event.error };
        task.summary = `${RETRY_LABEL[event.kind]}, retrying (attempt ${event.attempt}/${event.maxAttempts})`;
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
          task.summary = text ? summaryFor(text) : 'Finished the turn.';
          this.addAttention({ taskId, kind: 'completion', headline: text ? headlineFor(text) : 'Finished the turn.', details: text });
        }
        break;
      }
      case 'sessionFailed':
      case 'sessionDisconnected': {
        this.live.delete(taskId);
        this.handBackRetry(task);
        const reason = event.type === 'sessionFailed' ? event.error : event.reason;
        task.status = event.type === 'sessionFailed' ? 'failed' : 'disconnected';
        task.lastError = reason;
        task.summary = `${event.type === 'sessionFailed' ? 'Session failed' : 'Disconnected'}: ${clip(reason, 140)}`;
        this.expireNative(taskId, sessionLocalId, `Provider session ended: ${reason}`);
        if (event.type === 'sessionFailed') this.addAttention({ taskId, kind: 'error', headline: task.summary, details: reason });
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
  }

  // ---------------------------------------------------------------- attention

  private addAttention(a: Omit<AttentionItem, 'id' | 'state' | 'createdAt'>): AttentionItem {
    const item: AttentionItem = { ...a, id: `a-${randomUUID().slice(0, 8)}`, state: 'open', createdAt: now() };
    this.store.data.attention.push(item);
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
    this.appendSystem(a.taskId, `${a.kind === 'approval' ? 'Approval decision' : 'Answer'} sent to ${task.provider}: ${label}`);
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

  private appendSystem(taskId: string, text: string): void {
    this.upsertTranscript(taskId, { id: `sys-${randomUUID()}`, taskId, role: 'system', text, createdAt: now() });
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

  updateMemory(id: string, patch: { body?: string; approvedForReuse?: boolean }): void {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m) throw new Error('Unknown memory record.');
    if (patch.body !== undefined) m.body = patch.body;
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
      : await run('/bin/sh', ['-c', this.opts.home ? `HOME=${shq(this.opts.home)}\n${MEMORY_SCAN_SCRIPT}` : MEMORY_SCAN_SCRIPT], { timeoutMs: 30_000 });
    const out = parseScanOutput(r.stdout);
    if (!out.complete) throw new Error(host ? sshError(host, r.stderr) : r.stderr.trim() || 'Could not read the memory files.');
    return candidatesFrom(host, out.home, out.files, this.store.data.projects);
  }

  /** This Mac and every reachable enabled host; hosts that are not connected are reported, not waited for. */
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
    if ((!manual && !this.memSync.started) || this.store.data.settings.memorySync === false) return undefined;
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

  private shareResults = new Map<string, { lastWrite?: string; errors?: string[] }>();
  private pushTimer?: NodeJS.Timeout;
  /** Writes to the CLIs' files run one at a time (a link, a push, a restore never overlap). */
  private shareQueue: Promise<unknown> = Promise.resolve();
  private shareSerial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.shareQueue.then(fn, fn);
    this.shareQueue = next.catch(() => undefined);
    return next;
  }

  /** Soon after user memory changed in the app: the linked machines get it. */
  private schedulePush(): void {
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.pushMemory(), 2000);
    this.pushTimer.unref?.();
  }

  /** Writes the shared user memory to every linked, reachable machine (offline ones catch up on the next sync). */
  pushMemory(): Promise<void> {
    return this.shareSerial(() => this.doPush());
  }

  private async doPush(): Promise<void> {
    if (this.store.data.settings.memorySync === false) return;
    const hosts = Object.keys(this.store.data.settings.memoryLinks ?? {}).filter((h) => h === LOCAL || this.hostStatus.get(h)?.ssh === 'ok');
    await Promise.all(
      hosts.map(async (h) => {
        const r = await this.writeback.write(h, this.store.data.memory, 'sync').catch((e: Error) => ({ written: [], errors: [e.message] }));
        this.shareResults.set(h, { lastWrite: r.written.length ? now() : this.shareResults.get(h)?.lastWrite, errors: r.errors.length ? r.errors : undefined });
      }),
    );
    this.changed();
  }

  /**
   * What linking a machine would do: its user-level notes that would join the shared
   * user memory, and each of its CLI files before and after (nothing is changed).
   */
  async linkPreview(host: string): Promise<{ incoming: MemoryCandidate[]; files: Array<{ path: string; kind: string; exists: boolean; before: string; after: string | null }> }> {
    const incoming = (await this.scanMachine(host === LOCAL ? undefined : host)).filter((c) => c.suggestedScope === 'global');
    const marked = markCandidates(incoming, this.store.data).filter((c) => !c.alreadyImported && !c.dismissed);
    const after = [...this.store.data.memory, ...marked.map((c, i) => ({ id: `preview-${i}`, scope: 'global' as const, scopeId: 'global', body: c.body, source: c.key, importKeys: [c.key], approvedForReuse: true, updatedAt: now() }))];
    const files = planWriteback(await this.writeback.read(host), after);
    return { incoming: marked, files: files.map(({ file, next }) => ({ path: file.path, kind: file.kind, exists: file.exists, before: file.content, after: next })) };
  }

  /** The first sync with a machine: back up its files, merge its user-level notes in, write the shared user memory there. */
  linkMachine(host: string): Promise<{ added: number; written: string[]; errors: string[] }> {
    return this.shareSerial(() => this.doLink(host));
  }

  private async doLink(host: string): Promise<{ added: number; written: string[]; errors: string[] }> {
    const incoming = (await this.scanMachine(host === LOCAL ? undefined : host)).filter((c) => c.suggestedScope === 'global');
    const fresh = markCandidates(incoming, this.store.data).filter((c) => !c.alreadyImported && !c.dismissed);
    const added = importCandidates(this.store.data, fresh.map((candidate) => ({ candidate, scope: 'global' as const, scopeId: 'global' }))).length;
    const r = await this.writeback.write(host, this.store.data.memory, 'link');
    this.store.data.settings.memoryLinks = { ...this.store.data.settings.memoryLinks, [host]: { linkedAt: now() } };
    this.shareResults.set(host, { lastWrite: r.written.length ? now() : undefined, errors: r.errors.length ? r.errors : undefined });
    this.changed();
    // Machines linked earlier get the notes this one brought.
    if (added) this.schedulePush();
    return { added, ...r };
  }

  /** Stops sharing with a machine: takes the app's text out, or puts the files back as they were before linking. */
  async unlinkMachine(host: string, how: 'remove' | 'original'): Promise<void> {
    await this.shareSerial(() => this.writeback.unlink(host, how));
    const links = { ...this.store.data.settings.memoryLinks };
    delete links[host];
    this.store.data.settings.memoryLinks = links;
    this.shareResults.delete(host);
    this.changed();
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

  sendFromMain(taskId: string, text: string, interrupt: boolean) {
    return this.send(taskId, text, 'main', { interrupt });
  }

  /**
   * The main agent forks an agent to branch off work: the whole conversation as it is now, or from
   * just before an earlier prompt (matched by its start). In its own worktree when the project is a
   * git repository, and never with more permissions than the workspace default, which only the user can raise.
   */
  async forkFromMain(taskId: string, args: { instruction: string; beforePrompt?: string; role?: string }): Promise<{ task: Task; delivery: DispatchResult }> {
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
    const task = await this.forkTask(taskId, { upToMessageId, isolate: true, name: args.role, permissionMode });
    return { task, delivery: await this.send(task.taskId, args.instruction, 'main') };
  }

  async createFromMain(args: { projectId: string; provider: AgentProvider; title: string; instruction?: string; role?: string }): Promise<Task> {
    return this.createTask({ ...args, name: args.role, nameSource: 'auto', isolate: true });
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
    return (['claude', 'codex'] as const).filter((p) => this.providerReady(p));
  }

  // ---------------------------------------------------------------- file preview

  /** Folders a task's files may be previewed from: its cwd, its worktree, its project. */
  private previewRoots(t: Task): string[] {
    const project = this.store.data.projects.find((p) => p.projectId === t.projectId);
    return [t.cwd, t.worktree?.path, project?.rootPath].filter((r): r is string => !!r);
  }

  async previewFile(taskId: string, path: string): Promise<FilePreview> {
    const t = this.task(taskId);
    return t.host ? readRemote(t.host, t.cwd, path, this.previewRoots(t)) : readLocal(t.cwd, path, this.previewRoots(t));
  }

  /** The checked local path to hand to the default app (this Mac only). */
  previewLocalPath(taskId: string, path: string): string {
    const t = this.task(taskId);
    if (t.host) throw new Error(`The file is on ${t.host}; it can only be previewed here.`);
    return localPath(t.cwd, path, this.previewRoots(t));
  }

  // ---------------------------------------------------------------- demo

  /** Creates a self-contained demo repo and three mock agents matching the spec's script. */
  async seedDemo(demoRepoPath: string): Promise<void> {
    const project = await this.addProject(demoRepoPath, 'demo-shop');
    // Roles (Backend, Frontend, Database) are filled in automatically from the titles.
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
