import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, systemPreferences } from 'electron';
import { EVENT_TRANSCRIPT, EVENT_WORKSPACE, ipcSchemas, type IpcChannel } from '../shared/ipc';
import { openableKind } from '../shared/preview';
import type { ImageRef, PermissionMode, Settings, TranscriptItem } from '../shared/types';
import { KeyStore } from './keystore';
import { checkOpenAiKey, envOpenAiKey, loadOpenAiKey, OpenAiClient } from './openai';
import { ClaudeAdapter } from './providers/claude';
import { CodexAdapter } from './providers/codex';
import { MockAdapter } from './providers/mock';
import { LocalStt } from './stt/local';
import { Workspace } from './workspace';
import type { ResearchDoc } from '../shared/research';
import { documentToHtml } from './documents';
import { bundleIcon, installedApps, launch, launchCommand } from './open-in-app';
import { cancelHostLogin, cancelLogin, desktopApps, installOnHost, loginWithApiKey, sendHostLoginCode, startHostLogin, startLogin, type LoginMethod } from './login';

// All app state lives in one app-owned directory (default: <app>/.data) so the
// prototype never touches other apps' or the user's global configuration.
const appRoot = app.getAppPath();
// `npm run demo` (AMW_MODE=demo) is a separate entry with mock agents and its own
// data dir, so the real workspace never fills up with demo tasks.
const demoMode = process.env.AMW_MODE === 'demo';
// Packaged builds live in a read-only bundle: their data goes to the OS app-data folder
// (macOS: ~/Library/Application Support/Agent Workspace). From source it stays in app/.
const userBase = app.isPackaged ? join(app.getPath('appData'), 'Agent Workspace') : appRoot;
const dataDir = process.env.AMW_DATA_DIR ?? join(userBase, app.isPackaged ? (demoMode ? 'Demo' : 'Workspace') : demoMode ? '.data-demo' : '.data');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', join(dataDir, 'electron'));
app.setName('Agent Workspace');

const appIcons = new Map<string, string>();
/** An app's icon as a data URL (Electron reads it from the bundle), cached. */
async function appIcon(path: string): Promise<string | undefined> {
  if (appIcons.has(path)) return appIcons.get(path);
  try {
    // The bundle's own icon; Electron's file icon (often a blank document for an .app) only as a fallback.
    const own = await bundleIcon(path, join(app.getPath('userData'), 'app-icons'));
    const fallback = own ? undefined : await app.getFileIcon(path, { size: 'normal' });
    const url = own ?? (fallback && !fallback.isEmpty() ? fallback.toDataURL() : undefined);
    if (url) appIcons.set(path, url);
    return url;
  } catch {
    return undefined;
  }
}

const log = (...args: unknown[]) => {
  if (process.env.AMW_DEBUG) console.log('[amw]', ...args);
};

// OpenAI key: environment > saved in Settings (encrypted, read once the app is ready) > openai.key file.
const keyStore = new KeyStore(dataDir);
const key = loadOpenAiKey(appRoot);
// On-device speech models are shared by the real and demo entries and kept inside the app folder.
let notifyModels = () => {};
const localStt = new LocalStt(process.env.AMW_MODELS_DIR ?? join(userBase, app.isPackaged ? 'Models' : '.models'), () => notifyModels());
const openai = key ? new OpenAiClient(key) : undefined;
const workspace = new Workspace({
  dataDir,
  adapters: {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    mock: new MockAdapter(join(dataDir, 'mock-sessions')),
  },
  openai,
  localStt,
  log,
  demo: demoMode,
  hiddenSessionDirs: [join(appRoot, '.cache')],
  // Tests: the background model answers from a file (never a real CLI), e.g. a session map grouping.
  ...(process.env.AMW_BACKGROUND_ANSWER ? { backgroundModel: async () => readFileSync(process.env.AMW_BACKGROUND_ANSWER!, 'utf8') } : {}),
});
notifyModels = () => workspace.notifyChanged();
const keySource = (): 'env' | 'file' | null => (envOpenAiKey() ? 'env' : key ? 'file' : null);
if (key) workspace.setOpenAi(openai, { source: keySource(), last4: key.slice(-4) });

