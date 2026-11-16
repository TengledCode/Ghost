// Reveals Ghost's reply in step with its voice, like subtitles: each segment's words appear across
// the time its audio plays, starting exactly when that audio starts. Pure logic with an injectable
// clock (seconds), so it is unit-tested; the overlay feeds it events and renders its text.

interface Seg {
  display: string;
  words: string[]; // display split into words, whitespace kept, so partial text reads naturally
  hasAudio: boolean;
  silent?: boolean; // words to say but no voice (it failed): revealed at speaking pace anyway
  addedAt: number;
  startAt?: number; // when its audio starts (clock seconds)
  duration?: number;
}

/** If a segment's audio hasn't started this long after it could have, show its text anyway. */
export const NO_AUDIO_GRACE = 2.5;

/** About how fast Ghost speaks (characters a second), for revealing words that have no voice. */
export const SPOKEN_CHARS_PER_SECOND = 15;
const spokenFor = (text: string) => Math.max(0.6, text.trim().length / SPOKEN_CHARS_PER_SECOND);

export class Subtitles {
  private turnId = '';
  private segs = new Map<number, Seg>();
  private all: false | 'all' | 'voiced' = false;
  private rendered = '';
  private silentTurn = ''; // a turn revealed silently as a whole by the safety net, until its voice comes

  constructor(private readonly render: (text: string) => void, private readonly now: () => number = () => performance.now() / 1000) {}

  get activeTurn(): string { return this.turnId; }

  /** A new reply starts (or a standalone line such as a reminder). */
  begin(turnId: string): void {
    if (turnId === this.turnId) return;
    this.turnId = turnId;
    this.silentTurn = '';
    this.segs.clear();
    this.all = false;
    this.rendered = '';
  }

  /**
   * The text for one segment arrived with its audio. `hasAudio` false: nothing to say (a code block,
   * shown at once), or, with `failed`, its voice failed (revealed word by word at speaking pace).
   */
  add(turnId: string, seq: number, display: string, hasAudio: boolean, failed = false): void {
    if (turnId === this.silentTurn) {
      if (!hasAudio) return; // still no voice: the silent reveal carries on
      // The voice turned up after all: start again in step with it (the shown words stay until its
      // first word, so nothing blinks).
      this.silentTurn = '';
      this.segs.clear();
      this.all = false;
    }
    this.begin(turnId);
    if (this.segs.has(seq)) return;
    this.segs.set(seq, { display, words: display.split(/(?<=\s)/), hasAudio, silent: !hasAudio && failed, addedAt: this.now() });
    this.tick();
  }

  /**
   * No voice has come for a whole reply (the overlay's safety net): reveal its text word by word at
   * speaking pace, silently. If the voice turns up after all, the words start again in step with it.
   */
  showSilently(turnId: string, text: string): void {
    this.begin(turnId);
    this.silentTurn = turnId;
    this.segs.clear();
    this.segs.set(0, { display: text, words: text.split(/(?<=\s)/), hasAudio: false, silent: true, addedAt: this.now() });
    this.tick();
  }

  /** The player started this segment's audio at `at` (clock seconds) for `duration` seconds. */
  started(turnId: string, seq: number, at: number, duration: number): void {
    const s = turnId === this.turnId ? this.segs.get(seq) : undefined;
    if (!s) return;
    s.startAt = at;
    s.duration = Math.max(0.2, duration);
    this.tick();
  }

  /**
   * Show everything now: cancelled (`everything`), or the voice finished playing, when sentences
   * without a voice keep their speaking pace (the voice can finish early when sentences failed).
   */
  revealAll(turnId = this.turnId, everything = true): void {
    if (turnId !== this.turnId) return;
    this.all = everything ? 'all' : 'voiced';
    this.tick();
  }

  /** The text that should be visible right now. */
  visibleText(): string {
    const now = this.now();
    const order = [...this.segs.keys()].sort((a, b) => a - b);
    let out = '';
    let prevEnd = -Infinity; // when the previous segment finished revealing
    for (let i = 0; i < order.length; i++) {
      const seq = order[i];
      if (seq !== i) break; // wait for a missing earlier segment, so text never appears out of order
      const s = this.segs.get(seq)!;
      if (this.all === 'all' || (this.all === 'voiced' && !s.silent)) { out += s.display; continue; }
      // A sentence without its voice starts revealing as soon as it's its turn, as if spoken.
      if (s.silent && s.startAt === undefined) {
        s.startAt = Math.max(s.addedAt, Number.isFinite(prevEnd) ? prevEnd : s.addedAt);
        s.duration = spokenFor(s.display);
      }
      if (s.startAt !== undefined && s.duration !== undefined) {
        if (now < s.startAt) break;
        // Spread the words over ~90% of the audio so the last word lands just before it ends.
        const f = Math.min(1, (now - s.startAt) / (s.duration * 0.9));
        const shown = Math.min(s.words.length, Math.ceil(f * s.words.length));
        out += s.words.slice(0, shown).join('');
        if (shown < s.words.length) break;
        prevEnd = s.startAt + s.duration * 0.9;
        continue;
      }
      const readySince = Math.max(s.addedAt, Number.isFinite(prevEnd) ? prevEnd : s.addedAt);
      if (!s.hasAudio && (i === 0 || now >= prevEnd)) { out += s.display; prevEnd = Math.max(prevEnd, now); continue; }
      if (s.hasAudio && now - readySince > NO_AUDIO_GRACE) { out += s.display; prevEnd = now; continue; }
      break;
    }
    return out;
  }

  /** Re-render if the visible text changed. Call every animation frame while a reply is on screen. */
  tick(): void {
    const text = this.visibleText();
    if (text && text !== this.rendered) { this.rendered = text; this.render(text); }
  }
}
