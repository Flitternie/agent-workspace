import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } from 'electron';
import { EVENT_TRANSCRIPT, EVENT_WORKSPACE, ipcSchemas, type IpcChannel } from '../shared/ipc';
import type { Settings, TranscriptItem } from '../shared/types';
import { loadOpenAiKey, OpenAiClient } from './openai';
import { ClaudeAdapter } from './providers/claude';
import { CodexAdapter } from './providers/codex';
import { MockAdapter } from './providers/mock';
import { Workspace } from './workspace';

// All app state lives in one app-owned directory (default: <app>/.data) so the
// prototype never touches other apps' or the user's global configuration.
const appRoot = app.getAppPath();
// `npm run demo` (AMW_MODE=demo) is a separate entry with mock agents and its own
// data dir, so the real workspace never fills up with demo tasks.
const demoMode = process.env.AMW_MODE === 'demo';
const dataDir = process.env.AMW_DATA_DIR ?? join(appRoot, demoMode ? '.data-demo' : '.data');
mkdirSync(dataDir, { recursive: true });
app.setPath('userData', join(dataDir, 'electron'));
app.setName('Agent Meeting Workspace');

const log = (...args: unknown[]) => {
  if (process.env.AMW_DEBUG) console.log('[amw]', ...args);
};

const key = loadOpenAiKey(appRoot);
const openai = key ? new OpenAiClient(key) : undefined;
const workspace = new Workspace({
  dataDir,
  adapters: {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    mock: new MockAdapter(join(dataDir, 'mock-sessions')),
  },
  openai,
  log,
  demo: demoMode,
});

let win: BrowserWindow | null = null;

function ensureDemoRepo(): string {
  const dir = join(dataDir, 'demo-repo');
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# demo-shop\n\nA tiny demo repository for Agent Meeting Workspace.\n');
    writeFileSync(join(dir, 'src', 'orders.ts'), 'export function listOrders() {\n  return [];\n}\n');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['-c', 'user.email=demo@local', '-c', 'user.name=demo', 'commit', '-qm', 'init'], { cwd: dir });
  }
  return dir;
}

type Handler = (input: never) => unknown;
const handlers: { [C in IpcChannel]: Handler } = {
  'workspace:snapshot': () => workspace.snapshot(),
  'transcript:get': (i: { taskId: string }) => workspace.transcript(i.taskId),
  'project:pickDirectory': async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  },
  'project:add': (i: { rootPath: string; name?: string }) => workspace.addProject(i.rootPath, i.name),
  'task:create': (i: Parameters<Workspace['createTask']>[0]) => workspace.createTask(i),
  'task:send': (i: { taskId: string; text: string; via: 'text' | 'card' }) => workspace.send(i.taskId, i.text, i.via),
  'task:interrupt': (i: { taskId: string }) => workspace.interrupt(i.taskId),
  'task:resume': (i: { taskId: string }) => workspace.resume(i.taskId),
  'task:stop': (i: { taskId: string }) => workspace.stop(i.taskId),
  'task:rename': (i: { taskId: string; name: string }) => workspace.rename(i.taskId, i.name),
  'task:remove': (i: { taskId: string }) => workspace.remove(i.taskId),
  'sessions:discover': (i: { projectId: string; provider: 'claude' | 'codex' }) => workspace.discoverSessions(i.projectId, i.provider),
  'task:importSession': (i: Parameters<Workspace['importSession']>[0]) => workspace.importSession(i),
  'attention:respond': (i: { attentionId: string; decision?: string; answers?: Record<string, string> }) =>
    workspace.respondAttention(i.attentionId, i.decision, i.answers),
  'attention:dismiss': (i: { attentionId: string }) => workspace.dismissAttention(i.attentionId),
  'voice:ensureMic': async () => {
    if (process.platform !== 'darwin') return true;
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
    return systemPreferences.askForMediaAccess('microphone');
  },
  'voice:transcribe': async (i: { audio: Uint8Array; mimeType: string }) => {
    if (!openai) throw new Error('Speech-to-text is not configured (no OpenAI key). Typed input still works.');
    // Task names help the recognizer with handles like "Agent C" or project names.
    const s = workspace.snapshot();
    const hint = ['Agent Meeting Workspace.', ...s.tasks.map((t) => `Agent ${t.alias} ${t.name}: ${t.title}.`)].join(' ');
    return { text: await openai.transcribe(i.audio, i.mimeType, hint) };
  },
  'route:decide': (i: { utterance: string; focusedTaskId: string | null }) => workspace.decideRoute(i.utterance, i.focusedTaskId),
  'route:dispatch': (i: { utterance: string; focusedTaskId: string | null; target: Parameters<Workspace['dispatch']>[1] }) =>
    workspace.dispatch(i.utterance, i.target, i.focusedTaskId),
  'memory:add': (i: { scope: 'global' | 'project' | 'task'; scopeId: string; body: string; originTaskId?: string; approvedForReuse: boolean }) =>
    workspace.addMemory({ ...i, source: 'user' }),
  'memory:update': (i: { id: string; body?: string; approvedForReuse?: boolean }) => workspace.updateMemory(i.id, i),
  'memory:delete': (i: { id: string }) => workspace.deleteMemory(i.id),
  'memory:promote': (i: { id: string; scope: 'project' | 'global' }) => workspace.promoteMemory(i.id, i.scope),
  'settings:update': (i: Partial<Settings>) => workspace.updateSettings(i),
  'capabilities:refresh': () => workspace.refreshCapabilities(),
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
    title: demoMode ? 'Agent Meeting Workspace — Demo' : 'Agent Meeting Workspace',
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
  // Microphone only (no camera, no screen), and only for our own window.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = details as { mediaTypes?: string[] };
    const audioOnly = permission === 'media' && (media.mediaTypes ?? []).every((t) => t === 'audio');
    callback(audioOnly && wc === win?.webContents);
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  if (!workspace.snapshot().settings.language) workspace.updateSettings({ language: app.getLocale().startsWith('zh') ? 'zh' : 'en' });
  registerIpc();
  wireEvents();
  createWindow();
  void workspace.refreshCapabilities();
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
