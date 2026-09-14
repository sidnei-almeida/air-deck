import type { PointerTool, ReachBox } from './gestures';
import type { SmoothingPreset } from './oneEuro';

/** What the trainer learns about the presenter's hand. */
export interface HandProfile {
  handedness: string | null;
  /** Median fingertip jitter per frame, in palm lengths. */
  jitter: number | null;
  reach: ReachBox;
  createdAt: string;
}

export interface Prefs {
  smoothing: SmoothingPreset;
  showCamera: boolean;
  inkColor: string;
  /** What one raised finger does, as last picked in the menu. */
  pointerTool: PointerTool;
  /** Went through (or skipped) the first-run trainer once: never forced on them again. */
  onboarded: boolean;
  /** Show the gesture reminder sheet when a presentation opens. */
  showTips: boolean;
  profile: HandProfile | null;
}

export const INK_COLORS = [
  { value: 'auto', label: 'Auto: contrasts with each slide' },
  { value: '#FFB020', label: 'Amber' },
  { value: '#E5484D', label: 'Red' },
  { value: '#2F7CF6', label: 'Blue' },
  { value: '#1F9D6B', label: 'Green' },
  { value: '#14161C', label: 'Graphite' },
] as const;

const KEY = 'airdeck:prefs:v1';
const PRACTICE_KEY = 'airdeck:practice:v1';
const DEFAULTS: Prefs = { smoothing: 'balanced', showCamera: true, inkColor: INK_COLORS[0].value, pointerTool: 'laser', onboarded: false, showTips: true, profile: null };
const SMOOTHINGS: SmoothingPreset[] = ['responsive', 'balanced', 'stable'];
const POINTER_TOOLS: PointerTool[] = ['laser', 'lens', 'eraser'];

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A stored profile from an older version or a broken write is dropped instead of breaking the pointer. */
function validProfile(value: unknown): HandProfile | null {
  const p = value as Partial<HandProfile> | null;
  const r = p?.reach;
  if (!r || ![r.x0, r.x1, r.y0, r.y1].every(finite) || r.x1 - r.x0 < 0.05 || r.y1 - r.y0 < 0.05) return null;
  return { handedness: p.handedness ?? null, jitter: finite(p.jitter) ? p.jitter : null, reach: r, createdAt: p.createdAt ?? new Date().toISOString() };
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<Prefs>;
    const prefs: Prefs = { ...DEFAULTS, ...saved, profile: validProfile(saved.profile) };
    if (!SMOOTHINGS.includes(prefs.smoothing)) prefs.smoothing = DEFAULTS.smoothing;
    if (!POINTER_TOOLS.includes(prefs.pointerTool)) prefs.pointerTool = DEFAULTS.pointerTool;
    // The old default amber vanished on white slides; those saves move to the contrasting color.
    if (prefs.inkColor === '#FFB23E') prefs.inkColor = 'auto';
    // Anyone with a saved hand has been through onboarding (older saves had no flag).
    if (prefs.profile) prefs.onboarded = true;
    return prefs;
  } catch {
    return DEFAULTS;
  }
}

export function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: preferences just don't persist.
  }
}

/** Trainer progress: how many times each challenge was done. */
export function loadPractice(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(PRACTICE_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => finite(entry[1])));
  } catch {
    return {};
  }
}

export function savePractice(counts: Record<string, number>) {
  try {
    localStorage.setItem(PRACTICE_KEY, JSON.stringify(counts));
  } catch {
    // Progress just isn't remembered.
  }
}

/** Forgets what this browser keeps in local storage: preferences, hand profile and practice. */
export function clearPrefs() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(PRACTICE_KEY);
  } catch {
    // Nothing stored.
  }
}
