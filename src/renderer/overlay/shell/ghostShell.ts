import * as THREE from 'three';
import type { GhostState } from '../../../shared/protocol';
import type { ThemeColors } from '../../../shared/settings';

// An original "companion shell": two rings of faceted petals around an open centre, where the
// particle eye (the Voice Orb) shows through. Each state sets targets that the frame loop eases towards.

interface Targets {
  open: number; // 0 = closed around the eye, 1 = fully spread
  innerSpin: number; // rad/s of the inner ring
  outerSpin: number; // rad/s of the outer ring
  bob: number; // vertical float amplitude
  scan: number; // side-to-side sweep amplitude (searching)
  tint: THREE.Color | null; // edge colour override (approval / error)
  flicker: number;
}

const STATE_TARGETS: Record<GhostState, Omit<Targets, 'tint'> & { tint?: string }> = {
  idle: { open: 0.05, innerSpin: 0.08, outerSpin: -0.05, bob: 1, scan: 0, flicker: 0 },
  listening: { open: 0.22, innerSpin: 0.15, outerSpin: -0.1, bob: 0.6, scan: 0, flicker: 0 },
  thinking: { open: 0.3, innerSpin: 1.1, outerSpin: -0.7, bob: 0.4, scan: 0, flicker: 0 },
  searching: { open: 0.85, innerSpin: 0.5, outerSpin: 1.6, bob: 0.3, scan: 1, flicker: 0 },
  speaking: { open: 0.4, innerSpin: 0.2, outerSpin: -0.12, bob: 0.5, scan: 0, flicker: 0 },
  done: { open: 0, innerSpin: 0.05, outerSpin: -0.03, bob: 1, scan: 0, flicker: 0 },
  approval: { open: 0.5, innerSpin: 0.12, outerSpin: -0.08, bob: 0.3, scan: 0, flicker: 0.25, tint: '#ffb347' },
  error: { open: 0.15, innerSpin: 0.02, outerSpin: 0, bob: 0.2, scan: 0, flicker: 0.9, tint: '#ff4f5e' },
};

/** A wedge-shaped armour plate; six of them form a faceted ring around the eye. */
function plateGeometry(inner: number, outer: number, halfAngle: number, depth: number): THREE.BufferGeometry {
  const a = Math.tan(halfAngle) * inner;
  const b = Math.tan(halfAngle * 0.9) * outer;
  const shape = new THREE.Shape();
  shape.moveTo(-a, inner);
  shape.lineTo(a, inner);
  shape.lineTo(b, outer * 0.93);
  shape.lineTo(b * 0.35, outer);
  shape.lineTo(-b * 0.35, outer);
  shape.lineTo(-b, outer * 0.93);
  shape.closePath();
  return extrude(shape, depth);
}

/** A narrow blade that sits in the gaps between plates. */
function bladeGeometry(inner: number, outer: number, half: number, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-half, inner);
  shape.lineTo(half, inner);
  shape.lineTo(half * 0.8, inner + (outer - inner) * 0.6);
  shape.lineTo(0, outer);
  shape.lineTo(-half * 0.8, inner + (outer - inner) * 0.6);
  shape.closePath();
  return extrude(shape, depth);
}

function extrude(shape: THREE.Shape, depth: number): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: depth * 0.5, bevelSize: 0.018, bevelSegments: 1, steps: 1,
  });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

interface Petal { mesh: THREE.Group; angle: number; baseTilt: number }

export class GhostShell {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  private root = new THREE.Group();
  private inner = new THREE.Group();
  private outer = new THREE.Group();
  private petals: { inner: Petal[]; outer: Petal[] } = { inner: [], outer: [] };
  private bodyMat: THREE.MeshStandardMaterial;
  private edgeMat: THREE.LineBasicMaterial;
  private eyeLight: THREE.PointLight;
  private current: Targets = { open: 0, innerSpin: 0, outerSpin: 0, bob: 1, scan: 0, tint: null, flicker: 0 };
  private target: Targets = { ...this.current };
  private state: GhostState = 'idle';
  private flash = 0;
  private lean = 0;
  private leanTarget = 0;
  private edgeBase = new THREE.Color('#7fd4ff');
  private lastFrame = performance.now();
  private elapsed = 0;
  private frame = 0;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  audioLevel: () => number = () => 0;

  constructor(host: HTMLElement, theme: ThemeColors) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'shell-canvas';
    host.appendChild(this.canvas);

    this.camera.position.set(0, 0, 6.9);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(-2.5, 3, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb8ff, 0.9);
    rim.position.set(3, -2, -3);
    this.scene.add(rim);
    this.eyeLight = new THREE.PointLight(0x7fd4ff, 6, 4, 1.5);
    this.eyeLight.position.set(0, 0, 0.6);
    this.scene.add(this.eyeLight);

