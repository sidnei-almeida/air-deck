import { beforeAll, describe, expect, it } from 'vitest';
import { InkLayer } from './ink';

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  g.requestAnimationFrame ??= () => 0;
  g.cancelAnimationFrame ??= () => {};
  g.window ??= { devicePixelRatio: 1 };
});

/** A canvas whose 2D context accepts every call and property without drawing. */
function layer() {
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  const canvas = { clientWidth: 800, clientHeight: 450, width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const ink = new InkLayer(canvas);
  ink.setPage('p1');
  return ink;
}

const stroke = (ink: InkLayer, x: number) => {
  ink.beginStroke({ x, y: 0.2 });
  ink.extendStroke({ x: x + 0.05, y: 0.2 });
  ink.endStroke();
};

describe('ink history', () => {
  it('undoes and redoes strokes one at a time', () => {
    const ink = layer();
    stroke(ink, 0.1);
    stroke(ink, 0.5);
    expect(ink.undo()).toBe(true);
    expect(ink.erase({ x: 0.52, y: 0.2 }, 0.01)).toBe(false);
    expect(ink.undo()).toBe(true);
    expect(ink.hasInk()).toBe(false);
    expect(ink.undo()).toBe(false);
    expect(ink.redo()).toBe(true);
    expect(ink.hasInk()).toBe(true);
    expect(ink.canRedo()).toBe(true);
  });

  it('a new change drops what could be redone', () => {
    const ink = layer();
    stroke(ink, 0.1);
    ink.undo();
    stroke(ink, 0.3);
    expect(ink.canRedo()).toBe(false);
  });

  it('one pass of the eraser is one step', () => {
    const ink = layer();
    stroke(ink, 0.1);
    stroke(ink, 0.5);
    ink.erase({ x: 0.12, y: 0.2 }, 0.01);
    ink.erase({ x: 0.52, y: 0.2 }, 0.01);
    expect(ink.hasInk()).toBe(false);
    ink.undo();
    expect(ink.erase({ x: 0.12, y: 0.2 }, 0.01)).toBe(true);
    expect(ink.erase({ x: 0.52, y: 0.2 }, 0.01)).toBe(true);
  });

  it('brings a cleared slide back, and keeps history per slide', () => {
    const ink = layer();
    stroke(ink, 0.1);
    ink.clearPage();
    ink.setPage('p2');
    expect(ink.canUndo()).toBe(false);
    ink.setPage('p1');
    expect(ink.undo()).toBe(true);
    expect(ink.hasInk()).toBe(true);
  });
});
