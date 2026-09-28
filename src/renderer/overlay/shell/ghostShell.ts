import * as THREE from 'three';
import type { GhostState } from '../../../shared/protocol';
import type { ThemeColors } from '../../../shared/settings';
import { createMaterials, studioEnvironment, type GhostMaterials } from './materials';
import { buildModel, CORE_RADIUS, type GhostModel } from './model';
import { Curiosity, flourishFor, lookAt, POSES, QUALITY, QualityGovernor, Spring, type Pose, type QualityLevel } from './motion';
import { ParticleCore } from './particleCore';
import { PostFx } from './postfx';

export type RenderQuality = 'auto' | QualityLevel;

const TONES = { amber: new THREE.Color('#ffae42'), red: new THREE.Color('#ff3b4e') };

/** The 3D Ghost: model + particle core + bloom, animated by springs towards per-state poses. */
export class GhostShell {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
  private mats: GhostMaterials;
  private model: GhostModel;
  private core: ParticleCore;
  private fx: PostFx;
  private governor: QualityGovernor;
  private curiosity = new Curiosity();

  private state: GhostState = 'idle';
  private pose: Pose = POSES.idle;
  private themeGlow = new THREE.Color('#7fd4ff');
  private glowColor = new THREE.Color('#7fd4ff');
  private bands: [number, number, number] = [0, 0, 0];

  // Springs
  private yaw = new Spring(0, 0, 38, 0.72);
  private pitch = new Spring(0, 0, 38, 0.72);
  private roll = new Spring(0, 0, 30, 0.6);
  private splits: Spring[] = [];
  private twist = new Spring(0, 0, 40, 0.8);
  private frontSpeed = new Spring(0, 0, 8, 1);
  private rearSpeed = new Spring(0, 0, 8, 1);
  private sweep = new Spring(0, 0, 10, 1);
  private bob = new Spring(1, 1, 10, 1);
  private iris = new Spring(1, 1, 90, 0.55);
  private glow = new Spring(0.9, 0.9, 20, 1);
  private eyeW = [new Spring(1, 1, 12), new Spring(0), new Spring(0), new Spring(0)].map(s => { s.stiffness = 12; return s; });
  private scan = new Spring(0, 0, 12, 1);
  private flicker = 0;
  private flash = 0;
  private shake = 0;
  private frontAngle = 0;
  private rearAngle = 0;

  // Gaze inputs
  private cursor: { yaw: number; pitch: number } | null = null;
  private cursorAt = -1e9;
  private lean = 0;
  private curiousLook = { yaw: 0, pitch: 0, roll: 0, until: 0 };

  private time = 0;
  private lastFrame = performance.now();
  private lastRender = 0;
  private idleSince = 0;
  private frame = 0;
  private size = { w: 0, h: 0 };
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  audioLevel: () => number = () => 0;

  constructor(host: HTMLElement, theme: ThemeColors, quality: RenderQuality = 'auto') {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'shell-canvas';
    host.appendChild(this.canvas);

    this.scene.environment = studioEnvironment(this.renderer);
    const key = new THREE.DirectionalLight('#ffffff', 2.6);
    key.position.set(-2.5, 3.2, 3.5);
    const rim = new THREE.DirectionalLight('#8fb4ff', 2.4);
    rim.position.set(3, 1.5, -3);
    const fill = new THREE.DirectionalLight('#ffd9b0', 0.3);
    fill.position.set(0, -3, 2);
    this.scene.add(key, rim, fill, new THREE.AmbientLight('#ffffff', 0.05));

    this.mats = createMaterials();
    this.model = buildModel(this.mats);
    this.core = new ParticleCore(4200, CORE_RADIUS * 0.42);
    this.model.particleAnchor.add(this.core.points);
    this.scene.add(this.model.root);
    this.splits = this.model.segments.map((s, i) => new Spring(0.04, 0.04, 34 + (s.ring === 'front' ? 0 : 10) + i * 3, 0.62));

    this.camera.position.set(0, 0, 7.4);
    this.fx = new PostFx(this.renderer, this.scene, this.camera);
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
    // Gunmetal, faintly tinted by the theme's shell colour.
    this.mats.setMetal('#' + new THREE.Color('#474d57').lerp(new THREE.Color(theme.shell), 0.12).getHexString());
  }

