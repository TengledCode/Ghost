import { readFileSync, writeFileSync } from 'node:fs';

/** When Aaron was last around, and what Ghost said last time it started (so greetings vary). */
export interface Presence { lastSeen?: number; lastGreeting?: string }

export class PresenceStore {
  private data: Presence = {};

  constructor(private readonly file: string) {
    try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* first run */ }
  }

  get(): Presence { return { ...this.data }; }

  update(patch: Presence): void {
    this.data = { ...this.data, ...patch };
    try { writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* best effort */ }
  }
}
