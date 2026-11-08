import { keyName, keyPrefersFlats, noteNameWithOctave } from '../../core/music';
import { THRESHOLDS, pitchInsights, weakestSection, type Counts, type Judgment, type NoteResult, type PitchInsight } from '../../core/scoring';
import type { Song } from '../../core/song';
import type { AttemptRecord } from '../../core/storage';
import type { App, PlayConfig, Route, Screen } from '../app';
import { backButton, fmtInt, h } from '../dom';
import type { TrailPt } from '../render/highway';
import { sparkline } from './songs';

export interface ReplayData {
  trail: TrailPt[];
  judgments: (Judgment | undefined)[];
  result: AttemptResult;
}

export interface AttemptResult {
  config: PlayConfig;
  /** The (transposed) song as it was sung. */
  song: Song;
  score: number;
  accuracy: number;
  timing: number;
  bestStreak: number;
  grade: string;
  counts: Counts;
  notes: NoteResult[];
  noteFrom: number;
  noteTo: number;
  passes: number[];
  previousBest: AttemptRecord | null;
  isNewBest: boolean;
  countsTowardBest: boolean;
  replay: ReplayData | undefined;
}

const LABEL: Record<Judgment, string> = { perfect: 'Perfect', great: 'Great', good: 'Good', off: 'Off', miss: 'Missed' };

export function resultsScreen(app: App, route: Route): Screen {
  if (route.name !== 'results') throw new Error('bad route');
  const r = route.result;
  const song = r.song;
  const flats = keyPrefersFlats(song.tonicPc, song.mode);
  const nn = (m: number) => noteNameWithOctave(m, flats);
  const progress = app.store.progress(r.config.songId);
  const base = app.songById(r.config.songId);

  const scoreEl = h('div', { class: 'score-line' }, '0');
  let raf = 0;
  const t0 = performance.now();
  const count = () => {
    const k = Math.min(1, (performance.now() - t0) / 900);
    const e = 1 - Math.pow(1 - k, 3);
    scoreEl.textContent = fmtInt(r.score * e);
    if (k < 1) raf = requestAnimationFrame(count);
  };
  raf = requestAnimationFrame(count);

  let bestLine: HTMLElement;
  if (!r.countsTowardBest) {
    bestLine = h('div', { class: 'muted' }, `Practice run (${Math.round(r.config.speed * 100)}% speed) · high scores count full-speed song runs`);
  } else if (r.isNewBest && r.previousBest) {
    bestLine = h('div', { class: 'chip ok', style: 'font-size:14px' }, `New high score! +${fmtInt(r.score - r.previousBest.score)} over ${fmtInt(r.previousBest.score)}`);
  } else if (r.isNewBest) {
    bestLine = h('div', { class: 'chip ok', style: 'font-size:14px' }, 'First high score set');
  } else {
    const prev = r.previousBest!;
    bestLine = h('div', { class: 'muted' }, `High score ${fmtInt(prev.score)} (${Math.round(prev.accuracy)}%) · ${fmtInt(prev.score - r.score)} to beat it`);
  }

  // Practice weak section: the weakest section among those sung in this attempt.
  const scoredSong = { ...song, sections: song.sections.filter((s) => s.noteFrom < r.noteTo && s.noteTo > r.noteFrom) };
  const weakLocal = scoredSong.sections.length ? weakestSection(scoredSong, r.notes) : -1;
  const weakIdx = weakLocal >= 0 ? song.sections.indexOf(scoredSong.sections[weakLocal]!) : -1;
  const weakSec = weakIdx >= 0 ? song.sections[weakIdx]! : null;

  const tryAgain = () => app.go({ name: 'play', config: { ...r.config } });
  const watch = () => r.replay && app.go({ name: 'play', config: { ...r.config, loop: false, replay: r.replay } });
  const practiceWeak = () =>
    weakIdx >= 0 &&
    app.go({ name: 'play', config: { ...r.config, mode: 'practice', section: weakIdx, speed: 0.75, loop: true, guide: true, backing: true } });

  const ins = pitchInsights(r.notes);
  const total = r.notes.length;
  const hit = r.counts.perfect + r.counts.great + r.counts.good;

  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'songs', selectId: r.config.songId }), 'Songs'), h('div', { class: 'spacer' })),
    h(
      'section',
      { class: 'results-hero' },
      h('div', { class: `big-grade grade-${r.grade}` }, r.grade),
      h(
        'div',
        { class: 'stack', style: 'gap:8px' },
        h('div', { class: 'muted' }, `${song.title}${r.config.section !== null ? ` · ${song.sections[r.config.section]?.name ?? ''}` : ''} · ${keyName(song.tonicPc, song.mode)}${r.config.transpose ? ` (${r.config.transpose > 0 ? '+' : ''}${r.config.transpose})` : ''}`),
        scoreEl,
        bestLine,
      ),
    ),
    h(
      'div',
      { class: 'stat-grid', style: 'margin-top:24px' },
      stat('Pitch accuracy', `${Math.round(r.accuracy)}%`),
      stat('Timing accuracy', `${Math.round(r.timing)}%`),
      stat('Best streak', String(r.bestStreak)),
      stat('Notes hit', `${hit}/${total}`),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:12px;gap:8px' },
      ...(['perfect', 'great', 'good', 'off', 'miss'] as Judgment[]).map((j) =>
        h('span', { class: 'chip' }, h('i', { class: 'dot', style: `color:var(--${j === 'miss' ? 'miss' : j})` }), `${LABEL[j]} ${r.counts[j]}`),
      ),
      r.passes.length > 1 ? h('span', { class: 'chip accent' }, `Passes: ${r.passes.map((p) => `${Math.round(p)}%`).join(' → ')}`) : null,
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:22px' },
      h('button', { class: 'btn primary big', onclick: tryAgain }, 'Try Again'),
      r.replay ? h('button', { class: 'btn big', onclick: watch, title: 'Watch your run with the guide melody' }, 'Replay Song') : null,
      weakSec ? h('button', { class: 'btn big', onclick: practiceWeak }, `Practice Weak Section: ${weakSec.name}`) : null,
    ),
    h(
      'div',
      { class: 'card', style: 'margin-top:22px' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' }, h('div', { class: 'panel-title', style: 'margin:0' }, 'Note by note'), legend()),
      ...timelineRows(song, r, nn),
    ),
    h(
      'div',
      { class: 'two-col', style: 'margin-top:14px' },
      h('div', { class: 'card' }, h('div', { class: 'panel-title' }, 'Notes you nailed'), ...(ins.nailed.length ? ins.nailed.map((p) => insightRow(p, nn, true)) : [h('div', { class: 'muted small' }, 'Keep going: no pitch was consistently above 85% yet.')])),
      h('div', { class: 'card' }, h('div', { class: 'panel-title' }, 'Notes you struggled with'), ...(ins.struggled.length ? ins.struggled.map((p) => insightRow(p, nn, false)) : [h('div', { class: 'muted small' }, 'Nothing stood out. Every pitch was close.')])),
    ),
    progress.attempts.length >= 2 ? h('div', { class: 'card', style: 'margin-top:14px' }, sparkline(progress.attempts)) : null,
    base && base.pdNote ? h('p', { class: 'faint tiny', style: 'margin-top:18px' }, base.pdNote) : null,
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') tryAgain();
  };
  window.addEventListener('keydown', onKey);
  return {
    el,
    destroy: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    },
  };
}

