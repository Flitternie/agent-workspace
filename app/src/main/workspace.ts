import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import type {
  AgentProvider,
  AttentionItem,
  CoordinatorEntry,
  DispatchResult,
  MemoryRecord,
  MemoryScope,
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
  WorkspaceSnapshot,
} from '../shared/types';
import { clipOutput } from '../shared/content';
import { asksUser, clip, headlineFor, summaryFor } from './attention';
import { instructionsFor, memoryForTask } from './memory';
import type { OpenAiClient } from './openai';
import type { LocalStt } from './stt/local';
import { STT_MODEL, ROUTER_MODEL } from './openai';
import type { ProviderAdapter, ProviderEvent, ProviderSession } from './providers/types';
import { decideDeterministic, decideRoute, type RouteContext } from './router';
import { aliasFor, JsonStore } from './store';
import { cleanRole, guessRole } from './role';
import { MAIN_AGENT_PROMPT, pickMainProvider, workspaceTools } from './main-agent';
import { gitRoot, WorktreeService } from './worktree';
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

export interface WorkspaceOptions {
  dataDir: string;
  adapters: Partial<Record<AgentProvider, ProviderAdapter>>;
  openai?: OpenAiClient;
  log?: (...args: unknown[]) => void;
  demo?: boolean;
  localStt?: LocalStt;
  /** Folders whose sessions are the app's own (test scratch repos) and never offered for import. */
  hiddenSessionDirs?: string[];
}

/**
 * The local backend (spec 03): task + session registry, durable attention queue,
 * routing, scoped memory and provider lifecycle. Framework-free so it can be
 * tested without Electron; the Electron layer only forwards IPC and events.
 */
export class Workspace {
  readonly store: JsonStore;
  private live = new Map<string, LiveSession>(); // taskId -> live provider session
  private connecting = new Map<string, Promise<LiveSession>>();
  private capabilities: ProviderCapabilities[] = [];
  private hostStatus = new Map<string, RemoteHostStatus>();
  private changeListeners = new Set<() => void>();
  /** item === null means "the whole transcript was replaced; reload it". */
  private transcriptListeners = new Set<(taskId: string, item: TranscriptItem | null) => void>();
  private worktrees: WorktreeService;
  private log: (...args: unknown[]) => void;

