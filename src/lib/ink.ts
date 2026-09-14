import { arrowHead, outlineDistance, shapeBox, shapeHandles, type Box, type Handle, type Shape } from './shapes';

export interface Selection {
  id: number;
  hot: Handle | null;
}

/** A shape being drawn: the clean preview, and the raw path when the hand is going around something. */
export interface Draft {
  shape: Shape | null;
  trail: InkPoint[] | null;
  /** Where the shape was anchored, marked while the shape is still too small to show. */
  start?: InkPoint;
}

/** Slide units: x and y divided by the slide width, so ink follows zoom and resize. */
export interface InkPoint {
  x: number;
  y: number;
}

interface StrokeItem {
  kind: 'stroke';
  id: number;
  color: string;
  points: InkPoint[];
}
interface ShapeItem {
  kind: 'shape';
  id: number;
  color: string;
  shape: Shape;
  born: number;
}
type Item = StrokeItem | ShapeItem;

const PEN_WIDTH = 0.0034;
const SHAPE_WIDTH = 0.0032;
const DRAW_MS = 420;
const MIN_STEP = 0.0012;
const MAX_EDGE = 4096;
/** Undo steps kept per slide. */
const HISTORY_LIMIT = 60;
/** Erasing in one pass is a single step to undo. */
const ERASE_COALESCE_MS = 800;

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/**
 * Ink that belongs to the slide: pen strokes and clean shapes, kept per page.
 * Lives inside the zoom layer, so it scales with the slide.
 */
