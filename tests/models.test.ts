import { describe, expect, it } from 'vitest';
import { geminiFamilies, modelName, parseGemini, pickGemini, topGeminiFamily } from '../src/core/models';

// What `agy models` offered Aaron on 31 Oct 2026 (Gemini 4 Argon out, no Pro any more).
const NOW = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low', 'claude-opus-5-5-low', 'claude-sonnet-5-5-high', 'gpt-oss-120b-medium'];
const WITH_CARBON = ['gemini-4-carbon-medium', 'gemini-4-carbon-high', ...NOW];
// 15 Nov 2026: Hydrogen arrived, with an effort above High.
const WITH_HYDROGEN = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-low', 'gemini-pro-orchestrator-g1-pro', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-low', 'gpt-oss-120b-medium'];

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
  it('keeps Aaron\'s family in the same generation instead of guessing from a new name', () => {
    expect(topGeminiFamily(WITH_CARBON, 'argon')).toBe('argon');
    expect(pickGemini(WITH_CARBON, 'top-high', 'argon')).toBe('gemini-4-argon-high');
    expect(pickGemini(WITH_CARBON, 'top-high', 'carbon')).toBe('gemini-4-carbon-high');
  });
  it('knows the XHigh effort (Hydrogen, Nov 2026) as an effort, not a family of its own', () => {
    expect(parseGemini('gemini-4-hydrogen-xhigh')).toEqual({ id: 'gemini-4-hydrogen-xhigh', version: 4, family: 'hydrogen', effort: 'xhigh' });
    expect(geminiFamilies(WITH_HYDROGEN).map(f => f.family)).toEqual(['argon', 'hydrogen', 'flash']);
    expect(modelName('gemini-4-hydrogen-xhigh')).toBe('Gemini 4 Hydrogen (XHigh)');
    expect(pickGemini(WITH_HYDROGEN, 'top-high', 'argon')).toBe('gemini-4-argon-high'); // the hints don't move by themselves
  });
  it('carries on when a model picked by name is withdrawn: same family and effort, newest version', () => {
    expect(pickGemini(WITH_HYDROGEN, 'gemini-4-hydrogen-xhigh')).toBe('gemini-4-hydrogen-xhigh');
    const next = ['gemini-4.5-hydrogen-high', 'gemini-4.5-hydrogen-xhigh', 'gemini-4-argon-high', 'gemini-3.8-flash-medium'];
    expect(pickGemini(next, 'gemini-4-hydrogen-xhigh')).toBe('gemini-4.5-hydrogen-xhigh');
    expect(pickGemini(next, 'gemini-4-hydrogen-medium')).toBe('gemini-4.5-hydrogen-high'); // the nearest effort left
    expect(pickGemini(['gemini-4-argon-high', 'gemini-4-argon-medium', 'gemini-3.8-flash-medium'], 'gemini-4-hydrogen-xhigh', 'argon')).toBe('gemini-4-argon-high'); // family gone
    expect(pickGemini([], 'gemini-4-hydrogen-xhigh')).toBe('gemini-4-hydrogen-xhigh'); // the list couldn't be read: leave it
    expect(pickGemini(WITH_HYDROGEN, 'claude-opus-5-5-low')).toBe('claude-opus-5-5-low'); // another maker's model, picked by hand
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

  it('reports a new family for a look-up, and keeps reporting it until that has been done', () => {
    const before = watchModels(NOW, EMPTY_WATCH, slots, '').state;
    expect(watchModels(NOW, before, slots, 'argon').changed).toBeUndefined(); // nothing new
    const r = watchModels(WITH_HYDROGEN, before, slots, 'argon');
    expect(r.changed?.news).toBe('Gemini 4 Hydrogen is now on your plan.');
    expect(r.changed?.added).toEqual(['gemini-4-hydrogen-high', 'gemini-4-hydrogen-low', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-xhigh']);
    expect(r.notices).toEqual([]);
    expect(r.state.inUse.deep).toBe('gemini-4-argon-high'); // nothing changes until Aaron says so
    expect(watchModels(WITH_HYDROGEN, r.state, slots, 'argon').changed?.news).toBe('Gemini 4 Hydrogen is now on your plan.'); // the look-up failed: still due
    expect(watchModels(WITH_HYDROGEN, { ...r.state, catalog: r.changed!.catalog }, slots, 'argon').changed).toBeUndefined(); // looked into
  });

  it('reports new efforts and withdrawn models too', () => {
    const before = watchModels(NOW, EMPTY_WATCH, slots, '').state;
    expect(watchModels([...NOW, 'gemini-4-argon-xhigh'], before, slots, 'argon').changed?.news).toBe('New Gemini models are on your plan: Gemini 4 Argon (XHigh).');
    const fewer = NOW.filter(id => id !== 'gemini-3.8-flash-low');
    expect(watchModels(fewer, before, slots, 'argon').changed?.news).toBe('Gemini 3.8 Flash (Low) is no longer on your plan.');
    expect(watchModels([...NOW, 'claude-opus-6-high'], before, slots, 'argon').changed).toBeUndefined(); // another maker's model: not Gemini's line-up
  });

  it('picks up where an older Ghost left off: the family it had on offer gets its look-up', () => {
    // data/models.json as it was on Aaron's PC on 15 Nov 2026 ("XHigh" misread as a family).
    const old = { known: ['argon', 'flash', 'hydrogen', 'hydrogen-xhigh'], dismissed: [], suggestion: 'hydrogen', inUse: { fast: 'gemini-3.8-flash-medium', balanced: 'gemini-4-argon-medium', deep: 'gemini-4-argon-high' } } as never;
    const r = watchModels(WITH_HYDROGEN, old, slots, 'argon');
    expect(r.changed?.news).toBe('Gemini 4 Hydrogen is now on your plan.');
    expect(r.state.known).toEqual(['argon', 'flash', 'hydrogen']);
    expect(watchModels(WITH_HYDROGEN, r.state, slots, 'argon').changed?.news).toBe('Gemini 4 Hydrogen is now on your plan.');
    // One with nothing on offer just notes what's there.
    expect(watchModels(NOW, { known: ['argon', 'flash'], inUse: {}, advice: null }, slots, 'argon').changed).toBeUndefined();
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
