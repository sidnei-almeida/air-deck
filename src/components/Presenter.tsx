import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, useMotionTemplate, useMotionValue, useMotionValueEvent, useSpring } from 'motion/react';
import { renderPage, type PDFDocumentProxy } from '../lib/pdf';
import { DEFAULT_REACH, GestureEngine, GESTURE, type PointerTool, type Tool, type TrackingState } from '../lib/gestures';
import { GestureController, type ControllerActions, type SlideSpace } from '../lib/controller';
import { InkLayer } from '../lib/ink';
import { useHandTracking, type HandFrame } from '../hooks/useHandTracking';
import { OverlayRenderer } from '../lib/overlay';
import { clearPip, drawPip } from '../lib/pip';
import { loadPrefs, savePrefs, type Prefs } from '../lib/prefs';
import { SMOOTHING } from '../lib/oneEuro';
import { resolveInk, slideSurface, type Surface } from '../lib/contrast';
import { debugLog } from '../lib/debug';
import { Mark, Wordmark } from './Brand';
import { HelpDialog } from './HelpDialog';
import { TipsSheet } from './TipsSheet';
import { Hud, POINTER_LABEL, trackingChip } from './Hud';
import { SettingsPanel } from './SettingsPanel';
import { SlideCanvas } from './SlideCanvas';
import { MenuDwell, menuOptionAt, OPTION_TOOL, ToolMenu } from './ToolMenu';
import { Trainer } from './Trainer';

const STAGE_PAD = 20;
const HUD_HIDE_MS = 3000;
const PIP_W = 192;
const PIP_H = 144;
const GLIDE = [0.22, 1, 0.36, 1] as const;

interface CacheEntry {
  bitmap: ImageBitmap;
  aspect: number;
  key: string;
}

interface MenuState {
  open: boolean;
  hot: number | null;
  progress: number;
}
const MENU_CLOSED: MenuState = { open: false, hot: null, progress: 0 };

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const fmtZoom = (v: number) => `${v.toFixed(1)}×`;
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

/** Going forward, the old slide leaves to the left and the new one comes in from the right. */
const slideVariants = {
  enter: (dir: number) => ({ x: `${dir * 8}%`, opacity: 0 }),
  center: { x: '0%', opacity: 1 },
  exit: (dir: number) => ({ x: `${dir * -16}%`, opacity: 0 }),
};

interface PresenterProps {
  doc: PDFDocumentProxy;
  name: string;
  /** Slide to open on (resuming a deck), 1-based. */
  startPage?: number;
  /** Called when the slide changes, so the app can resume there next time. */
  onPage?: (page: number) => void;
  onExit: () => void;
}

