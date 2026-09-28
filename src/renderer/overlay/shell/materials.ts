import * as THREE from 'three';
/**
 * A soft studio for metal reflections: a gradient dome (dark floor, cool-grey sky) with three large,
 * dim softboxes. Stock room environments carry near-blinding light panels that flat-shaded facets
 * mirror as white patches, so this one keeps every source gentle.
 */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const studio = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      vertexShader: 'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 p; void main(){
        float h = normalize(p).y;
        vec3 floorC = vec3(0.07, 0.075, 0.09), horizon = vec3(0.34, 0.36, 0.4), sky = vec3(0.58, 0.61, 0.66);
        vec3 c = h < 0.0 ? mix(horizon, floorC, -h) : mix(horizon, sky, h);
        gl_FragColor = vec4(c, 1.0);
      }`,
    }),
  );
  studio.add(dome);
  const softbox = (w: number, h: number, pos: [number, number, number], level: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(level, level, level * 1.04), side: THREE.DoubleSide }));
    m.position.set(...pos);
    m.lookAt(0, 0, 0);
    studio.add(m);
  };
  softbox(6, 4, [-5, 5, 4], 1.7); // key, upper left front
  softbox(4, 6, [6, 1, -3], 0.8); // side
  softbox(8, 2, [0, -2, 7], 0.55); // low front fill
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(studio, 0.04).texture;
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

/** Soft radial falloff used for the magnetic light pools under each shard. */
function radialTexture(size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

export interface GhostMaterials {
  armour: THREE.MeshStandardMaterial;
  armourDark: THREE.MeshStandardMaterial;
  core: THREE.MeshStandardMaterial;
  cavity: THREE.MeshStandardMaterial;
  underside: THREE.MeshStandardMaterial; // plain metal; each shard clones it to catch the magnetic glow below
  pool: THREE.MeshBasicMaterial; // magnetic light pool on the core beneath each shard
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
    color: '#959ca7', metalness: 0.8, roughness: 0.42, roughnessMap: brushed, flatShading: true, envMapIntensity: 1.45,
  });
  const armourDark = armour.clone();
  armourDark.color.set('#6a717c');
  // Engraved, not lit: panel lines are cut into the metal and catch light, with no glow of their own.
  const core = new THREE.MeshStandardMaterial({
    color: '#3a4049', metalness: 0.85, roughness: 0.42, bumpMap: panels, bumpScale: -1.4, envMapIntensity: 1.0, roughnessMap: brushed,
  });
  const cavity = new THREE.MeshStandardMaterial({ color: '#07090c', metalness: 0.3, roughness: 0.9, side: THREE.BackSide });
  // No colour of its own: the glow it shows is reflected light from the pool beneath (set per shard).
  const underside = new THREE.MeshStandardMaterial({ color: '#3a3f47', metalness: 0.9, roughness: 0.3, flatShading: true, envMapIntensity: 0.5, emissive: new THREE.Color('#000000') });
  const pool = new THREE.MeshBasicMaterial({
    color: '#7fd4ff', map: radialTexture(), transparent: true, opacity: 0.5, toneMapped: false, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const lens = new THREE.MeshPhysicalMaterial({
    color: '#0b1a22', metalness: 0, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.28,
    transparent: true, opacity: 0.16, envMapIntensity: 0.55, depthWrite: false,
  });
  const iris = new THREE.MeshBasicMaterial({ color: '#7fd4ff', toneMapped: false, transparent: true, side: THREE.DoubleSide });

  return {
    armour, armourDark, core, cavity, underside, pool, lens, iris,
    setGlow(color, intensity) {
      pool.color.copy(color);
      pool.opacity = Math.min(0.7, 0.06 + intensity * 0.1);
      iris.color.copy(color).multiplyScalar(1.3 + intensity * 0.9);
    },
    setMetal(hex) {
      armour.color.set(hex);
      armourDark.color.set(hex).multiplyScalar(0.8);
      underside.color.set(hex).multiplyScalar(0.5);
    },
  };
}