  constructor(private opts: WorkspaceOptions) {
    this.store = new JsonStore(opts.dataDir);
    this.worktrees = new WorktreeService(join(opts.dataDir, 'worktrees'));
    this.log = opts.log ?? (() => {});
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
    // Detach first so close-time events are dropped; restart recovery then marks state honestly.
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
  private async previewHistory(task: Task, provider: 'claude' | 'codex', nativeSessionId: string): Promise<void> {
    const adapter = this.opts.adapters[provider];
    if (!adapter?.readHistory) return;
    try {
      const events = await adapter.readHistory(nativeSessionId, task.cwd, task.host);
      if (this.live.has(task.taskId) || !this.store.data.tasks.includes(task)) return; // resumed meanwhile, or removed
      const items: TranscriptItem[] = [];
      for (const e of events) {
        if (e.type !== 'transcriptItem') continue;
        const i = items.findIndex((h) => h.id === e.itemId);
        const item = mergeItem(i === -1 ? undefined : items[i], { id: e.itemId, taskId: task.taskId, role: e.role, text: e.text, toolLabel: e.toolLabel, toolStatus: e.toolStatus, createdAt: now() }, e.tool);
        if (i === -1) items.push(item);
        else items[i] = item;
      }
      if (!items.length) return;
      // A preview: long sessions show their latest part; resuming restores everything.
      this.store.setTranscript(task.taskId, items.slice(-400));
      for (const cb of this.transcriptListeners) cb(task.taskId, null);
      const last = [...items].reverse().find((x) => x.role === 'assistant' && x.text.trim());
      if (last) task.summary = summaryFor(last.text);
      this.changed();
    } catch (error) {
      this.log('history preview failed', provider, error);
    }
  }

  /**
   * Gives an unnamed agent a one-word role in the language of its name: a keyword
   * guess now, refined by the LLM when configured. A role the user sets wins.
   */
  private autoRole(task: Task, title: string, instruction = ''): void {
    const lang = /[\u4e00-\u9fff]/.test(task.alias) ? 'zh' : 'en';
    const text = `${title}\n${instruction}`.trim();
    // The title says what the agent is for; the instruction only breaks ties.
    const guess = guessRole(title, lang) ?? guessRole(instruction, lang);
    if (guess) task.name = guess;
    const auto = task.name;
    const ai = this.opts.openai;
    if (!ai || !text.trim()) return;
    void ai
      .suggestRole(text, lang)
      .then((raw) => {
        const role = cleanRole(raw, lang);
        const t = this.store.data.tasks.find((x) => x.taskId === task.taskId);
        if (!role || !t || t.name !== auto) return;
        t.name = role;
        this.changed();
      })
      .catch((error) => this.log('role suggestion failed', error));
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
    await l.session.interrupt();
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
    this.autoRole(task, task.title);
    this.changed();
    void this.previewHistory(task, args.provider, args.nativeSessionId);
    return task;
  }

  // ---------------------------------------------------------------- messaging

  /** Delivers text to exactly this task's native session. Never re-routed. */
  async send(taskId: string, text: string, via: TranscriptItem['via'], opts: { interrupt?: boolean } = {}): Promise<DispatchResult> {
    const task = this.task(taskId);
    try {
      const live = await this.connect(taskId);
      const busy = live.turnActive;
      const item: TranscriptItem = { id: `u-${randomUUID()}`, taskId, role: 'user', text, via, createdAt: now(), ...(busy ? { delivery: opts.interrupt ? 'interrupt' : 'steer' } : {}) };
      this.upsertTranscript(taskId, item);
      const delivery = await live.session.send(text, opts);
      if (delivery === 'turn' && item.delivery) this.upsertTranscript(taskId, { ...item, delivery: undefined });
      // A delivered reply answers this task's heuristic asks (not native approvals, which need their own decision).
      for (const a of this.store.data.attention)
        if (a.taskId === taskId && a.state === 'open' && !a.providerRequestId && a.kind !== 'error')
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
      case 'turnStarted':
        live.turnActive = true;
        if (!this.hasOpenNative(taskId)) task.status = 'running';
        break;
      case 'planUpdated':
        task.plan = event.entries.length ? { entries: event.entries, explanation: event.explanation, updatedAt: now() } : undefined;
        return this.changedThrottled();
      case 'progress':
        task.summary = clip(event.text, 200);
        return this.changedThrottled();
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
        if (event.status === 'interrupted') {
          task.status = 'idle';
          task.summary = 'Interrupted. Waiting for your next instruction.';
          break;
        }
        if (event.status === 'failed') {
          task.status = 'failed';
          task.lastError = event.error;
          task.summary = `Turn failed: ${clip(event.error ?? 'unknown error', 160)}`;
          this.addAttention({ taskId, kind: 'error', headline: task.summary, details: event.error ?? '' });
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
    return rec;
  }

  updateMemory(id: string, patch: { body?: string; approvedForReuse?: boolean }): void {
    const m = this.store.data.memory.find((x) => x.id === id);
    if (!m) throw new Error('Unknown memory record.');
    if (patch.body !== undefined) m.body = patch.body;
    if (patch.approvedForReuse !== undefined) m.approvedForReuse = patch.approvedForReuse;
    m.updatedAt = now();
    this.changed();
  }

  deleteMemory(id: string): void {
    this.store.data.memory = this.store.data.memory.filter((m) => m.id !== id);
    this.changed();
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

  updateSettings(patch: Partial<Settings>): void {
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
    return this.store.data.projects.map((p) => ({ projectId: p.projectId, name: p.name, rootPath: p.host ? `${p.host}:${p.rootPath} (over SSH, Codex only)` : p.rootPath }));
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

  async createFromMain(args: { projectId: string; provider: AgentProvider; title: string; instruction?: string; role?: string }): Promise<Task> {
    return this.createTask({ ...args, name: args.role, isolate: true });
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
