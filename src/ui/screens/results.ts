import { keyPrefersFlats, noteNameWithOctave } from '../../core/music';
import { detectedVocalCoverage, fmtSpan, fmtTime, sectionTargetCoverage, targetCoverage, type SectionSpec } from '../../core/melody';
import { timedPhraseInsights, type TimedLyricLine, type TimedLineInsight } from '../../core/phraseInsights';
import { THRESHOLDS, pitchInsights, weakestSection, type Counts, type Judgment, type NoteResult, type PitchInsight } from '../../core/scoring';
import type { Song } from '../../core/song';
import type { AttemptRecord } from '../../core/storage';
import type { App, Route, Screen, SessionConfig } from '../app';
import { backButton, fmtInt, h } from '../dom';
import { deviationTimeline } from '../render/deviation';

export interface AttemptResult {
  config: SessionConfig;
  song: Song;
  sections: SectionSpec[];
  /** Length of the track (s). */
  duration: number;
  detectedVocalSeconds?: number;
  /** Actual lyric windows for this attempt; never persisted with high scores. */
  lyricLines: TimedLyricLine[] | null;
  score: number;
  accuracy: number;
  timing: number;
  bestStreak: number;
  grade: string;
  counts: Counts;
  notes: NoteResult[];
  previousBest: AttemptRecord | null;
  isNewBest: boolean;
}

const LABEL: Record<Judgment, string> = { perfect: 'Perfect', great: 'Great', good: 'Good', off: 'Off', miss: 'Missed' };

