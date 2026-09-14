import { describe, expect, it } from 'vitest';
import { balanceReach, classifyPose, DEFAULT_REACH, fingerAngle, GestureEngine, GESTURE, ThumbsUpHold, type FrameOutput, type Landmark, type Pose } from './gestures';

type Dir = 'up' | 'right' | 'left' | 'down';
const UP: Record<Exclude<Pose, 'none'>, number[]> = {
  open: [1, 1, 1, 1],
  four: [1, 1, 1, 1],
  fist: [0, 0, 0, 0],
  point: [1, 0, 0, 0],
  two: [1, 1, 0, 0],
  three: [1, 1, 1, 0],
  pinch: [1, 0, 0, 0],
  pinchMiddle: [1, 1, 1, 1],
  pinchRing: [1, 1, 1, 1],
  pinchPinky: [1, 1, 1, 1],
  thumbsDown: [0, 0, 0, 0],
  thumbsUp: [0, 0, 0, 0],
};
/** Finger (0 index … 3 pinky) that bends to meet the thumb. */
const PINCHED: Partial<Record<Pose, number>> = { pinchMiddle: 1, pinchRing: 2, pinchPinky: 3 };

/** Synthetic hand. `dir` is where the fingers point on the mirrored screen. Normalized coords, aspect 1. */
function hand(pose: Exclude<Pose, 'none'>, dir: Dir = 'up', at: Landmark = { x: 0.5, y: 0.75 }): Landmark[] {
  const d = dir === 'up' ? { x: 0, y: -1 } : dir === 'down' ? { x: 0, y: 1 } : dir === 'right' ? { x: -1, y: 0 } : { x: 1, y: 0 };
  const side = { x: -d.y, y: d.x };
  const P = (along: number, across: number) => ({ x: at.x + d.x * along + side.x * across, y: at.y + d.y * along + side.y * across });
  const lm: Landmark[] = new Array(21);
  lm[0] = P(0, 0);
  lm[1] = P(0.05, -0.05);
  lm[2] = P(0.09, -0.09);
  lm[3] = pose === 'open' ? P(0.12, -0.13) : P(0.12, -0.06);
  lm[4] = pose === 'open' ? P(0.15, -0.17) : P(0.14, -0.02);
  [-0.06, -0.01, 0.04, 0.085].forEach((across, i) => {
    const base = 5 + i * 4;
    lm[base] = P(0.18, across);
    if (PINCHED[pose] === i) {
      lm[base + 1] = P(0.25, across);
      lm[base + 2] = P(0.27, across - 0.01);
      lm[base + 3] = P(0.24, across - 0.02);
    } else if (UP[pose][i]) {
      lm[base + 1] = P(0.25, across);
      lm[base + 2] = P(0.3, across);
      lm[base + 3] = P(0.35, across);
    } else {
      lm[base + 1] = P(0.24, across);
      lm[base + 2] = P(0.2, across);
      lm[base + 3] = P(0.15, across);
    }
  });
  const pinchTip = pose === 'pinch' ? 8 : PINCHED[pose] !== undefined ? 8 + PINCHED[pose]! * 4 : null;
  if (pinchTip !== null) lm[4] = { x: lm[pinchTip].x + 0.01, y: lm[pinchTip].y + 0.01 };
  if (pose === 'thumbsDown') {
    lm[3] = P(0, -0.1);
    lm[4] = P(-0.12, -0.1);
  }
  if (pose === 'thumbsUp') {
    lm[3] = P(0.25, -0.1);
    lm[4] = P(0.4, -0.1);
  }
  return lm;
}

const W = 1920;
const H = 1080;

function run(engine: GestureEngine, frames: Landmark[][][], { t0 = 0, step = 33 } = {}) {
  const events: string[] = [];
  const outputs: FrameOutput[] = [];
  let t = t0;
  for (const hands of frames) {
    const out = engine.update({ hands, aspect: 1, t, width: W, height: H });
    events.push(...out.events.map(e => e.type));
    outputs.push(out);
    t += step;
  }
  return { events, t, last: outputs[outputs.length - 1], outputs };
}

