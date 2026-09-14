/**
 * Gesture glyphs in the Hand Landmarker style: dots and bones, never drawn hands.
 * Ported from brand/brand-kit.html. Output is static SVG markup.
 */
type Pt = [number, number];
type Finger = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';
type FingerPose = 'open' | 'shut' | Pt;
type HandPose = Record<Finger, FingerPose>;

const FINGERS: Finger[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const BASE: Record<Finger | 'wrist', Pt> = { wrist: [32, 54], thumb: [24, 46], index: [26, 33], middle: [31.5, 31], ring: [37, 32.5], pinky: [42, 36] };
const OPEN: Record<Finger, Pt> = { thumb: [11, 35], index: [20, 11], middle: [32, 7], ring: [43.5, 10], pinky: [53, 20] };
const SHUT: Record<Finger, Pt> = { thumb: [31, 41], index: [27, 26.5], middle: [32, 24.5], ring: [37.5, 26], pinky: [43.5, 30.5] };

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const all = (p: FingerPose) => Object.fromEntries(FINGERS.map(f => [f, p])) as HandPose;

function hand(pose: HandPose, { x = 0, y = 0, s = 1, hi = [] as Finger[] } = {}) {
  const line = (a: Pt, b: Pt) => `<line class="g-bone" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`;
  const dot = (p: Pt, rad: number, c = 'g-joint') => `<circle class="${c}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${rad}"/>`;
  let bones = line(BASE.wrist, BASE.thumb) + line(BASE.wrist, BASE.index) + line(BASE.wrist, BASE.pinky)
    + line(BASE.index, BASE.middle) + line(BASE.middle, BASE.ring) + line(BASE.ring, BASE.pinky);
  let dots = dot(BASE.wrist, 1.9);
  let tips = '';
  for (const f of FINGERS) {
    const p = pose[f];
    const b = BASE[f];
    const tip = Array.isArray(p) ? p : p === 'open' ? OPEN[f] : SHUT[f];
    bones += line(b, tip);
    dots += dot(b, 1.5) + dot(lerp(b, tip, 0.45), 1.25) + dot(lerp(b, tip, 0.74), 1.25);
    if (hi.includes(f)) tips += dot(tip, 5.5, 'g-halo') + dot(tip, 2.4, 'g-hot');
    else dots += dot(tip, 1.9);
  }
  return `<g transform="translate(${x} ${y}) scale(${s})">${bones}${dots}${tips}</g>`;
}

const arrow = (x1: number, x2: number, y = 32) => `<path class="g-arrow" d="M${x1} ${y}H${x2}m-5 -5 5 5 -5 5"/>`;

function wobblyEllipse(cx: number, cy: number, rx: number, ry: number) {
  let d = '';
  for (let i = 0; i <= 48; i++) {
    const th = -2.6 + (i / 48) * Math.PI * 2.05;
    const k = 1 + 0.06 * Math.sin(3 * th + 0.8);
    d += (i ? 'L' : 'M') + (cx + rx * k * Math.cos(th)).toFixed(1) + ' ' + (cy + ry * k * Math.sin(th)).toFixed(1);
  }
  return d;
}

const point: HandPose = { ...all('shut'), index: 'open' };
const pinch: HandPose = { ...all('shut'), thumb: [22.5, 20], index: [21.5, 18.5] };
/** Thumb meets one fingertip; the other fingers stay open. */
const pinchWith = (finger: Finger, at: Pt): HandPose => ({ ...all('open'), thumb: [at[0] - 1, at[1] + 1.5], [finger]: at });
const thumbsDown: HandPose = { ...all('shut'), thumb: [26, 62] };
const twoSide: HandPose = { ...all('shut'), index: [58, 27], middle: [60, 34] };
const threeUp: HandPose = { ...all('shut'), index: 'open', middle: 'open', ring: 'open' };
const fourUp: HandPose = { ...all('open'), thumb: 'shut' };

export interface GestureGuide {
  id: string;
  name: string;
  how: string;
  detail: string;
  svg: string;
}

export const GESTURE_GUIDE: GestureGuide[] = [
  {
    id: 'laser',
    name: 'Laser',
    how: 'Raise just your index finger.',
    detail: 'from the menu, that finger can also be a zoom lens or an eraser',
    svg: hand(point, { x: 6, y: 1, hi: ['index'] })
      + '<path class="g-dash" d="M34 14 C 70 6, 110 10, 150 28"/><circle class="g-halo" cx="150" cy="28" r="7"/><circle class="g-hot" cx="150" cy="28" r="2.6"/>',
  },
  {
    id: 'pen',
    name: 'Pen',
    how: 'Thumb + index: write. A straight stroke becomes a clean line.',
    detail: 'underline and let go: the line straightens itself',
    svg: hand(pinch, { x: 2, y: 2, hi: ['index'] })
      + '<path class="g-acc" d="M78 34c6-16 12-18 15-8s6 12 12 0 9-14 13-4 6 10 12 1 8-8 14 0"/><path class="g-acc" d="M76 52H160"/>',
  },
  {
    id: 'rect',
    name: 'Rectangle',
    how: 'Thumb + middle: aim at a corner, hold until the ring closes, then drag.',
    detail: 'the cursor stays on your index, like the laser · or draw around it · adjust the handles with an index pinch',
    svg: hand(pinchWith('middle', [30, 20]), { x: 2, y: 2, hi: ['middle'] })
      + '<path class="g-dash" d="M84 14L154 50"/><rect class="g-acc" x="84" y="14" width="70" height="36" rx="1.5"/><circle class="g-hot" cx="84" cy="14" r="2.6"/>',
  },
  {
    id: 'ellipse',
    name: 'Circle',
    how: 'Thumb + ring: aim at a corner, hold until the ring closes, then drag to the opposite corner.',
    detail: 'or, after the ring, draw around it · it doesn’t have to be round: it fits the word',
    svg: hand(pinchWith('ring', [37, 21]), { x: 2, y: 2, hi: ['ring'] })
      + `<path class="g-dash" d="${wobblyEllipse(122, 32, 34, 16)}"/><ellipse class="g-acc" cx="122" cy="32" rx="38" ry="19"/>`,
  },
  {
    id: 'arrow',
    name: 'Arrow',
    how: 'Thumb + pinky: aim where the arrow starts, hold until the ring closes, drag to the tip.',
    detail: 'to point at a detail on the slide',
    svg: hand(pinchWith('pinky', [42, 26]), { x: 2, y: 2, hi: ['pinky'] })
      + '<path class="g-acc" d="M82 52L150 16m-13 1 13-1-4 12"/><rect class="g-track" x="146" y="6" width="22" height="16" rx="3"/>',
  },
  {
    id: 'nav',
    name: 'Change slide',
    how: 'Index and middle pointing sideways. Right goes forward, left goes back.',
    detail: 'one slide at a time · relax your hand before the next · closes the menu when it’s open',
    svg: hand(twoSide, { x: 18, hi: ['index', 'middle'] }) + arrow(100, 156),
  },
  {
    id: 'menu',
    name: 'Menu',
    how: 'Hold an open palm still to open it. Point at an option and hold.',
    detail: 'or pinch over the option',
    svg: hand(all('open'), { x: 0 })
      + '<rect class="g-track" x="84" y="8" width="80" height="48" rx="6"/><path class="g-arrow" d="M96 22h44M96 32h56M96 42h36"/><circle class="g-halo" cx="146" cy="32" r="6"/><circle class="g-hot" cx="146" cy="32" r="2.4"/>',
  },
  {
    id: 'clear',
    name: 'Clear',
    how: 'Thumbs down, held still until the ring closes.',
    detail: 'wipes the ink on this slide · three fingers undo it',
    svg: hand(thumbsDown, { x: 20, y: -4, hi: ['thumb'] })
      + '<circle class="g-track" cx="128" cy="32" r="16"/><path class="g-acc" d="M128 16a16 16 0 1 1-15.2 21"/>'
      + '<path class="g-arrow" d="M122 26l12 12m0-12-12 12"/>',
  },
  {
    id: 'history',
    name: 'Undo',
    how: 'Three fingers up, held still, undo. Four with the thumb folded redo.',
    detail: 'works for strokes, shapes, eraser and clearing · Z and Y on the keyboard',
    svg: hand(threeUp, { x: -4, hi: ['index', 'middle', 'ring'] })
      + '<path class="g-acc" d="M84 24H72a9 9 0 0 0 0 18h8M72 24l5-5m-5 5 5 5"/>'
      + hand(fourUp, { x: 84, hi: ['index', 'middle', 'ring', 'pinky'] })
      + '<path class="g-acc" d="M152 24h12a9 9 0 0 1 0 18h-8M164 24l-5-5m5 5-5 5"/>',
  },
  {
    id: 'zoom',
    name: 'Zoom',
    how: 'Make a fist and raise it. Or pinch with your other hand.',
    detail: 'aims at the laser · two open hands go back to 1×',
    svg: hand(all('shut'), { x: 26 })
      + '<line class="g-track" x1="136" y1="8" x2="136" y2="58"/><path class="g-acc" d="M136 58V22"/>'
      + '<path class="g-arrow" d="M112 30V14m-5 5 5-5 5 5"/><circle class="g-hot" cx="136" cy="22" r="3.2"/>'
      + '<text class="g-txt" x="146" y="12">3×</text><text class="g-txt" x="146" y="60">1×</text>',
  },
];

export const SHORTCUTS: [string[], string][] = [
  [['→', 'Space'], 'Next slide'],
  [['←'], 'Previous slide'],
  [['M'], 'Tool menu'],
  [['1', '5'], 'Pick from the menu'],
  [['B'], 'Whiteboard'],
  [['E'], 'Clear slide ink'],
  [['Z'], 'Undo'],
  [['Y'], 'Redo'],
  [['+', '−'], 'Zoom'],
  [['0'], 'Reset zoom'],
  [['L'], 'Mouse laser and pen'],
  [['C'], 'Show camera'],
  [['T'], 'Practice gestures'],
  [['F'], 'Fullscreen'],
  [['?'], 'Help'],
  [['Esc'], 'Exit'],
];
