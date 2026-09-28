import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Long-term memory as a small JSON file: a personal assistant holds hundreds of facts, not
// millions, and plain JSON avoids native modules on Windows and later on a phone.

export interface Fact { id: string; text: string; created: string; hits: number }
export interface Episode { id: string; date: string; summary: string }
interface MemoryFile { facts: Fact[]; episodes: Episode[] }

const STOP = new Set('a an the and or but is are was were be to of in on at for with my me i you your it this that do does did what when where who how please can could would should'.split(' '));

export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter(t => t.length > 1 && !STOP.has(t));
}

export class MemoryStore {
  private data: MemoryFile = { facts: [], episodes: [] };

  constructor(private readonly file: string) {
    try { this.data = { facts: [], episodes: [], ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  }

  remember(text: string): Fact {
    const clean = text.trim();
    const dup = this.data.facts.find(f => f.text.toLowerCase() === clean.toLowerCase());
    if (dup) return dup;
    const fact = { id: randomUUID().slice(0, 8), text: clean, created: new Date().toISOString(), hits: 0 };
    this.data.facts.push(fact);
    this.save();
    return fact;
  }

  forget(idOrText: string): number {
    const needle = idOrText.toLowerCase();
    const before = this.data.facts.length;
    this.data.facts = this.data.facts.filter(f => f.id !== idOrText && !f.text.toLowerCase().includes(needle));
    if (this.data.facts.length !== before) this.save();
    return before - this.data.facts.length;
  }

  addEpisode(summary: string): void {
    this.data.episodes.push({ id: randomUUID().slice(0, 8), date: new Date().toISOString(), summary: summary.trim() });
    this.data.episodes = this.data.episodes.slice(-500);
    this.save();
  }

  /** Facts and episodes most related to the query, scored by keyword overlap and recency. */
  recall(query: string, limit = 8): string[] {
    const q = new Set(tokens(query));
    const score = (text: string, ageDays: number) => {
      const overlap = tokens(text).filter(t => q.has(t)).length;
      return overlap === 0 ? 0 : overlap + 1 / (1 + ageDays / 30);
    };
    const now = Date.now();
    const age = (iso: string) => (now - Date.parse(iso)) / 86_400_000;
    const scored = [
      ...this.data.facts.map(f => ({ text: f.text, s: score(f.text, age(f.created)) })),
      ...this.data.episodes.map(e => ({ text: `(${e.date.slice(0, 10)}) ${e.summary}`, s: score(e.summary, age(e.date)) * 0.8 })),
    ].filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    return scored.slice(0, limit).map(x => x.text);
  }

  /** Context for a turn: the most recent core facts plus anything relevant to the message. */
  contextFor(message: string, coreLimit = 6): string[] {
    const core = this.data.facts.slice(-coreLimit).map(f => f.text);
    const related = this.recall(message, 6);
    return [...new Set([...core, ...related])];
  }

  list(): Fact[] { return [...this.data.facts]; }

  clearEpisodes(): void { this.data.episodes = []; this.save(); }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
