import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_TRANSCRIPT, EVENT_WORKSPACE, IPC_CHANNELS } from '../shared/ipc';

// Narrow bridge: only named, validated channels; no Node, no generic exec.
const allowed = new Set<string>(IPC_CHANNELS);

contextBridge.exposeInMainWorld('amw', {
  invoke(channel: string, payload?: unknown) {
    if (!allowed.has(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, payload ?? {});
  },
  onWorkspace(cb: (snapshot: unknown) => void) {
    const listener = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on(EVENT_WORKSPACE, listener);
    return () => ipcRenderer.removeListener(EVENT_WORKSPACE, listener);
  },
  onTranscript(cb: (update: unknown) => void) {
    const listener = (_e: unknown, items: unknown) => cb(items);
    ipcRenderer.on(EVENT_TRANSCRIPT, listener);
    return () => ipcRenderer.removeListener(EVENT_TRANSCRIPT, listener);
  },
});
