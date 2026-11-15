import { readFileSync, writeFileSync } from 'node:fs';
import { EMPTY_WATCH, modelName, SLOT_NAMES, SLOTS, watchModels, type CatalogChange, type ClaudeWatchState, type ModelAdvice, type ModelWatchState, type Slot } from '../core/models';
import { buildAdvicePrompt, claudeCandidates, geminiCandidates, lineupText, parseAdvice, sameLineup, type AdvisedBrain, type Candidate } from '../core/modelAdvice';
import type { ClaudeModelProbe } from '../core/providers/claude';
import { modelLabel } from '../shared/modelLabel';
import type { Settings } from '../shared/settings';
import { log } from './log';

/** A proposed line-up for one brain, as Settings → Brain shows it, waiting for Aaron's answers. */
export interface ModelSuggestion {
  brain: AdvisedBrain;
  brainName: string; // "Gemini" or "Claude"
  news: string; // "Gemini 4 Hydrogen is now on your plan."
  by: string; // who looked it up: "Claude" or "Gemini"
  summary: string;
  slots: {
    key: Slot; slot: string; model: string; current: string; changed: boolean; reason: string;
    answered?: 'used' | 'kept'; // Aaron has already answered this slot
  }[];
}

const RETRY_MS = 30 * 60_000; // after a failed look-up (the brain was busy, at its limit, or answered badly)
const CLAUDE_PROBE_MS = 7 * 24 * 3600_000; // how often Claude's models are asked for one word each
const CLAUDE_BASE = ['haiku', 'sonnet', 'opus']; // always tried, besides the names Claude Code's help mentions
const BRAIN_NAMES: Record<AdvisedBrain, string> = { gemini: 'Gemini', claude: 'Claude' };

// Keeps each brain's Light / Balanced / Heavy models up to date.
// - Gemini: reads what Antigravity offers shortly after start and every few hours. Newer versions of
//   the models in use are followed by themselves.
// - Claude: its slots are short names ("opus") that follow the newest model by themselves; which
//   models the subscription includes is found by asking each for one word (see claudeModelProbe).
// When a brain's list of models changes, the other brain is asked to look the models up and propose
// a line-up, which is offered to Aaron slot by slot (notice, gear dot, Settings → Brain).
export class ModelWatcher {
  private state: ModelWatchState = EMPTY_WATCH;
  private timers: NodeJS.Timeout[] = [];
  private asking: Partial<Record<AdvisedBrain, boolean>> = {};
  private askedAt: Partial<Record<AdvisedBrain, number>> = {};

  constructor(private readonly o: {
    file: string; // data/models.json
    refresh: () => Promise<string[]>; // `agy models`, read afresh
    settings: () => Settings;
    save: (patch: Partial<Settings>) => void;
    notify: (level: 'info' | 'warn', text: string) => void;
    onSuggestion: (s: ModelSuggestion[]) => void;
    /** Ask a brain to look a brain's models up on the web (the other brain first) and answer. */
    advise: (prompt: string, about: AdvisedBrain) => Promise<{ text: string; by: string }>;
    /** Finding out which Claude models the subscription includes (absent: Claude's slots aren't checked). */
    claude?: ClaudeModelProbe;
    now?: () => number;
  }) {
    try { this.state = { ...EMPTY_WATCH, ...JSON.parse(readFileSync(o.file, 'utf8')) }; } catch { /* first run */ }
  }

  private now(): number { return (this.o.now ?? Date.now)(); }

  start(firstAfterMs = 30_000, everyMs = 6 * 3600_000): void {
    this.timers.push(setTimeout(() => void this.check(), firstAfterMs), setInterval(() => void this.check(), everyMs));
    for (const t of this.timers) t.unref();
  }

