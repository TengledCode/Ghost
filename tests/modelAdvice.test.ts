import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdvicePrompt, parseAdvice, sameLineup } from '../src/core/modelAdvice';
import { geminiChatModels } from '../src/core/models';
import { ModelWatcher } from '../src/main/modelWatcher';
import { claudeArgs } from '../src/core/providers/claude';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const NOW = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-low'];
const HYDROGEN = ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low'];
const CATALOG = geminiChatModels([...NOW, ...HYDROGEN]).sort();
const CURRENT = { fast: 'gemini-3.8-flash-medium', balanced: 'gemini-4-argon-medium', deep: 'gemini-4-argon-high' };
// Shaped like Claude Sonnet's answers on Aaron's PC on 15 Nov 2026 (two runs differed on Light and Heavy).
const ANSWER = JSON.stringify({
  light: { model: 'gemini-3.8-flash-medium', reason: 'No evidence Hydrogen beats Flash for light tasks.' },
  balanced: { model: 'gemini-4-hydrogen-high', reason: 'Scores 51 against Argon\'s 50 at about 38% of the cost, and runs faster.' },
  heavy: { model: 'gemini-4-argon-high', reason: 'Argon still leads on long-context and terminal tests.' },
  summary: 'Gemini 4 Hydrogen, released 12 Nov 2026, is Google\'s fast, cheaper daily driver.',
  sources: ['https://blog.google/x'], confidence: 'medium',
});

