import { readFileSync, writeFileSync } from 'node:fs';
import {
  renderConversationNote, renderTranscript, renderTranscriptEntry, transcriptOf, TRANSCRIPT_HEADER,
  type Names, type TranscriptLine,
} from '../obsidian/markdown';
import type { ObsidianVault } from '../obsidian/vault';
import type { VaultIndex } from '../obsidian/vaultIndex';
import { tokens } from './store';
import type { ConversationLog, Current, HistoryStore, LineMeta, LogLine } from './conversations';

// Conversations kept in the Obsidian vault. While a conversation is open, its lines are also kept in
// a small local working file (the ConversationLog buffer) so nothing is lost if the vault is briefly
// unavailable; once the conversation is filed (see obsidian/closer.ts) that file is removed and the
// note is the only copy.
//
// A note is only created once the conversation has something worth keeping: quick commands
// ("open notepad") stay in the working file and end up as a line in the Daily Note instead.

interface NoteState { path: string; written: number; deleted?: boolean }

export interface VaultConversationOptions {
  folder: () => string; // Ghost's folder in the vault
  names: () => Names;
  stateFile: string; // conversation id → its note, for notes not yet filed
}

export function hhmm(d: Date): string { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
export function isoDate(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

export function toTranscript(lines: LogLine[]): TranscriptLine[] {
  return lines.map(l => ({ time: hhmm(new Date(l.ts)), speaker: l.role, text: l.text, screen: l.screen }));
}

export class VaultConversations implements HistoryStore {
  private notes: Record<string, NoteState> = {};

  constructor(
    readonly buffer: ConversationLog,
    private readonly vault: ObsidianVault,
    private readonly index: VaultIndex,
    private readonly o: VaultConversationOptions,
  ) {
    try { this.notes = JSON.parse(readFileSync(o.stateFile, 'utf8')); } catch { /* none yet */ }
  }

  get current(): Current { return this.buffer.current; }
  get conversationsFolder(): string { return `${this.o.folder()}/Conversations`; }

  isStale(idleMs: number): boolean { return this.buffer.isStale(idleMs); }
  setClaudeSession(id: string | undefined): void { this.buffer.setClaudeSession(id); }

  append(role: LogLine['role'], text: string, meta: LineMeta = {}): void {
    this.buffer.append(role, text, meta);
    // Notes are written a whole exchange at a time, when the reply arrives.
    if (role !== 'assistant') return;
    const id = this.current.conversationId;
    const lines = this.buffer.lines(id);
    const state = this.notes[id];
    if (state?.deleted) return; // Aaron deleted the note mid-conversation: respect that
    if (!state) {
      if (lines.every(l => l.command)) return; // nothing worth a note yet
      this.createNote(id, lines);
      return;
    }
    const note = this.vault.read(state.path);
    if (note === null) { state.deleted = true; this.save(); return; }
    const fresh = toTranscript(lines.slice(state.written)).map(renderTranscriptEntry(this.o.names()));
    const base = note.includes(TRANSCRIPT_HEADER) ? note.replace(/\s+$/, '') : `${note.replace(/\s+$/, '')}\n\n${TRANSCRIPT_HEADER}`;
    const sep = base.endsWith(TRANSCRIPT_HEADER) ? '\n' : '\n>\n';
    this.vault.write(state.path, `${base}${sep}${fresh.join('\n>\n')}\n`);
    state.written = lines.length;
    this.save();
  }

  lines(conversationId = this.current.conversationId): LogLine[] {
    const local = this.buffer.lines(conversationId);
    if (local.length) return local;
    const state = this.notes[conversationId];
    const text = state ? this.vault.read(state.path) : null;
    if (!text) return [];
    const date = conversationId.slice(0, 10);
    return transcriptOf(text, this.o.names()).map(t => ({ ts: new Date(`${date}T${t.time.padStart(5, '0')}:00`).toISOString(), role: t.speaker, text: t.text, screen: t.screen }));
  }

  rotate(): string { return this.buffer.rotate(); }

  /** The note for a conversation, if one has been written. */
  notePath(conversationId: string): string | undefined {
    const s = this.notes[conversationId];
    return s && !s.deleted ? s.path : undefined;
  }

  /** Conversations waiting to be filed (ended, but not yet summarised into their final note). */
  unfiled(): string[] {
    const open = this.current.conversationId;
    return [...new Set([...this.buffer.ids(), ...Object.keys(this.notes)])].filter(id => id !== open).sort();
  }

  /** Track a note written for a conversation outside the live flow (e.g. filed later). */
  adopt(conversationId: string, path: string, written: number): void {
    this.notes[conversationId] = { path, written };
    this.save();
  }

  /** The conversation has been filed: drop the working copy and the bookkeeping. */
  forget(conversationId: string): void {
    this.buffer.remove(conversationId);
    delete this.notes[conversationId];
    this.save();
  }

  /** Past conversations mentioning the query: their summaries, then the lines that match. */
  search(query: string, limit = 8): string[] {
    const q = new Set(tokens(query));
    if (!q.size) return [];
    const names = this.o.names();
    const out: { score: number; text: string }[] = [];
    for (const hit of this.index.search(query, { within: this.conversationsFolder, limit: 6 })) {
      const date = String(hit.frontmatter.date ?? '').slice(0, 10);
      const summary = String(hit.frontmatter.summary ?? '');
      if (summary) out.push({ score: hit.score + 1, text: `(${date}, [[${hit.title}]]) ${summary}` });
      const text = this.vault.read(hit.rel) ?? '';
      for (const l of transcriptOf(text, names)) {
        const overlap = tokens(l.text).filter(t => q.has(t)).length;
        if (!overlap) continue;
        const snippet = l.text.length > 220 ? `${l.text.slice(0, 220)}…` : l.text;
        out.push({ score: overlap + hit.score / 10, text: `(${date} ${l.time}) ${l.speaker === 'user' ? names.user : names.assistant}: ${snippet}` });
      }
    }
    // The open conversation (and any not yet filed) are still in the working files.
    for (const line of this.buffer.search(query, limit)) out.push({ score: 0.5, text: line });
    return [...new Set(out.sort((a, b) => b.score - a.score).map(o => o.text))].slice(0, limit);
  }

  /** Move every conversation note to Obsidian's trash (memory notes are kept). */
  clear(): void {
    for (const rel of this.vault.list(this.conversationsFolder)) this.vault.trash(rel);
    this.notes = {};
    this.save();
    this.buffer.clear();
    this.index.refresh();
  }

  private createNote(id: string, lines: LogLine[]): void {
    const start = new Date(lines[0].ts);
    const folder = `${this.conversationsFolder}/${isoDate(start).slice(0, 7)}`;
    const path = this.vault.unique(`${folder}/${isoDate(start)} ${hhmm(start).replace(':', '')} Ghost conversation.md`);
    this.vault.write(path, renderConversationNote({
      frontmatter: { date: isoDate(start), time: hhmm(start), status: 'in progress', tags: ['ghost'] },
      title: 'Conversation in progress',
      myNotes: '',
      transcript: `${TRANSCRIPT_HEADER}\n${renderTranscript(toTranscript(lines), this.o.names())}`,
    }));
    this.notes[id] = { path, written: lines.length };
    this.save();
    this.index.update([path]);
  }

  private save(): void {
    try { writeFileSync(this.o.stateFile, JSON.stringify(this.notes, null, 2)); } catch { /* best effort */ }
  }
}
