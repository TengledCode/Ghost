// Which Gemini model each slot uses, from the ids `agy models` lists (e.g. gemini-4-argon-high,
// gemini-3.8-flash-medium). Gemini's slots are matched to Claude's: Light ≈ Haiku is the newest Flash,
// Balanced ≈ Sonnet and Heavy ≈ Opus are the strongest Gemini family at medium / high effort.
//
// Keeping up: a newer version of a model in use is followed automatically. Whenever the list of
// Gemini models itself changes (a new family such as Hydrogen next to Argon, a new generation, a
// model withdrawn), a name can't say which model suits which slot, so Ghost asks the other brain to
// look up current benchmarks and propose a line-up (see modelAdvice.ts), and Aaron answers Use it
// or Not now. A line-up he accepts is stored as exact model ids in settings.brainModels.gemini.

export interface GeminiModel { id: string; version: number; family: string; effort: string | null }

/** Slot hints in settings.brainModels.gemini; anything else is a concrete model id used as it is. */
export type GeminiHint = 'flash' | 'top-medium' | 'top-high';

/** "gemini-4-argon-high" → { version 4, family "argon", effort "high" }. Not a usable chat model → null. */
export function parseGemini(id: string): GeminiModel | null {
  const m = id.match(/^gemini-(\d+(?:\.\d+)?)-([a-z][a-z0-9-]*?)(?:-(minimal|low|medium|high|xhigh|max))?$/);
  if (!m || /(^|-)(lite|image|tts|embed|embedding|live|audio)(-|$)/.test(m[2])) return null;
  return { id, version: Number(m[1]), family: m[2], effort: m[3] ?? null };
}

/** The Gemini chat models in a list from `agy models`, as given (other makers' models left out). */
export const geminiChatModels = (ids: string[]): string[] => ids.filter(id => parseGemini(id));

/** Each Gemini family on offer, at its newest version, in the order agy lists them. */
export function geminiFamilies(ids: string[]): { family: string; version: number }[] {
  const out: { family: string; version: number }[] = [];
  for (const g of ids.map(parseGemini)) {
    if (!g) continue;
    const seen = out.find(f => f.family === g.family);
    if (!seen) out.push({ family: g.family, version: g.version });
    else seen.version = Math.max(seen.version, g.version);
  }
  return out;
}

/**
 * The strongest Gemini family: one from the newest generation (Flash aside). Aaron's chosen family
 * wins while it's in that generation; otherwise the first one agy lists.
 */
export function topGeminiFamily(ids: string[], chosen = ''): string {
  const frontier = geminiFamilies(ids).filter(f => f.family !== 'flash');
  if (!frontier.length) return '';
  const newest = Math.max(...frontier.map(f => f.version));
  const candidates = frontier.filter(f => f.version === newest);
  return candidates.find(f => f.family === chosen)?.family ?? candidates[0].family;
}

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** The newest model of a family, at the effort nearest to `effort` (the calmer one on a tie). */
function nearest(ids: string[], family: string, effort: string | null): string {
  const want = Math.max(0, EFFORTS.indexOf(effort ?? 'medium'));
  const gap = (g: GeminiModel) => Math.abs(Math.max(0, EFFORTS.indexOf(g.effort ?? 'medium')) - want);
  const options = ids.map(parseGemini).filter((g): g is GeminiModel => !!g && g.family === family);
  options.sort((a, b) => b.version - a.version || gap(a) - gap(b) || EFFORTS.indexOf(a.effort ?? '') - EFFORTS.indexOf(b.effort ?? ''));
  return options[0]?.id ?? '';
}

/** The model id for a slot hint. Empty when nothing on offer fits (agy then uses its default). */
export function pickGemini(ids: string[], hint: string, chosenTop = ''): string {
  const want = hint === 'pro' ? 'top-high' : hint; // "pro": the old name for the Heavy slot
  if (want !== 'flash' && want !== 'top-medium' && want !== 'top-high') {
    // An exact model (picked by name, or from an accepted line-up). If Google has withdrawn it,
    // carry on with its family's newest model at the same effort, or failing that the strongest family's.
    const exact = parseGemini(want);
    if (!exact || ids.includes(want) || !ids.some(id => parseGemini(id))) return want;
    return nearest(ids, exact.family, exact.effort) || nearest(ids, topGeminiFamily(ids, chosenTop), exact.effort);
  }
  const family = want === 'flash' ? 'flash' : topGeminiFamily(ids, chosenTop);
  const order = want === 'top-high' ? ['high', 'medium', 'xhigh', 'max', 'low'] : ['medium', 'high', 'low', 'xhigh', 'max'];
  const rank = (e: string | null) => { const i = order.indexOf(e ?? ''); return i < 0 ? order.length : i; };
  const options = ids.map(parseGemini).filter((g): g is GeminiModel => !!g && g.family === family);
  options.sort((a, b) => b.version - a.version || rank(a.effort) - rank(b.effort));
  return options[0]?.id ?? '';
}

/** "argon" → "Argon", for notices. */
export const familyName = (family: string) => family.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

// ---------------------------------------------------------------- keeping up (the model watcher)

export type Slot = 'fast' | 'balanced' | 'deep';
export const SLOT_NAMES: Record<Slot, string> = { fast: 'Light', balanced: 'Balanced', deep: 'Heavy' };
export const SLOTS = Object.keys(SLOT_NAMES) as Slot[];

