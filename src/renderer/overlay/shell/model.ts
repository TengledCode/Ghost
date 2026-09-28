import * as THREE from 'three';
import type { GhostMaterials } from './materials';

// An original companion-drone model: a machined core sphere with a single lens eye, wrapped in eight
// angular armour segments (four framing the eye in an X, four behind offset by 45°) that split apart
// and re-lock. All geometry is procedural.

export interface Segment {
  pivot: THREE.Group; // positioned at the core centre, oriented along the segment's axis
  body: THREE.Group; // slides along the axis (split) and twists around it
  axis: THREE.Vector3;
  ring: 'front' | 'rear';
  index: number;
}

export interface GhostModel {
  root: THREE.Group; // whole drone: body pose (yaw/pitch/roll/bob)
  front: THREE.Group; // front segment set (spins around the eye axis)
  rear: THREE.Group;
  segments: Segment[];
  eye: THREE.Group; // lens assembly, turns slightly ahead of the body
  iris: THREE.Mesh;
  particleAnchor: THREE.Group; // where the particle core goes
  glow: THREE.Mesh; // inner light seen through the seams
  eyeLight: THREE.PointLight;
}

export const CORE_RADIUS = 0.6;
const EYE_OPENING = 0.56; // polar angle (rad) of the eye opening in the core sphere

/**
 * A faceted armour shard: a pyramid on a kite-shaped base, chamfered by a second, smaller ring of
 * vertices so the edges catch highlights. Local +Z points outwards; the base sits at z = 0.
 */
function shardGeometry(len: number, wide: number, height: number): THREE.BufferGeometry {
  const base = [
    new THREE.Vector3(0, -len * 0.55, 0),
    new THREE.Vector3(wide, -len * 0.05, 0),
    new THREE.Vector3(wide * 0.62, len * 0.5, 0),
    new THREE.Vector3(0, len * 0.62, 0),
    new THREE.Vector3(-wide * 0.62, len * 0.5, 0),
    new THREE.Vector3(-wide, -len * 0.05, 0),
  ];
  // Chamfer ring: the base outline pulled in and lifted.
  const chamfer = base.map(p => new THREE.Vector3(p.x * 0.8, p.y * 0.8 + len * 0.06, height * 0.22));
  const apex = new THREE.Vector3(0, len * 0.42, height);
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  const n = base.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(base[i], base[j], chamfer[j]);
    tri(base[i], chamfer[j], chamfer[i]);
    tri(chamfer[i], chamfer[j], apex);
    tri(base[j], base[i], new THREE.Vector3(0, 0, 0)); // underside
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A thin glowing strip that traces the shard's base outline: the "seam" where armour meets core. */
function seamStrip(len: number, wide: number): THREE.BufferGeometry {
  const pts = [
    [0, -len * 0.55], [wide, -len * 0.05], [wide * 0.62, len * 0.5], [0, len * 0.62], [-wide * 0.62, len * 0.5], [-wide, -len * 0.05], [0, -len * 0.55],
  ].map(([x, y]) => new THREE.Vector3(x * 1.02, y * 1.02, 0.012));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.02);
  return new THREE.TubeGeometry(curve, 48, 0.012, 4, true);
}

export function buildModel(m: GhostMaterials): GhostModel {
  const root = new THREE.Group();
  const front = new THREE.Group();
  const rear = new THREE.Group();

  // ---- Core sphere with an opening for the eye (pole rotated to face +Z)
  const coreGeo = new THREE.SphereGeometry(CORE_RADIUS, 64, 40, 0, Math.PI * 2, EYE_OPENING, Math.PI - EYE_OPENING);
  coreGeo.rotateX(Math.PI / 2);
  const core = new THREE.Mesh(coreGeo, m.core);
  const cavity = new THREE.Mesh(new THREE.SphereGeometry(CORE_RADIUS * 0.97, 32, 20), m.cavity);
  root.add(core, cavity);

  // Inner light: a slightly larger additive shell, visible only through the gaps between segments.
  const glow = new THREE.Mesh(new THREE.IcosahedronGeometry(CORE_RADIUS * 1.18, 3), m.glowShell);
  root.add(glow);

  // ---- Eye: lip, iris ring, lens dome
  const eye = new THREE.Group();
  const lipZ = CORE_RADIUS * Math.cos(EYE_OPENING);
  const lipR = CORE_RADIUS * Math.sin(EYE_OPENING);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(lipR, 0.035, 12, 64), m.armour);
  lip.position.z = lipZ;
  const lipSeam = new THREE.Mesh(new THREE.TorusGeometry(lipR - 0.03, 0.008, 6, 64), m.seamBright);
  lipSeam.position.z = lipZ + 0.01;
  const iris = new THREE.Mesh(new THREE.RingGeometry(lipR * 0.62, lipR * 0.8, 64, 1), m.iris);
  iris.position.z = lipZ - 0.06;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(lipR * 1.05, 40, 20, 0, Math.PI * 2, 0, 1.0), m.lens);
  dome.rotateX(Math.PI / 2);
  dome.position.z = lipZ - lipR * 1.05 * Math.cos(1.0) + 0.02;
  const particleAnchor = new THREE.Group();
  particleAnchor.position.z = lipZ - 0.16;
  eye.add(lip, lipSeam, iris, particleAnchor, dome);
  root.add(eye);

  const eyeLight = new THREE.PointLight('#7fd4ff', 2.5, 3, 1.6);
  eyeLight.position.set(0, 0, lipZ + 0.25);
  root.add(eyeLight);

  // ---- Armour segments
  const segments: Segment[] = [];
  const frontGeo = shardGeometry(0.72, 0.27, 0.5);
  const rearGeo = shardGeometry(0.84, 0.3, 0.62);
  const frontEdges = new THREE.EdgesGeometry(frontGeo, 20);
  const rearEdges = new THREE.EdgesGeometry(rearGeo, 20);
  const frontSeam = seamStrip(0.72, 0.27);
  const rearSeam = seamStrip(0.84, 0.3);
  const up = new THREE.Vector3(0, 0, 1);

  const place = (ring: 'front' | 'rear', index: number, axis: THREE.Vector3) => {
    const pivot = new THREE.Group();
    pivot.quaternion.setFromUnitVectors(up, axis);
    // Roll so each shard's long axis points away from the eye (front) or around the back (rear).
    pivot.rotateZ(ring === 'front' ? Math.atan2(axis.y, axis.x) - Math.PI / 2 : Math.atan2(axis.y, axis.x) + Math.PI / 2);
    const body = new THREE.Group();
    body.position.z = CORE_RADIUS * 0.9;
    body.add(
      new THREE.Mesh(ring === 'front' ? frontGeo : rearGeo, ring === 'front' ? m.armour : m.armourDark),
      new THREE.LineSegments(ring === 'front' ? frontEdges : rearEdges, m.seam),
      new THREE.Mesh(ring === 'front' ? frontSeam : rearSeam, m.seamBright),
    );
    pivot.add(body);
    (ring === 'front' ? front : rear).add(pivot);
    segments.push({ pivot, body, axis, ring, index });
  };

  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2; // X around the eye
    place('front', i, new THREE.Vector3(Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.62).normalize());
    const b = (i * Math.PI) / 2; // offset 45°, swept back
    place('rear', i, new THREE.Vector3(Math.cos(b) * 0.8, Math.sin(b) * 0.8, -0.6).normalize());
  }
  root.add(front, rear);

  return { root, front, rear, segments, eye, iris, particleAnchor, glow, eyeLight };
}
