// Voice services pad every recording with silence at both ends. Ghost speaks a reply as several
// recordings played back to back, so each join got two lots of padding: pauses at the first comma
// and between sentences sounded too long. The player plays only the speech in each recording and
// puts a natural pause of its own between them (pauseAfter), the same for every voice service.

/** Below this level (about -48 dBFS) a 10 ms block counts as silence. */
export const SILENCE_LEVEL = 0.004;
const BLOCK = 0.01;
/** Kept around the speech so soft first and last sounds ("h", "s", a fading vowel) aren't cut. */
export const KEEP_BEFORE = 0.03;
export const KEEP_AFTER = 0.08;

/**
 * Where the speech is in a recording, in seconds: from its first to its last block above the
 * silence level, plus a little either side. The whole recording if it seems to hold no speech.
 */
export function speechBounds(channels: Float32Array[], sampleRate: number): { start: number; end: number } {
  const length = channels[0]?.length ?? 0;
  const whole = { start: 0, end: length / sampleRate };
  const block = Math.max(1, Math.round(BLOCK * sampleRate));
  const loud = (from: number) => {
    const to = Math.min(length, from + block);
    let sum = 0;
    for (const ch of channels) for (let i = from; i < to; i++) sum += ch[i] * ch[i];
    return Math.sqrt(sum / ((to - from) * channels.length)) > SILENCE_LEVEL;
  };
  let first = -1;
  for (let i = 0; i < length; i += block) if (loud(i)) { first = i; break; }
  if (first < 0) return whole;
  let last = first;
  for (let i = Math.floor((length - 1) / block) * block; i > first; i -= block) if (loud(i)) { last = i; break; }
  const start = Math.max(0, first / sampleRate - KEEP_BEFORE);
  const end = Math.min(whole.end, Math.min(length, last + block) / sampleRate + KEEP_AFTER);
  return end - start < 0.1 ? whole : { start, end };
}

/** The pause after a piece of the reply, by how it ends: a comma is short, a paragraph longer. */
export function pauseAfter(display: string | undefined): number {
  const text = display ?? '';
  if (/\n\s*\n\s*$/.test(text)) return 0.45;
  const end = text.trimEnd();
  if (/[,;:—–-]$/.test(end)) return 0.12;
  return 0.3; // the end of a sentence
}
