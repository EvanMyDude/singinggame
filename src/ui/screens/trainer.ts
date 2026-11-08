import { chime, previewNote } from '../../audio/synth';
import { centsError, intervalName, noteNameWithOctave } from '../../core/music';
import { THRESHOLDS, zoneFor } from '../../core/scoring';
import type { App, Screen } from '../app';
import { backButton, fmtInt, h, segmented, toggle } from '../dom';
import { COLORS, zoneColor } from '../render/colors';
import { TunerView } from '../render/tuner';

type Exercise = 'notes' | 'intervals';
type Level = 'easy' | 'medium' | 'hard';
type Dir = 'up' | 'down' | 'both';

const INTERVALS: Record<Level, number[]> = {
  easy: [3, 4, 7, 12],
  medium: [2, 3, 4, 5, 7, 9, 12],
  hard: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};
const ROUNDS = 10;
const LOCK_SECONDS = 0.7;
const TIME_LIMIT = 7;

interface Round {
  targets: number[];
  label: string;
}

export function trainerScreen(app: App): Screen {
  let exercise: Exercise = 'notes';
  let level: Level = 'easy';
  let dir: Dir = 'up';
  let hearFirst = true;
  const body = h('div', { class: 'stack' });
  let cleanup: (() => void) | null = null;

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:860px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' })), h('h2', { style: 'font-size:22px' }, 'Pitch Trainer'), h('div', { class: 'spacer' })),
    body,
  );

  const range = () => app.store.data.range ?? { low: 48, high: 67 };

  const makeRound = (): Round => {
    const r = range();
    const lo = Math.ceil(r.low + 1);
    const hi = Math.floor(r.high - 1);
    const pick = (a: number, b: number) => a + Math.floor(Math.random() * Math.max(1, b - a + 1));
    if (exercise === 'notes') {
      const m = pick(lo, hi);
      return { targets: [m], label: 'Match this note' };
    }
    const ivs = INTERVALS[level];
    for (let tries = 0; tries < 50; tries++) {
      const iv = ivs[Math.floor(Math.random() * ivs.length)]!;
      const up = dir === 'up' ? true : dir === 'down' ? false : Math.random() < 0.5;
      const a = pick(lo, hi);
      const b = a + (up ? iv : -iv);
      if (b >= lo && b <= hi) return { targets: [a, b], label: `${intervalName(iv)} ${up ? 'up' : 'down'}` };
    }
    const a = pick(lo, hi - 4);
    return { targets: [a, a + 4], label: 'Major 3rd up' };
  };

  const setup = () => {
    cleanup?.();
    const best = app.store.data.trainer[`${exercise}:${level}:${dir}`];
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('p', { class: 'muted', style: 'margin:0' }, 'Hear a note, then sing it and hold it inside the green band until it locks. Ten rounds. Faster and closer locks score more.'),
        h('div', { class: 'row' }, h('span', { class: 'field-label', style: 'min-width:80px' }, 'Exercise'), segmented([{ value: 'notes' as Exercise, label: 'Single notes' }, { value: 'intervals' as Exercise, label: 'Intervals' }], exercise, (v) => { exercise = v; setup(); }, 'Exercise')),
        exercise === 'intervals'
          ? h(
              'div',
              { class: 'stack', style: 'gap:12px' },
              h('div', { class: 'row' }, h('span', { class: 'field-label', style: 'min-width:80px' }, 'Intervals'), segmented([{ value: 'easy' as Level, label: '3rds, 5th, octave' }, { value: 'medium' as Level, label: '+ 2nds, 4th, 6th' }, { value: 'hard' as Level, label: 'All' }], level, (v) => { level = v; setup(); }, 'Interval set')),
              h('div', { class: 'row' }, h('span', { class: 'field-label', style: 'min-width:80px' }, 'Direction'), segmented([{ value: 'up' as Dir, label: 'Up' }, { value: 'down' as Dir, label: 'Down' }, { value: 'both' as Dir, label: 'Both' }], dir, (v) => { dir = v; setup(); }, 'Direction')),
              toggle('Play both notes first (off: hear only the first and find the second yourself)', hearFirst, (v) => (hearFirst = v)),
            )
          : null,
        h('div', { class: 'faint small' }, `Notes are drawn from ${noteNameWithOctave(range().low)}–${noteNameWithOctave(range().high)}${app.store.data.range ? ' (your range)' : ' (default range; run the range check for yours)'}.${best ? ` Best: ${fmtInt(best.score)}.` : ''}`),
        h('div', { class: 'row' }, h('button', { class: 'btn primary big', onclick: () => void start() }, 'Start')),
      ),
    );
  };

  const start = async () => {
    cleanup?.();
    if (!app.micReady) {
      const err = await app.openMic();
      if (err) {
        body.replaceChildren(h('div', { class: 'notice bad' }, err), h('button', { class: 'btn', onclick: setup }, 'Back'));
        return;
      }
    }
    const rt = app.rt();
    const fold = app.store.settings.foldOctaves;
    const canvas = h('canvas', { class: 'tuner-canvas', style: 'height:340px' });
    const tuner = new TunerView(canvas, { spanSemitones: 8 });
    const roundEl = h('span', { class: 'num' });
    const scoreEl = h('span', { class: 'num' }, '0');
    const streakEl = h('span', { class: 'num' }, '0');
    const prompt = h('h3', { style: 'font-size:26px' });
    const sub = h('div', { class: 'muted' });
    const hint = h('div', { style: 'font-family:var(--font-display);font-weight:700;font-size:20px;min-height:28px' });
    const lockBar = h('i', { style: 'display:block;height:100%;width:0;background:var(--perfect);border-radius:999px;box-shadow:0 0 14px rgba(61,255,162,.6)' });
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between' },
          h('div', null, prompt, sub),
          h(
            'div',
            { class: 'row', style: 'gap:22px' },
            h('div', null, h('div', { class: 'hud-label' }, 'Round'), roundEl),
            h('div', null, h('div', { class: 'hud-label' }, 'Score'), scoreEl),
            h('div', null, h('div', { class: 'hud-label' }, 'Streak'), streakEl),
          ),
        ),
        canvas,
        h('div', { class: 'meter', style: 'height:8px' }, lockBar),
        h('div', { class: 'row' }, hint, h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: () => replayTone() }, 'Hear again ', h('span', { class: 'kbd' }, 'R')), h('button', { class: 'btn ghost', onclick: () => skip() }, 'Skip')),
      ),
    );

    let round = 0;
    let score = 0;
    let streak = 0;
    let bestStreak = 0;
    let locked = 0;
    const errors: number[] = [];
    let cur: Round = makeRound();
    let ti = 0;
    let phase: 'listen' | 'sing' | 'between' = 'listen';
    let lockT = 0;
    let singStart = 0;
    let lastT = 0;
    let offSince = 0;
    let offSign = 0;
    let lockErrs: number[] = [];
    let timer: number | null = null;

    const target = () => cur.targets[ti]!;
    const replayTone = () => {
      if (phase !== 'sing') return;
      previewNote(rt.engine, target(), 0.9);
    };
    const nextRound = () => {
      round++;
      if (round > ROUNDS) return done();
      cur = makeRound();
      ti = 0;
      roundEl.textContent = `${round}/${ROUNDS}`;
      listen();
    };
    const listen = () => {
      phase = 'listen';
      tuner.setTarget(null);
      prompt.textContent = 'Listen…';
      sub.textContent = cur.targets.length > 1 ? cur.label : '';
      hint.textContent = '';
      lockBar.style.width = '0';
      const t = rt.engine.ctx.currentTime + 0.1;
      previewNote(rt.engine, cur.targets[0]!, 0.85, t);
      let wait = 1.0;
      if (cur.targets.length > 1 && hearFirst) {
        previewNote(rt.engine, cur.targets[1]!, 0.85, t + 1.0);
        wait = 2.0;
      }
      timer = window.setTimeout(() => sing(), wait * 1000 + 150);
    };
    const sing = () => {
      phase = 'sing';
      lockT = 0;
      lockErrs = [];
      singStart = rt.engine.ctx.currentTime;
      tuner.setTarget(target(), fold);
      // Used by automated tests (synthetic singer) and debugging.
      window.dispatchEvent(new CustomEvent('pitchline:target', { detail: { midi: target() } }));
      tuner.clear();
      if (cur.targets.length > 1) {
        prompt.textContent = ti === 0 ? 'Sing the first note' : `Now the ${cur.label}`;
        sub.textContent = ti === 0 ? `${cur.label}, starting here` : hearFirst ? 'You heard it a moment ago' : 'Find it from the first note';
      } else {
        prompt.textContent = 'Sing it and hold';
        sub.textContent = 'Keep the line inside the green band';
      }
    };
    const resolve = (ok: boolean) => {
      phase = 'between';
      const t = target();
      if (ok) {
        const med = lockErrs.sort((a, b) => Math.abs(a) - Math.abs(b))[lockErrs.length >> 1] ?? 0;
        const elapsed = rt.engine.ctx.currentTime - singStart;
        const pts = Math.round(Math.max(20, 100 - Math.abs(med) * 1.6) + Math.max(0, 50 * (1 - (elapsed - LOCK_SECONDS) / 3)));
        score += pts * (1 + Math.min(streak, 10) * 0.1);
        errors.push(Math.abs(med));
        chime(rt.engine, 84);
        hint.style.color = COLORS.perfect;
        hint.textContent = `Locked · ${Math.round(Math.abs(med))} cents ${med > 0 ? 'sharp' : med < 0 ? 'flat' : ''} · +${pts}`;
      } else {
        streak = 0;
        hint.style.color = COLORS.off;
        hint.textContent = `Missed: it was ${noteNameWithOctave(t)}`;
        previewNote(rt.engine, t, 0.7);
      }
      scoreEl.textContent = fmtInt(score);
      const lastTarget = ti >= cur.targets.length - 1;
      if (ok && lastTarget) {
        streak++;
        locked++;
        bestStreak = Math.max(bestStreak, streak);
      }
      streakEl.textContent = String(streak);
      timer = window.setTimeout(() => {
        if (ok && !lastTarget) {
          ti++;
          sing();
        } else nextRound();
      }, ok ? 900 : 1300);
    };
    const skip = () => {
      if (phase === 'sing') resolve(false);
    };

    const off = rt.onFrame((f) => {
      tuner.push(f);
      if (phase !== 'sing') return;
      const dt = lastT ? Math.min(0.05, f.time - lastT) : 0;
      lastT = f.time;
      if (f.time - singStart > TIME_LIMIT) return resolve(false);
      if (!f.voiced) {
        lockT = Math.max(0, lockT - dt * 0.5);
      } else {
        const c = centsError(f.midi, target(), fold);
        const abs = Math.abs(c);
        if (abs <= THRESHOLDS.great) {
          lockT += dt;
          lockErrs.push(c);
        } else lockT = Math.max(0, lockT - dt);
        if (abs > THRESHOLDS.great) {
          const s = Math.sign(c);
          if (s !== offSign) {
            offSign = s;
            offSince = f.time;
          }
          if (f.time - offSince > 0.15) {
            hint.style.color = zoneColor(zoneFor(abs));
            hint.textContent = s > 0 ? 'Too sharp ↑' : 'Too flat ↓';
          }
        } else {
          offSign = 0;
          hint.style.color = zoneColor(zoneFor(abs));
          hint.textContent = abs <= THRESHOLDS.perfect ? 'Perfect, hold it' : 'Close, hold it';
        }
      }
      lockBar.style.width = `${Math.min(1, lockT / LOCK_SECONDS) * 100}%`;
      if (lockT >= LOCK_SECONDS) resolve(true);
    });
    let raf = 0;
    const draw = () => {
      tuner.draw(rt.engine.ctx.currentTime);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') replayTone();
    };
    window.addEventListener('keydown', onKey);

    const done = () => {
      cleanup?.();
      cleanup = null;
      const key = `${exercise}:${level}:${dir}`;
      const isBest = app.store.recordTrainer(key, Math.round(score));
      const avg = errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : NaN;
      body.replaceChildren(
        h(
          'div',
          { class: 'card stack', style: 'text-align:center;padding:32px' },
          h('div', { class: 'panel-title' }, exercise === 'notes' ? 'Single notes' : `Intervals · ${level}`),
          h('div', { class: 'score-line' }, fmtInt(score)),
          isBest ? h('div', null, h('span', { class: 'chip ok' }, 'New best')) : null,
          h(
            'div',
            { class: 'stat-grid', style: 'text-align:left' },
            h('div', { class: 'stat' }, h('span', { class: 'hud-label' }, 'Locked'), h('b', null, `${locked}/${ROUNDS}`)),
            h('div', { class: 'stat' }, h('span', { class: 'hud-label' }, 'Avg error'), h('b', null, Number.isFinite(avg) ? `${Math.round(avg)}¢` : '–')),
            h('div', { class: 'stat' }, h('span', { class: 'hud-label' }, 'Best streak'), h('b', null, String(bestStreak))),
            h('div', { class: 'stat' }, h('span', { class: 'hud-label' }, 'Grade'), h('b', null, locked >= 9 ? 'S' : locked >= 8 ? 'A' : locked >= 6 ? 'B' : locked >= 4 ? 'C' : 'D')),
          ),
          h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn', onclick: setup }, 'Change exercise'), h('button', { class: 'btn primary big', onclick: () => void start() }, 'Go again')),
        ),
      );
    };

    cleanup = () => {
      off();
      cancelAnimationFrame(raf);
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
    await rt.engine.resume();
    nextRound();
  };

  setup();
  return { el, destroy: () => cleanup?.() };
}