export function resultsScreen(app: App, route: Route): Screen {
  if (route.name !== 'results') throw new Error('bad route');
  const r = route.result;
  const song = r.song;
  const flats = keyPrefersFlats(song.tonicPc, song.mode);
  const nn = (m: number) => noteNameWithOctave(m, flats);
  const progress = app.store.progress(song.id);
  const fullRuns = progress.attempts.filter((a) => a.mode === 'sing' && a.speed === 1);

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
  if (r.isNewBest && r.previousBest) {
    bestLine = h('div', { class: 'chip ok', style: 'font-size:14px;align-self:flex-start' }, `New high score! +${fmtInt(r.score - r.previousBest.score)} over ${fmtInt(r.previousBest.score)}`);
  } else if (r.isNewBest) {
    bestLine = h('div', { class: 'chip ok', style: 'font-size:14px;align-self:flex-start' }, 'First high score set');
  } else if (r.previousBest) {
    const prev = r.previousBest;
    bestLine = h('div', { class: 'muted' }, `High score ${fmtInt(prev.score)} (${Math.round(prev.accuracy)}%) · ${fmtInt(prev.score - r.score)} to beat it`);
  } else bestLine = h('div');

  const weakIdx = song.sections.length > 1 ? weakestSection(song, r.notes) : -1;
  const weak = weakIdx >= 0 ? r.sections[weakIdx] ?? null : null;

  const tryAgain = () => void app.startSession({ mode: 'sing' });
  const practiceWeak = () => weak && void app.startSession({ mode: 'practice', startAt: weak.start, loop: { a: weak.start, b: weak.end } });

  const ins = pitchInsights(r.notes);
  const phrases = timedPhraseInsights(song, r.notes, r.lyricLines);
  const onsets = r.notes.map((n) => n.onset).filter((o): o is number => o !== null).sort((a, b) => a - b);
  const medianOnset = onsets.length >= 5 ? onsets[onsets.length >> 1]! : 0;
  const latencyHint =
    medianOnset > 0.12 && r.timing < 80
      ? h(
          'div',
          { class: 'notice warn row', style: 'margin-top:14px' },
          h('span', { class: 'grow' }, `Your notes started about ${Math.round(medianOnset * 1000)} ms late on average. If that felt on time to you, your audio setup has extra delay; calibrating removes it from scoring.`),
          h('button', { class: 'btn', onclick: () => app.go({ name: 'latency', next: { name: 'home' } }) }, 'Calibrate latency'),
        )
      : null;
  const total = r.notes.length;
  // What the grade rests on: targets exist only where the melody could be extracted reliably.
  const cover = targetCoverage(song);
  const vocals = detectedVocalCoverage(song, r.duration, r.detectedVocalSeconds);
  const targetWord = cover.notes === 1 ? 'pitch target' : 'pitch targets';
  const hit = r.counts.perfect + r.counts.great + r.counts.good;

  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' }), 'Home'), h('div', { class: 'spacer' })),
    h(
      'section',
      { class: 'results-hero' },
      h('div', { class: `big-grade grade-${r.grade}` }, r.grade),
      h('div', { class: 'stack', style: 'gap:8px' }, h('div', { class: 'muted' }, `${song.title} · scored on ${cover.notes} ${targetWord}, ${fmtSpan(cover.seconds)} of ${fmtTime(r.duration)}`), scoreEl, bestLine),
    ),
    h(
      'div',
      { class: 'stat-grid', style: 'margin-top:24px' },
      stat('Pitch accuracy (on targets)', `${Math.round(r.accuracy)}%`),
      stat('Timing accuracy (sung targets)', `${Math.round(r.timing)}%`),
      stat('Best streak', String(r.bestStreak)),
      stat('Targets hit', `${hit}/${total}`),
    ),
    h(
      'div',
      { class: 'notice', style: 'margin-top:12px' },
      h('div', null, `Only the ${cover.notes} ${targetWord} are graded. They cover ${fmtSpan(cover.seconds)} of this ${fmtTime(r.duration)} track. Your score reflects the available targets; singing outside them cannot lower your grade.`),
      vocals ? h('div', { style: 'margin-top:6px' }, `About ${Math.round(vocals.percent)}% of detected reference-vocal time has targets. Detected reference vocals: ${fmtSpan(vocals.seconds)}. Recording: ${fmtTime(r.duration)}.`) : null,
      h('div', { class: 'small', style: 'margin-top:6px' }, 'Timing accuracy summarizes sung targets; targets without a sung timing are excluded.'),
    ),
    latencyHint,
    h(
      'div',
      { class: 'row', style: 'margin-top:12px;gap:8px' },
      ...(['perfect', 'great', 'good', 'off', 'miss'] as Judgment[]).map((j) =>
        h('span', { class: 'chip' }, h('i', { class: 'dot', style: `color:var(--${j === 'miss' ? 'miss' : j})` }), `${LABEL[j]} ${r.counts[j]}`),
      ),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top:22px' },
      h('button', { class: 'btn primary big', onclick: tryAgain }, 'Sing Again'),
      weak ? h('button', { class: 'btn big', onclick: practiceWeak }, `Practice weakest scored part: ${weak.name}`) : null,
      h('button', { class: 'btn big', onclick: () => void app.startSession({ mode: 'practice' }) }, 'Practice'),
    ),
    h(
      'div',
      { class: 'two-col', style: 'margin-top:22px' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'panel-title' }, 'What you nailed'),
        phrases.best ? phraseRow(phrases.best, true) : null,
        ...(ins.nailed.length ? ins.nailed.map((p) => insightRow(p, nn, true, song)) : [h('div', { class: 'muted small' }, 'No pitch was clean every time yet. Keep going.')]),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'panel-title' }, 'What you struggled with'),
        phrases.hardest ? phraseRow(phrases.hardest, false) : null,
        ...(ins.struggled.length ? ins.struggled.map((p) => insightRow(p, nn, false, song)) : [h('div', { class: 'muted small' }, 'Nothing stood out. Every pitch was close.')]),
      ),
    ),
    phrases.lines.length
      ? h('details', { class: 'card', style: 'margin-top:14px' },
          h('summary', null, 'Scored lyric lines'),
          h('p', { class: 'muted small' }, 'Accuracy describes assigned pitch targets, not the entire lyric line. Rankings require at least two targets and 0.5 s of target time in each of two lines.'),
          !phrases.best && !phrases.hardest ? h('p', { class: 'muted small' }, 'No best or hardest scored line to report from the available target support and accuracy.') : null,
          ...phrases.lines.map((line) => h('div', { style: 'margin-top:10px' },
            h('div', null, line.text),
            h('div', { class: 'faint tiny' }, `${line.targetCount} ${line.targetCount === 1 ? 'target' : 'targets'} · ${fmtSpan(line.targetSeconds)} · ${line.accuracy === null ? 'unscored' : `${Math.round(line.accuracy * 100)}% on assigned targets`}${line.targetCount && !line.rankable ? ' · insufficient support for ranking' : ''}`),
          )),
        )
      : h('div', { class: 'muted small', style: 'margin-top:14px' }, 'Lyric line insights unavailable without matching lyrics and saved line timing.'),
    h('div', { class: 'card', style: 'margin-top:14px' }, deviationTimeline(song, r.notes, nn)),
    h(
      'div',
      { class: 'card', style: 'margin-top:14px' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' }, h('div', { class: 'panel-title', style: 'margin:0' }, 'Note by note'), legend()),
      ...timelineRows(song, r, nn),
    ),
    fullRuns.length >= 2 ? h('div', { class: 'card', style: 'margin-top:14px' }, sparkline(fullRuns)) : null,
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
  song.sections.forEach((sec, si) => {
    const spec = r.sections[si];
    const span = spec ? fmtSpan(spec.end - spec.start) : '';
    const cov = sectionTargetCoverage(song, sec);
    if (!cov.notes || sec.noteTo <= sec.noteFrom) {
      // A section without targets is shown, not hidden: it was sung but could not be graded.
      rows.push(
        h(
          'div',
          { class: 'timeline-row' },
          h('div', null, h('div', { style: 'font-weight:600' }, sec.name), h('div', { class: 'faint tiny' }, 'Accuracy unavailable'), h('div', { class: 'faint tiny' }, `${fmtSpan(cov.seconds)}${span ? ` of ${span}` : ''}`)),
          h('div', { class: 'faint small' }, cov.notes
            ? 'Continuing target from previous part; no separate note score. 0 targets starting here.'
            : `No pitch targets${span ? ` in this ${span} section` : ''}. Free singing; it does not affect your grade.`),
        ),
      );
      return;
    }
    const dots: HTMLElement[] = [];
    for (let i = sec.noteFrom; i < sec.noteTo; i++) {
      const n = byIndex.get(i);
      if (!n) continue;
      const bias = n.biasCents;
      const dir = Number.isFinite(bias) && Math.abs(bias) > THRESHOLDS.perfect ? (bias > 0 ? '↑' : '↓') : '';
      const detail =
        n.judgment === 'miss'
          ? 'not sung'
          : `${Math.round(Math.abs(bias))} cents ${bias > 0 ? 'sharp' : 'flat'} · ${Math.round(n.accuracy * 100)}%${n.onset !== null ? ` · entered ${Math.round(n.onset * 1000)} ms ${n.onset >= 0 ? 'after' : 'before'} the note` : ''}`;
      dots.push(h('span', { class: `tdot ${n.judgment}`, title: `${nn(n.midi)} · ${LABEL[n.judgment]} · ${detail}` }, h('span', { class: 'dir' }, dir)));
    }
    const acc = r.notes.filter((n) => n.index >= sec.noteFrom && n.index < sec.noteTo);
    const pct = acc.length ? `${Math.round((100 * acc.reduce((s, n) => s + n.accuracy * n.beats, 0)) / acc.reduce((s, n) => s + n.beats, 0))}%` : 'Accuracy unavailable';
    rows.push(
      h(
        'div',
        { class: 'timeline-row' },
        h(
          'div',
          null,
          h('div', { style: 'font-weight:600' }, sec.name),
          h('div', { class: 'faint tiny' }, pct),
          h('div', { class: 'faint tiny' }, `${sec.noteTo - sec.noteFrom} ${sec.noteTo - sec.noteFrom === 1 ? 'target' : 'targets'} starting here`),
          h('div', { class: 'faint tiny' }, `${fmtSpan(cov.seconds)}${span ? ` of ${span}` : ''}`),
        ),
        h('div', { class: 'timeline-dots' }, ...dots),
      ),
    );
  });
  return rows;
}

