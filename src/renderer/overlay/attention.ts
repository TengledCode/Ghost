// Where Ghost looks, decided from what is actually on screen (measured every frame), never from a
// fixed direction: the UI can sit above, below or beside him depending on the corner, so any
// hard-coded "look up" is wrong somewhere. In order of importance:
//   1. a confirm card is open → the Allow button (he's waiting for your answer)
//   2. you're typing          → the caret, following the words
//   3. something just appeared (a reminder, a notice) → a brief glance at it
// Otherwise nothing: the shell follows the cursor or idles on its own.

export interface Point { x: number; y: number }
export interface Box { left: number; top: number; width: number; height: number }

export interface AttentionInputs {
  approve: Box | null; // the confirm card's Allow button, when the card is visible
  caret: Point | null; // the text caret, while the input is focused
  glance: { box: Box; until: number } | null; // something that just appeared, briefly
  now: number; // ms
}

export const GLANCE_MS = 1600;

export function attentionPoint(i: AttentionInputs): Point | null {
  if (i.approve) return centre(i.approve);
  if (i.caret) return i.caret;
  if (i.glance && i.now < i.glance.until) return centre(i.glance.box);
  return null;
}

export function centre(b: Box): Point { return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }

/** A point relative to the shell's centre, as the shell's gaze expects it. */
export function relativeTo(p: Point, shell: Box): { dx: number; dy: number } {
  const c = centre(shell);
  return { dx: p.x - c.x, dy: p.y - c.y };
}
