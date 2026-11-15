import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAdvicePrompt, claudeCandidates, geminiCandidates, parseAdvice, sameLineup } from '../src/core/modelAdvice';
import { geminiChatModels } from '../src/core/models';
import { ModelWatcher } from '../src/main/modelWatcher';
import { claudeArgs, type ClaudeModelProbe } from '../src/core/providers/claude';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const NOW = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-low'];
const HYDROGEN = ['gemini-4-hydrogen-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-hydrogen-medium', 'gemini-4-hydrogen-low'];
const CATALOG = geminiChatModels([...NOW, ...HYDROGEN]).sort();
const CURRENT = { fast: 'gemini-3.8-flash-medium', balanced: 'gemini-4-argon-medium', deep: 'gemini-4-argon-high' };
// Shaped like Claude Sonnet's answers on Aaron's PC on 15 Nov 2026 (the runs differed on Light and Heavy).
const ANSWER = JSON.stringify({
  light: { model: 'gemini-3.8-flash-medium', reason: 'No evidence Hydrogen beats Flash for light tasks.' },
  balanced: { model: 'gemini-4-hydrogen-high', reason: 'Scores 51 against Argon\'s 50 at about 38% of the cost, and runs faster.' },
  heavy: { model: 'gemini-4-argon-high', reason: 'Argon still leads on long-context and terminal tests.' },
  summary: 'Gemini 4 Hydrogen, released 12 Nov 2026, is Google\'s fast, cheaper daily driver.',
  sources: ['https://blog.google/x'], confidence: 'medium',
});
// One that changes two slots, for answering them one at a time.
const TWO = ANSWER.replace('gemini-3.8-flash-medium', 'gemini-4-hydrogen-low');
const CLAUDE_MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-2' };
const CLAUDE_ANSWER = JSON.stringify({
  light: { model: 'haiku', reason: 'Still the fastest and lightest.' }, balanced: { model: 'sonnet', reason: 'The best balance for everyday use.' },
  heavy: { model: 'fable', reason: 'Leads the reasoning benchmarks, at several times the plan usage.' }, summary: 'Fable is the strongest and the heaviest on the plan.',
});

