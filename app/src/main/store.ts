import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AttentionItem,
  CoordinatorEntry,
  MemoryRecord,
  Project,
  SessionRecord,
  Settings,
  Task,
  TranscriptItem,
} from '../shared/types';

export interface WorkspaceData {
  version: 1;
  projects: Project[];
  tasks: Task[];
  sessions: SessionRecord[];
  attention: AttentionItem[];
  memory: MemoryRecord[];
  coordinator: CoordinatorEntry[];
  settings: Settings;
  /** Monotonic counter behind task aliases A, B, … Z, AA, … (never reused). */
  aliasCounter: number;
}

const empty = (): WorkspaceData => ({
  version: 1,
  projects: [],
  tasks: [],
  sessions: [],
  attention: [],
  memory: [],
  coordinator: [],
  settings: { alwaysConfirmVoice: false, autoListen: true },
  aliasCounter: 0,
});

/** Write-then-rename so a crash mid-write never leaves a truncated file. */
export function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * Durable local store: one JSON document for workspace state plus one file per
 * task transcript display cache. Writes are debounced; flush() forces them.
 * The transcript cache is for display only; native sessions stay authoritative
 * and replace it on resume.
 */
export class JsonStore {
  data: WorkspaceData;
  private transcripts = new Map<string, TranscriptItem[]>();
  private dirtyTranscripts = new Set<string>();
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly dir: string,
    private debounceMs = 150,
  ) {
    mkdirSync(join(dir, 'transcripts'), { recursive: true });
    const file = join(dir, 'workspace.json');
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WorkspaceData>;
      this.data = { ...empty(), ...parsed, settings: { ...empty().settings, ...parsed.settings } };
    } else {
      this.data = empty();
    }
  }

  transcript(taskId: string): TranscriptItem[] {
    let items = this.transcripts.get(taskId);
    if (!items) {
      const file = this.transcriptFile(taskId);
      items = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as TranscriptItem[]) : [];
      this.transcripts.set(taskId, items);
    }
    return items;
  }

  setTranscript(taskId: string, items: TranscriptItem[]): void {
    this.transcripts.set(taskId, items);
    this.touchTranscript(taskId);
  }

  touchTranscript(taskId: string): void {
    this.dirtyTranscripts.add(taskId);
    this.schedule();
  }

  save(): void {
    this.dirty = true;
    this.schedule();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.dirty) atomicWrite(join(this.dir, 'workspace.json'), JSON.stringify(this.data, null, 2));
    this.dirty = false;
    for (const id of this.dirtyTranscripts) {
      const items = this.transcripts.get(id);
      if (items) atomicWrite(this.transcriptFile(id), JSON.stringify(items));
    }
    this.dirtyTranscripts.clear();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private transcriptFile(taskId: string): string {
    return join(this.dir, 'transcripts', `${taskId.replace(/[^a-zA-Z0-9-]/g, '')}.json`);
  }
}

export function aliasFor(n: number): string {
  let s = '';
  let x = n;
  do {
    s = String.fromCharCode(65 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}