function stat(label: string, value: string): HTMLElement {
  return h('div', { class: 'stat' }, h('span', { class: 'hud-label' }, label), h('b', null, value));
}

function legend(): HTMLElement {
  const item = (c: string, t: string) => h('span', null, h('i', { style: `background:${c}` }), t);
  return h(
    'div',
    { class: 'legend' },
    item('var(--perfect)', 'Perfect'),
    item('var(--great)', 'Great'),
    item('var(--good)', 'Good'),
    item('var(--off)', 'Off'),
    h('span', null, h('i', { style: 'box-shadow:inset 0 0 0 2px var(--miss)' }), 'Missed'),
    h('span', null, '↑ sharp  ↓ flat'),
  );
}

function timelineRows(song: Song, r: AttemptResult, nn: (m: number) => string): HTMLElement[] {
  const byIndex = new Map(r.notes.map((n) => [n.index, n]));
  const rows: HTMLElement[] = [];
  for (const sec of song.sections) {
    if (sec.noteTo <= r.noteFrom || sec.noteFrom >= r.noteTo) continue;
    const dots: HTMLElement[] = [];
    for (let i = Math.max(sec.noteFrom, r.noteFrom); i < Math.min(sec.noteTo, r.noteTo); i++) {
      const n = byIndex.get(i);
      if (!n) continue;
      const bias = n.biasCents;
      const dir = Number.isFinite(bias) && Math.abs(bias) > THRESHOLDS.perfect ? (bias > 0 ? '↑' : '↓') : '';
      const lyric = n.lyric ? `"${n.lyric.replace(/-$/, '')}" · ` : '';
      const detail =
        n.judgment === 'miss'
          ? 'not sung'
          : `${Math.round(Math.abs(bias))} cents ${bias > 0 ? 'sharp' : 'flat'} · ${Math.round(n.accuracy * 100)}%${n.onset !== null ? ` · entered ${Math.round(n.onset * 1000)} ms ${n.onset >= 0 ? 'after' : 'before'} the beat` : ''}`;
      dots.push(h('span', { class: `tdot ${n.judgment}`, title: `${lyric}${nn(n.midi)} · ${LABEL[n.judgment]} · ${detail}` }, h('span', { class: 'dir' }, dir)));
    }
    const acc = r.notes.filter((n) => n.index >= sec.noteFrom && n.index < sec.noteTo);
    const pct = acc.length ? Math.round((100 * acc.reduce((s, n) => s + n.accuracy * n.beats, 0)) / acc.reduce((s, n) => s + n.beats, 0)) : 0;
    rows.push(
      h(
        'div',
        { class: 'timeline-row' },
        h('div', null, h('div', { style: 'font-weight:600' }, sec.name), h('div', { class: 'faint tiny' }, `${pct}%`)),
        h('div', { class: 'timeline-dots' }, ...dots),
      ),
    );
  }
  return rows;
}

function insightRow(p: PitchInsight, nn: (m: number) => string, good: boolean): HTMLElement {
  const bias = p.bias;
  const dirText = !Number.isFinite(bias)
    ? 'not sung'
    : Math.abs(bias) <= THRESHOLDS.perfect
      ? 'centered'
      : `${Math.round(Math.abs(bias))} cents ${bias > 0 ? 'sharp ↑' : 'flat ↓'}`;
  const color = good ? 'var(--perfect)' : Number.isFinite(bias) && Math.abs(bias) > THRESHOLDS.great ? 'var(--off)' : 'var(--good)';
  return h(
    'div',
    { class: 'insight' },
    h('span', { class: 'note', style: `color:${color}` }, nn(p.midi)),
    h('div', { class: 'grow' }, h('div', null, `${Math.round(p.accuracy * 100)}% · ${dirText}`), p.lyrics.length ? h('div', { class: 'faint tiny' }, `on “${p.lyrics.join('”, “')}”`) : null),
    h('span', { class: 'faint tiny' }, `${p.count}×`),
  );
}