/** A line-up the other brain proposed after looking the models up, waiting for Aaron's answer. */
export interface ModelAdvice {
  slots: Record<Slot, { model: string; reason: string }>;
  summary: string; // what the new models are, in a sentence or two
  by: string; // who looked it up: "Claude" or "Gemini"
  news: string; // what set it off: "Gemini 4 Hydrogen is now on your plan."
  at: number;
}

/** What the watcher remembers between checks (data/models.json). */
export interface ModelWatchState {
  known: string[]; // Gemini families seen so far
  inUse: Partial<Record<Slot, string>>; // what each Gemini slot used at the last check
  catalog?: string[]; // the Gemini models on offer when the line-up was last looked into (sorted)
  advice: ModelAdvice | null; // a proposed line-up, waiting for Aaron's answer
}
export const EMPTY_WATCH: ModelWatchState = { known: [], inUse: {}, advice: null };

/** The list of Gemini models changed since the line-up was last looked into. */
export interface CatalogChange { catalog: string[]; added: string[]; removed: string[]; news: string }

export interface WatchResult {
  state: ModelWatchState;
  pinTop?: string; // the strongest family to remember as Aaron's choice (first check only)
  notices: { level: 'info' | 'warn'; text: string }[];
  changed?: CatalogChange; // time to ask the other brain which model suits which slot
}

const label = (ids: string[], family: string) => {
  const f = geminiFamilies(ids).find(x => x.family === family);
  return f ? `Gemini ${f.version} ${familyName(family)}` : `Gemini ${familyName(family)}`;
};
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** What changed, in a sentence for the notice: new families first, else new or withdrawn models. */
function describeChange(ids: string[], added: string[], removed: string[], knownFamilies: string[]): string {
  const families = [...new Set(added.map(id => parseGemini(id)!.family))];
  const fresh = families.filter(f => !knownFamilies.includes(f));
  if (fresh.length) return `${list(fresh.map(f => label(ids, f)))} ${fresh.length > 1 ? 'are' : 'is'} now on your plan.`;
  if (added.length) return `New Gemini models are on your plan: ${list(added.map(modelName))}.`;
  return `${list(removed.map(modelName))} ${removed.length > 1 ? 'are' : 'is'} no longer on your plan.`;
}

/**
 * One look at what agy offers: remember the strongest family on the first look, follow newer models
 * on its own (and say so), and report when the list itself has changed, so the line-up gets looked into.
 * `prev.catalog` is only moved on by the watcher, once that has been done.
 */
export function watchModels(ids: string[], prev: ModelWatchState, slots: Record<Slot, string>, chosenTop: string): WatchResult {
  if (!ids.some(id => parseGemini(id))) return { state: prev, notices: [] }; // agy unavailable: nothing to go on
  const first = !prev.known.length;
  const families = geminiFamilies(ids).map(f => f.family);
  // Never chosen yet: settle on the strongest family Aaron already has (a known one before a new one).
  let pinTop: string | undefined;
  if (!chosenTop) {
    const newest = geminiFamilies(ids).filter(f => f.family !== 'flash');
    const top = Math.max(...newest.map(f => f.version));
    pinTop = newest.find(f => f.version === top && prev.known.includes(f.family))?.family ?? topGeminiFamily(ids);
  }
  const effectiveTop = chosenTop || pinTop || '';
  const notices: WatchResult['notices'] = [];

  const inUse: Partial<Record<Slot, string>> = {};
  const moved: string[] = [];
  for (const slot of SLOTS) {
    const id = pickGemini(ids, slots[slot], effectiveTop);
    if (!id) continue;
    inUse[slot] = id;
    const before = prev.inUse[slot];
    if (!first && before && before !== id) moved.push(`${SLOT_NAMES[slot]}: ${modelName(id)}`);
  }
  if (moved.length) notices.push({ level: 'info', text: `Gemini moved to newer models. ${moved.join(', ')}.` });

  // The very first look only notes what's there. After that, any change to the list is looked into.
  // (An older Ghost kept no list: what's there now counts as known, except a family it had on offer.)
  const catalog = geminiChatModels(ids).sort();
  let base = first ? catalog : prev.catalog;
  if (!base) {
    const offered = (prev as { suggestion?: string | null }).suggestion; // an older Ghost's offer of a family, never answered
    base = offered ? catalog.filter(id => parseGemini(id)!.family !== offered) : catalog;
  }
  const added = catalog.filter(id => !base.includes(id));
  const removed = base.filter(id => !catalog.includes(id));
  const changed: CatalogChange | undefined = added.length || removed.length
    ? { catalog, added, removed, news: describeChange(ids, added, removed, geminiFamilies(base).map(f => f.family)) }
    : undefined;

  const state: ModelWatchState = {
    known: [...new Set([...prev.known.filter(f => families.includes(f) || !f.includes('-')), ...families])],
    inUse,
    catalog: base,
    advice: prev.advice,
  };
  return { state, pinTop, notices, changed };
}

/** "gemini-4-argon-high" → "Gemini 4 Argon (High)". */
export function modelName(id: string): string {
  const g = parseGemini(id);
  if (!g) return id;
  const effort = g.effort === 'xhigh' ? 'XHigh' : g.effort ? `${g.effort[0].toUpperCase()}${g.effort.slice(1)}` : '';
  return `Gemini ${g.version} ${familyName(g.family)}${effort ? ` (${effort})` : ''}`;
}
