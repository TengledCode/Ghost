import { describe, expect, it } from 'vitest';
import { shardGeometry } from '../src/renderer/overlay/shell/model';

describe('shard geometry', () => {
  it('is watertight: armour plus underside close every edge (no slit to see through)', () => {
    const { shell, under } = shardGeometry(0.72, 0.27, 0.5);
    const key = (x: number, y: number, z: number) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
    const edges = new Map<string, number>();
    for (const g of [shell, under]) {
      const p = g.getAttribute('position');
      for (let t = 0; t < p.count; t += 3) {
        const v = [0, 1, 2].map(k => key(p.getX(t + k), p.getY(t + k), p.getZ(t + k)));
        for (let k = 0; k < 3; k++) {
          const e = [v[k], v[(k + 1) % 3]].sort().join('|');
          edges.set(e, (edges.get(e) ?? 0) + 1);
        }
      }
    }
    const open = [...edges.values()].filter(n => n !== 2);
    expect(open).toEqual([]);
  });
});
