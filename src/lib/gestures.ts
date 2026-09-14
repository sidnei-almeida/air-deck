import { PointSmoother, type SmoothingPreset } from './oneEuro';
import { debugLog, debugStat } from './debug';

/** Minimal landmark shape, compatible with MediaPipe's NormalizedLandmark. */
export interface Landmark {
  x: number;
  y: number;
}

/** `pinch` is thumb and index; the other pinches name the finger touching the thumb. */
export type Pose = 'open' | 'four' | 'three' | 'two' | 'point' | 'pinch' | 'pinchMiddle' | 'pinchRing' | 'pinchPinky' | 'fist' | 'thumbsDown' | 'thumbsUp' | 'none';
/** What one raised finger does. Chosen in the menu. */
export type PointerTool = 'laser' | 'lens' | 'eraser';
/** What a pinch draws, by finger: index pen, middle rectangle, ring ellipse, pinky arrow. */
export type DrawTool = 'pen' | 'rect' | 'ellipse' | 'arrow';
/** What the hand is doing right now. */
export type Tool = PointerTool | DrawTool | 'zoom' | 'menu' | 'clear';
export type TrackingState = 'searching' | 'tracking' | 'lost';
export type GestureEvent =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'zoom-reset' }
  | { type: 'menu-open' }
  | { type: 'menu-close' }
  | { type: 'menu-click' }
  | { type: 'pen-hold' }
  | { type: 'clear' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'confirm' };

const PINCHES = ['pinch', 'pinchMiddle', 'pinchRing', 'pinchPinky'] as const;
export const PINCH_TOOL: Record<(typeof PINCHES)[number], DrawTool> = { pinch: 'pen', pinchMiddle: 'rect', pinchRing: 'ellipse', pinchPinky: 'arrow' };
export const isPinch = (pose: Pose): pose is (typeof PINCHES)[number] => (PINCHES as readonly Pose[]).includes(pose);

/** Region of the camera frame (mirrored, normalized) that maps to the whole screen. */
export interface ReachBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Kept away from the camera edges, where the tracker loses fingertips first. */
export const DEFAULT_REACH: ReachBox = { x0: 0.18, x1: 0.82, y0: 0.14, y1: 0.64 };

/**
 * Grows the shorter side of a reach box so the hand moves the cursor at the same speed sideways
 * and up and down. A tall, narrow box (practice log: 36% of the camera wide, 85% tall) made small
 * sideways moves fling the cursor to the edge. Never shrinks; stays inside the camera frame.
 * Coordinates are mirrored camera fractions; `camAspect` and `screenAspect` are width / height.
 */
export function balanceReach(box: ReachBox, camAspect: number, screenAspect: number): ReachBox {
  const want = screenAspect / camAspect;
  let w = box.x1 - box.x0;
  let h = box.y1 - box.y0;
  if (w < h * want) w = Math.min(h * want, 1);
  else h = Math.min(w / want, 1);
  const fit = (center: number, size: number): [number, number] => {
    const c = clamp(center, size / 2, 1 - size / 2);
    return [c - size / 2, c + size / 2];
  };
  const [x0, x1] = fit((box.x0 + box.x1) / 2, w);
  const [y0, y1] = fit((box.y0 + box.y1) / 2, h);
  return { x0, x1, y0, y1 };
}

/**
 * Tuning knobs. Informed by a real practice session (30 fps webcam, pose flicker between
 * two/three/open fingers); expect further tuning.
 */
