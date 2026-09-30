import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEMORY_TOPICS, type Fact, type MemoryTopic } from '../memory/store';
import type { VaultMemory } from '../memory/vaultMemory';
import { closeConversation, type CloseDeps } from './closer';

// Moving Ghost's existing local history into the vault, once, when a vault is first connected.
// Everything is copied to a dated backup folder first; the import files each past conversation
// oldest first and sorts the old facts into the Memory notes. It can be interrupted (a brain being
// unavailable pauses it) and picks up where it left off. The backup is only deleted when Aaron
// presses "Delete" in Settings, after he's checked the notes.

export interface ImportState { done: string[]; facts: boolean; finished: boolean; backup?: string }
export interface ImportProgress { done: number; total: number; phase: 'conversations' | 'facts' | 'finished' | 'paused' }

export interface ImportDeps extends CloseDeps {
  dataDir: string;
  memory: VaultMemory;
  onProgress: (p: ImportProgress) => void;
}

const stateFile = (dataDir: string) => join(dataDir, 'obsidian-import.json');

export function importState(dataDir: string): ImportState {
  try { return JSON.parse(readFileSync(stateFile(dataDir), 'utf8')); } catch { return { done: [], facts: false, finished: false }; }
}

function saveState(dataDir: string, s: ImportState): void { writeFileSync(stateFile(dataDir), JSON.stringify(s, null, 2)); }

/** Anything local that hasn't gone to the vault yet? */
export function hasLocalHistory(dataDir: string, openConversation: string): boolean {
  const s = importState(dataDir);
  if (s.finished) return false;
  const convs = listJsonl(join(dataDir, 'conversations')).filter(id => id !== openConversation && !s.done.includes(id));
  return convs.length > 0 || (!s.facts && oldFacts(dataDir).length > 0);
}

export async function importLocalHistory(d: ImportDeps): Promise<ImportProgress> {
  const state = importState(d.dataDir);
  const open = d.conversations.current.conversationId;
  if (!state.backup) {
    state.backup = backup(d.dataDir);
    saveState(d.dataDir, state);
  }

  const todo = listJsonl(join(d.dataDir, 'conversations')).filter(id => id !== open && !state.done.includes(id));
  const total = state.done.length + todo.length;
  for (const id of todo) {
    d.onProgress({ done: state.done.length, total, phase: 'conversations' });
    const result = await closeConversation(d, id);
    if (result === 'retry') { d.onProgress({ done: state.done.length, total, phase: 'paused' }); return { done: state.done.length, total, phase: 'paused' }; }
    state.done.push(id);
    saveState(d.dataDir, state);
  }

  if (!state.facts) {
    d.onProgress({ done: total, total, phase: 'facts' });
    const facts = oldFacts(d.dataDir);
    if (facts.length) {
      let topics: Record<number, MemoryTopic> = {};
      try { topics = parseTopics(await d.ask(topicPrompt(facts))); } catch { /* unsorted facts go to Other */ }
      facts.forEach((f, i) => d.memory.remember(f.text, topics[i] ?? 'Other'));
    }
    // The original memory file is in the backup; Ghost now reads the Memory notes.
    rmSync(join(d.dataDir, 'memory.json'), { force: true });
    state.facts = true;
    saveState(d.dataDir, state);
  }
  state.finished = true;
  saveState(d.dataDir, state);
  d.onProgress({ done: total, total, phase: 'finished' });
  return { done: total, total, phase: 'finished' };
}

/** The backup folder and its size, if one is still around. */
export function backupInfo(dataDir: string): { path: string; bytes: number } | null {
  const s = importState(dataDir);
  if (!s.backup || !existsSync(s.backup)) return null;
  return { path: s.backup, bytes: folderSize(s.backup) };
}

export function deleteBackup(dataDir: string): void {
  const s = importState(dataDir);
  if (s.backup) rmSync(s.backup, { recursive: true, force: true });
  delete s.backup;
  saveState(dataDir, s);
}

function backup(dataDir: string): string {
  const dir = join(dataDir, `backup-${new Date().toISOString().slice(0, 10)}`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dataDir, 'conversations'))) cpSync(join(dataDir, 'conversations'), join(dir, 'conversations'), { recursive: true });
  if (existsSync(join(dataDir, 'memory.json'))) cpSync(join(dataDir, 'memory.json'), join(dir, 'memory.json'));
  return dir;
}

function oldFacts(dataDir: string): Fact[] {
  try { return (JSON.parse(readFileSync(join(dataDir, 'memory.json'), 'utf8')).facts ?? []) as Fact[]; } catch { return []; }
}

function listJsonl(dir: string): string[] {
  try { return readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.replace(/\.jsonl$/, '')).sort(); } catch { return []; }
}

function folderSize(dir: string): number {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? folderSize(p) : statSync(p).size;
  }
  return total;
}

export function topicPrompt(facts: Fact[]): string {
  return [
    `Sort these facts about a person into topics. Reply with JSON only: {"0": "Topic", "1": "Topic", …}.`,
    `Topics: ${MEMORY_TOPICS.join(', ')}. "People" is for facts about other people; "Plans & routines" for plans, schedules and habits.`,
    '',
    ...facts.map((f, i) => `${i}: ${f.text}`),
  ].join('\n');
}

export function parseTopics(reply: string): Record<number, MemoryTopic> {
  const raw = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1)) as Record<string, string>;
  const out: Record<number, MemoryTopic> = {};
  for (const [k, v] of Object.entries(raw)) {
    const topic = MEMORY_TOPICS.find(t => t.toLowerCase() === String(v).toLowerCase());
    if (topic) out[Number(k)] = topic;
  }
  return out;
}
