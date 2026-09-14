import type { DrawTool, GestureEngine, FrameOutput } from './gestures';
import type { InkLayer, InkPoint } from './ink';
import type { OverlayRenderer } from './overlay';
import { hitShape, isLoop, moveShape, resizeShape, shapeFromGesture, straightenStroke, type Handle, type Shape } from './shapes';
import type { HandFrame } from './tracker';
import { debugLog } from './debug';

/** How screen coordinates relate to the slide, including the current zoom. */
export interface SlideSpace {
  /** Size of the box the pointer maps into (the overlay canvas), px. */
  screen(): { width: number; height: number };
  /** Screen px to slide units (fractions of slide width), undoing zoom. */
  toSlide(x: number, y: number): InkPoint;
  /** Screen px per slide unit at the current zoom. */
  pxPerUnit(): number;
}

export interface ControllerActions {
  next?(): void;
  prev?(): void;
  zoom?(level: number, originX: number, originY: number, follow: boolean): void;
  resetZoom?(): void;
  menuOpen?(): void;
  menuClose?(): void;
  /** Where the hand points while the menu is open, in overlay px. */
  menuPointer?(x: number, y: number, t: number): void;
  menuClick?(): void;
  /** Thumb down held: clear the ink on this slide. */
  clear?(): void;
  /** Three or four fingers held: the ink was already undone or redone (`done` false when there was nothing). */
  history?(kind: 'undo' | 'redo', done: boolean): void;
  /** Thumbs up held while something is open: OK. */
  confirm?(): void;
}

export interface ControllerResult {
  out: FrameOutput;
  erased: boolean;
  /** Pen distance added this frame, in slide units. */
  penDistance: number;
  /** Shapes made or adjusted this frame, in slide units. */
  shapes: Shape[];
}

/**
 * Tremor filters for drawing. `radius` (fraction of the smaller screen side) is shake that never
 * moves the nib; `glideMs` smooths deliberate motion; `settleMs` slowly closes the gap when the hand rests.
 */
const PEN_STEADY = { radius: 0.011, glideMs: 40, settleMs: 260 };
/** Shapes magnify tremor (an ellipse radius is √2 × the pull), so their filter is heavier. */
const SHAPE_STEADY = { radius: 0.022, glideMs: 70, settleMs: 420 };
/** The start of a shape is the average of its first moments. */
const START_AVERAGE_MS = 100;
/** A shape pinch first aims: holding still this long places the start, then the shape follows the hand. */
const AIM_HOLD_MS = 350;
/** Wandering farther than this (fraction of the smaller screen side) restarts the aim. */
const AIM_RADIUS = 0.018;
/** Shortest straight pen stroke that becomes a clean line, in slide units. Handwriting stays ink. */
const MIN_LINE = 0.06;
/** Smallest shape a pinch finger draws, in slide units. Small enough to box a single letter. */
const MIN_SHAPE = 0.015;
/** A drawn shape stays adjustable this long after the last touch. */
const SELECT_MS = 5000;
/** Reach of a handle, in slide units. */
const HANDLE_RADIUS = 0.03;
/** Opening the fingers drags the pinch point; this much of the end of a shape gesture is dropped. */
const RELEASE_TRIM_MS = 180;

type ShapeTool = Exclude<DrawTool, 'pen'>;

const HOLD_LABEL = { menu: 'Menu', clear: 'Clear', undo: 'Undo', redo: 'Redo', confirm: 'OK' } as const;

/**
 * Lazy brush plus glide. Shakes inside the radius are ignored, moving past it drags the point
 * along, and a short exponential glide removes the steps left by 30 fps input. When the hand
 * rests, the point creeps onto the finger so it never stays a radius short of it.
 */
export class SteadyPoint {
  private anchor = { x: 0, y: 0 };
  private out = { x: 0, y: 0 };
  private t = 0;

  reset(x: number, y: number, t: number) {
    this.anchor = { x, y };
    this.out = { x, y };
    this.t = t;
    return { x, y };
  }