export const GESTURE = {
  /** A new pose must hold this long before it takes over. */
  confirmMs: 60,
  /** Losing the pose (unclear frames) takes longer, so tools don't flicker off. */
  noneConfirmMs: 200,
  /** Lifting the pen takes a little longer than putting it down. */
  penReleaseMs: 160,
  /** Index and middle pointing sideways, held this long, turn the page: right advances, left goes back. */
  navHoldMs: 300,
  /** How far from level the two fingers may point. */
  navAngleDeg: 35,
  menuOpenHoldMs: 700,
  /** Palm lengths per second; slower counts as holding still. */
  menuStillSpeed: 1.2,
  menuIdleMs: 8000,
  twoOpenMs: 150,
  /** If the tracker drops the hand for less than this, the current tool keeps going. */
  gapHoldMs: 450,
  penGapHoldMs: 800,
  lostAfterMs: 2500,
  zoomMin: 1,
  zoomMax: 3,
  /** Raising the hand this many palm lengths doubles the zoom. */
  zoomPalmsPerDoubling: 1.2,
  zoomDeadBand: 0.08,
  /** Zoom targets the laser if it was used this recently. */
  laserMemoryMs: 4000,
  lensLevel: 2,
  /** The lens lets go only after the finger stops pointing for this long. */
  lensReleaseMs: 400,
  /** Holding the pen still this long at the end of a stroke asks for a shape. */
  penHoldMs: 600,
  /** Fraction of the smaller screen side per second. */
  penStillSpeed: 0.12,
  /** Thumb-to-fingertip gap that starts a pinch, in palm lengths. */
  pinchEnter: 0.28,
  /** The pinching fingertip must be this much closer to the thumb than the next one. */
  pinchMargin: 0.08,
  /** Thumb down held still this long clears the ink. */
  clearHoldMs: 900,
  /** Three fingers up held still undo; four (thumb folded) redo. Long, because finger counts flicker. */
  historyHoldMs: 800,
  /** How far from straight up those fingers may point. */
  historyAngleDeg: 35,
  /** Thumbs up held this long is the app-wide OK. */
  confirmHoldMs: 800,
  /** Brief tracking flickers don't restart the thumbs up. */
  confirmGraceMs: 150,
  /** Eraser radius relative to the smaller screen side. */
  eraserRadius: 0.06,
} as const;

const WRIST = 0;
const TIPS = [8, 12, 16, 20] as const;
const FINGERS = [
  { pip: 6, tip: 8 },
  { pip: 10, tip: 12 },
  { pip: 14, tip: 16 },
  { pip: 18, tip: 20 },
] as const;

type FingerState = 'extended' | 'curled' | 'unsure';

