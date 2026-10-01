import { appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

// A small app log (data/ghost.log) for things that are otherwise invisible: the overlay's drawing
// process dying, a stray attempt to close it, a lost 3D context. Kept under ~1 MB.
let file: string | null = null;

export function initLog(path: string): void {
  file = path;
  try {
    mkdirSync(dirname(path), { recursive: true });
    if (statSync(path).size > 1_000_000) renameSync(path, `${path}.old`);
  } catch { /* new log */ }
}

export function log(event: string, detail: unknown = ''): void {
  if (!file) return;
  try { appendFileSync(file, `${new Date().toISOString()} ${event}${detail === '' ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}\n`); } catch { /* best effort */ }
}
