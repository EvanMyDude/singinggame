import type { VoiceFrame } from '../../audio/pitch/tracker';
import { centsError, foldToOctaveOf, noteNameWithOctave } from '../../core/music';
import { THRESHOLDS, zoneFor } from '../../core/scoring';
import { COLORS, fitCanvas, zoneColor } from './colors';

interface Pt {
  t: number;
  midi: number;
}

/**
 * Scrolling pitch trace used by the range check (free mode) and the Pitch Trainer
 * (target mode, with Perfect/Great/Good bands around the target).
 */
export class TunerView {
  private readonly c: HTMLCanvasElement;
  private pts: Pt[] = [];
  private target: number | null = null;
  private fold = true;
  private center = 57;
  private readonly span: number;
  private readonly window = 4;

  constructor(canvas: HTMLCanvasElement, opts: { spanSemitones?: number } = {}) {
    this.c = canvas;
    this.span = opts.spanSemitones ?? 14;
  }

  setTarget(midi: number | null, fold = true): void {
    this.target = midi;
    this.fold = fold;
    if (midi !== null) this.center = midi;
  }

  clear(): void {
    this.pts = [];
  }

  push(f: VoiceFrame): void {
    this.pts.push({ t: f.time, midi: f.voiced ? f.displayMidi : NaN });
    const cutoff = f.time - this.window - 0.5;
    while (this.pts.length && this.pts[0]!.t < cutoff) this.pts.shift();
  }

  draw(now: number): void {
    const fit = fitCanvas(this.c);
    if (!fit) return;
    const { g, w, h } = fit;
    g.clearRect(0, 0, w, h);
    const target = this.target;
    const visible = this.pts.filter((p) => Number.isFinite(p.midi));
    if (target === null && visible.length) {
      // Free mode: drift the view toward the singer so the trace stays on screen.
      const last = visible[visible.length - 1]!.midi;
      if (Math.abs(last - this.center) > this.span * 0.35) this.center += (last - this.center) * 0.08;
    }
    const lo = this.center - this.span / 2;
    const y = (m: number) => h - ((m - lo) / this.span) * h;
    const headX = w * 0.82;
    const x = (t: number) => headX - ((now - t) / this.window) * headX;

    // Semitone lanes with labels.
    g.font = '600 11px Inter Variable, system-ui, sans-serif';
    g.textBaseline = 'middle';
    for (let m = Math.ceil(lo); m <= lo + this.span; m++) {
      const yy = y(m);
      const isC = ((m % 12) + 12) % 12 === 0;
      g.strokeStyle = isC ? COLORS.laneStrong : COLORS.lane;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, yy);
      g.lineTo(w, yy);
      g.stroke();
      if (target === null || Math.abs(m - target) <= 3) {
        g.fillStyle = m === target ? COLORS.text : COLORS.faint;
        g.fillText(noteNameWithOctave(m), 10, yy);
      }
    }

    if (target !== null) {
      const semi = h / this.span;
      const band = (cents: number, color: string) => {
        const half = (cents / 100) * semi;
        g.fillStyle = color;
        g.fillRect(44, y(target) - half, w - 44, half * 2);
      };
      band(THRESHOLDS.good, 'rgba(255,159,67,0.07)');
      band(THRESHOLDS.great, 'rgba(255,225,77,0.08)');
      band(THRESHOLDS.perfect, 'rgba(61,255,162,0.12)');
      g.strokeStyle = COLORS.accent;
      g.lineWidth = 2;
      g.shadowColor = COLORS.accent;
      g.shadowBlur = 12;
      g.beginPath();
      g.moveTo(44, y(target));
      g.lineTo(w, y(target));
      g.stroke();
      g.shadowBlur = 0;
    }

    // Trace.
    g.lineWidth = 3.5;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    let prev: { x: number; y: number } | null = null;
    let lastPt: { x: number; y: number; color: string } | null = null;
    for (const p of this.pts) {
      if (!Number.isFinite(p.midi)) {
        prev = null;
        continue;
      }
      const m = target !== null && this.fold ? foldToOctaveOf(p.midi, target) : p.midi;
      const px = x(p.t);
      const py = Math.max(4, Math.min(h - 4, y(m)));
      const color = target !== null ? zoneColor(zoneFor(Math.abs(centsError(p.midi, target, this.fold)))) : COLORS.accent;
      if (prev) {
        g.strokeStyle = color;
        g.beginPath();
        g.moveTo(prev.x, prev.y);
        g.lineTo(px, py);
        g.stroke();
      }
      prev = { x: px, y: py };
      lastPt = { x: px, y: py, color };
    }
    const fresh = this.pts.length && Number.isFinite(this.pts[this.pts.length - 1]!.midi) && now - this.pts[this.pts.length - 1]!.t < 0.25;
    if (lastPt && fresh) {
      g.fillStyle = lastPt.color;
      g.shadowColor = lastPt.color;
      g.shadowBlur = 18;
      g.beginPath();
      g.arc(lastPt.x, lastPt.y, 7, 0, Math.PI * 2);
      g.fill();
      g.shadowBlur = 0;
    }
  }
}
