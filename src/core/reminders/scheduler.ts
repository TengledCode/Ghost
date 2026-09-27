import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface Reminder { id: string; text: string; due: string; created: string }

/** Persisted one-shot reminders. Survives restarts; overdue ones fire on the next start. */
export class ReminderScheduler {
  private items: Reminder[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly onDue: (r: Reminder) => void,
    private readonly now: () => number = Date.now,
  ) {
    try { this.items = JSON.parse(readFileSync(file, 'utf8')); } catch { this.items = []; }
  }

  start(intervalMs = 5_000): void {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  add(text: string, when: { at?: string; inMinutes?: number }): Reminder {
    let due: number;
    if (typeof when.inMinutes === 'number' && Number.isFinite(when.inMinutes)) due = this.now() + when.inMinutes * 60_000;
    else if (when.at && Number.isFinite(Date.parse(when.at))) due = Date.parse(when.at);
    else throw new Error('Give either in_minutes or an ISO 8601 "at" time.');
    if (due < this.now() - 60_000) throw new Error('That time is already in the past.');
    const r = { id: randomUUID().slice(0, 8), text: text.trim(), due: new Date(due).toISOString(), created: new Date(this.now()).toISOString() };
    this.items.push(r);
    this.save();
    return r;
  }

  cancel(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter(r => r.id !== id);
    if (before !== this.items.length) this.save();
    return before !== this.items.length;
  }

  list(): Reminder[] { return [...this.items].sort((a, b) => a.due.localeCompare(b.due)); }

  tick(): void {
    const now = this.now();
    const due = this.items.filter(r => Date.parse(r.due) <= now);
    if (!due.length) return;
    this.items = this.items.filter(r => Date.parse(r.due) > now);
    this.save();
    for (const r of due) this.onDue(r);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}