const repeat = (hands: Landmark[] | Landmark[][], n: number): Landmark[][][] =>
  Array.from({ length: n }, () => (Array.isArray(hands[0]) ? (hands as Landmark[][]) : [hands as Landmark[]]));

const openMenu = (e: GestureEngine, t0 = 0) => run(e, repeat(hand('open'), Math.ceil((GESTURE.menuOpenHoldMs + 250) / 33)), { t0 });

describe('classifyPose', () => {
  it.each(['open', 'four', 'fist', 'point', 'two', 'three', 'pinch', 'pinchMiddle', 'pinchRing', 'pinchPinky', 'thumbsDown', 'thumbsUp'] as const)('recognizes %s', pose => {
    expect(classifyPose(hand(pose), 1)).toBe(pose);
  });

  it('a fist with the thumb over the fingers is not a pinch', () => {
    const fist = hand('fist');
    fist[4] = { x: fist[12].x + 0.01, y: fist[12].y + 0.01 };
    expect(classifyPose(fist, 1)).toBe('fist');
  });

  it('pointing with the thumb resting on the curled middle finger is still pointing', () => {
    const pointing = hand('point');
    pointing[4] = { x: pointing[12].x + 0.005, y: pointing[12].y };
    expect(classifyPose(pointing, 1)).toBe('point');
  });

  it('three fingers with the thumb holding a folded pinky are three, not an arrow', () => {
    const three = hand('three');
    three[4] = { x: three[20].x + 0.005, y: three[20].y };
    expect(classifyPose(three, 1)).toBe('three');
  });

  it('a thumb between two fingertips is not a pinch yet', () => {
    const between = hand('open');
    between[4] = { x: (between[12].x + between[16].x) / 2, y: between[12].y + 0.02 };
    expect(classifyPose(between, 1)).not.toMatch(/^pinch/);
  });

  it('keeps the pinch while the index curls during writing', () => {
    const curled = hand('fist');
    curled[4] = { x: curled[8].x + 0.01, y: curled[8].y + 0.01 };
    expect(classifyPose(curled, 1)).toBe('fist');
    expect(classifyPose(curled, 1, 'pinch')).toBe('pinch');
  });

  it('ignores partial landmark sets', () => {
    expect(classifyPose(hand('open').slice(0, 10), 1)).toBe('none');
  });

  it('reads finger direction on the mirrored screen', () => {
    expect(fingerAngle(hand('two'), 1)).toBeCloseTo(-90, 0);
    expect(Math.abs(fingerAngle(hand('two', 'right'), 1))).toBeLessThan(1);
  });
});

describe('page turns', () => {
  it('two fingers pointing right, held, advance once', () => {
    expect(run(new GestureEngine(), repeat(hand('two', 'right'), 30)).events).toEqual(['next']);
  });

  it('two fingers pointing left go back', () => {
    expect(run(new GestureEngine(), repeat(hand('two', 'left'), 30)).events).toEqual(['prev']);
  });

  it('shows progress on the side being pointed at', () => {
    const { outputs } = run(new GestureEngine(), repeat(hand('two', 'right'), 8));
    expect(outputs.some(o => (o.nav?.lean ?? 0) > 0.3)).toBe(true);
  });

  it('a brief flicker of two fingers does nothing', () => {
    expect(run(new GestureEngine(), [...repeat(hand('two', 'right'), 6), ...repeat(hand('point', 'right'), 20)]).events).toEqual([]);
  });

  it('relax the hand and point again for the next slide', () => {
    const frames = [...repeat(hand('two', 'right'), 20), ...repeat(hand('open'), 6), ...repeat(hand('two', 'right'), 20)];
    expect(run(new GestureEngine(), frames).events).toEqual(['next', 'next']);
  });

  it('two fingers up do nothing', () => {
    expect(run(new GestureEngine(), repeat(hand('two'), 40)).events).toEqual([]);
  });

  it('one finger pointing sideways is just the laser', () => {
    expect(run(new GestureEngine(), repeat(hand('point', 'right'), 40)).events).toEqual([]);
  });

  it('three fingers no longer do anything by themselves', () => {
    expect(run(new GestureEngine(), repeat(hand('three'), 40)).events).toEqual([]);
  });
});