function insightRow(p: PitchInsight, nn: (m: number) => string, good: boolean, song: Song): HTMLElement {
  const bias = p.bias;
  const dirText = !Number.isFinite(bias)
    ? 'not sung'
    : Math.abs(bias) <= THRESHOLDS.perfect
      ? 'centered'
      : `${Math.round(Math.abs(bias))} cents ${bias > 0 ? 'sharp ↑' : 'flat ↓'}`;
  const color = good ? 'var(--perfect)' : Number.isFinite(bias) && Math.abs(bias) > THRESHOLDS.great ? 'var(--off)' : 'var(--good)';
  const where = [...new Set(p.indices.map((i) => song.sections.find((s) => i >= s.noteFrom && i < s.noteTo)?.name).filter(Boolean))];
  const context = !good && where.length ? `in ${where.slice(0, 2).join(', ')}` : '';
  return h(
    'div',
    { class: 'insight' },
    h('span', { class: 'note', style: `color:${color}` }, nn(p.midi)),
    h('div', { class: 'grow' }, h('div', null, `${good ? `${Math.round(p.accuracy * 100)}% · ` : ''}${dirText}`), context ? h('div', { class: 'faint tiny' }, context) : null),
    h('span', { class: 'faint tiny' }, good ? `${p.total}×` : `${p.count} of ${p.total}`),
  );
}

