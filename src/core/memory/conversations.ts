import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokens } from './store';

// Full conversation history on disk, so Ghost picks up where it left off after a restart and can
// search what was said weeks ago. Everything stays on this PC:
//   data/conversations/<id>.jsonl   one line per message
//   data/current.json               the open conversation and its Claude session

export interface LogLine {
  ts: string; role: 'user' | 'assistant'; text: string; provider?: string; model?: string;
  command?: boolean; // a quick instruction ("open notepad") rather than a real exchange
  actions?: string[]; // what Ghost did on the PC for this reply ("opened Spotify")
  screen?: string; // what Ghost saw on the screen for this reply
}
export type LineMeta = Omit<LogLine, 'ts' | 'role' | 'text'>;
export interface Current { conversationId: string; claudeSessionId?: string; lastActivity: number }

/** Where conversations are kept: locally (below) or in the Obsidian vault (vaultConversations.ts). */
export interface HistoryStore {
  readonly current: Current;
  isStale(idleMs: number): boolean;
  append(role: LogLine['role'], text: string, meta?: LineMeta): void;
  setClaudeSession(id: string | undefined): void;
  lines(conversationId?: string): LogLine[];
  /** Start a new conversation; returns the id of the one that just ended. */
  rotate(): string;
  search(query: string, limit?: number): string[];
  clear(): void;
}

export class ConversationLog implements HistoryStore {
  private readonly dir: string;
  private readonly currentFile: string;
  current: Current;

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly names: () => { user: string; assistant: string } = () => ({ user: 'Aaron', assistant: 'Ghost' }),
  ) {
    this.dir = join(dataDir, 'conversations');
    this.currentFile = join(dataDir, 'current.json');
    mkdirSync(this.dir, { recursive: true });
    let loaded: Current | null = null;
    try { loaded = JSON.parse(readFileSync(this.currentFile, 'utf8')); } catch { /* first run */ }
    this.current = loaded ?? this.fresh();
  }

  private fresh(): Current {
    return { conversationId: `${new Date(this.now()).toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`, lastActivity: this.now() };
  }

  /** True when the open conversation went quiet longer than `idleMs` ago (it should be archived). */
  isStale(idleMs: number): boolean { return this.lines().length > 0 && this.now() - this.current.lastActivity > idleMs; }

  append(role: LogLine['role'], text: string, meta: LineMeta = {}): void {
    const line: LogLine = { ts: new Date(this.now()).toISOString(), role, text, ...meta };
    appendFileSync(join(this.dir, `${this.current.conversationId}.jsonl`), JSON.stringify(line) + '\n');
    this.current.lastActivity = this.now();
    this.save();
  }

  setClaudeSession(id: string | undefined): void {
    if (this.current.claudeSessionId === id) return;
    this.current.claudeSessionId = id;
    this.save();
  }

  lines(conversationId = this.current.conversationId): LogLine[] {
    let text: string;
    try { text = readFileSync(join(this.dir, `${conversationId}.jsonl`), 'utf8'); } catch { return []; }
    // One damaged line (e.g. a write cut short by a crash) mustn't hide the rest of the conversation.
    return text.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as LogLine]; } catch { return []; } });
  }

  /** Start a new conversation; returns the id of the one that just ended (for summarising). */
  rotate(): string {
    const ended = this.current.conversationId;
    this.current = this.fresh();
    this.save();
    return ended;
  }

  /** Keyword search across every past conversation, best matches first, as dated snippets. */
  search(query: string, limit = 8): string[] {
    const q = new Set(tokens(query));
    if (!q.size) return [];
    const hits: { score: number; text: string }[] = [];
    const names = this.names();
    let files: string[] = [];
    try { files = readdirSync(this.dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    for (const f of files) {
      for (const l of this.lines(f.replace(/\.jsonl$/, ''))) {
        const overlap = tokens(l.text).filter(t => q.has(t)).length;
        if (!overlap) continue;
        const ageDays = (this.now() - Date.parse(l.ts)) / 86_400_000;
        const snippet = l.text.length > 220 ? `${l.text.slice(0, 220)}…` : l.text;
        hits.push({ score: overlap + 1 / (1 + ageDays / 30), text: `(${l.ts.slice(0, 10)}) ${l.role === 'user' ? names.user : names.assistant}: ${snippet}` });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(h => h.text);
  }

  /** Conversations still held here (their JSONL files), oldest first. */
  ids(): string[] {
    try { return readdirSync(this.dir).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')).sort(); } catch { return []; }
  }

  /** Drop one conversation's file (it has been filed elsewhere, e.g. in the vault). */
  remove(conversationId: string): void { rmSync(join(this.dir, `${conversationId}.jsonl`), { force: true }); }

  get folder(): string { return this.dir; }

  /** Forget every past conversation (lasting facts live elsewhere and are kept). */
  clear(): void {
    if (existsSync(this.dir)) rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
    this.current = this.fresh();
    this.save();
  }

  private save(): void {
    writeFileSync(`${this.currentFile}.tmp`, JSON.stringify(this.current, null, 2));
    renameSync(`${this.currentFile}.tmp`, this.currentFile);
  }
}
