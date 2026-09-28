// Turns a stream of text deltas into speakable sentences so TTS can start before the reply is done.

const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|approx|No)\.$/i;
const MIN_CHARS = 12; // merge very short fragments ("Right.") into the next sentence
const FIRST_CLAUSE_CHARS = 18; // the opening clause may be spoken on its own once it's this long

/** One piece of the reply: the text exactly as written, and how it should be spoken (may be empty). */
export interface Segment { display: string; speech: string }

export class SentenceSplitter {
  private buffer = '';
  private first = true;

  /** `firstClause`: the reply's opening segment may end at a comma or semicolon, so the voice starts sooner. */
  constructor(private readonly firstClause = false) {}

  /** Feed a delta; returns zero or more complete segments. Concatenated displays reproduce the text exactly. */
  push(delta: string): Segment[] {
    this.buffer += delta;
    const out: Segment[] = [];
    for (;;) {
      const cut = this.findBoundary();
      if (cut < 0) break;
      const display = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (display.trim()) { out.push({ display, speech: this.toSpeech(display) }); this.first = false; }
    }
    return out;
  }

  /** Flush whatever is left at the end of the turn. */
  flush(): Segment[] {
    const display = this.buffer;
    this.buffer = '';
    return display.trim() ? [{ display, speech: this.toSpeech(display) }] : [];
  }

  private findBoundary(): number {
    const text = this.buffer;
    for (let i = 0; i < text.length; i++) {
      if (text.startsWith('```', i)) {
        const close = text.indexOf('```', i + 3);
        if (close < 0) return -1; // wait for the whole code block
        i = close + 2;
        continue;
      }
      const ch = text[i];
      if (ch === '\n' && text[i + 1] === '\n' && i >= 1) return i + 2;
      if (this.firstClause && this.first && (ch === ',' || ch === ';' || ch === '—') && /\s/.test(text[i + 1] ?? '')) {
        const head = text.slice(0, i + 1).trim();
        if (head.length >= FIRST_CLAUSE_CHARS && head.split(/\s+/).length >= 3 && !head.includes('`')) return i + 1;
      }
      if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
      const next = text[i + 1];
      if (next === undefined) return -1; // could be "3." of "3.14"; wait for more
      if (!/[\s"')\]]/.test(next)) continue;
      const head = text.slice(0, i + 1);
      if (ch === '.' && ABBREVIATIONS.test(head)) continue;
      if (head.trim().length < MIN_CHARS) continue;
      let end = i + 1;
      while (end < text.length && /["')\]]/.test(text[end])) end++;
      return end;
    }
    return -1;
  }

  /** Strip markdown so the voice doesn't read symbols aloud. */
  private toSpeech(text: string): string {
    let t = text.replace(/```[\s\S]*?```/g, ' (the code is in the transcript) ');
    t = t
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'the link')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/[*_~>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return /[\p{L}\p{N}]/u.test(t) ? t : '';
  }
}
