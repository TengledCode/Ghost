import { app, safeStorage } from 'electron';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSettings, type Settings } from '../shared/settings';

export class SettingsStore extends EventEmitter {
  private current: Settings;
  private readonly file = join(app.getPath('userData'), 'settings.json');
  private readonly secretsFile = join(app.getPath('userData'), 'secrets.json');

  constructor() {
    super();
    let stored: Partial<Settings> | null = null;
    try { stored = JSON.parse(readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.current = mergeSettings(stored);
  }

  get(): Settings { return this.current; }

  update(patch: Partial<Settings>): Settings {
    const before = this.current;
    this.current = mergeSettings({ ...this.current, ...patch });
    mkdirSync(app.getPath('userData'), { recursive: true });
    // Written to a temp file first, so a crash mid-write can't leave a half-written settings file.
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.current, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
    this.emit('change', this.current, before);
    return this.current;
  }

  // ElevenLabs key, encrypted with the Windows user's DPAPI via safeStorage.
  getSecret(name: string): string {
    try {
      const all = JSON.parse(readFileSync(this.secretsFile, 'utf8'));
      if (!all[name]) return '';
      const buf = Buffer.from(all[name], 'base64');
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    } catch { return ''; }
  }

  setSecret(name: string, value: string): void {
    let all: Record<string, string> = {};
    try { all = JSON.parse(readFileSync(this.secretsFile, 'utf8')); } catch { /* none yet */ }
    if (!value) delete all[name];
    else all[name] = (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value) : Buffer.from(value)).toString('base64');
    writeFileSync(this.secretsFile, JSON.stringify(all));
  }
}
