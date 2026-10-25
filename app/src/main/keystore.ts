// The OpenAI key entered in Settings, encrypted with Electron safeStorage (macOS:
// a key held in the login Keychain) and kept in the app's data folder. The plain
// key lives only in the main process; the renderer only ever sees its last four characters.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

export class KeyStore {
  private file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'openai-key.enc');
  }

  /** Only after app 'ready'; undefined when nothing is saved or it cannot be decrypted. */
  load(): string | undefined {
    if (!existsSync(this.file) || !safeStorage.isEncryptionAvailable()) return undefined;
    try {
      return safeStorage.decryptString(readFileSync(this.file)).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  save(key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available on this system, so the key cannot be saved. Set OPENAI_API_KEY instead.');
    writeFileSync(this.file, safeStorage.encryptString(key), { mode: 0o600 });
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
