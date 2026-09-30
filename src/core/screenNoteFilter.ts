// When Ghost looked at a screenshot, the model ends its reply with <screen>brief description</screen>.
// That note is for the transcript in Obsidian (the image itself is never kept), so it is taken out
// of the stream before anything is shown or spoken. Tags may arrive split across deltas.

const OPEN = '<screen>';
const CLOSE = '</screen>';

export class ScreenNoteFilter {
  private held = '';
  private inside = false;
  private note = '';

  /** Feed a delta; returns the text that can go out now. */
  push(delta: string): string {
    this.held += delta;
    let out = '';
    for (;;) {
      if (this.inside) {
        const end = this.held.indexOf(CLOSE);
        if (end < 0) return out; // keep collecting the note
        this.note += this.held.slice(0, end);
        this.held = this.held.slice(end + CLOSE.length);
        this.inside = false;
        continue;
      }
      const start = this.held.indexOf(OPEN);
      if (start >= 0) {
        out += this.held.slice(0, start);
        this.held = this.held.slice(start + OPEN.length);
        this.inside = true;
        continue;
      }
      // Hold back a tail that could be the start of "<screen>".
      const keep = partialTail(this.held, OPEN);
      out += this.held.slice(0, this.held.length - keep);
      this.held = this.held.slice(this.held.length - keep);
      return out;
    }
  }

  /** End of the reply: anything held back that turned out not to be a tag. */
  flush(): string {
    const rest = this.inside ? '' : this.held;
    if (this.inside) this.note += this.held;
    this.held = '';
    this.inside = false;
    return rest;
  }

  /** What Ghost saw, if it said. */
  get screen(): string | undefined {
    const n = this.note.replace(/\s+/g, ' ').trim();
    return n || undefined;
  }
}

function partialTail(text: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (tag.startsWith(text.slice(-n))) return n;
  return 0;
}