  setState(state: GhostState): void {
    if (state === this.state) return;
    const f = flourishFor(this.state, state);
    this.state = state;
    this.pose = POSES[state];
    this.frontSpeed.kick(f.spinKick);
    this.rearSpeed.kick(-f.spinKick * 0.6);
    for (const s of this.splits) s.kick(f.splitKick);
    this.pitch.kick(f.nod * 3);
    this.flash = Math.max(this.flash, f.flash);
    this.shake = Math.max(this.shake, f.shake);
    if (state !== 'idle') this.curiosity.reset(this.time);
    else this.idleSince = this.time;
  }

  /** Cursor offset from the shell's centre, in CSS px. */
  setCursor(dx: number, dy: number): void {
    const next = lookAt(dx, dy);
    if (!this.cursor || Math.abs(next.yaw - this.cursor.yaw) + Math.abs(next.pitch - this.cursor.pitch) > 0.01) this.cursorAt = this.time;
    this.cursor = next;
  }

  /** Lean towards the input bar while Aaron types (-1 left, +1 right, 0 none). */
  setLean(direction: number): void { this.lean = direction; }

  setBands(b: [number, number, number]): void { this.bands = b; }

  /** Orbit the camera around the drone (the draft lab's drag-to-rotate). */
  setViewOrbit(yaw: number, pitch: number): void {
    const r = 7.4;
    this.camera.position.set(Math.sin(yaw) * Math.cos(pitch) * r, Math.sin(pitch) * r, Math.cos(yaw) * Math.cos(pitch) * r);
    this.camera.lookAt(0, 0, 0);
  }

  setQuality(q: RenderQuality): void { this.governor.setMode(q); this.resize(); }

  get qualityLevel(): QualityLevel { return this.governor.level; }

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
    const p = this.pose;
    const t = this.time;
    const m = this.model;
    const motion = this.reduced ? 0 : 1;
    const [low, mid, high] = this.bands[0] + this.bands[1] + this.bands[2] > 0 ? this.bands : [this.audioLevel(), this.audioLevel() * 0.6, 0];
    const speaking = this.state === 'speaking' ? 1 : 0;

    // ---- gaze: cursor (fresh) > curiosity (idle) > lean (typing) > rest
    let yawT = 0, pitchT = 0, rollT = 0;
    const cursorFresh = this.cursor && t - this.cursorAt < 3;
    if (p.curious && !cursorFresh) {
      const act = this.curiosity.update(t);
      if (act?.kind === 'glance') this.curiousLook = { yaw: act.yaw, pitch: act.pitch, roll: act.yaw * -0.25, until: t + act.hold };
      else if (act?.kind === 'tilt') this.curiousLook = { yaw: 0, pitch: 0, roll: act.roll, until: t + act.hold };
      else if (act?.kind === 'blink') this.iris.kick(-14);
      else if (act?.kind === 'spin') this.frontSpeed.kick(14);
      else if (act?.kind === 'shake') this.shake = 0.6;
      if (t < this.curiousLook.until) { yawT = this.curiousLook.yaw; pitchT = this.curiousLook.pitch; rollT = this.curiousLook.roll; }
    }
    if (this.cursor && (cursorFresh || !p.curious)) { yawT = this.cursor.yaw; pitchT = this.cursor.pitch; rollT = -this.cursor.yaw * 0.15; }
    if (this.lean) { yawT = this.lean * 0.5; pitchT = -0.12; }
    if (this.state === 'approval') pitchT = -0.35; // looks up at the confirm card
    yawT += Math.sin(t * 2.2) * p.sweep;
    this.yaw.target = yawT; this.pitch.target = pitchT; this.roll.target = rollT;

