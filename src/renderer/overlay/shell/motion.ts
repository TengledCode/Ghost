// Pure motion logic for the Ghost shell: springs, per-state poses, idle curiosity, and the adaptive
// quality governor. It has no three.js or DOM, so it is unit-testable and deterministic with a seeded RNG.
import type { GhostState } from '../../../shared/protocol';

/** Damped spring. zeta = 1 is critically damped, and < 1 overshoots a little, which reads as "alive". */
export class Spring {
  velocity = 0;
  constructor(public value: number, public target = value, public stiffness = 60, public zeta = 1) {}

  step(dt: number): number {
    // Sub-step for stability at low frame rates.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    const damping = 2 * this.zeta * Math.sqrt(this.stiffness);
    for (let i = 0; i < steps; i++) {
      const accel = this.stiffness * (this.target - this.value) - damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }

  kick(v: number): void { this.velocity += v; }
  snap(v: number): void { this.value = this.target = v; this.velocity = 0; }
}

export type GlowTone = 'theme' | 'amber' | 'red';

export interface Pose {
  split: number; // 0 = locked shut, 1 = fully unfolded
  twist: number; // rad, each segment rotated about its own axis
  frontSpin: number; // rad/s, the front segment set rotating about the eye axis
  rearSpin: number;
  sweep: number; // side-to-side scanning amplitude (rad)
  bob: number; // hover amplitude multiplier
  iris: number; // iris scale (dilation)
  glow: number; // seam and core glow intensity (1 = normal, feeds bloom)
  tone: GlowTone;
  eye: [number, number, number, number]; // particle weights: idle, listening, thinking, speaking
  scan: number; // particle rings (searching)
  flicker: number;
  curious: boolean; // idle glances allowed
}

export const POSES: Record<GhostState, Pose> = {
  idle: { split: 0.1, twist: 0, frontSpin: 0, rearSpin: 0, sweep: 0, bob: 1, iris: 1, glow: 0.9, tone: 'theme', eye: [1, 0, 0, 0], scan: 0, flicker: 0, curious: true },
  listening: { split: 0.14, twist: 0.12, frontSpin: 0, rearSpin: 0, sweep: 0, bob: 0.6, iris: 1.18, glow: 1.1, tone: 'theme', eye: [0, 1, 0, 0], scan: 0, flicker: 0, curious: false },
  thinking: { split: 0.42, twist: 0.35, frontSpin: 1.4, rearSpin: -0.9, sweep: 0, bob: 0.4, iris: 0.85, glow: 1.25, tone: 'amber', eye: [0, 0, 1, 0], scan: 0, flicker: 0, curious: false },
  searching: { split: 0.85, twist: 0.6, frontSpin: 0.6, rearSpin: 2.2, sweep: 0.45, bob: 0.3, iris: 1.05, glow: 1.3, tone: 'theme', eye: [0, 0, 0.3, 0], scan: 1, flicker: 0, curious: false },
  speaking: { split: 0.22, twist: 0.08, frontSpin: 0.15, rearSpin: -0.1, sweep: 0, bob: 0.5, iris: 1.1, glow: 1.15, tone: 'theme', eye: [0, 0, 0, 1], scan: 0, flicker: 0, curious: false },
  done: { split: 0.02, twist: 0, frontSpin: 0, rearSpin: 0, sweep: 0, bob: 1, iris: 1, glow: 1, tone: 'theme', eye: [1, 0, 0, 0], scan: 0, flicker: 0, curious: false },
  approval: { split: 0.35, twist: 0.2, frontSpin: 0, rearSpin: 0.25, sweep: 0, bob: 0.3, iris: 1.2, glow: 1.3, tone: 'amber', eye: [0.6, 0.4, 0, 0], scan: 0, flicker: 0.25, curious: false },
  error: { split: 0.12, twist: 0.05, frontSpin: 0, rearSpin: 0, sweep: 0, bob: 0.2, iris: 0.8, glow: 1.2, tone: 'red', eye: [1, 0, 0, 0], scan: 0, flicker: 0.9, curious: false },
};

/** One-off flourishes when entering a state (velocity kicks applied to the springs). */
export interface Flourish { spinKick: number; splitKick: number; nod: number; flash: number; shake: number }

export function flourishFor(prev: GhostState, next: GhostState): Flourish {
  const f: Flourish = { spinKick: 0, splitKick: 0, nod: 0, flash: 0, shake: 0 };
  if (next === 'thinking' && prev !== 'thinking') { f.spinKick = 6; f.splitKick = 3; } // plates unlock with a twist
  if (next === 'searching') { f.splitKick = 4; f.spinKick = -4; }
  if (next === 'done') { f.nod = 1; f.flash = 1; f.splitKick = -3; } // snap shut, nod
  if (next === 'error') f.shake = 1;
  if (next === 'approval') f.flash = 0.4; // a little flare of attention; the gaze itself goes to the card
  return f;
}

// ---------------------------------------------------------------- idle curiosity

export type Rng = () => number;

export function seededRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export type CuriousAct =
  | { kind: 'glance'; yaw: number; pitch: number; hold: number }
  | { kind: 'tilt'; roll: number; hold: number }
  | { kind: 'blink' }
  | { kind: 'spin' }
  | { kind: 'shake' };

/** Schedules small idle behaviours: glances every 4–9 s, blinks, and rarely a spin or a shake. */
export class Curiosity {
  private next: number;
  private sinceBig = 0;