describe('asking the other brain which Gemini model suits each slot', () => {
  it('asks with the models on offer, the current line-up, what changed, and to look it up first', () => {
    const prompt = buildAdvicePrompt({ catalog: CATALOG, current: CURRENT, change: { added: HYDROGEN, removed: [], news: 'Gemini 4 Hydrogen is now on your plan.' }, now: new Date('2026-11-15T12:00:00') });
    expect(prompt).toContain('Today is 15 November 2026.');
    expect(prompt).toContain('- Gemini 4 Hydrogen: gemini-4-hydrogen-high, gemini-4-hydrogen-low, gemini-4-hydrogen-medium, gemini-4-hydrogen-xhigh');
    expect(prompt).toContain('Current line-up: Light = gemini-3.8-flash-medium, Balanced = gemini-4-argon-medium, Heavy = gemini-4-argon-high.');
    expect(prompt).toContain('What changed: Gemini 4 Hydrogen is now on your plan. New: gemini-4-hydrogen-high');
    expect(prompt).toMatch(/Before deciding, search the web/);
    expect(prompt).toMatch(/a model's name says nothing about its strength/);
    expect(prompt).not.toContain('claude-opus'); // other makers' models aren't candidates
  });

  it('takes a line-up only when every slot names a model that is really on offer', () => {
    const advice = parseAdvice(`Here you go:\n${ANSWER}\n`, CATALOG);
    expect(advice?.slots.balanced).toEqual({ model: 'gemini-4-hydrogen-high', reason: 'Scores 51 against Argon\'s 50 at about 38% of the cost, and runs faster.' });
    expect(advice?.summary).toMatch(/daily driver/);
    expect(parseAdvice(ANSWER.replace('gemini-4-hydrogen-high', 'gemini-9-ultra-high'), CATALOG)).toBeNull(); // made up
    expect(parseAdvice(ANSWER.replace('gemini-4-argon-high', 'claude-opus-5-5-low'), [...CATALOG])).toBeNull(); // not a Gemini model
    expect(parseAdvice(ANSWER.replace('"heavy"', '"deep"'), CATALOG)).toBeNull(); // a slot missing
    expect(parseAdvice('I could not find anything.', CATALOG)).toBeNull();
    expect(parseAdvice('{"light": nonsense', CATALOG)).toBeNull();
    expect(sameLineup(advice!.slots, CURRENT)).toBe(false);
    expect(sameLineup(advice!.slots, { ...CURRENT, balanced: 'gemini-4-hydrogen-high' })).toBe(true);
  });

  it('gives the research call the web tools only: none of Ghost\'s, no persona', () => {
    const args = claudeArgs({ model: 'sonnet', personaFile: 'p.md', mcpConfigPath: 'm.json', oneShot: true, web: true });
    expect(args.join(' ')).toContain('--tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch');
    expect(args).not.toContain('--mcp-config');
    expect(args).not.toContain('--append-system-prompt-file');
    expect(claudeArgs({ model: 'haiku', personaFile: 'p.md', mcpConfigPath: 'm.json', oneShot: true }).join(' ')).toContain('--tools  '); // filing: still no tools at all
  });
});

describe('the model watcher', () => {
  function setup(answers: (string | Error)[]) {
    const file = join(mkdtempSync(join(tmpdir(), 'ghost-models-')), 'models.json');
    let ids = NOW;
    let settings: Settings = { ...DEFAULT_SETTINGS, geminiTopFamily: 'argon' };
    let now = Date.parse('2026-11-15T12:00:00');
    const notices: string[] = [];
    const offers: unknown[] = [];
    const asked: string[] = [];
    const watcher = new ModelWatcher({
      file, refresh: async () => ids, settings: () => settings, save: patch => { settings = { ...settings, ...patch }; },
      notify: (level, text) => notices.push(`${level}: ${text}`), onSuggestion: s => offers.push(s),
      advise: async prompt => { asked.push(prompt); const a = answers.shift(); if (!a || a instanceof Error) throw a ?? new Error('no answer'); return { text: a, by: 'Claude' }; },
      now: () => now,
    });
    return { watcher, notices, offers, asked, set: (list: string[]) => { ids = list; }, later: (ms: number) => { now += ms; }, settings: () => settings, state: () => JSON.parse(readFileSync(file, 'utf8')) };
  }

  it('has a new family looked up, offers the line-up, and uses it on "Use it"', async () => {
    const t = setup([ANSWER]);
    await t.watcher.check(); // first look: nothing to ask
    expect(t.asked).toHaveLength(0);
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    expect(t.asked).toHaveLength(1);
    expect(t.notices).toEqual(['warn: Gemini 4 Hydrogen is now on your plan. Claude suggests Light: Gemini 3.8 Flash (Medium), Balanced: Gemini 4 Hydrogen (High), Heavy: Gemini 4 Argon (High). Settings → Brain.']);
    expect(t.watcher.suggestion?.slots.map(s => [s.slot, s.model, s.changed])).toEqual([
      ['Light', 'Gemini 3.8 Flash (Medium)', false], ['Balanced', 'Gemini 4 Hydrogen (High)', true], ['Heavy', 'Gemini 4 Argon (High)', false],
    ]);
    expect(t.watcher.suggestion?.slots[1].current).toBe('Gemini 4 Argon (Medium)');
    await t.watcher.check(); // still on offer, not asked again
    expect(t.asked).toHaveLength(1);
    t.watcher.answer(true);
    expect(t.settings().brainModels.gemini).toEqual({ fast: 'gemini-3.8-flash-medium', balanced: 'gemini-4-hydrogen-high', deep: 'gemini-4-argon-high' });
    expect(t.notices.at(-1)).toBe('info: Gemini now uses Light: Gemini 3.8 Flash (Medium), Balanced: Gemini 4 Hydrogen (High), Heavy: Gemini 4 Argon (High).');
    expect(t.watcher.suggestion).toBeNull();
  });

  it('changes nothing on "Not now", and doesn\'t ask again until the list changes', async () => {
    const t = setup([ANSWER, ANSWER]);
    await t.watcher.check();
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    t.watcher.answer(false);
    expect(t.settings().brainModels.gemini).toEqual(DEFAULT_SETTINGS.brainModels.gemini);
    t.later(24 * 3600_000);
    await t.watcher.check();
    expect(t.asked).toHaveLength(1);
    t.set([...NOW, ...HYDROGEN, 'gemini-4-argon-xhigh']);
    await t.watcher.check();
    expect(t.asked).toHaveLength(2);
  });

  it('says so, without an offer, when the look-up finds the line-up is already right', async () => {
    const same = ANSWER.replace('gemini-4-hydrogen-high', 'gemini-4-argon-medium');
    const t = setup([same]);
    await t.watcher.check();
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    expect(t.watcher.suggestion).toBeNull();
    expect(t.notices).toEqual(['info: Gemini 4 Hydrogen is now on your plan. Claude looked it up, and your Gemini models stay as they are.']);
  });

  it('tries again later when the look-up fails or answers badly, and not before', async () => {
    const t = setup([new Error('limit reached'), 'no idea, sorry', ANSWER]);
    await t.watcher.check();
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    expect(t.notices).toEqual([]);
    await t.watcher.check(); // straight away: not yet
    expect(t.asked).toHaveLength(1);
    t.later(31 * 60_000);
    await t.watcher.check(); // an answer with no line-up in it
    expect(t.asked).toHaveLength(2);
    expect(t.watcher.suggestion).toBeNull();
    t.later(31 * 60_000);
    await t.watcher.check();
    expect(t.watcher.suggestion?.by).toBe('Claude');
    t.watcher.stop();
  });
});
