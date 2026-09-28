// Quick acknowledgements ("Noted.") spoken while a reply takes a moment. Each situation has its own
// pool, and each pool rotates through its lines without repeating the one just used.

export type AckPool = 'question' | 'task' | 'search' | 'deep' | 'screen';

export const ACKS: Record<AckPool, string[]> = {
  question: ['Noted.', 'A fair question. One moment.', 'Let me see.', 'Good question, Aaron. One moment.', 'Allow me a moment.'],
  task: ['Very good.', 'Right away.', 'Leave it with me.', 'Consider it in hand.', 'Certainly, Aaron.'],
  search: ['Looking into it.', 'Allow me to check.', "I'll find out.", 'Let me look that up.'],
  deep: ['That deserves some thought.', 'Allow me to think this through.', 'Give me a moment with this one.'],
  screen: ['Let me take a look.', 'Having a look now.', "One moment, I'll see what's there."],
};

/** Every line, with the user's name swapped in (for pre-recording the audio). */
export function allAckLines(userName: string): string[] {
  return Object.values(ACKS).flat().map(l => withName(l, userName));
}

export function withName(line: string, userName: string): string { return line.replace(/\bAaron\b/g, userName); }

const SEARCH = /\b(search|look (it |that )?up|find out|latest|news|weather|forecast|price of|score|who won|google)\b/i;
const TASK = /^(please |could you |can you |would you )?(open|launch|start|close|write|make|create|draft|set|remind|run|save|delete|move|rename|send|add|remember|fix|build|generate|schedule|cancel|play|turn)\b/i;

/** Which pool fits this message. */
export function classifyAck(message: string, tier: 'fast' | 'balanced' | 'deep', screen: boolean): AckPool {
  if (screen) return 'screen';
  if (tier === 'deep') return 'deep';
  if (SEARCH.test(message)) return 'search';
  if (TASK.test(message.trim())) return 'task';
  return 'question';
}

/** Rotates through each pool in a shuffled order, never repeating a line back to back. */
export class AckPicker {
  private decks = new Map<AckPool, string[]>();
  private last = new Map<AckPool, string>();

  constructor(private readonly random: () => number = Math.random) {}

  next(pool: AckPool): string {
    let deck = this.decks.get(pool);
    if (!deck?.length) {
      deck = shuffle([...ACKS[pool]], this.random);
      // A new round mustn't open with the line that closed the last one.
      if (deck.length > 1 && deck[deck.length - 1] === this.last.get(pool)) [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
      this.decks.set(pool, deck);
    }
    const line = deck.pop()!;
    this.last.set(pool, line);
    return line;
  }
}

function shuffle<T>(a: T[], random: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
