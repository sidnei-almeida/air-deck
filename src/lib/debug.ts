/**
 * Dev-only diagnostics. Events and per-second stats are batched to the Vite dev server,
 * which appends them to debug/session.jsonl. Does nothing in production builds.
 */
const enabled = import.meta.env.DEV && typeof window !== 'undefined';

interface Stat {
  n: number;
  sum: number;
  min: number;
  max: number;
}

let queue: string[] = [];
let stats = new Map<string, Stat>();
let lastStats = 0;
let timer = 0;

function schedule() {
  if (!timer) timer = window.setTimeout(flush, 500);
}

function flush() {
  timer = 0;
  const now = performance.now();
  if (stats.size && now - lastStats >= 1000) {
    const summary: Record<string, unknown> = { type: 'stats', t: Math.round(now) };
    for (const [key, s] of stats) {
      summary[key] = { n: s.n, avg: round(s.sum / s.n), min: round(s.min), max: round(s.max) };
    }
    queue.push(JSON.stringify(summary));
    stats = new Map();
    lastStats = now;
  }
  if (stats.size) schedule();
  if (!queue.length) return;
  const body = queue.join('\n');
  queue = [];
  fetch('/__airdeck/log', { method: 'POST', body, keepalive: true }).catch(() => {});
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function debugLog(type: string, data: Record<string, unknown> = {}) {
  if (!enabled) return;
  queue.push(JSON.stringify({ type, t: Math.round(performance.now()), ...data }));
  schedule();
}

export function debugStat(key: string, value: number) {
  if (!enabled || !Number.isFinite(value)) return;
  const s = stats.get(key);
  if (s) {
    s.n++;
    s.sum += value;
    s.min = Math.min(s.min, value);
    s.max = Math.max(s.max, value);
  } else {
    stats.set(key, { n: 1, sum: value, min: value, max: value });
  }
  schedule();
}
