// Local speech-to-text with sherpa-onnx (Apache-2.0, prebuilt for darwin-arm64).
// Models are downloaded on request into an app-owned folder; nothing is installed
// globally. Model choice and the picker design follow VoiceInk / Spokenly: a
// catalogue with size, speed and languages, download → use → delete.
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LocalModelState } from '../../shared/types';

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

type Engine = { senseVoice: { model: string } } | { paraformer: { model: string } } | { whisper: { encoder: string; decoder: string } };

interface CatalogEntry {
  id: string;
  /** Archive (and folder) name in the sherpa-onnx asr-models release. */
  archive: string;
  label: string;
  sizeMb: number;
  languages: string;
  note: string;
  /** 1–5, from this app's own clips (zh, en, mixed); shown as dots in Settings. */
  accuracy: number;
  speed: number;
  files: { tokens: string } & ({ senseVoice: string } | { paraformer: string } | { encoder: string; decoder: string });
  /** All-caps English, no punctuation: normalise case after decoding. */
  upperCase?: boolean;
}

// Measured on an M-series Mac with this app's test clips (zh, en and mixed, 3–6 s each).
export const LOCAL_MODELS: CatalogEntry[] = [
  {
    id: 'sensevoice',
    accuracy: 4,
    speed: 5,
    archive: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    label: 'SenseVoice Small',
    sizeMb: 166,
    languages: 'zh · en · ja · ko · yue',
    note: 'Recommended: about 0.1 s per sentence, good with mixed Chinese and English',
    files: { senseVoice: 'model.int8.onnx', tokens: 'tokens.txt' },
    upperCase: true,
  },
  {
    id: 'whisper-turbo',
    accuracy: 4,
    speed: 2,
    archive: 'sherpa-onnx-whisper-turbo',
    label: 'Whisper large-v3 turbo',
    sizeMb: 564,
    languages: '99 languages',
    note: 'Most accurate locally, with punctuation; about 1.2 s per sentence',
    files: { encoder: 'turbo-encoder.int8.onnx', decoder: 'turbo-decoder.int8.onnx', tokens: 'turbo-tokens.txt' },
  },
  {
    id: 'whisper-base',
    accuracy: 2,
    speed: 4,
    archive: 'sherpa-onnx-whisper-base',
    label: 'Whisper base',
    sizeMb: 208,
    languages: '99 languages',
    note: 'Fast and very good for English; weak for Chinese',
    files: { encoder: 'base-encoder.int8.onnx', decoder: 'base-decoder.int8.onnx', tokens: 'base-tokens.txt' },
  },
  {
    id: 'paraformer-zh',
    accuracy: 3,
    speed: 5,
    archive: 'sherpa-onnx-paraformer-zh-int8-2025-10-07',
    label: 'Paraformer (Chinese)',
    sizeMb: 228,
    languages: 'zh',
    note: 'Chinese only; English words come out garbled',
    files: { paraformer: 'model.int8.onnx', tokens: 'tokens.txt' },
  },
];

type Sherpa = typeof import('sherpa-onnx-node');
type Recognizer = Awaited<ReturnType<Sherpa['OfflineRecognizer']['createAsync']>>;

export class LocalStt {
  private downloads = new Map<string, { progress: number; abort: AbortController; error?: string }>();
  private failed = new Map<string, string>();
  private recognizers = new Map<string, Promise<Recognizer>>();

