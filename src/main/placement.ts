import type { Corner } from '../shared/settings';

export interface Rect { x: number; y: number; width: number; height: number }

/** Space kept around the shell so unfolded shards and their glow are never clipped by the window. */
export const SHELL_PAD = 0.3;

/** Overlay window size: the padded shell plus room for the reply bubble and the input bar. */
export function windowSize(shell: number): { width: number; height: number } {
  const padded = Math.round(shell * (1 + SHELL_PAD * 2));
  // Wide enough for the 360 px chat stack beside the shell's glow margin.
  return { width: Math.max(padded + 16, 376 + Math.round(shell * SHELL_PAD)), height: padded + 290 };
}

// ---------------------------------------------------------------- snapping by the shell itself

/** How close (px) the shell must come to a screen edge to stick to it, and the gap it keeps. */
export const EDGE_SNAP = 48;
export const EDGE_MARGIN = 12;

export interface Snapped { x: number; y: number; corner: Corner | null }

/**
 * Given a proposed window position, snap the *shell* (its rect inside the window) to any screen
 * edge it is near, and clamp it so the whole shell stays on-screen. The window's transparent
 * padding is allowed to hang off-screen. Returns the window position to use.
 */
export function snapShell(win: { x: number; y: number }, shell: Rect, work: Rect): Snapped {
  let sx = win.x + shell.x;
  let sy = win.y + shell.y;
  const minX = work.x + EDGE_MARGIN, maxX = work.x + work.width - shell.width - EDGE_MARGIN;
  const minY = work.y + EDGE_MARGIN, maxY = work.y + work.height - shell.height - EDGE_MARGIN;
  let h: 'left' | 'right' | null = null, v: 'top' | 'bottom' | null = null;
  if (sx - minX < EDGE_SNAP) { sx = minX; h = 'left'; } else if (maxX - sx < EDGE_SNAP) { sx = maxX; h = 'right'; }
  if (sy - minY < EDGE_SNAP) { sy = minY; v = 'top'; } else if (maxY - sy < EDGE_SNAP) { sy = maxY; v = 'bottom'; }
  sx = Math.min(Math.max(sx, minX), Math.max(minX, maxX));
  sy = Math.min(Math.max(sy, minY), Math.max(minY, maxY));
  return { x: Math.round(sx - shell.x), y: Math.round(sy - shell.y), corner: h && v ? (`${v}-${h}` as Corner) : null };
}

/** Window position that puts the shell snugly in a corner of the work area. */
export function cornerWindowPosition(corner: Corner, shell: Rect, work: Rect): { x: number; y: number } {
  const sx = corner.endsWith('left') ? work.x + EDGE_MARGIN : work.x + work.width - shell.width - EDGE_MARGIN;
  const sy = corner.startsWith('top') ? work.y + EDGE_MARGIN : work.y + work.height - shell.height - EDGE_MARGIN;
  return { x: Math.round(sx - shell.x), y: Math.round(sy - shell.y) };
}

/** Which way the UI stack should grow for a shell at this screen position: towards the screen centre. */
export function orientationForShell(shellAbs: Rect, work: Rect): Corner {
  const cx = shellAbs.x + shellAbs.width / 2, cy = shellAbs.y + shellAbs.height / 2;
  return `${cy < work.y + work.height / 2 ? 'top' : 'bottom'}-${cx < work.x + work.width / 2 ? 'left' : 'right'}` as Corner;
}