describe('menu', () => {
  it('an open palm held still opens it', () => {
    const { events, last } = openMenu(new GestureEngine());
    expect(events).toEqual(['menu-open']);
    expect(last.menuOpen).toBe(true);
  });

  it('a moving palm does not open it', () => {
    const frames = Array.from({ length: 40 }, (_, i) => [hand('open', 'up', { x: 0.5, y: 0.75 - (i % 2 ? 0.04 : 0) })]);
    expect(run(new GestureEngine(), frames).events).toEqual([]);
  });

  it('pointing inside the menu gives a pointer, pinching clicks', () => {
    const e = new GestureEngine();
    const opened = openMenu(e);
    const pointing = run(e, repeat(hand('point'), 8), { t0: opened.t });
    expect(pointing.last.tool).toBe('menu');
    expect(pointing.last.pointer).not.toBeNull();
    const clicked = run(e, repeat(hand('pinch'), 6), { t0: pointing.t });
    expect(clicked.events).toEqual(['menu-click']);
  });

  it('two fingers to the side close it instead of changing slides', () => {
    const e = new GestureEngine();
    const opened = openMenu(e);
    const { events } = run(e, repeat(hand('two', 'right'), 20), { t0: opened.t });
    expect(events).toEqual(['menu-close']);
  });
});

