/**
 * Clean annotations from shaky hands. Each pinch finger names its shape, so nothing here
 * has to guess *which* shape was meant, only *where*: a corner-to-corner drag, a pull from
 * the center, or a rough loop around a word all become a tidy rectangle or ellipse.
 */
export type Shape =
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotation: number; startAngle: number; clockwise: boolean }
  | { kind: 'rect'; cx: number; cy: number; w: number; h: number; rotation: number; startCorner: number; clockwise: boolean }
  | { kind: 'underline'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number };

export type ShapeKind = Shape['kind'];
/** Shapes drawn with a dedicated pinch finger. */
export type DrawnKind = 'rect' | 'ellipse' | 'arrow';

export interface Point {
  x: number;
  y: number;
}

const DEG = Math.PI / 180;
/** Round enough to become a true circle. Words are wide, so only near-circles snap. */
const CIRCLE_RATIO = 0.9;

type Segment = Extract<Shape, { x1: number }>;
const isSegment = (shape: Shape): shape is Segment => shape.kind === 'underline' || shape.kind === 'arrow';

function pathLength(pts: Point[]) {
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return length;
}

/**
 * A pen stroke that is basically straight becomes a clean line, level when nearly horizontal.
 * Tolerates tremor along the way and a small hook where the pinch lets go.
 */
export function straightenStroke(pts: Point[], minLength: number): Shape | null {
  if (pts.length < 6) return null;
  const n = pts.length;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x / n;
    my += p.y / n;
  }
  // Principal direction of the points.
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const angle = Math.atan2(2 * sxy, sxx - syy) / 2;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);

  const along = pts.map(p => (p.x - mx) * ux + (p.y - my) * uy);
  const across = pts.map(p => -(p.x - mx) * uy + (p.y - my) * ux);
  const sorted = [...along].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.02 * (n - 1))];
  const hi = sorted[Math.ceil(0.98 * (n - 1))];
  const length = hi - lo;
  if (length < minLength) return null;

  const deviations = across.map(Math.abs).sort((a, b) => a - b);
  const typical = deviations[Math.floor(0.9 * (n - 1))];
  if (typical > 0.07 * length) return null;
  // Going back and forth (a scribble, a zigzag) is not a line.
  if (pathLength(pts) > 1.35 * (Math.max(...along) - Math.min(...along)) + 0.02 * length) return null;

  // Keep the drawing direction: the line starts where the stroke started.
  const forward = along[n - 1] >= along[0];
  const [a, b] = forward ? [lo, hi] : [hi, lo];
  let x1 = mx + a * ux;
  let y1 = my + a * uy;
  let x2 = mx + b * ux;
  let y2 = my + b * uy;
  const tilt = Math.abs(Math.atan2(y2 - y1, x2 - x1));
  if (tilt < 12 * DEG || tilt > 168 * DEG) {
    const y = (y1 + y2) / 2;
    y1 = y;
    y2 = y;
  }
  return { kind: 'underline', x1, y1, x2, y2 };
}

/** Area enclosed by the path (closed back to its start) over its bounding-box area. Near 0 for a drag, ~0.8 for a loop. */
function enclosure(pts: Point[], box: Box) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  const boxArea = (box.x1 - box.x0) * (box.y1 - box.y0);
  return boxArea > 0 ? Math.abs(area / 2) / boxArea : 0;
}

function bounds(pts: Point[], trim = 0): Box {
  const xs = pts.map(p => p.x).sort((a, b) => a - b);
  const ys = pts.map(p => p.y).sort((a, b) => a - b);
  const at = (v: number[], q: number) => v[Math.round(q * (v.length - 1))];
  return { x0: at(xs, trim), x1: at(xs, 1 - trim), y0: at(ys, trim), y1: at(ys, 1 - trim) };
}