export function Presenter({ doc, name, startPage = 1, onPage, onExit }: PresenterProps) {
  const total = doc.numPages;

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  const updatePrefs = useCallback((next: Prefs) => {
    prefsRef.current = next;
    setPrefs(next);
    savePrefs(next);
  }, []);
  const [engine] = useState(
    () => new GestureEngine({ smoothing: prefs.smoothing, reach: prefs.profile?.reach, handedness: prefs.profile?.handedness, pointerTool: prefs.pointerTool }),
  );

  const [page, setPage] = useState(() => Math.min(Math.max(startPage, 1), total));
  const pageRef = useRef(page);
  const [dir, setDir] = useState(1);
  const [board, setBoard] = useState(false);
  const boardRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [tracking, setTracking] = useState<TrackingState>('searching');
  const trackingRef = useRef<TrackingState>('searching');
  const [everTracked, setEverTracked] = useState(false);
  const [tool, setTool] = useState<Tool | null>(null);
  const toolRef = useRef<Tool | null>(null);
  const [pointerTool, setPointerTool] = useState<PointerTool>(prefs.pointerTool);
  const [menu, setMenu] = useState<MenuState>(MENU_CLOSED);
  const menuRef = useRef<MenuState>(MENU_CLOSED);
  const dwellRef = useRef(new MenuDwell());
  // The reminder sheet greets each presentation (unless turned off), closed by a thumbs up.
  const [panel, setPanel] = useState<'help' | 'settings' | 'tips' | null>(() => (prefs.showTips ? 'tips' : null));
  const [confirmProgress, setConfirmProgress] = useState(0);
  const confirmRef = useRef(0);
  const panelRef = useRef(panel);
  const [training, setTraining] = useState(false);
  const trainingRef = useRef(false);
  const [mouseLaser, setMouseLaser] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(() => !!document.fullscreenElement);
  const [toast, setToast] = useState<string | null>(null);

  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<OverlayRenderer | null>(null);
  const inkRef = useRef<InkLayer | null>(null);
  const controllerRef = useRef<GestureController | null>(null);
  const pipRef = useRef<HTMLCanvasElement>(null);
  const mouseDrawing = useRef(false);

  useEffect(() => {
    panelRef.current = panel;
  }, [panel]);

  useEffect(() => {
    document.title = `${name} · Air-Deck`;
    return () => {
      document.title = 'Air-Deck';
    };
  }, [name]);

  /* ---------- HUD auto-hide and toasts ---------- */
  const [hudVisible, setHudVisible] = useState(true);
  const hideTimer = useRef(0);
  const poke = useCallback(() => {
    setHudVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setHudVisible(false), HUD_HIDE_MS);
  }, []);
  useEffect(() => {
    poke();
    return () => window.clearTimeout(hideTimer.current);
  }, [poke]);

  const toastTimer = useRef(0);
  const showToast = useCallback((text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  /* ---------- viewport and page rendering ---------- */
  const [viewport, setViewport] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    let t = 0;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => setViewport({ w: window.innerWidth, h: window.innerHeight }), 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  const boxW = Math.max(viewport.w - STAGE_PAD * 2, 120);
  const boxH = Math.max(viewport.h - STAGE_PAD * 2, 90);
  const renderKey = `${boxW}x${boxH}`;
  const renderKeyRef = useRef(renderKey);
  useEffect(() => {
    renderKeyRef.current = renderKey;
  }, [renderKey]);

  const cacheRef = useRef(new Map<number, CacheEntry>());
  const inflightRef = useRef(new Map<string, Promise<void>>());
  const [, setCacheVersion] = useState(0);
  const [baseAspect, setBaseAspect] = useState(16 / 9);

  useEffect(() => {
    doc.getPage(1).then(p => {
      const v = p.getViewport({ scale: 1 });
      setBaseAspect(v.width / v.height);
    });
  }, [doc]);

  useEffect(() => {
    let cancelled = false;
    const cache = cacheRef.current;
    const inflight = inflightRef.current;
    const density = Math.min(window.devicePixelRatio || 1, 2) * 1.5;
    const wanted = [page, page + 1, page - 1, page + 2].filter(n => n >= 1 && n <= total);

    (async () => {
      for (const [i, n] of wanted.entries()) {
        // Neighbors wait for the slide transition, so rendering never competes with it.
        if (i === 1) await sleep(450);
        if (cancelled) return;
        if (cache.get(n)?.key === renderKey) continue;
        const id = `${n}@${renderKey}`;
        let job = inflight.get(id);
        if (!job) {
          job = renderPage(doc, n, boxW, boxH, density)
            .then(({ bitmap, aspect }) => {
              if (renderKeyRef.current !== renderKey) {
                bitmap.close();
                return;
              }
              const old = cache.get(n);
              cache.set(n, { bitmap, aspect, key: renderKey });
              old?.bitmap.close();
              setCacheVersion(v => v + 1);
            })
            .catch(() => {})
            .finally(() => inflight.delete(id));
          inflight.set(id, job);
        }
        await job;
      }
      for (const [n, entry] of cache) {
        if (Math.abs(n - pageRef.current) > 3) {
          entry.bitmap.close();
          cache.delete(n);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [doc, page, total, renderKey, boxW, boxH]);

  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      cache.forEach(entry => entry.bitmap.close());
      cache.clear();
    };
  }, []);

  const entry = page <= total ? cacheRef.current.get(page) : undefined;
  const aspect = entry?.aspect ?? baseAspect;
  const slideW = Math.min(boxW, boxH * aspect);
  const slideH = slideW / aspect;

  // Ink and laser in a color that stands out on this slide: amber on dark ones, vermilion on light ones.
  const surface = useMemo<Surface>(() => (board ? 'light' : page > total ? 'dark' : entry ? slideSurface(entry.bitmap) : 'light'), [board, page, total, entry]);
  const accent = resolveInk(prefs.inkColor, surface);
  const accentRef = useRef(accent);
  useEffect(() => {
    accentRef.current = accent;
    inkRef.current?.setColor(accent);
    overlayRef.current?.setAccent(accent);
    if (controllerRef.current) controllerRef.current.inkColor = accent;
  }, [accent]);
  const slideRef = useRef({ w: slideW, h: slideH });
  useEffect(() => {
    slideRef.current = { w: slideW, h: slideH };
  }, [slideW, slideH]);

  /* ---------- zoom ---------- */
  const zoomTarget = useMotionValue(1);
  const zoom = useSpring(zoomTarget, { stiffness: 220, damping: 28, mass: 0.9 });
  const originX = useMotionValue(window.innerWidth / 2);
  const originY = useMotionValue(window.innerHeight / 2);
  const transformOrigin = useMotionTemplate`${originX}px ${originY}px`;
  const [zoomText, setZoomText] = useState(fmtZoom(1));
  useMotionValueEvent(zoom, 'change', v => setZoomText(fmtZoom(v)));

  const setZoomLevel = useCallback(
    (level: number, origin?: { x: number; y: number }, fromGesture = false, follow = false) => {
      const clamped = clamp(level, GESTURE.zoomMin, GESTURE.zoomMax);
      // The lens follows the finger; otherwise moving the origin while zoomed would make the slide jump.
      if (origin && (follow || zoom.get() < 1.05)) {
        originX.set(origin.x);
        originY.set(origin.y);
      }
      zoomTarget.set(clamped);
      if (!fromGesture) engine.setZoom(clamped);
    },
    [engine, originX, originY, zoom, zoomTarget],
  );

  const space = useMemo<SlideSpace>(
    () => ({
      screen: () => ({ width: window.innerWidth, height: window.innerHeight }),
      toSlide: (x, y) => {
        const s = zoom.get();
        const ox = originX.get();
        const oy = originY.get();
        const { w, h } = slideRef.current;
        const px = ox + (x - ox) / s;
        const py = oy + (y - oy) / s;
        return { x: (px - (window.innerWidth - w) / 2) / w, y: (py - (window.innerHeight - h) / 2) / w };
      },
      pxPerUnit: () => slideRef.current.w * zoom.get(),
    }),
    [originX, originY, zoom],
  );

  /* ---------- navigation, board, menu ---------- */
  const goTo = useCallback(
    (target: number) => {
      const next = clamp(target, 1, total + 1);
      const current = pageRef.current;
      if (next === current) return false;
      setDir(next > current ? 1 : -1);
      pageRef.current = next;
      setPage(next);
      setZoomLevel(1);
      return true;
    },
    [total, setZoomLevel],
  );

  const setBoardOn = useCallback(
    (on: boolean) => {
      if (boardRef.current === on) return;
      boardRef.current = on;
      setBoard(on);
      setZoomLevel(1);
    },
    [setZoomLevel],
  );

  const syncMenu = useCallback((next: MenuState) => {
    const prev = menuRef.current;
    if (prev.open === next.open && prev.hot === next.hot && Math.abs(prev.progress - next.progress) < 0.04) return;
    menuRef.current = next;
    setMenu(next);
  }, []);

  const setMenuOpen = useCallback(
    (open: boolean) => {
      engine.setMenuOpen(open);
      dwellRef.current.reset();
      syncMenu({ open, hot: null, progress: 0 });
    },
    [engine, syncMenu],
  );

  const clearInk = useCallback(() => {
    const cleared = inkRef.current?.clearPage();
    showToast(cleared ? 'Ink cleared · three fingers up to undo' : 'Nothing to clear on this slide');
  }, [showToast]);

  const historyToast = useCallback((kind: 'undo' | 'redo', done: boolean) => {
    if (kind === 'undo') showToast(done ? 'Undone · four fingers to redo' : 'Nothing to undo on this slide');
    else showToast(done ? 'Redone' : 'Nothing to redo');
  }, [showToast]);

  const undoInk = useCallback(() => historyToast('undo', !!inkRef.current?.undo()), [historyToast]);
  const redoInk = useCallback(() => historyToast('redo', !!inkRef.current?.redo()), [historyToast]);

  const applyMenuOption = useCallback(
    (option: number) => {
      setMenuOpen(false);
      debugLog('menu-select', { option });
      const next = OPTION_TOOL[option];
      if (next) {
        setPointerTool(next);
        engine.setPointerTool(next);
        updatePrefs({ ...prefsRef.current, pointerTool: next });
        showToast(`1 finger is now ${POINTER_LABEL[next]}`);
      } else if (option === 4) {
        setBoardOn(!boardRef.current);
      } else if (option === 5) {
        clearInk();
      }
    },
    [clearInk, engine, setBoardOn, setMenuOpen, showToast, updatePrefs],
  );

  const turn = useCallback(
    (delta: 1 | -1) => {
      // A page turn first closes whatever is open; only a turn over the slides changes them.
      if (menuRef.current.open) setMenuOpen(false);
      else if (panelRef.current) setPanel(null);
      else if (boardRef.current) setBoardOn(false);
      else if (!goTo(pageRef.current + delta)) showToast(delta > 0 ? 'You’re already at the end' : 'This is the first slide');
    },
    [goTo, setBoardOn, setMenuOpen, showToast],
  );

  const actionsRef = useRef<ControllerActions>({});
  useEffect(() => {
    actionsRef.current = {
      next: () => turn(1),
      prev: () => turn(-1),
      zoom: (level, x, y, follow) => setZoomLevel(level, { x, y }, true, follow),
      resetZoom: () => setZoomLevel(1),
      menuOpen: () => {
        dwellRef.current.reset();
        syncMenu({ open: true, hot: null, progress: 0 });
        poke();
      },
      menuClose: () => {
        dwellRef.current.reset();
        syncMenu(MENU_CLOSED);
      },
      menuPointer: (x, y, t) => {
        const picked = dwellRef.current.update(menuOptionAt(x, y), t);
        if (picked) applyMenuOption(picked);
        else syncMenu({ open: true, hot: dwellRef.current.hot, progress: dwellRef.current.progress });
      },
      menuClick: () => {
        const option = dwellRef.current.hot;
        if (option) applyMenuOption(option);
      },
      clear: clearInk,
      history: historyToast,
      // Thumbs up: OK closes whatever is open.
      confirm: () => {
        if (menuRef.current.open) setMenuOpen(false);
        else if (panelRef.current) setPanel(null);
      },
    };
  }, [applyMenuOption, clearInk, historyToast, poke, setMenuOpen, setZoomLevel, syncMenu, turn]);

  useEffect(() => {
    engine.setConfirmAvailable(menu.open || panel !== null);
  }, [engine, menu.open, panel]);

  /* ---------- layers ---------- */
  useEffect(() => {
    const overlayCanvas = overlayCanvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!overlayCanvas || !inkCanvas) return;
    const overlay = new OverlayRenderer(overlayCanvas, SMOOTHING[prefsRef.current.smoothing].leadMs);
    overlay.setAccent(accentRef.current);
    const ink = new InkLayer(inkCanvas);
    ink.setColor(accentRef.current);
    ink.setPage(`p${pageRef.current}`);
    const controller = new GestureController(engine, overlay, ink, space, {
      next: () => actionsRef.current.next?.(),
      prev: () => actionsRef.current.prev?.(),
      zoom: (level, x, y, follow) => actionsRef.current.zoom?.(level, x, y, follow),
      resetZoom: () => actionsRef.current.resetZoom?.(),
      menuOpen: () => actionsRef.current.menuOpen?.(),
      menuClose: () => actionsRef.current.menuClose?.(),
      menuPointer: (x, y, t) => actionsRef.current.menuPointer?.(x, y, t),
      menuClick: () => actionsRef.current.menuClick?.(),
      clear: () => actionsRef.current.clear?.(),
      history: (kind, done) => actionsRef.current.history?.(kind, done),
      confirm: () => actionsRef.current.confirm?.(),
    });
    controller.inkColor = accentRef.current;
    overlayRef.current = overlay;
    inkRef.current = ink;
    controllerRef.current = controller;
    return () => {
      overlay.destroy();
      ink.destroy();
      overlayRef.current = null;
      inkRef.current = null;
      controllerRef.current = null;
    };
  }, [engine, space]);

  useEffect(() => {
    engine.setSmoothing(prefs.smoothing);
    engine.setReach(prefs.profile?.reach ?? DEFAULT_REACH);
    engine.setHandedness(prefs.profile?.handedness ?? null);
    overlayRef.current?.setLead(SMOOTHING[prefs.smoothing].leadMs);
  }, [engine, prefs]);

  useEffect(() => {
    inkRef.current?.setPage(board ? 'board' : page > total ? 'end' : `p${page}`);
  }, [board, page, total]);

  useEffect(() => {
    onPage?.(Math.min(page, total));
  }, [onPage, page, total]);

  useEffect(() => {
    trainingRef.current = training;
    if (training) {
      overlayRef.current?.pushCursor(null);
      setMenuOpen(false);
    }
  }, [training, setMenuOpen]);

  useEffect(() => {
    if (controllerRef.current) controllerRef.current.keepIdleCursor = mouseLaser;
    if (!mouseLaser) overlayRef.current?.pushCursor(null);
  }, [mouseLaser]);

  /* ---------- hand tracking ---------- */
  const onFrame = useCallback(
    (f: HandFrame) => {
      const controller = controllerRef.current;
      if (!controller || trainingRef.current) return;
      const { out } = controller.handle(f);
      if (out.tracking !== trackingRef.current) {
        trackingRef.current = out.tracking;
        setTracking(out.tracking);
        if (out.tracking === 'tracking') setEverTracked(true);
        if (out.tracking === 'lost') poke();
      }
      if (out.tool !== toolRef.current) {
        toolRef.current = out.tool;
        setTool(out.tool);
      }
      const ok = out.hold?.kind === 'confirm' ? out.hold.progress : 0;
      if (Math.abs(ok - confirmRef.current) > 0.04 || (ok === 0) !== (confirmRef.current === 0)) {
        confirmRef.current = ok;
        setConfirmProgress(ok);
      }
      if (!out.menuOpen && menuRef.current.open) {
        dwellRef.current.reset();
        syncMenu(MENU_CLOSED);
      }
      if (pipRef.current) drawPip(pipRef.current, f.video, f.hands, out.tool);
    },
    [poke, syncMenu],
  );

  const cameraStatus = useHandTracking(cameraOn, onFrame);

  useEffect(() => {
    if (cameraOn) return;
    trackingRef.current = 'searching';
    setTracking('searching');
    toolRef.current = null;
    setTool(null);
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.pushCursor(null);
      overlay.setNav(null);
      overlay.setHold(null);
      overlay.setZoomMarker(null);
    }
  }, [cameraOn]);

  useEffect(() => {
    if (!prefs.showCamera && pipRef.current) clearPip(pipRef.current);
  }, [prefs.showCamera]);

  /* ---------- fullscreen ---------- */
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => showToast('The browser didn’t allow fullscreen'));
  }, [showToast]);

  /* ---------- keyboard and presenter remotes ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || trainingRef.current) return;
      const target = e.target as HTMLElement | null;
      const inControl = !!target?.closest('input, button, .panel, .dialog');
      poke();

      if (e.key === 'Escape') {
        if (menuRef.current.open) setMenuOpen(false);
        else if (panelRef.current) setPanel(null);
        else if (!document.fullscreenElement) onExit();
        return;
      }
      if (menuRef.current.open && /^[1-5]$/.test(e.key)) {
        applyMenuOption(Number(e.key));
        return;
      }
      if (inControl && [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'Enter':
        case 'n':
          e.preventDefault();
          if (boardRef.current) setBoardOn(false);
          else if (!goTo(pageRef.current + 1)) showToast('You’re already at the end');
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
        case 'p':
          e.preventDefault();
          if (boardRef.current) setBoardOn(false);
          else if (!goTo(pageRef.current - 1)) showToast('This is the first slide');
          break;
        case 'Home':
          goTo(1);
          break;
        case 'End':
          goTo(total);
          break;
        case 'm':
        case 'M':
          setMenuOpen(!menuRef.current.open);
          break;
        case 'b':
        case 'B':
        case '.':
          setBoardOn(!boardRef.current);
          break;
        case 'e':
        case 'E':
          clearInk();
          break;
        case 'z':
          undoInk();
          break;
        case 'Z':
        case 'y':
        case 'Y':
          redoInk();
          break;
        case '+':
        case '=':
          setZoomLevel(zoomTarget.get() * 1.25, { x: window.innerWidth / 2, y: window.innerHeight / 2 });
          break;
        case '-':
        case '_':
          setZoomLevel(zoomTarget.get() / 1.25);
          break;
        case '0':
          setZoomLevel(1);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'c':
        case 'C':
          updatePrefs({ ...prefsRef.current, showCamera: !prefsRef.current.showCamera });
          break;
        case 'l':
        case 'L':
          setMouseLaser(v => !v);
          break;
        case 't':
        case 'T':
          setPanel(null);
          setTraining(true);
          break;
        case '?':
        case 'h':
        case 'H':
          setPanel(p => (p === 'help' ? null : 'help'));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [applyMenuOption, clearInk, goTo, onExit, poke, redoInk, setBoardOn, undoInk, setMenuOpen, setZoomLevel, showToast, toggleFullscreen, total, updatePrefs, zoomTarget]);

  /* ---------- mouse: laser, and drag to write ---------- */
  const onPointer = (e: ReactPointerEvent) => {
    poke();
    if (!mouseLaser || training || (e.target as HTMLElement).closest('.hud, .panel, .dialog, .pip, .trainer, .tool-menu')) return;
    const overlay = overlayRef.current;
    const ink = inkRef.current;
    if (!overlay || !ink) return;
    const drawing = (e.buttons & 1) === 1;
    overlay.pushCursor({ tool: drawing ? 'pen' : 'laser', x: e.clientX, y: e.clientY, vx: 0, vy: 0, t: performance.now(), color: accent });
    if (drawing) {
      const p = space.toSlide(e.clientX, e.clientY);
      if (mouseDrawing.current) ink.extendStroke(p);
      else {
        ink.beginStroke(p);
        mouseDrawing.current = true;
      }
    } else if (mouseDrawing.current) {
      ink.endStroke();
      mouseDrawing.current = false;
    }
  };

  /* ---------- hints ---------- */
  const chip = trackingChip(cameraOn, cameraStatus, tracking);
  let hint: { tone: 'search' | 'lost' | 'ok'; text: string } | null = null;
  if (cameraOn && !training) {
    if (cameraStatus === 'starting') hint = { tone: 'search', text: 'Starting the camera and hand tracking' };
    else if (cameraStatus === 'denied' && hudVisible) hint = { tone: 'lost', text: 'Camera blocked. Allow access in the browser, or use the arrow keys.' };
    else if (cameraStatus === 'unavailable' && hudVisible) hint = { tone: 'lost', text: 'No camera found. Use the arrow keys.' };
    else if (cameraStatus === 'error' && hudVisible) hint = { tone: 'lost', text: 'Tracking didn’t start. Use the arrow keys.' };
    else if (cameraStatus === 'ready' && !everTracked) hint = { tone: 'search', text: 'Raise your index finger to begin' };
  }

  const chromeVisible = hudVisible || panel !== null || menu.open;
  const showPip = cameraOn && prefs.showCamera && cameraStatus === 'ready' && !training;
  const pipDpr = Math.min(window.devicePixelRatio || 1, 2);

  return (
    <div
      className={`presenter${chromeVisible ? '' : ' is-idle'}${mouseLaser ? ' is-laser' : ''}`}
      onPointerMove={onPointer}
      onPointerDown={onPointer}
      onPointerUp={onPointer}
      onPointerLeave={() => mouseLaser && overlayRef.current?.pushCursor(null)}
    >
      <motion.div className="zoom-layer" style={{ scale: zoom, transformOrigin }}>
        <AnimatePresence initial={false} custom={dir}>
          <motion.div
            key={board ? 'board' : page}
            className="slide-frame"
            custom={dir}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.42, ease: GLIDE }}
            style={{ width: slideW, height: slideH }}
          >
            {board ? (
              <div className="board">
                <span className="board-mark">
                  <Mark size={18} />
                  <Wordmark />
                </span>
              </div>
            ) : page > total ? (
              <div className="end-card">
                <Mark size={44} />
                <h2>End of presentation</h2>
                <p>{name}</p>
                <span className="mono">Two fingers pointing left or ← to go back · Esc to exit</span>
              </div>
            ) : entry ? (
              <SlideCanvas bitmap={entry.bitmap} width={slideW} height={slideH} className="slide" />
            ) : (
              <div className="slide-loading" role="status" aria-label="Loading slide" />
            )}
          </motion.div>
        </AnimatePresence>
        <canvas ref={inkCanvasRef} className="ink" style={{ width: slideW, height: slideH }} aria-hidden="true" />
      </motion.div>

      <Hud
        visible={chromeVisible}
        chip={chip}
        page={page}
        total={total}
        zoomText={zoomText}
        tool={tool ?? (mouseLaser ? 'laser' : null)}
        pointerTool={pointerTool}
        board={board}
        cameraOn={cameraOn}
        isFullscreen={isFullscreen}
        panel={panel}
        onMenu={() => setMenuOpen(!menuRef.current.open)}
        onHelp={() => setPanel(p => (p === 'help' ? null : 'help'))}
        onTrain={() => {
          setPanel(null);
          setTraining(true);
        }}
        onSettings={() => setPanel(p => (p === 'settings' ? null : 'settings'))}
        onCamera={() => setCameraOn(v => !v)}
        onFullscreen={toggleFullscreen}
        onExit={onExit}
      />

      <ToolMenu
        open={menu.open}
        hot={menu.hot}
        progress={menu.progress}
        pointerTool={pointerTool}
        board={board}
        onSelect={applyMenuOption}
        onClose={() => setMenuOpen(false)}
      />

      {panel === 'settings' && (
        <SettingsPanel
          prefs={prefs}
          onPrefs={updatePrefs}
          cameraOn={cameraOn}
          onCameraOn={setCameraOn}
          mouseLaser={mouseLaser}
          onMouseLaser={setMouseLaser}
          onTrain={() => {
            setPanel(null);
            setTraining(true);
          }}
        />
      )}
      {panel === 'tips' && (
        <TipsSheet
          progress={confirmProgress}
          showAtStart={prefs.showTips}
          onShowAtStart={show => updatePrefs({ ...prefsRef.current, showTips: show })}
          onClose={() => setPanel(null)}
          onHelp={() => setPanel('help')}
        />
      )}
      {panel === 'help' && (
        <HelpDialog
          onClose={() => setPanel(null)}
          onTrain={() => {
            setPanel(null);
            setTraining(true);
          }}
        />
      )}

      {/* Above the menu, so the hand pointer shows on top of the options. */}
      <canvas ref={overlayCanvasRef} className="overlay overlay-top" aria-hidden="true" />

      <div className={`rail${chromeVisible ? '' : ' is-hidden'}`} aria-hidden="true">
        <div style={{ transform: `scaleX(${Math.min(page, total) / total})` }} />
      </div>

      {showPip && (
        <canvas
          ref={pipRef}
          className={`pip${chromeVisible ? '' : ' is-dim'}`}
          width={PIP_W * pipDpr}
          height={PIP_H * pipDpr}
          aria-label="Camera preview with hand landmarks"
        />
      )}

      <div className="toasts" aria-live="polite">
        {hint && (
          <div className="toast toast-hint" data-tone={hint.tone}>
            <i />
            {hint.text}
          </div>
        )}
        {toast && <div className="toast toast-hint">{toast}</div>}
      </div>

      {training && (
        <Trainer
          prefs={prefs}
          onPrefs={updatePrefs}
          startStep={prefs.profile ? 'practice' : 'hand'}
          onClose={() => setTraining(false)}
          doneLabel="Back to the presentation"
          skipLabel="Close"
        />
      )}
    </div>
  );
}
