// Drops a pleasantry at the start of a reply ("Certainly, Aaron.", "Very good."), so Ghost starts
// with the answer itself. The persona asks for this too; this makes sure of it. The first few words
// are held back until the opening sentence is complete (or long enough to rule an opener out).

const OPENERS = [
  'certainly', 'very good', 'very well', 'of course', 'right away', 'absolutely', 'understood', 'noted', 'indeed',
  'sure', 'sure thing', 'excellent', 'splendid', 'good question', 'great question', 'excellent question', 'a fair question',
  'fair question', 'good', 'right', 'alright', 'all right', 'ah', 'well', 'okay', 'ok', 'yes', 'gladly', 'with pleasure',
  'my pleasure', 'happy to help', 'allow me', 'one moment', 'let me see',
];
const HOLD_LIMIT = 60;

export class OpenerFilter {
  private held = '';
  private decided = false;
  private readonly pattern: RegExp;

  constructor(userName: string) {
    const names = ['sir', userName].filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const words = OPENERS.sort((a, b) => b.length - a.length).join('|');
    // One or more openers, each ending in punctuation: "Certainly, Aaron. " / "Very good! " / "Sure, "
    this.pattern = new RegExp(`^\\s*(?:(?:${words})(?:,?\\s+(?:${names}))?\\s*(?:[.!,;:—–-]|\\.\\.\\.)\\s*)+`, 'i');
  }

  /** Feed a delta; returns the text that can go out now. */
  push(delta: string): string {
    if (this.decided) return delta;
    this.held += delta;
    // Decide once the first sentence is complete, or it's too long to be only a pleasantry.
    if (!/[.!?](\s|$)[\s\S]*\S/.test(this.held) && this.held.length < HOLD_LIMIT) return '';
    return this.release();
  }

  /** End of the reply: whatever is still held. */
  flush(): string { return this.decided ? '' : this.release(); }

  private release(): string {
    this.decided = true;
    const text = this.held;
    this.held = '';
    const m = text.match(this.pattern);
    if (!m) return text;
    const rest = text.slice(m[0].length);
    if (!rest.trim()) return text; // the whole reply is the pleasantry: keep it rather than say nothing
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
}
