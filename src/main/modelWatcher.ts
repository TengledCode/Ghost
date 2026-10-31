import { readFileSync, writeFileSync } from 'node:fs';
import { EMPTY_WATCH, familyName, geminiFamilies, watchModels, type ModelWatchState } from '../core/models';
import type { Settings } from '../shared/settings';
import { log } from './log';

/** A Gemini family on offer for Balanced and Heavy, waiting for Aaron's "Use it" or "Not now". */
export interface ModelSuggestion { family: string; label: string; current: string }

// Looks at what Antigravity offers shortly after start and every few hours: Ghost follows newer
// Gemini models by itself, and a new family is offered to Aaron (notice, gear dot, Settings → Brain).
// Claude needs none of this: its slots are aliases ("opus") that always mean the newest model.
export class ModelWatcher {
  private state: ModelWatchState = EMPTY_WATCH;
  private ids: string[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: {
    file: string; // data/models.json
    refresh: () => Promise<string[]>; // `agy models`, read afresh
    settings: () => Settings;
    save: (patch: Partial<Settings>) => void;
    notify: (level: 'info' | 'warn', text: string) => void;
    onSuggestion: (s: ModelSuggestion | null) => void;
  }) {
    try { this.state = { ...EMPTY_WATCH, ...JSON.parse(readFileSync(o.file, 'utf8')) }; } catch { /* first run */ }
  }

  start(firstAfterMs = 30_000, everyMs = 6 * 3600_000): void {
    this.timers.push(setTimeout(() => void this.check(), firstAfterMs), setInterval(() => void this.check(), everyMs));
    for (const t of this.timers) t.unref();
  }

  stop(): void { for (const t of this.timers) clearTimeout(t); this.timers = []; }

  get suggestion(): ModelSuggestion | null {
    const family = this.state.suggestion;
    if (!family) return null;
    const f = geminiFamilies(this.ids).find(x => x.family === family);
    return { family, label: f ? `Gemini ${f.version} ${familyName(family)}` : `Gemini ${familyName(family)}`, current: familyName(this.o.settings().geminiTopFamily) };
  }

  async check(): Promise<void> {
    try {
      const ids = await this.o.refresh();
      if (ids.length) this.ids = ids;
      const s = this.o.settings();
      const r = watchModels(ids, this.state, s.brainModels.gemini, s.geminiTopFamily);
      if (r.pinTop && !s.geminiTopFamily) this.o.save({ geminiTopFamily: r.pinTop });
      const had = this.state.suggestion;
      this.setState(r.state);
      for (const n of r.notices) { log('models', n.text); this.o.notify(n.level, n.text); }
      if (this.state.suggestion !== had) this.o.onSuggestion(this.suggestion);
    } catch (e) {
      log('model check failed', String(e));
    }
  }

  /** Aaron's answer to the offer: use the new family for Balanced and Heavy, or not now. */
  answer(use: boolean): void {
    const family = this.state.suggestion;
    if (!family) return;
    if (use) {
      this.o.save({ geminiTopFamily: family });
      this.o.notify('info', `Balanced and Heavy now use ${this.suggestion?.label ?? familyName(family)}.`);
    }
    this.setState({ ...this.state, suggestion: null, dismissed: use ? this.state.dismissed : [...this.state.dismissed, family] });
    this.o.onSuggestion(null);
    void this.check(); // note the slots' new models
  }

  private setState(s: ModelWatchState): void {
    this.state = s;
    try { writeFileSync(this.o.file, JSON.stringify(s, null, 2)); } catch { /* best effort */ }
  }
}
