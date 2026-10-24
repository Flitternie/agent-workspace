import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptItem, WorkspaceSnapshot } from '../shared/types';
import { call } from './api';
import { t } from './i18n';

/** Snapshot-on-start, then push updates from the main process (spec 03: recover from missed events). */
export function useWorkspace(): WorkspaceSnapshot | null {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  useEffect(() => {
    const off = window.amw.onWorkspace(setSnapshot);
    void call('workspace:snapshot', {}).then(setSnapshot);
    return off;
  }, []);
  return snapshot;
}

/** Transcripts are loaded per task on demand and kept current from pushed item upserts. */
export function useTranscripts(): {
  transcripts: Record<string, TranscriptItem[]>;
  load: (taskId: string) => void;
} {
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptItem[]>>({});
  const loaded = useRef(new Set<string>());
  useEffect(
    () =>
      window.amw.onTranscript(({ items, resets }) => {
        // The native history replaced this task's transcript (resume): reload it wholesale.
        for (const taskId of resets)
          if (loaded.current.has(taskId))
            void call('transcript:get', { taskId }).then((list) => setTranscripts((prev) => ({ ...prev, [taskId]: list })));
        setTranscripts((prev) => {
          const next = { ...prev };
          for (const item of items) {
            if (!loaded.current.has(item.taskId)) continue;
            const list = [...(next[item.taskId] ?? [])];
            const i = list.findIndex((x) => x.id === item.id);
            if (i === -1) list.push(item);
            else list[i] = item;
            next[item.taskId] = list;
          }
          return next;
        });
      }),
    [],
  );
  const load = useCallback((taskId: string) => {
    loaded.current.add(taskId);
    void call('transcript:get', { taskId }).then((items) => setTranscripts((prev) => ({ ...prev, [taskId]: items })));
  }, []);
  return { transcripts, load };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return t('just now');
  const m = Math.round(s / 60);
  if (m < 60) return t('{n}m ago', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('{n}h ago', { n: h });
  return t('{n}d ago', { n: Math.round(h / 24) });
}

/** Re-render periodically so relative times stay fresh. */
export function useTick(ms = 30_000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}
