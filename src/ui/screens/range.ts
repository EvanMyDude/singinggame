import { noteNameWithOctave } from '../../core/music';
import { RANGE_PRESETS, voiceTypeFor, type VocalRange } from '../../core/range';
import { median } from '../../audio/pitch/tracker';
import type { App, Route, Screen } from '../app';
import { backButton, h } from '../dom';
import { TunerView } from '../render/tuner';
import { flowSteps } from './setup';

const HOLD_SECONDS = 1.2;

export function rangeScreen(app: App, route: Route): Screen {
  const next: Route = (route.name === 'range' && route.next) || { name: 'songs' };
  const body = h('div', { class: 'stack' });
  let cleanup: (() => void) | null = null;

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:820px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' })), h('div', { class: 'spacer' })),
    flowSteps(route, 1),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Vocal range check'),
    h('p', { class: 'muted', style: 'margin:0 0 20px' }, 'Two notes, about 20 seconds. Songs are then moved into a key that suits your voice.'),
    body,
  );

  const finish = (range: VocalRange | null, source: 'measured' | 'preset' | null) => {
    if (range) app.store.setRange(range, source);
    app.store.setOnboarded();
    app.go(next);
  };

  const showPresets = () => {
    cleanup?.();
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'panel-title' }, 'Pick the closest voice'),
        h(
          'div',
          { class: 'choice-grid' },
          ...RANGE_PRESETS.map((p) =>
            h(
              'button',
              { class: 'choice', onclick: () => finish(p.range, 'preset') },
              h('div', { style: 'font-weight:620' }, p.label),
              h('div', { class: 'muted small' }, p.detail),
              h('div', { class: 'faint tiny' }, `${noteNameWithOctave(p.range.low)}–${noteNameWithOctave(p.range.high)}`),
            ),
          ),
        ),
        h('div', { class: 'row' }, h('button', { class: 'btn ghost', onclick: () => void measure() }, 'Measure instead'), h('div', { class: 'grow' }), h('button', { class: 'btn ghost', onclick: () => finish(null, null) }, 'Keep songs in their original keys')),
      ),
    );
  };

  const measure = async () => {
    cleanup?.();
    if (!app.micReady) {
      const err = await app.openMic();
      if (err) {
        body.replaceChildren(h('div', { class: 'notice bad' }, err), h('button', { class: 'btn', onclick: () => void measure() }, 'Try again'));
        return;
      }
    }
    const rt = app.rt();
    const canvas = h('canvas', { class: 'tuner-canvas' });
    const tuner = new TunerView(canvas, { spanSemitones: 16 });
    const prompt = h('h3', { style: 'font-size:22px' });
    const sub = h('p', { class: 'muted', style: 'margin:4px 0 0' });
    const live = h('div', { class: 'big-note num' }, '–');
    const ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 120 120');
    ring.setAttribute('class', 'ring');
    ring.innerHTML = '<circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8"/>';
    ringFg.setAttribute('cx', '60');
    ringFg.setAttribute('cy', '60');
    ringFg.setAttribute('r', '52');
    ringFg.setAttribute('fill', 'none');
    ringFg.setAttribute('stroke', '#5ee0ff');
    ringFg.setAttribute('stroke-width', '8');
    ringFg.setAttribute('stroke-linecap', 'round');
    ringFg.setAttribute('transform', 'rotate(-90 60 60)');
    const circ = 2 * Math.PI * 52;
    ringFg.setAttribute('stroke-dasharray', String(circ));
    ring.appendChild(ringFg);
    const msg = h('div', { class: 'notice', style: 'display:none' });
    const captured = h('div', { class: 'row small muted' });

    body.replaceChildren(
      h('div', { class: 'card stack' }, h('div', null, prompt, sub), h('div', { class: 'row', style: 'gap:24px;align-items:center' }, ring, live, h('div', { class: 'grow' }), captured), canvas, msg),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn ghost', onclick: showPresets }, 'Skip: pick a voice type'),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn ghost', onclick: () => finish(null, null) }, 'Keep original keys'),
      ),
    );

    let step: 'low' | 'high' = 'low';
    let low = NaN;
    let progress = 0;
    let lastT = 0;
    const recent: { t: number; midi: number }[] = [];
    const setStep = (s: 'low' | 'high') => {
      step = s;
      progress = 0;
      recent.length = 0;
      prompt.textContent = s === 'low' ? 'Sing a comfortable LOW note' : 'Now a comfortable HIGH note';
      sub.textContent =
        s === 'low'
          ? 'Not your very lowest: a low note you could hold easily. Sing "ah" and hold it steady.'
          : 'Not a strained top note: a high note that still feels easy. Hold it steady.';
      msg.style.display = 'none';
    };
    setStep('low');

    const off = rt.onFrame((f) => {
      tuner.push(f);
      const dt = lastT ? Math.min(0.05, f.time - lastT) : 0;
      lastT = f.time;
      if (f.voiced) {
        live.textContent = noteNameWithOctave(f.displayMidi);
        recent.push({ t: f.time, midi: f.midi });
      }
      while (recent.length && recent[0]!.t < f.time - 0.8) recent.shift();
      const ms = recent.map((r) => r.midi);
      // Need ~60 % of the last 0.8 s voiced, with under 35 cents of spread.
      const enough = ms.length >= 0.6 * (0.8 / rt.frameInterval);
      const mu = ms.length ? mean(ms) : 0;
      const sd = ms.length > 2 ? Math.sqrt(ms.reduce((s, m) => s + (m - mu) ** 2, 0) / ms.length) : 99;
      const stable = f.voiced && enough && sd < 0.35;
      progress = stable ? progress + dt : Math.max(0, progress - dt * 1.5);
      ringFg.setAttribute('stroke-dashoffset', String(circ * (1 - Math.min(1, progress / HOLD_SECONDS))));
      if (progress >= HOLD_SECONDS) {
        const m = median(ms);
        if (step === 'low') {
          low = m;
          captured.textContent = `Low: ${noteNameWithOctave(m)}`;
          setStep('high');
        } else if (m < low + 4) {
          progress = 0;
          msg.style.display = '';
          msg.className = 'notice warn';
          msg.textContent = `That was ${noteNameWithOctave(m)}, close to your low note. Try a noticeably higher note.`;
        } else {
          done({ low, high: m });
        }
      }
    });
    let raf = 0;
    const draw = () => {
      tuner.draw(rt.engine.ctx.currentTime);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    cleanup = () => {
      off();
      cancelAnimationFrame(raf);
    };
  };

  const done = (raw: VocalRange) => {
    cleanup?.();
    cleanup = null;
    const range = { low: Math.round(raw.low * 10) / 10, high: Math.round(raw.high * 10) / 10 };
    const span = Math.round(range.high - range.low);
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack', style: 'text-align:center;padding:32px' },
        h('div', { class: 'panel-title' }, 'Your comfortable range'),
        h('div', { class: 'big-note num', style: 'font-size:64px' }, `${noteNameWithOctave(range.low)} – ${noteNameWithOctave(range.high)}`),
        h('div', { class: 'muted' }, `${span} semitones (${(span / 12).toFixed(1)} octaves) · roughly ${voiceTypeFor(range)}`),
        span < 9 ? h('div', { class: 'notice warn' }, 'That is a narrow range. Songs will still fit as well as possible; you can redo this any time.') : null,
        h('p', { class: 'muted small', style: 'margin:0' }, 'Each song will show its original key and the key chosen for you.'),
        h('div', { class: 'row', style: 'justify-content:center' }, h('button', { class: 'btn', onclick: () => void measure() }, 'Redo'), h('button', { class: 'btn primary big', onclick: () => finish(range, 'measured') }, 'Use this range')),
      ),
    );
  };

  body.replaceChildren(
    h(
      'div',
      { class: 'card stack' },
      h('p', { style: 'margin:0' }, 'You will sing two notes and hold each for about a second. The ring fills while you hold steady.'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary big', onclick: () => void measure() }, 'Start range check'), h('button', { class: 'btn ghost', onclick: showPresets }, 'Pick a voice type instead')),
    ),
  );

  return { el, destroy: () => cleanup?.() };
}

function mean(v: number[]): number {
  return v.reduce((s, x) => s + x, 0) / v.length;
}