    this.bodyMat = new THREE.MeshStandardMaterial({ color: theme.shell, metalness: 0.55, roughness: 0.38, flatShading: true });
    this.edgeMat = new THREE.LineBasicMaterial({ color: theme.edge, transparent: true, opacity: 0.85 });

    // Sizes are in world units; the eye (the particle orb) fills radius ~0.95 at this camera distance.
    const plateGeo = plateGeometry(1.0, 1.42, Math.PI / 6 - 0.05, 0.07);
    const bladeGeo = bladeGeometry(1.08, 1.86, 0.1, 0.05);
    this.build(this.inner, this.petals.inner, plateGeo, 6, 0, 0.12);
    this.build(this.outer, this.petals.outer, bladeGeo, 6, Math.PI / 6, 0.3);
    this.outer.position.z = -0.25;
    this.root.add(this.outer, this.inner);
    this.scene.add(this.root);

    this.setTheme(theme);
    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);
    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  private build(group: THREE.Group, list: Petal[], geo: THREE.BufferGeometry, count: number, offset: number, tilt: number): void {
    const edges = new THREE.EdgesGeometry(geo, 25);
    for (let i = 0; i < count; i++) {
      const angle = offset + (i / count) * Math.PI * 2;
      // pivot (at the centre) spins to the petal's angle and tilts it back; arm slides it outwards.
      const pivot = new THREE.Group();
      const arm = new THREE.Group();
      arm.add(new THREE.Mesh(geo, this.bodyMat), new THREE.LineSegments(edges, this.edgeMat));
      pivot.add(arm);
      group.add(pivot);
      list.push({ mesh: pivot, angle, baseTilt: tilt });
    }
  }

  setTheme(theme: ThemeColors): void {
    this.bodyMat.color.set(theme.shell);
    this.edgeBase.set(theme.edge);
    this.edgeMat.color.set(theme.edge);
    this.eyeLight.color.set(theme.eye);
  }

  setState(state: GhostState): void {
    if (state === this.state) return;
    if (state === 'done') this.flash = 1;
    this.state = state;
    const t = STATE_TARGETS[state];
    this.target = { ...t, tint: t.tint ? new THREE.Color(t.tint) : null };
  }

  /** Lean towards the input bar while Aaron types (-1 left, +1 right, 0 none). */
  setLean(direction: number): void { this.leanTarget = direction; }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement!;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop(): void {
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
    this.lastFrame = now;
    const t = (this.elapsed += dt);
    const ease = 1 - Math.exp(-dt * 5);
    const c = this.current;
    const g = this.target;
    c.open += (g.open - c.open) * (this.state === 'done' ? 1 - Math.exp(-dt * 14) : ease);
    c.innerSpin += (g.innerSpin - c.innerSpin) * ease;
    c.outerSpin += (g.outerSpin - c.outerSpin) * ease;
    c.bob += (g.bob - c.bob) * ease;
    c.scan += (g.scan - c.scan) * ease;
    c.flicker += (g.flicker - c.flicker) * ease;
    this.lean += (this.leanTarget - this.lean) * ease;
    this.flash = Math.max(0, this.flash - dt * 2.2);

    const level = this.state === 'speaking' ? this.audioLevel() : 0;
    const motion = this.reduced ? 0 : 1;

    this.inner.rotation.z += c.innerSpin * dt * motion;
    this.outer.rotation.z += c.outerSpin * dt * motion;
    this.root.position.y = Math.sin(t * 1.3) * 0.06 * c.bob * motion;
    this.root.rotation.y = (Math.sin(t * 2.4) * 0.35 * c.scan + this.lean * 0.32 + Math.sin(t * 0.7) * 0.05) * motion;
    this.root.rotation.x = (Math.sin(t * 0.9) * 0.05 - c.scan * 0.08) * motion;

    const layout = (list: Petal[], spread: number, extraTilt: number) => {
      for (const p of list) {
        p.mesh.rotation.set(0, 0, p.angle);
        p.mesh.rotateX(-(p.baseTilt + extraTilt)); // lean back, away from the camera, like an opening flower
        p.mesh.children[0].position.y = spread;
      }
    };
    const pulse = level * 0.18;
    layout(this.petals.inner, c.open * 0.22 + pulse, c.open * 0.45);
    layout(this.petals.outer, c.open * 0.3 + pulse * 0.6, c.open * 0.35);

    // Edge glow: theme colour, state tint, "done" flash, error flicker.
    const edge = this.edgeBase.clone();
    if (g.tint) edge.lerp(g.tint, 0.85);
    const flick = c.flicker > 0.01 ? (Math.sin(t * 38) > 0.2 ? 1 : 1 - c.flicker * 0.7) : 1;
    this.edgeMat.color.copy(edge).multiplyScalar(flick * (1 + this.flash * 1.5));
    this.edgeMat.opacity = 0.65 + this.flash * 0.35 + level * 0.3;
    this.eyeLight.intensity = (4 + level * 10 + this.flash * 12) * flick;

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.renderer.dispose();
    this.canvas.remove();
  }
}
