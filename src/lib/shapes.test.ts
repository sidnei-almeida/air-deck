import { describe, expect, it } from 'vitest';
import { hitShape, isLoop, moveShape, resizeShape, shapeBox, shapeContains, shapeFromGesture, straightenStroke, type Shape } from './shapes';

const MIN = 0.015;

/** A hand-drawn loop: wobbly radius, optional overshoot past the start. */
const loop = (cx: number, cy: number, rx: number, ry: number, { sweep = Math.PI * 2, n = 60, start = -2.6, noise = 0 } = {}) =>
  Array.from({ length: n }, (_, i) => {
    const a = start + (sweep * i) / (n - 1);
    const k = noise ? 1 + Math.sin(i * 1.7) * noise : 1;
    return { x: cx + rx * k * Math.cos(a), y: cy + ry * k * Math.sin(a) };
  });

const drag = (x1: number, y1: number, x2: number, y2: number, n = 20) =>
  Array.from({ length: n }, (_, i) => ({ x: x1 + ((x2 - x1) * i) / (n - 1) + Math.sin(i) * 0.001, y: y1 + ((y2 - y1) * i) / (n - 1) + Math.cos(i * 1.3) * 0.001 }));

describe('straightenStroke', () => {
  it('turns a shaky horizontal stroke into a level line', () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.3 + Math.sin(i * 1.9) * 0.004 }));
    const shape = straightenStroke(pts, 0.05);
    expect(shape?.kind).toBe('underline');
    if (shape?.kind !== 'underline') return;
    expect(shape.y1).toBe(shape.y2);
    expect(shape.x1).toBeLessThan(shape.x2);
  });

  it('ignores the little hook where the pinch lets go', () => {
    const pts = Array.from({ length: 40 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.5 }));
    pts.push({ x: 0.595, y: 0.49 }, { x: 0.59, y: 0.482 });
    const shape = straightenStroke(pts, 0.05);
    expect(shape?.kind).toBe('underline');
    if (shape?.kind === 'underline') expect(shape.x2).toBeGreaterThan(0.57);
  });

  it('keeps diagonal lines diagonal and in drawing order', () => {
    const shape = straightenStroke(drag(0.6, 0.6, 0.3, 0.3, 30), 0.05);
    expect(shape).toMatchObject({ kind: 'underline' });
    if (shape?.kind === 'underline') {
      expect(shape.x1).toBeGreaterThan(shape.x2);
      expect(shape.y1).toBeGreaterThan(shape.y2);
    }
  });

  it('leaves handwriting, loops and zigzags alone', () => {
    const wave = Array.from({ length: 40 }, (_, i) => ({ x: 0.2 + i * 0.006, y: 0.3 + Math.sin(i / 2) * 0.02 }));
    const zigzag = [...drag(0.2, 0.3, 0.5, 0.3), ...drag(0.5, 0.3, 0.2, 0.3), ...drag(0.2, 0.3, 0.5, 0.3)];
    expect(straightenStroke(wave, 0.05)).toBeNull();
    expect(straightenStroke(loop(0.5, 0.3, 0.1, 0.05), 0.05)).toBeNull();
    expect(straightenStroke(zigzag, 0.05)).toBeNull();
  });

  it('short strokes stay ink', () => {
    expect(straightenStroke(drag(0.2, 0.3, 0.23, 0.3), 0.05)).toBeNull();
  });
});

describe('rectangle finger', () => {
  it('drags from one corner to the other', () => {
    const shape = shapeFromGesture('rect', drag(0.62, 0.4, 0.3, 0.32), MIN);
    expect(shape?.kind).toBe('rect');
    if (shape?.kind !== 'rect') return;
    expect(shape.cx).toBeCloseTo(0.46, 2);
    expect(shape.cy).toBeCloseTo(0.36, 2);
    expect(shape.w).toBeCloseTo(0.32, 2);
    expect(shape.h).toBeCloseTo(0.08, 2);
  });

  it('a rough loop around a word becomes its box', () => {
    const shape = shapeFromGesture('rect', loop(0.5, 0.3, 0.12, 0.04, { noise: 0.08, sweep: Math.PI * 2.2 }), MIN);
    expect(shape?.kind).toBe('rect');
    if (shape?.kind !== 'rect') return;
    expect(shape.w / shape.h).toBeGreaterThan(2.3);
    expect(shapeContains(shape, 0.5, 0.3)).toBe(true);
  });

  it('a tiny pinch draws nothing', () => {
    expect(shapeFromGesture('rect', drag(0.5, 0.5, 0.505, 0.502), MIN)).toBeNull();
  });
});

