import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, isAbsolute } from 'node:path';

// The screenshots and recordings Ghost saved, as the bubble's Open / Show in folder buttons and
// "show my last screenshot" use them. The overlay hands back a path, so it's checked here: only a
// picture or video inside Ghost's own two folders is ever opened.

export const SCREENSHOT_TYPES = ['.png'];
export const RECORDING_TYPES = ['.mp4', '.webm'];

/** Whether `path` is a screenshot or recording file inside one of `dirs` (not a folder, not elsewhere). */
export function isCaptureFile(path: unknown, dirs: string[]): path is string {
  if (typeof path !== 'string' || !path) return false;
  const full = resolve(path);
  if (![...SCREENSHOT_TYPES, ...RECORDING_TYPES].includes(extname(full).toLowerCase())) return false;
  const inside = dirs.some(dir => {
    const rel = relative(resolve(dir), full);
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  });
  try { return inside && statSync(full).isFile(); } catch { return false; }
}

/** The newest file of these types directly in `dir`, by when it was last written. */
export function latestCapture(dir: string, types: string[]): { path: string; at: number } | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; at: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!types.includes(extname(name).toLowerCase())) continue;
    const path = join(dir, name);
    try {
      const s = statSync(path);
      if (s.isFile() && s.size > 0 && (!best || s.mtimeMs > best.at)) best = { path, at: s.mtimeMs };
    } catch { /* gone meanwhile */ }
  }
  return best;
}
