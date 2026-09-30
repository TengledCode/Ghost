import { parseConversationNote, renderConversationNote } from './markdown';
import { Linker } from './linker';
import { safeFileName, type ObsidianVault } from './vault';
import type { VaultIndex } from './vaultIndex';

// A starter layout for a (nearly) empty vault, offered once in Settings → Obsidian: Daily notes in
// Daily/, new notes in Inbox/, a note per person in People/ and a Home note tying it together, with
// Obsidian's own settings pointed at them. Nothing that already exists is overwritten: notes are
// created only if missing and settings files are merged, keeping every key already there.

export const NEARLY_EMPTY = 20;

/** Few enough notes of Aaron's own (Ghost's folder aside) that a starter layout makes sense. */
export function isNearlyEmpty(index: VaultIndex, ghostFolder: string): boolean {
  return index.all().filter(n => !n.rel.startsWith(`${ghostFolder}/`)).length < NEARLY_EMPTY;
}

export interface StarterResult { created: string[]; settings: string[]; people: string[]; relinked: number }

export interface StarterOptions {
  ghostFolder: string;
  /** Names of people Ghost knows (from its memory); may be empty. */
  people: string[];
}

const DAILY_TEMPLATE = `# {{date:dddd D MMMM YYYY}}

## Plan
-\u0020

## Notes
`;

function home(ghostFolder: string): string {
  return `# Home

Start here. Everything else is linked from this note.

- **Today:** open today's note with the calendar icon in the left bar (or the command "Open today's daily note"). Daily notes live in \`Daily/\`.
- **Inbox:** new notes land in \`Inbox/\`. Sort them into folders when you have a moment, or leave them; search finds everything.
- **People:** one note per person in \`People/\`. When you or Ghost mention someone who has a note, it links automatically.
- **Ghost:** conversations are in \`${ghostFolder}/Conversations\`, and what Ghost knows about you is in [[${ghostFolder}/Memory/About me|About me]], [[${ghostFolder}/Memory/People|People]], [[${ghostFolder}/Memory/Preferences|Preferences]] and [[${ghostFolder}/Memory/Plans & routines|Plans & routines]]. Edit those freely.
`;
}

export function setupStarter(vault: ObsidianVault, index: VaultIndex, o: StarterOptions): StarterResult {
  const result: StarterResult = { created: [], settings: [], people: [], relinked: 0 };
  const create = (rel: string, text: string, bucket: string[] = result.created) => {
    if (vault.exists(rel)) return;
    vault.write(rel, text);
    bucket.push(rel);
  };

  // Notes and folders (Obsidian shows a folder once it holds a note).
  create('Home.md', home(o.ghostFolder));
  create('Templates/Daily.md', DAILY_TEMPLATE);
  create('Inbox/Welcome to your Inbox.md', '# Inbox\n\nNew notes land here. Move them into folders when you like, or delete this one.\n');
  for (const name of o.people) {
    const clean = safeFileName(name, 60);
    if (!clean || clean === 'Untitled') continue;
    create(`People/${clean}.md`, `# ${clean}\n\n- About: \n`, result.people);
  }

  // Obsidian's settings: only keys that aren't set yet.
  const merge = (file: string, patch: Record<string, unknown>) => {
    const rel = `.obsidian/${file}`;
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(vault.read(rel) ?? '{}'); } catch { return; } // unreadable: leave it alone
    const missing = Object.fromEntries(Object.entries(patch).filter(([k]) => current[k] === undefined || current[k] === ''));
    if (!Object.keys(missing).length) return;
    vault.write(rel, JSON.stringify({ ...current, ...missing }, null, 2));
    result.settings.push(rel);
  };
  merge('daily-notes.json', { folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily' });
  merge('templates.json', { folder: 'Templates' });
  merge('app.json', { newFileLocation: 'folder', newFileFolderPath: 'Inbox' });
  enableCorePlugins(vault, ['daily-notes', 'templates'], result);

  index.refresh();
  result.relinked = relinkGhostNotes(vault, index, o.ghostFolder);
  return result;
}

/** Turn on core plugins. A missing file means Obsidian's defaults, where both are already on. */
function enableCorePlugins(vault: ObsidianVault, ids: string[], result: StarterResult): void {
  const rel = '.obsidian/core-plugins.json';
  const text = vault.read(rel);
  if (text === null) return;
  let data: unknown;
  try { data = JSON.parse(text); } catch { return; }
  let changed = false;
  if (Array.isArray(data)) {
    for (const id of ids) if (!data.includes(id)) { data.push(id); changed = true; }
  } else if (data && typeof data === 'object') {
    const map = data as Record<string, boolean>;
    for (const id of ids) if (map[id] !== true) { map[id] = true; changed = true; }
  }
  if (changed) { vault.write(rel, JSON.stringify(data, null, 2)); result.settings.push(rel); }
}

/**
 * Link Ghost's own notes to notes that now exist (e.g. new people notes): Memory bullets, and each
 * conversation's summary and key points. Transcripts and "My notes" are never touched.
 * Returns how many notes changed.
 */
export function relinkGhostNotes(vault: ObsidianVault, index: VaultIndex, ghostFolder: string): number {
  const linker = new Linker(index.linkTargets());
  let changed = 0;
  for (const rel of vault.list(ghostFolder)) {
    const text = vault.read(rel);
    if (!text) continue;
    let next = text;
    if (rel.startsWith(`${ghostFolder}/Memory/`)) {
      next = text.split('\n').map(line => {
        const m = line.match(/^(\s*[-*+]\s+)(.+)$/);
        return m ? m[1] + linker.linkify(m[2]) : line;
      }).join('\n');
    } else if (rel.startsWith(`${ghostFolder}/Conversations/`)) {
      const note = parseConversationNote(text);
      if (!note.summary && !note.keyPoints?.length) continue; // not filed yet
      const seen = new Set<string>();
      next = renderConversationNote({
        ...note,
        summary: note.summary ? linker.linkify(note.summary, seen) : undefined,
        keyPoints: note.keyPoints?.map(k => linker.linkify(k, seen)),
      });
    }
    if (next !== text) { vault.write(rel, next); changed++; }
  }
  if (changed) index.refresh();
  return changed;
}
