import { noteNameWithOctave } from '../../core/music';
import type { Judgment, Zone } from '../../core/scoring';
import type { Song } from '../../core/song';
import { COLORS, JUDGMENT_LABEL, fitCanvas, judgmentColor, zoneColor } from './colors';

/** One point of the sung-pitch trail, already folded into the target's octave. */
export interface TrailPt {
  beat: number;
  /** Display pitch (MIDI), NaN for a gap. */
  m: number;
  zone: Zone | null;
}

export interface HighwayFrame {
  /** Song beat currently being heard (the playhead). */
  beat: number;
  /** Beat at which the first note of this pass starts (for the count-in display). */
  firstNoteBeat: number;
  /** Beat at which counting in started. */
  countInFrom: number;
  /** Finalized judgments by note index. */
  judgments: (Judgment | undefined)[];
  /** Latest live zone per note while it is being sung. */
  liveZones: (Zone | undefined)[];
  trail: readonly TrailPt[];
  head: { m: number; zone: Zone | null } | null;
  hint: 'sharp' | 'flat' | null;
  /** Note index to flash (Hear Target Note). */
  flashNote: number;
  flashUntil: number;
  now: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  r: number;
}

interface Popup {
  text: string;
  sub?: string;
  color: string;
  x: number;
  y: number;
  born: number;
  big: boolean;
}

const LOOKAHEAD_SECONDS = 3.4;
const BEHIND_FRACTION = 0.26;

export class Highway {
  private readonly canvas: HTMLCanvasElement;
  private song: Song;
  private from: number;
  private to: number;
  private low = 55;
  private high = 70;
  private particles: Particle[] = [];
  private popups: Popup[] = [];
  private lastDraw = 0;
  showNoteNames = false;
  private layout = { w: 0, h: 0, top: 0, bottom: 0, px: 0, ppb: 0 };

  constructor(canvas: HTMLCanvasElement, song: Song, from: number, to: number) {
    this.canvas = canvas;
    this.song = song;
    this.from = from;
    this.to = to;
    const notes = song.notes.filter((n) => n.start >= from - 1e-9 && n.start < to - 1e-9);
    const lo = Math.min(...notes.map((n) => n.midi));
    const hi = Math.max(...notes.map((n) => n.midi));
    const pad = 3;
    let low = lo - pad;
    let high = hi + pad;
    if (high - low < 13) {
      const c = (low + high) / 2;
      low = c - 6.5;
      high = c + 6.5;
    }
    this.low = low;
    this.high = high;
  }

  /** Y (CSS px) for a MIDI pitch. */
  yOf(m: number): number {
    const { top, bottom } = this.layout;
    return bottom - ((m - this.low) / (this.high - this.low)) * (bottom - top);
  }

  xOf(beat: number, now: number): number {
    return this.layout.px + (beat - now) * this.layout.ppb;
  }

  popJudgment(j: Judgment, noteMidi: number, extra?: string): void {
    this.popups.push({
      text: JUDGMENT_LABEL[j],
      sub: extra,
      color: judgmentColor(j),
      x: this.layout.px,
      y: this.yOf(noteMidi) - 26,
      born: performance.now(),
      big: false,
    });
    if (j === 'perfect') this.burst(this.layout.px, this.yOf(noteMidi), COLORS.perfect, 14);
  }

  comboBurst(text: string): void {
    const { w, top, bottom } = this.layout;
    this.popups.push({ text, color: COLORS.accent, x: w * 0.5, y: (top + bottom) / 2, born: performance.now(), big: true });
    this.burst(this.layout.px, (top + bottom) / 2, COLORS.accent, 30);
  }

