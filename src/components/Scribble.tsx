import type { CSSProperties } from 'react';

export type ScribbleKind = 'ellipse' | 'underline' | 'box' | 'arrow' | 'check';

const f = (n: number) => n.toFixed(1);

/** A loop drawn by hand: a little more than one turn, never quite round, drifting as it closes. */
function loop() {
  const steps = 72;
  const start = -2.5;
  const sweep = Math.PI * 2 * 1.1;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const a = start + sweep * k;
    const rx = 95 * (1 + 0.035 * Math.sin(3 * a + 0.7)) - k * 3;
    const ry = 43 * (1 + 0.06 * Math.sin(2 * a + 0.3)) + k * 2;
    d += `${i ? 'L' : 'M'}${f(100 + rx * Math.cos(a) + k * 4)} ${f(51 + ry * Math.sin(a) - k * 3)}`;
  }
  return d;
}

/** Shapes that stretch to their box use `none`; arrows and ticks keep their proportions. */
const SHAPES: Record<ScribbleKind, { view: string; fit: string; paths: string[]; stagger: number }> = {
  ellipse: { view: '0 0 200 100', fit: 'none', paths: [loop()], stagger: 0 },
  underline: { view: '0 0 200 24', fit: 'none', paths: ['M3 14C48 8 118 17 197 9', 'M24 19C78 15 132 20 178 16'], stagger: 360 },
  box: { view: '0 0 200 100', fit: 'none', paths: ['M5 9C70 5 140 7 196 5', 'M194 3C196 36 193 70 195 96', 'M197 93C130 96 66 94 4 96', 'M7 98C4 66 6 34 4 6'], stagger: 150 },
  arrow: { view: '0 0 120 90', fit: 'xMidYMid meet', paths: ['M8 8C40 2 92 18 104 70', 'M86 60L105 74L113 52'], stagger: 520 },
  check: { view: '0 0 40 40', fit: 'xMidYMid meet', paths: ['M6 22L16 32L35 6'], stagger: 0 },
};

/**
 * The app's own annotations, used on its own interface: a word circled, a line underlined, an
 * arrow pointing at what matters. Drawn in on mount, like the pen does on a slide.
 */
export function Scribble({ kind, delay = 0, className = '', style }: { kind: ScribbleKind; delay?: number; className?: string; style?: CSSProperties }) {
  const { view, fit, paths, stagger } = SHAPES[kind];
  return (
    <svg className={`scribble scribble-${kind} ${className}`} viewBox={view} preserveAspectRatio={fit} aria-hidden="true" style={style}>
      {paths.map((d, i) => (
        <path key={i} d={d} pathLength={1} vectorEffect="non-scaling-stroke" style={{ animationDelay: `${delay + i * stagger}ms` }} />
      ))}
    </svg>
  );
}
