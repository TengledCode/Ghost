import { describe, expect, it } from 'vitest';
import { NO_AUDIO_GRACE, Subtitles } from '../src/renderer/overlay/subtitles';

function setup() {
  let t = 100;
  const shown: string[] = [];
  const subs = new Subtitles(text => shown.push(text), () => t);
  return { subs, shown, at: (s: number) => { t = s; subs.tick(); return subs.visibleText(); } };
}

describe('Subtitles (text in step with the voice)', () => {
  it('shows nothing until the audio starts, then reveals words across its duration', () => {
    const { subs, at } = setup();
    subs.add('t1', 0, 'Very good, Aaron. ', true); // text and audio are ready, but playback hasn't begun
    expect(at(100.5)).toBe('');
    subs.started('t1', 0, 101, 1.0);
    expect(at(100.9)).toBe('');
    const mid = at(101.45);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid.length).toBeLessThan('Very good, Aaron. '.length);
    expect(at(102)).toBe('Very good, Aaron. ');
  });

  it('keeps sentence order and waits for each sentence to be spoken', () => {
    const { subs, at } = setup();
    subs.add('t1', 1, 'Second sentence. ', true); // arrives first but must wait for seq 0
    expect(at(100.2)).toBe('');
    subs.add('t1', 0, 'First sentence. ', true);
    subs.started('t1', 0, 100.3, 1);
    subs.started('t1', 1, 101.3, 1);
    expect(at(101)).toMatch(/^First/);
    expect(at(101)).not.toContain('Second');
    expect(at(102.4)).toBe('First sentence. Second sentence. ');
  });

  it('shows a segment with nothing to say (code) right after the sentence before it', () => {
    const { subs, at } = setup();
    subs.add('t1', 0, 'Here it is.\n\n', true);
    subs.add('t1', 1, '```\nx = 1\n```\n\n', false);
    subs.started('t1', 0, 100.1, 1);
    expect(at(100.5)).not.toContain('x = 1');
    expect(at(101.2)).toContain('x = 1');
  });

  it('falls back to showing text when its audio never comes', () => {
    const { subs, at } = setup();
    subs.add('t1', 0, 'Voice is down. ', true);
    expect(at(100 + NO_AUDIO_GRACE - 0.1)).toBe('');
    expect(at(100 + NO_AUDIO_GRACE + 0.1)).toBe('Voice is down. ');
  });

  it('reveals everything on finish or cancel, and resets for the next reply', () => {
    const { subs, at } = setup();
    subs.add('t1', 0, 'One. ', true);
    subs.add('t1', 1, 'Two. ', true);
    subs.revealAll('t1');
    expect(at(100)).toBe('One. Two. ');
    subs.add('t2', 0, 'Next reply. ', true);
    expect(at(100.1)).toBe('');
  });
});

import { chunkStart, PREROLL } from '../src/renderer/overlay/audio/player';
import { isIdle } from '../src/renderer/overlay/idle';

describe('chunk scheduling (no clipped first words)', () => {
  it('leaves the device time to wake after a silence, and plays back-to-back sentences gaplessly', () => {
    expect(chunkStart(100, 0, 90, false)).toBeCloseTo(100 + PREROLL); // 10 s of silence
    expect(chunkStart(100, 0, 99.5, false)).toBeCloseTo(100.03); // just finished talking: no pre-roll
    expect(chunkStart(100, 101.7, 99, true)).toBe(101.7); // mid-reply: starts exactly when the last ends
  });
});

describe('true idle', () => {
  it('is idle only when not busy, not hovered and quiet long enough', () => {
    const base = { busy: false, hovering: false, quietMs: 7000, holdMs: 6000 };
    expect(isIdle(base)).toBe(true);
    expect(isIdle({ ...base, busy: true })).toBe(false);
    expect(isIdle({ ...base, hovering: true })).toBe(false);
    expect(isIdle({ ...base, quietMs: 2000 })).toBe(false);
  });
});
