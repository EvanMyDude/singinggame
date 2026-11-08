import { THRESHOLDS, type Judgment, type NoteResult } from '../../core/scoring';
import type { Song } from '../../core/song';
import { h } from '../dom';
import { COLORS, judgmentColor } from './colors';

/**
 * Sharp/flat timeline for the results screen: one bar per note at its place in the song,
 * growing up (sharp) or down (flat) from a zero line by the note's median cents deviation,
 * colored by its judgment. Missed notes are hollow rings on the zero line. The Perfect band
 * (±10 cents) is a soft wash; ±25 and ±50 are hairline gridlines. Hover, tap or arrow keys
 * show details; a table view lists every value.
 */

const DOMAIN = 75; // cents shown above/below zero; larger deviations are capped with a marker
const HEIGHT = 210;
const LEFT = 46;
const RIGHT = 10;
const TOP = 18;
const AXIS_BAND = 30; // section labels under the plot

const LABEL: Record<Judgment, string> = { perfect: 'Perfect', great: 'Great', good: 'Good', off: 'Off', miss: 'Missed' };

export function deviationTimeline(song: Song, results: readonly NoteResult[], nn: (m: number) => string): HTMLElement {
  const notes = [...results].sort((a, b) => a.index - b.index);
  const plot = h('div', { class: 'dev-plot' });
  const tip = h('div', { class: 'dev-tip', role: 'status', 'aria-live': 'polite' });
  const sung = notes.filter((n) => Number.isFinite(n.biasCents) && n.judgment !== 'miss');
  const sharp = sung.filter((n) => n.biasCents > THRESHOLDS.perfect).length;
  const flat = sung.filter((n) => n.biasCents < -THRESHOLDS.perfect).length;
  const summary = `${notes.length} notes: ${sharp} sharp, ${flat} flat, ${sung.length - sharp - flat} centered within ${THRESHOLDS.perfect} cents, ${notes.length - sung.length} missed.`;
  plot.append(tip);

  let active = -1;
  let svgEl: SVGSVGElement | null = null;
  let centers: number[] = [];

  const describe = (n: NoteResult): string => {
    const lyric = n.lyric ? `“${n.lyric.replace(/-$/, '')}” · ` : '';
    if (n.judgment === 'miss') return `${lyric}${nn(n.midi)} · Missed`;
    const c = Math.round(n.biasCents);
    const dir = Math.abs(c) <= THRESHOLDS.perfect ? 'centered' : c > 0 ? `${c} cents sharp` : `${-c} cents flat`;
    return `${lyric}${nn(n.midi)} · ${LABEL[n.judgment]} · ${dir}`;
  };

  const show = (i: number) => {
    active = i;
    if (i < 0 || !svgEl) {
      tip.style.opacity = '0';
      tip.style.left = '0px'; // a faded tooltip must not keep stretching the page
      svgEl?.querySelector('.dev-cursor')?.setAttribute('opacity', '0');
      return;
    }
    tip.textContent = describe(notes[i]!);
    tip.style.opacity = '1';
    const x = centers[i]!;
    const w = plot.clientWidth;
    tip.style.left = `${Math.max(8, Math.min(w - tip.offsetWidth - 8, x - tip.offsetWidth / 2))}px`;
    const cursor = svgEl.querySelector('.dev-cursor');
    cursor?.setAttribute('x', String(x - 0.5));
    cursor?.setAttribute('opacity', '1');
  };

  const render = () => {
    const width = plot.clientWidth;
    if (!width || !notes.length) return;
    const first = notes[0]!;
    const last = notes[notes.length - 1]!;
    const b0 = first.start;
    const b1 = last.start + last.beats;
    const plotW = width - LEFT - RIGHT;
    const plotH = HEIGHT - TOP - AXIS_BAND;
    const mid = TOP + plotH / 2;
    const half = plotH / 2;
    const x = (beat: number) => LEFT + ((beat - b0) / (b1 - b0)) * plotW;
    const y = (c: number) => mid - (Math.max(-DOMAIN, Math.min(DOMAIN, c)) / DOMAIN) * half;

    const parts: string[] = [];
    // Perfect band wash and hairline grid.
    parts.push(`<rect x="${LEFT}" y="${y(THRESHOLDS.perfect)}" width="${plotW}" height="${y(-THRESHOLDS.perfect) - y(THRESHOLDS.perfect)}" fill="rgba(61,255,162,0.07)"/>`);
    for (const c of [THRESHOLDS.good, THRESHOLDS.great, -THRESHOLDS.great, -THRESHOLDS.good]) {
      parts.push(`<line x1="${LEFT}" x2="${LEFT + plotW}" y1="${y(c)}" y2="${y(c)}" stroke="rgba(255,255,255,0.07)" stroke-width="1" shape-rendering="crispEdges"/>`);
      parts.push(`<text x="${LEFT - 8}" y="${y(c) + 4}" text-anchor="end" class="dev-tick">${c > 0 ? '+' : '−'}${Math.abs(c)}</text>`);
    }
    parts.push(`<text x="${LEFT - 8}" y="${mid + 4}" text-anchor="end" class="dev-tick">0</text>`);
    // Axis captions live in the left gutter so they never collide with section names.
    parts.push(`<text x="0" y="${TOP - 4}" class="dev-axis">Sharp ↑</text>`);
    parts.push(`<text x="0" y="${TOP + plotH + 12}" class="dev-axis">Flat ↓</text>`);

    // Section dividers and names.
    const secs = song.sections.filter((s) => s.noteTo > first.index && s.noteFrom <= last.index);
    secs.forEach((s, i) => {
      const sx = x(Math.max(b0, s.startBeat));
      const ex = i + 1 < secs.length ? x(Math.max(b0, secs[i + 1]!.startBeat)) : LEFT + plotW;
      if (i > 0) parts.push(`<line x1="${sx}" x2="${sx}" y1="${TOP}" y2="${TOP + plotH}" stroke="rgba(255,255,255,0.10)" stroke-width="1" shape-rendering="crispEdges"/>`);
      const maxChars = Math.floor((ex - sx - 8) / 6.4);
      if (maxChars >= 4) {
        const name = s.name.length > maxChars ? `${s.name.slice(0, maxChars - 1)}…` : s.name;
        parts.push(`<text x="${sx + 4}" y="${HEIGHT - 8}" class="dev-sec">${escapeXml(name)}</text>`);
      }
    });

    // Bars.
    centers = notes.map((n) => x(n.start + n.beats / 2));
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      const span = x(n.start + n.beats) - x(n.start);
      const bw = Math.max(3, Math.min(12, span - 2));
      const cx = centers[i]!;
      if (n.judgment === 'miss' || !Number.isFinite(n.biasCents)) {
        parts.push(`<circle cx="${cx}" cy="${mid}" r="4" fill="none" stroke="${COLORS.miss}" stroke-width="2"/>`);
        continue;
      }
      const color = judgmentColor(n.judgment);
      const c = n.biasCents;
      const len = Math.max(2, Math.abs(y(c) - mid));
      parts.push(`<path d="${barPath(cx - bw / 2, mid, bw, len, c >= 0)}" fill="${color}"/>`);
      if (Math.abs(c) > DOMAIN) {
        const ty = c > 0 ? y(DOMAIN) - 4 : y(-DOMAIN) + 4;
        const d = c > 0 ? -5 : 5;
        parts.push(`<path d="M${cx - 4},${ty} L${cx + 4},${ty} L${cx},${ty + d} Z" fill="${color}"/>`);
      }
    }
    parts.push(`<line x1="${LEFT}" x2="${LEFT + plotW}" y1="${mid}" y2="${mid}" stroke="rgba(255,255,255,0.28)" stroke-width="1" shape-rendering="crispEdges"/>`);
    parts.push(`<rect class="dev-cursor" x="0" y="${TOP}" width="1" height="${plotH}" fill="rgba(255,255,255,0.45)" opacity="0"/>`);

    plot.querySelector('svg')?.remove();
    plot.insertAdjacentHTML(
      'afterbegin',
      `<svg width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" tabindex="0" aria-label="Sharp and flat deviation per note. ${escapeXml(summary)} Use the left and right arrow keys to step through notes.">${parts.join('')}</svg>`,
    );
    svgEl = plot.querySelector('svg');
    if (active >= 0) show(active);
  };

  // Nearest-note hover so thin bars still have a generous hit area.
  const nearest = (clientX: number) => {
    const rect = plot.getBoundingClientRect();
    const px = clientX - rect.left;
    if (px < LEFT - 6) return -1;
    let best = -1;
    let bd = Infinity;
    centers.forEach((c, i) => {
      const d = Math.abs(c - px);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };
  plot.addEventListener('pointermove', (e) => show(nearest(e.clientX)));
  plot.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
  plot.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') show(-1);
  });
  plot.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = active < 0 ? 0 : Math.max(0, Math.min(notes.length - 1, active + (e.key === 'ArrowRight' ? 1 : -1)));
    show(next);
  });
  plot.addEventListener('focusout', () => show(-1));

  const ro = new ResizeObserver(() => render());
  ro.observe(plot);

  const legendItem = (color: string, text: string, hollow = false) =>
    h('span', null, h('i', { style: hollow ? `box-shadow:inset 0 0 0 2px ${color}` : `background:${color}` }), text);

  const table = h(
    'table',
    { class: 'dev-table' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Lyric'), h('th', null, 'Note'), h('th', null, 'Result'), h('th', null, 'Cents'), h('th', null, 'Sung'))),
    h(
      'tbody',
      null,
      ...notes.map((n, i) =>
        h(
          'tr',
          null,
          h('td', null, String(i + 1)),
          h('td', null, n.lyric.replace(/-$/, '') || '·'),
          h('td', null, nn(n.midi)),
          h('td', null, LABEL[n.judgment]),
          h('td', null, Number.isFinite(n.biasCents) && n.judgment !== 'miss' ? `${n.biasCents > 0 ? '+' : ''}${Math.round(n.biasCents)}` : '–'),
          h('td', null, `${Math.round(n.coverage * 100)}%`),
        ),
      ),
    ),
  );

  return h(
    'div',
    { class: 'dev' },
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
      h('div', null, h('div', { class: 'panel-title', style: 'margin:0' }, 'Sharp / flat timeline'), h('div', { class: 'faint tiny' }, 'Each bar is one note: up is sharp, down is flat, height is how far (cents). Green band = within ±10.')),
      h(
        'div',
        { class: 'legend' },
        legendItem('var(--perfect)', 'Perfect ±10'),
        legendItem('var(--great)', 'Great ±25'),
        legendItem('var(--good)', 'Good ±50'),
        legendItem('var(--off)', 'Off'),
        legendItem('var(--miss)', 'Missed', true),
      ),
    ),
    plot,
    h('div', { class: 'faint tiny', style: 'margin-top:6px' }, summary),
    h('details', { class: 'dev-details' }, h('summary', null, 'Show as table'), h('div', { class: 'dev-table-wrap' }, table)),
  );
}

/** Bar from the baseline with a 4px rounded data end and a square baseline end. */
function barPath(x: number, base: number, w: number, len: number, up: boolean): string {
  const r = Math.min(4, w / 2, len);
  if (up) {
    const top = base - len;
    return `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${base} Z`;
  }
  const bot = base + len;
  return `M${x},${base} L${x},${bot - r} Q${x},${bot} ${x + r},${bot} L${x + w - r},${bot} Q${x + w},${bot} ${x + w},${bot - r} L${x + w},${base} Z`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