export class InkLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private density: number;
  private w = 0;
  private h = 0;
  private raf = 0;
  private pages = new Map<string, Item[]>();
  private key = '';
  private active: StrokeItem | null = null;
  private color = '#FFB23E';
  private nextId = 1;
  private selection: Selection | null = null;
  private draft: Draft | null = null;
  /** Per slide: how the page looked before each change, and changes undone that can be redone. */
  private history = new Map<string, { undo: Item[][]; redo: Item[][] }>();
  private lastCheckpoint = { reason: '', key: '', t: -Infinity };

  constructor(canvas: HTMLCanvasElement, density = 1.5) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.density = density;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }

  setPage(key: string) {
    if (key === this.key) return;
    this.active = null;
    this.selection = null;
    this.draft = null;
    this.key = key;
    this.invalidate();
  }

  setColor(color: string) {
    this.color = color;
  }

  hasInk() {
    return this.items.length > 0;
  }

  /**
   * Saves the page as it is, so the change about to happen can be undone. Strokes, shapes, handle
   * edits, erasing and clearing all call it; a stream of erasing counts once.
   */
  checkpoint(reason = 'edit') {
    const now = performance.now();
    const last = this.lastCheckpoint;
    const coalesce = reason === 'erase' && last.reason === 'erase' && last.key === this.key && now - last.t < ERASE_COALESCE_MS;
    this.lastCheckpoint = { reason, key: this.key, t: now };
    if (coalesce) return;
    const stacks = this.stacks;
    stacks.undo.push(this.snapshot());
    if (stacks.undo.length > HISTORY_LIMIT) stacks.undo.shift();
    stacks.redo = [];
  }

  canUndo() {
    return (this.history.get(this.key)?.undo.length ?? 0) > 0;
  }

  canRedo() {
    return (this.history.get(this.key)?.redo.length ?? 0) > 0;
  }

  undo(): boolean {
    const stacks = this.stacks;
    const previous = stacks.undo.pop();
    if (!previous) return false;
    stacks.redo.push(this.snapshot());
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    const stacks = this.stacks;
    const next = stacks.redo.pop();
    if (!next) return false;
    stacks.undo.push(this.snapshot());
    this.restore(next);
    return true;
  }

  private get stacks() {
    let stacks = this.history.get(this.key);
    if (!stacks) {
      stacks = { undo: [], redo: [] };
      this.history.set(this.key, stacks);
    }
    return stacks;
  }

  /** Items are copied; committed strokes never change their points, so those arrays can be shared. */
  private snapshot(): Item[] {
    return this.items.map(item => ({ ...item }));
  }

  private restore(items: Item[]) {
    this.pages.set(this.key, items);
    this.active = null;
    this.selection = null;
    this.lastCheckpoint = { reason: '', key: '', t: -Infinity };
    this.invalidate();
  }

  beginStroke(p: InkPoint) {
    this.checkpoint('stroke');
    this.active = { kind: 'stroke', id: this.nextId++, color: this.color, points: [p] };
    this.items.push(this.active);
    this.invalidate();
  }

  /** Returns the distance added, in slide units. */
  extendStroke(p: InkPoint): number {
    if (!this.active) {
      this.beginStroke(p);
      return 0;
    }
    const pts = this.active.points;
    const last = pts[pts.length - 1];
    const d = Math.hypot(p.x - last.x, p.y - last.y);
    if (d < MIN_STEP) return 0;
    pts.push(p);
    this.invalidate();
    return d;
  }

  endStroke() {
    this.active = null;
  }

  /** Irons out what tremor is left in the finished stroke. Ends stay where they were drawn. */
  smoothActive(passes = 2) {
    const pts = this.active?.points;
    if (!pts || pts.length < 4) return;
    for (let pass = 0; pass < passes; pass++) {
      const src = pts.map(p => ({ ...p }));
      for (let i = 1; i < pts.length - 1; i++) {
        pts[i] = { x: (src[i - 1].x + 2 * src[i].x + src[i + 1].x) / 4, y: (src[i - 1].y + 2 * src[i].y + src[i + 1].y) / 4 };
      }
    }
    this.invalidate();
  }

  /** Points of the stroke being drawn, if any. */
  activeStroke(): InkPoint[] | null {
    return this.active ? this.active.points : null;
  }

  /** Swaps the stroke being drawn for a clean shape in the same color. */
  replaceActiveWithShape(shape: Shape): number | null {
    const active = this.active;
    if (!active) return null;
    const list = this.items;
    const i = list.indexOf(active);
    if (i >= 0) list.splice(i, 1);
    this.active = null;
    const id = this.nextId++;
    list.push({ kind: 'shape', id, color: active.color, shape, born: performance.now() });
    this.invalidate();
    return id;
  }

  addStroke(points: InkPoint[], color = this.color) {
    this.items.push({ kind: 'stroke', id: this.nextId++, color, points });
    this.invalidate();
  }

  /** `animate` draws the outline in; shapes already previewed while drawing appear at once. */
  addShape(shape: Shape, animate = true): number {
    this.checkpoint('shape');
    const id = this.nextId++;
    this.items.push({ kind: 'shape', id, color: this.color, shape, born: animate ? performance.now() : 0 });
    this.invalidate();
    return id;
  }

  getShape(id: number): Shape | null {
    const item = this.items.find(i => i.kind === 'shape' && i.id === id);
    return item?.kind === 'shape' ? item.shape : null;
  }

  updateShape(id: number, shape: Shape) {
    const item = this.items.find(i => i.kind === 'shape' && i.id === id);
    if (item?.kind !== 'shape') return;
    item.shape = shape;
    item.born = 0;
    this.invalidate();
  }

  /** Shows handles around a shape. */
  setSelection(selection: Selection | null) {
    if (JSON.stringify(selection) === JSON.stringify(this.selection)) return;
    this.selection = selection;
    this.invalidate();
  }

  setDraft(draft: Draft | null) {
    if (!draft && !this.draft) return;
    this.draft = draft;
    this.invalidate();
  }

  itemBox(id: number): Box | null {
    const item = this.items.find(i => i.id === id);
    if (!item) return null;
    if (item.kind === 'shape') return shapeBox(item.shape);
    const xs = item.points.map(p => p.x);
    const ys = item.points.map(p => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  /** Removes every stroke or shape the eraser touches, whole: wiping a slide takes a pass, not a scrub. */
  erase(p: InkPoint, radius: number): boolean {
    const list = this.items;
    const next = list.filter(item => {
      if (item.kind === 'shape') return outlineDistance(item.shape, p.x, p.y) >= radius;
      const pts = item.points;
      if (pts.length === 1) return Math.hypot(pts[0].x - p.x, pts[0].y - p.y) >= radius;
      for (let i = 1; i < pts.length; i++) if (segmentDistance(p, pts[i - 1], pts[i]) < radius) return false;
      return true;
    });
    if (next.length === list.length) return false;
    this.checkpoint('erase');
    if (this.active && !next.includes(this.active)) this.active = null;
    if (this.selection && !next.some(i => i.id === this.selection!.id)) this.selection = null;
    this.pages.set(this.key, next);
    this.invalidate();
    return true;
  }

  /** Clears this slide. Returns false when there was nothing to clear. */
  clearPage(): boolean {
    if (!this.items.length) return false;
    this.checkpoint('clear');
    this.pages.set(this.key, []);
    this.active = null;
    this.selection = null;
    this.invalidate();
    return true;
  }

  private get items(): Item[] {
    let list = this.pages.get(this.key);
    if (!list) {
      list = [];
      this.pages.set(this.key, list);
    }
    return list;
  }

  private resize() {
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.density;
    const scale = Math.min(dpr, MAX_EDGE / Math.max(this.w, this.h, 1));
    this.canvas.width = Math.max(1, Math.round(this.w * scale));
    this.canvas.height = Math.max(1, Math.round(this.h * scale));
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
    this.invalidate();
  }

  private invalidate() {
    if (!this.raf) this.raf = requestAnimationFrame(this.render);
  }

  private render = (now: number) => {
    this.raf = 0;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let animating = false;
    for (const item of this.items) {
      if (item.kind === 'stroke') this.drawStroke(item.points, item.color, PEN_WIDTH);
      else {
        const p = Math.min((now - item.born) / DRAW_MS, 1);
        if (p < 1) animating = true;
        this.drawShape(item.shape, item.color, easeInOut(Math.max(p, 0)));
      }
    }
    this.drawDraft();
    this.drawSelection();
    if (animating) this.raf = requestAnimationFrame(this.render);
  };

  private drawDraft() {
    const draft = this.draft;
    if (!draft) return;
    const { ctx } = this;
    ctx.save();
    if (draft.trail && draft.trail.length > 1) {
      ctx.globalAlpha = 0.3;
      this.drawStroke(draft.trail, this.color, PEN_WIDTH * 0.6);
    }
    if (draft.shape) {
      ctx.globalAlpha = 0.9;
      this.drawShape(draft.shape, this.color, 1);
    } else if (draft.start) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = this.color;
      ctx.beginPath();
      ctx.arc(draft.start.x * this.w, draft.start.y * this.w, SHAPE_WIDTH * this.w * 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawSelection() {
    const sel = this.selection;
    const shape = sel && this.getShape(sel.id);
    if (!sel || !shape) return;
    const { ctx, w } = this;
    ctx.save();
    ctx.setLineDash([0.006 * w, 0.005 * w]);
    ctx.lineWidth = 0.0012 * w;
    ctx.strokeStyle = 'rgba(20,22,28,.45)';
    if (shape.kind === 'underline' || shape.kind === 'arrow') {
      const box = shapeBox(shape);
      const pad = 0.012;
      ctx.strokeRect((box.x0 - pad) * w, (box.y0 - pad) * w, (box.x1 - box.x0 + pad * 2) * w, (box.y1 - box.y0 + pad * 2) * w);
    } else {
      const hw = (shape.kind === 'ellipse' ? shape.rx : shape.w / 2) * w;
      const hh = (shape.kind === 'ellipse' ? shape.ry : shape.h / 2) * w;
      ctx.translate(shape.cx * w, shape.cy * w);
      ctx.rotate(shape.rotation);
      ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    }
    ctx.restore();
    ctx.save();
    const size = 0.014 * w;
    for (const h of shapeHandles(shape)) {
      const hot = JSON.stringify(h.handle) === JSON.stringify(sel.hot);
      const x = h.x * w;
      const y = h.y * w;
      ctx.beginPath();
      ctx.roundRect(x - size / 2, y - size / 2, size, size, size * 0.25);
      ctx.fillStyle = hot ? '#FFB23E' : '#FFFFFF';
      ctx.fill();
      ctx.lineWidth = 0.0014 * w;
      ctx.strokeStyle = hot ? '#14161C' : '#FFB23E';
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Catmull-Rom through the samples: smooth curves from 30–60 Hz input. */
  private drawStroke(points: InkPoint[], color: string, width: number) {
    const { ctx, w } = this;
    const pts = points.map(p => ({ x: p.x * w, y: p.y * w }));
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width * w;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
    }
    ctx.stroke();
  }

  private drawShape(s: Shape, color: string, progress: number) {
    if (progress <= 0) return;
    const { ctx, w } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = SHAPE_WIDTH * w;
    ctx.beginPath();

    if (s.kind === 'underline' || s.kind === 'arrow') {
      if (s.kind === 'underline') ctx.lineWidth *= 1.15;
      const x2 = s.x1 + (s.x2 - s.x1) * progress;
      const y2 = s.y1 + (s.y2 - s.y1) * progress;
      ctx.moveTo(s.x1 * w, s.y1 * w);
      ctx.lineTo(x2 * w, y2 * w);
      if (s.kind === 'arrow') {
        const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) * w;
        const head = arrowHead(length, ctx.lineWidth) * Math.min(progress * 1.25, 1);
        const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        for (const side of [-1, 1]) {
          ctx.moveTo(x2 * w, y2 * w);
          ctx.lineTo(x2 * w - head * Math.cos(angle + side * 0.5), y2 * w - head * Math.sin(angle + side * 0.5));
        }
      }
    } else if (s.kind === 'ellipse') {
      const sweep = progress * (Math.PI * 2 + 0.16);
      const end = s.clockwise ? s.startAngle + sweep : s.startAngle - sweep;
      ctx.ellipse(s.cx * w, s.cy * w, s.rx * w, s.ry * w, s.rotation, s.startAngle, end, !s.clockwise);
    } else {
      const c = Math.cos(s.rotation);
      const sn = Math.sin(s.rotation);
      const hw = (s.w / 2) * w;
      const hh = (s.h / 2) * w;
      const local = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ];
      const order = [0, 1, 2, 3].map(i => (s.clockwise ? (s.startCorner + i) % 4 : (s.startCorner - i + 4) % 4));
      const corners = [...order, order[0]].map(i => ({ x: s.cx * w + local[i][0] * c - local[i][1] * sn, y: s.cy * w + local[i][0] * sn + local[i][1] * c }));
      const perimeter = 4 * (hw + hh);
      let remaining = perimeter * progress;
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < corners.length && remaining > 0; i++) {
        const a = corners[i - 1];
        const b = corners[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const k = Math.min(remaining / len, 1);
        ctx.lineTo(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
        remaining -= len;
      }
      if (progress >= 1) ctx.closePath();
    }
    ctx.stroke();
  }
}

function segmentDistance(p: InkPoint, a: InkPoint, b: InkPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const k = len ? Math.min(Math.max(((p.x - a.x) * dx + (p.y - a.y) * dy) / len, 0), 1) : 0;
  return Math.hypot(p.x - (a.x + dx * k), p.y - (a.y + dy * k));
}
