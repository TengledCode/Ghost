import * as THREE from 'three';

// Ghost's holographic projection: a holo-iris disc hovering in front of the lens that slides towards
// where it looks, plus a short, soft directing beam from the eye when it is actively looking at something.

const HOLO_VERT = /* glsl */ `
  varying vec2 vUv;
  varying float vView;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec3 n = normalize(normalMatrix * normal);
    vView = abs(dot(n, normalize(-mv.xyz)));
    gl_Position = projectionMatrix * mv;
  }`;

// Scanlines, a travelling sweep and a faint flicker: the cues that read as "projection".
const HOLO_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 color;
  uniform float opacity, time, useMap, beam;
  varying vec2 vUv;
  varying float vView;
  void main() {
    float a = useMap > 0.5 ? texture2D(map, vUv).a : 1.0;
    float scan = 0.72 + 0.28 * sin((vUv.y * (beam > 0.5 ? 60.0 : 90.0) - time * 6.0));
    float sweep = beam > 0.5 ? smoothstep(0.0, 0.15, fract(vUv.y - time * 0.8)) * 0.5 + 0.5 : 1.0;
    float flicker = 0.92 + 0.08 * sin(time * 53.0) * sin(time * 17.0);
    if (beam > 0.5) a *= (1.0 - vUv.y) * 0.9 + 0.1;          // fades towards the far end
    if (beam > 0.5) a *= pow(1.0 - vView, 1.5) * 0.9 + 0.1;   // brighter at the cone's edges
    float alpha = a * scan * sweep * flicker * opacity;
    gl_FragColor = vec4(color * alpha, min(1.0, alpha));
  }`;

function holoMaterial(map: THREE.Texture | null, beam = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: map }, color: { value: new THREE.Color('#7fd4ff') }, opacity: { value: 0 },
      time: { value: 0 }, useMap: { value: map ? 1 : 0 }, beam: { value: beam ? 1 : 0 },
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
  readonly beam: THREE.Mesh; // world space
  private irisMat = holoMaterial(drawIris());
  private beamMat = holoMaterial(null, true);

  constructor(private readonly irisZ: number) {
    this.iris = new THREE.Mesh(new THREE.PlaneGeometry(0.58, 0.58), this.irisMat);
    this.iris.position.z = irisZ;
    this.iris.renderOrder = 5;
    // Unit-length cone along +Y from the tip (0) to the base (1); stretched to the target each frame.
    const cone = new THREE.CylinderGeometry(0.2, 0.07, 1, 32, 1, true);
    cone.translate(0, 0.5, 0);
    cone.rotateX(Math.PI / 2); // along +Z
    // Flip UVs so v = 0 at the eye and 1 at the target.
    const uv = cone.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    this.beam = new THREE.Mesh(cone, this.beamMat);
    this.beam.renderOrder = 4;
    this.beam.frustumCulled = false;
  }

  /**
   * @param look normalised gaze offset (-1..1) for sliding the holo-iris
   * @param from beam origin (world), to beam target (world)
   * @param beamOn 0..1 visibility of the beam
   */
  update(t: number, dt: number, o: { color: THREE.Color; intensity: number; look: THREE.Vector2; from: THREE.Vector3; to: THREE.Vector3; beamOn: number; irisOn: number; blink: number }): void {
    for (const m of [this.irisMat, this.beamMat]) { m.uniforms.time.value = t; m.uniforms.color.value.copy(o.color); }
    // Holo-iris: slides towards the gaze, rotates slowly, squashes on blink.
    this.iris.position.set(o.look.x * 0.09, o.look.y * 0.09, this.irisZ);
    this.iris.rotation.z += dt * 0.35;
    this.iris.scale.set(1, Math.max(0.05, 1 - o.blink), 1);
    this.irisMat.uniforms.opacity.value = o.irisOn * (1.1 + o.intensity * 0.5); // above 1 so the bloom catches it

    // Beam: a short, soft cone from the lens pointing towards the target (it never reaches it).
    const dir = new THREE.Vector3().subVectors(o.to, o.from);
    const len = Math.min(0.9, dir.length());
    this.beam.position.copy(o.from);
    this.beam.lookAt(o.to);
    this.beam.scale.set(1, 1, len);
    this.beamMat.uniforms.opacity.value = o.beamOn * 0.22;
    this.beam.visible = o.beamOn > 0.01;
  }
}
