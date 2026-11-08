import { noteNameWithOctave } from '../../core/music';
import type { VocalRange } from '../../core/range';
import { zoneFor } from '../../core/scoring';
import { COLORS, fitCanvas, zoneColor } from './colors';

/**
 * Real-time pitch graph for the Pitch Monitor: time runs right to left (newest at the right
 * edge), pitch is vertical with one lane per semitone. The trace is colored by how centered
 * the voice is on the nearest note, using the game's Perfect / Great / Good / Off zones.
 */

export interface GraphView {
  /** MIDI pitch at the bottom and top edges. */
  low: number;
  high: number;
}

export const MIN_MIDI = 24; // C1
export const MAX_MIDI = 96; // C7
export const SPAN_STEPS = [12, 18, 24, 30, 36, 48];

/** Initial view: the singer's range with a little air, or C2 to C5. */
export function defaultView(range: VocalRange | null): GraphView {
  if (!range) return { low: 36, high: 72 };
  const low = Math.floor(range.low) - 5;
  const high = Math.ceil(range.high) + 5;
  const span = SPAN_STEPS.find((s) => s >= high - low) ?? 48;
  const mid = (low + high) / 2;
  return clampView({ low: Math.round(mid - span / 2), high: Math.round(mid - span / 2) + span });
}

export function clampView(v: GraphView): GraphView {
  const span = v.high - v.low;
  let low = Math.max(MIN_MIDI, Math.min(MAX_MIDI - span, v.low));
  low = Math.round(low);
  return { low, high: low + span };
}

/** Zoom in (dir = 1, fewer semitones) or out (dir = -1) around the center. */
export function zoomView(v: GraphView, dir: 1 | -1): GraphView {
  const span = v.high - v.low;
  const idx = SPAN_STEPS.findIndex((s) => s >= span);
  const cur = idx < 0 ? SPAN_STEPS.length - 1 : idx;
  const next = SPAN_STEPS[Math.max(0, Math.min(SPAN_STEPS.length - 1, cur - dir))]!;
  const mid = (v.low + v.high) / 2;
  return clampView({ low: Math.round(mid - next / 2), high: Math.round(mid - next / 2) + next });
}

export function shiftView(v: GraphView, semitones: number): GraphView {
  return clampView({ low: v.low + semitones, high: v.high + semitones });
}

/** Keep `midi` at least `margin` semitones inside the view, moving it as little as possible. */
export function followView(v: GraphView, midi: number, margin = 2): GraphView {
  if (midi < v.low + margin) return shiftView(v, Math.floor(midi - margin - v.low));
  if (midi > v.high - margin) return shiftView(v, Math.ceil(midi + margin - v.high));
  return v;
}

export function viewLabel(v: GraphView): string {
  return `${noteNameWithOctave(v.low)}–${noteNameWithOctave(v.high)}`;
}

/** Cents from the nearest equal-tempered note, in (-50, 50]. */
export function centsFromNearest(midi: number): number {
  return (midi - Math.round(midi)) * 100;
}

const NATURAL = new Set([0, 2, 4, 5, 7, 9, 11]);
const GUTTER = 42;

interface Pt {
  t: number;
  m: number;
}

export class PitchGraph {
  view: GraphView;
  windowSec = 8;
  private readonly canvas: HTMLCanvasElement;
  private pts: Pt[] = [];

  constructor(canvas: HTMLCanvasElement, view: GraphView) {
    this.canvas = canvas;
    this.view = view;
  }

  push(t: number, midi: number): void {
    this.pts.push({ t, m: midi });
    const cutoff = t - 60; // keep a minute so Hold can still show the recent past
    let drop = 0;
    while (drop < this.pts.length && this.pts[drop]!.t < cutoff) drop++;
    if (drop > 200) this.pts.splice(0, drop);
  }

  clear(): void {
    this.pts = [];
  }

