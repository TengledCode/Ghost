import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationLog } from '../src/core/memory/conversations';
import { VaultConversations } from '../src/core/memory/vaultConversations';
import { VaultMemory } from '../src/core/memory/vaultMemory';
import { closeConversation, pickTags, type CloseDeps } from '../src/core/obsidian/closer';
import { addToDailyNote, dailyNoteConfig, dailyNotePath, formatMoment, insertUnderHeading } from '../src/core/obsidian/dailyNote';
import { backupInfo, deleteBackup, importLocalHistory, importState } from '../src/core/obsidian/importer';
import { Linker } from '../src/core/obsidian/linker';
import {
  parseConversationNote, parseFrontmatter, renderConversationNote, renderTranscript, stringifyFrontmatter, transcriptOf, TRANSCRIPT_HEADER,
  type TranscriptLine,
} from '../src/core/obsidian/markdown';
import { detectVaults, ObsidianVault, safeFileName } from '../src/core/obsidian/vault';
import { VaultIndex } from '../src/core/obsidian/vaultIndex';
import { VaultTools } from '../src/core/obsidian/vaultTools';
import { ScreenNoteFilter } from '../src/core/screenNoteFilter';
import { actionLabel, isCommandTurn } from '../src/core/turnKind';
import { DEFAULT_OBSIDIAN, type ObsidianSettings } from '../src/shared/settings';

const names = { user: 'Aaron', assistant: 'Ghost' };

/** A small vault like Aaron's: Daily Notes in "Daily", a people note, a project note with tags. */
function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'ghost-vault-'));
  const data = mkdtempSync(join(tmpdir(), 'ghost-data-'));
  const put = (rel: string, text: string) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('.obsidian/core-plugins.json', JSON.stringify(['file-explorer', 'daily-notes']));
  put('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily', format: 'YYYY-MM-DD' }));
  put('People/Sam.md', '---\naliases: [Samuel]\ntags: [person]\n---\n# Sam\nMy brother.\n');
  put('Projects/Travel Budget 2026.md', '---\ntags: [travel, finance]\n---\nFlights and hotels. #travel\n');
  put('Ideas.md', '# Ideas\n- A tea subscription\n');
  const vault = new ObsidianVault(root, join(data, 'pending.json'));
  const index = new VaultIndex(vault, () => 'Ghost');
  index.refresh();
  let settings: ObsidianSettings = { ...DEFAULT_OBSIDIAN, vaultPath: root };
  const buffer = new ConversationLog(data);
  const conversations = new VaultConversations(buffer, vault, index, { folder: () => 'Ghost', names: () => names, stateFile: join(data, 'notes.json') });
  const memory = new VaultMemory(vault, index, {
    folder: () => 'Ghost', linker: () => new Linker(index.linkTargets()), cacheFile: join(data, 'memory-cache.json'),
    conversationsFolder: () => 'Ghost/Conversations',
  });
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const files = (dir: string): string[] => existsSync(join(root, dir))
    ? readdirSync(join(root, dir), { recursive: true }).map(String).filter(f => f.endsWith('.md')) : [];
  const deps = (ask: CloseDeps['ask']): CloseDeps => ({ vault, index, conversations, settings: () => settings, names: () => names, ask });
  return { root, data, vault, index, buffer, conversations, memory, read, files, deps, put, setSettings: (s: Partial<ObsidianSettings>) => { settings = { ...settings, ...s }; } };
}

const filing = (over: Record<string, unknown> = {}) => async () => JSON.stringify({
  title: 'Tokyo trip planning', summary: 'Aaron planned the Tokyo trip with Sam; the budget is in Travel Budget 2026.',
  keyPoints: ['Flights on 12 Dec'], decisions: ['Budget S$3,000'], tags: ['travel', 'Japan Trips', 'food'], people: ['Sam', 'Mia'], ...over,
});