describe('ellipse finger', () => {
  it('drags from one corner to the other, and the ellipse fills that box', () => {
    const shape = shapeFromGesture('ellipse', drag(0.62, 0.4, 0.3, 0.32), MIN);
    if (shape?.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(shape.cx).toBeCloseTo(0.46, 2);
    expect(shape.cy).toBeCloseTo(0.36, 2);
    expect(shape.rx).toBeCloseTo(0.16, 2);
    expect(shape.ry).toBeCloseTo(0.04, 2);
  });

  it('a drag along one axis still makes a usable ellipse', () => {
    const shape = shapeFromGesture('ellipse', drag(0.5, 0.3, 0.65, 0.3), MIN);
    if (shape?.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(shape.ry).toBeGreaterThan(shape.rx * 0.2);
  });

  it('circling a wide word keeps it wide, not a circle', () => {
    const shape = shapeFromGesture('ellipse', loop(0.5, 0.3, 0.14, 0.045, { noise: 0.1, sweep: Math.PI * 2.3 }), MIN);
    if (shape?.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(shape.rx / shape.ry).toBeGreaterThan(2.2);
    expect(Math.abs(shape.cx - 0.5)).toBeLessThan(0.02);
    expect(Math.abs(shape.cy - 0.3)).toBeLessThan(0.01);
  });

  it('completes a loop the hand did not close', () => {
    const shape = shapeFromGesture('ellipse', loop(0.5, 0.3, 0.1, 0.06, { sweep: Math.PI * 1.55, noise: 0.03 }), MIN);
    if (shape?.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(shape.rx).toBeCloseTo(0.1, 1);
    expect(shape.ry).toBeCloseTo(0.06, 1);
    expect(Math.abs(shape.cx - 0.5)).toBeLessThan(0.02);
  });

  it('a roundish loop snaps to a circle', () => {
    const shape = shapeFromGesture('ellipse', loop(0.5, 0.3, 0.08, 0.076, { noise: 0.04 }), MIN);
    if (shape?.kind !== 'ellipse') throw new Error('expected ellipse');
    expect(shape.rx).toBe(shape.ry);
  });

  it('tells loops from drags', () => {
    expect(isLoop(loop(0.5, 0.3, 0.1, 0.05), MIN)).toBe(true);
    expect(isLoop(drag(0.3, 0.3, 0.6, 0.5), MIN)).toBe(false);
    // Pulling out, in and out again while sizing is still a drag.
    expect(isLoop([...drag(0.5, 0.3, 0.6, 0.36), ...drag(0.6, 0.36, 0.55, 0.33), ...drag(0.55, 0.33, 0.62, 0.37)], MIN)).toBe(false);
  });
});

describe('arrow finger', () => {
  it('points from where the pinch started to where it let go', () => {
    const shape = shapeFromGesture('arrow', drag(0.2, 0.6, 0.45, 0.35), MIN);
    expect(shape).toMatchObject({ kind: 'arrow', x1: expect.closeTo(0.2, 2), y1: expect.closeTo(0.6, 2) });
    if (shape?.kind === 'arrow') expect(shape.x2).toBeCloseTo(0.45, 2);
  });

  it('snaps nearly level arrows', () => {
    const shape = shapeFromGesture('arrow', drag(0.2, 0.5, 0.5, 0.52), MIN);
    if (shape?.kind !== 'arrow') throw new Error('expected arrow');
    expect(shape.y2).toBeCloseTo(shape.y1, 5);
  });
});

describe('editing a shape', () => {
  const rect: Shape = { kind: 'rect', cx: 0.5, cy: 0.3, w: 0.2, h: 0.1, rotation: 0, startCorner: 0, clockwise: true };

  it('grabs the nearest handle, or the outline, but never the inside', () => {
    expect(hitShape(rect, 0.6, 0.35, 0.02)).toEqual({ kind: 'resize', sx: 1, sy: 1 });
    expect(hitShape(rect, 0.45, 0.251, 0.02)).toEqual({ kind: 'move' });
    expect(hitShape(rect, 0.5, 0.3, 0.02)).toBeNull();
    expect(hitShape(rect, 0.9, 0.9, 0.02)).toBeNull();
  });

  it('grabs arrow ends', () => {
    const arrow: Shape = { kind: 'arrow', x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.2 };
    expect(hitShape(arrow, 0.401, 0.2, 0.02)).toEqual({ kind: 'end', end: 2 });
    expect(resizeShape(arrow, { kind: 'end', end: 2 }, 0.5, 0.3, 0.01)).toMatchObject({ x2: 0.5, y2: 0.3 });
  });

  it('resizes around the center, one axis from an edge handle', () => {
    const wider = resizeShape(rect, { kind: 'resize', sx: 1, sy: 0 }, 0.65, 0.31, 0.01);
    expect(wider).toMatchObject({ cx: 0.5, cy: 0.3, h: 0.1 });
    if (wider.kind === 'rect') expect(wider.w).toBeCloseTo(0.3);
  });

  it('moves', () => {
    expect(moveShape(rect, 0.1, -0.05)).toMatchObject({ cx: 0.6, cy: 0.25 });
    expect(shapeBox(moveShape(rect, 0.1, 0)).x1).toBeCloseTo(0.7);
  });
});
