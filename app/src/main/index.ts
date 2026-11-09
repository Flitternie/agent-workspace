import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, systemPreferences } from 'electron';
import { EVENT_TRANSCRIPT, EVENT_WORKSPACE, ipcSchemas, type IpcChannel } from '../shared/ipc';
import { previewKind } from '../shared/preview';
import type { PermissionMode, Settings, TranscriptItem } from '../shared/types';
import { KeyStore } from './keystore';
import { checkOpenAiKey, envOpenAiKey, loadOpenAiKey, OpenAiClient } from './openai';
import { ClaudeAdapter } from './providers/claude';
import { CodexAdapter } from './providers/codex';
import { MockAdapter } from './providers/mock';
import { LocalStt } from './stt/local';
import { Workspace } from './workspace';

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
const previewDocs = new Map<string, string>();
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } }]);

function servePreviews(): void {
  protocol.handle(PREVIEW_SCHEME, (req) => {
    const html = previewDocs.get(new URL(req.url).pathname.slice(1));
    if (html === undefined) return new Response('Preview expired. Refresh it.', { status: 404 });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PREVIEW_CSP } });
  });
}

/** Keeps the latest few documents (one per refresh); older frames show "expired". */
function addPreviewDoc(html: string): string {
  const key = randomUUID();
  previewDocs.set(key, html);
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
  'ssh:hosts': () => workspace.sshHosts(),
  'ssh:setEnabled': (i: { host: string; enabled: boolean }) => workspace.setHostEnabled(i.host, i.enabled),
  'ssh:check': (i: { host: string }) => workspace.checkHost(i.host),
  'ssh:connect': (i: { host: string }) => workspace.connectHost(i.host),
  'ssh:terminal': (i: { host: string }) => workspace.openHostTerminal(i.host),
  'task:create': (i: Parameters<Workspace['createTask']>[0]) => workspace.createTask(i),
  'task:send': (i: { taskId: string; text: string; via: 'text' | 'card'; interrupt?: boolean }) => workspace.send(i.taskId, i.text, i.via, { interrupt: i.interrupt }),
  'task:interrupt': (i: { taskId: string }) => workspace.interrupt(i.taskId),
  'task:shell': (i: { taskId: string; command: string }) => workspace.runShell(i.taskId, i.command),
  'skills:list': () => workspace.skills.list(),
  'skills:scan': () => workspace.scanSkills(),
  'skills:import': (i: { key: string }) => workspace.importSkill(i.key),
  'skills:setEnabled': (i: { name: string; enabled: boolean }) => workspace.setSkillEnabled(i.name, i.enabled),
  'skills:remove': (i: { name: string }) => workspace.removeSkill(i.name),
  'task:forkPoints': (i: { taskId: string }) => workspace.forkPoints(i.taskId),
  'task:fork': (i: { taskId: string; upToMessageId?: string; isolate: boolean; instruction?: string }) => workspace.forkTask(i.taskId, i),
  'task:retry': (i: { taskId: string }) => workspace.retry(i.taskId),
  'task:resume': (i: { taskId: string }) => workspace.resume(i.taskId),
  'task:stop': (i: { taskId: string }) => workspace.stop(i.taskId),
  'task:rename': (i: { taskId: string; name: string }) => workspace.rename(i.taskId, i.name),
  'task:setPermissionMode': (i: { taskId: string; mode: PermissionMode }) => workspace.setPermissionMode(i.taskId, i.mode),
  'task:remove': (i: { taskId: string }) => workspace.remove(i.taskId),
  'sessions:discover': (i: { projectId: string; provider: 'claude' | 'codex' }) => workspace.discoverSessions(i.projectId, i.provider),
  'sessions:discoverAll': () => workspace.discoverAllSessions(),
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
  'file:preview': async (i: { taskId: string; path: string }) => {
    const p = await workspace.previewFile(i.taskId, i.path);
    return p.kind === 'html' ? { ...p, frameUrl: addPreviewDoc(p.text ?? '') } : p;
  },
  'file:open': async (i: { taskId: string; path: string }) => {
    const file = workspace.previewLocalPath(i.taskId, i.path);
    // Only document types: openPath on a script or an app would run it.
    if (!previewKind(file)) throw new Error('Only previewable files can be opened from here.');
    const problem = await shell.openPath(file);
    if (problem) throw new Error(problem);
  },
  'memory:add': (i: { scope: 'global' | 'project' | 'task'; scopeId: string; body: string; originTaskId?: string; approvedForReuse: boolean }) =>
    workspace.addMemory({ ...i, source: 'user' }),
  'memory:update': (i: { id: string; body?: string; approvedForReuse?: boolean }) => workspace.updateMemory(i.id, i),
  'memory:delete': (i: { id: string }) => workspace.deleteMemory(i.id),
  'memory:promote': (i: { id: string; scope: 'project' | 'global' }) => workspace.promoteMemory(i.id, i.scope),
  'memory:scanImports': () => workspace.scanMemoryImports(),
  'memory:import': (i: { items: Parameters<Workspace['importMemory']>[0] }) => workspace.importMemory(i.items),
  'memory:syncNow': () => workspace.syncMemory(true),
  'settings:update': (i: Partial<Settings>) => workspace.updateSettings(i),
  'capabilities:refresh': () => workspace.refreshCapabilities(),
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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
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
