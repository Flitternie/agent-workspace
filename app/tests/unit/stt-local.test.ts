import { describe, expect, it } from 'vitest';
import { parseWav, polish } from '../../src/main/stt/local';

describe('local speech-to-text post-processing', () => {
  const names = ['Alice', 'Bob', 'Charlie', '小张'];
  it('undoes all-caps English and restores agent names where a name is expected', () => {
    expect(polish('ALICE ADD A REGRESION TEST FOR THE API', names, true)).toBe('Alice add a regresion test for the API');
    expect(polish('等一下 CHARLY 先别删那个表', names, true)).toBe('等一下 Charlie 先别删那个表');
    expect(polish('tell charly to stop', names, false)).toBe('tell Charlie to stop');
  });
  it('leaves ordinary words alone', () => {
    expect(polish('put it in the box', names, false)).toBe('put it in the box');
    expect(polish('make it look alike', names, false)).toBe('make it look alike');
    expect(polish('小张先停一下', names, true)).toBe('小张先停一下');
  });
  it('parses 16-bit WAV, including streaming headers with an unknown size', () => {
    const data = Buffer.alloc(8);
    data.writeInt16LE(16384, 0);
    data.writeInt16LE(-32768, 2);
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.write('WAVE', 8);
    h.write('fmt ', 12);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(24000, 24);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(0xffffffff, 40);
    const w = parseWav(new Uint8Array(Buffer.concat([h, data])));
    expect(w.sampleRate).toBe(24000);
    expect([...w.samples.slice(0, 2)]).toEqual([0.5, -1]);
  });
});
