import type { LogLine } from '../memory/conversations';
import { hhmm, isoDate, toTranscript, type VaultConversations } from '../memory/vaultConversations';
import type { ObsidianSettings } from '../../shared/settings';
import { addToDailyNote } from './dailyNote';
import { Linker } from './linker';
import {
  normaliseTag, parseConversationNote, renderConversationNote, renderTranscript, TRANSCRIPT_HEADER,
  type Frontmatter, type Names,
} from './markdown';
import { safeFileName, type ObsidianVault } from './vault';
import type { VaultIndex } from './vaultIndex';

// Filing a finished conversation: one quick model call gives it a title, summary, key points, tags
// and the people mentioned; the note is rewritten (keeping the transcript and anything under
// "My notes"), renamed to "<date> <title>.md" and linked from that day's Daily Note. A conversation
// that was only quick commands gets no note, just a line in the Daily Note.

export interface CloseDeps {
  vault: ObsidianVault;
  index: VaultIndex;
  conversations: VaultConversations;
  settings: () => ObsidianSettings;
  names: () => Names;
  /** One short model call (fast slot); rejects when no brain is available. */
  ask: (prompt: string) => Promise<string>;
}

export type CloseResult = 'note' | 'activity' | 'empty' | 'retry';

export interface Filing {
  title: string;
  summary: string;
  keyPoints: string[];
  decisions: string[];
  tags: string[];
  people: string[];
}

export async function closeConversation(d: CloseDeps, id: string): Promise<CloseResult> {
  const lines = d.conversations.lines(id);
  if (!lines.length) { d.conversations.forget(id); return 'empty'; }
  const s = d.settings();
  const start = new Date(lines[0].ts);
  const existing = d.conversations.notePath(id);

  // Only quick commands: a line in the Daily Note, no conversation note.
  if (!existing && lines.every(l => l.command)) {
    const actions = lines.flatMap(l => l.actions ?? []);
    if (s.dailyLinks && actions.length) addToDailyNote(d.vault, start, `- ${hhmm(start)} ${capitalise(actions.join(', '))}`);
    d.conversations.forget(id);
    return 'activity';
  }

  let filing: Filing;
  try {
    filing = parseFiling(await d.ask(filingPrompt(lines, d.names(), d.index.tagVocabulary(60), start)));
  } catch {
    if (existing) markNeedsSummary(d.vault, existing);
    else writeInterim(d, id, lines); // keep it in the vault even if it can't be summarised yet
    return 'retry';
  }

  const linker = s.linkNotes ? new Linker(d.index.linkTargets()) : null;
  const linked = new Set<string>();
  const link = (t: string) => linker?.linkify(t, linked) ?? t;

  const prev = existing ? d.vault.read(existing) : null;
  const note = prev ? parseConversationNote(prev) : null;
  const transcript = note?.transcript.includes(TRANSCRIPT_HEADER) && note.transcript.trim() !== TRANSCRIPT_HEADER
    ? note.transcript
    : `${TRANSCRIPT_HEADER}\n${renderTranscript(toTranscript(lines), d.names())}`;

  const end = new Date(lines.at(-1)!.ts);
  const people = filing.people.map(p => { const title = linker?.noteFor(p); return title ? `[[${title}]]` : p; });
  const frontmatter: Frontmatter = {
    date: isoDate(start),
    time: hhmm(start) === hhmm(end) ? hhmm(start) : `${hhmm(start)}–${hhmm(end)}`,
    brain: brainOf(lines),
    ...(people.length ? { people } : {}),
    tags: pickTags(filing.tags, d.index.tagVocabulary(200), s.topicTags),
    summary: oneLine(filing.summary),
  };
  const content = renderConversationNote({
    frontmatter,
    title: filing.title,
    summary: link(filing.summary),
    keyPoints: [...filing.decisions.map(x => `Decided: ${x}`), ...filing.keyPoints].map(link),
    myNotes: note?.myNotes ?? '',
    transcript,
  });

  const target = `${d.conversations.conversationsFolder}/${isoDate(start).slice(0, 7)}/${isoDate(start)} ${safeFileName(filing.title)}.md`;
  let path: string;
  if (existing) {
    d.vault.write(existing, content);
    path = d.vault.rename(existing, d.vault.unique(target, existing));
  } else {
    path = d.vault.unique(target);
    d.vault.write(path, content);
  }
  const name = path.split('/').pop()!.replace(/\.md$/, '');
  if (s.dailyLinks) addToDailyNote(d.vault, start, `- ${hhmm(start)} [[${name}|${filing.title}]]`);
  d.conversations.forget(id);
  d.index.update([path, ...(existing && existing !== path ? [existing] : [])]);
  return 'note';
}

