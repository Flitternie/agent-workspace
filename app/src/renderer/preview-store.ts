// The file each agent's preview shows, kept per agent on this machine: switching to another agent
// and back finds it where it was (as DeepSeek Harness keeps a right Sidebar per session).

export interface PreviewState {
  /** Showing the file's changes from the agent's latest turn rather than the file. */
  diff?: boolean;
  path: string;
  line?: number;
}

const KEY = (taskId: string) => `amw.preview.${taskId}`;

export function savedPreview(taskId: string): PreviewState | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(taskId)) ?? 'null') as PreviewState | null;
    return v && typeof v.path === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function savePreview(taskId: string, state: PreviewState | null): void {
  if (state) localStorage.setItem(KEY(taskId), JSON.stringify(state));
  else localStorage.removeItem(KEY(taskId));
}