/** Applies the best available key: environment, then the one saved in Settings, then the key file. */
function useBestKey(): void {
  if (process.env.AMW_NO_OPENAI === '1') return;
  const env = envOpenAiKey();
  if (env) return workspace.setOpenAi(new OpenAiClient(env), { source: 'env', last4: env.slice(-4) });
  const saved = keyStore.load();
  if (saved) return workspace.setOpenAi(new OpenAiClient(saved), { source: 'saved', last4: saved.slice(-4) });
  const file = loadOpenAiKey(appRoot);
  workspace.setOpenAi(file ? new OpenAiClient(file) : undefined, file ? { source: 'file', last4: file.slice(-4) } : { source: null });
}

let win: BrowserWindow | null = null;

function ensureDemoRepo(): string {
  const dir = join(dataDir, 'demo-repo');
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# demo-shop\n\nA tiny demo repository for Agent Workspace.\n');
    writeFileSync(join(dir, 'src', 'orders.ts'), 'export function listOrders() {\n  return [];\n}\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=demo@local', '-c', 'user.name=demo', 'commit', '-qm', 'init'], { cwd: dir });
  }
  return dir;
}

// HTML previews load from amw-preview:// rather than iframe srcdoc: a srcdoc frame inherits
// the app's CSP (script-src 'self'), so "Allow scripts" could never work. This scheme serves
// only documents the preview just read, under a CSP of their own: nothing loads from the
// network or disk, inline scripts run only when the iframe's sandbox allows them, and the
// sandbox never grants same-origin, so a page cannot reach the app.
const PREVIEW_SCHEME = 'amw-preview';
const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; script-src 'unsafe-inline'";
// Documents (Word, via textutil) get no scripts at all; PDFs open in Chromium's own viewer.
const DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const previewDocs = new Map<string, { body: string | Uint8Array; type: string; csp?: string }>();
// Images in messages load from amw-image://img/<id>: only stored images, by their content name.
const IMAGE_SCHEME = 'amw-image';
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } },
]);

function servePreviews(): void {
  protocol.handle(PREVIEW_SCHEME, (req) => {
    const doc = previewDocs.get(new URL(req.url).pathname.slice(1));
    if (doc === undefined) return new Response('Preview expired. Refresh it.', { status: 404 });
    return new Response(doc.body as BodyInit, { headers: { 'content-type': doc.type, ...(doc.csp ? { 'content-security-policy': doc.csp } : {}) } });
  });
  protocol.handle(IMAGE_SCHEME, (req) => {
    const id = new URL(req.url).pathname.slice(1);
    const ref = workspace.attachments.has(id) ? workspace.attachments.read(id) : undefined;
    if (!ref) return new Response('Image not found.', { status: 404 });
    const type = id.endsWith('.png') ? 'image/png' : id.endsWith('.gif') ? 'image/gif' : id.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    return new Response(new Uint8Array(ref), { headers: { 'content-type': type, 'cache-control': 'max-age=31536000, immutable' } });
  });
}

/** Keeps the latest few documents (one per refresh); older frames show "expired". */
function addPreviewDoc(body: string | Uint8Array, type = 'text/html; charset=utf-8', csp: string | undefined = PREVIEW_CSP): string {
  const key = randomUUID();
  previewDocs.set(key, { body, type, csp });
  for (const k of previewDocs.keys()) if (previewDocs.size > 8) previewDocs.delete(k);
  return `${PREVIEW_SCHEME}://doc/${key}`;
}

