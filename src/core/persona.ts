import { readFileSync } from 'node:fs';
import type { Settings } from '../shared/settings';

const FALLBACK = `You are {{assistant}}, {{user}}'s personal companion.`;

/** Stable persona. The Claude CLI records the system prompt when the session starts, so keep per-turn data out of it. */
export function buildPersona(personaPath: string, s: Pick<Settings, 'assistantName' | 'userName'>): string {
  let template = FALLBACK;
  try { template = readFileSync(personaPath, 'utf8'); } catch { /* use fallback */ }
  return template.replaceAll('{{assistant}}', s.assistantName).replaceAll('{{user}}', s.userName);
}

/** Per-turn context goes in the user message: current time, relevant memories. */
export function buildTurnPrompt(
  message: string,
  opts: { now: Date; memories: string[]; userName: string; screen?: { path: string } | { error: string } },
): string {
  const lines = [`<context>`, `Local time: ${opts.now.toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })} (ISO ${opts.now.toISOString()})`];
  if (opts.screen && 'path' in opts.screen) {
    lines.push(`${opts.userName}'s screen right now (a snapshot of the monitor under his cursor, taken as he sent this): ${opts.screen.path}. Open that image file (your file-reading tool can view images) if it is relevant to what he asks.`);
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
