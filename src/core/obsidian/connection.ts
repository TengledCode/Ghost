import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConversationLog } from '../memory/conversations';
import { VaultConversations } from '../memory/vaultConversations';
import { VaultMemory } from '../memory/vaultMemory';
import type { Settings } from '../../shared/settings';
import { closeConversation, type CloseDeps } from './closer';
import { backupInfo, deleteBackup, hasLocalHistory, importLocalHistory, importState, type ImportProgress } from './importer';
import { Linker } from './linker';
import { isNearlyEmpty, setupStarter } from './starter';
import type { Names } from './markdown';
import { detectVaults, ObsidianVault, type DetectedVault } from './vault';
import { VaultIndex } from './vaultIndex';
import { VaultTools } from './vaultTools';

// Everything Ghost does with an Obsidian vault, in one place: the stores the core uses for history
// and memory, the index (kept fresh by a watcher), the tools for the rest of the vault, and a
// one-at-a-time queue for filing conversations and importing old history.

export interface ObsidianStatus {
  vaults: DetectedVault[];
  connected: { name: string; path: string; notes: number; waiting: boolean } | null;
  error?: string;
  import: ImportProgress | null;
  backupBytes: number | null;
  starter: 'offer' | 'done' | null; // the one-click starter layout for a nearly empty vault
}

export interface ConnectionOptions {
  dataDir: string;
  buffer: ConversationLog; // working copy of the open conversation
  settings: () => Settings;
  /** One short model call (fast slot); rejects when no brain is available. */
  ask: (prompt: string) => Promise<string>;
  notify: (level: 'info' | 'warn', text: string) => void;
  onStatus: () => void;
}

const REFRESH_MS = 5 * 60_000;

export class ObsidianConnection {
  readonly vault: ObsidianVault;
  readonly index: VaultIndex;
  readonly conversations: VaultConversations;
  readonly memory: VaultMemory;
  readonly tools: VaultTools;
  private stopWatch: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private progress: ImportProgress | null = null;
  private warnedOffline = false;
  private indexed = false; // the first full index has finished (until then, "nearly empty" isn't known)

  constructor(vaultPath: string, private readonly o: ConnectionOptions) {
    const s = () => o.settings().obsidian;
    const folder = () => s().folder;
    this.vault = new ObsidianVault(vaultPath, join(o.dataDir, 'obsidian-pending.json'));
    this.index = new VaultIndex(this.vault, folder);
    this.conversations = new VaultConversations(o.buffer, this.vault, this.index, {
      folder, names: () => this.names(), stateFile: join(o.dataDir, 'obsidian-notes.json'),
    });
    this.memory = new VaultMemory(this.vault, this.index, {
      folder,
      linker: () => (s().linkNotes ? new Linker(this.index.linkTargets()) : null),
      cacheFile: join(o.dataDir, 'memory-cache.json'),
      conversationsFolder: () => this.conversations.conversationsFolder,
    });
    this.tools = new VaultTools(this.vault, this.index, s);
  }

  start(): void {
    this.stopWatch = this.vault.watch(rels => this.index.update(rels));
    this.timer = setInterval(() => this.tick(), REFRESH_MS);
    this.timer.unref?.();
    this.checkAvailable();
    // Index the vault first (in the background), then file anything left over from last time and
    // bring in old local history (once).
    void this.enqueue(async () => { await this.index.refreshAsync(); this.indexed = true; this.o.onStatus(); });
    for (const id of this.conversations.unfiled()) this.close(id);
    if (hasLocalHistory(this.o.dataDir, this.conversations.current.conversationId)) this.importHistory();
  }

