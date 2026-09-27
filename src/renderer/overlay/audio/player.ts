import { GhostFilter } from './ghostFilter';

/** Plays the core's sentence-by-sentence audio gaplessly, in order, through the Ghost filter. */
export class VoicePlayer {
  readonly ctx = new AudioContext();
  readonly filter: GhostFilter;
  readonly master: GainNode;
  private playhead = 0;
  private turnId = '';
  private pending = new Map<number, AudioBuffer | null>();
  private nextSeq = 0;
  private lastSeq = -1;
  private sources = new Set<AudioBufferSourceNode>();
  private decodeChain: Promise<void> = Promise.resolve();
  onFinished: (turnId: string) => void = () => {};
  onStart: () => void = () => {};

  constructor(mix: number, volume: number) {
    this.filter = new GhostFilter(this.ctx, mix);
    this.master = this.ctx.createGain();
    this.master.gain.value = volume;
    this.filter.output.connect(this.master).connect(this.ctx.destination);
  }

  setVolume(v: number): void { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  stop(): void {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    this.pending.clear();
    this.nextSeq = 0;
    this.lastSeq = -1;
    this.playhead = 0;
  }

  push(turnId: string, seq: number, base64: string, last: boolean): void {
    if (turnId !== this.turnId) { this.stop(); this.turnId = turnId; }
    if (last) { this.lastSeq = seq; this.drain(); return; }
    const bytes = base64 ? Uint8Array.from(atob(base64), c => c.charCodeAt(0)) : null;
    this.decodeChain = this.decodeChain.then(async () => {
      if (turnId !== this.turnId) return;
      let buf: AudioBuffer | null = null;
      if (bytes) { try { buf = await this.ctx.decodeAudioData(bytes.buffer); } catch { buf = null; } }
      if (turnId !== this.turnId) return;
      this.pending.set(seq, buf);
      this.drain();
    });
  }

  private drain(): void {
    void this.ctx.resume();
    while (this.pending.has(this.nextSeq)) {
      const buf = this.pending.get(this.nextSeq)!;
      this.pending.delete(this.nextSeq);
      this.nextSeq++;
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.filter.input);
      const start = Math.max(this.ctx.currentTime + 0.03, this.playhead);
      if (this.sources.size === 0) this.onStart();
      src.start(start);
      this.playhead = start + buf.duration;
      this.sources.add(src);
      src.onended = () => { this.sources.delete(src); this.checkDone(); };
    }
    this.checkDone();
  }

  private checkDone(): void {
    if (this.lastSeq >= 0 && this.nextSeq >= this.lastSeq && this.sources.size === 0) {
      const id = this.turnId;
      this.lastSeq = -1;
      this.onFinished(id);
    }
  }
}
