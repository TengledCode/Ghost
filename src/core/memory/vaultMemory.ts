import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseFrontmatter, stringifyFrontmatter } from '../obsidian/markdown';
import type { Linker } from '../obsidian/linker';
import type { ObsidianVault } from '../obsidian/vault';
import type { VaultIndex } from '../obsidian/vaultIndex';
import { MEMORY_TOPICS, tokens, type Fact, type FactStore, type MemoryTopic } from './store';

// Lasting facts as Memory notes in the vault, one per topic, each fact a bullet. The notes are the
// source: bullets Aaron adds, edits or deletes in Obsidian change what Ghost knows straight away.
// Conversation summaries aren't kept separately any more; they live in each conversation note's
// `summary` property and are found through the vault index.

export interface VaultMemoryOptions {
  folder: () => string;
  linker: () => Linker | null; // null when linking is switched off
  cacheFile: string; // last-known facts, used while the vault is unavailable
  conversationsFolder: () => string;
}

const BULLET = /^\s*[-*+]\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;

/** A fact as plain text: [[Sam]] → Sam, [[Sam|my brother]] → my brother. */
export function plainText(s: string): string {
  return s.replace(/\[\[([^\]|]+)\|([^\]]+)]]/g, '$2').replace(/\[\[([^\]]+)]]/g, '$1');
}

function factId(text: string): string { return createHash('sha1').update(plainText(text).toLowerCase()).digest('hex').slice(0, 8); }

export class VaultMemory implements FactStore {
  private cache: { topic: MemoryTopic; fact: Fact }[] = [];

  constructor(private readonly vault: ObsidianVault, private readonly index: VaultIndex, private readonly o: VaultMemoryOptions) {
    try { this.cache = JSON.parse(readFileSync(o.cacheFile, 'utf8')); } catch { /* none yet */ }
  }

  noteFor(topic: MemoryTopic): string { return `${this.o.folder()}/Memory/${topic}.md`; }

  remember(text: string, topic: MemoryTopic = 'Other'): Fact {
    const clean = text.trim().replace(/\s+/g, ' ');
    const plain = plainText(clean).toLowerCase();
    const dup = this.all().find(f => plainText(f.fact.text).toLowerCase() === plain);
    if (dup) return dup.fact;
    const t = MEMORY_TOPICS.includes(topic) ? topic : 'Other';
    const linked = this.o.linker()?.linkify(clean) ?? clean;
    const rel = this.noteFor(t);
    const note = this.vault.read(rel) ?? this.emptyNote(t);
    this.vault.write(rel, `${note.replace(/\s+$/, '')}\n- ${linked}\n`);
    this.index.update([rel]);
    const fact = { id: factId(clean), text: plainText(linked), created: new Date().toISOString(), hits: 0 };
    this.cache.push({ topic: t, fact });
    this.saveCache();
    return fact;
  }

  forget(idOrText: string): number {
    const needle = idOrText.toLowerCase().trim();
    if (!needle) return 0;
    let removed = 0;
    for (const topic of MEMORY_TOPICS) {
      const rel = this.noteFor(topic);
      const note = this.vault.read(rel);
      if (!note) continue;
      const kept = note.split('\n').filter(line => {
        const m = line.match(BULLET);
        if (!m) return true;
        const hit = factId(m[1]) === needle || plainText(m[1]).toLowerCase().includes(needle);
        if (hit) removed++;
        return !hit;
      });
      if (kept.length !== note.split('\n').length) { this.vault.write(rel, kept.join('\n')); this.index.update([rel]); }
    }
    if (removed) this.all();
    return removed;
  }

  /** Summaries live in the conversation notes now. */
  addEpisode(_summary: string): void {}
  clearEpisodes(): void {}

  list(): Fact[] { return this.all().map(x => x.fact); }

  recall(query: string, limit = 8): string[] {
    const q = new Set(tokens(query));
    if (!q.size) return [];
    const overlap = (text: string) => tokens(text).filter(t => q.has(t)).length;
    const scored: { s: number; text: string }[] = [];
    for (const { fact } of this.all()) {
      const s = overlap(fact.text);
      if (s) scored.push({ s, text: fact.text });
    }
    // Summaries of past conversations, from their notes' `summary` property.
    for (const hit of this.index.search(query, { within: this.o.conversationsFolder(), limit: 8 })) {
      const summary = String(hit.frontmatter.summary ?? '');
      if (!summary) continue;
      const s = overlap(summary);
      if (s) scored.push({ s: s * 0.8, text: `(${String(hit.frontmatter.date ?? '').slice(0, 10)}, [[${hit.title}]]) ${summary}` });
    }
    return scored.sort((a, b) => b.s - a.s).slice(0, limit).map(x => x.text);
  }

  /** What goes into every turn: the "About me" essentials plus anything related to the message. */
  contextFor(message: string, coreLimit = 6): string[] {
    const all = this.all();
    const core = all.filter(x => x.topic === 'About me').slice(-coreLimit).map(x => x.fact.text);
    return [...new Set([...core, ...this.recall(message, 6)])];
  }

  /** Every fact, read from the Memory notes (or the last-known copy while the vault is away). */
  private all(): { topic: MemoryTopic; fact: Fact }[] {
    if (!this.vault.available()) return this.cache;
    const out: { topic: MemoryTopic; fact: Fact }[] = [];
    for (const topic of MEMORY_TOPICS) {
      const rel = this.noteFor(topic);
      const note = this.vault.read(rel);
      if (!note) continue;
      const created = new Date(this.vault.mtime(rel) || Date.now()).toISOString();
      for (const line of parseFrontmatter(note).body.split('\n')) {
        const m = line.match(BULLET);
        if (m) out.push({ topic, fact: { id: factId(m[1]), text: plainText(m[1]), created, hits: 0 } });
      }
    }
    this.cache = out;
    this.saveCache();
    return out;
  }

  private emptyNote(topic: MemoryTopic): string {
    return `${stringifyFrontmatter({ tags: ['ghost'] })}\n# ${topic}\n\nWhat Ghost knows. Edit freely: add, change or delete lines, and Ghost follows.\n\n`;
  }

  private saveCache(): void {
    try { writeFileSync(this.o.cacheFile, JSON.stringify(this.cache)); } catch { /* best effort */ }
  }
}
