import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Where Ghost may read files without asking. A model that has been tricked (by a web page, a note or
// something on screen) could otherwise read a private file and send it out with a web fetch, so
// reading anywhere else shows a confirm card first.

const isWin = process.platform === 'win32';

/** Ghost's own folders, the Obsidian vault, and the everyday places: Desktop, Documents, Downloads. */
export function safeReadRoots(o: { ghostDirs: string[]; vault?: string | null; home?: string }): string[] {
  const home = o.home ?? homedir();
  return [...o.ghostDirs, ...(o.vault ? [o.vault] : []), join(home, 'Desktop'), join(home, 'Documents'), join(home, 'Downloads')];
}

/** The real, absolute form of a path (symlinks and `..` resolved), for comparing locations. */
export function canonical(path: string): string {
  let full = resolve(path);
  try { full = realpathSync.native(full); } catch { /* doesn't exist (yet): compare the resolved path */ }
  return isWin ? full.toLowerCase() : full;
}

/** True when `path` is inside one of `roots`. UNC paths (\\server\share) never are. */
export function isInside(path: string, roots: string[]): boolean {
  if (!path || /^\\\\|^\/\//.test(path.trim())) return false;
  const target = canonical(path.trim());
  return roots.some(r => {
    const root = canonical(r);
    return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}
