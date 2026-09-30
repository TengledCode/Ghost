import type { ObsidianSettings } from '../../shared/settings';
import { Linker } from './linker';
import type { ObsidianVault } from './vault';
import type { VaultIndex } from './vaultIndex';

// Ghost's access to the rest of the vault: search and read freely (when allowed in Settings),
// create or edit notes only through the confirm card (see approvals/classify.ts).

const MAX_READ = 12_000;

export class VaultTools {
  constructor(
    private readonly vault: ObsidianVault,
    private readonly index: VaultIndex,
    private readonly settings: () => ObsidianSettings,
  ) {}

  search(query: string): string {
    if (!this.settings().readVault) return 'Reading the vault is switched off in Settings.';
    const hits = this.index.search(query, { limit: 8 });
    if (!hits.length) return `No notes match "${query}".`;
    return hits.map(h => {
      const text = this.vault.read(h.rel) ?? '';
      return `${h.rel}\n  ${snippet(text, query)}`;
    }).join('\n');
  }

  read(path: string): string {
    if (!this.settings().readVault) return 'Reading the vault is switched off in Settings.';
    const rel = this.resolve(path);
    const text = this.vault.read(rel);
    if (text === null) return `There's no note at ${rel}.`;
    return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n…(truncated)` : text;
  }

  write(path: string, content: string, mode: 'create' | 'append' | 'replace'): string {
    if (!this.settings().writeVault) return 'Editing notes is switched off in Settings.';
    const rel = this.resolve(path);
    const linker = this.settings().linkNotes ? new Linker(this.index.linkTargets().filter(t => `${t.title}.md` !== rel.split('/').pop())) : null;
    const body = linker?.linkify(content) ?? content;
    const existing = this.vault.read(rel);
    if (mode === 'create' && existing !== null) return `${rel} already exists; use append or replace.`;
    const next = mode === 'append' && existing !== null ? `${existing.replace(/\s+$/, '')}\n\n${body.trim()}\n` : `${body.trim()}\n`;
    this.vault.write(rel, next);
    this.index.update([rel]);
    return `${mode === 'append' && existing !== null ? 'Added to' : existing !== null ? 'Replaced' : 'Created'} ${rel}.`;
  }

  /** A note path from what the model gives: "Ideas", "Projects/Ideas.md", or an absolute path inside the vault. */
  resolve(path: string): string {
    let p = path.trim().replace(/\\/g, '/').replace(/^\[\[|]]$/g, '');
    // Absolute paths must be inside the vault; "/Ideas.md" means the vault's Ideas note.
    const root = this.vault.root.replace(/\\/g, '/');
    if (/^[a-zA-Z]:\//.test(p) || p.startsWith(`${root}/`)) p = this.vault.rel(p);
    else p = p.replace(/^\/+/, '');
    if (!p.endsWith('.md')) {
      // A bare title: find the existing note with that name anywhere in the vault.
      const match = this.index.all().find(n => n.title.toLowerCase() === p.split('/').pop()!.toLowerCase());
      p = match && !p.includes('/') ? match.rel : `${p}.md`;
    }
    this.vault.abs(p); // throws when outside the vault
    return p;
  }
}

/** The most relevant line of a note, for search results. */
function snippet(text: string, query: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('---'));
  const best = lines.find(l => words.some(w => l.toLowerCase().includes(w))) ?? lines[0] ?? '';
  return best.length > 200 ? `${best.slice(0, 200)}…` : best.trim();
}
