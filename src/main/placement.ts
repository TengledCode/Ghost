import type { Corner } from '../shared/settings';

export interface Rect { x: number; y: number; width: number; height: number }

export const MARGIN = 4; // the shell already sits inside its own glow margin (SHELL_PAD)
export const SNAP_DISTANCE = 96;

/** Space kept around the shell so unfolded shards and their glow are never clipped by the window. */
export const SHELL_PAD = 0.3;

/** Overlay window size: the padded shell plus room for the reply bubble and the input bar. */
export function windowSize(shell: number): { width: number; height: number } {
  const padded = Math.round(shell * (1 + SHELL_PAD * 2));
  return { width: Math.max(padded + 16, 380), height: padded + 290 };
}

export function cornerPosition(corner: Corner, work: Rect, size: { width: number; height: number }): { x: number; y: number } {
  const left = work.x + MARGIN;
  const right = work.x + work.width - size.width - MARGIN;
  const top = work.y + MARGIN;
  const bottom = work.y + work.height - size.height - MARGIN;
  return {
    x: corner.endsWith('left') ? left : right,
    y: corner.startsWith('top') ? top : bottom,
  };
}

/** Nearest corner for a window at (x, y), and whether it is close enough to snap. */
export function nearestCorner(x: number, y: number, work: Rect, size: { width: number; height: number }): { corner: Corner; snap: boolean } {
  let best: { corner: Corner; d: number } = { corner: 'bottom-right', d: Infinity };
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as Corner[]) {
    const p = cornerPosition(corner, work, size);
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < best.d) best = { corner, d };
  }
  return { corner: best.corner, snap: best.d <= SNAP_DISTANCE };
}

/** Which way the UI stack should grow for a free position: towards the centre of the screen. */
export function orientationFor(x: number, y: number, work: Rect, size: { width: number; height: number }): Corner {
  const cx = x + size.width / 2;
  const cy = y + size.height / 2;
  const h = cx < work.x + work.width / 2 ? 'left' : 'right';
  const v = cy < work.y + work.height / 2 ? 'top' : 'bottom';
  return `${v}-${h}` as Corner;
}