  constructor(private readonly rng: Rng = Math.random, private now = 0) { this.next = now + this.gap(); }

  private gap(): number { return 4 + this.rng() * 5; }

  /** Advance time; returns an act when one is due. */
  update(time: number): CuriousAct | null {
    const dt = time - this.now;
    this.now = time;
    this.sinceBig += dt;
    if (time < this.next) return null;
    this.next = time + this.gap();
    const r = this.rng();
    if (this.sinceBig > 120 && r < 0.35) {
      this.sinceBig = 0;
      return this.rng() < 0.6 ? { kind: 'spin' } : { kind: 'shake' };
    }
    if (r < 0.25) return { kind: 'blink' };
    if (r < 0.45) return { kind: 'tilt', roll: (this.rng() - 0.5) * 0.7, hold: 1.2 + this.rng() * 1.5 };
    return { kind: 'glance', yaw: (this.rng() - 0.5) * 1.1, pitch: (this.rng() - 0.5) * 0.6, hold: 1 + this.rng() * 2 };
  }

  /** Something happened (typing, state change): push the next idle act further out. */
  reset(time: number): void { this.now = time; this.next = time + this.gap(); }
}

// ---------------------------------------------------------------- cursor

/**
 * Converts a cursor offset from the shell centre (px) into a look direction (rad), treating the
 * screen as a flat plane `distance` px in front of Ghost. The angle keeps changing all the way
 * across a large monitor (no blind spot), and the vertical angle is measured over the true
 * distance, so a far-left point slightly above still reads as "left".
 */
export function lookAt(dx: number, dy: number, maxAngle = 1.15, distance = 900): { yaw: number; pitch: number } {
  const clamp = (v: number) => Math.max(-maxAngle, Math.min(maxAngle, v));
  return { yaw: clamp(Math.atan2(dx, distance)), pitch: clamp(Math.atan2(dy, Math.hypot(dx, distance))) };
}

// ---------------------------------------------------------------- adaptive quality

export type QualityLevel = 'high' | 'medium' | 'low';
export const QUALITY: Record<QualityLevel, { dpr: number; bloom: number; fps: number }> = {
  high: { dpr: 2, bloom: 1, fps: 60 },
  medium: { dpr: 1.5, bloom: 0.5, fps: 60 },
  low: { dpr: 1, bloom: 0, fps: 30 },
};

/**
 * Steps quality down after ~2 s of slow frames and back up after ~20 s of comfortable ones.
 * While the shell is idle for a while, frames are capped at 30 fps to save GPU time.
 */
export class QualityGovernor {
  level: QualityLevel;
  private slow = 0;
  private fast = 0;
  constructor(private mode: 'auto' | QualityLevel = 'auto') { this.level = mode === 'auto' ? 'high' : mode; }

  setMode(mode: 'auto' | QualityLevel): void { this.mode = mode; this.level = mode === 'auto' ? 'high' : mode; this.slow = this.fast = 0; }

  /** Feed the measured frame time (s). Returns true if the level changed. */
  sample(frameTime: number): boolean {
    if (this.mode !== 'auto') return false;
    const budget = 1 / QUALITY[this.level].fps;
    if (frameTime > budget * 1.6) { this.slow += frameTime; this.fast = 0; }
    else if (frameTime < budget * 0.7) { this.fast += frameTime; this.slow = Math.max(0, this.slow - frameTime); }
    const order: QualityLevel[] = ['high', 'medium', 'low'];
    const i = order.indexOf(this.level);
    if (this.slow > 2 && i < 2) { this.level = order[i + 1]; this.slow = this.fast = 0; return true; }
    if (this.fast > 20 && i > 0) { this.level = order[i - 1]; this.slow = this.fast = 0; return true; }
    return false;
  }

  frameInterval(idleFor: number): number {
    const fps = idleFor > 30 ? Math.min(30, QUALITY[this.level].fps) : QUALITY[this.level].fps;
    return 1 / fps;
  }
}

// ---------------------------------------------------------------- speech emphasis

/**
 * Detects emphasis in speech: moments where the voice rises clearly above its own recent level
 * (a stressed word, a lift in pitch/brightness), rather than every syllable. Returns a pulse
 * strength 0–1 when one begins, and 0 otherwise. All shards pulse together on it.
 */
export class EmphasisDetector {
  private fast = 0;
  private slow = 0;
  private armed = true;
  private cooldown = 0;

