// "Ghost filter": turns a natural stock voice into a small synthetic companion. The wet path is a
// band-limited "small speaker" EQ, a short metallic comb (the shell), light saturation, a wobbling
// chorus and a touch of ring modulation. The character preset sets how synthetic it gets, including
// a slight speed-up that raises pitch and formants so the voice sounds like it comes from something
// small. `mix` 0 = clean voice, 1 = fully processed.

import type { VoiceCharacter } from '../../../shared/settings';

export interface CharacterParams {
  rate: number; // playback rate: pitch and formants up, speech slightly quicker
  highpass: number; // Hz: thinner low end = smaller body
  presence: number; // dB boost around presenceHz
  presenceHz: number;
  combMs: number; // shell size: shorter = smaller, brighter ring
  combFeedback: number;
  ring: number; // ring-mod blend
  ringHz: number;
  drive: number; // 0 - 1 saturation
  chorusDepth: number; // seconds of delay modulation
  level: number; // makeup gain for the wet path, so every character sounds about as loud as the plain voice
}

export const CHARACTERS: Record<VoiceCharacter, CharacterParams> = {
  natural: { rate: 1, highpass: 110, presence: 3, presenceHz: 2600, combMs: 4.2, combFeedback: 0.22, ring: 0.05, ringHz: 55, drive: 0, chorusDepth: 0.0012, level: 0.8 },
  companion: { rate: 1.035, highpass: 190, presence: 5, presenceHz: 2900, combMs: 3.1, combFeedback: 0.42, ring: 0.14, ringHz: 72, drive: 0.25, chorusDepth: 0.002, level: 0.6 },
  drone: { rate: 1.07, highpass: 260, presence: 6.5, presenceHz: 3300, combMs: 2.3, combFeedback: 0.55, ring: 0.24, ringHz: 96, drive: 0.5, chorusDepth: 0.0028, level: 0.5 },
};

export class GhostFilter {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private highpass: BiquadFilterNode;
  private presence: BiquadFilterNode;
  private comb: DelayNode;
  private feedback: GainNode;
  private shaper: WaveShaperNode;
  private lfoDepth: GainNode;
  private carrier: OscillatorNode;
  private ringLevel: GainNode;
  private wetLevel: GainNode;
  private mix = 0.5;
  /** Playback rate the player applies to each chunk (part of the character). */
  rate = 1;

  constructor(private readonly ctx: AudioContext, mix: number, character: VoiceCharacter = 'companion') {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.wetLevel = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();

    this.highpass = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }) as BiquadFilterNode;
    this.presence = Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }) as BiquadFilterNode;
    this.presence.Q.value = 0.9;
    const air = Object.assign(ctx.createBiquadFilter(), { type: 'highshelf' }) as BiquadFilterNode;
    air.frequency.value = 6500; air.gain.value = 3;
    // A small speaker doesn't reproduce the very top either.
    const lowpass = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' }) as BiquadFilterNode;
    lowpass.frequency.value = 9500;

    // Short feedback comb: the metal shell's resonance.
    this.comb = ctx.createDelay(0.05);
    this.feedback = ctx.createGain();
    const combSum = ctx.createGain();

    // Gentle saturation: a slightly "electronic" edge.
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';

    // Chorus: a slowly modulated short delay.
    const chorus = ctx.createDelay(0.05);
    chorus.delayTime.value = 0.011;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.8;
    this.lfoDepth = ctx.createGain();
    lfo.connect(this.lfoDepth).connect(chorus.delayTime);
    lfo.start();

    // Ring modulation, blended in lightly for a digital edge.
    const ring = ctx.createGain();
    ring.gain.value = 0;
    this.carrier = ctx.createOscillator();
    this.carrier.connect(ring.gain);
    this.carrier.start();
    this.ringLevel = ctx.createGain();

    // Evens out the level so every character sounds about as loud.
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -20; glue.ratio.value = 3; glue.attack.value = 0.005; glue.release.value = 0.12; glue.knee.value = 8;

    // A soft clipper on the sum: normal levels pass untouched, peaks from loud TTS plus the shell
    // resonance are rounded off instead of clipping. (A compressor node would add its own makeup gain.)
    const sum = ctx.createGain();
    const clipper = ctx.createWaveShaper();
    clipper.curve = softClipCurve();
    clipper.oversample = '2x';
    sum.connect(clipper).connect(this.output);

    this.input.connect(this.dry).connect(sum);
    this.input.connect(this.highpass).connect(this.presence).connect(air).connect(lowpass);
    lowpass.connect(combSum);
    lowpass.connect(this.comb).connect(this.feedback).connect(this.comb);
    this.comb.connect(combSum);
    combSum.connect(this.shaper);
    this.shaper.connect(this.wet);
    this.shaper.connect(chorus).connect(this.wet);
    this.shaper.connect(ring).connect(this.ringLevel).connect(this.wet);
    this.wet.connect(glue).connect(this.wetLevel).connect(sum);
    this.setCharacter(character);
    this.setMix(mix);
  }

  setMix(mix: number): void {
    this.mix = Math.min(1, Math.max(0, mix));
    const t = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(1 - this.mix * 0.8, t, 0.05);
    this.wet.gain.setTargetAtTime(this.mix * 0.6, t, 0.05);
  }

  setCharacter(name: VoiceCharacter): void {
    const c = CHARACTERS[name] ?? CHARACTERS.companion;
    const t = this.ctx.currentTime;
    this.rate = c.rate;
    this.highpass.frequency.setTargetAtTime(c.highpass, t, 0.05);
    this.presence.frequency.setTargetAtTime(c.presenceHz, t, 0.05);
    this.presence.gain.setTargetAtTime(c.presence, t, 0.05);
    this.comb.delayTime.setTargetAtTime(c.combMs / 1000, t, 0.05);
    this.feedback.gain.setTargetAtTime(c.combFeedback, t, 0.05);
    this.carrier.frequency.setTargetAtTime(c.ringHz, t, 0.05);
    this.ringLevel.gain.setTargetAtTime(c.ring, t, 0.05);
    this.lfoDepth.gain.setTargetAtTime(c.chorusDepth, t, 0.05);
    this.wetLevel.gain.setTargetAtTime(c.level, t, 0.05);
    this.shaper.curve = saturationCurve(c.drive);
  }
}

/** Soft-clipping curve; drive 0 is a straight line. */
export function saturationCurve(drive: number, n = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const k = 1 + drive * 6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = drive <= 0 ? x : Math.tanh(k * x) / norm;
  }
  return curve;
}

/** Linear up to 0.7, then a smooth knee that never exceeds 0.98. */
export function softClipCurve(n = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const knee = 0.7, room = 0.98 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1; // the node maps input -1..1 onto the curve (louder input holds the end value)
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