describe('tools', () => {
  it('one finger is the laser by default', () => {
    const { last } = run(new GestureEngine(), repeat(hand('point'), 6));
    expect(last.tool).toBe('laser');
    expect(last.pointer).not.toBeNull();
  });

  it('one finger erases when the eraser is picked', () => {
    const { last } = run(new GestureEngine({ pointerTool: 'eraser' }), repeat(hand('point'), 6));
    expect(last.tool).toBe('eraser');
    expect(last.pointer).toBeNull();
  });

  it('the lens tolerates a brief flicker and lets go afterwards', () => {
    const e = new GestureEngine({ pointerTool: 'lens' });
    const pointing = run(e, repeat(hand('point'), 6));
    expect(pointing.last.zoom).toMatchObject({ level: GESTURE.lensLevel, follow: true });
    const flicker = run(e, [...repeat(hand('two'), 5), ...repeat(hand('point'), 4)], { t0: pointing.t });
    expect(flicker.events).toEqual([]);
    const away = run(e, repeat(hand('two'), 20), { t0: flicker.t });
    expect(away.events).toEqual(['zoom-reset']);
  });

  it('a pinch puts the pen down', () => {
    const { last } = run(new GestureEngine(), repeat(hand('pinch'), 6));
    expect(last.tool).toBe('pen');
    expect(last.penDown).toBe(true);
  });

  it('holding the pen still asks for a shape once', () => {
    const { events } = run(new GestureEngine(), repeat(hand('pinch'), 50));
    expect(events).toEqual(['pen-hold']);
  });

  it.each([
    ['pinchMiddle', 'rect'],
    ['pinchRing', 'ellipse'],
    ['pinchPinky', 'arrow'],
  ] as const)('%s draws a %s', (pose, tool) => {
    const { last, events } = run(new GestureEngine(), repeat(hand(pose), 50));
    expect(last.tool).toBe(tool);
    expect(last.penDown).toBe(true);
    expect(events).toEqual([]);
  });

  it('shape pinches point with the index tip, right where the laser was', () => {
    const laser = run(new GestureEngine(), repeat(hand('point'), 6)).last.pointer!;
    for (const pose of ['pinchMiddle', 'pinchRing', 'pinchPinky'] as const) {
      const pinch = run(new GestureEngine(), repeat(hand(pose), 6)).last.pointer!;
      expect(Math.hypot(pinch.x - laser.x, pinch.y - laser.y)).toBeLessThan(2);
    }
  });

  it('keeps the tool picked at the start when the finger flickers mid-stroke', () => {
    const { outputs } = run(new GestureEngine(), [...repeat(hand('pinchMiddle'), 6), ...repeat(hand('pinchRing'), 10), ...repeat(hand('pinchMiddle'), 4)]);
    expect(outputs.slice(3).every(o => o.tool === 'rect' && o.penDown)).toBe(true);
  });

  it('a thumb down held still clears once', () => {
    const e = new GestureEngine();
    const held = run(e, repeat(hand('thumbsDown'), 60));
    expect(held.events).toEqual(['clear']);
    expect(held.outputs.some(o => o.hold?.kind === 'clear')).toBe(true);
    const again = run(e, [...repeat(hand('point'), 5), ...repeat(hand('thumbsDown'), 40)], { t0: held.t });
    expect(again.events).toEqual(['clear']);
  });

  it('a thumbs up does nothing when there is nothing to confirm', () => {
    const { events, last } = run(new GestureEngine(), repeat(hand('thumbsUp'), 40));
    expect(events).toEqual([]);
    expect(last.tool).toBeNull();
    expect(last.hold).toBeNull();
  });

  it('a thumbs up held is OK once when something is open, even the menu', () => {
    const e = new GestureEngine();
    const opened = openMenu(e);
    e.setConfirmAvailable(true);
    const { events, outputs } = run(e, repeat(hand('thumbsUp'), 50), { t0: opened.t });
    expect(events).toEqual(['confirm']);
    expect(outputs.some(o => o.hold?.kind === 'confirm')).toBe(true);
  });

  it('the OK survives a tracking flicker but restarts when the thumb comes down', () => {
    const hold = new ThumbsUpHold();
    hold.update(true, 0);
    hold.update(false, 100);
    expect(hold.update(true, 600).progress).toBeCloseTo(600 / GESTURE.confirmHoldMs);
    hold.update(false, 700);
    hold.update(false, 900);
    expect(hold.update(true, 1000).progress).toBe(0);
    expect(hold.update(true, 1000 + GESTURE.confirmHoldMs).fire).toBe(true);
  });

  it('keeps the pen down through a tracking gap', () => {
    const e = new GestureEngine();
    const { t } = run(e, repeat(hand('pinch'), 8));
    const gap = run(e, Array.from({ length: 18 }, () => []), { t0: t });
    expect(gap.last.penDown).toBe(true);
    const long = run(e, Array.from({ length: 12 }, () => []), { t0: gap.t });
    expect(long.last.penDown).toBe(false);
  });
});

describe('undo and redo', () => {
  const withHistory = () => {
    const e = new GestureEngine();
    e.setHistory(true, true);
    return e;
  };

  it('three fingers up, held still, undo once', () => {
    const { events, outputs } = run(withHistory(), repeat(hand('three'), 50));
    expect(events).toEqual(['undo']);
    expect(outputs.some(o => o.hold?.kind === 'undo')).toBe(true);
  });

  it('four fingers up with the thumb folded redo', () => {
    expect(run(withHistory(), repeat(hand('four'), 50)).events).toEqual(['redo']);
  });

  it('nothing to undo: no ring and no event', () => {
    const { events, outputs } = run(new GestureEngine(), repeat(hand('three'), 50));
    expect(events).toEqual([]);
    expect(outputs.every(o => o.hold === null)).toBe(true);
  });

  it('lower the fingers and raise them again to undo twice', () => {
    const frames = [...repeat(hand('three'), 40), ...repeat(hand('point'), 6), ...repeat(hand('three'), 40)];
    expect(run(withHistory(), frames).events).toEqual(['undo', 'undo']);
  });

  it('an open palm is still the menu, never redo', () => {
    expect(openMenu(withHistory()).events).toEqual(['menu-open']);
  });

  it('three fingers pointing sideways do nothing', () => {
    expect(run(withHistory(), repeat(hand('three', 'right'), 50)).events).toEqual([]);
  });
});

