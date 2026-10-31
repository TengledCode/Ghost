import { describe, expect, it } from 'vitest';
import { geminiFamilies, parseGemini, pickGemini, suggestTopFamily, topGeminiFamily } from '../src/core/models';

// What `agy models` offered Aaron on 31 Oct 2026 (Gemini 4 Argon out, no Pro any more).
const NOW = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low', 'claude-opus-5-5-low', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium'];
const WITH_CARBON = ['gemini-4-carbon-medium', 'gemini-4-carbon-high', ...NOW];

describe('Gemini model ids', () => {
  it('reads generation, family and effort, and skips non-chat models', () => {
    expect(parseGemini('gemini-4-argon-high')).toEqual({ id: 'gemini-4-argon-high', version: 4, family: 'argon', effort: 'high' });
    expect(parseGemini('gemini-3.8-flash-medium')?.family).toBe('flash');
    expect(parseGemini('gemini-3.8-flash-lite-low')).toBeNull();
    expect(parseGemini('claude-opus-5-5-low')).toBeNull();
    expect(geminiFamilies(NOW)).toEqual([{ family: 'argon', version: 4 }, { family: 'flash', version: 3.8 }]);
  });
});

describe('matching Gemini slots to Claude (Light ≈ Haiku, Balanced ≈ Sonnet, Heavy ≈ Opus)', () => {
  it('uses Flash for Light and the strongest family (Argon) for Balanced and Heavy', () => {
    expect(pickGemini(NOW, 'flash')).toBe('gemini-3.8-flash-medium');
    expect(pickGemini(NOW, 'top-medium')).toBe('gemini-4-argon-medium');
    expect(pickGemini(NOW, 'top-high')).toBe('gemini-4-argon-high');
    expect(pickGemini(NOW, 'pro')).toBe('gemini-4-argon-high'); // the old Heavy setting
    expect(pickGemini(NOW, 'gemini-3.8-flash-low')).toBe('gemini-3.8-flash-low'); // a model Aaron picked by name
  });
  it('moves up to a newer generation on its own', () => {
    const next = ['gemini-5-neon-high', 'gemini-5-neon-medium', 'gemini-3.9-flash-medium', ...NOW];
    expect(topGeminiFamily(next, 'argon')).toBe('neon');
    expect(pickGemini(next, 'top-high', 'argon')).toBe('gemini-5-neon-high');
    expect(pickGemini(next, 'flash')).toBe('gemini-3.9-flash-medium');
  });
  it('keeps Aaron\'s family in the same generation, and offers a new one instead of guessing', () => {
    expect(topGeminiFamily(WITH_CARBON, 'argon')).toBe('argon');
    expect(suggestTopFamily(WITH_CARBON, ['argon', 'flash'], [], 'argon')).toBe('carbon');
    expect(suggestTopFamily(WITH_CARBON, ['argon', 'flash'], ['carbon'], 'argon')).toBeNull(); // "Not now"
    expect(suggestTopFamily(WITH_CARBON, ['argon', 'flash', 'carbon'], [], 'argon')).toBeNull(); // already known
    expect(pickGemini(WITH_CARBON, 'top-high', 'carbon')).toBe('gemini-4-carbon-high'); // after "Use it"
  });
  it('picks nothing when nothing fits, so agy falls back to its default', () => {
    expect(pickGemini(['claude-opus-5-5-low'], 'top-high')).toBe('');
  });
});

import { EMPTY_WATCH, watchModels } from '../src/core/models';

describe('keeping up with new Gemini models', () => {
  const slots = { fast: 'flash', balanced: 'top-medium', deep: 'top-high' };

  it('settles on Argon at the first look, without any notices', () => {
    const r = watchModels(NOW, EMPTY_WATCH, slots, '');
    expect(r.pinTop).toBe('argon');
    expect(r.notices).toEqual([]);
    expect(r.state.inUse).toEqual({ fast: 'gemini-3.8-flash-medium', balanced: 'gemini-4-argon-medium', deep: 'gemini-4-argon-high' });
  });

  it('offers Carbon once when it appears, and keeps offering it (the gear dot) until answered', () => {
    const before = watchModels(NOW, EMPTY_WATCH, slots, '').state;
    const r = watchModels(WITH_CARBON, before, slots, 'argon');
    expect(r.state.suggestion).toBe('carbon');
    expect(r.notices).toEqual([{ level: 'warn', text: 'Gemini 4 Carbon is now on your plan, alongside Argon. Use it for Balanced and Heavy? Settings → Brain.' }]);
    expect(r.state.inUse.deep).toBe('gemini-4-argon-high'); // nothing changes until Aaron says so
    const again = watchModels(WITH_CARBON, r.state, slots, 'argon');
    expect(again.notices).toEqual([]);
    expect(again.state.suggestion).toBe('carbon');
  });

  it('follows a newer generation on its own and says so', () => {
    const before = watchModels(NOW, EMPTY_WATCH, slots, '').state;
    const next = ['gemini-5-neon-high', 'gemini-5-neon-medium', 'gemini-3.9-flash-medium', ...NOW];
    const r = watchModels(next, before, slots, 'argon');
    expect(r.state.inUse).toEqual({ fast: 'gemini-3.9-flash-medium', balanced: 'gemini-5-neon-medium', deep: 'gemini-5-neon-high' });
    expect(r.notices).toEqual([{ level: 'info', text: 'Gemini moved to newer models. Light: Gemini 3.9 Flash (Medium), Balanced: Gemini 5 Neon (Medium), Heavy: Gemini 5 Neon (High).' }]);
  });

  it('does nothing when the list can\'t be read', () => {
    const before = watchModels(NOW, EMPTY_WATCH, slots, '').state;
    expect(watchModels([], before, slots, 'argon')).toEqual({ state: before, notices: [] });
  });
});