describe('Obsidian markdown', () => {
  it('round-trips frontmatter the way Obsidian writes Properties', () => {
    const data = { date: '2026-09-30', time: '19:05–19:32', people: ['[[Sam]]', 'Mia'], tags: ['ghost', 'travel'], summary: 'Budget: S$3,000 "tight"' };
    const text = `${stringifyFrontmatter(data)}\nbody`;
    expect(parseFrontmatter(text)).toEqual({ data, body: 'body' });
    expect(parseFrontmatter('---\ntags: [a, "b c"]\nk: v\n---\nx').data).toEqual({ tags: ['a', 'b c'], k: 'v' });
  });

  it('round-trips transcripts, including code, blank lines and what Ghost saw', () => {
    const lines: TranscriptLine[] = [
      { time: '19:05', speaker: 'user', text: 'Fix this:\n\nconst x = 1' },
      { time: '19:06', speaker: 'assistant', text: '```ts\nconst x: number = 1;\n```\nThat types it.', screen: 'VS Code, an error in main.ts' },
      { time: '19:07', speaker: 'user', text: '- one\n- two' },
    ];
    const note = `# T\n\n${TRANSCRIPT_HEADER}\n${renderTranscript(lines, names)}\n`;
    expect(note).toContain('> *(looked at your screen: VS Code, an error in main.ts)*');
    expect(transcriptOf(note, names)).toEqual(lines);
  });

  it('keeps "My notes" when a note is rewritten', () => {
    const text = renderConversationNote({ frontmatter: { date: '2026-09-30' }, title: 'T', summary: 'S', keyPoints: ['a'], myNotes: 'Call Sam back.', transcript: TRANSCRIPT_HEADER });
    const parsed = parseConversationNote(text);
    expect(parsed).toMatchObject({ title: 'T', summary: 'S', keyPoints: ['a'], myNotes: 'Call Sam back.' });
    expect(parsed.transcript.startsWith(TRANSCRIPT_HEADER)).toBe(true);
  });

  it('makes safe file names', () => {
    expect(safeFileName('Q3: plans / ideas?')).toBe('Q3 plans ideas');
    expect(safeFileName('')).toBe('Untitled');
  });
});

describe('linking to existing notes', () => {
  const linker = new Linker([
    { title: 'Sam', name: 'Sam' }, { title: 'Sam', name: 'Samuel' },
    { title: 'Travel Budget 2026', name: 'Travel Budget 2026' }, { title: 'Travel', name: 'Travel' },
  ]);

  it('links the longest match, only the first mention, keeping how it was written', () => {
    expect(linker.linkify('The travel budget 2026 covers Sam. Sam agreed; travel is booked.'))
      .toBe('The [[Travel Budget 2026|travel budget 2026]] covers [[Sam]]. Sam agreed; [[Travel|travel]] is booked.');
    expect(linker.linkify('Samuel called')).toBe('[[Sam|Samuel]] called');
  });

  it('never links inside code, links, URLs or other words', () => {
    expect(linker.linkify('`Sam` and [[Sam]] and https://sam.example/Sam and Samantha')).toBe('`Sam` and [[Sam]] and https://sam.example/Sam and Samantha');
  });
});

