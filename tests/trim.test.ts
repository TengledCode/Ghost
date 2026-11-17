import { describe, expect, it } from 'vitest';
import { KEEP_AFTER, KEEP_BEFORE, pauseAfter, speechBounds } from '../src/renderer/overlay/audio/trim';

const RATE = 24000;
/** A recording: `lead` s of silence, `speech` s of a tone, `tail` s of silence (with a little hiss). */
function recording(lead: number, speech: number, tail: number): Float32Array {
  const n = Math.round((lead + speech + tail) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const hiss = (((i * 7919) % 101) / 101 - 0.5) * 0.002; // well under the silence level
    out[i] = hiss + (t >= lead && t < lead + speech ? 0.3 * Math.sin(2 * Math.PI * 220 * t) : 0);
  }
  return out;
}

describe('trimming the silence voice services pad recordings with', () => {
  it('keeps only the speech, with a little room either side', () => {
    const { start, end } = speechBounds([recording(0.25, 1.2, 0.6)], RATE);
    expect(start).toBeCloseTo(0.25 - KEEP_BEFORE, 1);
    expect(end).toBeCloseTo(0.25 + 1.2 + KEEP_AFTER, 1);
    expect(start).toBeLessThanOrEqual(0.25 - KEEP_BEFORE + 0.011);
    expect(end).toBeGreaterThanOrEqual(0.25 + 1.2 + KEEP_AFTER - 0.011);
  });

  it('leaves a recording with no padding, or no speech, as it is', () => {
    expect(speechBounds([recording(0, 1, 0)], RATE)).toEqual({ start: 0, end: 1 });
    expect(speechBounds([recording(0.5, 0, 0.5)], RATE)).toEqual({ start: 0, end: 1 });
    expect(speechBounds([new Float32Array(0)], RATE)).toEqual({ start: 0, end: 0 });
  });

  it('pauses briefly after a comma, longer after a sentence or a paragraph', () => {
    expect(pauseAfter('Very good, ')).toBeLessThan(pauseAfter('Very good. '));
    expect(pauseAfter('Very good. ')).toBeLessThan(pauseAfter('Very good.\n\n'));
    expect(pauseAfter(undefined)).toBe(pauseAfter('Done. '));
  });
});
