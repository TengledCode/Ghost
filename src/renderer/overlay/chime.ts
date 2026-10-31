// A short, soft chime for notices, made with Web Audio (no sound files). Info is one gentle note,
// a warning two rising notes, an error two falling, lower ones.
type Level = 'info' | 'warn' | 'error';

const NOTES: Record<Level, number[]> = { info: [1318.5], warn: [987.8, 1318.5], error: [659.3, 493.9] };
let ctx: AudioContext | null = null;

export function playChime(level: Level, volume: number): void {
  if (volume <= 0) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const start = ctx.currentTime + 0.02;
    NOTES[level].forEach((freq, i) => {
      const t = start + i * 0.11;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      // A quick, soft attack and a gentle ring-out: a chime, not a beep.
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35 * volume, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch { /* no audio output: the notice still shows */ }
}
