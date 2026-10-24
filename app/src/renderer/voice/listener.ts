/**
 * Always-on microphone with on-device voice activity detection (meeting-style).
 *
 * Audio is analysed locally frame by frame; only segments that contain speech
 * are encoded (16-bit mono WAV) and handed to `onUtterance`. Silence and
 * background noise never leave the machine. Muting stops the stream entirely,
 * so the OS microphone indicator turns off too.
 */

export interface ListenerHandlers {
  /** 0..1 input level, ~15 times a second, for the meter. */
  onLevel?: (level: number) => void;
  onSpeechStart?: () => void;
  /** Speech ended. `wav` is a complete WAV file. */
  onUtterance: (wav: Uint8Array<ArrayBuffer>, durationMs: number) => void;
  /** Speech was too short to be a command (cough, click). */
  onDiscard?: () => void;
}

const FRAME = 1024; // samples per analysis frame (~64 ms at 16 kHz)
const PRE_ROLL_FRAMES = 5; // keep ~320 ms before speech starts
const START_FRAMES = 2; // consecutive loud frames to open a segment
const END_SILENCE_MS = 850; // pause that ends an utterance
const MIN_VOICED_MS = 350; // shorter than this is noise
const MAX_UTTERANCE_MS = 30_000;

export class ContinuousListener {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: ScriptProcessorNode;
  private source?: MediaStreamAudioSourceNode;
  private noiseFloor = 0.004;
  private preRoll: Float32Array[] = [];
  private segment: Float32Array[] | null = null;
  private loudRun = 0;
  private silentFrames = 0;
  private voicedFrames = 0;
  private levelTick = 0;

  constructor(private h: ListenerHandlers) {}

  get active(): boolean {
    return !!this.stream;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    // Ask for 16 kHz so clips are small; Chromium resamples the device for us.
    const ctx = new AudioContext({ sampleRate: 16_000 });
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor is deprecated but needs no extra module file (the CSP forbids blob: workers).
    this.node = ctx.createScriptProcessor(FRAME, 1, 1);
    this.node.onaudioprocess = (e) => {
      this.frame(new Float32Array(e.inputBuffer.getChannelData(0)));
      e.outputBuffer.getChannelData(0).fill(0);
    };
    this.source.connect(this.node);
    this.node.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
    this.reset();
  }

  stop(): void {
    this.node?.disconnect();
    this.source?.disconnect();
    if (this.node) this.node.onaudioprocess = null;
    void this.ctx?.close().catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.ctx = undefined;
    this.node = undefined;
    this.source = undefined;
    this.reset();
    this.h.onLevel?.(0);
  }

  private reset(): void {
    this.preRoll = [];
    this.segment = null;
    this.loudRun = 0;
    this.silentFrames = 0;
    this.voicedFrames = 0;
  }

  private frame(samples: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / samples.length);
    const rate = this.ctx?.sampleRate ?? 16_000;
    const frameMs = (samples.length / rate) * 1000;
    const startThreshold = Math.max(this.noiseFloor * 3.2, 0.012);
    const keepThreshold = Math.max(this.noiseFloor * 2, 0.008);

    if (++this.levelTick % 2 === 0) this.h.onLevel?.(Math.min(1, rms / 0.12));

    if (!this.segment) {
      // Track background noise only while nobody is talking.
      this.noiseFloor = Math.min(0.05, Math.max(0.002, this.noiseFloor * 0.96 + rms * 0.04));
      this.preRoll.push(samples);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.loudRun = rms > startThreshold ? this.loudRun + 1 : 0;
      if (this.loudRun >= START_FRAMES) {
        this.segment = [...this.preRoll];
        this.preRoll = [];
        this.voicedFrames = this.loudRun;
        this.silentFrames = 0;
        this.h.onSpeechStart?.();
      }
      return;
    }

    this.segment.push(samples);
    if (rms > keepThreshold) {
      this.voicedFrames++;
      this.silentFrames = 0;
    } else this.silentFrames++;

    const total = this.segment.length * frameMs;
    if (this.silentFrames * frameMs >= END_SILENCE_MS || total >= MAX_UTTERANCE_MS) {
      const voicedMs = this.voicedFrames * frameMs;
      // Keep ~250 ms of the trailing pause; drop the rest.
      const keep = this.segment.length - Math.max(0, this.silentFrames - Math.ceil(250 / frameMs));
      const frames = this.segment.slice(0, keep);
      this.segment = null;
      this.loudRun = 0;
      this.silentFrames = 0;
      this.voicedFrames = 0;
      if (voicedMs < MIN_VOICED_MS) {
        this.h.onDiscard?.();
        return;
      }
      this.h.onUtterance(encodeWav(frames, rate), frames.length * frameMs);
    }
  }
}

export function encodeWav(frames: Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const length = frames.reduce((n, f) => n + f.length, 0);
  const buf = new ArrayBuffer(44 + length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, length * 2, true);
  let o = 44;
  for (const f of frames)
    for (let i = 0; i < f.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, f[i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  return new Uint8Array(buf);
}

/** STT models sometimes "hear" stock phrases in near-silence. */
export function isLikelyNoise(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[.!?。！？,，\s]+$/g, '');
  if (t.length < 2) return true;
  return /^(thank you|thanks|thanks for watching|bye|you|uh|um|hmm|嗯|啊|谢谢|谢谢观看|字幕.*|请不吝点赞.*)$/.test(t);
}
