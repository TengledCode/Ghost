import * as THREE from 'three';
import type { GhostState } from '../../../shared/protocol';
import type { ThemeColors } from '../../../shared/settings';
import { Hologram } from './hologram';
import { createMaterials, studioEnvironment, type GhostMaterials } from './materials';
import { buildModel, CORE_RADIUS, SHARD_REST, type GhostModel } from './model';
import {
  Articulator, Curiosity, lookAt, DOZE_AFTER, EmphasisDetector, flourishFor, MicroLife, POSES, QUALITY, QualityGovernor, Spring,
  type Mood, type Pose, type QualityLevel,
} from './motion';
import { ParticleCore } from './particleCore';
import { BLOOM_LAYER, PostFx } from './postfx';

export type RenderQuality = 'auto' | QualityLevel;

const TONES = { amber: new THREE.Color('#ffae42'), red: new THREE.Color('#ff3b4e') };
const LIVE_TINT = new THREE.Color('#ff3d8b');
const CAMERA_DISTANCE = 7.4;
const LOOK_PLANE_Z = 1.5; // where cursor targets are projected in front of Ghost
const NEAR_PX = 170; // cursor this close (px from centre) makes Ghost lean in

interface ShardAnim {
  lift: Spring; // distance off the core
  twist: Spring; // calibrating twist about its own axis
  lagX: Spring; // secondary motion: trails the body's rotation
  lagY: Spring;
  poolMat: THREE.MeshBasicMaterial;
}

/** The 3D Ghost: model, particle core, hologram and bloom, animated by springs towards per-state poses. */
export class GhostShell {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  private mats: GhostMaterials;
  private model: GhostModel;
  private core: ParticleCore;
  private holo: Hologram;
  private fx: PostFx;
  private governor: QualityGovernor;
  private curiosity = new Curiosity();
  private micro = new MicroLife();
  private emphasis = new EmphasisDetector();
  private mouth = new Articulator();

  private state: GhostState = 'idle';
  private pose: Pose = POSES.idle;
  private themeGlow = new THREE.Color('#7fd4ff');
  private glowColor = new THREE.Color('#7fd4ff');
  private bands: [number, number, number] = [0, 0, 0];

  // Body
  private yaw = new Spring(0, 0, 120, 0.78);
  private pitch = new Spring(0, 0, 120, 0.78);
  private roll = new Spring(0, 0, 45, 0.6);
  private eyeYaw = new Spring(0, 0, 260, 0.85); // the eye gets there before the body
  private eyePitch = new Spring(0, 0, 260, 0.85);
  private recoil = new Spring(0, 0, 90, 0.5); // boop: the body is pushed back, then settles (no deformation)
  private approach = new Spring(0, 0, 25, 1); // lean-in: drifts towards you
  private hop = new Spring(0, 0, 70, 0.45);
  private shards: ShardAnim[] = [];
  private twist = new Spring(0, 0, 40, 0.8);
  private frontSpeed = new Spring(0, 0, 8, 1);
  private rearSpeed = new Spring(0, 0, 8, 1);
  private bob = new Spring(1, 1, 10, 1);
  private iris = new Spring(1, 1, 90, 0.55);
  private glow = new Spring(0.9, 0.9, 20, 1);
  private eyeW = [new Spring(1, 1, 12), new Spring(0, 0, 12), new Spring(0, 0, 12), new Spring(0, 0, 12)];
  private scan = new Spring(0, 0, 12, 1);
  private near = new Spring(0, 0, 25, 1);
  private sacX = new Spring(0, 0, 400, 0.9);
  private sacY = new Spring(0, 0, 400, 0.9);
  private blink = 0; // 0 open → 1 shut
  private blinkQueue: number[] = [];
  private flicker = 0;
  private flash = 0;
  private shake = 0;
  private frontAngle = 0;
  private rearAngle = 0;

  // Gaze inputs
  private cursorPx: { dx: number; dy: number } | null = null;
  private cursorAt = -1e9;
  private focus: { dx: number; dy: number } | null = null; // what Aaron is typing: the caret, relative to the shell centre
  private curiousLook = { yaw: 0, pitch: 0, roll: 0, until: 0 };
  private mood: { kind: Mood; until: number } | null = null;
  private dozing = false;
  private materialiseAt: number | null = null; // start time of the startup assembly, while it runs
  private live = false; // live screen view: the eye takes a distinct red-magenta cast
  private liveMix = 0;

