import type { ObsidianVault } from './vault';

// Ghost adds its lines to the Daily Note the way Obsidian's own Daily Notes plugin would find it:
// the folder, date format and template come from <vault>/.obsidian/daily-notes.json.

export interface DailyNoteConfig { enabled: boolean; folder: string; format: string; template: string }

export function dailyNoteConfig(vault: ObsidianVault): DailyNoteConfig {
  const json = <T>(rel: string): T | null => { try { return JSON.parse(vault.read(rel) ?? 'null'); } catch { return null; } };
  const plugins = json<string[] | Record<string, boolean>>('.obsidian/core-plugins.json');
  // Older Obsidian: a list of enabled plugin ids. Newer: { id: enabled }. No file: defaults (on).
  const enabled = !plugins ? true : Array.isArray(plugins) ? plugins.includes('daily-notes') : plugins['daily-notes'] !== false;
  const cfg = json<{ folder?: string; format?: string; template?: string }>('.obsidian/daily-notes.json') ?? {};
  return { enabled, folder: (cfg.folder ?? '').replace(/^\/+|\/+$/g, ''), format: cfg.format || 'YYYY-MM-DD', template: cfg.template ?? '' };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The subset of moment.js formatting Daily Notes users actually use. */
export function formatMoment(d: Date, format: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
  return format.replace(/\[([^\]]*)]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|HH|H|mm|ww|w/g, (tok, literal) => {
    if (literal !== undefined) return literal;
    switch (tok) {
      case 'YYYY': return String(d.getFullYear());
      case 'YY': return String(d.getFullYear()).slice(-2);
      case 'MMMM': return MONTHS[d.getMonth()];
      case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
      case 'MM': return pad(d.getMonth() + 1);
      case 'M': return String(d.getMonth() + 1);
      case 'Do': return ordinal(d.getDate());
      case 'DD': return pad(d.getDate());
      case 'D': return String(d.getDate());
      case 'dddd': return DAYS[d.getDay()];
      case 'ddd': return DAYS[d.getDay()].slice(0, 3);
      case 'dd': return DAYS[d.getDay()].slice(0, 2);
      case 'HH': return pad(d.getHours());
      case 'H': return String(d.getHours());
      case 'mm': return pad(d.getMinutes());
      case 'ww': return pad(isoWeek(d));
      case 'w': return String(isoWeek(d));
      default: return tok;
    }
  });
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

export function dailyNotePath(cfg: DailyNoteConfig, d: Date): string {
  const name = `${formatMoment(d, cfg.format)}.md`;
  return cfg.folder ? `${cfg.folder}/${name}` : name;
}

/**
 * Add a line under the "## Ghost" heading of that day's note, creating the heading (or the note,
 * from the Daily Notes template) if needed. Does nothing if the Daily Notes plugin is switched off.
 * Returns the note's path, or null when skipped.
 */
export function addToDailyNote(vault: ObsidianVault, d: Date, line: string, heading = 'Ghost'): string | null {
  const cfg = dailyNoteConfig(vault);
  if (!cfg.enabled) return null;
  const rel = dailyNotePath(cfg, d);
  let text = vault.read(rel);
  if (text === null) text = fromTemplate(vault, cfg, d);
  if (text.includes(line)) return rel; // already there (e.g. an import re-run)
  vault.write(rel, insertUnderHeading(text, heading, line));
  return rel;
}

function fromTemplate(vault: ObsidianVault, cfg: DailyNoteConfig, d: Date): string {
  if (!cfg.template) return '';
  const t = vault.read(cfg.template.endsWith('.md') ? cfg.template : `${cfg.template}.md`) ?? '';
  return t
    .replace(/\{\{date(?::([^}]+))?}}/g, (_m, f) => formatMoment(d, f ?? cfg.format))
    .replace(/\{\{time(?::([^}]+))?}}/g, (_m, f) => formatMoment(d, f ?? 'HH:mm'))
    .replace(/\{\{title}}/g, formatMoment(d, cfg.format));
}

/** Append `line` at the end of the `## heading` section, or add the section at the end of the note. */
export function insertUnderHeading(text: string, heading: string, line: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.trim() === `## ${heading}`);
  if (at < 0) {
    const base = text.replace(/\s+$/, '');
    return `${base}${base ? '\n\n' : ''}## ${heading}\n${line}\n`;
  }
  let end = at + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end])) end++;
  while (end > at + 1 && lines[end - 1].trim() === '') end--; // insert after the last entry, before blank lines
  lines.splice(end, 0, line);
  return lines.join('\n');
}