describe('zoom', () => {
  it('a raised fist zooms in at the last laser position', () => {
    const e = new GestureEngine();
    const laser = run(e, repeat(hand('point'), 8));
    const laserAt = laser.last.pointer!;
    const frames = Array.from({ length: 30 }, (_, i) => [hand('fist', 'up', { x: 0.5, y: 0.75 - i * 0.01 })]);
    const { last } = run(e, frames, { t0: laser.t });
    expect(last.tool).toBe('zoom');
    expect(last.zoom!.level).toBeGreaterThan(1.5);
    expect(last.zoom!.originX).toBeCloseTo(laserAt.x, 0);
  });

  it('a pinch with the other hand zooms while the first hand points', () => {
    const frames = Array.from({ length: 30 }, (_, i) => [hand('point', 'up', { x: 0.6, y: 0.7 }), hand('pinch', 'up', { x: 0.25, y: 0.8 - i * 0.01 })]);
    const { last } = run(new GestureEngine(), frames);
    expect(last.tool).toBe('zoom');
    expect(last.zoom!.level).toBeGreaterThan(1.3);
  });

  it('two open hands reset the zoom without opening the menu', () => {
    const e = new GestureEngine();
    e.setZoom(2);
    const { events } = run(e, repeat([hand('open', 'up', { x: 0.65, y: 0.75 }), hand('open', 'up', { x: 0.3, y: 0.75 })], 30));
    expect(events).toEqual(['zoom-reset']);
  });
});

describe('reach', () => {
  it('widens a tall, narrow reach box instead of flinging the cursor sideways', () => {
    const box = balanceReach({ x0: 0.64, x1: 1, y0: 0.05, y1: 0.89 }, 4 / 3, 16 / 9);
    expect(box.x0).toBeCloseTo(0);
    expect(box.x1).toBeCloseTo(1);
    expect(box.y1 - box.y0).toBeCloseTo(0.84);
  });

  it('leaves the default box nearly as it is, and stays inside the camera', () => {
    const box = balanceReach(DEFAULT_REACH, 4 / 3, 16 / 9);
    expect(box.x1 - box.x0).toBeCloseTo(0.667, 2);
    expect(box.y1 - box.y0).toBeCloseTo(0.5, 5);
    const edge = balanceReach({ x0: 0.9, x1: 1, y0: 0.2, y1: 0.8 }, 4 / 3, 16 / 9);
    expect(edge.x1).toBeLessThanOrEqual(1);
    expect(edge.x0).toBeGreaterThanOrEqual(0);
  });

  it('the same hand move sideways or up moves the cursor the same distance', () => {
    const e = new GestureEngine({ reach: { x0: 0.4, x1: 0.6, y0: 0.2, y1: 0.6 } });
    const at = (x: number, y: number, t0: number) => run(e, repeat(hand('point', 'up', { x, y }), 12), { t0 });
    const a = at(0.5, 0.75, 0);
    const side = at(0.45, 0.75, a.t);
    const up = at(0.5, 0.7, side.t);
    const dx = Math.abs(side.last.pointer!.x - a.last.pointer!.x);
    const dy = Math.abs(up.last.pointer!.y - side.last.pointer!.y);
    expect(dx / dy).toBeGreaterThan(0.9);
    expect(dx / dy).toBeLessThan(1.1);
  });
});

describe('tracking', () => {
  it('reports lost, then searching, when the hand leaves', () => {
    const e = new GestureEngine();
    const { t } = run(e, repeat(hand('fist'), 3));
    expect(e.update({ hands: [], aspect: 1, t: t + 100, width: W, height: H }).tracking).toBe('lost');
    expect(e.update({ hands: [], aspect: 1, t: t + GESTURE.lostAfterMs + 100, width: W, height: H }).tracking).toBe('searching');
  });
});
