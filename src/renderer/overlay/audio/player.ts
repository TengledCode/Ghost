import { BandMeter } from './bands';
import { GhostFilter } from './ghostFilter';

export type KeepAlive = 'while-talking' | 'always' | 'off';

/** After this much silence the output device may have gone to sleep, so leave it time to wake. */
export const SILENCE_BEFORE_PREROLL = 3;
export const PREROLL = 0.25;
const LEAD = 0.03;
const KEEPALIVE_TAIL_MS = 20_000;

/**
 * When the next chunk should start: straight after the previous one (gapless), or, when nothing is
 * playing, a little ahead of now. That lead is longer after a silence, so a device that sleeps on
 * silence (Bluetooth headsets, some USB/Realtek outputs) is awake before the first word.
 */
export function chunkStart(now: number, playhead: number, lastSoundEnd: number, playing: boolean): number {
  if (playing && playhead > now) return playhead;
  const lead = now - lastSoundEnd > SILENCE_BEFORE_PREROLL ? PREROLL : LEAD;
  return Math.max(now + lead, playhead);
}

/** Plays the core's sentence-by-sentence audio gaplessly, in order, through the Ghost filter. */
export class VoicePlayer {
  readonly ctx = new AudioContext();
  readonly filter: GhostFilter;
  readonly master: GainNode;
  private meter: BandMeter;
  private playhead = 0;
  private lastSoundEnd = -Infinity;
  private turnId = '';
  private pending = new Map<number, AudioBuffer | null>();
  private nextSeq = 0;
  private lastSeq = -1;
  private sources = new Set<AudioBufferSourceNode>();
  private decodeChain: Promise<void> = Promise.resolve();
  private keepAliveGain: GainNode;
  private keepAliveMode: KeepAlive = 'while-talking';
  private keepAliveTimer = 0;
  onFinished: (turnId: string) => void = () => {};
  onStart: () => void = () => {};
  /** A chunk begins playing: `at` is on the performance clock (seconds), for syncing the subtitles. */
  onChunkStart: (turnId: string, seq: number, at: number, duration: number) => void = () => {};

  constructor(mix: number, volume: number) {
    this.filter = new GhostFilter(this.ctx, mix);
    this.master = this.ctx.createGain();
    this.master.gain.value = volume;
    this.filter.output.connect(this.master).connect(this.ctx.destination);
    // The shell's mouth movement reads the voice exactly as Aaron hears it (after the Ghost filter).
    const analyser = this.ctx.createAnalyser();
    this.master.connect(analyser);
    this.meter = new BandMeter(analyser);

    // Keep-alive: a looping whisper of noise at about -80 dBFS, inaudible, straight to the output
    // (it bypasses the analyser, so it never moves the shards). Feeding the device real, non-zero
    // samples stops it from sleeping and swallowing the first word of a reply.
    const noise = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 1e-4;
    const src = this.ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    this.keepAliveGain = this.ctx.createGain();
    this.keepAliveGain.gain.value = 0;
    src.connect(this.keepAliveGain).connect(this.ctx.destination);
    src.start();
  }

  /** Smoothed [low, mid, high] levels of the voice right now; zeros when nothing is playing. */
  bands(): [number, number, number] { return this.sources.size ? this.meter.read() : [0, 0, 0]; }

  setVolume(v: number): void { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  setKeepAlive(mode: KeepAlive): void {
    this.keepAliveMode = mode;
    this.setKeepAliveOn(mode === 'always');
  }

  /** Ghost is about to talk (thinking, a reminder): wake the output device now, well before speech. */
  wake(): void {
    if (this.keepAliveMode === 'off') return;
    clearTimeout(this.keepAliveTimer);
    this.setKeepAliveOn(true);
  }

  private setKeepAliveOn(on: boolean): void {
    if (on) void this.ctx.resume();
    this.keepAliveGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.05);
  }

  /** After speech, keep the device awake a little longer, then let it sleep (unless 'always'). */
  private relax(): void {
    if (this.keepAliveMode !== 'while-talking') return;
    clearTimeout(this.keepAliveTimer);
    this.keepAliveTimer = window.setTimeout(() => { if (this.sources.size === 0) this.setKeepAliveOn(false); }, KEEPALIVE_TAIL_MS);
  }

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
    this.wake();
    if (last) { this.lastSeq = seq; this.drain(); return; }
    const bytes = base64 ? Uint8Array.from(atob(base64), c => c.charCodeAt(0)) : null;
    this.decodeChain = this.decodeChain.then(async () => {
      if (turnId !== this.turnId) return;
      let buf: AudioBuffer | null = null;
      if (bytes) { try { buf = await this.ctx.decodeAudioData(bytes.buffer); } catch { buf = null; } }
      if (turnId !== this.turnId) return;
      // Make sure the clock is running before scheduling against it.
      if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* keeps trying on the next chunk */ } }
      this.pending.set(seq, buf);
      this.drain();
    });
  }

  private drain(): void {
    void this.ctx.resume();
    while (this.pending.has(this.nextSeq)) {
      const seq = this.nextSeq;
      const buf = this.pending.get(seq)!;
      this.pending.delete(seq);
      this.nextSeq++;
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.filter.input);
      const now = this.ctx.currentTime;
      const start = chunkStart(now, this.playhead, this.lastSoundEnd, this.sources.size > 0);
      if (this.sources.size === 0) this.onStart();
      src.start(start);
      this.playhead = start + buf.duration;
      this.sources.add(src);
      // Tell the subtitles when this chunk will actually be heard, on the page's own clock.
      this.onChunkStart(this.turnId, seq, performance.now() / 1000 + (start - now), buf.duration);
      src.onended = () => {
        this.sources.delete(src);
        this.lastSoundEnd = this.ctx.currentTime;
        this.checkDone();
      };
    }
    this.checkDone();
  }

  private checkDone(): void {
    if (this.lastSeq >= 0 && this.nextSeq >= this.lastSeq && this.sources.size === 0) {
      const id = this.turnId;
      this.lastSeq = -1;
      this.relax();
      this.onFinished(id);
    }
  }
}
