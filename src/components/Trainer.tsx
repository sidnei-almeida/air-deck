import { useCallback, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type CSSProperties } from 'react';
import { AnimatePresence, motion, useMotionTemplate, useMotionValue, useSpring } from 'motion/react';
import { useHandTracking, type HandFrame } from '../hooks/useHandTracking';
import { balanceReach, classifyPose, DEFAULT_REACH, GestureEngine, palmLength, ThumbsUpHold, type Landmark, type PointerTool, type Pose, type ReachBox, type Tool } from '../lib/gestures';
import { GestureController, type SlideSpace } from '../lib/controller';
import { InkLayer } from '../lib/ink';
import { OverlayRenderer } from '../lib/overlay';
import { drawPip, drawReach } from '../lib/pip';
import { SMOOTHING, type SmoothingPreset } from '../lib/oneEuro';
import { resolveInk } from '../lib/contrast';
import { shapeContains } from '../lib/shapes';
import { loadPractice, savePractice, type Prefs } from '../lib/prefs';
import { GESTURE_GUIDE } from '../lib/glyphs';
import { debugLog } from '../lib/debug';
import { Lockup, Mark, Wordmark } from './Brand';
import { Scribble } from './Scribble';
import { POINTER_LABEL, TOOL_LABEL } from './Hud';
import { Icon } from './Icon';
import { MenuDwell, menuOptionAt, OPTION_TOOL, ToolMenu } from './ToolMenu';

type Step = 'hand' | 'reach' | 'practice' | 'done';
type Tone = 'ok' | 'search' | 'lost';

interface MenuState {
  open: boolean;
  hot: number | null;
  progress: number;
}

const STEPS = [
  { id: 'hand', label: 'Hand' },
  { id: 'reach', label: 'Reach' },
  { id: 'practice', label: 'Practice' },
] as const;

const CHALLENGES = [
  { id: 'laser', guide: 'laser', title: 'Laser', how: 'Raise just your index finger and hit the 3 targets.', goal: 3 },
  { id: 'pen', guide: 'pen', title: 'Pen', how: 'Thumb + index: write on the slide. Underline with a straight stroke and let go.', goal: 1 },
  { id: 'rect', guide: 'rect', title: 'Rectangle', how: 'Thumb + middle: aim at a corner of the word, hold until the ring closes, drag to the opposite corner.', goal: 1 },
  { id: 'circle', guide: 'ellipse', title: 'Circle', how: 'Thumb + ring: aim at a corner of the word, hold until the ring closes, drag to the opposite corner.', goal: 1 },
  { id: 'arrow', guide: 'arrow', title: 'Arrow', how: 'Thumb + pinky: aim away from the word, hold until the ring closes, drag the tip onto it.', goal: 1 },
  { id: 'next', guide: 'nav', title: 'Next slide', how: 'Index and middle together, pointing right. Relax your hand before the second one.', goal: 2 },
  { id: 'prev', guide: 'nav', title: 'Previous', how: 'Index and middle together, pointing left.', goal: 1 },
  { id: 'menu', guide: 'menu', title: 'Menu', how: 'Hold an open palm still. Point at Zoom and hold.', goal: 1 },
  { id: 'eraser', guide: 'menu', title: 'Eraser', how: 'In the menu, pick Eraser and sweep your index over the scribble.', goal: 1 },
  { id: 'clear', guide: 'clear', title: 'Clear', how: 'Thumbs down, held still until the ring closes.', goal: 1 },
  { id: 'undo', guide: 'history', title: 'Undo', how: 'Draw something. Then three fingers up, pinky folded, held still until the ring closes.', goal: 1 },
  { id: 'redo', guide: 'history', title: 'Redo', how: 'After undoing, four fingers up with the thumb folded into the palm, held still.', goal: 1 },
  { id: 'zoom', guide: 'zoom', title: 'Zoom', how: 'Make a fist and raise it to 2×. Or point with Zoom from the menu.', goal: 1 },
  { id: 'board', guide: 'menu', title: 'Whiteboard', how: 'In the menu, pick Whiteboard. Two fingers sideways bring you back.', goal: 1 },
] as const;
/** How close the arrow tip must land to the word, in slide units. */
const ARROW_REACH = 0.05;
const SHAPE_CHALLENGE = { rect: 'rect', ellipse: 'circle', arrow: 'arrow' } as const;
const SHAPE_NAME = { rect: 'a rectangle', ellipse: 'a circle', arrow: 'an arrow' } as const;
/** Which finger the active shape challenge wants, said when another finger drew. */
const SHAPE_CHALLENGE_TOOL = { rect: 'Rectangle is thumb + middle.', circle: 'Circle is thumb + ring.', arrow: 'Arrow is thumb + pinky.' } as const;
type ChallengeId = (typeof CHALLENGES)[number]['id'];

const LASER_TARGETS = [
  { x: 0.24, y: 0.3 },
  { x: 0.77, y: 0.32 },
  { x: 0.52, y: 0.76 },
];
const HOLD_MS = 3000;
const SLIDE_WIDTH = 0.82;
const GLIDE = [0.22, 1, 0.36, 1] as const;
const MENU_CLOSED: MenuState = { open: false, hot: null, progress: 0 };

