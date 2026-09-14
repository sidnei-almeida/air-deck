import type { Landmark, ReachBox, Tool } from './gestures';

const FINGER_CHAINS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const PALM = [0, 1, 5, 9, 13, 17];
const TIPS = [4, 8, 12, 16, 20];

/** Points that light up in Holofote for each tool. */
const ACTIVE_TIPS: Partial<Record<Tool, number[]>> = { laser: [8], lens: [8], eraser: [8], menu: [8], clear: [4] };
/** Fingertip touching the thumb for each pinch tool. */
const PINCH_TIP: Partial<Record<Tool, number>> = { pen: 8, rect: 12, ellipse: 16, arrow: 20 };

function cover(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const w = canvas.width;
  const h = canvas.height;
  const scale = Math.max(w / video.videoWidth, h / video.videoHeight);
  const vw = video.videoWidth * scale;
  const vh = video.videoHeight * scale;
  return { w, h, vw, vh, ox: (w - vw) / 2, oy: (h - vh) / 2 };
}

/**
 * Camera thumbnail with the hand drawn in the Air-Deck style: a faint palm, thin
 * finger lines in Rastro, and the fingertips of the active tool in Holofote.
 */
export function drawPip(canvas: HTMLCanvasElement, video: HTMLVideoElement, hands: Landmark[][], tool: Tool | null, brightness = 0.5) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !video.videoWidth) return;
  const { w, h, vw, vh, ox, oy } = cover(canvas, video);
  const unit = w / 320;

  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.filter = `grayscale(0.75) brightness(${brightness})`;
  ctx.drawImage(video, ox, oy, vw, vh);
  ctx.filter = 'none';
  ctx.fillStyle = 'rgba(11,13,19,.18)';
  ctx.fillRect(0, 0, w, h);

  hands.forEach((lm, i) => {
    const pts = lm.map(p => ({ x: ox + p.x * vw, y: oy + p.y * vh }));
    const primary = i === 0;
    const alpha = primary ? 1 : 0.45;

    ctx.beginPath();
    PALM.forEach((id, k) => (k ? ctx.lineTo(pts[id].x, pts[id].y) : ctx.moveTo(pts[id].x, pts[id].y)));
    ctx.closePath();
    ctx.fillStyle = `rgba(251,248,242,${0.1 * alpha})`;
    ctx.fill();
    ctx.lineWidth = 0.8 * unit;
    ctx.strokeStyle = `rgba(251,248,242,${0.3 * alpha})`;
    ctx.stroke();

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.5 * unit;
    ctx.strokeStyle = `rgba(251,248,242,${0.78 * alpha})`;
    for (const chain of FINGER_CHAINS) {
      ctx.beginPath();
      ctx.moveTo(pts[chain[0]].x, pts[chain[0]].y);
      for (let k = 1; k < chain.length - 1; k++) {
        const a = pts[chain[k]];
        const b = pts[chain[k + 1]];
        ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
      }
      const end = pts[chain[chain.length - 1]];
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }

    ctx.fillStyle = `rgba(238,240,246,${0.9 * alpha})`;
    for (const id of TIPS) {
      ctx.beginPath();
      ctx.arc(pts[id].x, pts[id].y, 1.9 * unit, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!primary || !tool) return;
    const glow = (x: number, y: number) => {
      ctx.fillStyle = 'rgba(255,178,62,.25)';
      ctx.beginPath();
      ctx.arc(x, y, 6 * unit, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFB23E';
      ctx.beginPath();
      ctx.arc(x, y, 2.6 * unit, 0, Math.PI * 2);
      ctx.fill();
    };
    const pinchTip = PINCH_TIP[tool];
    if (pinchTip !== undefined) glow((pts[4].x + pts[pinchTip].x) / 2, (pts[4].y + pts[pinchTip].y) / 2);
    else if (tool === 'zoom') {
      const c = PALM.reduce((s, id) => ({ x: s.x + pts[id].x / PALM.length, y: s.y + pts[id].y / PALM.length }), { x: 0, y: 0 });
      ctx.strokeStyle = '#FFB23E';
      ctx.lineWidth = 1.4 * unit;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 9 * unit, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      for (const id of ACTIVE_TIPS[tool] ?? []) glow(pts[id].x, pts[id].y);
    }
  });
  ctx.restore();
}

/** Trainer overlay: where the fingertip has been, and the resulting reach box. Coordinates are mirrored (u = 1 − x). */
export function drawReach(canvas: HTMLCanvasElement, video: HTMLVideoElement, samples: { u: number; y: number }[], box: ReachBox | null) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !video.videoWidth) return;
  const { vw, vh, ox, oy } = cover(canvas, video);
  const unit = canvas.width / 320;
  ctx.save();
  ctx.fillStyle = 'rgba(251,248,242,.4)';
  for (const s of samples.slice(-500)) {
    ctx.beginPath();
    ctx.arc(ox + s.u * vw, oy + s.y * vh, 1.4 * unit, 0, Math.PI * 2);
    ctx.fill();
  }
  if (box) {
    const x = ox + box.x0 * vw;
    const y = oy + box.y0 * vh;
    const bw = (box.x1 - box.x0) * vw;
    const bh = (box.y1 - box.y0) * vh;
    ctx.fillStyle = 'rgba(255,178,62,.07)';
    ctx.fillRect(x, y, bw, bh);
    ctx.setLineDash([5 * unit, 4 * unit]);
    ctx.lineWidth = 1.5 * unit;
    ctx.strokeStyle = '#FFB23E';
    ctx.strokeRect(x, y, bw, bh);
  }
  ctx.restore();
}

export function clearPip(canvas: HTMLCanvasElement) {
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
}
