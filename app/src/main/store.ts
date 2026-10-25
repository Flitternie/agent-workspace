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
  /** Monotonic counter behind agent names (never reused). */
  aliasCounter: number;
  /** The main agent's task record (kept apart from `tasks`: not a worker). */
  mainAgent?: Task;
}

const empty = (): WorkspaceData => ({
  version: 1,
  projects: [],
  tasks: [],
  sessions: [],
  attention: [],
  memory: [],
  coordinator: [],
  settings: { alwaysConfirmVoice: false, autoListen: true, permissionMode: 'auto' },
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

// Agents are addressed by name, as in a meeting: "Alice, add a test" / "小王，跑一下测试".
// English names have distinct first letters and are not everyday words; the
// Chinese ones are common "小+surname" handles chosen to sound distinct to STT
// (no 王/黄, 张/郑, 孙/宋 pairs).
export const AGENT_NAMES = {
  en: ['Alice', 'Bob', 'Charlie', 'Diana', 'Ethan', 'Fiona', 'George', 'Hannah', 'Isaac', 'Julia', 'Kevin', 'Laura', 'Mason', 'Nora', 'Oscar', 'Penny', 'Quentin', 'Rachel', 'Simon', 'Tara', 'Ulysses', 'Victor', 'Wendy', 'Xavier', 'Yvonne', 'Zack'],
  zh: ['小王', '小李', '小张', '小刘', '小陈', '小杨', '小赵', '小周', '小徐', '小马', '小朱', '小郭', '小林', '小高', '小罗', '小梁', '小谢', '小宋', '小唐', '小韩', '小冯', '小邓', '小曹', '小魏', '小蒋', '小沈'],
} as const;

/** n-th agent name; after the list runs out, names repeat with a number (Alice2). */
export function aliasFor(n: number, lang: 'en' | 'zh' = 'en'): string {
  const names = AGENT_NAMES[lang];
  const round = Math.floor(n / names.length);
  return `${names[n % names.length]}${round ? round + 1 : ''}`;
}