const emptyCounts = (): Record<ChallengeId, number> => ({ laser: 0, pen: 0, rect: 0, circle: 0, arrow: 0, next: 0, prev: 0, menu: 0, eraser: 0, clear: 0, undo: 0, redo: 0, zoom: 0, board: 0 });

const slideVariants = {
  enter: (dir: number) => ({ x: `${dir * 8}%`, opacity: 0 }),
  center: { x: '0%', opacity: 1 },
  exit: (dir: number) => ({ x: `${dir * -16}%`, opacity: 0 }),
};

interface Draft {
  handedness: string | null;
  jitter: number | null;
  smoothing: SmoothingPreset;
  reach: ReachBox;
}

interface Props {
  prefs: Prefs;
  onPrefs: (prefs: Prefs) => void;
  onClose: () => void;
  doneLabel: string;
  skipLabel: string;
  /** Someone with a saved hand goes straight to practice; the first two steps stay one click away. */
  startStep?: Step;
}

const percentile = (sorted: number[], q: number) => sorted[Math.floor(q * (sorted.length - 1))];
const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/** Reach wider than this (camera fraction) counts as covering the sides; taller than `REACH_MIN_H` as covering up and down. */
const REACH_MIN_W = 0.3;
const REACH_MIN_H = 0.2;

/**
 * The comfortable area: where the fingertip went, minus stray points (a hand dropping out of view).
 * `box` is what gets saved; `shown` is how the engine will balance it for this camera and screen.
 */
function reachFromSamples(samples: { u: number; y: number }[], camAspect: number, screenAspect: number) {
  if (samples.length < 20) return null;
  const us = samples.map(s => s.u).sort((a, b) => a - b);
  const ys = samples.map(s => s.y).sort((a, b) => a - b);
  const box = { x0: clamp01(percentile(us, 0.03)), x1: clamp01(percentile(us, 0.97)), y0: clamp01(percentile(ys, 0.03)), y1: clamp01(percentile(ys, 0.97)) };
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const progress = (Math.min(w / REACH_MIN_W, 1) * 0.5 + Math.min(h / REACH_MIN_H, 1) * 0.5) * Math.min(samples.length / 60, 1);
  const hint = w < REACH_MIN_W ? 'Go further to the sides, left and right' : h < REACH_MIN_H ? 'Go further up and down' : samples.length < 60 ? 'Keep sweeping your finger around the area' : null;
  return {
    box: w > 0.05 && h > 0.05 ? box : null,
    shown: balanceReach(box, camAspect, screenAspect),
    ready: samples.length >= 60 && w >= REACH_MIN_W && h >= REACH_MIN_H,
    progress,
    hint,
  };
}

