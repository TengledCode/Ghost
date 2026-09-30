import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

// An Obsidian vault is a folder of Markdown files, so Ghost works on it directly: no plugin, and
// Obsidian picks changes up as they happen. Paths inside the vault are always vault-relative with
// forward slashes ("Ghost/Memory/People.md"), the way Obsidian itself names notes.

export interface DetectedVault { path: string; name: string; open: boolean }

/** Vaults Obsidian knows about on this PC (from its own obsidian.json), the open one first. */
export function detectVaults(configDir = obsidianConfigDir()): DetectedVault[] {
  try {
    const cfg = JSON.parse(readFileSync(join(configDir, 'obsidian.json'), 'utf8')) as { vaults?: Record<string, { path?: string; open?: boolean; ts?: number }> };
    return Object.values(cfg.vaults ?? {})
      .filter(v => v.path && existsSync(v.path))
      .sort((a, b) => Number(!!b.open) - Number(!!a.open) || (b.ts ?? 0) - (a.ts ?? 0))
      .map(v => ({ path: v.path!, name: basename(v.path!), open: !!v.open }));
  } catch { return []; }
}

export function obsidianConfigDir(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA ?? '', 'obsidian');
  if (process.platform === 'darwin') return join(process.env.HOME ?? '', 'Library', 'Application Support', 'obsidian');
  return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'), 'obsidian');
}

/** A note title that is safe as a file name on every platform Obsidian runs on. */
export function safeFileName(title: string, max = 80): string {
  const clean = title.replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (clean.length > max ? clean.slice(0, max).replace(/\s+\S*$/, '') : clean) || 'Untitled';
}

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules']);

export class ObsidianVault {
  readonly root: string;
  private pending: Record<string, string | null> = {}; // vault-relative path → content (null = delete), waiting for the vault

  constructor(root: string, private readonly pendingFile?: string) {
    this.root = resolve(root);
    if (pendingFile) { try { this.pending = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { /* none */ } }
  }

  get name(): string { return basename(this.root); }

  /** The vault folder is there (it can be on a drive that isn't plugged in). */
  available(): boolean { try { return statSync(this.root).isDirectory(); } catch { return false; } }

  get hasPending(): boolean { return Object.keys(this.pending).length > 0; }

  /** Absolute path of a vault-relative path; refuses anything that would land outside the vault. */
  abs(rel: string): string {
    const full = resolve(this.root, ...rel.replace(/\\/g, '/').split('/').filter(Boolean));
    const inside = relative(this.root, full);
    if (!inside || inside.startsWith('..') || resolve(inside) === inside) throw new Error(`"${rel}" is outside the vault`);
    return full;
  }

  /** Vault-relative form of a path (accepts absolute paths inside the vault too). */
  rel(path: string): string {
    const full = resolve(this.root, path);
    const inside = relative(this.root, full);
    if (!inside || inside.startsWith('..')) throw new Error(`"${path}" is outside the vault`);
    return inside.split(sep).join('/');
  }

  exists(rel: string): boolean { return rel in this.pending ? this.pending[rel] !== null : existsSync(this.abs(rel)); }

  read(rel: string): string | null {
    if (rel in this.pending) return this.pending[rel];
    try { return readFileSync(this.abs(rel), 'utf8'); } catch { return null; }
  }

  mtime(rel: string): number { try { return statSync(this.abs(rel)).mtimeMs; } catch { return 0; } }

  /** Write atomically (safe alongside Obsidian Sync / iCloud). Queued while the vault is unavailable. */
  write(rel: string, content: string): void {
    if (!this.available()) { this.queue(rel, content); return; }
    this.flush();
    const full = this.abs(rel);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.ghost-tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, full);
  }

  /** Rename a note, never overwriting another; returns the new vault-relative path. */
  rename(from: string, to: string): string {
    if (from === to) return to;
    const target = this.unique(to, from);
    if (!this.available()) {
      const content = this.read(from);
      if (content !== null) { this.queue(target, content); this.queue(from, null); }
      return target;
    }
    const full = this.abs(target);
    mkdirSync(dirname(full), { recursive: true });
    renameSync(this.abs(from), full);
    return target;
  }

  /** `path` if free, otherwise "name 2.md", "name 3.md"… (`self` is allowed to be the existing file). */
  unique(rel: string, self?: string): string {
    if (rel === self || !this.exists(rel)) return rel;
    const base = rel.replace(/\.md$/, '');
    for (let i = 2; ; i++) if (!this.exists(`${base} ${i}.md`) || `${base} ${i}.md` === self) return `${base} ${i}.md`;
  }

  /** Move to Obsidian's own trash (<vault>/.trash), so a deletion can be undone there. */
  trash(rel: string): void {
    if (!this.available()) { this.queue(rel, null); return; }
    const full = this.abs(rel);
    if (!existsSync(full)) return;
    const bin = join(this.root, '.trash');
    mkdirSync(bin, { recursive: true });
    let target = join(bin, basename(full));
    for (let i = 2; existsSync(target); i++) target = join(bin, basename(full).replace(/(\.md)?$/, ` ${i}$1`));
    renameSync(full, target);
  }

  /** Every Markdown note under `dir` (vault-relative), skipping Obsidian's own folders. */
  list(dir = ''): string[] {
    const out: string[] = [];
    const walk = (rel: string, depth: number) => {
      if (depth > 12) return;
      let entries;
      try { entries = readdirSync(rel ? this.abs(rel) : this.root, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(child, depth + 1); }
        else if (e.name.endsWith('.md')) out.push(child);
      }
    };
    walk(dir.replace(/\/$/, ''), 0);
    return out;
  }

  /** Write anything that queued up while the vault was away. */
  flush(): void {
    if (!this.hasPending || !this.available()) return;
    const pending = this.pending;
    this.pending = {};
    for (const [rel, content] of Object.entries(pending)) {
      try {
        if (content === null) this.trash(rel);
        else this.write(rel, content);
      } catch { this.pending[rel] = content; }
    }
    this.savePending();
  }

  /** Call `onChange` with vault-relative paths of notes that changed (debounced). */
  watch(onChange: (rels: string[]) => void): () => void {
    let watcher: FSWatcher | null = null;
    const changed = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    try {
      watcher = watch(this.root, { recursive: true }, (_e, file) => {
        if (!file) return;
        const rel = String(file).split(sep).join('/');
        if (!rel.endsWith('.md') || rel.split('/').some(p => SKIP_DIRS.has(p))) return;
        changed.add(rel);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { const list = [...changed]; changed.clear(); onChange(list); }, 400);
      });
      watcher.on('error', () => { /* the vault went away; a periodic refresh catches up */ });
    } catch { /* recursive watching unsupported: callers also refresh periodically */ }
    return () => { if (timer) clearTimeout(timer); watcher?.close(); };
  }

  /** Remove a file Ghost itself owns outright (no trash), e.g. a stray temp file. */
  remove(rel: string): void { rmSync(this.abs(rel), { force: true }); }

  private queue(rel: string, content: string | null): void {
    this.pending[rel] = content;
    this.savePending();
  }

  private savePending(): void {
    if (!this.pendingFile) return;
    try {
      mkdirSync(dirname(this.pendingFile), { recursive: true });
      writeFileSync(this.pendingFile, JSON.stringify(this.pending));
    } catch { /* best effort */ }
  }
}