describe('asking the other brain which model suits each slot', () => {
  it('asks about Gemini with the models on offer, the current line-up, what changed, and to look it up first', () => {
    const prompt = buildAdvicePrompt({ brain: 'gemini', candidates: geminiCandidates(CATALOG), current: CURRENT, change: { added: HYDROGEN, removed: [], news: 'Gemini 4 Hydrogen is now on your plan.' }, now: new Date('2026-11-15T12:00:00') });
    expect(prompt).toContain('Today is 15 November 2026.');
    expect(prompt).toContain('- Gemini 4 Hydrogen: gemini-4-hydrogen-high, gemini-4-hydrogen-low, gemini-4-hydrogen-medium, gemini-4-hydrogen-xhigh');
    expect(prompt).toContain('Current line-up: Light = gemini-3.8-flash-medium, Balanced = gemini-4-argon-medium, Heavy = gemini-4-argon-high.');
    expect(prompt).toContain('What changed: Gemini 4 Hydrogen is now on your plan. New: gemini-4-hydrogen-high');
    expect(prompt).toMatch(/Before deciding, search the web/);
    expect(prompt).toMatch(/a model's name says nothing about its strength/);
    expect(prompt).not.toContain('claude-opus'); // other makers' models aren't candidates
  });

  it('asks about Claude with the models the subscription itself includes, by their short names', () => {
    const prompt = buildAdvicePrompt({
      brain: 'claude', candidates: claudeCandidates(CLAUDE_MODELS), current: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
      change: { added: ['fable'], removed: [], news: 'Claude Fable 5.2 is now included in your Claude plan.' }, now: new Date('2026-11-16T12:00:00'),
    });
    expect(prompt).toContain("Anthropic's Claude models on a Claude subscription (via Claude Code), with no pay-as-you-go usage credits");
    expect(prompt).toContain('- fable: Claude Fable 5.2\n- haiku: Claude Haiku 5.5\n- opus: Claude Opus 5.5\n- sonnet: Claude Sonnet 5.5');
    expect(prompt).toContain('Current line-up: Light = haiku, Balanced = sonnet, Heavy = opus.');
    expect(prompt).toMatch(/eats the plan's limits several times faster is the wrong choice there/);
    expect(parseAdvice(CLAUDE_ANSWER, Object.keys(CLAUDE_MODELS))?.slots.deep.model).toBe('fable');
    expect(parseAdvice(CLAUDE_ANSWER, ['haiku', 'sonnet', 'opus'])).toBeNull(); // Fable not included: no proposal with it
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
  function setup(answers: (string | Error)[], claude?: { models: Record<string, string | null>; version?: string }) {
    const file = join(mkdtempSync(join(tmpdir(), 'ghost-models-')), 'models.json');
    let ids = NOW;
    let settings: Settings = { ...DEFAULT_SETTINGS, geminiTopFamily: 'argon' };
    let now = Date.parse('2026-11-15T12:00:00');
    const notices: string[] = [];
    const asked: { prompt: string; about: string }[] = [];
    const probed: string[] = [];
    const cl = claude && { version: claude.version ?? '2.1.322', models: claude.models };
    const probe: ClaudeModelProbe | undefined = cl && {
      version: async () => cl.version,
      aliases: async () => ['fable', 'opus', 'sonnet'],
      probe: async alias => { probed.push(alias); const m = cl.models[alias]; return m === null ? null : m ? { model: m, included: true } : { model: '', included: false }; },
    };
    const watcher = new ModelWatcher({
      file, refresh: async () => ids, settings: () => settings, save: patch => { settings = { ...settings, ...patch }; },
      notify: (level, text) => notices.push(`${level}: ${text}`), onSuggestion: () => {},
      advise: async (prompt, about) => { asked.push({ prompt, about }); const a = answers.shift(); if (!a || a instanceof Error) throw a ?? new Error('no answer'); return { text: a, by: about === 'gemini' ? 'Claude' : 'Gemini' }; },
      claude: probe, now: () => now,
    });
    const offer = (brain: 'gemini' | 'claude') => watcher.suggestions.find(s => s.brain === brain) ?? null;
    return { watcher, notices, asked, probed, offer, cl, set: (list: string[]) => { ids = list; }, later: (ms: number) => { now += ms; }, settings: () => settings, state: () => JSON.parse(readFileSync(file, 'utf8')) };
  }

  it('has a new family looked up, offers the line-up, and uses it all on "Use all"', async () => {
    const t = setup([ANSWER]);
    await t.watcher.check(); // first look: nothing to ask
    expect(t.asked).toHaveLength(0);
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    expect(t.asked).toHaveLength(1);
    expect(t.notices).toEqual(['warn: Gemini 4 Hydrogen is now on your plan. Claude suggests Light: Gemini 3.8 Flash (Medium), Balanced: Gemini 4 Hydrogen (High), Heavy: Gemini 4 Argon (High). Settings → Brain.']);
    expect(t.offer('gemini')?.slots.map(s => [s.slot, s.model, s.changed])).toEqual([
      ['Light', 'Gemini 3.8 Flash (Medium)', false], ['Balanced', 'Gemini 4 Hydrogen (High)', true], ['Heavy', 'Gemini 4 Argon (High)', false],
    ]);
    expect(t.offer('gemini')?.slots[1].current).toBe('Gemini 4 Argon (Medium)');
    await t.watcher.check(); // still on offer, not asked again
    expect(t.asked).toHaveLength(1);
    t.watcher.answer('gemini', true);
    expect(t.settings().brainModels.gemini).toEqual({ fast: 'flash', balanced: 'gemini-4-hydrogen-high', deep: 'top-high' }); // only the slot that changed is pinned
    expect(t.notices.at(-1)).toBe('info: Gemini now uses Balanced: Gemini 4 Hydrogen (High).');
    expect(t.offer('gemini')).toBeNull();
  });

  it('takes an answer for each slot on its own', async () => {
    const t = setup([TWO]);
    await t.watcher.check();
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    expect(t.offer('gemini')?.slots.filter(s => s.changed).map(s => s.slot)).toEqual(['Light', 'Balanced']);
    t.watcher.answer('gemini', false, 'fast'); // Not now for Light
    expect(t.settings().brainModels.gemini).toEqual(DEFAULT_SETTINGS.brainModels.gemini);
    expect(t.offer('gemini')?.slots.map(s => s.answered)).toEqual(['kept', undefined, undefined]); // still on offer for Balanced
    t.watcher.answer('gemini', false, 'fast'); // answered already: nothing happens
    t.watcher.answer('gemini', true, 'deep'); // nothing was proposed for Heavy
    expect(t.offer('gemini')).not.toBeNull();
    t.watcher.answer('gemini', true, 'balanced'); // Use it for Balanced: the last open slot
    expect(t.settings().brainModels.gemini).toEqual({ fast: 'flash', balanced: 'gemini-4-hydrogen-high', deep: 'top-high' });
    expect(t.offer('gemini')).toBeNull();
  });

  it('changes nothing on "Not now for any", and doesn\'t ask again until the list changes', async () => {
    const t = setup([TWO, ANSWER]);
    await t.watcher.check();
    t.set([...NOW, ...HYDROGEN]);
    await t.watcher.check();
    t.watcher.answer('gemini', false);
    expect(t.settings().brainModels.gemini).toEqual(DEFAULT_SETTINGS.brainModels.gemini);
    expect(t.offer('gemini')).toBeNull();
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
    expect(t.offer('gemini')).toBeNull();
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
    expect(t.offer('gemini')).toBeNull();
    t.later(31 * 60_000);
    await t.watcher.check();
    expect(t.offer('gemini')?.by).toBe('Claude');
    t.watcher.stop();
  });

  it('finds the Claude models the subscription includes, and has Gemini look a new one up', async () => {
    const t = setup([CLAUDE_ANSWER], { models: CLAUDE_MODELS });
    await t.watcher.check();
    expect(t.probed.sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet']);
    expect(t.asked.map(a => a.about)).toEqual(['claude']);
    expect(t.notices).toEqual(['warn: Claude Fable 5.2 is now included in your Claude plan. Gemini suggests Light: Claude Haiku 5.5, Balanced: Claude Sonnet 5.5, Heavy: Claude Fable 5.2. Settings → Brain.']);
    expect(t.offer('claude')?.slots.map(s => [s.slot, s.model, s.current, s.changed])).toEqual([
      ['Light', 'Claude Haiku 5.5', 'Claude Haiku 5.5', false], ['Balanced', 'Claude Sonnet 5.5', 'Claude Sonnet 5.5', false], ['Heavy', 'Claude Fable 5.2', 'Claude Opus 5.5', true],
    ]);
    await t.watcher.check(); // same Claude Code, same week: no more probing, no second look-up
    expect(t.probed).toHaveLength(4);
    expect(t.asked).toHaveLength(1);
    t.watcher.answer('claude', true, 'deep');
    expect(t.settings().brainModels.claude).toEqual({ fast: 'haiku', balanced: 'sonnet', deep: 'fable' });
    expect(t.notices.at(-1)).toBe('info: Claude now uses Heavy: Claude Fable 5.2.');
    expect(t.offer('claude')).toBeNull();
  });

  it('leaves Claude alone while the plan holds only Haiku, Sonnet and Opus, and looks again when Claude Code changes', async () => {
    const t = setup([CLAUDE_ANSWER.replace('fable', 'opus')], { models: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' } }); // Fable answers "not on offer"
    await t.watcher.check();
    expect(t.asked).toHaveLength(0);
    expect(t.offer('claude')).toBeNull();
    t.later(8 * 24 * 3600_000); // a week on: asked again, still nothing new
    await t.watcher.check();
    expect(t.probed).toHaveLength(8);
    expect(t.asked).toHaveLength(0);
    t.cl!.version = '2.2.0';
    t.cl!.models.opus = 'claude-opus-6'; // a new Opus behind the same short name
    await t.watcher.check();
    expect(t.asked.map(a => a.about)).toEqual(['claude']);
    expect(t.notices).toEqual(['info: Claude Opus 6 is now included in your Claude plan. Gemini looked it up, and your Claude models stay as they are.']);
  });

  it("doesn't touch what it knows about Claude when the models can't be asked (signed out, at the limit)", async () => {
    const t = setup([], { models: { haiku: null, sonnet: null, opus: null, fable: null } });
    await t.watcher.check();
    expect(t.asked).toHaveLength(0);
    expect(t.state().claude).toBeUndefined();
  });
});