type Handler = (input: never) => unknown;
const handlers: { [C in IpcChannel]: Handler } = {
  'workspace:snapshot': () => workspace.snapshot(),
  'transcript:get': (i: { taskId: string }) => workspace.transcript(i.taskId),
  'project:pickDirectory': async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  'project:add': (i: { rootPath: string; name?: string; host?: string }) => workspace.addProject(i.rootPath, i.name, i.host),
  'research:get': (i: { projectId: string }) => workspace.researchLoad(i.projectId),
  'research:save': (i: { projectId: string; doc: ResearchDoc }) => workspace.researchSave(i.projectId, i.doc),
  'research:notes': (i: { projectId: string }) => workspace.researchLoadNotes(i.projectId),
  'research:message': (i: { projectId: string; nodeIds: string[]; text: string; images?: ImageRef[] }) => workspace.researchMessage(i.projectId, i.nodeIds, i.text, i.images),
  'research:create': (i: { projectId: string; title: string; goal: string; sample: boolean }) => workspace.researchCreate(i.projectId, i.title, i.goal, i.sample),
  'ssh:hosts': () => workspace.sshHosts(),
  'ssh:setEnabled': (i: { host: string; enabled: boolean }) => workspace.setHostEnabled(i.host, i.enabled),
  'ssh:check': (i: { host: string; quiet?: boolean }) => workspace.checkHost(i.host, { quiet: i.quiet }),
  // Installing and signing in on a host, when the user asks (they see the command first).
  'ssh:install': async (i: { host: string; provider: 'claude' | 'codex' }) => {
    const r = await installOnHost(i.host, i.provider);
    await workspace.checkHost(i.host, { quiet: true });
    return r;
  },
  'ssh:login': (i: { host: string; provider: 'claude' | 'codex' }) => startHostLogin(i.host, i.provider, () => void workspace.checkHost(i.host, { quiet: true })),
  'ssh:loginCode': (i: { host: string; provider: 'claude' | 'codex'; code: string }) => sendHostLoginCode(i.host, i.provider, i.code),
  'ssh:loginCancel': (i: { host: string; provider: 'claude' | 'codex' }) => cancelHostLogin(i.host, i.provider),
  'ssh:connect': (i: { host: string }) => workspace.connectHost(i.host),
  'ssh:terminal': (i: { host: string }) => workspace.openHostTerminal(i.host),
  'task:create': (i: Parameters<Workspace['createTask']>[0]) => workspace.createTask(i),
  'task:send': (i: { taskId: string; text: string; via: 'text' | 'card'; interrupt?: boolean; images?: ImageRef[]; about?: string }) => workspace.send(i.taskId, i.text, i.via, { interrupt: i.interrupt, images: i.images, openRequest: i.about }),
  'attachment:save': (i: { bytes: Uint8Array; name?: string }) => workspace.attachments.save(i.bytes, i.name),
  'task:interrupt': (i: { taskId: string }) => workspace.interrupt(i.taskId),
  'task:models': (i: { taskId: string }) => workspace.listModels(i.taskId),
  'task:setModel': (i: { taskId: string; model: string | null }) => workspace.setModel(i.taskId, i.model ?? undefined),
  'task:shell': (i: { taskId: string; command: string }) => workspace.runShell(i.taskId, i.command),
  'memory:linkPreview': (i: { host: string }) => workspace.linkPreview(i.host),
  'memory:link': (i: { host: string }) => workspace.linkMachine(i.host),
  'memory:unlink': (i: { host: string }) => workspace.unlinkMachine(i.host),
  'memory:resolveShare': (i: { host: string; kind: 'claude-md' | 'claude-user' | 'codex-md'; how: 'resume' | 'adopt' }) => workspace.resolveShare(i.host, i.kind, i.how),
  'memory:resolveConflict': (i: { id: string; take: 'source' | 'mine' }) => workspace.resolveConflict(i.id, i.take),
  'memory:restoreNote': (i: { id: string }) => workspace.restoreNote(i.id),
  'memory:backups': (i: { host?: string }) => workspace.memoryBackups(i.host),
  'memory:backupContent': (i: { id: string }) => workspace.memoryBackupContent(i.id),
  'memory:restoreBackup': (i: { id: string }) => workspace.restoreMemoryBackup(i.id),
  'skills:list': () => workspace.skills.list(),
  'skills:scan': () => workspace.scanSkills(),
  'skills:import': (i: { key: string }) => workspace.importSkill(i.key),
  'skills:setEnabled': (i: { name: string; enabled: boolean }) => workspace.setSkillEnabled(i.name, i.enabled),
  'skills:remove': (i: { name: string }) => workspace.removeSkill(i.name),
  'task:forkPoints': (i: { taskId: string }) => workspace.forkPoints(i.taskId),
  'task:fork': (i: { taskId: string; upToMessageId?: string; isolate: boolean; instruction?: string }) => workspace.forkTask(i.taskId, i),
  'task:retry': (i: { taskId: string }) => workspace.retry(i.taskId),
  'task:resume': (i: { taskId: string }) => workspace.resume(i.taskId),
  'task:setAside': (i: { taskId: string; on: boolean }) => workspace.setAside(i.taskId, i.on),
  'task:remoteControl': (i: { taskId: string; on: boolean }) => workspace.setRemoteControl(i.taskId, i.on),
  'task:stop': (i: { taskId: string }) => workspace.stop(i.taskId),
  'task:rename': (i: { taskId: string; name: string }) => workspace.rename(i.taskId, i.name),
  'task:viewed': (i: { taskId: string }) => workspace.markViewed(i.taskId),
  'task:setPermissionMode': (i: { taskId: string; mode: PermissionMode }) => workspace.setPermissionMode(i.taskId, i.mode),
  'task:remove': (i: { taskId: string }) => workspace.remove(i.taskId),
  'sessions:discover': (i: { projectId: string; provider: 'claude' | 'codex' }) => workspace.discoverSessions(i.projectId, i.provider),
  'sessions:discoverAll': () => workspace.discoverAllSessions(),
  // Side questions ("btw"): never part of the agent's conversation.
  // The session map: an agent's turns grouped into tasks by a model (null: group by structure).
  'session:map': (i: { taskId: string }) => workspace.sessionMapGrouping(i.taskId),
  'btw:list': (i: { taskId: string }) => workspace.btwList(i.taskId),
  'btw:ask': (i: { taskId: string; question: string }) => workspace.askBtw(i.taskId, i.question),
  'btw:clear': (i: { taskId: string }) => workspace.clearBtw(i.taskId),
  // Typing a folder path in the project chooser: its subfolders, here or on a machine.
  'files:search': (i: { taskId: string; query: string }) => workspace.searchFiles(i.taskId, i.query),
  'files:dropped': (i: { taskId: string; paths: string[] }) => workspace.droppedFiles(i.taskId, i.paths),
  'fs:listDirs': (i: { dir: string; host?: string }) => workspace.listDirs(i.dir, i.host),
  'sessions:discoverHost': (i: { host: string }) => workspace.discoverHostSessions(i.host),
  'task:importSession': (i: Parameters<Workspace['importSession']>[0]) => workspace.importSession(i),
  'attention:respond': (i: { attentionId: string; decision?: string; answers?: Record<string, string> }) =>
    workspace.respondAttention(i.attentionId, i.decision, i.answers),
  'attention:dismiss': (i: { attentionId: string }) => workspace.dismissAttention(i.attentionId),
  'voice:ensureMic': async () => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  },
  'voice:transcribe': async (i: { audio: Uint8Array; mimeType: string }) => ({ text: await workspace.transcribe(i.audio, i.mimeType) }),
  'stt:download': (i: { id: string }) => void localStt.download(i.id),
  'stt:cancel': (i: { id: string }) => localStt.cancel(i.id),
  'stt:delete': (i: { id: string }) => localStt.remove(i.id),
  'route:decide': (i: { utterance: string; focusedTaskId: string | null; namedOnly?: boolean }) => workspace.decideRoute(i.utterance, i.focusedTaskId, i.namedOnly),
  'route:dispatch': (i: { utterance: string; focusedTaskId: string | null; target: Parameters<Workspace['dispatch']>[1]; interrupt?: boolean; typed?: boolean }) =>
    workspace.dispatch(i.utterance, i.target, i.focusedTaskId, { interrupt: i.interrupt, typed: i.typed }),
  'file:preview': async (i: { taskId: string; path: string; allowOutside?: boolean }) => {
    const p = await workspace.previewFile(i.taskId, i.path, i.allowOutside);
    if (p.kind === 'html') return { ...p, frameUrl: addPreviewDoc(p.text ?? '') };
    const { data, ...rest } = p;
    if (p.kind === 'pdf') return { ...rest, frameUrl: addPreviewDoc(data ?? new Uint8Array(), 'application/pdf', undefined) };
    if (p.kind === 'document') return { ...rest, frameUrl: addPreviewDoc(await documentToHtml(data ?? new Uint8Array(), p.path), 'text/html; charset=utf-8', DOCUMENT_CSP) };
    return rest;
  },
  // A cheap look for the preview's live refresh: changed since it was read? (This Mac only.)
  'file:stat': (i: { taskId: string; path: string; allowOutside?: boolean }) => {
    try {
      const s = statSync(workspace.previewLocalPath(i.taskId, i.path, i.allowOutside));
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
  // "Open with…": installed apps from a fixed catalog, with their icons (cached).
  'apps:installed': async () => {
    const apps = installedApps();
    return Promise.all(apps.map(async (a) => ({ id: a.id, name: a.name, kind: a.kind, lines: a.lines, icon: await appIcon(a.path) })));
  },
  // An agent's folder (no path) or one of its files, in that app; the file goes through the preview's checks.
  'apps:open': (i: { appId: string; taskId: string; path?: string; line?: number; allowOutside?: boolean }) => {
    const target = installedApps().find((a) => a.id === i.appId);
    if (!target) throw new Error('That app is not installed here.');
    const file = i.path ? workspace.previewLocalPath(i.taskId, i.path, i.allowOutside) : undefined;
    launch(launchCommand(target, file ?? workspace.agentFolder(i.taskId), { isFile: !!file, line: i.line }));
  },
  'file:open': async (i: { taskId: string; path: string; allowOutside?: boolean }) => {
    const file = workspace.previewLocalPath(i.taskId, i.path, i.allowOutside);
    // Only document types: openPath on a script or an app would run it.
    if (!openableKind(file)) throw new Error('Only documents (Markdown, HTML, images, text) can be opened from here.');
    const problem = await shell.openPath(file);
    if (problem) throw new Error(problem);
  },
  'memory:add': (i: { scope: 'global' | 'project' | 'task'; scopeId: string; body: string; title?: string; originTaskId?: string; approvedForReuse: boolean }) =>
    workspace.addMemory({ ...i, source: 'user' }),
  'memory:distill': (i: { taskId: string; itemId: string }) => workspace.distillMemory(i.taskId, i.itemId),
  'label:short': (i: { text: string }) => workspace.shortLabel(i.text),
  'main:newChapter': () => workspace.newMainChapter('manual'),
  'memory:update': (i: { id: string; body?: string; title?: string; approvedForReuse?: boolean }) => workspace.updateMemory(i.id, i),
  'memory:reach': (i: { id: string }) => workspace.memoryReach(i.id),
  'memory:tellNow': (i: { id: string }) => workspace.tellMemoryNow(i.id),
  'memory:delete': (i: { id: string }) => workspace.deleteMemory(i.id),
  'memory:promote': (i: { id: string; scope: 'project' | 'global' }) => workspace.promoteMemory(i.id, i.scope),
  'memory:scanImports': () => workspace.scanMemoryImports(),
  'memory:import': (i: { items: Parameters<Workspace['importMemory']>[0] }) => workspace.importMemory(i.items),
  'memory:syncNow': () => workspace.syncMemory(true),
  'settings:update': (i: Partial<Settings>) => workspace.updateSettings(i),
  'capabilities:refresh': (i: { localOnly?: boolean }) => workspace.refreshCapabilities({ localOnly: i?.localOnly }),
  // Sign-in runs the CLI's own login (it opens the browser); the capability check notices success.
  'provider:login': (i: { provider: 'claude' | 'codex'; method?: LoginMethod }) => startLogin(i.provider, i.method, () => void workspace.refreshCapabilities()),
  'provider:loginCancel': (i: { provider: 'claude' | 'codex' }) => cancelLogin(i.provider),
  'provider:loginApiKey': async (i: { key: string }) => {
    const r = await loginWithApiKey(i.key);
    await workspace.refreshCapabilities();
    return r;
  },
  'apps:detect': () => desktopApps(),
  'models:list': async () => workspace.openAi()?.listModels() ?? [],
  'openai:setKey': async (i: { key: string }) => {
    if (process.env.AMW_NO_OPENAI === '1') return { ok: false, error: 'OpenAI is disabled for this run (AMW_NO_OPENAI=1).' };
    const k = i.key.trim();
    const problem = await checkOpenAiKey(k);
    if (problem) return { ok: false, error: problem };
    keyStore.save(k);
    useBestKey();
    return { ok: true, overriddenByEnv: !!envOpenAiKey() };
  },
  'openai:clearKey': () => {
    keyStore.clear();
    useBestKey();
  },
  'demo:seed': () => {
    if (!demoMode) throw new Error('Demo agents are only available in the demo entry (npm run demo).');
    return workspace.seedDemo(ensureDemoRepo());
  },
};

function registerIpc(): void {
  for (const channel of Object.keys(ipcSchemas) as IpcChannel[]) {
    ipcMain.handle(channel, async (event, raw: unknown) => {
      if (!win || event.sender !== win.webContents) throw new Error('Unknown sender.');
      const parsed = ipcSchemas[channel].safeParse(raw ?? {});
      if (!parsed.success) throw new Error(`Invalid input for ${channel}: ${parsed.error.issues[0]?.message ?? ''}`);
      try {
        return await (handlers[channel] as (i: unknown) => unknown)(parsed.data);
      } catch (error) {
        log('ipc error', channel, error);
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
  }
}

function wireEvents(): void {
  let snapshotTimer: NodeJS.Timeout | undefined;
  workspace.onChange(() => {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      win?.webContents.send(EVENT_WORKSPACE, workspace.snapshot());
    }, 30);
  });
  // Batch transcript updates so a noisy stream cannot flood the renderer.
  const pending = new Map<string, TranscriptItem>();
  const resets = new Set<string>();
  let transcriptTimer: NodeJS.Timeout | undefined;
  workspace.onTranscript((taskId, item) => {
    if (item) pending.set(`${taskId}\u0000${item.id}`, { ...item });
    else {
      resets.add(taskId);
      for (const k of pending.keys()) if (k.startsWith(`${taskId}\u0000`)) pending.delete(k);
    }
    if (transcriptTimer) return;
    transcriptTimer = setTimeout(() => {
      transcriptTimer = undefined;
      const items = [...pending.values()];
      pending.clear();
      const reset = [...resets];
      resets.clear();
      win?.webContents.send(EVENT_TRANSCRIPT, { items, resets: reset });
    }, 50);
  });
}

/**
 * Automated tests run the app in the background (AMW_BACKGROUND=1): no window on screen, no Dock icon,
 * never the frontmost app, so a test run does not take the keyboard from whoever is typing. The page
 * still renders and runs its timers as if shown.
 */
const background = process.env.AMW_BACKGROUND === '1';
if (background && process.platform === 'darwin') app.setActivationPolicy('accessory');

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    ...(background ? { show: false, paintWhenInitiallyHidden: true } : {}),
    minWidth: 900,
    minHeight: 600,
    title: demoMode ? 'Agent Workspace — Demo' : 'Agent Workspace',
    backgroundColor: '#f4f5f7',
    // Native-looking frame: traffic lights sit inside the sidebar on macOS.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      // The mic opens at launch (meeting-style), before any click; without this
      // Chromium keeps the AudioContext suspended and the level stays at zero.
      autoplayPolicy: 'no-user-gesture-required',
      // Chromium's built-in PDF viewer, for PDF previews (no PDF library bundled).
      plugins: true,
      // Hidden in the background mode, it must keep rendering and running timers as if on screen.
      ...(background ? { backgroundThrottling: false } : {}),
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(appRoot, 'out/renderer/index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  // From source the Dock would show Electron's icon; packaged builds carry their own.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(appRoot, 'build', 'icon.png'));
  useBestKey(); // safeStorage can decrypt the saved key only after 'ready'
  // Microphone only (no camera, no screen) and writing to the clipboard (Copy buttons;
  // never reading it), and only for our own window.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] };
    const audioOnly = permission === 'media' && (media.mediaTypes ?? []).every((t) => t === 'audio');
    callback((audioOnly || permission === 'clipboard-sanitized-write') && wc === win?.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'clipboard-sanitized-write');
  if (!workspace.snapshot().settings.language) workspace.updateSettings({ language: app.getLocale().startsWith('zh') ? 'zh' : 'en' });
  registerIpc();
  servePreviews();
  wireEvents();
  createWindow();
  void workspace.refreshCapabilities();
  // Demo runs (and the tests built on them) leave the real native memory alone unless asked.
  if (!demoMode || process.env.AMW_MEMORY_SYNC === '1') workspace.startMemorySync();
  if (demoMode && workspace.snapshot().tasks.length === 0) void workspace.seedDemo(ensureDemoRepo());
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void workspace.shutdown().finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