  update(bands: [number, number, number], dt: number): number {
    const [low, mid, high] = bands;
    const energy = low * 0.4 + mid + high * 0.8; // brighter, higher speech counts as stronger
    this.fast += (energy - this.fast) * (1 - Math.exp(-dt / 0.03));
    this.slow += (energy - this.slow) * (1 - Math.exp(-dt / 0.7));
    this.cooldown = Math.max(0, this.cooldown - dt);
    const threshold = this.slow * 1.28 + 0.06;
    if (this.fast < this.slow * 1.08 + 0.02) this.armed = true; // re-arm once it falls back
    if (!this.armed || this.cooldown > 0 || this.fast < threshold || energy < 0.2) return 0;
    this.armed = false;
    this.cooldown = 0.2;
    return Math.min(1, 0.45 + (this.fast / Math.max(0.05, threshold) - 1) * 1.5);
  }
}

/**
 * Continuous "mouth" movement from the voice: like jaw and lip muscles, it opens fast on each
 * syllable and closes a little slower, every frame. Vowels (the mid band) open it most, bass adds
 * weight, and consonants (the high band) add small quick flicks. Returns 0 (closed) to 1 (wide).
 */
export class Articulator {
  value = 0;
  private peak = 0.5; // recent loudness ceiling, so quiet and loud voices both articulate fully

  update(bands: [number, number, number], dt: number, speaking: boolean): number {
    const [low, mid, high] = bands;
    const energy = mid * 0.9 + low * 0.35 + high * 0.3;
    const floor = 0.16;
    // Automatic gain: the ceiling jumps up to new peaks and relaxes slowly (~2 s).
    this.peak = Math.max(energy, this.peak + (Math.max(energy, 0.4) - this.peak) * (1 - Math.exp(-dt / 2)));
    const raw = speaking ? ((energy - floor) / Math.max(0.2, this.peak - floor)) * 0.92 : 0;
    const target = Math.min(1, Math.max(0, raw));
    const tau = target > this.value ? 0.028 : 0.09; // open fast, close a bit slower
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    return this.value;
  }
}

// ---------------------------------------------------------------- eye micro-life

export type MicroAct =
  | { kind: 'saccade'; x: number; y: number }
  | { kind: 'blink'; double: boolean }
  | { kind: 'calibrate'; shard: number; amount: number };

/** Tiny involuntary movements: eye darts, blinks and shards making small calibrating adjustments. */
export class MicroLife {
  private nextSaccade: number;
  private nextBlink: number;
  private nextCalibrate: number;

  constructor(private readonly rng: Rng = Math.random, now = 0) {
    this.nextSaccade = now + 0.5 + rng();
    this.nextBlink = now + 3 + rng() * 4;
    this.nextCalibrate = now + 6 + rng() * 8;
  }

  update(t: number, shards: number): MicroAct[] {
    const out: MicroAct[] = [];
    if (t >= this.nextSaccade) {
      this.nextSaccade = t + 0.35 + this.rng() * 1.6;
      out.push({ kind: 'saccade', x: (this.rng() - 0.5) * 0.5, y: (this.rng() - 0.5) * 0.35 });
    }
    if (t >= this.nextBlink) {
      this.nextBlink = t + 2.8 + this.rng() * 4.5;
      out.push({ kind: 'blink', double: this.rng() < 0.2 });
    }
    if (t >= this.nextCalibrate) {
      this.nextCalibrate = t + 5 + this.rng() * 9;
      out.push({ kind: 'calibrate', shard: Math.floor(this.rng() * shards), amount: (this.rng() < 0.5 ? -1 : 1) * (0.25 + this.rng() * 0.35) });
    }
    return out;
  }
}

// ---------------------------------------------------------------- moods

export type Mood = 'happy' | 'curious' | 'sad' | 'boop' | 'perk' | 'wake';

/** Guess a mood from what Aaron typed, for a small reaction while Ghost works on the reply. */
export function moodFromMessage(text: string): Mood | null {
  const t = text.toLowerCase();
  if (/\b(thanks?|thank you|cheers|ty|great job|well done|nice one|love (it|you)|brilliant|awesome|good (job|boy|work))\b/.test(t)) return 'happy';
  if (/\?\s*$/.test(t) || /^(what|why|how|who|where|when|which|could|can|would|should|is|are|do|does)\b/.test(t)) return 'curious';
  return null;
}

export const DOZE_AFTER = 300; // seconds of idle before Ghost dozes off