function phraseRow(p: TimedLineInsight, good: boolean): HTMLElement {
  const bias = p.bias;
  const dir = !Number.isFinite(bias)
    ? 'mostly not sung'
    : Math.abs(bias) <= THRESHOLDS.perfect
      ? 'centered'
      : `mostly ${bias > 0 ? 'sharp ↑' : 'flat ↓'} (${Math.round(Math.abs(bias))} cents)`;
  return h(
    'div',
    { class: 'insight' },
    h('span', { class: 'note', style: `color:${good ? 'var(--perfect)' : 'var(--off)'};font-size:13px;min-width:86px` }, good ? 'Best scored line' : 'Hardest scored line'),
    h('div', { class: 'grow' }, h('div', null, p.text), h('div', { class: 'faint tiny' }, `${Math.round(p.accuracy! * 100)}% on targets · ${dir}`), h('div', { class: 'faint tiny' }, `${p.targetCount} targets · ${fmtSpan(p.targetSeconds)}`)),
  );
}

export function sparkline(attempts: AttemptRecord[]): HTMLElement {
  const pts = attempts.slice(-15);
  const w = 300;
  const hh = 46;
  const xs = (i: number) => (pts.length === 1 ? w / 2 : (i / (pts.length - 1)) * (w - 8) + 4);
  const ys = (a: number) => hh - 4 - (Math.max(0, Math.min(100, a)) / 100) * (hh - 8);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.accuracy).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const wrap = h('div', null, h('div', { class: 'hud-label', style: 'margin-bottom:4px' }, `Accuracy, last ${pts.length} full runs`));
  wrap.insertAdjacentHTML(
    'beforeend',
    `<svg class="spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none" role="img" aria-label="Accuracy trend"><path d="${d}" fill="none" stroke="#5ee0ff" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`,
  );
  wrap.append(h('div', { class: 'faint tiny' }, `Latest ${Math.round(last.accuracy)}% · best ${Math.round(Math.max(...pts.map((p) => p.accuracy)))}%`));
  return wrap;
}