/** Whether the points go around something rather than being dragged from A to B. */
export function isLoop(pts: Point[], minSize: number) {
  if (pts.length < 8) return false;
  const box = bounds(pts);
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  if (Math.min(w, h) < minSize * 0.5) return false;
  return enclosure(pts, box) > 0.5 && pathLength(pts) > 1.5 * Math.hypot(w, h);
}

/** Solves a small dense linear system in place (Gaussian elimination with pivoting). */
function solve(m: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < n; k++) m[r][k] -= f * m[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x;
}

interface AxisEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Least-squares axis-aligned ellipse. Reconstructs a loop the hand did not quite close. */
function fitEllipse(pts: Point[]): AxisEllipse | null {
  const n = pts.length;
  if (n < 6) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x / n;
    my += p.y / n;
  }
  let s = 0;
  for (const p of pts) s += ((p.x - mx) ** 2 + (p.y - my) ** 2) / n;
  s = Math.sqrt(s) || 1;
  // a·u² + c·v² + d·u + e·v = 1, in centered and scaled coordinates.
  const m = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  const b = [0, 0, 0, 0];
  for (const p of pts) {
    const u = (p.x - mx) / s;
    const v = (p.y - my) / s;
    const f = [u * u, v * v, u, v];
    for (let i = 0; i < 4; i++) {
      b[i] += f[i];
      for (let k = 0; k < 4; k++) m[i][k] += f[i] * f[k];
    }
  }
  const sol = solve(m, b);
  if (!sol) return null;
  const [a, c, d, e] = sol;
  if (a <= 0 || c <= 0) return null;
  const g = 1 + (d * d) / (4 * a) + (e * e) / (4 * c);
  if (g <= 0) return null;
  return { cx: mx - (d / (2 * a)) * s, cy: my - (e / (2 * c)) * s, rx: Math.sqrt(g / a) * s, ry: Math.sqrt(g / c) * s };
}

/** Fits, drops the points that disagree most (tails, overshoots, a second lap), fits again. */
function robustEllipse(pts: Point[]): AxisEllipse | null {
  const first = fitEllipse(pts);
  if (!first) return null;
  const residual = (p: Point) => Math.abs(Math.hypot((p.x - first.cx) / first.rx, (p.y - first.cy) / first.ry) - 1);
  const kept = [...pts].sort((p, q) => residual(p) - residual(q)).slice(0, Math.max(6, Math.floor(pts.length * 0.85)));
  return fitEllipse(kept) ?? first;
}

function ellipseShape(cx: number, cy: number, rx: number, ry: number, minSize: number): Shape {
  rx = Math.max(rx, minSize / 2);
  ry = Math.max(ry, minSize / 2);
  if (Math.min(rx, ry) / Math.max(rx, ry) >= CIRCLE_RATIO) rx = ry = (rx + ry) / 2;
  return { kind: 'ellipse', cx, cy, rx, ry, rotation: 0, startAngle: -Math.PI / 2, clockwise: true };
}

function rectShape(box: Box, minSize: number): Shape {
  const w = Math.max(box.x1 - box.x0, minSize * 0.6);
  const h = Math.max(box.y1 - box.y0, minSize * 0.6);
  return { kind: 'rect', cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, w, h, rotation: 0, startCorner: 0, clockwise: true };
}

/**
 * The shape a pinch finger drew, from the points of the gesture (start to release).
 * - Rectangle: drag from one corner to the other, or go around the thing.
 * - Ellipse: drag from one corner of its box to the other, or go around the thing.
 * - Arrow: from where the pinch started to where it let go.
 * Returns null while the gesture is too small to mean anything.
 */
