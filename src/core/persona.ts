import { readFileSync } from 'node:fs';
import type { Settings } from '../shared/settings';

const FALLBACK = `You are {{assistant}}, {{user}}'s personal companion.`;

/** Stable persona. The Claude CLI records the system prompt when the session starts, so keep per-turn data out of it. */
export function buildPersona(personaPath: string, s: Pick<Settings, 'assistantName' | 'userName'> & { obsidian?: Settings['obsidian'] }): string {
  let template = FALLBACK;
  try { template = readFileSync(personaPath, 'utf8'); } catch { /* use fallback */ }
  if (s.obsidian?.vaultPath) template += OBSIDIAN_SECTION(s.obsidian);
  return template.replaceAll('{{assistant}}', s.assistantName).replaceAll('{{user}}', s.userName);
}

/** Only when an Obsidian vault is connected (Settings → Obsidian). */
const OBSIDIAN_SECTION = (o: Settings['obsidian']) => `

## Obsidian

- {{user}} keeps his notes in Obsidian, and your conversations and memory are saved there too (in the "${o.folder}" folder). \`recall\` searches them.
${o.readVault ? `- For questions about his own notes, projects or plans, search his vault with \`vault_search\` and read notes with \`vault_read\`. Mention which note you found something in.
` : ''}${o.writeVault ? `- You can add to or create notes with \`vault_write\` when he asks ("add this to my Ideas note"). He confirms each write, so say what you'll write. Prefer appending to existing notes.
` : ''}- When you looked at a screenshot to answer, end your reply with a brief description of what was on the screen in a <screen>…</screen> tag, e.g. <screen>VS Code, a TypeScript error in main.ts</screen>. It is saved in the transcript, never shown or spoken.
`;

/** Per-turn context goes in the user message: current time, relevant memories. */
export function buildTurnPrompt(
  message: string,
  opts: { now: Date; memories: string[]; userName: string; screen?: { path: string } | { error: string } },
): string {
  const lines = [`<context>`, `Local time: ${opts.now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })} (ISO ${opts.now.toISOString()})`];
  if (opts.screen && 'path' in opts.screen) {
    lines.push(`${opts.userName}'s screen right now (a snapshot of the monitor under his cursor, taken as he sent this): ${opts.screen.path}. Look at it with Ghost's read_file tool if it is relevant to what he asks.`);
  } else if (opts.screen) {
    lines.push(`Live screen view is on, but the screen could not be captured this time (${opts.screen.error}).`);
  }
  if (opts.memories.length) {
    lines.push(`Things you remember about ${opts.userName}:`);
    for (const m of opts.memories) lines.push(`- ${m}`);
  }
  lines.push(`</context>`, '', message);
  return lines.join('\n');
}