  update(x: number, y: number, t: number, radius: number, { glideMs, settleMs }: { glideMs: number; settleMs: number }) {
    const dt = Math.min(Math.max(t - this.t, 0), 100);
    this.t = t;
    const a = this.anchor;
    const d = Math.hypot(x - a.x, y - a.y);
    if (d > radius) {
      a.x += ((x - a.x) * (d - radius)) / d;
      a.y += ((y - a.y) * (d - radius)) / d;
    } else {
      const k = 1 - Math.exp(-dt / settleMs);
      a.x += (x - a.x) * k;
      a.y += (y - a.y) * k;
    }
    const g = 1 - Math.exp(-dt / glideMs);
    this.out.x += (a.x - this.out.x) * g;
    this.out.y += (a.y - this.out.y) * g;
    return { ...this.out };
  }
}

/** Hold still to place the start of a shape. Progress 0–1, restarting whenever the point wanders off. */
export class AimDwell {
  private anchor: { x: number; y: number } | null = null;
  private since = 0;

  update(x: number, y: number, t: number, radius: number, holdMs = AIM_HOLD_MS) {
    if (!this.anchor || Math.hypot(x - this.anchor.x, y - this.anchor.y) > radius) {
      this.anchor = { x, y };
      this.since = t;
    }
    return Math.min((t - this.since) / holdMs, 1);
  }
}

/** Gesture points with the start replaced by the average of its first moments. */
function gesturePoints(samples: { p: InkPoint; t: number }[]): InkPoint[] {
  const pts = samples.map(s => s.p);
  const early = samples.filter(s => s.t - samples[0].t <= START_AVERAGE_MS);
  pts[0] = { x: early.reduce((sum, s) => sum + s.p.x, 0) / early.length, y: early.reduce((sum, s) => sum + s.p.y, 0) / early.length };
  return pts;
}

/** Wires engine output to the cursor layer, the ink and the host's actions. Shared by presenter and trainer. */
export class GestureController {
  inkColor = '#FFB23E';
  /** When true, frames without a cursor leave the overlay alone (mouse laser owns it). */
  keepIdleCursor = false;
  private penWasDown = false;
  private steady = new SteadyPoint();
  private snapped = false;
  /** A rectangle, ellipse or arrow: aiming its start (`aim` set), then every point since the start was placed. */
  private draft: { tool: ShapeTool; aim: AimDwell | null; samples: { p: InkPoint; t: number }[] } | null = null;
  private selection: { id: number; grab: { handle: Handle; from: InkPoint; start: Shape } | null; seen: number } | null = null;
  private engine: GestureEngine;
  private overlay: OverlayRenderer;
  private ink: InkLayer;
  private space: SlideSpace;
  private actions: ControllerActions;

  constructor(engine: GestureEngine, overlay: OverlayRenderer, ink: InkLayer, space: SlideSpace, actions: ControllerActions) {
    this.engine = engine;
    this.overlay = overlay;
    this.ink = ink;
    this.space = space;
    this.actions = actions;
  }

  private select(id: number | null, t: number) {
    this.selection = id === null ? null : { id, grab: null, seen: t };
    this.ink.setSelection(id === null ? null : { id, hot: null });
  }