  private time = 0;
  private lastFrame = performance.now();
  private lastRender = 0;
  private idleSince = 0;
  private frame = 0;
  private size = { w: 1, h: 1 };
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private target = new THREE.Vector3();
  audioLevel: () => number = () => 0;

  constructor(host: HTMLElement, theme: ThemeColors, quality: RenderQuality = 'auto') {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    // Tone mapping and sRGB encoding happen in PostFx's final pass (alpha-correct for the desktop).
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'shell-canvas';
    host.appendChild(this.canvas);

    this.scene.environment = studioEnvironment(this.renderer);
    const key = new THREE.DirectionalLight('#ffffff', 2.1);
    key.position.set(-2.5, 3.2, 3.5);
    const rim = new THREE.DirectionalLight('#8fb4ff', 0.9);
    rim.position.set(2, 1.2, -6); // mostly behind: grazes the silhouette instead of glinting off facets
    const fill = new THREE.DirectionalLight('#ffd9b0', 0.3);
    fill.position.set(0, -3, 2);
    this.scene.add(key, rim, fill, new THREE.AmbientLight('#ffffff', 0.18));

    this.mats = createMaterials();
    this.model = buildModel(this.mats);
    this.core = new ParticleCore(2400, CORE_RADIUS * 0.42);
    this.model.particleAnchor.add(this.core.points);
    this.holo = new Hologram(this.model.eyeFront.z + 0.14);
    this.model.eye.add(this.holo.iris);
    this.scene.add(this.model.root);
    this.shards = this.model.segments.map((s, i) => {
      const poolMat = this.mats.pool.clone();
      s.pool.material = poolMat;
      return {
        lift: new Spring(0.1, 0.1, 40, 0.55), // identical springs so field pulses move the shards together
        twist: new Spring(0, 0, 60, 0.5),
        lagX: new Spring(0, 0, 50 + i * 4, 0.45),
        lagY: new Spring(0, 0, 50 + i * 4, 0.45),
        poolMat,
      };
    });

    this.camera.position.set(0, 0, CAMERA_DISTANCE);
    this.fx = new PostFx(this.renderer, this.scene, this.camera);
    this.fx.setExposure(0.95);
    // Only light sources glow: the iris ring, particle core, hologram and magnetic pools.
    for (const o of [this.model.iris, this.core.points, this.holo.iris, ...this.model.segments.map(s => s.pool)]) o.layers.enable(BLOOM_LAYER);
    this.governor = new QualityGovernor(quality);
    this.setTheme(theme);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- inputs

  setTheme(theme: ThemeColors): void {
    this.themeGlow.set(theme.edge);
    this.mats.setMetal('#' + new THREE.Color('#767d88').lerp(new THREE.Color(theme.shell), 0.12).getHexString());
  }

  /** Startup: the shards fly in from far out and lock around the eye as the light comes up (~1.3 s). */
  materialise(): void {
    if (this.reduced) return;
    this.materialiseAt = this.time;
  }

  /** How scattered shard `i` still is (1 = far out, 0 = locked), and how far the light has come up. */
  private assembly(i: number): { scatter: number; light: number } {
    if (this.materialiseAt === null) return { scatter: 0, light: 1 };
    const e = this.time - this.materialiseAt;
    const p = Math.min(1, Math.max(0, (e - 0.15 - i * 0.045) / 0.9));
    // Ease out with a slight overshoot, so each shard snaps into place.
    const c = 1.9, q = p - 1;
    return { scatter: 1 - (1 + (c + 1) * q * q * q + c * q * q), light: Math.min(1, Math.max(0, (e - 0.35) / 0.9)) };
  }

  setState(state: GhostState): void {
    if (state === this.state) return;
    if (state !== 'idle') this.wake(false);
    const f = flourishFor(this.state, state);
    this.state = state;
    this.pose = POSES[state];
    this.frontSpeed.kick(f.spinKick);
    this.rearSpeed.kick(-f.spinKick * 0.6);
    for (const s of this.shards) s.lift.kick(f.splitKick);
    this.pitch.kick(f.nod * 3);
    this.flash = Math.max(this.flash, f.flash);
    this.shake = Math.max(this.shake, f.shake);
    if (state === 'error') this.express('sad');
    if (state === 'listening' && !this.mood) this.express('perk');
    if (state !== 'idle') this.curiosity.reset(this.time);
    else this.idleSince = this.time;
  }

  /** Cursor offset from the shell's centre, in CSS px (anywhere on screen). */
  setCursor(dx: number, dy: number): void {
    const prev = this.cursorPx;
    this.cursorPx = { dx, dy };
    if (!prev || Math.abs(prev.dx - dx) + Math.abs(prev.dy - dy) > 2) {
      this.cursorAt = this.time;
      if (this.dozing && Math.hypot(dx, dy) < NEAR_PX * 1.5) this.wake(true);
    }
  }

  /**
   * While Aaron types, Ghost watches the text caret (CSS px from the shell's centre), so his eye
   * settles on the box and drifts along the words as they appear. null when not typing.
   */
  setFocus(point: { dx: number; dy: number } | null): void {
    if (point && !this.focus) this.wake(false);
    this.focus = point;
  }

  setBands(b: [number, number, number]): void { this.bands = b; }

  /** Live screen view on/off: tints the eye and adds a scanning sweep to the holo-iris. */
  setLiveScreen(on: boolean): void { this.live = on; }

  setQuality(q: RenderQuality): void { this.governor.setMode(q); this.resize(); }

  get qualityLevel(): QualityLevel { return this.governor.level; }

  get isDozing(): boolean { return this.dozing; }

  /** A short emotional reaction layered over the current state. */
  express(mood: Mood): void {
    const t = this.time;
    switch (mood) {
      case 'happy': // a delighted spin and a hop
        this.frontSpeed.kick(16); this.rearSpeed.kick(-10); this.hop.kick(3.2); this.flash = Math.max(this.flash, 0.5);
        this.mood = { kind: mood, until: t + 1.6 };
        break;
      case 'curious': // head tilt, iris widens
        this.mood = { kind: mood, until: t + 2.2 };
        break;
      case 'sad': // droop and dim
        this.mood = { kind: mood, until: t + 2.8 };
        break;
      case 'boop': // flinch: the field repels the shards outwards and the body recoils; the metal never deforms
        this.recoil.kick(-5); this.shards.forEach((s, i) => s.lift.kick(6 + (i % 3))); this.roll.kick(4); this.pitch.kick(-2); this.blinkQueue.push(t, t + 0.18);
        this.mood = { kind: mood, until: t + 0.8 };
        break;
      case 'perk': // "oh, you're typing": a quick hop and bright eye
        this.hop.kick(2); this.iris.kick(4);
        break;
      case 'wake':
        this.shake = 0.5; this.flash = Math.max(this.flash, 0.4); this.blinkQueue.push(t, t + 0.25);
        break;
    }
  }

  /** Aaron clicked the shell. */
  boop(): void { this.wake(false); this.express('boop'); }

  /** Doze off immediately (the lab's preview of the 5-minute idle behaviour). */
  doze(): void { if (this.state === 'idle') { this.dozing = true; } }

  private wake(withFlourish: boolean): void {
    if (!this.dozing) return;
    this.dozing = false;
    this.idleSince = this.time;
    if (withFlourish) this.express('wake');
  }

  /** Orbit the camera around the drone (the draft lab's drag-to-rotate). */
  setViewOrbit(yaw: number, pitch: number): void {
    this.camera.position.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);
  }

