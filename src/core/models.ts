// Which Gemini model each slot uses, from the ids `agy models` lists (e.g. gemini-4-argon-high,
// gemini-3.8-flash-medium). Gemini's slots are matched to Claude's: Light ≈ Haiku is the newest Flash,
// Balanced ≈ Sonnet and Heavy ≈ Opus are the strongest Gemini family at medium / high effort.
//
// Keeping up: a newer generation (Gemini 5 over Gemini 4) is taken automatically. A *new family* in
// the newest generation (Carbon next to Argon) can't be ranked from its name, so it's offered to
// Aaron instead (see suggestTopFamily); his choice is settings.geminiTopFamily.

export interface GeminiModel { id: string; version: number; family: string; effort: string | null }

/** Slot hints in settings.brainModels.gemini; anything else is a concrete model id used as it is. */
export type GeminiHint = 'flash' | 'top-medium' | 'top-high';

/** "gemini-4-argon-high" → { version 4, family "argon", effort "high" }. Not a usable chat model → null. */
export function parseGemini(id: string): GeminiModel | null {
  const m = id.match(/^gemini-(\d+(?:\.\d+)?)-([a-z][a-z0-9-]*?)(?:-(minimal|low|medium|high|max))?$/);
  if (!m || /(^|-)(lite|image|tts|embed|embedding|live|audio)(-|$)/.test(m[2])) return null;
  return { id, version: Number(m[1]), family: m[2], effort: m[3] ?? null };
}

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

/** The model id for a slot hint. Empty when nothing on offer fits (agy then uses its default). */
export function pickGemini(ids: string[], hint: string, chosenTop = ''): string {
  const want = hint === 'pro' ? 'top-high' : hint; // "pro": the old name for the Heavy slot
  if (want !== 'flash' && want !== 'top-medium' && want !== 'top-high') return want;
  const family = want === 'flash' ? 'flash' : topGeminiFamily(ids, chosenTop);
  const order = want === 'top-high' ? ['high', 'medium', 'max', 'low'] : ['medium', 'high', 'low', 'max'];
  const rank = (e: string | null) => { const i = order.indexOf(e ?? ''); return i < 0 ? order.length : i; };
  const options = ids.map(parseGemini).filter((g): g is GeminiModel => !!g && g.family === family);
  options.sort((a, b) => b.version - a.version || rank(a.effort) - rank(b.effort));
  return options[0]?.id ?? '';
}

/**
 * A family worth offering Aaron for Balanced and Heavy: new since last time (not in `known`), not
 * turned down before, and in the same newest generation as the one in use (a newer generation is
 * taken automatically, so it's never "offered").
 */
export function suggestTopFamily(ids: string[], known: string[], dismissed: string[], chosenTop = ''): string | null {
  const top = topGeminiFamily(ids, chosenTop);
  const topVersion = geminiFamilies(ids).find(f => f.family === top)?.version;
  const fresh = geminiFamilies(ids).find(f =>
    f.family !== 'flash' && f.family !== top && f.version === topVersion && !known.includes(f.family) && !dismissed.includes(f.family));
  return fresh?.family ?? null;
}

/** "argon" → "Argon", for notices. */
export const familyName = (family: string) => family.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

// ---------------------------------------------------------------- keeping up (the model watcher)

type Slot = 'fast' | 'balanced' | 'deep';
const SLOT_NAMES: Record<Slot, string> = { fast: 'Light', balanced: 'Balanced', deep: 'Heavy' };

/** What the watcher remembers between checks (data/models.json). */
export interface ModelWatchState {
  known: string[]; // Gemini families seen so far
  dismissed: string[]; // families Aaron said "Not now" to
  suggestion: string | null; // a family on offer, waiting for Aaron's answer
  inUse: Partial<Record<Slot, string>>; // what each Gemini slot used at the last check
}
export const EMPTY_WATCH: ModelWatchState = { known: [], dismissed: [], suggestion: null, inUse: {} };

export interface WatchResult {
  state: ModelWatchState;
  pinTop?: string; // the strongest family to remember as Aaron's choice (first check only)
  notices: { level: 'info' | 'warn'; text: string }[];
}

const label = (ids: string[], family: string) => {
  const f = geminiFamilies(ids).find(x => x.family === family);
  return f ? `Gemini ${f.version} ${familyName(family)}` : `Gemini ${familyName(family)}`;
};

/**
 * One look at what agy offers: remember the strongest family on the first look, follow newer models
 * on its own (and say so), and offer a new family in the newest generation instead of guessing.
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

  const suggestion = first ? null : suggestTopFamily(ids, prev.known, prev.dismissed, effectiveTop);
  if (suggestion && suggestion !== prev.suggestion) {
    notices.push({ level: 'warn', text: `${label(ids, suggestion)} is now on your plan, alongside ${familyName(effectiveTop)}. Use it for Balanced and Heavy? Settings → Brain.` });
  }

  const inUse: Partial<Record<Slot, string>> = {};
  const moved: string[] = [];
  for (const slot of Object.keys(SLOT_NAMES) as Slot[]) {
    const id = pickGemini(ids, slots[slot], effectiveTop);
    if (!id) continue;
    inUse[slot] = id;
    const before = prev.inUse[slot];
    if (!first && before && before !== id) moved.push(`${SLOT_NAMES[slot]}: ${modelName(id)}`);
  }
  if (moved.length) notices.push({ level: 'info', text: `Gemini moved to newer models. ${moved.join(', ')}.` });

  const state: ModelWatchState = {
    known: [...new Set([...prev.known, ...families])],
    dismissed: prev.dismissed,
    suggestion: suggestion ?? (prev.suggestion && families.includes(prev.suggestion) ? prev.suggestion : null),
    inUse,
  };
  return { state, pinTop, notices };
}

/** "gemini-4-argon-high" → "Gemini 4 Argon (High)". */
function modelName(id: string): string {
  const g = parseGemini(id);
  if (!g) return id;
  return `Gemini ${g.version} ${familyName(g.family)}${g.effort ? ` (${g.effort[0].toUpperCase()}${g.effort.slice(1)})` : ''}`;
}