describe('Daily Notes', () => {
  it('formats dates the way Daily Notes does', () => {
    const d = new Date(2026, 8, 30, 19, 5);
    expect(formatMoment(d, 'YYYY-MM-DD')).toBe('2026-09-30');
    expect(formatMoment(d, 'dddd, MMMM Do YYYY')).toBe('Wednesday, September 30th 2026');
    expect(formatMoment(d, '[Week] ww, ddd D MMM')).toBe('Week 40, Wed 30 Sep');
  });

  it("finds the note with Obsidian's own settings and adds a Ghost section once", () => {
    const v = makeVault();
    const d = new Date(2026, 8, 30, 19, 5);
    expect(dailyNotePath(dailyNoteConfig(v.vault), d)).toBe('Daily/2026-09-30.md');
    v.put('Daily/2026-09-30.md', '# Wednesday\nGym at 7.\n\n## Later\nstuff\n');
    addToDailyNote(v.vault, d, '- 19:05 [[A|A]]');
    addToDailyNote(v.vault, d, '- 20:10 [[B|B]]');
    addToDailyNote(v.vault, d, '- 20:10 [[B|B]]'); // already there
    expect(v.read('Daily/2026-09-30.md')).toBe('# Wednesday\nGym at 7.\n\n## Later\nstuff\n\n## Ghost\n- 19:05 [[A|A]]\n- 20:10 [[B|B]]\n');
  });

  it('creates the day from the template, and stays out when Daily Notes is off', () => {
    const v = makeVault();
    v.put('.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Day' }));
    v.put('Templates/Day.md', '# {{date:dddd D MMMM}}\n## Tasks\n');
    addToDailyNote(v.vault, new Date(2026, 9, 1), '- x');
    expect(v.read('Daily/2026-10-01.md')).toBe('# Thursday 1 October\n## Tasks\n\n## Ghost\n- x\n');
    v.put('.obsidian/core-plugins.json', JSON.stringify({ 'daily-notes': false }));
    expect(addToDailyNote(v.vault, new Date(2026, 9, 2), '- y')).toBeNull();
    expect(insertUnderHeading('', 'Ghost', '- a')).toBe('## Ghost\n- a\n');
  });
});

