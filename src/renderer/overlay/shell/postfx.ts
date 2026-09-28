import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Bloom that keeps transparency: this UnrealBloomPass writes bloom alpha = max(rgb) and blends
// additively with premultiplied alpha, so glow halos composite over the desktop in the
// transparent overlay window instead of painting a black box.
export class PostFx {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private enabled = true;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, format: THREE.RGBAFormat });
    this.composer = new EffectComposer(renderer, target);
    const render = new RenderPass(scene, camera);
    render.clearAlpha = 0;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.35, 0.93);
    this.composer.addPass(render);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setSize(w: number, h: number, dpr: number, bloomScale: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
    this.enabled = bloomScale > 0;
    this.bloom.enabled = this.enabled;
    if (this.enabled) this.bloom.resolution.set(Math.max(64, w * dpr * bloomScale), Math.max(64, h * dpr * bloomScale));
  }

  setStrength(s: number): void { this.bloom.strength = s; }

  render(): void { this.composer.render(); }

  dispose(): void { this.composer.dispose(); this.bloom.dispose(); }
}
