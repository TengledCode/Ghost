/**
 * True idle: not busy, not under the cursor, nothing has happened for `holdMs`, and (when given) the
 * cursor left Ghost more than `hoverHoldMs` ago. Just hovering is a lighter touch than typing or
 * talking, so it gets its own, shorter hold.
 */
export function isIdle(o: { busy: boolean; hovering: boolean; quietMs: number; holdMs: number; hoverQuietMs?: number; hoverHoldMs?: number }): boolean {
  return !o.busy && !o.hovering && o.quietMs > o.holdMs && (o.hoverQuietMs ?? Infinity) > (o.hoverHoldMs ?? 0);
}