export function shapeFromGesture(kind: DrawnKind, pts: Point[], minSize: number): Shape | null {
  if (pts.length < 2) return null;
  const start = pts[0];
  const end = pts[pts.length - 1];

  if (kind === 'arrow') {
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < minSize) return null;
    let { x, y } = end;
    // Nearly level or plumb arrows snap straight.
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const snapped = Math.round(angle / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(angle - snapped) < 6 * DEG) {
      x = start.x + Math.cos(snapped) * length;
      y = start.y + Math.sin(snapped) * length;
    }
    return { kind: 'arrow', x1: start.x, y1: start.y, x2: x, y2: y };
  }

  if (isLoop(pts, minSize)) {
    if (kind === 'rect') return rectShape(bounds(pts, 0.03), minSize);
    const box = bounds(pts, 0.03);
    const hw = (box.x1 - box.x0) / 2;
    const hh = (box.y1 - box.y0) / 2;
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const fit = robustEllipse(pts);
    // A fit that wanders far from the drawing (nearly straight arcs) is worse than the box.
    const sane = fit && Math.abs(fit.cx - cx) < hw * 0.5 && Math.abs(fit.cy - cy) < hh * 0.5 && fit.rx < hw * 1.6 && fit.ry < hh * 1.6 && fit.rx > hw * 0.6 && fit.ry > hh * 0.6;
    return sane ? ellipseShape(fit.cx, fit.cy, fit.rx, fit.ry, minSize) : ellipseShape(cx, cy, hw, hh, minSize);
  }

  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if (Math.max(dx, dy) < minSize) return null;
  const box = { x0: Math.min(start.x, end.x), y0: Math.min(start.y, end.y), x1: Math.max(start.x, end.x), y1: Math.max(start.y, end.y) };
  if (kind === 'rect') return rectShape(box, minSize);
  // Corner to corner, like the rectangle: the ellipse fills the box the drag spans.
  const rx = dx / 2;
  const ry = dy / 2;
  const major = Math.max(rx, ry);
  return ellipseShape((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, Math.max(rx, major * 0.22), Math.max(ry, major * 0.22), minSize);
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function shapeBox(shape: Shape): Box {
  const pts = shapeHandles(shape);
  return {
    x0: Math.min(...pts.map(p => p.x)),
    y0: Math.min(...pts.map(p => p.y)),
    x1: Math.max(...pts.map(p => p.x)),
    y1: Math.max(...pts.map(p => p.y)),
  };
}

/** What a pinch on a selected shape grabs. */
export type Handle = { kind: 'move' } | { kind: 'resize'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 } | { kind: 'end'; end: 1 | 2 };

/** Corner and edge handles for ellipses and rectangles (in the shape's own frame), end points for lines and arrows. */
export function shapeHandles(shape: Shape): { handle: Handle; x: number; y: number }[] {
  if (isSegment(shape)) {
    return [
      { handle: { kind: 'end', end: 1 }, x: shape.x1, y: shape.y1 },
      { handle: { kind: 'end', end: 2 }, x: shape.x2, y: shape.y2 },
    ];
  }
  const hw = shape.kind === 'ellipse' ? shape.rx : shape.w / 2;
  const hh = shape.kind === 'ellipse' ? shape.ry : shape.h / 2;
  const c = Math.cos(shape.rotation);
  const s = Math.sin(shape.rotation);
  const out: { handle: Handle; x: number; y: number }[] = [];
  for (const sx of [-1, 0, 1] as const) {
    for (const sy of [-1, 0, 1] as const) {
      if (!sx && !sy) continue;
      const u = sx * hw;
      const v = sy * hh;
      out.push({ handle: { kind: 'resize', sx, sy }, x: shape.cx + u * c - v * s, y: shape.cy + u * s + v * c });
    }
  }
  return out;
}

function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const k = len ? Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0), 1) : 0;
  return Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k));
}

/** Distance from a point to the drawn outline of a shape. */
export function outlineDistance(shape: Shape, x: number, y: number) {
  const p = { x, y };
  if (isSegment(shape)) return segmentDistance(p, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 });
  const outline = shapeOutline(shape, 72);
  let best = Infinity;
  for (let i = 0; i < outline.length; i++) best = Math.min(best, segmentDistance(p, outline[i], outline[(i + 1) % outline.length]));
  return best;
}

/**
 * The nearest handle within `radius`, or `move` when the point is on the outline. The inside
 * stays free, so a word that was just circled can still be written on.
 */
