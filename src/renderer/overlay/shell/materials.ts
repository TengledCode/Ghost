import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Studio reflections for the metal. Without an environment, metal renders flat and dark. */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  pmrem.dispose();
  return env;
}

/** Brushed-metal roughness streaks plus fine grain, generated once on a canvas. */
function brushedTexture(size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8a8a8a';
  g.fillRect(0, 0, size, size);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const y = rnd() * size;
    const v = 110 + rnd() * 70;
    g.strokeStyle = `rgba(${v},${v},${v},${0.15 + rnd() * 0.25})`;
    g.lineWidth = 0.5 + rnd();
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(size, y + (rnd() - 0.5) * 4);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Engraved panel lines for the core sphere: an emissive map (lines glow) and a bump map (lines recess). */
function panelTexture(size = 512): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size / 2;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  // Latitude bands and staggered meridian cuts: reads as machined panels at small sizes.
  for (const y of [0.22, 0.4, 0.6, 0.78]) { g.beginPath(); g.moveTo(0, y * c.height); g.lineTo(c.width, y * c.height); g.stroke(); }
  for (let i = 0; i < 12; i++) {
    const x = (i / 12) * c.width;
    const off = (i % 2) * (c.width / 24);
    g.beginPath(); g.moveTo(x + off, 0.22 * c.height); g.lineTo(x + off, 0.4 * c.height); g.stroke();
    g.beginPath(); g.moveTo(x, 0.6 * c.height); g.lineTo(x, 0.78 * c.height); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export interface GhostMaterials {
  armour: THREE.MeshStandardMaterial;
  armourDark: THREE.MeshStandardMaterial;
  core: THREE.MeshStandardMaterial;
  cavity: THREE.MeshStandardMaterial;
  seam: THREE.LineBasicMaterial;
  seamBright: THREE.MeshBasicMaterial;
  glowShell: THREE.MeshBasicMaterial;
  lens: THREE.MeshPhysicalMaterial;
  iris: THREE.MeshBasicMaterial;
  setGlow(color: THREE.Color, intensity: number): void;
  setMetal(color: string): void;
}

export function createMaterials(): GhostMaterials {
  const brushed = brushedTexture();
  brushed.repeat.set(2, 2);
  const panels = panelTexture();
  const armour = new THREE.MeshStandardMaterial({
    color: '#5b616b', metalness: 0.88, roughness: 0.34, roughnessMap: brushed, flatShading: true, envMapIntensity: 0.55,
  });
  const armourDark = armour.clone();
  armourDark.color.set('#2a2e35');
  const core = new THREE.MeshStandardMaterial({
    color: '#2b3038', metalness: 0.85, roughness: 0.45, bumpMap: panels, bumpScale: -1.2, envMapIntensity: 0.5,
    emissive: new THREE.Color('#7fd4ff'), emissiveMap: panels, emissiveIntensity: 0.6,
  });
  const cavity = new THREE.MeshStandardMaterial({ color: '#07090c', metalness: 0.3, roughness: 0.9, side: THREE.BackSide });
  const seam = new THREE.LineBasicMaterial({ color: '#7fd4ff', transparent: true, opacity: 0.55, toneMapped: false });
  const seamBright = new THREE.MeshBasicMaterial({ color: '#7fd4ff', toneMapped: false });
  const glowShell = new THREE.MeshBasicMaterial({ color: '#7fd4ff', transparent: true, opacity: 0.35, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
  const lens = new THREE.MeshPhysicalMaterial({
    color: '#0b1a22', metalness: 0, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.03,
    transparent: true, opacity: 0.22, envMapIntensity: 1.2, depthWrite: false,
  });
  const iris = new THREE.MeshBasicMaterial({ color: '#7fd4ff', toneMapped: false, transparent: true, side: THREE.DoubleSide });

  return {
    armour, armourDark, core, cavity, seam, seamBright, glowShell, lens, iris,
    setGlow(color, intensity) {
      // Values above ~1 cross the bloom threshold; keep the armour itself below it.
      seam.color.copy(color).multiplyScalar(0.45 + intensity * 0.25);
      seamBright.color.copy(color).multiplyScalar(0.6 + intensity * 0.75);
      core.emissive.copy(color);
      core.emissiveIntensity = 0.12 + intensity * 0.22;
      glowShell.color.copy(color);
      glowShell.opacity = Math.min(0.8, 0.1 + intensity * 0.12);
      iris.color.copy(color).multiplyScalar(0.7 + intensity * 0.6);
    },
    setMetal(hex) {
      armour.color.set(hex);
      armourDark.color.set(hex).multiplyScalar(0.6);
    },
  };
}
