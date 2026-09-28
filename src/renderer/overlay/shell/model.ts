import * as THREE from 'three';
import type { GhostMaterials } from './materials';

// An original companion-drone model: a machined core sphere with a single lens eye, wrapped in eight
// angular armour shards (four framing the eye in an X, four behind offset by 45°). The shards are not
// attached: they hover off the core as if held magnetically, with light pooling beneath each one.
// All geometry is procedural.

export interface Segment {
  pivot: THREE.Group; // at the core centre, oriented along the segment's axis
  body: THREE.Group; // slides along the axis (lift/split), twists and wobbles
  pool: THREE.Mesh; // magnetic light pool on the core under the shard
  axis: THREE.Vector3;
  ring: 'front' | 'rear';
  index: number;
  phase: number; // per-shard float rhythm
}

export interface GhostModel {
  root: THREE.Group; // whole drone: body pose (yaw/pitch/roll/hover)
  front: THREE.Group; // front shard set (spins around the eye axis)
  rear: THREE.Group;
  segments: Segment[];
  eye: THREE.Group; // lens assembly; leads the body when looking
  iris: THREE.Mesh;
  particleAnchor: THREE.Group; // where the particle core goes
  eyeFront: THREE.Vector3; // lens front centre in root space (for the hologram)
  eyeLight: THREE.PointLight;
}

export const CORE_RADIUS = 0.6;
export const SHARD_REST = CORE_RADIUS * 0.93; // resting height of a shard's base above the core centre
const EYE_OPENING = 0.56; // polar angle (rad) of the eye opening in the core sphere

/**
 * A faceted armour shard: a pyramid on a kite-shaped base, chamfered by a second ring of vertices
 * so the edges catch highlights. Local +Z points outwards and the base sits at z = 0. It returns the
 * armour faces and the underside cap separately, because the underside glows.
 */
function shardGeometry(len: number, wide: number, height: number): { shell: THREE.BufferGeometry; under: THREE.BufferGeometry } {
  const base = [
    new THREE.Vector3(0, -len * 0.55, 0),
    new THREE.Vector3(wide, -len * 0.05, 0),
    new THREE.Vector3(wide * 0.62, len * 0.5, 0),
    new THREE.Vector3(0, len * 0.62, 0),
    new THREE.Vector3(-wide * 0.62, len * 0.5, 0),
    new THREE.Vector3(-wide, -len * 0.05, 0),
  ];
  const chamfer = base.map(p => new THREE.Vector3(p.x * 0.8, p.y * 0.8 + len * 0.06, height * 0.22));
  const apex = new THREE.Vector3(0, len * 0.42, height);
  const shell: number[] = [];
  const under: number[] = [];
  const tri = (out: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  const centre = new THREE.Vector3(0, 0, 0.004);
  for (let i = 0; i < base.length; i++) {
    const j = (i + 1) % base.length;
    tri(shell, base[i], base[j], chamfer[j]);
    tri(shell, base[i], chamfer[j], chamfer[i]);
    tri(shell, chamfer[i], chamfer[j], apex);
    // Underside, slightly shrunk so it never z-fights with the armour's bottom edge.
    tri(under, base[j].clone().multiplyScalar(0.96), base[i].clone().multiplyScalar(0.96), centre);
  }
  const build = (arr: number[]) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.computeVertexNormals();
    return g;
  };
  return { shell: build(shell), under: build(under) };
}

export function buildModel(m: GhostMaterials): GhostModel {
  const root = new THREE.Group();
  const front = new THREE.Group();
  const rear = new THREE.Group();

  // ---- Core sphere with an opening for the eye (pole rotated to face +Z)
  const coreGeo = new THREE.SphereGeometry(CORE_RADIUS, 64, 40, 0, Math.PI * 2, EYE_OPENING, Math.PI - EYE_OPENING);
  coreGeo.rotateX(Math.PI / 2);
  root.add(new THREE.Mesh(coreGeo, m.core), new THREE.Mesh(new THREE.SphereGeometry(CORE_RADIUS * 0.97, 32, 20), m.cavity));

  // ---- Eye: machined lip, iris ring, lens dome, particle core behind it
  const eye = new THREE.Group();
  const lipZ = CORE_RADIUS * Math.cos(EYE_OPENING);
  const lipR = CORE_RADIUS * Math.sin(EYE_OPENING);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(lipR, 0.038, 14, 72), m.armour);
  lip.position.z = lipZ;
  const iris = new THREE.Mesh(new THREE.RingGeometry(lipR * 0.64, lipR * 0.78, 72, 1), m.iris);
  iris.position.z = lipZ - 0.06;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(lipR * 1.05, 40, 20, 0, Math.PI * 2, 0, 1.0), m.lens);
  dome.rotateX(Math.PI / 2);
  dome.position.z = lipZ - lipR * 1.05 * Math.cos(1.0) + 0.02;
  const particleAnchor = new THREE.Group();
  particleAnchor.position.z = lipZ - 0.16;
  eye.add(lip, iris, particleAnchor, dome);
  root.add(eye);

  const eyeLight = new THREE.PointLight('#7fd4ff', 2.5, 3, 1.6);
  eyeLight.position.set(0, 0, lipZ + 0.25);
  root.add(eyeLight);

  // ---- Armour shards
  const segments: Segment[] = [];
  const frontGeo = shardGeometry(0.72, 0.27, 0.5);
  const rearGeo = shardGeometry(0.84, 0.3, 0.62);
  const poolGeo = new THREE.PlaneGeometry(0.5, 0.5);
  const up = new THREE.Vector3(0, 0, 1);

  const place = (ring: 'front' | 'rear', index: number, axis: THREE.Vector3) => {
    const pivot = new THREE.Group();
    pivot.quaternion.setFromUnitVectors(up, axis);
    pivot.rotateZ(ring === 'front' ? Math.atan2(axis.y, axis.x) - Math.PI / 2 : Math.atan2(axis.y, axis.x) + Math.PI / 2);
    const geo = ring === 'front' ? frontGeo : rearGeo;
    const body = new THREE.Group();
    body.position.z = SHARD_REST;
    body.add(new THREE.Mesh(geo.shell, ring === 'front' ? m.armour : m.armourDark), new THREE.Mesh(geo.under, m.underGlow));
    const pool = new THREE.Mesh(poolGeo, m.pool);
    pool.position.z = CORE_RADIUS * 1.004;
    pool.renderOrder = 2;
    pivot.add(body, pool);
    (ring === 'front' ? front : rear).add(pivot);
    segments.push({ pivot, body, pool, axis, ring, index, phase: index * 1.618 + (ring === 'rear' ? 0.9 : 0) });
  };

  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2; // X around the eye
    place('front', i, new THREE.Vector3(Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0.62).normalize());
    const b = (i * Math.PI) / 2; // offset 45°, swept back
    place('rear', i + 4, new THREE.Vector3(Math.cos(b) * 0.8, Math.sin(b) * 0.8, -0.6).normalize());
  }
  root.add(front, rear);

  return { root, front, rear, segments, eye, iris, particleAnchor, eyeFront: new THREE.Vector3(0, 0, lipZ + 0.05), eyeLight };
}
