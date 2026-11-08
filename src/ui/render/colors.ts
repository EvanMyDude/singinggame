import type { Judgment, Zone } from '../../core/scoring';

export const COLORS = {
  bg: '#07080c',
  lane: 'rgba(255,255,255,0.035)',
  laneStrong: 'rgba(255,255,255,0.07)',
  text: '#eef1f7',
  dim: 'rgba(238,241,247,0.55)',
  faint: 'rgba(238,241,247,0.28)',
  accent: '#5ee0ff',
  accent2: '#a08cff',
  perfect: '#3dffa2',
  great: '#ffe14d',
  good: '#ff9f43',
  off: '#ff4d6d',
  miss: '#4f5668',
  neutral: '#dfe6f5',
} as const;

export function zoneColor(z: Zone | null): string {
  switch (z) {
    case 'perfect':
      return COLORS.perfect;
    case 'great':
      return COLORS.great;
    case 'good':
      return COLORS.good;
    case 'off':
      return COLORS.off;
    default:
      return COLORS.neutral;
  }
}

export function judgmentColor(j: Judgment): string {
  return j === 'miss' ? COLORS.miss : zoneColor(j);
}

export const JUDGMENT_LABEL: Record<Judgment, string> = {
  perfect: 'PERFECT',
  great: 'GREAT',
  good: 'GOOD',
  off: 'OFF',
  miss: 'MISS',
};

/** Size a canvas to its CSS box at device pixel ratio; returns the 2D context in CSS pixels. */
export function fitCanvas(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth;
  const h = c.clientHeight;
  if (!w || !h) return null;
  const W = Math.round(w * dpr);
  const H = Math.round(h * dpr);
  if (c.width !== W || c.height !== H) {
    c.width = W;
    c.height = H;
  }
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