  handle(frame: HandFrame): ControllerResult {
    const { width, height } = this.space.screen();
    this.engine.setHistory(this.ink.canUndo(), this.ink.canRedo());
    const out = this.engine.update({ hands: frame.hands, handedness: frame.handedness, aspect: frame.aspect, t: frame.t, width, height });
    const { overlay, ink, space, actions } = this;
    let erased = false;
    let penDistance = 0;
    const shapes: Shape[] = [];
    const drawTool = out.penDown ? (out.tool as DrawTool) : null;

    /** Shape tools show the filtered point, and the aim progress until the start is placed. */
    let cursorAt: { x: number; y: number } | null = null;
    let aim: number | undefined;
    overlay.setNav(out.nav);
    overlay.setHold(out.hold ? { progress: out.hold.progress, label: HOLD_LABEL[out.hold.kind] } : null);
    overlay.setZoomMarker(out.zoom && !out.zoom.follow ? { x: out.zoom.originX, y: out.zoom.originY, level: out.zoom.level } : null);

    if (out.menuOpen && out.pointer) actions.menuPointer?.(out.pointer.x, out.pointer.y, frame.t);

    // A drawn shape stays selected for a moment: an index pinch on a handle resizes it, on the outline moves it.
    // Other fingers always draw, so boxing the next word never grabs the last box by accident.
    let grabbing = false;
    const sel = this.selection;
    if (sel) {
      const shape = ink.getShape(sel.id);
      const tip = out.pointer ? space.toSlide(out.pointer.x, out.pointer.y) : null;
      const leaving = out.menuOpen || out.events.some(e => e.type === 'next' || e.type === 'prev' || e.type === 'clear');
      if (!shape || leaving) {
        this.select(null, frame.t);
      } else if (sel.grab) {
        if (out.penDown && tip) {
          const g = sel.grab;
          const next = g.handle.kind === 'move' ? moveShape(g.start, tip.x - g.from.x, tip.y - g.from.y) : resizeShape(g.start, g.handle, tip.x, tip.y, MIN_SHAPE);
          ink.updateShape(sel.id, next);
          grabbing = true;
        } else {
          debugLog('shape-edited', { handle: sel.grab.handle.kind, kind: shape.kind });
          sel.grab = null;
          shapes.push(shape);
          ink.setSelection({ id: sel.id, hot: null });
        }
        sel.seen = frame.t;
      } else if (tip) {
        const hit = drawTool === null || drawTool === 'pen' ? hitShape(shape, tip.x, tip.y, HANDLE_RADIUS) : null;
        if (hit) sel.seen = frame.t;
        if (out.penDown && !this.penWasDown) {
          if (hit && drawTool === 'pen') {
            ink.checkpoint('edit');
            sel.grab = { handle: hit, from: tip, start: shape };
            grabbing = true;
          } else {
            this.select(null, frame.t);
          }
        }
        if (this.selection) ink.setSelection({ id: sel.id, hot: hit });
      }
      if (this.selection && !this.selection.grab && frame.t - this.selection.seen > SELECT_MS) this.select(null, frame.t);
    }

    if (grabbing) {
      // Adjusting a shape: no ink.
    } else if (drawTool === 'pen' && out.pointer) {
      // Pen through the tremor filter: shakes never reach the ink, deliberate strokes glide.
      const { x, y } = out.pointer;
      if (!this.penWasDown) {
        this.steady.reset(x, y, frame.t);
        this.snapped = false;
        ink.beginStroke(space.toSlide(x, y));
      } else if (!this.snapped) {
        const p = this.steady.update(x, y, frame.t, PEN_STEADY.radius * Math.min(width, height), PEN_STEADY);
        penDistance = ink.extendStroke(space.toSlide(p.x, p.y));
      }
    } else if (drawTool && drawTool !== 'pen' && out.pointer) {
      // Rectangle, ellipse or arrow. First aim: the cursor moves freely and holding still places the
      // start. Then the clean shape previews live while the pinch moves.
      const { x, y } = out.pointer;
      const side = Math.min(width, height);
      const filter = this.draft && !this.draft.aim ? SHAPE_STEADY : PEN_STEADY;
      const p = this.draft ? this.steady.update(x, y, frame.t, filter.radius * side, filter) : this.steady.reset(x, y, frame.t);
      const draft = (this.draft ??= { tool: drawTool, aim: new AimDwell(), samples: [] });
      cursorAt = p;
      if (draft.aim) {
        aim = draft.aim.update(p.x, p.y, frame.t, AIM_RADIUS * side);
        if (aim >= 1) {
          draft.aim = null;
          aim = undefined;
          debugLog('shape-aimed', { tool: draft.tool });
        }
      }
      if (!draft.aim) {
        draft.samples.push({ p: space.toSlide(p.x, p.y), t: frame.t });
        const pts = gesturePoints(draft.samples);
        const shape = shapeFromGesture(draft.tool, pts, MIN_SHAPE);
        ink.setDraft({ shape, trail: draft.tool !== 'arrow' && isLoop(pts, MIN_SHAPE) ? pts : null, start: pts[0] });
      }
    }

    if (!out.penDown && this.penWasDown) {
      const draft = this.draft;
      if (draft?.aim) {
        // Let go before the start was placed: nothing drawn.
        debugLog('shape-aim-cancelled', { tool: draft.tool });
        this.draft = null;
      } else if (draft) {
        const cut = frame.t - RELEASE_TRIM_MS;
        const kept = draft.samples.filter(s => s.t <= cut);
        const pts = gesturePoints(kept.length >= 2 ? kept : draft.samples);
        const shape = shapeFromGesture(draft.tool, pts, MIN_SHAPE);
        ink.setDraft(null);
        debugLog('shape-drawn', { tool: draft.tool, shape: shape?.kind ?? null, loop: isLoop(pts, MIN_SHAPE), points: pts.length });
        if (shape) {
          const id = ink.addShape(shape, false);
          shapes.push(shape);
          this.select(id, frame.t);
        }
        this.draft = null;
      } else {
        // Lifting the pen straightens a line; anything else stays as it was written.
        if (!this.snapped) {
          ink.smoothActive();
          const points = ink.activeStroke();
          const line = points && straightenStroke(points, MIN_LINE);
          debugLog('pen-up-shape', { points: points?.length ?? 0, shape: line?.kind ?? null });
          if (line) {
            ink.replaceActiveWithShape(line);
            shapes.push(line);
          }
        }
        ink.endStroke();
      }
    }
    this.penWasDown = out.penDown;

    if (out.eraser) overlay.pushCursor({ tool: 'eraser', ...out.eraser });
    else if (out.pointer) {
      const tool = drawTool ?? (out.tool === 'lens' ? 'lens' : 'laser');
      overlay.pushCursor({ tool, ...out.pointer, ...cursorAt, color: this.inkColor, progress: aim });
    } else if (!this.keepIdleCursor) overlay.pushCursor(null);

    if (out.eraser) erased = ink.erase(space.toSlide(out.eraser.x, out.eraser.y), out.eraser.radius / space.pxPerUnit());
    if (out.zoom) actions.zoom?.(out.zoom.level, out.zoom.originX, out.zoom.originY, out.zoom.follow);

    for (const ev of out.events) {
      switch (ev.type) {
        case 'next':
          overlay.flashNav('right');
          actions.next?.();
          break;
        case 'prev':
          overlay.flashNav('left');
          actions.prev?.();
          break;
        case 'zoom-reset':
          actions.resetZoom?.();
          break;
        case 'menu-open':
          actions.menuOpen?.();
          break;
        case 'menu-close':
          actions.menuClose?.();
          break;
        case 'menu-click':
          actions.menuClick?.();
          break;
        case 'clear':
          actions.clear?.();
          break;
        case 'confirm':
          debugLog('thumbs-up', { where: 'presenter' });
          actions.confirm?.();
          break;
        case 'undo':
        case 'redo': {
          const done = ev.type === 'undo' ? ink.undo() : ink.redo();
          if (done) this.select(null, frame.t);
          debugLog('history', { kind: ev.type, done });
          actions.history?.(ev.type, done);
          break;
        }
        case 'pen-hold': {
          if (this.snapped) break;
          const points = ink.activeStroke();
          const line = points && straightenStroke(points, MIN_LINE);
          debugLog('pen-hold', { points: points?.length ?? 0, shape: line?.kind ?? null });
          if (line) {
            ink.replaceActiveWithShape(line);
            shapes.push(line);
            this.snapped = true;
          }
          break;
        }
      }
    }
    return { out, erased, penDistance, shapes };
  }
}