  private burst(x: number, y: number, color: string, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 40 + Math.random() * 160;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.5 + Math.random() * 0.4, color, r: 1.5 + Math.random() * 2 });
    }
  }

  private emit(x: number, y: number, zone: Zone): void {
    if (zone !== 'perfect' && zone !== 'great') return;
    const n = zone === 'perfect' ? 2 : 1;
    const color = zoneColor(zone);
    for (let i = 0; i < n; i++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y + (Math.random() - 0.5) * 6,
        vx: -30 - Math.random() * 60,
        vy: (Math.random() - 0.5) * 70,
        life: 0,
        max: 0.35 + Math.random() * 0.35,
        color,
        r: 1.2 + Math.random() * 1.8,
      });
    }
  }

  draw(f: HighwayFrame): void {
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { g, w, h } = fit;
    const nowMs = performance.now();
    const dt = this.lastDraw ? Math.min(0.05, (nowMs - this.lastDraw) / 1000) : 0;
    this.lastDraw = nowMs;

    const spb1 = 60 / this.song.bpm;
    const top = Math.max(96, h * 0.14);
    const bottom = h - Math.max(118, h * 0.17);
    const px = Math.round(w * BEHIND_FRACTION);
    const ppb = (w - px) / (LOOKAHEAD_SECONDS / spb1);
    this.layout = { w, h, top, bottom, px, ppb };
    const beat = f.beat;

    g.clearRect(0, 0, w, h);

    // Semitone lanes.
    const laneH = (bottom - top) / (this.high - this.low);
    for (let m = Math.ceil(this.low); m <= Math.floor(this.high); m++) {
      const y = this.yOf(m);
      g.fillStyle = ((m % 12) + 12) % 12 === 0 ? COLORS.laneStrong : COLORS.lane;
      g.fillRect(0, Math.round(y), w, 1);
      if (this.showNoteNames) {
        g.fillStyle = COLORS.faint;
        g.font = '600 10px Inter Variable, system-ui, sans-serif';
        g.textBaseline = 'middle';
        g.fillText(noteNameWithOctave(m), 8, y);
      }
    }

    // Bar lines.
    const bpb = this.song.beatsPerBar;
    const firstBar = Math.floor((beat - px / ppb) / bpb) * bpb;
    for (let b = firstBar; b < beat + (w - px) / ppb + bpb; b += bpb) {
      const x = this.xOf(b, beat);
      if (x < 0 || x > w) continue;
      g.fillStyle = 'rgba(255,255,255,0.04)';
      g.fillRect(Math.round(x), top - 10, 1, bottom - top + 20);
    }

    // Notes.
    const barH = Math.max(9, Math.min(22, laneH * 0.66));
    g.textAlign = 'center';
    g.textBaseline = 'top';
    let activeIdx = -1;
    for (const n of this.song.notes) {
      const x0 = this.xOf(n.start, beat);
      const x1 = this.xOf(n.start + n.beats, beat) - 3;
      if (x1 < -20 || x0 > w + 20) continue;
      const inWindow = n.start >= this.from - 1e-9 && n.start < this.to - 1e-9;
      const y = this.yOf(n.midi);
      const isActive = inWindow && x0 <= px && x1 >= px;
      if (isActive) activeIdx = n.index;
      const past = x1 < px;
      const j = f.judgments[n.index];
      const live = f.liveZones[n.index];
      let fill: string;
      let alpha: number;
      if (!inWindow) {
        fill = COLORS.miss;
        alpha = 0.25;
      } else if (past || (isActive && live)) {
        fill = j ? judgmentColor(j) : live ? zoneColor(live) : COLORS.miss;
        alpha = past ? 0.55 : 0.95;
      } else {
        fill = COLORS.accent;
        alpha = isActive ? 1 : 0.82;
      }
      const flashing = f.flashNote === n.index && nowMs < f.flashUntil;
      const width = Math.max(4, x1 - x0);
      g.globalAlpha = alpha * (inWindow ? 0.22 : 0.1);
      g.fillStyle = fill;
      roundRect(g, x0 - 4, y - barH / 2 - 4, width + 8, barH + 8, (barH + 8) / 2);
      g.fill();
      g.globalAlpha = alpha;
      if (isActive || flashing) {
        g.shadowColor = flashing ? COLORS.text : fill;
        g.shadowBlur = flashing ? 26 : 18;
      }
      g.fillStyle = flashing ? COLORS.text : fill;
      roundRect(g, x0, y - barH / 2, width, barH, barH / 2);
      g.fill();
      g.shadowBlur = 0;
      // Inner highlight for depth.
      g.globalAlpha = alpha * 0.35;
      g.fillStyle = '#ffffff';
      roundRect(g, x0 + 3, y - barH / 2 + 2, Math.max(0, width - 6), Math.max(2, barH * 0.28), barH * 0.14);
      g.fill();
      g.globalAlpha = 1;
      if (n.lyric && inWindow) {
        g.font = `${isActive ? 700 : 600} 13px Inter Variable, system-ui, sans-serif`;
        g.fillStyle = isActive ? COLORS.text : past ? COLORS.faint : COLORS.dim;
        g.fillText(n.lyric.replace(/-$/, ''), x0 + Math.min(width / 2, 40), y + barH / 2 + 6);
      }
    }
    g.textAlign = 'left';

    // Playhead.
    const grad = g.createLinearGradient(0, top - 20, 0, bottom + 20);
    grad.addColorStop(0, 'rgba(94,224,255,0)');
    grad.addColorStop(0.5, 'rgba(94,224,255,0.45)');
    grad.addColorStop(1, 'rgba(94,224,255,0)');
    g.fillStyle = grad;
    g.fillRect(px - 1, top - 20, 2, bottom - top + 40);
    if (activeIdx >= 0) {
      const y = this.yOf(this.song.notes[activeIdx]!.midi);
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(px - 14, y);
      g.lineTo(px + 14, y);
      g.stroke();
    }

    // Voice trail, grouped into same-color runs to keep glow draws cheap.
    g.lineWidth = 4;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const minBeat = beat - px / ppb;
    let run: { color: string; pts: [number, number][] } | null = null;
    const flush = () => {
      if (run && run.pts.length > 1) {
        g.strokeStyle = run.color;
        g.shadowColor = run.color;
        g.shadowBlur = 10;
        g.beginPath();
        g.moveTo(run.pts[0]![0], run.pts[0]![1]);
        for (let i = 1; i < run.pts.length; i++) g.lineTo(run.pts[i]![0], run.pts[i]![1]);
        g.stroke();
        g.shadowBlur = 0;
      }
    };
    let lastXY: [number, number] | null = null;
    for (const p of f.trail) {
      if (p.beat < minBeat || p.beat > beat + 0.05) continue;
      if (!Number.isFinite(p.m)) {
        flush();
        run = null;
        lastXY = null;
        continue;
      }
      const x = this.xOf(p.beat, beat);
      const y = clamp(this.yOf(p.m), top - 30, bottom + 30);
      const color = zoneColor(p.zone);
      if (!run || run.color !== color) {
        flush();
        run = { color, pts: lastXY ? [lastXY] : [] };
      }
      run.pts.push([x, y]);
      lastXY = [x, y];
    }
    flush();

    // Head dot at the playhead.
    if (f.head && Number.isFinite(f.head.m)) {
      const yRaw = this.yOf(f.head.m);
      const y = clamp(yRaw, top - 30, bottom + 30);
      const color = zoneColor(f.head.zone);
      if (lastXY) {
        g.strokeStyle = color;
        g.globalAlpha = 0.7;
        g.beginPath();
        g.moveTo(lastXY[0], lastXY[1]);
        g.lineTo(px, y);
        g.stroke();
        g.globalAlpha = 1;
      }
      if (f.head.zone === 'perfect') {
        g.fillStyle = 'rgba(61,255,162,0.16)';
        g.beginPath();
        g.arc(px, y, 20 + Math.sin(nowMs / 90) * 2, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 22;
      g.beginPath();
      g.arc(px, y, 9, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
      g.fillStyle = '#0a0c10';
      g.beginPath();
      g.arc(px, y, 3, 0, Math.PI * 2);
      g.fill();
      if (yRaw < top - 30 || yRaw > bottom + 30) {
        g.fillStyle = color;
        g.font = '700 14px Inter Variable, system-ui, sans-serif';
        g.fillText(yRaw < top ? '▲' : '▼', px + 14, y + 5);
      }
      if (f.head.zone) this.emit(px, y, f.head.zone);

      if (f.hint) {
        const sharp = f.hint === 'sharp';
        g.font = '700 17px Space Grotesk Variable, Inter Variable, system-ui, sans-serif';
        g.fillStyle = COLORS.off;
        g.shadowColor = COLORS.off;
        g.shadowBlur = 12;
        g.fillText(sharp ? 'Too sharp ↑' : 'Too flat ↓', px + 22, sharp ? y - 18 : y + 30);
        g.shadowBlur = 0;
      }
    }

    // Count-in.
    if (beat < f.firstNoteBeat && beat >= f.countInFrom - 0.5) {
      const left = f.firstNoteBeat - beat;
      const n = Math.ceil(left);
      const frac = n - left;
      if (n <= 4 && n >= 1) {
        g.save();
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.globalAlpha = 1 - frac * 0.7;
        g.fillStyle = COLORS.text;
        g.font = `700 ${Math.round(96 + frac * 30)}px Space Grotesk Variable, system-ui, sans-serif`;
        g.fillText(String(n), w / 2, (top + bottom) / 2);
        g.restore();
      }
    }

    // Particles.
    g.globalCompositeOperation = 'lighter';
    const scroll = ppb / (60 / this.song.bpm);
    this.particles = this.particles.filter((p) => {
      p.life += dt;
      if (p.life >= p.max) return false;
      p.x += (p.vx - scroll * 0.6) * dt;
      p.y += p.vy * dt;
      p.vy *= 0.96;
      g.globalAlpha = 1 - p.life / p.max;
      g.fillStyle = p.color;
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      g.fill();
      return true;
    });
    if (this.particles.length > 600) this.particles.splice(0, this.particles.length - 600);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    // Popups.
    this.popups = this.popups.filter((p) => {
      const age = (nowMs - p.born) / 1000;
      const dur = p.big ? 1.1 : 0.8;
      if (age > dur) return false;
      const k = age / dur;
      g.save();
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.globalAlpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45);
      g.fillStyle = p.color;
      g.shadowColor = p.color;
      g.shadowBlur = 16;
      const scale = p.big ? 1 + 0.25 * Math.sin(Math.min(1, k * 3) * Math.PI) : 1 + 0.2 * Math.max(0, 1 - k * 5);
      g.font = `700 ${Math.round((p.big ? 46 : 20) * scale)}px Space Grotesk Variable, system-ui, sans-serif`;
      g.fillText(p.text, p.x, p.y - k * (p.big ? 20 : 34));
      if (p.sub) {
        g.font = '700 13px Inter Variable, system-ui, sans-serif';
        g.fillText(p.sub, p.x, p.y - k * 34 + 20);
      }
      g.restore();
      return true;
    });
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.arcTo(x + w, y, x + w, y + rr, rr);
  g.lineTo(x + w, y + h - rr);
  g.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  g.lineTo(x + rr, y + h);
  g.arcTo(x, y + h, x, y + h - rr, rr);
  g.lineTo(x, y + rr);
  g.arcTo(x, y, x + rr, y, rr);
  g.closePath();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
