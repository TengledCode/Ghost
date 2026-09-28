import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokens } from './store';

// Full conversation history on disk, so Ghost picks up where it left off after a restart and can
// search what was said weeks ago. Everything stays on this PC:
//   data/conversations/<id>.jsonl   one line per message
//   data/current.json               the open conversation and its Claude session

export interface LogLine { ts: string; role: 'user' | 'assistant'; text: string; provider?: string; model?: string }
export interface Current { conversationId: string; claudeSessionId?: string; lastActivity: number }

export class ConversationLog {
  private readonly dir: string;
  private readonly currentFile: string;
  current: Current;

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
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

  append(role: LogLine['role'], text: string, meta: { provider?: string; model?: string } = {}): void {
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
    try {
      return readFileSync(join(this.dir, `${conversationId}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LogLine);
    } catch { return []; }
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
    let files: string[] = [];
    try { files = readdirSync(this.dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
    for (const f of files) {
      for (const l of this.lines(f.replace(/\.jsonl$/, ''))) {
        const overlap = tokens(l.text).filter(t => q.has(t)).length;
        if (!overlap) continue;
        const ageDays = (this.now() - Date.parse(l.ts)) / 86_400_000;
        const snippet = l.text.length > 220 ? `${l.text.slice(0, 220)}…` : l.text;
        hits.push({ score: overlap + 1 / (1 + ageDays / 30), text: `(${l.ts.slice(0, 10)}) ${l.role === 'user' ? 'Aaron' : 'Ghost'}: ${snippet}` });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit).map(h => h.text);
  }

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
