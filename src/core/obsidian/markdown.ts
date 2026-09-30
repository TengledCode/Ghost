// Ghost's notes as Markdown: frontmatter (Obsidian "Properties"), conversation notes with a folded
// transcript, and the parsing that reads them back. Round-trips are exact, because the vault, not a
// private database, is where Ghost's history lives.

export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

// ---------------------------------------------------------------- frontmatter

/** Split a note into its frontmatter and body. Understands the YAML Obsidian writes for Properties. */
export function parseFrontmatter(text: string): { data: Frontmatter; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: text };
  const data: Frontmatter = {};
  let listKey: string | null = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = raw.match(/^\s+-\s*(.*)$/);
    if (item && listKey) { (data[listKey] as string[]).push(unquote(item[1])); continue; }
    const kv = raw.match(/^([A-Za-z0-9_\- ]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    listKey = null;
    if (value === '') { data[key] = []; listKey = key; }
    else if (value.startsWith('[') && value.endsWith(']') && !value.startsWith('[[')) data[key] = splitInline(value.slice(1, -1));
    else data[key] = unquote(value);
  }
  return { data, body: text.slice(m[0].length) };
}

export function stringifyFrontmatter(data: Frontmatter): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) lines.push(value.length ? `${key}:\n${value.map(v => `  - ${quote(v)}`).join('\n')}` : `${key}: []`);
    else lines.push(`${key}: ${quote(value)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function splitInline(s: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null, depth = 0;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t[0] === '"' ? t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function quote(v: string): string {
  // Plain when YAML would read it back unchanged; otherwise double-quoted.
  if (v !== '' && /^[\p{L}\p{N}][\p{L}\p{N} _.,()'/–&+-]*$/u.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) && !/[:#]/.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------- transcripts

export interface TranscriptLine {
  time: string; // "HH:MM"
  speaker: 'user' | 'assistant';
  text: string;
  screen?: string; // what Ghost saw on the screen for this reply
}

export interface Names { user: string; assistant: string }

export const TRANSCRIPT_HEADER = '> [!quote]- Transcript';

/** Transcript lines inside a folded callout: every line starts with ">", so code and lists survive. */
export function renderTranscript(lines: TranscriptLine[], names: Names): string {
  return lines.map(renderTranscriptEntry(names)).join('\n>\n');
}

export function renderTranscriptEntry(names: Names): (l: TranscriptLine) => string {
  return l => {
    const label = `**${l.time} ${l.speaker === 'user' ? names.user : names.assistant}:**`;
    const body = l.text.replace(/\s+$/, '').split('\n');
    // Keep block content (code fences, lists, headings) on its own lines, after the label.
    const inline = body.length && !/^(```|#|[-*+] |\d+\. |>|\|)/.test(body[0]);
    const out = inline ? [`${label} ${body[0]}`, ...body.slice(1)] : [label, ...body];
    if (l.screen) out.push(`*(looked at your screen: ${l.screen.replace(/\s+/g, ' ').trim()})*`);
    return out.map(x => (x ? `> ${x}` : '>')).join('\n');
  };
}

/** Read a transcript callout (the lines after TRANSCRIPT_HEADER) back into lines. */
export function parseTranscript(block: string, names: Names): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  // Any "**HH:MM Name:**" label starts a message, so notes stay readable after a rename in Settings.
  const label = /^\*\*(\d{1,2}:\d{2}) ([^*]{1,40}):\*\*(?: (.*))?$/;
  for (const raw of block.split(/\r?\n/)) {
    if (!raw.startsWith('>')) break; // the callout ends at the first line without ">"
    const line = raw.replace(/^> ?/, '');
    const m = line.match(label);
    if (m) { out.push({ time: m[1], speaker: m[2] === names.assistant ? 'assistant' : 'user', text: m[3] ?? '' }); continue; }
    const cur = out.at(-1);
    if (!cur) continue;
    const screen = line.match(/^\*\(looked at your screen: (.*)\)\*$/);
    if (screen) { cur.screen = screen[1]; continue; }
    cur.text += `\n${line}`;
  }
  for (const l of out) l.text = l.text.replace(/^\n+/, '').replace(/\n+$/, '');
  return out;
}

// ---------------------------------------------------------------- conversation notes

export interface ConversationNote {
  frontmatter: Frontmatter;
  title: string;
  summary?: string;
  keyPoints?: string[];
  myNotes: string; // whatever Aaron wrote under "## My notes" (kept on every rewrite)
  transcript: string; // the callout, verbatim (header + "> " lines)
}

export const MY_NOTES_HEADING = '## My notes';

export function renderConversationNote(n: ConversationNote): string {
  const parts = [stringifyFrontmatter(n.frontmatter), `# ${n.title}`];
  if (n.summary) parts.push(`## Summary\n${n.summary}`);
  if (n.keyPoints?.length) parts.push(`## Key points\n${n.keyPoints.map(k => `- ${k}`).join('\n')}`);
  parts.push(`${MY_NOTES_HEADING}\n${n.myNotes.trim()}`.trimEnd());
  parts.push(n.transcript.trimEnd());
  return `${parts.join('\n\n')}\n`;
}

export function parseConversationNote(text: string): ConversationNote {
  const { data, body } = parseFrontmatter(text);
  const title = body.match(/^# (.+)$/m)?.[1]?.trim() ?? '';
  const t = body.indexOf(TRANSCRIPT_HEADER);
  const head = t >= 0 ? body.slice(0, t) : body;
  const transcript = t >= 0 ? body.slice(t) : TRANSCRIPT_HEADER;
  const section = (name: string) => head.match(new RegExp(`^## ${name}\\r?\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))?.[1]?.trim();
  const keyPoints = section('Key points')?.split(/\r?\n/).filter(l => /^[-*] /.test(l)).map(l => l.slice(2).trim());
  return { frontmatter: data, title, summary: section('Summary'), keyPoints, myNotes: section('My notes') ?? '', transcript };
}

/** The transcript lines of a conversation note. */
export function transcriptOf(text: string, names: Names): TranscriptLine[] {
  const t = text.indexOf(TRANSCRIPT_HEADER);
  if (t < 0) return [];
  return parseTranscript(text.slice(t + TRANSCRIPT_HEADER.length).replace(/^\r?\n/, ''), names);
}

// ---------------------------------------------------------------- tags

/** Tags written in the body (#tag, #nested/tag), ignoring headings and code. */
export function inlineTags(body: string): string[] {
  const noCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  return [...noCode.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)].map(m => m[1]);
}

/** Frontmatter tags as a list, whichever way they were written. */
export function frontmatterTags(data: Frontmatter): string[] {
  const t = data.tags ?? data.tag;
  const list = Array.isArray(t) ? t : typeof t === 'string' ? t.split(/[,\s]+/) : [];
  return list.map(x => x.replace(/^#/, '').trim()).filter(Boolean);
}

/** A tag in Obsidian's form: lowercase words joined by hyphens, nesting kept. */
export function normaliseTag(tag: string): string {
  return tag.replace(/^#/, '').trim().toLowerCase().replace(/[^\p{L}\p{N}/_-]+/gu, '-').replace(/^-+|-+$/g, '');
}
