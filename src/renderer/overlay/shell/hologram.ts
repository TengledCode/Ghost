import * as THREE from 'three';

// Ghost's holographic projection: a holo-iris disc hovering in front of the lens that slides towards
// where it looks.

const HOLO_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// Scanlines, a travelling sweep and a faint flicker: the cues that read as "projection".
const HOLO_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 color;
  uniform float opacity, time, useMap, live;
  varying vec2 vUv;
  void main() {
    float a = useMap > 0.5 ? texture2D(map, vUv).a : 1.0;
    float scan = 0.72 + 0.28 * sin(vUv.y * 90.0 - time * 6.0);
    float flicker = 0.92 + 0.08 * sin(time * 53.0) * sin(time * 17.0);
    // Live screen view: a bright band sweeps down the iris, like a scanner reading the screen.
    float sweep = live * 1.6 * smoothstep(0.09, 0.0, abs(fract(time * 0.45) - (1.0 - vUv.y)));
    float alpha = a * (scan + sweep) * flicker * opacity;
    gl_FragColor = vec4(color * alpha, min(1.0, alpha));
  }`;

function holoMaterial(map: THREE.Texture | null): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map }, color: { value: new THREE.Color('#7fd4ff') }, opacity: { value: 0 },
      time: { value: 0 }, useMap: { value: map ? 1 : 0 }, live: { value: 0 },
    },
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
  });
}

function drawIris(size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const m = size / 2;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  const ring = (r: number, w: number, from = 0, to = Math.PI * 2) => { g.lineWidth = w; g.beginPath(); g.arc(m, m, r, from, to); g.stroke(); };
  ring(m * 0.92, 2);
  ring(m * 0.78, 5, 0.2, 1.9);
  ring(m * 0.78, 5, 2.4, 3.6);
  ring(m * 0.78, 5, 4.2, 5.9);
  ring(m * 0.5, 1.5);
  for (let i = 0; i < 48; i++) { // tick marks
    const a = (i / 48) * Math.PI * 2;
    const r1 = m * 0.84, r2 = m * (i % 4 === 0 ? 0.72 : 0.78);
    g.lineWidth = i % 4 === 0 ? 2 : 1;
    g.beginPath(); g.moveTo(m + Math.cos(a) * r1, m + Math.sin(a) * r1); g.lineTo(m + Math.cos(a) * r2, m + Math.sin(a) * r2); g.stroke();
  }
  g.beginPath(); g.arc(m, m, m * 0.08, 0, Math.PI * 2); g.fill();
  return new THREE.CanvasTexture(c);
}

export class Hologram {
  readonly iris: THREE.Mesh; // child of the eye group
  private irisMat = holoMaterial(drawIris());

  constructor(private readonly irisZ: number) {
    this.iris = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.58), this.irisMat);
    this.iris.position.z = irisZ;
    this.iris.renderOrder = 5;
  }

  /** @param look normalised gaze offset (-1..1) for sliding the holo-iris */
  update(t: number, dt: number, o: { color: THREE.Color; intensity: number; look: THREE.Vector2; irisOn: number; blink: number; live?: number }): void {
    this.irisMat.uniforms.live.value = o.live ?? 0;
    this.irisMat.uniforms.time.value = t;
    this.irisMat.uniforms.color.value.copy(o.color);
    // Slides towards the gaze, rotates slowly, squashes on blink.
    this.iris.position.set(o.look.x * 0.09, o.look.y * 0.09, this.irisZ);
    this.iris.rotation.z += dt * 0.35;
    this.iris.scale.set(1, Math.max(0.05, 1 - o.blink), 1);
    this.irisMat.uniforms.opacity.value = o.irisOn * (1.1 + o.intensity * 0.5); // above 1 so the bloom catches it
  }
}
