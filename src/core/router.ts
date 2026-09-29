import type { ModelTier, ProviderId } from '../shared/settings';

export type ConcreteTier = Exclude<ModelTier, 'auto'>;

const DEEP = /\b(think (hard|carefully|deeply)|deep dive|in depth|thoroughly|step by step|architect|prove|strategy|trade-?offs?)\b/i;
const BALANCED = /\b(write|code|script|debug|fix|explain|analy[sz]e|compare|summari[sz]e|research|plan|draft|search|look up|find out|review|translate|calculate)\b/i;
const FAST = /^(hi|hey|hello|yo|thanks|thank you|cheers|good (morning|afternoon|evening|night)|how are you|what time|what'?s the (time|date)|open|launch|start|close|remind me|set (a )?(timer|reminder)|remember that|cancel)\b/i;

/** Picks how much model to spend on a message, to save subscription usage. */
export function routeTier(message: string, setting: ModelTier): ConcreteTier {
  if (setting !== 'auto') return setting;
  const text = message.trim();
  if (DEEP.test(text) || text.length > 600) return 'deep';
  if (FAST.test(text) && text.length < 120 && !BALANCED.test(text.replace(FAST, ''))) return 'fast';
  if (text.length < 40 && !BALANCED.test(text)) return 'fast';
  return 'balanced';
}

// Aliases resolve to the newest model of each family in the CLI. An empty string means "CLI default".
export const MODEL_MAP: Record<Exclude<ProviderId, 'mock'>, Record<ConcreteTier, string>> = {
  claude: { fast: 'haiku', balanced: 'sonnet', deep: 'opus' },
  // Families for Antigravity: the provider picks the newest matching id from `agy models`.
  gemini: { fast: 'flash', balanced: 'flash', deep: 'pro' },
};

export function modelFor(provider: ProviderId, tier: ConcreteTier): string {
  return provider === 'mock' ? `mock-${tier}` : MODEL_MAP[provider][tier];
}
