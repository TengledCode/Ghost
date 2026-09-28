import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/** Objects on this layer glow (eye, hologram, magnetic pools). Nothing else ever blooms. */
export const BLOOM_LAYER = 1;

// Final composite for a transparent desktop window:
//  - adds the bloom, whose coverage (alpha) is its own brightness,
//  - cuts the faint haze a wide blur leaves across the whole canvas and fades the canvas edges,
//    so there is never a visible box,
//  - un-premultiplies before tone mapping and sRGB encoding, then premultiplies again. Encoding
//    premultiplied colour directly brightens nearly transparent pixels into a grey rectangle.
const FINAL_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D bloomTexture;
  uniform float bloomOn, exposure;
  varying vec2 vUv;
  vec3 rrtOdt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
  vec3 aces(vec3 c) {
    const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    c *= exposure / 0.6;
    return clamp(outM * rrtOdt(inM * c), 0.0, 1.0);
  }
  vec3 srgb(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    vec3 bloom = texture2D(bloomTexture, vUv).rgb * bloomOn;
    float bloomA = max(bloom.r, max(bloom.g, bloom.b));
    bloom *= smoothstep(0.015, 0.07, bloomA);           // drop the faint far haze
    bloomA = max(bloom.r, max(bloom.g, bloom.b));
    vec3 rgb = base.rgb + bloom;
    float a = clamp(max(base.a, bloomA), 0.0, 1.0);
    vec2 e = min(vUv, 1.0 - vUv);
    float edge = smoothstep(0.0, 0.1, min(e.x, e.y));  // nothing may reach the canvas border
    rgb *= edge; a *= edge;
    if (a < 0.002) { gl_FragColor = vec4(0.0); return; }
    vec3 c = srgb(aces(rgb / a));
    gl_FragColor = vec4(c * a, a);
  }`;

const FINAL_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/**
 * Selective bloom: a first pass renders only BLOOM_LAYER objects (other solid geometry is drawn
 * black so it still hides glow behind it) and blurs them. The final pass composites that glow over
 * the normally rendered scene. Metal highlights, however bright, never bloom.
 */
export class PostFx {
  private bloomComposer: EffectComposer;
  private finalComposer: EffectComposer;
  private bloom: UnrealBloomPass;
  private final: ShaderPass;
  private enabled = true;
  private layer = new THREE.Layers();
  private black = [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide].map(side => new THREE.MeshBasicMaterial({ color: 0x000000, side }));
  private saved = new Map<THREE.Object3D, THREE.Material | THREE.Material[]>();
  private hidden: THREE.Object3D[] = [];

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, camera: THREE.Camera) {
    this.layer.set(BLOOM_LAYER);
    const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat });

    this.bloomComposer = new EffectComposer(renderer, rt());
    this.bloomComposer.renderToScreen = false;
    const bloomRender = new RenderPass(scene, camera);
    bloomRender.clearAlpha = 0;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.8, 0.28, 0.1);
    this.bloomComposer.addPass(bloomRender);
    this.bloomComposer.addPass(this.bloom);

    this.finalComposer = new EffectComposer(renderer, rt());
    const render = new RenderPass(scene, camera);
    render.clearAlpha = 0;
    this.final = new ShaderPass(new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, bloomTexture: { value: this.bloomComposer.renderTarget2.texture }, bloomOn: { value: 1 }, exposure: { value: 1 } },
      vertexShader: FINAL_VERT, fragmentShader: FINAL_FRAG,
    }));
    this.finalComposer.addPass(render);
    this.finalComposer.addPass(this.final);
  }

  setSize(w: number, h: number, dpr: number, bloomScale: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    for (const c of [this.bloomComposer, this.finalComposer]) { c.setPixelRatio(dpr); c.setSize(w, h); }
    this.enabled = bloomScale > 0;
    this.final.uniforms.bloomOn.value = this.enabled ? 1 : 0;
    if (this.enabled) this.bloom.resolution.set(Math.max(64, w * dpr * bloomScale), Math.max(64, h * dpr * bloomScale));
  }

  setStrength(s: number): void { this.bloom.strength = s; }

  setExposure(e: number): void { this.final.uniforms.exposure.value = e; }

  render(): void {
    if (this.enabled) {
      this.isolateGlow();
      this.bloomComposer.render();
      this.restore();
    }
    this.finalComposer.render();
  }

  /** Solid non-glowing geometry turns black (it still blocks glow behind it); see-through non-glowing parts hide. */
  private isolateGlow(): void {
    this.scene.traverse(obj => {
      const o = obj as THREE.Mesh;
      if (!(o.isMesh || (obj as THREE.Points).isPoints || (obj as THREE.Line).isLine) || this.layer.test(obj.layers)) return;
      const mat = o.material as THREE.Material;
      if (mat.transparent || (obj as THREE.Points).isPoints || (obj as THREE.Line).isLine) {
        if (obj.visible) { obj.visible = false; this.hidden.push(obj); }
      } else {
        this.saved.set(obj, o.material);
        o.material = this.black[mat.side]; // keep the side, or inside-out parts (the eye cavity) would hide the core
      }
    });
  }

  private restore(): void {
    for (const [obj, mat] of this.saved) (obj as THREE.Mesh).material = mat;
    for (const obj of this.hidden) obj.visible = true;
    this.saved.clear();
    this.hidden = [];
  }

  dispose(): void { this.bloomComposer.dispose(); this.finalComposer.dispose(); this.bloom.dispose(); }
}
