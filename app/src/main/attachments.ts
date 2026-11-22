import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImageRef } from '../shared/types';

/**
 * The images a message carries, kept once in the app's data folder and named by their content
 * (the same image pasted twice is one file). The transcript records only the reference, so the
 * conversation shows its images without depending on the CLI's own session files, and each CLI is
 * handed the file (Codex on this computer) or its bytes (Claude, and Codex over SSH).
 *
 * Only formats both CLIs accept are stored; the renderer converts anything else, and shrinks an
 * image that is too large, before saving (a too-large image breaks a Claude session for good,
 * since every later turn sends it again).
 */

/** Anthropic's limit is 5 MB of base64 per image; the bytes stay under it with room to spare. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Images per message. */
export const MAX_IMAGES = 10;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ID = /^[0-9a-f]{24}\.(png|jpg|gif|webp)$/;

/** The image format from its first bytes (what a file or the clipboard says it is can be wrong). */
export function imageType(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

export class AttachmentStore {
  constructor(private dir: string) {}

  static validId(id: string): boolean {
    return ID.test(id);
  }

  /** Stores an image (or finds it already stored) and returns its reference. */
  save(bytes: Uint8Array, name?: string, opts: { anySize?: boolean } = {}): ImageRef {
    const mediaType = imageType(bytes);
    if (!mediaType) throw new Error('Not a PNG, JPEG, GIF or WebP image.');
    if (!opts.anySize && bytes.length > MAX_IMAGE_BYTES) throw new Error(`The image is too large (${(bytes.length / 1e6).toFixed(1)} MB; at most ${(MAX_IMAGE_BYTES / 1e6).toFixed(1)} MB).`);
    const id = `${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}.${EXT[mediaType]}`;
    const path = this.path(id);
    if (!existsSync(path)) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path, bytes);
    }
    return { id, mediaType, ...(name ? { name: name.slice(0, 200) } : {}) };
  }

  /**
   * Stores an image read back from a CLI's history (base64 bytes or a file on this computer), to show in
   * the conversation; undefined when it is not one it can keep. Any size: the CLI already took it.
   */
  saveFromHistory(src: { data: string } | { path: string }): ImageRef | undefined {
    try {
      return this.save('data' in src ? Buffer.from(src.data, 'base64') : readFileSync(src.path), undefined, { anySize: true });
    } catch {
      return undefined;
    }
  }

  path(id: string): string {
    if (!ID.test(id)) throw new Error(`Not an image reference: ${id}`);
    return join(this.dir, id);
  }

  has(id: string): boolean {
    return ID.test(id) && existsSync(join(this.dir, id));
  }

  read(id: string): Buffer {
    return readFileSync(this.path(id));
  }
}