  stop(): void {
    this.stopWatch?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** File a finished conversation (queued; one at a time). */
  close(id: string): Promise<unknown> {
    return this.enqueue(async () => {
      const result = await closeConversation(this.closeDeps(), id);
      if (result === 'retry') this.o.notify('warn', "Couldn't summarise a conversation for Obsidian (no brain available). It's saved and will be finished later.");
    });
  }

  importHistory(): Promise<unknown> {
    return this.enqueue(async () => {
      this.o.notify('info', 'Moving your Ghost history into Obsidian…');
      const result = await importLocalHistory({
        ...this.closeDeps(), dataDir: this.o.dataDir, memory: this.memory,
        onProgress: p => { this.progress = p; this.o.onStatus(); },
      });
      if (result.phase === 'finished') this.o.notify('info', `Your Ghost history is now in Obsidian (${result.total} conversation${result.total === 1 ? '' : 's'}).`);
      else this.o.notify('warn', 'Importing into Obsidian paused: no brain available to summarise. It will continue later.');
    });
  }

  deleteBackup(): void { deleteBackup(this.o.dataDir); this.o.onStatus(); }

  /** Create the starter layout (Daily/, Inbox/, People/, Home, Obsidian settings), then link Ghost's notes to it. */
  setupStarter(): Promise<unknown> {
    return this.enqueue(async () => {
      let people: string[] = [];
      try { people = parsePeople(await this.o.ask(peoplePrompt(this.memory.list().map(f => f.text)))); } catch { /* no brain: skip the people notes */ }
      const r = setupStarter(this.vault, this.index, { ghostFolder: this.o.settings().obsidian.folder, people });
      this.setStarterState('done');
      this.o.notify('info', `Your vault is set up${r.people.length ? `, with notes for ${r.people.length} ${r.people.length === 1 ? 'person' : 'people'} Ghost knows` : ''}. Restart Obsidian so it picks up the new settings.`);
    });
  }

  dismissStarter(): void { this.setStarterState('dismissed'); this.o.onStatus(); }

  status(): ObsidianStatus {
    const available = this.vault.available();
    const st = importState(this.o.dataDir);
    return {
      vaults: detectVaults(),
      connected: { name: this.vault.name, path: this.vault.root, notes: this.index.size, waiting: this.vault.hasPending },
      error: available ? undefined : `Can't reach the vault folder (${this.vault.root}). Ghost keeps notes waiting and writes them when it's back.`,
      import: this.progress ?? (st.finished ? { done: st.done.length, total: st.done.length, phase: 'finished' } : null),
      backupBytes: backupInfo(this.o.dataDir)?.bytes ?? null,
      starter: this.starterStatus(),
    };
  }

  private starterStatus(): ObsidianStatus['starter'] {
    const state = this.starterStates()[this.vault.root];
    if (state === 'done') return 'done';
    if (state === 'dismissed' || !this.vault.available() || !this.index.size && !this.indexed) return null;
    return isNearlyEmpty(this.index, this.o.settings().obsidian.folder) ? 'offer' : null;
  }

  private starterStates(): Record<string, 'done' | 'dismissed'> {
    try { return JSON.parse(readFileSync(join(this.o.dataDir, 'obsidian-starter.json'), 'utf8')); } catch { return {}; }
  }

  private setStarterState(state: 'done' | 'dismissed'): void {
    const all = this.starterStates();
    all[this.vault.root] = state;
    try { writeFileSync(join(this.o.dataDir, 'obsidian-starter.json'), JSON.stringify(all, null, 2)); } catch { /* best effort */ }
  }

  private names(): Names {
    const s = this.o.settings();
    return { user: s.userName, assistant: s.assistantName };
  }

  private closeDeps(): CloseDeps {
    return {
      vault: this.vault, index: this.index, conversations: this.conversations,
      settings: () => this.o.settings().obsidian, names: () => this.names(), ask: this.o.ask,
    };
  }

  private enqueue(job: () => Promise<void>): Promise<unknown> {
    this.queue = this.queue.then(job).catch(e => this.o.notify('warn', `Obsidian: ${String((e as Error).message ?? e)}`));
    return this.queue;
  }

  private tick(): void {
    this.checkAvailable();
    this.vault.flush();
    void this.index.refreshAsync(); // catches anything the watcher missed
  }

  private checkAvailable(): void {
    const ok = this.vault.available();
    if (!ok && !this.warnedOffline) this.o.notify('warn', `Obsidian vault not found at ${this.vault.root}. Ghost will keep notes until it's back.`);
    this.warnedOffline = !ok;
    this.o.onStatus();
  }
}

function peoplePrompt(facts: string[]): string {
  return [
    'List the names of the people mentioned in these facts (not the person they are about). Reply with a JSON array of names only, e.g. ["Sam", "Mia"]. Reply [] if there are none.',
    '',
    ...facts.map(f => `- ${f}`),
  ].join('\n');
}

function parsePeople(reply: string): string[] {
  const list = JSON.parse(reply.slice(reply.indexOf('['), reply.lastIndexOf(']') + 1)) as unknown[];
  return [...new Set(list.map(x => String(x).trim()).filter(n => n && n.length <= 40))].slice(0, 30);
}