  draw(now: number, current: number | null): void {
    const fit = fitCanvas(this.canvas);
    if (!fit) return;
    const { g, w, h } = fit;
    const { low, high } = this.view;
    const span = high - low;
    const laneH = h / span;
    const y = (m: number) => h - ((m - low) / span) * h;
    const plotW = w - GUTTER;
    const x = (t: number) => GUTTER + plotW - ((now - t) / this.windowSec) * plotW;

    g.clearRect(0, 0, w, h);
    g.fillStyle = '#090b10';
    g.fillRect(GUTTER, 0, plotW, h);

    // Highlight the lane of the note being sung.
    if (current !== null && current >= low && current <= high) {
      const n = Math.round(current);
      g.fillStyle = zoneColor(zoneFor(Math.abs(centsFromNearest(current))));
      g.globalAlpha = 0.09;
      g.fillRect(GUTTER, y(n + 0.5), plotW, laneH);
      g.globalAlpha = 1;
    }

    // Semitone lines: C lines in the accent violet, naturals faint, sharps fainter.
    const labelAll = laneH >= 9;
    const labelSome = laneH >= 5;
    g.font = '600 10.5px Inter Variable, system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let m = Math.ceil(low); m <= high; m++) {
      const pc = ((m % 12) + 12) % 12;
      const yy = Math.round(y(m)) + 0.5;
      const isC = pc === 0;
      g.strokeStyle = isC ? 'rgba(160,140,255,0.45)' : NATURAL.has(pc) ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.03)';
      g.lineWidth = isC ? 1.5 : 1;
      g.beginPath();
      g.moveTo(GUTTER, yy);
      g.lineTo(w, yy);
      g.stroke();
      const show = isC || (labelAll && NATURAL.has(pc)) || (labelSome && pc === 7);
      if (show && yy > 6 && yy < h - 6) {
        const active = current !== null && Math.round(current) === m;
        g.fillStyle = active ? COLORS.text : isC ? 'rgba(200,190,255,0.85)' : COLORS.faint;
        g.font = `${isC || active ? 700 : 600} 10.5px Inter Variable, system-ui, sans-serif`;
        g.fillText(noteNameWithOctave(m), GUTTER - 7, yy);
      }
    }

    // Trace, grouped into same-color runs.
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    let run: { color: string; pts: [number, number][] } | null = null;
    let prevM: number | null = null;
    const flush = () => {
      if (run && run.pts.length > 1) {
        g.strokeStyle = run.color;
        g.shadowColor = run.color;
        g.shadowBlur = 8;
        g.beginPath();
        g.moveTo(run.pts[0]![0], run.pts[0]![1]);
        for (let i = 1; i < run.pts.length; i++) g.lineTo(run.pts[i]![0], run.pts[i]![1]);
        g.stroke();
        g.shadowBlur = 0;
      }
    };
    let last: { x: number; y: number; color: string } | null = null;
    const t0 = now - this.windowSec - 0.2;
    // Color by a smoothed deviation (so vibrato does not strobe the line) and draw fast
    // glides in the neutral accent: "centered on a note" only means something while holding.
    let ema = 0;
    let rate = 0;
    let prevT = 0;
    for (const p of this.pts) {
      if (p.t < t0 || p.t > now + 0.05) continue;
      if (!Number.isFinite(p.m) || (prevM !== null && Math.abs(p.m - prevM) > 2.5)) {
        flush();
        run = null;
        prevM = Number.isFinite(p.m) ? p.m : null;
        if (!Number.isFinite(p.m)) continue;
        ema = Math.abs(centsFromNearest(p.m));
        rate = 0;
        prevT = p.t;
      }
      const dt = Math.max(1e-3, p.t - prevT);
      const k = 1 - Math.exp(-dt / 0.15);
      if (prevM !== null && p.t > prevT) rate += (1 - Math.exp(-dt / 0.06)) * (Math.abs(p.m - prevM) / dt - rate);
      ema += k * (Math.abs(centsFromNearest(p.m)) - ema);
      prevT = p.t;
      const px = x(p.t);
      const py = Math.max(2, Math.min(h - 2, y(p.m)));
      const color = rate > 3 ? COLORS.accent : zoneColor(zoneFor(ema));
      if (!run || run.color !== color) {
        const carry: [number, number][] = run && run.pts.length ? [run.pts[run.pts.length - 1]!] : [];
        flush();
        run = { color, pts: carry };
      }
      run.pts.push([px, py]);
      prevM = p.m;
      last = { x: px, y: py, color };
    }
    flush();
    if (last && current !== null) {
      g.fillStyle = last.color;
      g.shadowColor = last.color;
      g.shadowBlur = 16;
      g.beginPath();
      g.arc(last.x, last.y, 5.5, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }

    // View range, top-right.
    g.fillStyle = COLORS.faint;
    g.font = '600 11px Inter Variable, system-ui, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'top';
    g.fillText(viewLabel(this.view), w - 10, 8);
    g.textBaseline = 'middle';

    // Off-screen indicator.
    if (current !== null && (current < low || current > high)) {
      g.fillStyle = COLORS.accent;
      g.font = '700 13px Inter Variable, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(current > high ? '▲ above view' : '▼ below view', GUTTER + plotW / 2, current > high ? 14 : h - 14);
    }
    g.textAlign = 'left';
  }
}
