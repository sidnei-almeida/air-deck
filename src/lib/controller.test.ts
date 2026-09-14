import { describe, expect, it } from 'vitest';
import { AimDwell, SteadyPoint } from './controller';

describe('AimDwell', () => {
  it('fills while the point holds still and restarts when it wanders off', () => {
    const aim = new AimDwell();
    expect(aim.update(100, 100, 0, 20, 350)).toBe(0);
    expect(aim.update(105, 98, 200, 20, 350)).toBeCloseTo(200 / 350);
    expect(aim.update(140, 100, 250, 20, 350)).toBe(0);
    expect(aim.update(141, 101, 600, 20, 350)).toBe(1);
  });
});

const STEADY = { glideMs: 70, settleMs: 420 };

describe('SteadyPoint', () => {
  it('a trembling hand holding still barely moves the point', () => {
    const s = new SteadyPoint();
    s.reset(500, 400, 0);
    let spread = 0;
    for (let i = 1; i < 120; i++) {
      const p = s.update(500 + Math.sin(i * 2.3) * 12, 400 + Math.cos(i * 1.7) * 12, i * 33, 24, STEADY);
      if (i > 30) spread = Math.max(spread, Math.hypot(p.x - 500, p.y - 400));
    }
    expect(spread).toBeLessThan(4);
  });

  it('follows a deliberate move and lands on the finger once it rests', () => {
    const s = new SteadyPoint();
    s.reset(0, 0, 0);
    let t = 0;
    for (let i = 1; i <= 15; i++) s.update(i * 20, 0, (t += 33), 24, STEADY);
    const moving = s.update(300, 0, (t += 33), 24, STEADY);
    expect(moving.x).toBeGreaterThan(200);
    let rest = moving;
    for (let i = 0; i < 60; i++) rest = s.update(300, 0, (t += 33), 24, STEADY);
    expect(rest.x).toBeGreaterThan(297);
  });
});
