import { tokens } from '../memory/store';
import { frontmatterTags, inlineTags, parseFrontmatter, type Frontmatter } from './markdown';
import type { ObsidianVault } from './vault';

// An in-memory index of the vault, kept fresh by the watcher: titles and aliases (for [[links]]),
// the tags in use (Ghost reuses them rather than inventing new ones) and words (for search).

export interface IndexedNote {
  rel: string;
  title: string;
  aliases: string[];
  tags: string[];
  frontmatter: Frontmatter;
  words: Set<string>;
  mtime: number;
}

export interface SearchHit { rel: string; title: string; score: number; frontmatter: Frontmatter }

/** Titles that would make poor links (dates, numbers, very short or common words). */
const COMMON = new Set('the and for with this that from what when where note notes todo inbox home index untitled readme daily journal ideas'.split(' '));
function linkable(title: string): boolean {
  const t = title.trim();
  return t.length >= 3 && !COMMON.has(t.toLowerCase()) && !/^[\d\s\-_.:/]+$/.test(t);
}

export class VaultIndex {
  private notes = new Map<string, IndexedNote>();
  private version = 0;

  constructor(private readonly vault: ObsidianVault, private readonly ghostFolder: () => string) {}

  get size(): number { return this.notes.size; }
  /** Changes whenever the index does (lets callers cache derived data). */
  get revision(): number { return this.version; }

  /** Full rescan; unchanged files (same mtime) are reused. */
  refresh(): void {
    if (!this.vault.available()) return;
    const seen = new Set<string>();
    for (const rel of this.vault.list()) { seen.add(rel); this.load(rel); }
    for (const rel of [...this.notes.keys()]) if (!seen.has(rel)) { this.notes.delete(rel); this.version++; }
  }

  /** The same rescan in small batches, so a large vault never stalls Ghost (it runs in the app's main process). */
  async refreshAsync(batch = 150): Promise<void> {
    if (!this.vault.available()) return;
    const seen = new Set<string>();
    const rels = this.vault.list();
    for (let i = 0; i < rels.length; i++) {
      seen.add(rels[i]);
      this.load(rels[i]);
      if (i % batch === batch - 1) await new Promise(r => setImmediate(r));
    }
    for (const rel of [...this.notes.keys()]) if (!seen.has(rel)) { this.notes.delete(rel); this.version++; }
  }

  /** Re-read specific notes (from the watcher). */
  update(rels: string[]): void {
    for (const rel of rels) {
      if (!this.vault.exists(rel)) { if (this.notes.delete(rel)) this.version++; continue; }
      this.load(rel);
    }
  }

  get(rel: string): IndexedNote | undefined { return this.notes.get(rel); }

  all(): IndexedNote[] { return [...this.notes.values()]; }

  /** Notes that mentions can link to: everything outside Ghost's own folder. */
  linkTargets(): { title: string; name: string }[] {
    const own = `${this.ghostFolder()}/`;
    const out: { title: string; name: string }[] = [];
    for (const n of this.notes.values()) {
      if (n.rel.startsWith(own)) continue;
      if (linkable(n.title)) out.push({ title: n.title, name: n.title });
      for (const a of n.aliases) if (linkable(a)) out.push({ title: n.title, name: a });
    }
    return out;
  }

  /** Tags used in the vault, most used first (Ghost's own #ghost tags excluded). */
  tagVocabulary(limit = 60): string[] {
    const counts = new Map<string, number>();
    for (const n of this.notes.values()) for (const t of n.tags) {
      const key = t.toLowerCase();
      if (key === 'ghost' || key.startsWith('ghost/')) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
  }

  /** Keyword search; `within` limits it to a folder, `exclude` skips one. Titles weigh more than body text. */
  search(query: string, opts: { within?: string; exclude?: string; limit?: number } = {}): SearchHit[] {
    const q = tokens(query);
    if (!q.length) return [];
    const hits: SearchHit[] = [];
    for (const n of this.notes.values()) {
      if (opts.within && !n.rel.startsWith(`${opts.within}/`)) continue;
      if (opts.exclude && n.rel.startsWith(`${opts.exclude}/`)) continue;
      const title = new Set(tokens(n.title));
      let score = 0;
      for (const t of q) score += (n.words.has(t) ? 1 : 0) + (title.has(t) ? 2 : 0);
      if (score) hits.push({ rel: n.rel, title: n.title, score: score + n.mtime / 1e15, frontmatter: n.frontmatter });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
  }

  private load(rel: string): void {
    const mtime = this.vault.mtime(rel);
    const old = this.notes.get(rel);
    if (old && old.mtime === mtime && mtime !== 0) return;
    const text = this.vault.read(rel);
    if (text === null) return;
    const { data, body } = parseFrontmatter(text);
    const title = rel.split('/').pop()!.replace(/\.md$/, '');
    const aliasField = data.aliases ?? data.alias;
    const aliases = (Array.isArray(aliasField) ? aliasField : aliasField ? [aliasField] : []).filter(Boolean);
    this.notes.set(rel, {
      rel, title, aliases,
      tags: [...new Set([...frontmatterTags(data), ...inlineTags(body)])],
      frontmatter: data,
      words: new Set(tokens(`${title} ${aliases.join(' ')} ${body}`)),
      mtime,
    });
    this.version++;
  }
}
