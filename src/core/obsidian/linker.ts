// Turns mentions of existing notes into [[links]], so Ghost's notes appear in the graph and in each
// note's backlinks. Only notes that exist are linked (never empty ones), only the first mention of
// each, and never inside code, existing links or URLs.

export interface LinkTarget { title: string; name: string } // name: the title itself or one of its aliases

const PROTECTED = /```[\s\S]*?```|`[^`\n]*`|\[\[[^\]\n]*]]|\[[^\]\n]*]\([^)\n]*\)|https?:\/\/\S+/g;

export class Linker {
  private pattern: RegExp | null = null;
  private byName = new Map<string, string>(); // lowercased name → note title

  constructor(targets: LinkTarget[]) {
    const names: string[] = [];
    for (const t of targets) {
      const key = t.name.toLowerCase();
      if (this.byName.has(key)) continue;
      this.byName.set(key, t.title);
      names.push(t.name);
    }
    if (!names.length) return;
    // Longest first, so "Travel Budget 2026" wins over "Travel".
    names.sort((a, b) => b.length - a.length);
    const alternatives = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
    this.pattern = new RegExp(`(?<![\\p{L}\\p{N}_\\[])(${alternatives.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  }

  /** Link the first mention of each note in `text`. `already` carries titles linked earlier in the same note. */
  linkify(text: string, already = new Set<string>()): string {
    if (!this.pattern) return text;
    let out = '';
    let last = 0;
    for (const m of text.matchAll(PROTECTED)) {
      out += this.linkPlain(text.slice(last, m.index), already) + m[0];
      last = m.index! + m[0].length;
      // Existing links count as mentioned already.
      const existing = m[0].match(/^\[\[([^\]|#]+)/)?.[1];
      if (existing) already.add(existing.toLowerCase());
    }
    return out + this.linkPlain(text.slice(last), already);
  }

  /** The note title a name refers to, if the vault has one (for the `people` property). */
  noteFor(name: string): string | undefined { return this.byName.get(name.trim().toLowerCase()); }

  private linkPlain(text: string, already: Set<string>): string {
    return text.replace(this.pattern!, match => {
      const title = this.byName.get(match.replace(/\s+/g, ' ').toLowerCase());
      if (!title || already.has(title.toLowerCase())) return match;
      already.add(title.toLowerCase());
      return title === match ? `[[${title}]]` : `[[${title}|${match}]]`;
    });
  }
}