  constructor(
    private dir: string,
    private onChange: () => void,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private entry(id: string): CatalogEntry {
    const e = LOCAL_MODELS.find((m) => m.id === id);
    if (!e) throw new Error(`Unknown local model ${id}`);
    return e;
  }

  private path(e: CatalogEntry, file: string): string {
    return join(this.dir, e.archive, file);
  }

  installed(id: string): boolean {
    const e = LOCAL_MODELS.find((m) => m.id === id);
    return !!e && Object.values(e.files).every((f) => existsSync(this.path(e, f)));
  }

  states(): LocalModelState[] {
    return LOCAL_MODELS.map((m) => {
      const d = this.downloads.get(m.id);
      return {
        id: m.id,
        label: m.label,
        sizeMb: m.sizeMb,
        languages: m.languages,
        note: m.note,
        accuracy: m.accuracy,
        speed: m.speed,
        installed: this.installed(m.id),
        progress: d ? d.progress : undefined,
        error: this.failed.get(m.id),
      };
    });
  }

  /** Downloads and unpacks a model (archive → .part → extracted folder). Progress is pushed via onChange. */
  async download(id: string): Promise<void> {
    const e = this.entry(id);
    if (this.installed(id) || this.downloads.has(id)) return;
    const abort = new AbortController();
    const state = { progress: 0, abort };
    this.downloads.set(id, state);
    this.failed.delete(id);
    this.onChange();
    const part = join(this.dir, `${e.archive}.tar.bz2.part`);
    try {
      const res = await fetch(`${RELEASE}/${e.archive}.tar.bz2`, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
      const total = Number(res.headers.get('content-length')) || e.sizeMb * 1_000_000;
      let got = 0;
      let last = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on('data', (chunk: Buffer) => {
        got += chunk.length;
        state.progress = Math.min(0.99, got / total);
        if (Date.now() - last > 250) {
          last = Date.now();
          this.onChange();
        }
      });
      await pipeline(body, createWriteStream(part));
      const archive = join(this.dir, `${e.archive}.tar.bz2`);
      renameSync(part, archive);
      // macOS tar (bsdtar) reads bzip2 natively. Sample audio and the full-precision
      // Whisper weights (only the int8 ones are used) are left out.
      await new Promise<void>((resolve, reject) =>
        execFile('tar', ['-xjf', archive, '-C', this.dir, '--exclude', '*/test_wavs/*', '--exclude', '*-encoder.onnx', '--exclude', '*-decoder.onnx'], (err) => (err ? reject(err) : resolve())),
      );
      rmSync(archive, { force: true });
      if (!this.installed(id)) throw new Error('The archive did not contain the expected model files.');
    } catch (error) {
      rmSync(part, { force: true });
      if (!abort.signal.aborted) this.failed.set(id, (error as Error).message);
    } finally {
      this.downloads.delete(id);
      this.onChange();
    }
  }

  cancel(id: string): void {
    this.downloads.get(id)?.abort.abort();
  }

  remove(id: string): void {
    const e = this.entry(id);
    this.cancel(id);
    this.recognizers.delete(id);
    rmSync(join(this.dir, e.archive), { recursive: true, force: true });
    this.failed.delete(id);
    this.onChange();
  }

  private recognizer(id: string): Promise<Recognizer> {
    let r = this.recognizers.get(id);
    if (!r) {
      const e = this.entry(id);
      const f = e.files as Record<string, string>;
      const engine: Engine = 'senseVoice' in f
        ? { senseVoice: { model: this.path(e, f.senseVoice) } }
        : 'paraformer' in f
          ? { paraformer: { model: this.path(e, f.paraformer) } }
          : { whisper: { encoder: this.path(e, f.encoder), decoder: this.path(e, f.decoder) } };
      const modelConfig = {
        ...engine,
        ...('senseVoice' in engine ? { senseVoice: { ...engine.senseVoice, useInverseTextNormalization: 1 } } : {}),
        ...('whisper' in engine ? { whisper: { ...engine.whisper, language: '', task: 'transcribe' } } : {}),
        tokens: this.path(e, f.tokens),
        numThreads: 4,
        provider: 'cpu',
        debug: 0,
      };
      // CommonJS addon: under dynamic import() its exports arrive as `default`.
      r = import('sherpa-onnx-node')
        .then((m) => ((m as { default?: Sherpa }).default ?? m) as Sherpa)
        .then((sherpa) => sherpa.OfflineRecognizer.createAsync({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig }));
      r.catch(() => this.recognizers.delete(id));
      this.recognizers.set(id, r);
    }
    return r;
  }

  /** Transcribes a 16-bit PCM WAV. `names` are agent names to restore when the model mangles them. */
  async transcribe(id: string, wav: Uint8Array, names: string[]): Promise<string> {
    if (!this.installed(id)) throw new Error('This local speech model is not downloaded yet (Settings › Voice).');
    const e = this.entry(id);
    const rec = await this.recognizer(id);
    const stream = rec.createStream();
    stream.acceptWaveform(parseWav(wav));
    const result = (await rec.decodeAsync(stream)) as { text?: string };
    return polish(result.text ?? '', names, !!e.upperCase);
  }
}

/** 16-bit PCM WAV (mono or stereo) → float samples. Tolerates streaming headers with a bogus data size. */
export function parseWav(bytes: Uint8Array): { sampleRate: number; samples: Float32Array } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let off = 12;
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(off + 10);
      rate = b.readUInt32LE(off + 12);
      bits = b.readUInt16LE(off + 22);
    }
    if (id === 'data') {
      if (bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
      const start = off + 8;
      const end = Math.min(b.length, size > 0 && size < 0xffffffff ? start + size : b.length);
      const n = Math.floor((end - start) / 2 / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = b.readInt16LE(start + i * 2 * channels) / 32768;
      return { sampleRate: rate, samples };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

const ACRONYMS = new Set(['API', 'UI', 'UX', 'CSS', 'SQL', 'PR', 'CI', 'CD', 'ID', 'URL', 'HTTP', 'JSON', 'AWS', 'CLI', 'SDK', 'DB', 'JS', 'TS', 'OK', 'AI', 'LLM']);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * Local models have no prompt to bias spelling, so restore agent names afterwards
 * ("CHARLY" → "Charlie") and undo SenseVoice's all-caps English.
 */
export function polish(text: string, names: string[], upperCase: boolean): string {
  let out = text.trim();
  if (upperCase)
    out = out.replace(/[A-Za-z][A-Za-z']*/g, (w) => (ACRONYMS.has(w) ? w : w.toLowerCase())).replace(/^[a-z]/, (c) => c.toUpperCase());
  const latin = names.filter((n) => /^[A-Za-z][A-Za-z0-9-]*$/.test(n));
  out = out.replace(/[A-Za-z][A-Za-z']*/g, (w, at: number, all: string) => {
    const lw = w.toLowerCase();
    // Near-misses are fixed only where a name is expected: at the start, after
    // "tell / ask / 让 / 给…", or next to Chinese text ("等一下 CHARLY 先别…").
    const before = all.slice(0, at).trimEnd();
    const vocative = !before || /[\u3400-\u9fff，。、,.!?！？:：]$/.test(before) || /\b(tell|ask|hey|ok|okay|and)$/i.test(before) || /[\u3400-\u9fff]/.test(all.slice(at + w.length).trimStart()[0] ?? '');
    for (const n of latin) {
      const ln = n.toLowerCase();
      if (lw === ln) return n;
      if (!vocative || ln.length <= 3) continue;
      const allowed = ln.length <= 5 ? 1 : 2;
      if (lw[0] === ln[0] && Math.abs(lw.length - ln.length) <= allowed && distance(lw, ln) <= allowed) return n;
    }
    return w;
  });
  return out;
}
