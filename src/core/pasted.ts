import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PastedImage } from '../shared/protocol';

// Pictures Aaron pastes into Ghost's text box (a screenshot from the clipboard, as in the Claude
// app). A pasted picture isn't a file, and the brains look at pictures through read_file, so each
// one is saved in Ghost's working folder (a safe folder: no confirm card) and named in the message's
// context. They aren't needed afterwards (Aaron, 15 Nov): the folder is emptied when Ghost starts and
// when it closes, and holds at most the newest few in between.

export const MAX_PASTED = 4; // pictures in one message
const MAX_BYTES = 12_000_000; // each
const KEEP = 20; // on disk
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };

/** Removes every pasted picture (Ghost starting or closing). */
export function clearPastedImages(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* in use: the next start clears it */ }
}

/** Saves the pictures that are really pictures (a known type, not too big) and returns their paths. */
export function savePastedImages(dir: string, images: unknown, now = new Date()): string[] {
  if (!Array.isArray(images)) return [];
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const paths: string[] = [];
  for (const image of images.slice(0, MAX_PASTED) as Partial<PastedImage>[]) {
    const ext = TYPES[String(image?.mime)];
    if (!ext || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(image.data)) continue;
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES) continue;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `pasted-${stamp}-${paths.length + 1}.${ext}`);
    writeFileSync(path, bytes);
    paths.push(path);
  }
  if (paths.length) {
    const old = readdirSync(dir).filter(f => /^pasted-.*\.(png|jpg|webp|gif|bmp)$/.test(f)).sort().slice(0, -KEEP);
    for (const f of old) rmSync(join(dir, f), { force: true });
  }
  return paths;
}
