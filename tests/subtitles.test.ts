import { describe, expect, it } from 'vitest';
import { NO_AUDIO_GRACE, SPOKEN_CHARS_PER_SECOND, Subtitles } from '../src/renderer/overlay/subtitles';

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

  it('reveals a sentence whose voice failed word by word, at speaking pace, even after the voice finished', () => {
    const { subs, at } = setup();
    const text = 'This sentence lost its voice somewhere. '; // 40 characters: about 2.7 s at 15 a second
    subs.add('t1', 0, text, false, true);
    subs.revealAll('t1', false); // the player had nothing to play, so it finished at once
    const early = at(100.5);
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(text.length);
    expect(at(100 + text.trim().length / SPOKEN_CHARS_PER_SECOND + 0.1)).toBe(text);
    subs.revealAll('t1'); // Esc: everything at once
    expect(at(100.1)).toBe(text);
  });

  it('safety net: reveals the whole reply silently, and starts again in step when the voice comes', () => {
    const { subs, at, shown } = setup();
    subs.showSilently('t1', 'Hello there, Aaron. How are you today? ');
    const mid = at(101);
    expect(mid.length).toBeGreaterThan(0);
    expect(mid).not.toBe('Hello there, Aaron. How are you today? ');
    subs.add('t1', 0, 'Late. ', false, true); // a later sentence still without voice: no restart
    expect(at(101.1).startsWith('Hello')).toBe(true);
    subs.add('t1', 0, 'Hello there, Aaron. ', true); // the voice arrives
    const before = shown.length;
    expect(at(101.2)).toBe(''); // waiting for its first word (the bubble keeps what it showed)
    expect(shown.length).toBe(before);
    subs.started('t1', 0, 101.3, 1);
    expect(at(101.5).length).toBeGreaterThan(0);
    expect(at(102.4)).toBe('Hello there, Aaron. ');
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

import { chunkStart, PREROLL, WAKE_TIME } from '../src/renderer/overlay/audio/player';
import { isIdle } from '../src/renderer/overlay/idle';

describe('chunk scheduling (no clipped first words)', () => {
  it('leaves the device time to wake after a silence, and plays back-to-back sentences gaplessly', () => {
    expect(chunkStart(100, 0, 90, false)).toBeCloseTo(100 + PREROLL); // 10 s of silence
    expect(chunkStart(100, 0, 99.5, false)).toBeCloseTo(100.03); // just finished talking: no pre-roll
    expect(chunkStart(100, 101.7, 99, true)).toBe(101.7); // mid-reply: starts exactly when the last ends
  });

  it('waits for a sleeping Bluetooth device to wake, unless the keep-alive has already woken it', () => {
    expect(chunkStart(100, 0, 90, false, 0)).toBeCloseTo(100 + WAKE_TIME); // cold: keep-alive only just started
    expect(chunkStart(100, 0, 90, false, 0.5)).toBeCloseTo(100 + WAKE_TIME - 0.5);
    expect(chunkStart(100, 0, 90, false, 5)).toBeCloseTo(100 + PREROLL); // warm since "thinking" began
    expect(chunkStart(100, 0, 99.5, false, 0)).toBeCloseTo(100.03); // just finished talking: still awake
    expect(chunkStart(100, 101.7, 90, true, 0)).toBe(101.7); // mid-reply: gapless
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
  it('fades sooner after only a hover than after typing or a reply', () => {
    const hover = { busy: false, hovering: false, quietMs: 60_000, holdMs: 6000, hoverHoldMs: 2000 };
    expect(isIdle({ ...hover, hoverQuietMs: 1000 })).toBe(false); // just left Ghost
    expect(isIdle({ ...hover, hoverQuietMs: 2500 })).toBe(true); // 2.5 s later: faded
    expect(isIdle({ ...hover, quietMs: 3000, hoverQuietMs: 2500 })).toBe(false); // typed 3 s ago: still the 6 s hold
  });
});

import { attentionPoint, relativeTo } from '../src/renderer/overlay/attention';

describe("where Ghost's attention goes", () => {
  const box = (left: number, top: number) => ({ left, top, width: 20, height: 10 });
  it('prefers the Allow button, then the caret, then a brief glance; never a fixed direction', () => {
    const now = 1000;
    expect(attentionPoint({ approve: box(0, 300), caret: { x: 5, y: 5 }, glance: null, now })).toEqual({ x: 10, y: 305 });
    expect(attentionPoint({ approve: null, caret: { x: 5, y: 5 }, glance: { box: box(0, 0), until: 2000 }, now })).toEqual({ x: 5, y: 5 });
    expect(attentionPoint({ approve: null, caret: null, glance: { box: box(0, 0), until: 2000 }, now })).toEqual({ x: 10, y: 5 });
    expect(attentionPoint({ approve: null, caret: null, glance: { box: box(0, 0), until: 900 }, now })).toBeNull(); // glance over
    expect(attentionPoint({ approve: null, caret: null, glance: null, now })).toBeNull();
    expect(relativeTo({ x: 10, y: 305 }, { left: 0, top: 0, width: 100, height: 100 })).toEqual({ dx: -40, dy: 255 });
  });
});
