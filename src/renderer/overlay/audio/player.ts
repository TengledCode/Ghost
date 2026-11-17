import { BandMeter } from './bands';
import type { VoiceCharacter } from '../../../shared/settings';
import { GhostFilter } from './ghostFilter';
import { pauseAfter, speechBounds } from './trim';

export type KeepAlive = 'while-talking' | 'always' | 'off';

/** After this much silence the output device may have gone to sleep, so leave it time to wake. */
export const SILENCE_BEFORE_PREROLL = 3;
export const PREROLL = 0.25;
/** Time a sleeping Bluetooth headset needs to wake once real signal reaches it. */
export const WAKE_TIME = 0.9;
const LEAD = 0.03;
const FADE_IN = 0.015;
/** Every piece fades in and out this fast, so trimming a recording never clicks. */
const EDGE_FADE = 0.005;
/** Keep-alive tone: 20 Hz at about -46 dBFS. Far below hearing at that pitch, but real signal to a Bluetooth codec. */
const KEEPALIVE_HZ = 20;
const KEEPALIVE_LEVEL = 0.005;
const KEEPALIVE_TAIL_MS = 20_000;

/**
 * When the next chunk should start: straight after the previous one (gapless), or, when nothing is
 * playing, a little ahead of now. After a silence the device may be asleep (Bluetooth headsets
 * especially), so the first word waits until it has had WAKE_TIME of keep-alive signal to wake up.
 * `warmFor`: seconds the keep-alive has been playing (0 if it's off).
 */
export function chunkStart(now: number, playhead: number, lastSoundEnd: number, playing: boolean, warmFor = Infinity): number {
  if (playing && playhead > now) return playhead;
  const silent = now - lastSoundEnd > SILENCE_BEFORE_PREROLL;
  const lead = silent ? Math.max(PREROLL, WAKE_TIME - warmFor) : LEAD;
  return Math.max(now + lead, playhead);
}

/**
 * Plays the core's sentence-by-sentence audio in order, through the Ghost filter: only the speech in
 * each recording (its padding of silence is trimmed), with a natural pause between pieces (trim.ts).
 */
export class VoicePlayer {
  readonly ctx = new AudioContext();
  readonly filter: GhostFilter;
  readonly master: GainNode;
  private meter: BandMeter;
  private playhead = 0;
  private lastSoundEnd = -Infinity;
  private turnId = '';
  private pending = new Map<number, { buf: AudioBuffer | null; pause: number }>();
  private nextSeq = 0;
  private lastSeq = -1;
  private sources = new Set<AudioBufferSourceNode>();
  private decodeChain: Promise<void> = Promise.resolve();
  private keepAliveGain: GainNode;
  private keepAliveSince: number | null = null; // ctx time the keep-alive tone started
  private keepAliveMode: KeepAlive = 'while-talking';
  private keepAliveTimer = 0;
  onFinished: (turnId: string) => void = () => {};
  onStart: () => void = () => {};
  /** A chunk begins playing: `at` is on the performance clock (seconds), for syncing the subtitles. */
  onChunkStart: (turnId: string, seq: number, at: number, duration: number) => void = () => {};

  constructor(mix: number, volume: number, character: VoiceCharacter = 'companion') {
    this.filter = new GhostFilter(this.ctx, mix, character);
    this.master = this.ctx.createGain();
    this.master.gain.value = volume;
    this.filter.output.connect(this.master).connect(this.ctx.destination);
    // The shell's mouth movement reads the voice exactly as Aaron hears it (after the Ghost filter).
    const analyser = this.ctx.createAnalyser();
    this.master.connect(analyser);
    this.meter = new BandMeter(analyser);

    // Keep-alive: a 20 Hz tone at about -46 dBFS, straight to the output (it bypasses the analyser,
    // so it never moves the shards). It's inaudible, but unlike near-silent noise it survives the
    // Windows volume and the Bluetooth codec as real signal, so a headset stays awake and doesn't
    // swallow the first word of a reply.
    const tone = this.ctx.createOscillator();
    tone.frequency.value = KEEPALIVE_HZ;
    this.keepAliveGain = this.ctx.createGain();
    this.keepAliveGain.gain.value = 0;
    tone.connect(this.keepAliveGain).connect(this.ctx.destination);
    tone.start();
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
    if (on && this.keepAliveSince === null) this.keepAliveSince = this.ctx.currentTime;
    if (!on) this.keepAliveSince = null;
    this.keepAliveGain.gain.setTargetAtTime(on ? KEEPALIVE_LEVEL : 0, this.ctx.currentTime, 0.05);
  }

  /** How long the output has been fed keep-alive signal (seconds). */
  private warmFor(): number { return this.keepAliveSince === null ? 0 : this.ctx.currentTime - this.keepAliveSince; }

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

  /** `display`: the reply text this piece speaks, which sets the pause after it (a comma, a sentence). */
  push(turnId: string, seq: number, base64: string, last: boolean, display?: string): void {
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
      this.pending.set(seq, { buf, pause: pauseAfter(display) });
      this.drain();
    });
  }

  private drain(): void {
    void this.ctx.resume();
    while (this.pending.has(this.nextSeq)) {
      const seq = this.nextSeq;
      const { buf, pause } = this.pending.get(seq)!;
      this.pending.delete(seq);
      this.nextSeq++;
      if (!buf) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      // The Ghost character plays the voice slightly fast: a smaller-sounding speaker.
      const rate = this.filter.rate;
      src.playbackRate.value = rate;
      const channels = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
      const speech = speechBounds(channels, buf.sampleRate);
      const length = speech.end - speech.start; // seconds of the recording
      const duration = length / rate; // seconds on the clock
      const now = this.ctx.currentTime;
      // Mid-reply (the previous piece, or the pause after it, isn't over yet): straight on after it.
      const following = this.playhead > now;
      const start = chunkStart(now, this.playhead, this.lastSoundEnd, following, this.warmFor());
      // Fade in (longer after silence, so a device waking up doesn't click) and out.
      const fade = this.ctx.createGain();
      const fadeIn = following ? EDGE_FADE : FADE_IN;
      fade.gain.setValueAtTime(0, start);
      fade.gain.linearRampToValueAtTime(1, start + fadeIn);
      fade.gain.setValueAtTime(1, Math.max(start + fadeIn, start + duration - EDGE_FADE));
      fade.gain.linearRampToValueAtTime(0, start + duration);
      src.connect(fade).connect(this.filter.input);
      if (this.sources.size === 0) this.onStart();
      src.start(start, speech.start, length);
      this.playhead = start + duration + pause;
      this.sources.add(src);
      // Tell the subtitles when this chunk will actually be heard, on the page's own clock.
      this.onChunkStart(this.turnId, seq, performance.now() / 1000 + (start - now), duration);
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
