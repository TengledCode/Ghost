// Reveals Ghost's reply in step with its voice, like subtitles: each segment's words appear across
// the time its audio plays, starting exactly when that audio starts. Pure logic with an injectable
// clock (seconds), so it is unit-tested; the overlay feeds it events and renders its text.

interface Seg {
  display: string;
  words: string[]; // display split into words, whitespace kept, so partial text reads naturally
  hasAudio: boolean;
  addedAt: number;
  startAt?: number; // when its audio starts (clock seconds)
  duration?: number;
}

/** If a segment's audio hasn't started this long after it could have, show its text anyway. */
export const NO_AUDIO_GRACE = 2.5;

export class Subtitles {
  private turnId = '';
  private segs = new Map<number, Seg>();
  private all = false;
  private rendered = '';

  constructor(private readonly render: (text: string) => void, private readonly now: () => number = () => performance.now() / 1000) {}

  get activeTurn(): string { return this.turnId; }

  /** A new reply starts (or a standalone line such as a reminder). */
  begin(turnId: string): void {
    if (turnId === this.turnId) return;
    this.turnId = turnId;
    this.segs.clear();
    this.all = false;
    this.rendered = '';
  }

  /** The text for one segment arrived with its audio (`hasAudio` false: nothing to say, e.g. a code block). */
  add(turnId: string, seq: number, display: string, hasAudio: boolean): void {
    this.begin(turnId);
    if (this.segs.has(seq)) return;
    this.segs.set(seq, { display, words: display.split(/(?<=\s)/), hasAudio, addedAt: this.now() });
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

  /** Playback finished, was cancelled, or voice is unavailable: show everything now. */
  revealAll(turnId = this.turnId): void {
    if (turnId !== this.turnId) return;
    this.all = true;
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
      if (this.all) { out += s.display; continue; }
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