  // ---------------------------------------------------------------- frame

  private resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.size = { w, h };
    const q = QUALITY[this.governor.level];
    this.fx.setSize(w, h, Math.min(devicePixelRatio || 1, q.dpr), q.bloom);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.core.setPixelScale(h * Math.min(devicePixelRatio || 1, q.dpr));
  }

  private loop(): void {
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    const idleFor = this.state === 'idle' ? this.time - this.idleSince : 0;
    if ((now - this.lastRender) / 1000 < this.governor.frameInterval(idleFor) * 0.92) return;
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.lastRender = now;
    this.time += dt;
    this.update(dt);
    this.fx.render();
    if (this.governor.sample(dt)) this.resize();
  }

  private update(dt: number): void {
    const t = this.time;
    const m = this.model;
    const motion = this.reduced ? 0 : 1;
    const [low, mid, high] = this.bands[0] + this.bands[1] + this.bands[2] > 0 ? this.bands : [this.audioLevel(), this.audioLevel() * 0.6, 0];
    const speaking = this.state === 'speaking' ? 1 : 0;
    if (this.mood && t > this.mood.until) this.mood = null;
    if (this.state === 'idle' && !this.dozing && t - this.idleSince > DOZE_AFTER) this.dozing = true;
    const p = this.pose;
    const mood = this.mood?.kind;

    // ---- where to look: approval card > searching sweep > what Aaron is typing > cursor > idle glances
    const cursorFresh = !!this.cursorPx && t - this.cursorAt < 2.5;
    const target = this.target;
    let lookingAtSomething = true;
    let rollT = 0;
    if (this.state === 'approval') target.set(0, 1.4, 1.2);
    else if (this.state === 'searching') { target.set(Math.sin(t * 2.2) * 1.4, Math.sin(t * 1.3) * 0.35, LOOK_PLANE_Z); }
    else if (this.focus && !this.dozing) {
      // Text is close, so a shorter viewing distance than for the screen-wide cursor: moving along
      // the input sweeps the gaze gently, like reading along.
      const g = lookAt(this.focus.dx, this.focus.dy, 0.95, 340);
      target.set(Math.sin(g.yaw) * Math.cos(g.pitch), -Math.sin(g.pitch), Math.cos(g.yaw) * Math.cos(g.pitch)).multiplyScalar(1.6);
      rollT = -Math.atan2(target.x, 3) * 0.15;
    }
    else if (cursorFresh && !this.dozing) {
      // A direction across the whole screen (not clamped to this small canvas), so every part of
      // the screen maps to a distinct gaze.
      const g = lookAt(this.cursorPx!.dx, this.cursorPx!.dy);
      target.set(Math.sin(g.yaw) * Math.cos(g.pitch), -Math.sin(g.pitch), Math.cos(g.yaw) * Math.cos(g.pitch)).multiplyScalar(1.6);
      rollT = -Math.atan2(target.x, 3) * 0.2;
    } else if (p.curious && !this.dozing) {
      const act = this.curiosity.update(t);
      if (act?.kind === 'glance') this.curiousLook = { yaw: act.yaw, pitch: act.pitch, roll: act.yaw * -0.25, until: t + act.hold };
      else if (act?.kind === 'tilt') this.curiousLook = { yaw: 0, pitch: 0, roll: act.roll, until: t + act.hold };
      else if (act?.kind === 'blink') this.blinkQueue.push(t);
      else if (act?.kind === 'spin') this.frontSpeed.kick(14);
      else if (act?.kind === 'shake') this.shake = 0.6;
      const c = t < this.curiousLook.until ? this.curiousLook : { yaw: 0, pitch: 0, roll: 0 };
      target.set(Math.sin(c.yaw) * 2, -Math.sin(c.pitch) * 2, 2);
      rollT = c.roll;
    } else { target.set(0, 0, 2); lookingAtSomething = false; }

    const maxTurn = 1.15; // it may turn well to the side to follow a cursor at the far edge of the screen
    let yawT = THREE.MathUtils.clamp(Math.atan2(target.x, Math.max(0.3, target.z)), -maxTurn, maxTurn);
    let pitchT = THREE.MathUtils.clamp(-Math.atan2(target.y, Math.max(0.3, Math.hypot(target.x, target.z))), -maxTurn, maxTurn);
    // Moods and dozing bend the pose.
    if (mood === 'curious') { rollT = 0.32; pitchT -= 0.08; }
    if (mood === 'sad') pitchT = 0.45;
    if (this.dozing) { pitchT = 0.3 + Math.sin(t * 0.4) * 0.05; yawT = Math.sin(t * 0.21) * 0.15; rollT = Math.sin(t * 0.3) * 0.12; }
    this.yaw.target = yawT;
    this.pitch.target = pitchT;
    this.roll.target = rollT;
    this.eyeYaw.target = (yawT - this.yaw.value) * 0.8;
    this.eyePitch.target = (pitchT - this.pitch.value) * 0.8;
    this.near.target = !this.dozing && this.cursorPx && cursorFresh ? Math.max(0, 1 - Math.hypot(this.cursorPx.dx, this.cursorPx.dy) / NEAR_PX) : 0;

    // ---- micro-life: saccades, blinks, calibrating shards
    for (const act of this.dozing ? [] : this.micro.update(t, this.shards.length)) {
      if (act.kind === 'saccade') { const k = lookingAtSomething ? 0.35 : 1; this.sacX.target = act.x * k; this.sacY.target = act.y * k; }
      else if (act.kind === 'blink') this.blinkQueue.push(t, ...(act.double ? [t + 0.28] : []));
      else if (act.kind === 'calibrate' && (this.state === 'idle' || this.state === 'listening')) this.shards[act.shard].twist.kick(act.amount * 8);
    }
    // Blink: a quick close-open, about 160 ms.
    this.blinkQueue = this.blinkQueue.filter(start => t < start + 0.16);
    const b = this.blinkQueue.find(start => t >= start);
    this.blink = b !== undefined ? Math.sin(((t - b) / 0.16) * Math.PI) : 0;

    // ---- speech: the shards open and close with the voice like a mouth, all together, every frame.
    // Emphasis adds only a light accent on top.
    const open = this.mouth.update([low, mid, high], dt, speaking === 1);
    if (speaking) {
      const accent = this.emphasis.update([low, mid, high], dt);
      if (accent > 0) for (const sh of this.shards) sh.lift.kick(accent * 1.2);
    }

    // ---- springs towards the pose
    const dozeDim = this.dozing ? 0.35 : 1;
    this.twist.target = p.twist;
    this.frontSpeed.target = this.dozing ? 0.05 : p.frontSpin;
    this.rearSpeed.target = this.dozing ? -0.03 : p.rearSpin;
    this.bob.target = this.dozing ? 1.6 : p.bob;
    this.iris.target = (this.dozing ? 0.55 : p.iris) + open * 0.22 + this.near.value * 0.2 + (mood === 'curious' ? 0.15 : 0);
    this.glow.target = (p.glow + open * 0.45 + this.near.value * 0.2 - (mood === 'sad' ? 0.35 : 0)) * dozeDim;
    p.eye.forEach((w, i) => { this.eyeW[i].target = w; });
    this.scan.target = p.scan;
    for (const s of [this.yaw, this.pitch, this.roll, this.eyeYaw, this.eyePitch, this.recoil, this.approach, this.hop, this.twist, this.frontSpeed,
      this.rearSpeed, this.bob, this.iris, this.glow, this.scan, this.near, this.sacX, this.sacY, ...this.eyeW]) s.step(dt);

    // ---- colour and glow (computed first: shards and eye both use it)
    const u = this.core.uniforms;
    this.liveMix += ((this.live ? 1 : 0) - this.liveMix) * (1 - Math.exp(-dt * 4));
    // Live view blends the theme colour halfway to red-magenta, so state tones (amber, red) still read.
    const toneTarget = (p.tone === 'theme' ? this.themeGlow : TONES[p.tone]).clone().lerp(LIVE_TINT, this.liveMix * 0.55);
    this.glowColor.lerp(toneTarget, 1 - Math.exp(-dt * 6));
    this.flicker += (p.flicker - this.flicker) * (1 - Math.exp(-dt * 6));
    const flick = this.flicker > 0.02 ? (Math.sin(t * 41) > 0.25 ? 1 : 1 - this.flicker * 0.75) : 1;
    // Startup assembly: dark until the shards arrive, then a flash as they lock.
    const intro = this.assembly(this.shards.length);
    if (this.materialiseAt !== null && t - this.materialiseAt > 1.25 + this.shards.length * 0.045) {
      this.materialiseAt = null;
      this.flash = Math.max(this.flash, 0.7);
      for (const sh of this.shards) sh.lift.kick(1.5);
    }
    const intensity = (this.glow.value + this.flash * 1.6) * flick * intro.light;
    this.mats.setGlow(this.glowColor, intensity);
    u.colorA.value.copy(this.glowColor).multiplyScalar(0.9);
    u.colorB.value.copy(this.glowColor).lerp(new THREE.Color('#ffffff'), 0.35);
    u.intensity.value = (0.7 + intensity * 0.3) * (1 - this.blink * 0.7) * intro.light;
    m.eyeLight.color.copy(this.glowColor);
    m.eyeLight.intensity = 0.12 + intensity * 0.16; // a gentle tint on nearby metal, never a hotspot
    this.fx.setStrength(0.3 + intensity * 0.18);

    // ---- body
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.flash = Math.max(0, this.flash - dt * 2.4);
    const shakeYaw = Math.sin(t * 38) * this.shake * 0.12;
    m.root.rotation.set(this.pitch.value * motion, (this.yaw.value + shakeYaw) * motion, this.roll.value * motion, 'YXZ');
    // Lazy figure-8 hover with a hop on top.
    const bobA = this.bob.value * motion;
    m.root.position.set(Math.sin(t * 0.62) * 0.05 * bobA, Math.sin(t * 1.24) * 0.07 * bobA + this.hop.value * 0.18 - (this.dozing ? 0.12 : 0), 0);
    this.approach.target = this.near.value * 0.35;
    m.root.position.z = this.recoil.value * 0.12 + this.approach.value;

    // ---- shards: magnetic float, lift/split, secondary lag, calibrating twist
    this.frontAngle += this.frontSpeed.value * dt * motion;
    this.rearAngle += this.rearSpeed.value * dt * motion;
    m.front.rotation.z = this.frontAngle;
    m.rear.rotation.z = this.rearAngle;
    const sag = mood === 'sad' ? 0.1 : 0;
    m.segments.forEach((seg, i) => {
      const a = this.shards[i];
      const float = (0.035 * Math.sin(t * 0.9 + seg.phase) + 0.018 * Math.sin(t * 2.3 + seg.phase * 2)) * motion * (this.dozing ? 2 : 1);
      a.lift.target = p.split + (this.dozing ? 0.25 : 0) + this.near.value * 0.06 - sag;
      // Secondary motion: when the body turns, the shards trail behind and overshoot.
      a.lagX.target = -this.pitch.velocity * 0.05;
      a.lagY.target = -this.yaw.velocity * 0.05;
      for (const s of [a.lift, a.twist, a.lagX, a.lagY]) s.step(dt);
      const lift = Math.max(-0.04, a.lift.value) + float + open * 0.24; // the mouth offset is applied directly, so it never lags
      const { scatter } = this.assembly(i);
      seg.body.position.z = SHARD_REST + lift * (seg.ring === 'front' ? 0.55 : 0.75) + scatter * 2.6;
      seg.body.rotation.set(
        lift * 0.3 * (seg.ring === 'front' ? 1 : -1) + a.lagX.value + Math.sin(t * 1.1 + seg.phase) * 0.03 * motion + scatter * 1.4,
        a.lagY.value + Math.cos(t * 0.8 + seg.phase) * 0.03 * motion - scatter * 0.9,
        this.twist.value * (i % 2 ? 1 : -1) + a.twist.value + scatter * 3 * (i % 2 ? 1 : -1),
      );
      seg.body.visible = scatter < 0.98;
      // The magnetic light pool brightens and spreads as the shard lifts.
      // The magnetic pool is strongest with a small gap and fades as the shard moves far away,
      // so a fully unfolded Ghost doesn't wash its core in light.
      const g = Math.max(0, lift);
      seg.pool.scale.setScalar(0.7 + Math.min(g, 0.4) * 1.2);
      a.poolMat.opacity = this.mats.pool.opacity * (0.4 + g * 2.4) * Math.exp(-g * 2.2) * intro.light;
      a.poolMat.color.copy(this.mats.pool.color);
      // The underside only shows the glow it reflects from the pool: stronger as it lifts off.
      // Brighter field as it lifts, but further from the pool: the reflection peaks at a small gap and fades with distance.
      const gap = Math.max(0, lift);
      (seg.under.material as THREE.MeshStandardMaterial).emissive.copy(this.glowColor).multiplyScalar(0.3 * Math.min(1.5, intensity) * (0.3 + gap) * Math.exp(-gap * 2.6));
    });

    // ---- eye: leads the body, saccades, dilation, blinks
    m.eye.rotation.set((this.eyePitch.value + this.sacY.value * 0.12) * motion, (this.eyeYaw.value + this.sacX.value * 0.12) * motion, 0);
    const irisS = Math.max(0.05, this.iris.value);
    m.iris.scale.set(irisS, Math.max(0.04, irisS * (1 - this.blink * 0.95)), 1);
    u.time.value = t;
    u.weights.value.set(...(this.eyeW.map(s => Math.max(0, s.value)) as [number, number, number, number]));
    u.scan.value = THREE.MathUtils.clamp(this.scan.value, 0, 1);
    u.bands.value.set(low, mid, high);
    u.onset.value = speaking * Math.max(0, low - 0.5) * 1.5;

    // ---- hologram
    const look = new THREE.Vector2(
      THREE.MathUtils.clamp(this.eyeYaw.value * 2 + this.sacX.value * 0.5, -1, 1),
      THREE.MathUtils.clamp(-this.eyePitch.value * 2 - this.sacY.value * 0.5, -1, 1),
    );
    this.holo.update(t, dt, {
      color: this.glowColor, intensity, look,
      irisOn: this.dozing ? 0.15 : 1, blink: this.blink, live: this.liveMix,
    });
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.fx.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
