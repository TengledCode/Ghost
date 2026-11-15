import { readFileSync, writeFileSync } from 'node:fs';
import { EMPTY_WATCH, modelName, SLOT_NAMES, SLOTS, watchModels, type CatalogChange, type ModelWatchState } from '../core/models';
import { buildAdvicePrompt, lineupText, parseAdvice, sameLineup } from '../core/modelAdvice';
import type { Settings } from '../shared/settings';
import { log } from './log';

/** A proposed Gemini line-up, as Settings → Brain shows it, waiting for Aaron's "Use it" or "Not now". */
export interface ModelSuggestion {
  news: string; // "Gemini 4 Hydrogen is now on your plan."
  by: string; // who looked it up: "Claude" or "Gemini"
  summary: string;
  slots: { slot: string; model: string; current: string; changed: boolean; reason: string }[];
}

const RETRY_MS = 30 * 60_000; // after a failed look-up (the brain was busy, at its limit, or answered badly)

// Looks at what Antigravity offers shortly after start and every few hours. Ghost follows newer
// versions of its models by itself. When the list itself changes (a new family, a withdrawn model),
// the other brain is asked to look up the models and propose a line-up for Light, Balanced and Heavy,
// which is offered to Aaron (notice, gear dot, Settings → Brain).
// Claude needs none of this: its slots are aliases ("opus") that always mean the newest model.
export class ModelWatcher {
  private state: ModelWatchState = EMPTY_WATCH;
  private timers: NodeJS.Timeout[] = [];
  private asking = false;
  private askedAt = 0;

  constructor(private readonly o: {
    file: string; // data/models.json
    refresh: () => Promise<string[]>; // `agy models`, read afresh
    settings: () => Settings;
    save: (patch: Partial<Settings>) => void;
    notify: (level: 'info' | 'warn', text: string) => void;
    onSuggestion: (s: ModelSuggestion | null) => void;
    /** Ask a brain to look the models up on the web (the other brain first) and answer. */
    advise: (prompt: string) => Promise<{ text: string; by: string }>;
    now?: () => number;
  }) {
    try { this.state = { ...EMPTY_WATCH, ...JSON.parse(readFileSync(o.file, 'utf8')) }; } catch { /* first run */ }
  }

  start(firstAfterMs = 30_000, everyMs = 6 * 3600_000): void {
    this.timers.push(setTimeout(() => void this.check(), firstAfterMs), setInterval(() => void this.check(), everyMs));
    for (const t of this.timers) t.unref();
  }

  stop(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  get suggestion(): ModelSuggestion | null {
    const a = this.state.advice;
    if (!a) return null;
    return {
      news: a.news, by: a.by, summary: a.summary,
      slots: SLOTS.map(slot => {
        const current = this.state.inUse[slot] ?? '';
        return { slot: SLOT_NAMES[slot], model: modelName(a.slots[slot].model), current: current ? modelName(current) : '', changed: a.slots[slot].model !== current, reason: a.slots[slot].reason };
      }),
    };
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
      if (r.changed) await this.ask(r.changed);
    } catch (e) {
      log('model check failed', String(e));
    }
  }

  /** The list of models changed: have them looked up, and offer the line-up that comes back. */
  private async ask(change: CatalogChange): Promise<void> {
    const now = this.o.now ?? Date.now;
    if (this.asking || now() - this.askedAt < RETRY_MS) return;
    this.asking = true;
    this.askedAt = now();
    try {
      log('models', `${change.news} Asking which model suits each slot.`);
      const answer = await this.o.advise(buildAdvicePrompt({ catalog: change.catalog, current: this.state.inUse, change, now: new Date(now()) }));
      const advice = parseAdvice(answer.text, change.catalog);
      if (!advice) throw new Error(`no usable line-up in the answer: ${answer.text.slice(0, 200)}`);
      this.askedAt = 0;
      const had = this.state.advice;
      if (sameLineup(advice.slots, this.state.inUse)) {
        this.setState({ ...this.state, catalog: change.catalog, advice: null });
        log('models', `${answer.by} looked it up: no change. ${advice.summary}`);
        this.o.notify('info', `${change.news} ${answer.by} looked it up, and your Gemini models stay as they are.`);
        if (had) this.o.onSuggestion(null);
        return;
      }
      this.setState({ ...this.state, catalog: change.catalog, advice: { ...advice, by: answer.by, news: change.news, at: now() } });
      const models = Object.fromEntries(SLOTS.map(slot => [slot, advice.slots[slot].model]));
      log('models', `${answer.by} suggests ${lineupText(models)}. ${advice.summary}`);
      this.o.notify('warn', `${change.news} ${answer.by} suggests ${lineupText(models)}. Settings → Brain.`);
      this.o.onSuggestion(this.suggestion);
    } catch (e) {
      // Tried again in a while: the list is still "changed" until a look-up has succeeded.
      log('model look-up failed', String((e as Error).message ?? e));
      const t = setTimeout(() => void this.check(true), RETRY_MS + 1000);
      t.unref();
      this.timers.push(t);
    } finally {
      this.asking = false;
    }
  }

  /** Aaron's answer to the offer: use the proposed line-up, or not now. */
  answer(use: boolean): void {
    const a = this.state.advice;
    if (!a) return;
    if (use) {
      const s = this.o.settings();
      const gemini = { fast: a.slots.fast.model, balanced: a.slots.balanced.model, deep: a.slots.deep.model };
      this.o.save({ brainModels: { ...s.brainModels, gemini } });
      this.o.notify('info', `Gemini now uses ${lineupText(gemini)}.`);
    }
    this.setState({ ...this.state, advice: null });
    this.o.onSuggestion(null);
    void this.check(true); // note the slots' new models
  }

  private setState(s: ModelWatchState): void {
    this.state = s;
    try { writeFileSync(this.o.file, JSON.stringify(s, null, 2)); } catch { /* best effort */ }
  }
}
