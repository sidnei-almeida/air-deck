export interface CursorSample {
  tool: 'laser' | 'lens' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'eraser';
  x: number;
  y: number;
  /** px per second */
  vx: number;
  vy: number;
  /** capture time, performance.now() clock */
  t: number;
  radius?: number;
  color?: string;
  /** Shape tools: how far the aim hold has gone (0–1). Absent once the shape is being drawn. */
  progress?: number;
}

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

const TRAIL_MS = 90;
const MAX_LEAD_MS = 56;
const FOLLOW_MS = 4;
/** Extra glide time for the laser while the hand rests (px/s below ~90): smooths tremor without lag when moving. */
const REST_FOLLOW_MS = 60;
const NAV_FLASH_MS = 420;
const ACCENT = '#FFB23E';
const HALO = '#EEF0F6';
const SHADOW = 'rgba(11,13,19,.55)';

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * Screen-space layer: cursors (laser, lens, pen, eraser), swipe hints, zoom marker, hold ring.
 * Renders at display refresh. Camera samples arrive at 30–60 Hz, so the laser is
 * extrapolated by its velocity and eased between samples: continuous motion, no steps.
 */
export class OverlayRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private observer: ResizeObserver;
  private w = 0;
  private h = 0;
  private raf = 0;
  private lastFrame = 0;
  private leadMs: number;
  private accent = { r: 255, g: 178, b: 62, hex: ACCENT };

  private sample: CursorSample | null = null;
  private tool: CursorSample['tool'] = 'laser';
  private display: { x: number; y: number } | null = null;
  private visibility = 0;
  private trail: TrailPoint[] = [];

  private nav: { lean: number } | null = null;
  private navAlpha = 0;
  private navLean = { left: 0, right: 0 };
  private navFlash: { dir: 'left' | 'right'; t: number } | null = null;
  private zoomMarker: { x: number; y: number; level: number } | null = null;
  private hold: { progress: number; label: string } | null = null;

  constructor(canvas: HTMLCanvasElement, leadMs = 10) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.leadMs = leadMs;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }

  setLead(ms: number) {
    this.leadMs = ms;
  }

  /** Laser color, picked to stand out on the current slide. */
  setAccent(hex: string) {
    const n = parseInt(hex.slice(1), 16);
    if (hex.length === 7 && Number.isFinite(n)) this.accent = { r: n >> 16, g: (n >> 8) & 255, b: n & 255, hex };
  }

  pushCursor(sample: CursorSample | null) {
    if (sample && sample.tool !== this.tool) {
      this.tool = sample.tool;
      this.trail = [];
    }
    this.sample = sample;
  }

  setNav(nav: { lean: number } | null) {
    this.nav = nav;
  }

  /** Flashes the chevron on the side the hand moved toward. */
  flashNav(dir: 'left' | 'right') {
    this.navFlash = { dir, t: performance.now() };
  }

  setZoomMarker(marker: { x: number; y: number; level: number } | null) {
    this.zoomMarker = marker;
  }

  setHold(hold: { progress: number; label: string } | null) {
    this.hold = hold;
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(this.w * dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(now - this.lastFrame, 50) : 16;
    this.lastFrame = now;
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    const unit = clamp(Math.min(w, h) / 900, 0.7, 1.5);

    this.updateCursor(now, dt);
    this.drawNav(now, dt, unit);
    if (this.zoomMarker) this.drawZoomMarker(unit);
    if (this.hold) this.drawHold(unit);
    if (this.visibility > 0.01 && this.display) {
      if (this.tool === 'laser') this.drawLaser(unit);
      else if (this.tool === 'lens') this.drawLens(unit);
      else if (this.tool === 'pen') this.drawPen(unit);
      else if (this.tool === 'eraser') this.drawEraser(unit);
      else this.drawShapeTool(unit, this.tool);
    }
  };

  private updateCursor(now: number, dt: number) {
    const s = this.sample;
    if (s) {
      // Only the laser is extrapolated; the other tools must sit exactly where they act.
      // Laser and lens are extrapolated to hide camera latency; pen and eraser must sit exactly where they act.
      const pointer = s.tool === 'laser' || s.tool === 'lens';
      const speed = Math.hypot(s.vx, s.vy);
      // A resting hand only trembles: extrapolating that tremor makes the laser shake, so the lead fades
      // out and the glide slows down at rest. Moving, both come back and the dot keeps up with the hand.
      const moving = clamp((speed - 90) / 700, 0, 1);
      const lead = pointer ? (Math.min(clamp(now - s.t, 0, 48) + this.leadMs, MAX_LEAD_MS) / 1000) * moving : 0;
      const follow = pointer ? FOLLOW_MS + (1 - moving) * REST_FOLLOW_MS : FOLLOW_MS;
      const k = speed > 4000 ? 4000 / speed : 1;
      const tx = s.x + s.vx * k * lead;
      const ty = s.y + s.vy * k * lead;
      if (!this.display || this.visibility === 0) {
        this.display = { x: tx, y: ty };
        this.trail = [];
      } else {
        const a = 1 - Math.exp(-dt / follow);
        this.display.x += (tx - this.display.x) * a;
        this.display.y += (ty - this.display.y) * a;
      }
      this.visibility = Math.min(1, this.visibility + dt / 70);
      if (s.tool === 'laser') this.trail.push({ x: this.display.x, y: this.display.y, t: now });
    } else {
      this.visibility = Math.max(0, this.visibility - dt / 120);
    }
    while (this.trail.length && now - this.trail[0].t > TRAIL_MS) this.trail.shift();
  }

  /** A real laser dot: small bright core, tight glow, a hairline of motion. */
  private drawLaser(unit: number) {
    const { ctx, trail } = this;
    const { x, y } = this.display!;
    const rgb = `${this.accent.r},${this.accent.g},${this.accent.b}`;
    ctx.save();
    ctx.globalAlpha = this.visibility;
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const k = i / trail.length;
      ctx.strokeStyle = `rgba(${rgb},${(k * 0.35).toFixed(3)})`;
      ctx.lineWidth = (0.6 + k * 1.4) * unit;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 11 * unit);
    glow.addColorStop(0, `rgba(${rgb},.55)`);
    glow.addColorStop(0.35, `rgba(${rgb},.18)`);
    glow.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 11 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = this.accent.hex;
    ctx.beginPath();
    ctx.arc(x, y, 3.2 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFF7EA';
    ctx.beginPath();
    ctx.arc(x, y, 1.6 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private drawLens(unit: number) {
    const { ctx } = this;
    const { x, y } = this.display!;
    ctx.save();
    ctx.globalAlpha = this.visibility;
    ctx.beginPath();
    ctx.arc(x, y, 18 * unit, 0, Math.PI * 2);
    ctx.lineWidth = 3 * unit;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.lineWidth = 1.4 * unit;
    ctx.strokeStyle = HALO;
    ctx.stroke();
    ctx.fillStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(x, y, 2 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** A small pen held at the fingertip, nib on the ink. */
  private drawPen(unit: number) {
    const { ctx } = this;
    const { x, y } = this.display!;
    const color = this.sample?.color ?? ACCENT;
    ctx.save();
    ctx.globalAlpha = this.visibility;
    ctx.translate(x, y);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 2.2 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(-Math.PI / 4);
    ctx.translate(5 * unit, 0);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1 * unit;
    ctx.strokeStyle = SHADOW;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(7 * unit, -2.8 * unit);
    ctx.lineTo(7 * unit, 2.8 * unit);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.roundRect(7 * unit, -2.8 * unit, 20 * unit, 5.6 * unit, [0, 1.8 * unit, 1.8 * unit, 0]);
    ctx.fillStyle = HALO;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(22 * unit, -2.8 * unit);
    ctx.lineTo(22 * unit, 2.8 * unit);
    ctx.stroke();
    ctx.restore();
  }

  /** Like the pen: a nib on the ink, with a small badge that names the shape the pinch is drawing. */
  private drawShapeTool(unit: number, kind: 'rect' | 'ellipse' | 'arrow') {
    const { ctx } = this;
    const { x, y } = this.display!;
    const color = this.sample?.color ?? ACCENT;
    const aim = this.sample?.progress;
    ctx.save();
    ctx.globalAlpha = this.visibility;
    if (aim !== undefined) {
      // Aiming: a crosshair ring that fills while the hand holds still; the shape starts when it closes.
      const r = 11 * unit;
      ctx.lineWidth = 3 * unit;
      ctx.strokeStyle = SHADOW;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.4 * unit;
      ctx.strokeStyle = HALO;
      ctx.stroke();
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.6 * unit;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + aim * Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2.4 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1 * unit;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();

    const bx = x + 16 * unit;
    const by = y - 16 * unit;
    const r = 10 * unit;
    ctx.beginPath();
    ctx.roundRect(bx - r, by - r, r * 2, r * 2, 4 * unit);
    ctx.fillStyle = 'rgba(21,25,36,.9)';
    ctx.fill();
    ctx.lineWidth = 1 * unit;
    ctx.strokeStyle = 'rgba(238,240,246,.25)';
    ctx.stroke();

    const s = 5 * unit;
    ctx.lineWidth = 1.6 * unit;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (kind === 'rect') ctx.rect(bx - s, by - s * 0.7, s * 2, s * 1.4);
    else if (kind === 'ellipse') ctx.ellipse(bx, by, s * 1.05, s * 0.72, 0, 0, Math.PI * 2);
    else {
      ctx.moveTo(bx - s, by + s);
      ctx.lineTo(bx + s, by - s);
      ctx.moveTo(bx + s, by - s);
      ctx.lineTo(bx + s * 0.05, by - s);
      ctx.moveTo(bx + s, by - s);
      ctx.lineTo(bx + s, by - s * 0.05);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawEraser(unit: number) {
    const { ctx } = this;
    const { x, y } = this.display!;
    const r = this.sample?.radius ?? 32;
    ctx.save();
    ctx.globalAlpha = this.visibility;
    ctx.fillStyle = 'rgba(238,240,246,.1)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 3 * unit;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.lineWidth = 1.4 * unit;
    ctx.strokeStyle = HALO;
    ctx.stroke();
    ctx.restore();
  }

  private drawNav(now: number, dt: number, unit: number) {
    const a = 1 - Math.exp(-dt / 70);
    this.navAlpha += ((this.nav ? 1 : 0) - this.navAlpha) * a;
    const flash = this.navFlash && now - this.navFlash.t < NAV_FLASH_MS ? this.navFlash : null;
    if (this.navAlpha < 0.01 && !flash) return;
    const lean = this.nav?.lean ?? 0;
    const { ctx } = this;
    for (const side of ['left', 'right'] as const) {
      const want = side === 'left' ? Math.max(0, -lean) : Math.max(0, lean);
      this.navLean[side] += (want - this.navLean[side]) * a;
      const f = flash && flash.dir === side ? 1 - (now - flash.t) / NAV_FLASH_MS : 0;
      const alpha = Math.max(this.navAlpha * (0.28 + 0.72 * this.navLean[side]), f);
      if (alpha < 0.01) continue;
      const sign = side === 'left' ? -1 : 1;
      const cx = (side === 'left' ? 40 * unit : this.w - 40 * unit) + sign * (this.navLean[side] * 6 + f * 6) * unit;
      const cy = this.h / 2;
      const s = 12 * unit;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const path = () => {
        ctx.beginPath();
        ctx.moveTo(cx - sign * s * 0.5, cy - s);
        ctx.lineTo(cx + sign * s * 0.5, cy);
        ctx.lineTo(cx - sign * s * 0.5, cy + s);
      };
      path();
      ctx.lineWidth = 5 * unit;
      ctx.strokeStyle = SHADOW;
      ctx.stroke();
      path();
      ctx.lineWidth = 2 * unit;
      ctx.strokeStyle = f > 0 ? ACCENT : HALO;
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawZoomMarker(unit: number) {
    const { ctx } = this;
    const { x, y, level } = this.zoomMarker!;
    ctx.save();
    ctx.lineWidth = 3 * unit;
    ctx.strokeStyle = SHADOW;
    ctx.beginPath();
    ctx.arc(x, y, 14 * unit, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1.4 * unit;
    ctx.strokeStyle = HALO;
    ctx.stroke();
    const text = `${level.toFixed(1)}×`;
    ctx.font = `500 ${Math.round(12 * unit)}px "Geist Mono", ui-monospace, monospace`;
    const tw = ctx.measureText(text).width;
    const px = x + 22 * unit;
    ctx.fillStyle = 'rgba(21,25,36,.88)';
    ctx.beginPath();
    ctx.roundRect(px, y - 11 * unit, tw + 16 * unit, 22 * unit, 11 * unit);
    ctx.fill();
    ctx.fillStyle = HALO;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px + 8 * unit, y + 0.5);
    ctx.restore();
  }

  private drawHold(unit: number) {
    const { ctx } = this;
    const { progress, label } = this.hold!;
    const cx = this.w / 2;
    const cy = this.h / 2;
    const r = 22 * unit;
    ctx.save();
    ctx.fillStyle = 'rgba(21,25,36,.82)';
    ctx.beginPath();
    ctx.arc(cx, cy, r + 14 * unit, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = 'round';
    ctx.lineWidth = 2.5 * unit;
    ctx.strokeStyle = '#262C3B';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = HALO;
    ctx.font = `500 ${Math.round(11 * unit)}px "Geist Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(label.toUpperCase(), cx, cy + r + 22 * unit);
    ctx.restore();
  }
}