/** A button the thumbs up also presses, so the trainer never needs the mouse. It fills while the thumb is held up. */
function ThumbButton({ progress, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { progress: number }) {
  return (
    <button {...props} className={`${className} thumb-btn`} style={{ '--p': progress } as CSSProperties} title="Or hold a thumbs up">
      <span className="thumb-fill" aria-hidden="true" />
      {children}
      <Icon name="thumbUp" size={15} />
    </button>
  );
}

export function Trainer({ prefs, onPrefs, onClose, doneLabel, skipLabel, startStep = 'hand' }: Props) {
  const [step, setStep] = useState<Step>(startStep);
  const stepRef = useRef<Step>(startStep);
  useEffect(() => {
    stepRef.current = step;
  }, [step]);

  const prefsRef = useRef(prefs);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);

  const [draft, setDraft] = useState<Draft>(() => ({
    handedness: prefs.profile?.handedness ?? null,
    jitter: prefs.profile?.jitter ?? null,
    smoothing: prefs.smoothing,
    reach: prefs.profile?.reach ?? DEFAULT_REACH,
  }));
  const draftRef = useRef(draft);
  const commitDraft = useCallback((next: Draft) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const saveProfile = useCallback(() => {
    const d = draftRef.current;
    onPrefs({
      ...prefsRef.current,
      smoothing: d.smoothing,
      profile: { handedness: d.handedness, jitter: d.jitter, reach: d.reach, createdAt: new Date().toISOString() },
    });
  }, [onPrefs]);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const pipRef = useRef<HTMLCanvasElement>(null);

  /* ---------- step 1: hand ---------- */
  const [hold, setHold] = useState<{ progress: number; hint: string; tone: Tone }>({ progress: 0, hint: 'Show your hand to the camera', tone: 'search' });
  const holdRef = useRef({
    since: null as number | null,
    badSince: null as number | null,
    deltas: [] as number[],
    lastTip: null as Landmark | null,
    labels: {} as Record<string, number>,
    pose: 'none' as Pose,
    speed: 0,
    lastWrist: null as { x: number; y: number; t: number } | null,
    done: false,
    lastHint: '',
  });

  /* ---------- step 2: reach ---------- */
  const reachRef = useRef({ samples: [] as { u: number; y: number }[], pose: 'none' as Pose, lastUpdate: 0 });
  const [reach, setReach] = useState<{ box: ReachBox | null; ready: boolean; progress: number; hint?: string | null }>({ box: null, ready: false, progress: 0 });

  useEffect(() => {
    debugLog('trainer-step', { step });
    if (step === 'hand') {
      Object.assign(holdRef.current, { since: null, badSince: null, deltas: [], lastTip: null, labels: {}, done: false });
      setHold({ progress: 0, hint: 'Show your hand to the camera', tone: 'search' });
    }
    if (step === 'reach') {
      reachRef.current.samples = [];
      setReach({ box: null, ready: false, progress: 0 });
    }
  }, [step]);

  /* ---------- step 3: practice ---------- */
  const stageRef = useRef<HTMLDivElement>(null);
  const slideRef = useRef<HTMLDivElement | null>(null);
  const wordRef = useRef<HTMLSpanElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const stageSize = useRef({ width: 1, height: 1 });
  const controllerRef = useRef<GestureController | null>(null);
  const engineRef = useRef<GestureEngine | null>(null);
  const inkRef = useRef<InkLayer | null>(null);
  // Practice progress survives closing the trainer and reloading the app.
  const [counts, setCounts] = useState(() => {
    const saved = loadPractice();
    const counts = emptyCounts();
    for (const c of CHALLENGES) counts[c.id] = Math.min(saved[c.id] ?? 0, c.goal);
    return counts;
  });
  const countsRef = useRef(counts);
  const [active, setActive] = useState<ChallengeId>(() => (CHALLENGES.find(c => counts[c.id] < c.goal) ?? CHALLENGES[0]).id);
  const activeRef = useRef<ChallengeId>(active);
  const [page, setPage] = useState(1);
  const pageRef = useRef(1);
  const [dir, setDir] = useState(1);
  const [board, setBoard] = useState(false);
  const boardRef = useRef(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const toolRef = useRef<Tool | null>(null);
  const [pointerTool, setPointerTool] = useState<PointerTool>('laser');
  const [menu, setMenu] = useState<MenuState>(MENU_CLOSED);
  const menuRef = useRef<MenuState>(MENU_CLOSED);
  const dwellRef = useRef(new MenuDwell());
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef(0);
  const dwellTargetRef = useRef<number | null>(null);
  const penTotal = useRef(0);

  const zoomTarget = useMotionValue(1);
  const zoom = useSpring(zoomTarget, { stiffness: 220, damping: 28, mass: 0.9 });
  const originX = useMotionValue(0);
  const originY = useMotionValue(0);
  const transformOrigin = useMotionTemplate`${originX}px ${originY}px`;

  const say = useCallback((text: string) => {
    setFeedback(text);
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 2400);
  }, []);
  useEffect(() => () => window.clearTimeout(feedbackTimer.current), []);

  const selectChallenge = useCallback((id: ChallengeId) => {
    activeRef.current = id;
    setActive(id);
  }, []);

  const bump = useCallback(
    (id: ChallengeId) => {
      const current = countsRef.current;
      const goal = CHALLENGES.find(c => c.id === id)!.goal;
      if (current[id] >= goal) return;
      const next = { ...current, [id]: current[id] + 1 };
      countsRef.current = next;
      setCounts(next);
      savePractice(next);
      debugLog('challenge', { id, count: next[id], goal });
      if (next[id] < goal) return;
      const remaining = CHALLENGES.filter(c => next[c.id] < c.goal);
      if (remaining.length === 0) window.setTimeout(() => setStep(s => (s === 'practice' ? 'done' : s)), 900);
      else if (activeRef.current === id) window.setTimeout(() => selectChallenge(remaining[0].id), 500);
    },
    [selectChallenge],
  );

  const syncMenu = useCallback((next: MenuState) => {
    const prev = menuRef.current;
    if (prev.open === next.open && prev.hot === next.hot && Math.abs(prev.progress - next.progress) < 0.04) return;
    menuRef.current = next;
    setMenu(next);
  }, []);

  const setMenuOpen = useCallback(
    (open: boolean) => {
      engineRef.current?.setMenuOpen(open);
      dwellRef.current.reset();
      syncMenu({ open, hot: null, progress: 0 });
    },
    [syncMenu],
  );

  const resetZoom = useCallback(() => {
    zoomTarget.set(1);
    engineRef.current?.setZoom(1);
  }, [zoomTarget]);

  const applyMenuOption = useCallback(
    (option: number) => {
      setMenuOpen(false);
      debugLog('menu-select', { option });
      bump('menu');
      const next = OPTION_TOOL[option];
      if (next) {
        setPointerTool(next);
        engineRef.current?.setPointerTool(next);
        say(`1 finger is now ${POINTER_LABEL[next]}`);
      } else if (option === 4) {
        boardRef.current = !boardRef.current;
        setBoard(boardRef.current);
        resetZoom();
        if (boardRef.current) bump('board');
      } else if (option === 5) {
        inkRef.current?.clearPage();
      }
    },
    [bump, resetZoom, say, setMenuOpen],
  );

  const space = useMemo<SlideSpace>(
    () => ({
      screen: () => stageSize.current,
      toSlide: (x, y) => {
        const { width, height } = stageSize.current;
        const s = zoom.get();
        const ox = originX.get();
        const oy = originY.get();
        const sw = width * SLIDE_WIDTH;
        const sh = (sw * 9) / 16;
        const px = ox + (x - ox) / s;
        const py = oy + (y - oy) / s;
        return { x: (px - (width - sw) / 2) / sw, y: (py - (height - sh) / 2) / sw };
      },
      pxPerUnit: () => stageSize.current.width * SLIDE_WIDTH * zoom.get(),
    }),
    [originX, originY, zoom],
  );

  const actionsRef = useRef({ applyMenuOption, resetZoom, say, setMenuOpen, syncMenu });
  useEffect(() => {
    actionsRef.current = { applyMenuOption, resetZoom, say, setMenuOpen, syncMenu };
  }, [applyMenuOption, resetZoom, say, setMenuOpen, syncMenu]);

  useEffect(() => {
    if (step !== 'practice') return;
    const stage = stageRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!stage || !overlayCanvas || !inkCanvas) return;
    const d = draftRef.current;
    const measure = () => {
      stageSize.current = { width: stage.clientWidth, height: stage.clientHeight };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);

    const overlay = new OverlayRenderer(overlayCanvas, SMOOTHING[d.smoothing].leadMs);
    const ink = new InkLayer(inkCanvas);
    ink.setColor(resolveInk(prefsRef.current.inkColor, 'light'));
    ink.setPage(boardRef.current ? 'board' : `t${pageRef.current}`);
    inkRef.current = ink;
    const engine = new GestureEngine({ smoothing: d.smoothing, reach: d.reach, handedness: d.handedness });
    engineRef.current = engine;
    const turn = (delta: 1 | -1) => {
      if (menuRef.current.open) {
        actionsRef.current.setMenuOpen(false);
        return;
      }
      if (boardRef.current) {
        boardRef.current = false;
        setBoard(false);
      } else if (pageRef.current + delta >= 1) {
        pageRef.current += delta;
        setDir(delta);
        setPage(pageRef.current);
      }
      actionsRef.current.resetZoom();
      bump(delta > 0 ? 'next' : 'prev');
    };
    const controller = new GestureController(engine, overlay, ink, space, {
      next: () => turn(1),
      prev: () => turn(-1),
      zoom: (level, ox, oy, follow) => {
        if (follow || zoom.get() < 1.05) {
          originX.set(ox);
          originY.set(oy);
        }
        zoomTarget.set(level);
        if (level >= 2) bump('zoom');
      },
      resetZoom: () => actionsRef.current.resetZoom(),
      menuOpen: () => {
        dwellRef.current.reset();
        actionsRef.current.syncMenu({ open: true, hot: null, progress: 0 });
      },
      menuClose: () => {
        dwellRef.current.reset();
        actionsRef.current.syncMenu(MENU_CLOSED);
      },
      menuPointer: (x, y, t) => {
        const rect = stage.getBoundingClientRect();
        const picked = dwellRef.current.update(menuOptionAt(rect.left + x, rect.top + y), t);
        if (picked) actionsRef.current.applyMenuOption(picked);
        else actionsRef.current.syncMenu({ open: true, hot: dwellRef.current.hot, progress: dwellRef.current.progress });
      },
      menuClick: () => {
        const option = dwellRef.current.hot;
        if (option) actionsRef.current.applyMenuOption(option);
      },
      clear: () => {
        if (ink.clearPage()) bump('clear');
        else actionsRef.current.say('Nothing to clear. Scribble something first.');
      },
      history: (kind, done) => {
        if (done) bump(kind);
        else actionsRef.current.say(kind === 'undo' ? 'Nothing to undo. Draw something first.' : 'Nothing to redo. Undo something first.');
      },
    });
    controller.inkColor = resolveInk(prefsRef.current.inkColor, 'light');
    controllerRef.current = controller;
    return () => {
      observer.disconnect();
      overlay.destroy();
      ink.destroy();
      controllerRef.current = null;
      engineRef.current = null;
      inkRef.current = null;
    };
  }, [step, space, bump, zoom, zoomTarget, originX, originY]);

  useEffect(() => {
    inkRef.current?.setPage(board ? 'board' : `t${page}`);
  }, [page, board]);

  // Something to erase or clear.
  useEffect(() => {
    if (step !== 'practice' || (active !== 'eraser' && active !== 'clear')) return;
    const ink = inkRef.current;
    if (!ink || ink.hasInk()) return;
    ink.addStroke(Array.from({ length: 44 }, (_, i) => ({ x: 0.3 + i * 0.009, y: 0.43 + Math.sin(i / 2.6) * 0.018 })), '#8A91A5');
  }, [step, active, page, board]);

  /* ---------- frame handlers ---------- */
  const handFrame = (f: HandFrame) => {
    const h = holdRef.current;
    const lm = f.hands[0];
    if (previewRef.current) drawPip(previewRef.current, f.video, f.hands, h.pose === 'open' ? 'zoom' : null, 0.85);
    if (h.done) return;

    const bad = (hint: string) => {
      h.lastTip = null;
      h.badSince ??= f.t;
      if (f.t - h.badSince < 250) return;
      if (h.lastHint !== hint) {
        debugLog('hold-reset', { hint, pose: h.pose, speed: Math.round(h.speed * 100) / 100, heldMs: h.since === null ? 0 : Math.round(f.t - h.since) });
        h.lastHint = hint;
      }
      h.since = null;
      h.deltas = [];
      h.labels = {};
      setHold(prev => (prev.progress === 0 && prev.hint === hint ? prev : { progress: 0, hint, tone: 'search' }));
    };
    if (!lm) {
      h.lastWrist = null;
      bad('Show your hand to the camera');
      return;
    }
    const palm = palmLength(lm, f.aspect);
    if (h.lastWrist && f.t > h.lastWrist.t) {
      const v = Math.hypot((lm[0].x - h.lastWrist.x) * f.aspect, lm[0].y - h.lastWrist.y) / palm / ((f.t - h.lastWrist.t) / 1000);
      h.speed += 0.4 * (v - h.speed);
    }
    h.lastWrist = { x: lm[0].x, y: lm[0].y, t: f.t };
    h.pose = classifyPose(lm, f.aspect, h.pose);
    if (h.pose !== 'open' && h.pose !== 'four') return bad('Open your hand wide, palm facing the camera');
    if (h.speed > 0.9) return bad('Hold your hand still');

    h.badSince = null;
    h.since ??= f.t;
    if (h.lastTip) h.deltas.push(Math.hypot((lm[8].x - h.lastTip.x) * f.aspect, lm[8].y - h.lastTip.y) / palm);
    h.lastTip = lm[8];
    const label = f.handedness[0];
    if (label) h.labels[label] = (h.labels[label] ?? 0) + 1;
    const progress = Math.min((f.t - h.since) / HOLD_MS, 1);
    if (h.lastHint !== 'holding') {
      debugLog('hold-start', { pose: h.pose, speed: Math.round(h.speed * 100) / 100 });
      h.lastHint = 'holding';
    }
    setHold(prev => (prev.tone === 'ok' && Math.abs(prev.progress - progress) < 0.02 ? prev : { progress, hint: 'That’s it. Hold a little longer', tone: 'ok' }));

    if (progress < 1) return;
    h.done = true;
    const sorted = [...h.deltas].sort((a, b) => a - b);
    const jitter = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0.01;
    // Fingertip jitter per frame, in palm lengths. Thresholds are first guesses.
    const smoothing: SmoothingPreset = jitter < 0.006 ? 'responsive' : jitter < 0.015 ? 'balanced' : 'stable';
    const handedness = Object.entries(h.labels).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    commitDraft({ ...draftRef.current, jitter, smoothing, handedness });
    debugLog('hand-registered', { jitter: Math.round(jitter * 10000) / 10000, smoothing, handedness, frames: h.deltas.length });
    setHold({ progress: 1, hint: 'Hand saved', tone: 'ok' });
    window.setTimeout(() => setStep(s => (s === 'hand' ? 'reach' : s)), 900);
  };

  const reachFrame = (f: HandFrame) => {
    const r = reachRef.current;
    const lm = f.hands[0];
    if (lm) {
      r.pose = classifyPose(lm, f.aspect, r.pose);
      // Every frame with a hand counts, whatever the pose: reaching far to one side twists the
      // wrist and the pointing pose drops, which used to leave that whole side unrecorded.
      r.samples.push({ u: 1 - lm[8].x, y: lm[8].y });
      if (r.samples.length > 1500) r.samples.shift();
    } else {
      r.pose = 'none';
    }
    const result = reachFromSamples(r.samples, f.aspect, window.innerWidth / Math.max(window.innerHeight, 1));
    const canvas = previewRef.current;
    if (canvas) {
      drawPip(canvas, f.video, f.hands, lm ? 'laser' : null, 0.75);
      drawReach(canvas, f.video, r.samples, result?.shown ?? null);
    }
    if (f.t - r.lastUpdate > 120) {
      r.lastUpdate = f.t;
      setReach({ box: result?.box ?? null, ready: !!result?.ready, progress: result?.progress ?? 0, hint: result?.hint });
    }
  };

  const practiceFrame = (f: HandFrame) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const { out, erased, penDistance, shapes } = controller.handle(f);
    if (out.tool !== toolRef.current) {
      toolRef.current = out.tool;
      setTool(out.tool);
    }
    if (!out.menuOpen && menuRef.current.open) {
      dwellRef.current.reset();
      syncMenu(MENU_CLOSED);
    }
    if (pipRef.current) drawPip(pipRef.current, f.video, f.hands, out.tool);

    if (activeRef.current === 'laser' && out.tool === 'laser' && out.pointer) {
      const target = LASER_TARGETS[countsRef.current.laser];
      const { width, height } = stageSize.current;
      if (target && Math.hypot(out.pointer.x - target.x * width, out.pointer.y - target.y * height) < Math.max(36, width * 0.05)) {
        dwellTargetRef.current ??= f.t;
        if (f.t - dwellTargetRef.current > 150) {
          dwellTargetRef.current = null;
          bump('laser');
        }
      } else {
        dwellTargetRef.current = null;
      }
    }
    if (penDistance > 0) {
      penTotal.current += penDistance;
      if (penTotal.current > 0.25) bump('pen');
    }
    if (erased && activeRef.current === 'eraser') bump('eraser');
    for (const shape of shapes) {
      const word = wordRef.current;
      const slide = slideRef.current;
      if (!word || !slide || boardRef.current || shape.kind === 'underline') continue;
      const wr = word.getBoundingClientRect();
      const sr = slide.getBoundingClientRect();
      const box = { x0: (wr.left - sr.left) / sr.width, x1: (wr.right - sr.left) / sr.width, y0: (wr.top - sr.top) / sr.width, y1: (wr.bottom - sr.top) / sr.width };
      const hit =
        shape.kind === 'arrow'
          ? Math.hypot(Math.max(box.x0 - shape.x2, 0, shape.x2 - box.x1), Math.max(box.y0 - shape.y2, 0, shape.y2 - box.y1)) < ARROW_REACH
          : shapeContains(shape, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
      const challenge = SHAPE_CHALLENGE[shape.kind];
      debugLog('shape-check', { kind: shape.kind, hit, active: activeRef.current });
      if (hit) bump(challenge);
      else if (activeRef.current === challenge) say(shape.kind === 'arrow' ? 'Almost. Let go with the arrow tip on the word.' : 'Almost. The word has to be inside.');
      else if (activeRef.current in SHAPE_CHALLENGE_TOOL && activeRef.current !== challenge) say(`That was ${SHAPE_NAME[shape.kind]}. ${SHAPE_CHALLENGE_TOOL[activeRef.current as keyof typeof SHAPE_CHALLENGE_TOOL]}`);
    }
  };

  const handlers = useRef({ hand: handFrame, reach: reachFrame, practice: practiceFrame, confirm: () => {} });
  useEffect(() => {
    handlers.current = { ...handlers.current, hand: handFrame, reach: reachFrame, practice: practiceFrame };
  });

  /* ---------- thumbs up: the trainer's OK ---------- */
  const [thumb, setThumb] = useState(0);
  const thumbRef = useRef({ poses: [] as Pose[], hold: new ThumbsUpHold() });

  const onFrame = useCallback((f: HandFrame) => {
    const th = thumbRef.current;
    th.poses = f.hands.map((lm, i) => classifyPose(lm, f.aspect, th.poses[i] ?? 'none'));
    const { progress, fire } = th.hold.update(th.poses.includes('thumbsUp'), f.t);
    if (fire) handlers.current.confirm();
    setThumb(prev => (Math.abs(prev - progress) < 0.04 && progress > 0 ? prev : progress));
    const s = stepRef.current;
    if (s === 'hand' || s === 'reach' || s === 'practice') handlers.current[s](f);
  }, []);
  const status = useHandTracking(true, onFrame);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuRef.current.open) setMenuOpen(false);
        else onClose();
      } else if (menuRef.current.open && /^[1-5]$/.test(e.key)) {
        applyMenuOption(Number(e.key));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyMenuOption, onClose, setMenuOpen]);

  const finishReach = (box: ReachBox) => {
    const samples = reachRef.current.samples;
    const us = samples.map(s => s.u);
    const ys = samples.map(s => s.y);
    debugLog('reach-saved', {
      box,
      samples: samples.length,
      extent: samples.length ? { u0: Math.min(...us), u1: Math.max(...us), y0: Math.min(...ys), y1: Math.max(...ys) } : null,
      usedDefault: box === DEFAULT_REACH,
    });
    commitDraft({ ...draftRef.current, reach: box });
    saveProfile();
    setStep('practice');
  };

  /** What a held thumbs up presses on each step: the same button that fills on screen. */
  const confirmStep = () => {
    debugLog('thumbs-up', { step: stepRef.current });
    const s = stepRef.current;
    if (s === 'hand') setStep('reach');
    else if (s === 'reach') finishReach(reach.ready && reach.box ? reach.box : DEFAULT_REACH);
    else if (s === 'practice') setStep('done');
    else {
      saveProfile();
      onClose();
    }
  };
  useEffect(() => {
    handlers.current.confirm = confirmStep;
  });

  const restartPractice = () => {
    const fresh = emptyCounts();
    countsRef.current = fresh;
    setCounts(fresh);
    savePractice(fresh);
    penTotal.current = 0;
    selectChallenge('laser');
    setStep('practice');
  };

  const stepIndex = step === 'done' ? STEPS.length : STEPS.findIndex(s => s.id === step);
  const blocked = status === 'denied' || status === 'unavailable' || status === 'error';
  const doneCount = CHALLENGES.filter(c => counts[c.id] >= c.goal).length;
  const activeIndex = Math.max(CHALLENGES.findIndex(c => c.id === active), 0);
  const activeChallenge = CHALLENGES[activeIndex];
  const activeGuide = GESTURE_GUIDE.find(g => g.id === activeChallenge.guide);
  const activeDone = counts[activeChallenge.id] >= activeChallenge.goal;
  const after = [...CHALLENGES.slice(activeIndex + 1), ...CHALLENGES.slice(0, activeIndex)];
  const upNext = after.find(c => counts[c.id] < c.goal) ?? null;
  const skipChallenge = () => selectChallenge((upNext ?? after[0]).id);

  const preview = (
    <figure className="trainer-preview">
      <div className="preview-frame">
        <canvas ref={previewRef} width={640} height={480} aria-label="Camera with hand landmarks" />
        {status !== 'ready' && (
          <div className="preview-status">
            <span className="spinner" aria-hidden="true" />
            Starting the camera
          </div>
        )}
      </div>
      <figcaption className="mono">live camera · nothing leaves this computer</figcaption>
    </figure>
  );

  return (
    <div className="trainer paper" role="dialog" aria-modal="true" aria-labelledby="trainer-title">
      <div className="trainer-shell">
        <header className="trainer-head">
          <Lockup size={20} />
          <ol className="trainer-steps">
            {STEPS.map((s, i) => (
              <li key={s.id} data-state={i === stepIndex ? 'current' : i < stepIndex ? 'done' : 'todo'}>
                <button type="button" onClick={() => setStep(s.id)} aria-current={i === stepIndex ? 'step' : undefined}>
                  {i < stepIndex ? <Icon name="check" size={13} /> : <span className="mono">{i + 1}</span>}
                  {s.label}
                  {i === stepIndex && <Scribble key={s.id} kind="ellipse" />}
                </button>
              </li>
            ))}
          </ol>
          <div className="trainer-head-end">
            <span className="thumb-hint">
              <Icon name="thumbUp" size={14} /> thumbs up = ok
            </span>
            <button className="link" type="button" onClick={onClose}>
              {skipLabel}
            </button>
          </div>
        </header>

        <div className="trainer-body">
          {blocked ? (
            <section className="trainer-done">
              <span className="done-mark is-lost">
                <Icon name="cameraOff" size={28} />
              </span>
              <h2 id="trainer-title" className="display">
                {status === 'denied' ? 'The camera is blocked.' : 'No camera found.'}
              </h2>
              <p>
                {status === 'denied'
                  ? 'Allow camera access from the lock icon in the address bar, then open practice again.'
                  : 'Connect a webcam and open practice again. Meanwhile, the arrow keys control the slides.'}
              </p>
              <div className="trainer-actions">
                <button className="btn btn-primary btn-small" type="button" onClick={onClose}>
                  {skipLabel}
                </button>
              </div>
            </section>
          ) : step === 'hand' ? (
            <section className="trainer-split">
              <div className="trainer-copy">
                <span className="label">Step 1 of 3</span>
                <h2 id="trainer-title" className="display">
                  Show your{' '}
                  <span className="scribbled">
                    hand
                    <Scribble kind="ellipse" delay={250} />
                  </span>
                  .
                </h2>
                <p>
                  Open hand, palm to the camera, at chest height. Hold it still for 3 seconds so Air-Deck can measure your camera’s tremor and pick
                  the right smoothing.
                </p>
                <div className="hold">
                  <div className="hold-bar">
                    <div style={{ transform: `scaleX(${hold.progress})` }} />
                  </div>
                  <span className="hold-hint" data-tone={hold.tone}>
                    <i />
                    {hold.hint}
                  </span>
                </div>
                {draft.jitter !== null && (
                  <p className="trainer-result mono">
                    {SMOOTHING[draft.smoothing].label} smoothing · tremor {(draft.jitter * 100).toFixed(2)}% of palm
                  </p>
                )}
                <div className="trainer-actions">
                  <ThumbButton progress={thumb} className="btn btn-quiet btn-small" type="button" onClick={() => setStep('reach')}>
                    {draft.jitter !== null ? 'Continue' : 'Skip this step'}
                  </ThumbButton>
                </div>
              </div>
              {preview}
            </section>
          ) : step === 'reach' ? (
            <section className="trainer-split">
              <div className="trainer-copy">
                <span className="label">Step 2 of 3</span>
                <h2 id="trainer-title" className="display">
                  Show your{' '}
                  <span className="scribbled">
                    reach
                    <Scribble kind="underline" delay={250} />
                  </span>
                  .
                </h2>
                <p>
                  Point and move your fingertip as far as your arm goes comfortably: all the way left, all the way right, up and down. That area
                  becomes the whole screen, equally sensitive sideways and up.
                </p>
                <div className="hold">
                  <div className="hold-bar">
                    <div style={{ transform: `scaleX(${reach.progress})` }} />
                  </div>
                  <span className="hold-hint" data-tone={reach.ready ? 'ok' : 'search'}>
                    <i />
                    {reach.ready ? 'Area saved. Continue, or keep refining.' : (reach.hint ?? 'Point and draw the area in the air')}
                  </span>
                </div>
                <div className="trainer-actions">
                  <button
                    className="btn btn-quiet btn-small"
                    type="button"
                    onClick={() => {
                      reachRef.current.samples = [];
                      setReach({ box: null, ready: false, progress: 0 });
                    }}
                  >
                    Start over
                  </button>
                  {reach.ready ? (
                    <button className="btn btn-quiet btn-small" type="button" onClick={() => finishReach(DEFAULT_REACH)}>
                      Use default
                    </button>
                  ) : (
                    <ThumbButton progress={thumb} className="btn btn-quiet btn-small" type="button" onClick={() => finishReach(DEFAULT_REACH)}>
                      Use default
                    </ThumbButton>
                  )}
                  {reach.ready ? (
                    <ThumbButton progress={thumb} className="btn btn-primary btn-small" type="button" onClick={() => reach.box && finishReach(reach.box)}>
                      Continue
                    </ThumbButton>
                  ) : (
                    <button className="btn btn-primary btn-small" type="button" disabled>
                      Continue
                    </button>
                  )}
                </div>
              </div>
              {preview}
            </section>
          ) : step === 'practice' ? (
            <section className="practice">
              {/* The coach: every challenge as a stop on a track, and the current one large. Nothing to scroll. */}
              <aside className="coach">
                <header className="coach-head">
                  <div className="coach-progress">
                    <span className="label">Step 3 of 3 · practice</span>
                    <span className="mono coach-tally">
                      {doneCount}/{CHALLENGES.length}
                    </span>
                  </div>
                  <ol className="coach-track" aria-label="Practice challenges">
                    {CHALLENGES.map((c, i) => {
                      const done = counts[c.id] >= c.goal;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="tick"
                            data-active={c.id === active}
                            data-done={done}
                            onClick={() => selectChallenge(c.id)}
                            title={c.title}
                            aria-label={`${i + 1}. ${c.title}${done ? ', done' : ''}`}
                            aria-current={c.id === active ? 'step' : undefined}
                          >
                            {done ? <Icon name="check" size={13} /> : i + 1}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </header>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={active}
                    className="coach-now"
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ duration: 0.24, ease: GLIDE }}
                  >
                    <span className="mono coach-step">
                      {String(activeIndex + 1).padStart(2, '0')} / {CHALLENGES.length}
                    </span>
                    <h2 id="trainer-title" className="display coach-title">
                      <span className="scribbled">
                        {activeChallenge.title}
                        {activeDone && <Scribble kind="underline" />}
                      </span>
                    </h2>
                    <p className="coach-how">{activeChallenge.how}</p>
                    {activeGuide && <svg className="coach-glyph" viewBox="0 0 176 64" aria-hidden="true" dangerouslySetInnerHTML={{ __html: activeGuide.svg }} />}
                    <div className="coach-status">
                      <span className="coach-count" aria-label={`${Math.min(counts[active], activeChallenge.goal)} of ${activeChallenge.goal}`}>
                        {Array.from({ length: activeChallenge.goal }, (_, k) => (
                          <i key={k} data-on={k < counts[active]} />
                        ))}
                      </span>
                      {activeDone ? (
                        <span className="coach-done">
                          <Icon name="check" size={14} /> Done
                        </span>
                      ) : (
                        <button className="link" type="button" onClick={skipChallenge}>
                          Skip this one
                        </button>
                      )}
                    </div>
                  </motion.div>
                </AnimatePresence>
                <footer className="coach-foot">
                  {upNext && (
                    <span className="coach-next">
                      Up next<b>{upNext.title}</b>
                    </span>
                  )}
                  <ThumbButton progress={thumb} className="btn btn-primary" type="button" onClick={() => setStep('done')}>
                    Finish practice
                  </ThumbButton>
                </footer>
              </aside>

              <div className="practice-stage" ref={stageRef}>
                <motion.div className="practice-zoom" style={{ scale: zoom, transformOrigin }}>
                  <AnimatePresence initial={false} custom={dir}>
                    <motion.div
                      key={board ? 'board' : page}
                      ref={el => {
                        if (el) slideRef.current = el;
                      }}
                      className={board ? 'practice-slide is-board' : 'practice-slide'}
                      custom={dir}
                      variants={slideVariants}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      transition={{ duration: 0.42, ease: GLIDE }}
                    >
                      {board ? (
                        <span className="board-mark">
                          <Mark size={16} />
                          <Wordmark />
                        </span>
                      ) : (
                        <>
                          <span className="eyebrow">Practice · slide {String(page).padStart(2, '0')}</span>
                          <h3>
                            The answer is{' '}
                            <span
                              className="practice-word"
                              ref={el => {
                                if (el) wordRef.current = el;
                              }}
                            >
                              glucose
                            </span>
                          </h3>
                          <p>Point, write, circle. Nothing here counts for real.</p>
                        </>
                      )}
                    </motion.div>
                  </AnimatePresence>
                  <canvas ref={inkCanvasRef} className="practice-ink" aria-hidden="true" />
                </motion.div>
                {active === 'laser' &&
                  LASER_TARGETS.map((p, i) => (
                    <span
                      key={i}
                      className="practice-target"
                      data-state={i < counts.laser ? 'done' : i === counts.laser ? 'current' : 'todo'}
                      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
                    />
                  ))}
                <div className="practice-hud">
                  <span className="chip" data-state={status !== 'ready' ? 'search' : tool ? 'ok' : 'search'}>
                    <i />
                    {status !== 'ready' ? 'Starting camera' : tool ? TOOL_LABEL[tool] : 'Show your hand'}
                  </span>
                </div>
                <ToolMenu
                  compact
                  open={menu.open}
                  hot={menu.hot}
                  progress={menu.progress}
                  pointerTool={pointerTool}
                  board={board}
                  onSelect={applyMenuOption}
                  onClose={() => setMenuOpen(false)}
                />
                <canvas ref={overlayCanvasRef} className="overlay overlay-top" aria-hidden="true" />
                <canvas ref={pipRef} className="pip practice-pip" width={352} height={264} aria-hidden="true" />
                {feedback && <div className="toast toast-hint practice-feedback">{feedback}</div>}
              </div>
            </section>
          ) : (
            <section className="trainer-done">
              <span className="done-mark">
                <Icon name="check" size={28} />
              </span>
              <h2 id="trainer-title" className="display">
                All{' '}
                <span className="scribbled">
                  set
                  <Scribble kind="underline" delay={200} />
                </span>
                .
              </h2>
              <p>Your hand is saved in this browser. Redo it anytime from Settings.</p>
              <div className="done-summary">
                <span>{SMOOTHING[draft.smoothing].label} smoothing</span>
                <span>{draft.reach === DEFAULT_REACH ? 'Default reach' : 'Custom reach'}</span>
                <span>
                  {doneCount}/{CHALLENGES.length} gestures practiced
                </span>
              </div>
              <div className="trainer-actions">
                <button className="btn btn-quiet btn-small" type="button" onClick={restartPractice}>
                  Practice again
                </button>
                <ThumbButton
                  progress={thumb}
                  className="btn btn-primary"
                  type="button"
                  autoFocus
                  onClick={() => {
                    saveProfile();
                    onClose();
                  }}
                >
                  {doneLabel}
                </ThumbButton>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
