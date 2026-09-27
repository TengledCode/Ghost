// "Ghost filter": makes a natural stock voice sound like a small synthetic companion. It uses a
// metallic comb resonance, a presence lift, a gently wobbling chorus and a whisper of ring
// modulation. `mix` 0 = clean voice, 1 = fully processed.
export class GhostFilter {
  readonly input: GainNode;
  readonly output: GainNode;
  private dry: GainNode;
  private wet: GainNode;
  private ring: GainNode;

  constructor(private readonly ctx: AudioContext, mix: number) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();

    const highpass = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' }) as BiquadFilterNode;
    highpass.frequency.value = 160;
    const presence = Object.assign(ctx.createBiquadFilter(), { type: 'peaking' }) as BiquadFilterNode;
    presence.frequency.value = 2600; presence.Q.value = 0.9; presence.gain.value = 5;
    const air = Object.assign(ctx.createBiquadFilter(), { type: 'highshelf' }) as BiquadFilterNode;
    air.frequency.value = 6500; air.gain.value = 4;

    // Short feedback comb: the "tiny metal shell" resonance.
    const comb = ctx.createDelay(0.05);
    comb.delayTime.value = 0.0042;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const combSum = ctx.createGain();

    // Chorus: a slowly modulated short delay.
    const chorus = ctx.createDelay(0.05);
    chorus.delayTime.value = 0.011;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.8;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.0018;
    lfo.connect(lfoDepth).connect(chorus.delayTime);
    lfo.start();

    // Ring modulation, blended in lightly for a digital edge.
    this.ring = ctx.createGain();
    this.ring.gain.value = 0;
    const carrier = ctx.createOscillator();
    carrier.frequency.value = 55;
    carrier.connect(this.ring.gain);
    carrier.start();
    const ringLevel = ctx.createGain();
    ringLevel.gain.value = 0.14;

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(highpass).connect(presence).connect(air);
    air.connect(combSum);
    air.connect(comb).connect(feedback).connect(comb);
    comb.connect(combSum);
    combSum.connect(this.wet);
    combSum.connect(chorus).connect(this.wet);
    combSum.connect(this.ring).connect(ringLevel).connect(this.wet);
    this.wet.connect(this.output);
    this.setMix(mix);
  }

  setMix(mix: number): void {
    const m = Math.min(1, Math.max(0, mix));
    const t = this.ctx.currentTime;
    this.dry.gain.setTargetAtTime(1 - m * 0.75, t, 0.05);
    this.wet.gain.setTargetAtTime(m * 0.55, t, 0.05);
  }
}