export function hitShape(shape: Shape, x: number, y: number, radius: number): Handle | null {
  let best: Handle | null = null;
  let bestDistance = radius;
  for (const h of shapeHandles(shape)) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d <= bestDistance) {
      best = h.handle;
      bestDistance = d;
    }
  }
  if (best) return best;
  return outlineDistance(shape, x, y) <= radius * 0.75 ? { kind: 'move' } : null;
}

export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  if (isSegment(shape)) return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
  return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
}

/** Drags a handle to a point. Resizing is symmetric around the center, so the shape stays where it was drawn. */
export function resizeShape(shape: Shape, handle: Handle, x: number, y: number, minSize: number): Shape {
  if (isSegment(shape)) {
    if (handle.kind !== 'end') return shape;
    return handle.end === 1 ? { ...shape, x1: x, y1: y } : { ...shape, x2: x, y2: y };
  }
  if (handle.kind !== 'resize') return shape;
  const c = Math.cos(shape.rotation);
  const s = Math.sin(shape.rotation);
  const u = (x - shape.cx) * c + (y - shape.cy) * s;
  const v = -(x - shape.cx) * s + (y - shape.cy) * c;
  const hw0 = shape.kind === 'ellipse' ? shape.rx : shape.w / 2;
  const hh0 = shape.kind === 'ellipse' ? shape.ry : shape.h / 2;
  const hw = handle.sx ? Math.max(Math.abs(u), minSize / 2) : hw0;
  const hh = handle.sy ? Math.max(Math.abs(v), minSize / 2) : hh0;
  return shape.kind === 'ellipse' ? { ...shape, rx: hw, ry: hh } : { ...shape, w: hw * 2, h: hh * 2 };
}

/** Whether a point lies inside a closed shape. Lines and arrows contain nothing. */
export function shapeContains(shape: Shape, x: number, y: number) {
  if (isSegment(shape)) return false;
  const dx = x - shape.cx;
  const dy = y - shape.cy;
  const c = Math.cos(shape.rotation);
  const s = Math.sin(shape.rotation);
  const u = dx * c + dy * s;
  const v = -dx * s + dy * c;
  if (shape.kind === 'ellipse') return (u / shape.rx) ** 2 + (v / shape.ry) ** 2 <= 1;
  return Math.abs(u) <= shape.w / 2 && Math.abs(v) <= shape.h / 2;
}

/** Points along the outline, for hit-testing with the eraser. */
export function shapeOutline(shape: Shape, steps = 48): Point[] {
  if (isSegment(shape)) {
    return Array.from({ length: steps }, (_, i) => {
      const k = i / (steps - 1);
      return { x: shape.x1 + (shape.x2 - shape.x1) * k, y: shape.y1 + (shape.y2 - shape.y1) * k };
    });
  }
  const c = Math.cos(shape.rotation);
  const s = Math.sin(shape.rotation);
  const out: Point[] = [];
  for (let i = 0; i < steps; i++) {
    let u: number;
    let v: number;
    if (shape.kind === 'ellipse') {
      const a = (i / steps) * Math.PI * 2;
      u = shape.rx * Math.cos(a);
      v = shape.ry * Math.sin(a);
    } else {
      const k = (i / steps) * 4;
      const side = Math.floor(k);
      const f = k - side;
      const hw = shape.w / 2;
      const hh = shape.h / 2;
      [u, v] = [
        [-hw + 2 * hw * f, -hh],
        [hw, -hh + 2 * hh * f],
        [hw - 2 * hw * f, hh],
        [-hw, hh - 2 * hh * f],
      ][side] as [number, number];
    }
    out.push({ x: shape.cx + u * c - v * s, y: shape.cy + u * s + v * c });
  }
  return out;
}

/** Arrowhead size for a given shaft length, in the same units. */
export function arrowHead(length: number, strokeWidth: number) {
  return Math.min(Math.max(length * 0.22, strokeWidth * 4), strokeWidth * 7);
}
