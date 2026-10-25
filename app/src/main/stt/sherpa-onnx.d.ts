// Minimal typings for the parts of sherpa-onnx-node (Apache-2.0) used here.
declare module 'sherpa-onnx-node' {
  export interface OfflineStream {
    acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
  }
  export class OfflineRecognizer {
    static createAsync(config: unknown): Promise<OfflineRecognizer>;
    createStream(hotwords?: string): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string }>;
  }
}
