import { describe, expect, it } from 'vitest';
import { Curiosity, flourishFor, lookAt, POSES, QualityGovernor, seededRng, Spring } from '../src/renderer/overlay/shell/motion';

describe('Spring', () => {
  it('settles on its target, even at low frame rates', () => {
    for (const dt of [1 / 144, 1 / 30, 0.1]) {
      const s = new Spring(0, 1, 60, 1);
      for (let t = 0; t < 2; t += dt) s.step(dt);
      expect(s.value).toBeCloseTo(1, 3);
    }
  });
  it('overshoots when under-damped (the lively feel)', () => {
    const s = new Spring(0, 1, 60, 0.5);
    let peak = 0;
    for (let i = 0; i < 200; i++) peak = Math.max(peak, s.step(1 / 120));
    expect(peak).toBeGreaterThan(1.05);
  });
});

describe('state choreography', () => {
  it('opens progressively from idle to searching and shuts on done', () => {
    expect(POSES.idle.split).toBeLessThan(POSES.listening.split);
    expect(POSES.listening.split).toBeLessThan(POSES.thinking.split);
    expect(POSES.thinking.split).toBeLessThan(POSES.searching.split);
    expect(POSES.done.split).toBe(0);
  });
  it('uses the right tones and flourishes', () => {
    expect(POSES.thinking.tone).toBe('amber');
    expect(POSES.error.tone).toBe('red');
    expect(flourishFor('idle', 'thinking').spinKick).toBeGreaterThan(0);
    expect(flourishFor('thinking', 'thinking').spinKick).toBe(0);
    expect(flourishFor('speaking', 'done')).toMatchObject({ flash: 1, nod: 1 });
    expect(flourishFor('thinking', 'error').shake).toBe(1);
  });
});

describe('Curiosity', () => {
  it('is deterministic with a seeded RNG and spaces acts 4–9 s apart', () => {
    const run = () => {
      const c = new Curiosity(seededRng(42));
      const acts: number[] = [];
      for (let t = 0; t < 120; t += 0.05) if (c.update(t)) acts.push(Math.round(t * 100) / 100);
      return acts;
    };
    const a = run();
    expect(a).toEqual(run());
    for (let i = 1; i < a.length; i++) expect(a[i] - a[i - 1]).toBeGreaterThanOrEqual(3.95);
    expect(a.length).toBeGreaterThan(10);
  });
  it('saves big moves (spin/shake) for after two minutes', () => {
    const c = new Curiosity(seededRng(7));
    const big: number[] = [];
    for (let t = 0; t < 600; t += 0.1) { const act = c.update(t); if (act && (act.kind === 'spin' || act.kind === 'shake')) big.push(t); }
    expect(big.length).toBeGreaterThan(0);
    expect(big[0]).toBeGreaterThan(120);
  });
});

describe('lookAt', () => {
  it('turns towards the cursor and saturates', () => {
    expect(lookAt(300, 0).yaw).toBeGreaterThan(0);
    expect(lookAt(0, 300).pitch).toBeGreaterThan(0);
    expect(Math.abs(lookAt(-5000, 0).yaw)).toBeLessThanOrEqual(0.6);
  });
});

describe('QualityGovernor', () => {
  it('steps down after sustained slow frames and back up after a comfortable stretch', () => {
    const g = new QualityGovernor('auto');
    for (let i = 0; i < 40; i++) g.sample(1 / 20);
    expect(g.level).toBe('medium');
    for (let i = 0; i < 40; i++) g.sample(1 / 20);
    expect(g.level).toBe('low');
    for (let i = 0; i < 60 * 21; i++) g.sample(1 / 60); // 21 s of comfortable frames
    expect(g.level).toBe('medium');
  });
  it('respects a fixed setting and caps idle frame rate', () => {
    const g = new QualityGovernor('high');
    for (let i = 0; i < 100; i++) g.sample(0.2);
    expect(g.level).toBe('high');
    expect(g.frameInterval(0)).toBeCloseTo(1 / 60);
    expect(g.frameInterval(45)).toBeCloseTo(1 / 30);
  });
});