    // ---- springs towards the pose
    this.twist.target = p.twist;
    this.frontSpeed.target = p.frontSpin;
    this.rearSpeed.target = p.rearSpin;
    this.bob.target = p.bob;
    this.iris.target = p.iris + speaking * low * 0.25;
    this.glow.target = p.glow + speaking * (low * 0.6 + mid * 0.3);
    p.eye.forEach((w, i) => { this.eyeW[i].target = w; });
    this.scan.target = p.scan;
    for (const s of [this.yaw, this.pitch, this.roll, this.twist, this.frontSpeed, this.rearSpeed, this.bob, this.iris, this.glow, this.scan, ...this.eyeW]) s.step(dt);
    this.model.segments.forEach((seg, i) => {
      const sp = this.splits[i];
      sp.target = p.split + speaking * low * (seg.ring === 'front' ? 0.25 : 0.15);
      sp.step(dt);
    });

    // ---- apply: body
    this.shake = Math.max(0, this.shake - dt * 1.6);
    this.flash = Math.max(0, this.flash - dt * 2.4);
    const shakeYaw = Math.sin(t * 38) * this.shake * 0.12;
    m.root.rotation.set(this.pitch.value * motion, (this.yaw.value + shakeYaw) * motion, this.roll.value * motion, 'YXZ');
    m.root.position.y = Math.sin(t * 1.25) * 0.07 * this.bob.value * motion;
    m.root.position.x = Math.sin(t * 0.7) * 0.02 * this.bob.value * motion;

    // ---- segments: spin sets, split along their axes, twist
    this.frontAngle += this.frontSpeed.value * dt * motion;
    this.rearAngle += this.rearSpeed.value * dt * motion;
    m.front.rotation.z = this.frontAngle;
    m.rear.rotation.z = this.rearAngle;
    m.segments.forEach((seg, i) => {
      const split = Math.max(-0.05, this.splits[i].value);
      seg.body.position.z = CORE_RADIUS * 0.9 + split * (seg.ring === 'front' ? 0.55 : 0.75);
      seg.body.rotation.z = this.twist.value * (i % 2 ? 1 : -1);
      seg.body.rotation.x = split * 0.35 * (seg.ring === 'front' ? 1 : -1);
    });

    // ---- eye: leads the body slightly, iris dilates/blinks, particle core weights
    m.eye.rotation.set(this.pitch.value * 0.25 * motion, this.yaw.value * 0.25 * motion, 0);
    const irisS = Math.max(0.05, this.iris.value);
    m.iris.scale.set(irisS, Math.max(0.05, irisS * (1 + Math.min(0, this.iris.velocity) * 0.04)), 1);
    const u = this.core.uniforms;
    u.time.value = t;
    u.weights.value.set(...(this.eyeW.map(s => Math.max(0, s.value)) as [number, number, number, number]));
    u.scan.value = Math.min(1, Math.max(0, this.scan.value));
    u.bands.value.set(low, mid, high);
    u.onset.value = speaking * Math.max(0, low - 0.5) * 1.5;

    // ---- colour and glow
    const target = p.tone === 'theme' ? this.themeGlow : TONES[p.tone];
    this.glowColor.lerp(target, 1 - Math.exp(-dt * 6));
    this.flicker += (p.flicker - this.flicker) * (1 - Math.exp(-dt * 6));
    const flick = this.flicker > 0.02 ? (Math.sin(t * 41) > 0.25 ? 1 : 1 - this.flicker * 0.75) : 1;
    const intensity = (this.glow.value + this.flash * 1.6) * flick;
    this.mats.setGlow(this.glowColor, intensity);
    u.colorA.value.copy(this.glowColor).multiplyScalar(0.55);
    u.colorB.value.copy(this.glowColor).lerp(new THREE.Color('#ffffff'), 0.55);
    u.intensity.value = 0.7 + intensity * 0.3;
    m.eyeLight.color.copy(this.glowColor);
    m.eyeLight.intensity = 0.8 + intensity * 1.4;
    this.fx.setStrength(0.3 + intensity * 0.18);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.fx.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