export function filingPrompt(lines: LogLine[], names: Names, tagVocabulary: string[], start: Date): string {
  const transcript = lines.map(l => `${l.role === 'user' ? names.user : names.assistant}: ${l.text}${l.screen ? ` [looked at the screen: ${l.screen}]` : ''}`).join('\n');
  return [
    `You file ${names.user}'s conversations with ${names.assistant} into his Obsidian vault. Reply with JSON only, no prose:`,
    `{"title": "3-7 words", "summary": "2-3 plain sentences", "keyPoints": ["…"], "decisions": ["…"], "tags": ["…"], "people": ["…"]}`,
    `- title: specific and human, like a note title ("Tokyo trip planning", not "Conversation about travel").`,
    `- summary: what was discussed and concluded, written about ${names.user} in the third person.`,
    `- keyPoints: up to 5 short facts worth finding later (numbers, names, dates, recommendations). decisions: things ${names.user} decided or planned; empty if none.`,
    `- tags: 1-3 topic tags. ${tagVocabulary.length ? `Use these existing tags where one fits: ${tagVocabulary.join(', ')}. Only invent a new tag if none fits (lowercase-hyphenated).` : 'Lowercase-hyphenated, broad topics.'}`,
    `- people: names of other people mentioned (not ${names.user} or ${names.assistant}).`,
    '',
    `Conversation on ${start.toDateString()}:`,
    transcript.slice(-16_000),
  ].join('\n');
}

export function parseFiling(reply: string): Filing {
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  const raw = JSON.parse(json) as Partial<Record<keyof Filing, unknown>>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : []);
  const title = String(raw.title ?? '').trim().replace(/^["#\s]+|["\s]+$/g, '');
  if (!title) throw new Error('no title');
  return { title, summary: String(raw.summary ?? '').trim(), keyPoints: list(raw.keyPoints), decisions: list(raw.decisions), tags: list(raw.tags), people: list(raw.people) };
}

/** #ghost plus up to three topic tags, preferring the vault's own; at most one new tag per note. */
export function pickTags(proposed: string[], vocabulary: string[], topicTags: boolean): string[] {
  const tags = ['ghost'];
  if (!topicTags) return tags;
  const known = new Set(vocabulary.map(t => t.toLowerCase()));
  let fresh = 0;
  for (const p of proposed.map(normaliseTag).filter(Boolean)) {
    if (tags.length >= 4 || tags.includes(p) || p === 'ghost') continue;
    if (!known.has(p)) { if (fresh) continue; fresh++; }
    tags.push(p);
  }
  return tags;
}

function brainOf(lines: LogLine[]): string {
  const counts = new Map<string, number>();
  for (const l of lines) if (l.role === 'assistant' && l.provider) {
    const key = `${capitalise(l.provider)}${l.model && l.model !== 'default' ? ` (${l.model})` : ''}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Ghost';
}

function markNeedsSummary(vault: ObsidianVault, rel: string): void {
  const text = vault.read(rel);
  if (text && !/^status: needs summary$/m.test(text)) vault.write(rel, text.replace(/^status: .*$/m, 'status: needs summary'));
}

function writeInterim(d: CloseDeps, id: string, lines: LogLine[]): void {
  // Created through the normal path so it's tracked, then marked for a retry.
  const start = new Date(lines[0].ts);
  const path = d.vault.unique(`${d.conversations.conversationsFolder}/${isoDate(start).slice(0, 7)}/${isoDate(start)} ${hhmm(start).replace(':', '')} Ghost conversation.md`);
  d.vault.write(path, renderConversationNote({
    frontmatter: { date: isoDate(start), time: hhmm(start), status: 'needs summary', tags: ['ghost'] },
    title: 'Conversation (not yet summarised)',
    myNotes: '',
    transcript: `${TRANSCRIPT_HEADER}\n${renderTranscript(toTranscript(lines), d.names())}`,
  }));
  d.conversations.adopt(id, path, lines.length);
}

function oneLine(s: string): string { return s.replace(/\s+/g, ' ').trim(); }
function capitalise(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
