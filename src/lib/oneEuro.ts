/**
 * One Euro Filter (Casiez et al., 2012).
 * Low jitter when the hand is still, low lag when it moves fast.
 */
export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private lastT = 0;
  minCutoff: number;
  beta: number;
  dCutoff: number;

  constructor(minCutoff: number, beta: number, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }

  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param t timestamp in ms */
  filter(value: number, t: number): number {
    if (this.x === null) {
      this.x = value;
      this.lastT = t;
      return value;
    }
    const dt = Math.min(Math.max((t - this.lastT) / 1000, 1 / 240), 0.1);
    this.lastT = t;
    const d = (value - this.x) / dt;
    this.dx += OneEuroFilter.alpha(this.dCutoff, dt) * (d - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuroFilter.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

export type SmoothingPreset = 'responsive' | 'balanced' | 'stable';

/**
 * Filter parameters work in screen pixels. `deadZone` is a soft dead zone relative to the
 * screen diagonal (the pointer trails by at most that distance, it never snaps in steps).
 * `leadMs` is how far ahead the overlay extrapolates the pointer to hide camera latency.
 */
export const SMOOTHING: Record<SmoothingPreset, { label: string; minCutoff: number; beta: number; deadZone: number; leadMs: number }> = {
  responsive: { label: 'Responsive', minCutoff: 6, beta: 0.12, deadZone: 0, leadMs: 24 },
  balanced: { label: 'Balanced', minCutoff: 3.5, beta: 0.06, deadZone: 0.0004, leadMs: 16 },
  stable: { label: 'Steady', minCutoff: 1.8, beta: 0.025, deadZone: 0.0012, leadMs: 8 },
};

export interface SmoothedPoint {
  x: number;
  y: number;
  /** px per second, from recent filtered motion (reacts within a couple of frames). */
  vx: number;
  vy: number;
}

/** 2D pointer smoother: One Euro per axis, soft dead zone, and a fast velocity estimate. */
export class PointSmoother {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;
  private out: { x: number; y: number; t: number } | null = null;
  private vx = 0;
  private vy = 0;
  private deadZone: number;

  constructor(preset: SmoothingPreset) {
    const p = SMOOTHING[preset];
    // A faster derivative (3 Hz instead of 1 Hz) lets the filter open up as soon as the hand starts moving.
    this.fx = new OneEuroFilter(p.minCutoff, p.beta, 3);
    this.fy = new OneEuroFilter(p.minCutoff, p.beta, 3);
    this.deadZone = p.deadZone;
  }

  setPreset(preset: SmoothingPreset) {
    const p = SMOOTHING[preset];
    this.fx.minCutoff = this.fy.minCutoff = p.minCutoff;
    this.fx.beta = this.fy.beta = p.beta;
    this.deadZone = p.deadZone;
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.out = null;
    this.vx = this.vy = 0;
  }

  /** x, y and diagonal in screen px; t in ms. */
  filter(x: number, y: number, t: number, diagonal: number): SmoothedPoint {
    const sx = this.fx.filter(x, t);
    const sy = this.fy.filter(y, t);
    let ox = sx;
    let oy = sy;
    const prev = this.out;
    if (prev) {
      const r = this.deadZone * diagonal;
      const dx = sx - prev.x;
      const dy = sy - prev.y;
      const d = Math.hypot(dx, dy);
      if (d <= r) {
        ox = prev.x;
        oy = prev.y;
      } else if (r > 0) {
        const k = (d - r) / d;
        ox = prev.x + dx * k;
        oy = prev.y + dy * k;
      }
      const dt = Math.max((t - prev.t) / 1000, 1 / 240);
      this.vx += 0.6 * ((ox - prev.x) / dt - this.vx);
      this.vy += 0.6 * ((oy - prev.y) / dt - this.vy);
    }
    this.out = { x: ox, y: oy, t };
    return { x: ox, y: oy, vx: this.vx, vy: this.vy };
  }
}