describe('conversations in the vault', () => {
  it('keeps quick commands out of the vault, then files a real conversation as a linked, tagged note', async () => {
    const v = makeVault();
    v.buffer.append('user', 'open spotify', { command: true });
    v.buffer.append('assistant', 'Opened Spotify.', { command: true, actions: ['opened spotify'] });
    v.conversations.append('user', 'x'); // (no-op check: user lines alone never write)
    expect(v.files('Ghost')).toEqual([]);

    // A real exchange starts the note, including what came before.
    v.conversations.append('user', "Let's plan Tokyo with Sam.");
    v.conversations.append('assistant', 'Happy to. What budget?', { provider: 'claude', model: 'sonnet' });
    v.conversations.append('user', 'S$3,000.');
    v.conversations.append('assistant', 'Noted, flights on 12 Dec.', { provider: 'claude', model: 'sonnet', screen: 'a flight search' });
    const [live] = v.files('Ghost/Conversations');
    expect(live).toMatch(/Ghost conversation\.md$/);
    const liveText = v.read(`Ghost/Conversations/${live}`);
    expect(transcriptOf(liveText, names).map(l => l.text)).toEqual(['open spotify', 'Opened Spotify.', 'x', "Let's plan Tokyo with Sam.", 'Happy to. What budget?', 'S$3,000.', 'Noted, flights on 12 Dec.']);

    // Aaron jots something in the note before it's filed.
    writeFileSync(join(v.root, 'Ghost/Conversations', live), liveText.replace('## My notes\n', '## My notes\nAsk Mia about hotels.\n'));

    const id = v.conversations.rotate();
    expect(await closeConversation(v.deps(filing()), id)).toBe('note');
    const [filed] = v.files('Ghost/Conversations');
    expect(filed).toMatch(/2026-\d\d\/\d{4}-\d\d-\d\d Tokyo trip planning\.md$/);
    const note = v.read(`Ghost/Conversations/${filed}`);
    const { data } = parseFrontmatter(note);
    expect(data).toMatchObject({ brain: 'Claude (sonnet)', people: ['[[Sam]]', 'Mia'], tags: ['ghost', 'travel', 'japan-trips'] });
    expect(note).toContain('## Summary\nAaron planned the Tokyo trip with [[Sam]]; the budget is in [[Travel Budget 2026]].');
    expect(note).toContain('- Decided: Budget S$3,000');
    expect(note).toContain('## My notes\nAsk Mia about hotels.');
    expect(note).toContain('> *(looked at your screen: a flight search)*');
    const daily = readdirSync(join(v.root, 'Daily'))[0];
    expect(v.read(`Daily/${daily}`)).toMatch(/## Ghost\n- \d\d:\d\d \[\[\d{4}-\d\d-\d\d Tokyo trip planning\|Tokyo trip planning]]\n/);
    expect(v.buffer.ids()).not.toContain(id); // the working copy is gone: the note is the only copy
  });

  it('turns a command-only conversation into one line in the Daily Note', async () => {
    const v = makeVault();
    v.conversations.append('user', 'open spotify', { command: true });
    v.conversations.append('assistant', 'Opened Spotify.', { command: true, actions: ['opened spotify'] });
    v.conversations.append('user', 'remind me at 3 to stretch', { command: true });
    v.conversations.append('assistant', 'Reminder set.', { command: true, actions: ['set a reminder: stretch'] });
    expect(await closeConversation(v.deps(filing()), v.conversations.rotate())).toBe('activity');
    expect(v.files('Ghost')).toEqual([]);
    const daily = readdirSync(join(v.root, 'Daily'))[0];
    expect(v.read(`Daily/${daily}`)).toMatch(/## Ghost\n- \d\d:\d\d Opened spotify, set a reminder: stretch\n/);
  });

  it("keeps a conversation that couldn't be summarised, and finishes it later", async () => {
    const v = makeVault();
    v.conversations.append('user', 'How do tides work?');
    v.conversations.append('assistant', 'The moon pulls the oceans.');
    const id = v.conversations.rotate();
    expect(await closeConversation(v.deps(async () => { throw new Error('offline'); }), id)).toBe('retry');
    const [waiting] = v.files('Ghost/Conversations');
    expect(v.read(`Ghost/Conversations/${waiting}`)).toMatch(/^status: needs summary$/m);
    expect(v.conversations.unfiled()).toContain(id);
    expect(await closeConversation(v.deps(filing({ title: 'Tides', people: [] })), id)).toBe('note');
    expect(v.files('Ghost/Conversations')).toEqual([expect.stringMatching(/ Tides\.md$/)]);
  });

  it('finds what was said in past conversations, with dates and the note', async () => {
    const v = makeVault();
    v.conversations.append('user', 'Which film was that?');
    v.conversations.append('assistant', 'Perfect Days, by Wim Wenders.');
    await closeConversation(v.deps(filing({ title: 'Film chat', summary: 'Ghost recommended Perfect Days.' })), v.conversations.rotate());
    const hits = v.conversations.search('Wenders film');
    expect(hits.join('\n')).toMatch(/\[\[\d{4}-\d\d-\d\d Film chat]]\) Ghost recommended Perfect Days/);
    expect(hits.join('\n')).toMatch(/Ghost: Perfect Days, by Wim Wenders/);
  });

  it("moves conversation notes to Obsidian's trash when history is cleared", async () => {
    const v = makeVault();
    v.conversations.append('user', 'How do tides work?');
    v.conversations.append('assistant', 'The moon.');
    await closeConversation(v.deps(filing({ title: 'Tides' })), v.conversations.rotate());
    v.conversations.clear();
    expect(v.files('Ghost/Conversations')).toEqual([]);
    expect(readdirSync(join(v.root, '.trash'))).toEqual([expect.stringMatching(/Tides\.md$/)]);
  });

  it('prefers the vault\'s own tags and adds at most one new one', () => {
    expect(pickTags(['Travel', 'finance', 'new-one', 'another-new'], ['travel', 'finance'], true)).toEqual(['ghost', 'travel', 'finance', 'new-one']);
    expect(pickTags(['travel'], ['travel'], false)).toEqual(['ghost']);
  });
});

describe('memory notes', () => {
  it('files facts by topic, links people, and follows edits made in Obsidian', () => {
    const v = makeVault();
    v.memory.remember("Sam's birthday is 4 March", 'People');
    v.memory.remember('Prefers Earl Grey', 'Preferences');
    v.memory.remember('Lives in Singapore', 'About me');
    v.memory.remember('prefers earl grey', 'Other'); // duplicate
    expect(v.read('Ghost/Memory/People.md')).toContain("- [[Sam]]'s birthday is 4 March");
    expect(v.files('Ghost/Memory').sort()).toEqual(['About me.md', 'People.md', 'Preferences.md']);
    expect(v.memory.recall('when is Sam birthday')).toEqual(["Sam's birthday is 4 March"]);
    expect(v.memory.contextFor('hello')).toContain('Lives in Singapore');

    // Aaron corrects a fact in Obsidian.
    const people = v.read('Ghost/Memory/People.md').replace('4 March', '5 March');
    writeFileSync(join(v.root, 'Ghost/Memory/People.md'), people);
    expect(v.memory.recall('Sam birthday')).toEqual(["Sam's birthday is 5 March"]);

    expect(v.memory.forget('earl grey')).toBe(1);
    expect(v.read('Ghost/Memory/Preferences.md')).not.toContain('Earl Grey');
  });
});

describe("Ghost's access to the rest of the vault", () => {
  it('searches, reads and writes notes, and never outside the vault', () => {
    const v = makeVault();
    const settings = { ...DEFAULT_OBSIDIAN, vaultPath: v.root };
    const tools = new VaultTools(v.vault, v.index, () => settings);
    expect(tools.search('tea subscription')).toMatch(/^Ideas\.md\n {2}- A tea subscription/);
    expect(tools.read('Ideas')).toContain('A tea subscription');
    expect(tools.write('Ideas', 'A travel mug for Sam', 'append')).toBe('Added to Ideas.md.');
    expect(v.read('Ideas.md')).toBe('# Ideas\n- A tea subscription\n\nA travel mug for [[Sam]]\n');
    expect(tools.write('Projects/New.md', 'Hello', 'create')).toBe('Created Projects/New.md.');
    expect(tools.write('Projects/New.md', 'Again', 'create')).toMatch(/already exists/);
    expect(() => tools.write('../outside.md', 'x', 'create')).toThrow(/outside the vault/);
    expect(tools.read(join(v.root, 'Ideas.md'))).toContain('A tea subscription'); // absolute, inside the vault
    expect(tools.read('/Ideas.md')).toContain('A tea subscription'); // "/…" means the vault's root
    if (process.platform === 'win32') expect(() => tools.read('C:/Windows/win.ini')).toThrow(/outside the vault/);
    const locked = new VaultTools(v.vault, v.index, () => ({ ...settings, readVault: false, writeVault: false }));
    expect(locked.search('tea')).toMatch(/switched off/);
    expect(locked.write('Ideas', 'x', 'append')).toMatch(/switched off/);
  });
});

describe('when the vault is unavailable', () => {
  it('keeps writes waiting and writes them when the vault is back', () => {
    const v = makeVault();
    const away = `${v.root}-away`;
    renameSync(v.root, away);
    v.vault.write('Ghost/Memory/Other.md', '- waiting');
    expect(v.vault.hasPending).toBe(true);
    expect(v.vault.read('Ghost/Memory/Other.md')).toBe('- waiting');
    renameSync(away, v.root);
    v.vault.flush();
    expect(v.read('Ghost/Memory/Other.md')).toBe('- waiting');
    expect(v.vault.hasPending).toBe(false);
  });
});

describe('importing existing history', () => {
  it('backs up, files old conversations and facts, and can be resumed without duplicates', async () => {
    const v = makeVault();
    const line = (ts: string, role: string, text: string, extra = {}) => JSON.stringify({ ts, role, text, ...extra });
    mkdirSync(join(v.data, 'conversations'), { recursive: true });
    writeFileSync(join(v.data, 'conversations', '2026-08-01-aaaa.jsonl'), [line('2026-08-01T10:00:00.000Z', 'user', 'How do I fix my bike chain?'), line('2026-08-01T10:01:00.000Z', 'assistant', 'Degrease it, then oil every link.')].join('\n'));
    writeFileSync(join(v.data, 'conversations', '2026-08-02-bbbb.jsonl'), [line('2026-08-02T09:00:00.000Z', 'user', 'Tell me about Kyoto'), line('2026-08-02T09:01:00.000Z', 'assistant', 'Temples, gardens and tea.')].join('\n'));
    writeFileSync(join(v.data, 'memory.json'), JSON.stringify({ facts: [{ id: '1', text: 'Likes cycling', created: '', hits: 0 }, { id: '2', text: "Sam's birthday is 4 March", created: '', hits: 0 }], episodes: [] }));

    let calls = 0;
    const ask = async (prompt: string) => {
      calls++;
      if (prompt.includes('Sort these facts')) return JSON.stringify({ 0: 'About me', 1: 'People' });
      if (prompt.includes('Kyoto') && calls === 2) throw new Error('limit reached'); // pause mid-way
      return JSON.stringify({ title: prompt.includes('Kyoto') ? 'Kyoto ideas' : 'Bike chain care', summary: 's', keyPoints: [], decisions: [], tags: [], people: [] });
    };
    const deps = { ...v.deps(ask), dataDir: v.data, memory: v.memory, onProgress: () => {} };
    expect((await importLocalHistory(deps)).phase).toBe('paused');
    expect(importState(v.data).done).toEqual(['2026-08-01-aaaa']);
    expect((await importLocalHistory(deps)).phase).toBe('finished');

    expect(v.files('Ghost/Conversations').sort()).toEqual(['2026-08/2026-08-01 Bike chain care.md', '2026-08/2026-08-02 Kyoto ideas.md']);
    expect(v.read('Ghost/Memory/People.md')).toContain("- [[Sam]]'s birthday is 4 March");
    expect(v.read('Ghost/Memory/About me.md')).toContain('- Likes cycling');
    expect(existsSync(join(v.data, 'memory.json'))).toBe(false); // Ghost now reads the Memory notes
    expect(v.buffer.ids()).toEqual([]);
    const backup = backupInfo(v.data)!;
    expect(readdirSync(join(backup.path, 'conversations'))).toHaveLength(2);
    expect(backup.bytes).toBeGreaterThan(0);
    deleteBackup(v.data);
    expect(backupInfo(v.data)).toBeNull();
  });
});

describe('telling commands from conversations', () => {
  it('treats carried-out instructions and small talk as commands', () => {
    expect(isCommandTurn('open spotify', ['mcp__ghost__open_app'], ['opened spotify'], 'Opened Spotify.')).toBe(true);
    expect(isCommandTurn('thanks!', [], [], 'Any time.')).toBe(true);
    expect(isCommandTurn('why is the sky blue', [], [], 'Rayleigh scattering.')).toBe(false);
    expect(isCommandTurn('open spotify', ['mcp__ghost__open_app'], ['opened spotify'], 'Opened it. Want a playlist?')).toBe(false);
    expect(isCommandTurn('look this up', ['WebSearch'], [], 'Found it.')).toBe(false);
    expect(actionLabel('open_app', { name: 'spotify' })).toBe('opened spotify');
    expect(actionLabel('vault_write', { path: 'Ideas.md', mode: 'append' })).toBe('added to [[Ideas]]');
    expect(actionLabel('list_windows', {})).toBeNull();
  });
});

describe('screen notes', () => {
  it('takes the <screen> note out of the reply, even split across deltas', () => {
    const f = new ScreenNoteFilter();
    const out = ['The error is on line 4. <scr', 'een>VS Code, a Type', 'Script error</scr', 'een>'].map(d => f.push(d)).join('') + f.flush();
    expect(out).toBe('The error is on line 4. ');
    expect(f.screen).toBe('VS Code, a TypeScript error');
    const g = new ScreenNoteFilter();
    expect(g.push('a < b and <sc') + g.flush()).toBe('a < b and <sc');
  });
});

describe('finding vaults', () => {
  it("reads Obsidian's own list, open vault first", () => {
    const cfg = mkdtempSync(join(tmpdir(), 'obs-cfg-'));
    const a = mkdtempSync(join(tmpdir(), 'VaultA-'));
    const b = mkdtempSync(join(tmpdir(), 'VaultB-'));
    writeFileSync(join(cfg, 'obsidian.json'), JSON.stringify({ vaults: { x: { path: a, ts: 2 }, y: { path: b, ts: 1, open: true }, z: { path: '/nope', ts: 3 } } }));
    expect(detectVaults(cfg).map(v => v.path)).toEqual([b, a]);
    expect(detectVaults(join(cfg, 'missing'))).toEqual([]);
  });
});

import { isNearlyEmpty, relinkGhostNotes, setupStarter } from '../src/core/obsidian/starter';

describe('starter layout for a nearly empty vault', () => {
  it('sets up folders, notes and Obsidian settings without overwriting anything, and links Ghost notes to new people notes', async () => {
    const v = makeVault();
    v.put('Home.md', '# My own home\n');
    v.put('.obsidian/app.json', JSON.stringify({ newFileLocation: 'current', theme: 'obsidian' }));
    // Ghost already knows about Mia (no note yet) from memory and a filed conversation.
    v.memory.remember("Mia's birthday is 2 May", 'People');
    v.conversations.append('user', 'Plan dinner with Mia');
    v.conversations.append('assistant', 'Booked for Friday.');
    await closeConversation(v.deps(filing({ title: 'Dinner plans', summary: 'Aaron planned dinner with Mia.', people: ['Mia'] })), v.conversations.rotate());
    expect(isNearlyEmpty(v.index, 'Ghost')).toBe(true);

    const r = setupStarter(v.vault, v.index, { ghostFolder: 'Ghost', people: ['Mia', 'Sam'] });
    expect(r.created).toEqual(expect.arrayContaining(['Templates/Daily.md', 'Inbox/Welcome to your Inbox.md']));
    expect(r.created).not.toContain('Home.md');
    expect(v.read('Home.md')).toBe('# My own home\n'); // kept
    expect(r.people).toEqual(['People/Mia.md']); // Sam already has a note
    expect(JSON.parse(v.read('.obsidian/app.json'))).toEqual({ newFileLocation: 'current', theme: 'obsidian', newFileFolderPath: 'Inbox' });
    expect(JSON.parse(v.read('.obsidian/daily-notes.json'))).toEqual({ folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily' });
    expect(JSON.parse(v.read('.obsidian/templates.json'))).toEqual({ folder: 'Templates' });
    expect(JSON.parse(v.read('.obsidian/core-plugins.json'))).toEqual(['file-explorer', 'daily-notes', 'templates']);

    // Ghost's notes now link to Mia; the transcript is left exactly as it was.
    expect(r.relinked).toBeGreaterThanOrEqual(2);
    expect(v.read('Ghost/Memory/People.md')).toContain("- [[Mia]]'s birthday is 2 May");
    const [note] = v.files('Ghost/Conversations');
    const text = v.read(`Ghost/Conversations/${note}`);
    expect(text).toContain('Aaron planned dinner with [[Mia]].');
    expect(text).toContain('> **');
    expect(text).toMatch(/Plan dinner with Mia$/m);

    // A day's note now follows the new settings and template.
    addToDailyNote(v.vault, new Date(2026, 9, 1), '- x');
    expect(v.read('Daily/2026-10-01.md')).toBe('# Thursday 1 October 2026\n\n## Plan\n- \n\n## Notes\n\n## Ghost\n- x\n');
    expect(relinkGhostNotes(v.vault, v.index, 'Ghost')).toBe(0); // nothing left to link
  });

  it("switches plugins on in either settings format, and leaves Obsidian's defaults alone", () => {
    const v = makeVault();
    v.put('.obsidian/core-plugins.json', JSON.stringify({ 'daily-notes': false, graph: true }));
    setupStarter(v.vault, v.index, { ghostFolder: 'Ghost', people: [] });
    expect(JSON.parse(v.read('.obsidian/core-plugins.json'))).toEqual({ 'daily-notes': true, graph: true, templates: true });
    const w = makeVault();
    w.vault.remove('.obsidian/core-plugins.json');
    setupStarter(w.vault, w.index, { ghostFolder: 'Ghost', people: [] });
    expect(existsSync(join(w.root, '.obsidian/core-plugins.json'))).toBe(false);
  });

  it('only offers itself when the vault is nearly empty', () => {
    const v = makeVault();
    for (let i = 0; i < 25; i++) v.put(`Notes/n${i}.md`, `# ${i}`);
    v.index.refresh();
    expect(isNearlyEmpty(v.index, 'Ghost')).toBe(false);
  });
});
