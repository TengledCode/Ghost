/** True idle: not busy, not under the cursor, and nothing has happened for `holdMs`. */
export function isIdle(o: { busy: boolean; hovering: boolean; quietMs: number; holdMs: number }): boolean {
  return !o.busy && !o.hovering && o.quietMs > o.holdMs;
}