function distance(a: Landmark, b: Landmark, aspect: number) {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

export function palmLength(lm: Landmark[], aspect: number) {
  return distance(lm[WRIST], lm[9], aspect);
}

export function palmCenter(lm: Landmark[]): Landmark {
  const ids = [0, 5, 9, 13, 17];
  return { x: ids.reduce((s, i) => s + lm[i].x, 0) / ids.length, y: ids.reduce((s, i) => s + lm[i].y, 0) / ids.length };
}

/**
 * Classifies a single hand from finger extension ratios relative to the wrist, so it works
 * at any distance and any rotation. `previous` makes the current pose sticky on unclear frames.
 */
export function classifyPose(lm: Landmark[], aspect: number, previous: Pose = 'none'): Pose {
  if (lm.length < 21) return 'none';
  const palm = palmLength(lm, aspect);
  if (palm < 1e-4) return 'none';

  const ratios = fingerRatios(lm, aspect);
  const states: FingerState[] = ratios.map(r => (r > 1.15 ? 'extended' : r < 1.0 ? 'curled' : 'unsure'));
  const [index, middle, ring, pinky] = states;
  const extended = states.filter(s => s === 'extended').length;
  const curled = states.filter(s => s === 'curled').length;
  const up = (f: FingerState, sticky: boolean) => f === 'extended' || (sticky && f === 'unsure');
  const down = (f: FingerState, sticky: boolean) => f === 'curled' || (sticky && f === 'unsure');
  const thumbReach = distance(lm[4], lm[5], aspect) / palm;
  const thumbOut = thumbReach > (previous === 'open' ? 0.45 : previous === 'four' ? 0.6 : 0.52);

  const gaps = pinchGaps(lm, aspect);
  // While drawing the fingers curl; as long as the same fingertip stays on the thumb it is the same tool.
  const held = PINCHES.indexOf(previous as (typeof PINCHES)[number]);
  // Ring and pinky can't press the thumb as firmly (practice log: pinky gap drifted to 0.7 mid-arrow), so they hold looser.
  if (held >= 0 && gaps[held] < [0.45, 0.45, 0.55, 0.55][held]) return previous;
  const order = [0, 1, 2, 3].sort((a, b) => gaps[a] - gaps[b]);
  const nearest = order[0];
  if (gaps[nearest] < GESTURE.pinchEnter && gaps[order[1]] - gaps[nearest] > GESTURE.pinchMargin) {
    if (nearest === 0 && ratios[0] > 0.95) return 'pinch';
    // Pointing or in a fist, the thumb rests on curled fingertips. A real pinch keeps the other fingers out.
    // The pinching finger bends only part way to meet the thumb; folded all the way under it is
    // "three fingers up" with the thumb holding the pinky, not an arrow.
    if (nearest > 0 && ratios[0] > 1.05 && ratios[nearest] > 0.8 && states.every((s, i) => i === nearest || s !== 'curled')) return PINCHES[nearest];
  }

  if (extended === 4) return thumbOut ? 'open' : 'four';
  if (extended === 3 && curled === 0) {
    if (previous === 'open' || previous === 'four') return previous;
    if (!(previous === 'three' && pinky !== 'extended')) return thumbOut ? 'open' : 'four';
  }
  if (curled >= 3 && index !== 'extended' && isThumbVertical(lm, palm, aspect, 'down', previous === 'thumbsDown')) return 'thumbsDown';
  if (curled >= 3 && index !== 'extended' && isThumbVertical(lm, palm, aspect, 'up', previous === 'thumbsUp')) return 'thumbsUp';
  if (curled >= 3 && extended === 0) return 'fist';

  const p3 = previous === 'three';
  if (up(index, p3) && up(middle, p3) && up(ring, p3) && pinky !== 'extended' && (pinky === 'curled' || p3)) return 'three';

  const p2 = previous === 'two';
  if (up(index, p2) && up(middle, p2) && ring !== 'extended' && pinky !== 'extended' && (ring === 'curled' || pinky === 'curled' || p2)) {
    return 'two';
  }

  const p1 = previous === 'point';
  if (up(index, p1) && down(middle, p1) && ring !== 'extended' && pinky !== 'extended' && (ring === 'curled' || pinky === 'curled' || p1)) {
    return 'point';
  }
  return 'none';
}

/** Fingertip-to-wrist over knuckle-to-wrist for index … pinky: above ~1.15 extended, below 1 curled. */
function fingerRatios(lm: Landmark[], aspect: number) {
  return FINGERS.map(({ pip, tip }) => distance(lm[tip], lm[WRIST], aspect) / Math.max(distance(lm[pip], lm[WRIST], aspect), 1e-6));
}

/**
 * Three fingers up (undo) or four with the thumb folded (redo), read strictly. Finger counts flicker
 * on a webcam (first practice log: two and three fingers showed up for 30 s unintended), so every
 * finger must be clearly up or clearly folded, and the hand must point up.
 */
export function historyGesture(lm: Landmark[], aspect: number, pose: Pose): 'undo' | 'redo' | null {
  if (pose !== 'three' && pose !== 'four') return null;
  if (angleGap(fingerAngle(lm, aspect), -90) > GESTURE.historyAngleDeg) return null;
  const r = fingerRatios(lm, aspect);
  if (pose === 'three') return r[0] > 1.2 && r[1] > 1.2 && r[2] > 1.2 && r[3] < 1 ? 'undo' : null;
  const thumbFolded = distance(lm[4], lm[5], aspect) / palmLength(lm, aspect) < 0.45;
  return thumbFolded && r.every(v => v > 1.2) ? 'redo' : null;
}

/**
 * Thumbs up held: the app-wide OK, shared by the presenter and the trainer. Fires once per hold;
 * the thumb has to come down before it can fire again.
 */
export class ThumbsUpHold {
  private since: number | null = null;
  private lastUp = -Infinity;
  private fired = false;
  private progress = 0;

  update(up: boolean, t: number): { progress: number; fire: boolean } {
    if (up) {
      this.lastUp = t;
      this.since ??= t;
      const progress = Math.min((t - this.since) / GESTURE.confirmHoldMs, 1);
      const fire = progress >= 1 && !this.fired;
      if (fire) this.fired = true;
      this.progress = this.fired ? 0 : progress;
      return { progress: this.progress, fire };
    }
    if (t - this.lastUp > GESTURE.confirmGraceMs) {
      this.since = null;
      this.fired = false;
      this.progress = 0;
    }
    return { progress: this.progress, fire: false };
  }
}

/** Thumb tip to index, middle, ring and pinky tips, in palm lengths. */
export function pinchGaps(lm: Landmark[], aspect: number) {
  const palm = Math.max(palmLength(lm, aspect), 1e-6);
  return TIPS.map(tip => distance(lm[4], lm[tip], aspect) / palm);
}

/**
 * Thumb extended and pointing down (or up), clearly the lowest (or highest) point of the hand.
 * An upright fist (zoom) has the wrist lowest and the curled knuckles highest, so neither meets it.
 */
function isThumbVertical(lm: Landmark[], palm: number, aspect: number, way: 'up' | 'down', sticky: boolean) {
  const s = way === 'down' ? 1 : -1;
  const tip = lm[4];
  if (!((tip.y - lm[3].y) * s > 0 && (lm[3].y - lm[2].y) * s > 0)) return false;
  if (distance(tip, lm[2], aspect) / palm < 0.5) return false;
  let extreme = -Infinity;
  for (let i = 0; i < lm.length; i++) if (i !== 3 && i !== 4) extreme = Math.max(extreme, lm[i].y * s);
  return (tip.y * s - extreme) / palm > (sticky ? 0.08 : 0.2);
}

/** Angle where index and middle point on the mirrored screen, degrees (−90 is up). */
export function fingerAngle(lm: Landmark[], aspect: number) {
  const dx = -(lm[8].x - lm[5].x + (lm[12].x - lm[9].x)) * aspect;
  const dy = lm[8].y - lm[5].y + (lm[12].y - lm[9].y);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

export interface EngineOptions {
  smoothing?: SmoothingPreset;
  reach?: ReachBox;
  /** MediaPipe handedness label of the registered hand, preferred when two hands are visible. */
  handedness?: string | null;
  pointerTool?: PointerTool;
}

export interface FrameInput {
  hands: Landmark[][];
  handedness?: string[];
  /** Camera frame width / height. */
  aspect: number;
  /** ms, performance.now() clock */
  t: number;
  /** Screen box the pointer maps into, px. */
  width: number;
  height: number;
}

export interface Cursor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
}

export interface FrameOutput {
  tracking: TrackingState;
  pose: Pose;
  tool: Tool | null;
  /** Laser, lens or menu pointer, or pen tip while pinching. Screen px. */
  pointer: Cursor | null;
  penDown: boolean;
  eraser: (Cursor & { radius: number }) | null;
  /** `follow` means the origin tracks the finger (lens). */
  zoom: { level: number; originX: number; originY: number; follow: boolean } | null;
  /** Progress of a held gesture: open palm opens the menu, thumb down clears the ink. */
  hold: { progress: number; kind: 'menu' | 'clear' | 'undo' | 'redo' | 'confirm' } | null;
  /** Two fingers pointing sideways: progress toward turning the page, −1 (left) to 1 (right). */
  nav: { lean: number } | null;
  menuOpen: boolean;
  events: GestureEvent[];
}

export class GestureEngine {
  private candidate: Pose = 'none';
  private candidateSince = 0;
  private stable: Pose = 'none';
  private secondaryPose: Pose = 'none';

  private lastHandT = -Infinity;
  private primaryWrist: Landmark | null = null;
  private lastWrist: { x: number; y: number; t: number } | null = null;
  private speed = 0;

  private pointerTool: PointerTool;
  private laser: PointSmoother;
  private pen: PointSmoother;
  private lastPointT = -Infinity;
  private lastPenT = -Infinity;
  private lastLaser: { x: number; y: number; t: number } | null = null;
  private lensActive = false;
  private lensAwaySince: number | null = null;
  private penDownSince: number | null = null;
  private penStillSince: number | null = null;
  private penHoldFired = false;
  /** The drawing tool picked when the pinch started; a finger flicker mid-stroke never swaps it. */
  private drawTool: DrawTool | null = null;
  private clearSince: number | null = null;
  private clearLatch = false;
  private canUndo = false;
  private canRedo = false;
  private canConfirm = false;
  private confirm = new ThumbsUpHold();
  private historyKind: 'undo' | 'redo' | null = null;
  private historySince = 0;
  /** The last undo or redo fired; the fingers must come down before it repeats. */
  private historyLatch: 'undo' | 'redo' | null = null;

  private navDir: -1 | 1 | null = null;
  private navSince = 0;
  private navLatch = false;

  private menuOpen = false;
  private openLatch = false;
  private openSince: number | null = null;
  private menuActivity = 0;

  private zoomLevel = 1;
  private zoomClutch: { y: number; level: number } | null = null;
  private zoomOrigin = { x: 0, y: 0 };
  private twoOpenSince: number | null = null;
  private twoOpenLatched = false;

  private reach: ReachBox;
  /** The reach box balanced for this frame's camera and screen. */
  private mapped: ReachBox;
  private handedness: string | null;
  private last: FrameOutput | null = null;
  private holdingSince: number | null = null;

  constructor(options: EngineOptions = {}) {
    const preset = options.smoothing ?? 'balanced';
    this.laser = new PointSmoother(preset);
    this.pen = new PointSmoother(preset === 'responsive' ? 'balanced' : preset);
    this.reach = options.reach ?? DEFAULT_REACH;
    this.mapped = this.reach;
    this.handedness = options.handedness ?? null;
    this.pointerTool = options.pointerTool ?? 'laser';
  }

  setSmoothing(preset: SmoothingPreset) {
    this.laser.setPreset(preset);
    this.pen.setPreset(preset === 'responsive' ? 'balanced' : preset);
  }

  setReach(reach: ReachBox) {
    this.reach = reach;
  }

  setHandedness(label: string | null) {
    this.handedness = label;
  }

  setPointerTool(tool: PointerTool) {
    this.pointerTool = tool;
  }

  /** The thumbs-up OK only arms when the host has something to confirm (a menu or panel open). */
  setConfirmAvailable(available: boolean) {
    this.canConfirm = available;
  }

  /** Undo and redo holds only arm when there is something to undo or redo. */
  setHistory(canUndo: boolean, canRedo: boolean) {
    this.canUndo = canUndo;
    this.canRedo = canRedo;
  }

  /** Opens or closes the menu from outside (mouse, keyboard, a picked option). */
  setMenuOpen(open: boolean) {
    if (!open) return this.closeMenu();
    this.menuOpen = true;
    this.openLatch = true;
    this.menuActivity = performance.now();
  }

  /** Keeps the engine in sync when zoom changes by keyboard or slide change. */
  setZoom(level: number) {
    this.zoomLevel = level;
    this.zoomClutch = null;
  }

  update(input: FrameInput): FrameOutput {
    const { hands, aspect, t, width, height } = input;
    this.mapped = balanceReach(this.reach, aspect, width / Math.max(height, 1));
    const events: GestureEvent[] = [];
    if (hands.length === 0) return this.noHands(t, events);
    if (this.holdingSince !== null) {
      debugLog('gap-recovered', { ms: Math.round(t - this.holdingSince) });
      this.holdingSince = null;
    }
    this.lastHandT = t;

    const primaryIndex = this.pickPrimary(hands, input.handedness, aspect);
    const lm = hands[primaryIndex];
    const secondary = hands.length > 1 ? hands[primaryIndex === 0 ? 1 : 0] : null;
    const palm = palmLength(lm, aspect);
    this.trackSpeed(lm[WRIST], palm, aspect, t);

    const prevPose = this.stable;
    const raw = classifyPose(lm, aspect, this.stable);
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.candidateSince = t;
    }
    const need = this.candidate === 'none' ? GESTURE.noneConfirmMs : isPinch(this.stable) ? GESTURE.penReleaseMs : GESTURE.confirmMs;
    if (this.candidate !== this.stable && t - this.candidateSince >= need) this.stable = this.candidate;
    const pose = this.stable;
    this.secondaryPose = secondary ? classifyPose(secondary, aspect, this.secondaryPose) : 'none';
    if (pose !== 'open' && pose !== 'none') this.openLatch = false;
    if (pose !== 'thumbsDown' && pose !== 'none') this.clearLatch = false;

    if (isPinch(pose) || isPinch(raw)) {
      const gaps = pinchGaps(lm, aspect);
      const k = PINCHES.indexOf((isPinch(pose) ? pose : raw) as (typeof PINCHES)[number]);
      debugStat(`pinchGap.${PINCH_TOOL[PINCHES[k]]}`, gaps[k]);
      debugStat(`pinchMargin.${PINCH_TOOL[PINCHES[k]]}`, Math.min(...gaps.filter((_, i) => i !== k)) - gaps[k]);
    }
    if (pose === 'point' || isPinch(pose)) {
      debugStat('tipU', 1 - lm[8].x);
      debugStat('tipY', lm[8].y);
    }
    if (raw !== pose) debugStat('poseDisagree', 1);

    const nav = this.trackNav(lm, pose, aspect, t);
    const out: FrameOutput = {
      tracking: 'tracking',
      pose,
      tool: null,
      pointer: null,
      penDown: false,
      eraser: null,
      zoom: null,
      hold: null,
      nav: nav.lean ? { lean: nav.lean } : null,
      menuOpen: false,
      events,
    };
    // Thumbs up held: OK, whatever is open (also while the menu is).
    const ok = this.confirm.update(this.canConfirm && pose === 'thumbsUp', t);
    if (ok.fire) events.push({ type: 'confirm' });
    else if (ok.progress > 0.15) out.hold = { progress: ok.progress, kind: 'confirm' };

    const diagonal = Math.hypot(width, height);
    const scale = Math.min(width, height);

    // Menu: point at an option and hold, or pinch to pick it. Two fingers to the side close it.
    if (this.menuOpen) {
      out.tool = 'menu';
      if (nav.dir) {
        events.push({ type: 'menu-close' });
        this.closeMenu();
      } else {
        if (pose === 'point' || isPinch(pose)) {
          if (t - this.lastPointT > 300) this.laser.reset();
          const [rx, ry] = this.toScreen(pose === 'pinch' ? midpoint(lm[4], lm[8]) : lm[8], width, height);
          out.pointer = { ...this.laser.filter(rx, ry, t, diagonal), t };
          this.lastPointT = t;
          this.menuActivity = t;
          if (isPinch(pose) && !isPinch(prevPose)) events.push({ type: 'menu-click' });
        }
        if (t - this.menuActivity > GESTURE.menuIdleMs) {
          events.push({ type: 'menu-close' });
          this.closeMenu();
        }
      }
      if (this.lensActive) this.endLens(events);
      return this.finish(out);
    }

    // One finger: the pointer tool chosen in the menu.
    if (pose === 'point') {
      if (t - this.lastPointT > 300) this.laser.reset();
      const [rx, ry] = this.toScreen(lm[8], width, height);
      const s = this.laser.filter(rx, ry, t, diagonal);
      this.lastPointT = t;
      this.lensAwaySince = null;
      if (this.pointerTool === 'eraser') {
        out.eraser = { ...s, t, radius: GESTURE.eraserRadius * scale };
        out.tool = 'eraser';
      } else {
        out.pointer = { ...s, t };
        out.tool = this.pointerTool;
        if (this.pointerTool === 'laser') {
          this.lastLaser = { x: s.x, y: s.y, t };
        } else {
          this.lensActive = true;
          out.zoom = { level: Math.max(GESTURE.lensLevel, this.zoomLevel), originX: s.x, originY: s.y, follow: true };
        }
      }
    } else if (this.lensActive && pose !== 'none') {
      this.lensAwaySince ??= t;
      if (t - this.lensAwaySince >= GESTURE.lensReleaseMs) this.endLens(events);
    }

    // Pinch: the finger on the thumb picks what to draw. Holding the pen still at the end of a stroke straightens it.
    if (isPinch(pose)) {
      if (t - this.lastPenT > 300) this.pen.reset();
      if (!isPinch(prevPose) || !this.drawTool) this.drawTool = PINCH_TOOL[pose];
      // The pen writes between thumb and index. The other pinches keep the index out, so they point
      // with its tip, exactly where the laser was: the cursor never jumps and stays inside the reach box.
      const [rx, ry] = this.toScreen(pose === 'pinch' ? midpoint(lm[4], lm[8]) : lm[8], width, height);
      const s = this.pen.filter(rx, ry, t, diagonal);
      out.pointer = { ...s, t };
      out.penDown = true;
      out.tool = this.drawTool;
      this.lastPenT = t;
      this.penDownSince ??= t;
      if (this.drawTool !== 'pen') {
        this.penStillSince = null;
      } else if (Math.hypot(s.vx, s.vy) < GESTURE.penStillSpeed * scale) {
        this.penStillSince ??= t;
        if (!this.penHoldFired && t - this.penStillSince >= GESTURE.penHoldMs && t - this.penDownSince >= GESTURE.penHoldMs) {
          events.push({ type: 'pen-hold' });
          this.penHoldFired = true;
        }
      } else {
        this.penStillSince = null;
        this.penHoldFired = false;
      }
    } else {
      this.penDownSince = null;
      this.penStillSince = null;
      this.penHoldFired = false;
      this.drawTool = null;
    }

    // Two fingers pointing sideways: right advances, left goes back.
    if (nav.dir) events.push({ type: nav.dir > 0 ? 'next' : 'prev' });

    // Thumb down held still: clear the ink. Latched until the hand does something else.
    if (pose === 'thumbsDown' && !this.clearLatch && this.speed < GESTURE.menuStillSpeed) {
      this.clearSince ??= t;
      const progress = Math.min((t - this.clearSince) / GESTURE.clearHoldMs, 1);
      out.tool = 'clear';
      if (progress >= 1) {
        events.push({ type: 'clear' });
        this.clearLatch = true;
        this.clearSince = null;
      } else if (progress > 0.15) {
        out.hold = { progress, kind: 'clear' };
      }
    } else {
      this.clearSince = null;
    }

    // Three fingers up held still: undo. Four with the thumb folded: redo.
    const history = this.speed < GESTURE.menuStillSpeed ? historyGesture(lm, aspect, pose) : null;
    const available = history === 'undo' ? this.canUndo : history === 'redo' && this.canRedo;
    if (history && available && history !== this.historyLatch) {
      if (history !== this.historyKind) {
        this.historyKind = history;
        this.historySince = t;
      }
      const progress = Math.min((t - this.historySince) / GESTURE.historyHoldMs, 1);
      if (progress >= 1) {
        events.push({ type: history });
        this.historyLatch = history;
        this.historyKind = null;
      } else if (progress > 0.2) {
        out.hold = { progress, kind: history };
      }
    } else {
      this.historyKind = null;
      if (!history && pose !== 'none') this.historyLatch = null;
    }

    // Open palm held still: menu.
    const holdingOpen = pose === 'open' && this.secondaryPose !== 'open' && !this.openLatch && this.speed < GESTURE.menuStillSpeed;
    if (holdingOpen) {
      this.openSince ??= t;
      const progress = Math.min((t - this.openSince) / GESTURE.menuOpenHoldMs, 1);
      if (progress >= 1) {
        this.setMenuOpen(true);
        this.menuActivity = t;
        this.openSince = null;
        events.push({ type: 'menu-open' });
        out.tool = 'menu';
      } else if (progress > 0.2) {
        out.hold = { progress, kind: 'menu' };
      }
    } else {
      this.openSince = null;
    }

    // Zoom clutch: a fist, or a pinch with the other hand. Up zooms in, down zooms out.
    let clutch: { at: Landmark; palm: number } | null = null;
    if (!this.lensActive) {
      if (pose === 'fist') clutch = { at: lm[9], palm };
      else if (secondary && this.secondaryPose === 'pinch') clutch = { at: midpoint(secondary[4], secondary[8]), palm: palmLength(secondary, aspect) };
    }
    if (clutch) {
      if (!this.zoomClutch) {
        this.zoomClutch = { y: clutch.at.y, level: this.zoomLevel };
        if (this.zoomLevel <= 1.02) {
          const laser = this.lastLaser;
          if (laser && t - laser.t < GESTURE.laserMemoryMs) this.zoomOrigin = { x: laser.x, y: laser.y };
          else {
            const [ox, oy] = this.toScreen(clutch.at, width, height);
            this.zoomOrigin = { x: ox, y: oy };
          }
        }
      }
      const rawUp = (this.zoomClutch.y - clutch.at.y) / clutch.palm;
      const up = Math.sign(rawUp) * Math.max(0, Math.abs(rawUp) - GESTURE.zoomDeadBand);
      this.zoomLevel = clamp(this.zoomClutch.level * 2 ** (up / GESTURE.zoomPalmsPerDoubling), GESTURE.zoomMin, GESTURE.zoomMax);
      out.zoom = { level: this.zoomLevel, originX: this.zoomOrigin.x, originY: this.zoomOrigin.y, follow: false };
      out.tool = 'zoom';
    } else {
      this.zoomClutch = null;
    }

    // Two open hands: back to 1×.
    if (pose === 'open' && this.secondaryPose === 'open') {
      this.twoOpenSince ??= t;
      if (!this.twoOpenLatched && t - this.twoOpenSince >= GESTURE.twoOpenMs) {
        this.twoOpenLatched = true;
        if (this.zoomLevel > 1.02) {
          events.push({ type: 'zoom-reset' });
          this.zoomLevel = 1;
        }
      }
    } else {
      this.twoOpenSince = null;
      this.twoOpenLatched = false;
    }

    return this.finish(out);
  }

  private closeMenu() {
    this.menuOpen = false;
    this.openLatch = true;
    this.openSince = null;
  }

  private endLens(events: GestureEvent[]) {
    this.lensActive = false;
    this.lensAwaySince = null;
    this.zoomLevel = 1;
    events.push({ type: 'zoom-reset' });
  }

  private finish(out: FrameOutput): FrameOutput {
    out.menuOpen = this.menuOpen;
    const prev = this.last;
    if (!prev || prev.pose !== out.pose) debugLog('pose', { pose: out.pose, from: prev?.pose, tool: out.tool });
    if (!prev || prev.tracking !== out.tracking) debugLog('tracking', { state: out.tracking });
    if (prev && prev.penDown !== out.penDown) debugLog(out.penDown ? 'pen-down' : 'pen-up', { pose: out.pose });
    for (const ev of out.events) debugLog('event', { event: ev.type });
    this.last = out;
    return out;
  }

  private noHands(t: number, events: GestureEvent[]): FrameOutput {
    const gap = t - this.lastHandT;
    const last = this.last;
    const limit = last?.penDown ? GESTURE.penGapHoldMs : GESTURE.gapHoldMs;
    // Tracker blinked: keep drawing, pointing or erasing instead of dropping the stroke.
    if (last && gap < limit && (last.penDown || last.pointer || last.eraser)) {
      if (this.holdingSince === null) {
        this.holdingSince = this.lastHandT;
        debugLog('gap-hold', { tool: last.tool, penDown: last.penDown });
      }
      return {
        ...last,
        pointer: last.pointer && { ...last.pointer, vx: 0, vy: 0 },
        eraser: last.eraser && { ...last.eraser, vx: 0, vy: 0 },
        zoom: last.zoom?.follow ? last.zoom : null,
        hold: null,
        nav: null,
        menuOpen: this.menuOpen,
        events,
      };
    }
    if (this.holdingSince !== null) {
      debugLog('gap-dropped', { ms: Math.round(gap), tool: last?.tool, penDown: last?.penDown });
      this.holdingSince = null;
    }
    if (this.lensActive) this.endLens(events);
    this.lastWrist = null;
    this.primaryWrist = null;
    this.zoomClutch = null;
    this.openSince = null;
    this.twoOpenSince = null;
    this.navDir = null;
    this.navLatch = false;
    this.penDownSince = null;
    this.penStillSince = null;
    this.drawTool = null;
    this.clearSince = null;
    this.historyKind = null;
    this.candidate = 'none';
    this.stable = 'none';
    this.secondaryPose = 'none';
    return this.finish({
      tracking: Number.isFinite(this.lastHandT) && gap < GESTURE.lostAfterMs ? 'lost' : 'searching',
      pose: 'none',
      tool: null,
      pointer: null,
      penDown: false,
      eraser: null,
      zoom: null,
      hold: null,
      nav: null,
      menuOpen: false,
      events,
    });
  }

  /**
   * Index and middle pointing sideways, like showing the way: held briefly, they turn one page.
   * The hand has to relax (or point the other way) before the next turn, so holding the pose
   * never flips through the deck. Fingers up or a single pointing finger do nothing.
   */
  private trackNav(lm: Landmark[], pose: Pose, aspect: number, t: number): { dir: -1 | 1 | null; lean: number } {
    // A tracking blip in the middle of the hold doesn't restart it.
    if (pose === 'none') return { dir: null, lean: 0 };
    const angle = pose === 'two' ? fingerAngle(lm, aspect) : null;
    const dir = angle === null ? null : angleGap(angle, 0) <= GESTURE.navAngleDeg ? 1 : angleGap(angle, 180) <= GESTURE.navAngleDeg ? -1 : null;
    if (!dir) {
      this.navDir = null;
      this.navLatch = false;
      return { dir: null, lean: 0 };
    }
    if (dir !== this.navDir) {
      this.navDir = dir;
      this.navSince = t;
      this.navLatch = false;
    }
    if (this.navLatch) return { dir: null, lean: 0 };
    const progress = Math.min((t - this.navSince) / GESTURE.navHoldMs, 1);
    if (progress < 1) return { dir: null, lean: dir * progress };
    this.navLatch = true;
    debugLog('nav-point', { dir, angle: Math.round(angle!) });
    return { dir, lean: 0 };
  }

  /** Follows the same hand across frames; then the registered hand; then the closest one. */
  private pickPrimary(hands: Landmark[][], labels: string[] | undefined, aspect: number) {
    let best = 0;
    if (hands.length > 1) {
      const last = this.primaryWrist;
      best = last ? hands.findIndex(h => distance(h[WRIST], last, aspect) < 0.15) : -1;
      if (best < 0 && this.handedness && labels) {
        const matches = labels.flatMap((label, i) => (label === this.handedness ? [i] : []));
        if (matches.length === 1) best = matches[0];
      }
      if (best < 0) best = hands.reduce((bi, h, i) => (palmLength(h, aspect) > palmLength(hands[bi], aspect) ? i : bi), 0);
    }
    this.primaryWrist = hands[best][WRIST];
    return best;
  }

  private trackSpeed(wrist: Landmark, palm: number, aspect: number, t: number) {
    const last = this.lastWrist;
    if (last && t > last.t) {
      const v = distance(wrist, last, aspect) / palm / ((t - last.t) / 1000);
      this.speed += 0.5 * (v - this.speed);
    } else {
      this.speed = 0;
    }
    this.lastWrist = { x: wrist.x, y: wrist.y, t };
  }

  /** Camera is mirrored so moving the hand right moves the pointer right. */
  private toScreen(p: Landmark, width: number, height: number): [number, number] {
    const { x0, x1, y0, y1 } = this.mapped;
    const rawX = (1 - p.x - x0) / (x1 - x0);
    const rawY = (p.y - y0) / (y1 - y0);
    debugStat('outsideReach', rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1 ? 1 : 0);
    return [clamp(rawX, 0, 1) * width, clamp(rawY, 0, 1) * height];
  }
}

function midpoint(a: Landmark, b: Landmark): Landmark {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function clamp(v: number, min: number, max: number) {
  return Math.min(Math.max(v, min), max);
}