  stop(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  /** The offers waiting for Aaron: none, one brain's, or both. */
  get suggestions(): ModelSuggestion[] {
    const out: ModelSuggestion[] = [];
    const s = this.o.settings();
    const offer = (brain: AdvisedBrain, a: ModelAdvice | null | undefined, current: Partial<Record<Slot, string>>, name: (id: string) => string) => {
      if (!a) return;
      out.push({
        brain, brainName: BRAIN_NAMES[brain], news: a.news, by: a.by, summary: a.summary,
        slots: SLOTS.map(slot => ({
          key: slot, slot: SLOT_NAMES[slot], model: name(a.slots[slot].model), current: current[slot] ? name(current[slot]!) : '',
          changed: a.slots[slot].model !== current[slot] && a.answered?.[slot] !== 'used', reason: a.slots[slot].reason, answered: a.answered?.[slot],
        })),
      });
    };
    offer('gemini', this.state.advice, this.state.inUse, modelName);
    offer('claude', this.state.claude?.advice, s.brainModels.claude, id => this.claudeName(id));
    return out;
  }

  /** "opus" → "Claude Opus 5.5", when the exact model behind the short name is known. */
  private claudeName(alias: string): string {
    const exact = this.state.claude?.models[alias];
    return exact ? modelLabel(exact) : alias.charAt(0).toUpperCase() + alias.slice(1);
  }

  /** `quiet`: just note the slots' new models (after Aaron's own "Use it", which already said so). */
  async check(quiet = false): Promise<void> {
    try {
      const ids = await this.o.refresh();
      const s = this.o.settings();
      const r = watchModels(ids, this.state, s.brainModels.gemini, s.geminiTopFamily);
      if (r.pinTop && !s.geminiTopFamily) this.o.save({ geminiTopFamily: r.pinTop });
      this.setState(r.state);
      for (const n of r.notices) {
        log('models', n.text);
        if (!quiet || n.level === 'warn') this.o.notify(n.level, n.text);
      }
      if (r.changed) await this.ask('gemini', r.changed, geminiCandidates(r.changed.catalog), this.state.inUse, modelName);
    } catch (e) {
      log('model check failed', String(e));
    }
    if (!quiet) await this.checkClaude().catch(e => log('Claude model check failed', String(e)));
  }

  /** Claude: find the subscription's models when it's due, and have the line-up looked into when they've changed. */
  private async checkClaude(): Promise<void> {
    const probe = this.o.claude;
    if (!probe) return;
    const prev: ClaudeWatchState = this.state.claude ?? { models: {}, advice: null };
    let next = prev;
    const version = await probe.version();
    if (!version) return; // Claude Code isn't there: nothing to go on
    if (version !== prev.version || !prev.probedAt || this.now() - prev.probedAt > CLAUDE_PROBE_MS) {
      const names = [...new Set([...CLAUDE_BASE, ...await probe.aliases()])];
      const models: Record<string, string> = {};
      let unknown = 0;
      for (const alias of names) {
        const r = await probe.probe(alias);
        if (!r) unknown++; else if (r.included) models[alias] = r.model;
      }
      // Signed out, at the limit or offline: keep what's known and look again at the next check.
      if (unknown || !Object.keys(models).length) { log('models', `Claude's models couldn't be checked (${unknown} of ${names.length} gave no answer).`); return; }
      next = { ...prev, version, probedAt: this.now(), models };
      this.setState({ ...this.state, claude: next });
      log('models', `Claude's subscription includes ${Object.entries(models).map(([a, m]) => `${a} (${m})`).join(', ')}.`);
    }
    // "opus=claude-opus-5-5": a model counts as new when its short name or the model behind it is.
    const catalog = Object.entries(next.models).map(([alias, exact]) => `${alias}=${exact}`).sort();
    const aliasOf = (entry: string) => entry.split('=')[0];
    const known = next.catalog;
    // Never looked into: Haiku, Sonnet and Opus are what Ghost started with, so only others are news.
    const fresh = known ? catalog.filter(c => !known.includes(c)) : catalog.filter(c => !CLAUDE_BASE.includes(aliasOf(c)));
    const gone = (known ?? []).filter(c => !catalog.map(aliasOf).includes(aliasOf(c)));
    if (!fresh.length && !gone.length) {
      if (!known) this.setState({ ...this.state, claude: { ...next, catalog } });
      return;
    }
    const names = (list: string[]) => list.map(c => modelLabel(c.split('=')[1] || aliasOf(c))).join(', ').replace(/, ([^,]*)$/, ' and $1');
    const news = fresh.length ? `${names(fresh)} ${fresh.length > 1 ? 'are' : 'is'} now included in your Claude plan.`
      : `${names(gone)} ${gone.length > 1 ? 'are' : 'is'} no longer in your Claude plan.`;
    const change: CatalogChange = { catalog, added: fresh.map(aliasOf), removed: gone.map(aliasOf), news };
    await this.ask('claude', change, claudeCandidates(next.models), this.o.settings().brainModels.claude, id => this.claudeName(id));
  }

  private advice(brain: AdvisedBrain): ModelAdvice | null { return (brain === 'gemini' ? this.state.advice : this.state.claude?.advice) ?? null; }

  /** Record a brain's advice (or its absence) and, when given, that its list of models has been looked into. */
  private setAdvice(brain: AdvisedBrain, advice: ModelAdvice | null, catalog?: string[]): void {
    if (brain === 'gemini') this.setState({ ...this.state, advice, ...(catalog ? { catalog } : {}) });
    else this.setState({ ...this.state, claude: { ...(this.state.claude ?? { models: {} }), advice, ...(catalog ? { catalog } : {}) } });
  }

  /** A brain's list of models changed: have them looked up, and offer the line-up that comes back. */
  private async ask(brain: AdvisedBrain, change: CatalogChange, candidates: Candidate[], current: Partial<Record<Slot, string>>, name: (id: string) => string): Promise<void> {
    if (this.asking[brain] || this.now() - (this.askedAt[brain] ?? 0) < RETRY_MS) return;
    this.asking[brain] = true;
    this.askedAt[brain] = this.now();
    try {
      log('models', `${change.news} Asking which model suits each slot.`);
      const answer = await this.o.advise(buildAdvicePrompt({ brain, candidates, current, change, now: new Date(this.now()) }), brain);
      const advice = parseAdvice(answer.text, candidates.map(c => c.id));
      if (!advice) throw new Error(`no usable line-up in the answer: ${answer.text.slice(0, 200)}`);
      this.askedAt[brain] = 0;
      const had = this.advice(brain);
      if (sameLineup(advice.slots, current)) {
        this.setAdvice(brain, null, change.catalog);
        log('models', `${answer.by} looked it up: no change. ${advice.summary}`);
        this.o.notify('info', `${change.news} ${answer.by} looked it up, and your ${BRAIN_NAMES[brain]} models stay as they are.`);
        if (had) this.o.onSuggestion(this.suggestions);
        return;
      }
      this.setAdvice(brain, { ...advice, by: answer.by, news: change.news, at: this.now() }, change.catalog);
      const models = Object.fromEntries(SLOTS.map(slot => [slot, advice.slots[slot].model]));
      log('models', `${answer.by} suggests ${lineupText(models, name)}. ${advice.summary}`);
      this.o.notify('warn', `${change.news} ${answer.by} suggests ${lineupText(models, name)}. Settings → Brain.`);
      this.o.onSuggestion(this.suggestions);
    } catch (e) {
      // Tried again in a while: the list is still "changed" until a look-up has succeeded.
      log('model look-up failed', String((e as Error).message ?? e));
      const t = setTimeout(() => void this.check(), RETRY_MS + 1000);
      t.unref();
      this.timers.push(t);
    } finally {
      this.asking[brain] = false;
    }
  }

  /**
   * Aaron's answer to an offer: use the proposed model or not, for one slot (`slot`) or for every
   * slot still open. The offer goes once each changed slot has an answer.
   */
  answer(brain: AdvisedBrain, use: boolean, slot?: Slot): void {
    const a = this.advice(brain);
    if (!a) return;
    const s = this.o.settings();
    const current: Partial<Record<Slot, string>> = brain === 'gemini' ? this.state.inUse : s.brainModels.claude;
    const name = brain === 'gemini' ? modelName : (id: string) => this.claudeName(id);
    const open = SLOTS.filter(k => a.slots[k].model !== current[k] && !a.answered?.[k]);
    const chosen = slot ? open.filter(k => k === slot) : open;
    if (!chosen.length) return;
    const answered = { ...a.answered };
    for (const k of chosen) answered[k] = use ? 'used' : 'kept';
    if (use) {
      const slots = { ...s.brainModels[brain] };
      for (const k of chosen) slots[k] = a.slots[k].model;
      this.o.save({ brainModels: { ...s.brainModels, [brain]: slots } });
      const used = Object.fromEntries(chosen.map(k => [k, a.slots[k].model]));
      this.o.notify('info', `${BRAIN_NAMES[brain]} now uses ${lineupText(used, name)}.`);
    }
    const left = open.filter(k => !chosen.includes(k));
    this.setAdvice(brain, left.length ? { ...a, answered } : null);
    if (brain === 'gemini' && use) void this.check(true).then(() => this.o.onSuggestion(this.suggestions)); // note the slots' new models
    else this.o.onSuggestion(this.suggestions);
  }

  private setState(s: ModelWatchState): void {
    this.state = s;
    try { writeFileSync(this.o.file, JSON.stringify(s, null, 2)); } catch { /* best effort */ }
  }
}
