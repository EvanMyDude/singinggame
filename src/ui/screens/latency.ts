import { OnsetDetector, estimateLatency, type LatencyEstimate } from '../../audio/onset';
import { playDrum } from '../../audio/synth';
import type { App, Route, Screen } from '../app';
import { backButton, h } from '../dom';

const COUNT_IN = 4;
const MEASURED = 8;
const SPB = 0.6; // 100 BPM

export function latencyScreen(app: App, route: Route): Screen {
  const next: Route = (route.name === 'latency' && route.next) || { name: 'settings' };
  const body = h('div', { class: 'stack' });
  let cleanup: (() => void) | null = null;
  const current = () => {
    const ms = app.store.settings.latencyMs;
    return ms === null ? `automatic (browser estimate ${Math.round(app.latency() * 1000)} ms)` : `${Math.round(ms)} ms (calibrated)`;
  };

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:720px' },
    h('div', { class: 'topbar' }, backButton(() => app.go(next)), h('div', { class: 'spacer' })),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Latency calibration'),
    h(
      'p',
      { class: 'muted', style: 'margin:0 0 20px' },
      'Sound takes time to travel from the browser to your ears and from your voice back into the browser. Measuring it means you are never marked late for something your hardware did.',
    ),
    body,
  );

  const intro = (note?: string) => {
    cleanup?.();
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('p', { style: 'margin:0' }, 'You will hear 4 count-in clicks, then 8 more. On each of the 8, clap, tap the mic, or say a short "ta", right on the click.'),
        h('p', { class: 'muted small', style: 'margin:0' }, `Current setting: ${current()}.`),
        note ? h('div', { class: 'notice warn' }, note) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn primary big', onclick: () => void run() }, 'Start')),
      ),
    );
  };

  const run = async () => {
    cleanup?.();
    if (!app.micReady) {
      const err = await app.openMic();
      if (err) return intro(err);
    }
    const rt = app.rt();
    await rt.engine.resume();
    const circle = h('div', { class: 'beat-circle num' }, '');
    const label = h('div', { class: 'muted' }, 'Get ready…');
    body.replaceChildren(h('div', { class: 'card stack', style: 'align-items:center;padding:36px' }, circle, label));

    const det = new OnsetDetector(rt.sampleRate, { gateDb: Math.max(-50, app.store.settings.gateDb + 4) });
    const onsets: number[] = [];
    const offChunk = rt.onChunk((d, t) => onsets.push(...det.push(d, t)));
    const session = rt.engine.openSession();
    const start = rt.engine.ctx.currentTime + 0.6;
    const clicks: number[] = [];
    for (let i = 0; i < COUNT_IN + MEASURED; i++) {
      const t = start + i * SPB;
      playDrum(rt.engine, session.buses.click, i < COUNT_IN ? 'click' : 'clickAccent', t, 0.9);
      if (i >= COUNT_IN) clicks.push(t);
    }
    const all = clicks.length ? [...Array(COUNT_IN).keys()].map((i) => start + i * SPB).concat(clicks) : [];
    let raf = 0;
    let shown = -1;
    const loop = () => {
      const heard = rt.engine.heardTime();
      let idx = -1;
      for (let i = 0; i < all.length; i++) if (heard >= all[i]!) idx = i;
      if (idx !== shown && idx >= 0) {
        shown = idx;
        circle.classList.add('flash');
        setTimeout(() => circle.classList.remove('flash'), 110);
        if (idx < COUNT_IN) {
          circle.textContent = String(COUNT_IN - idx);
          label.textContent = 'Listen…';
        } else {
          circle.textContent = String(idx - COUNT_IN + 1);
          label.textContent = 'Clap on every click';
        }
      }
      const answered = clicks.filter((c) => onsets.some((o) => o >= c - 0.1 && o <= c + 0.45)).length;
      if (idx >= COUNT_IN) circle.classList.toggle('hit', answered > 0 && onsets.some((o) => o >= clicks[Math.max(0, idx - COUNT_IN)]! - 0.1));
      if (heard > clicks[clicks.length - 1]! + 0.7) {
        finish(estimateLatency(clicks, onsets));
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    cleanup = () => {
      cancelAnimationFrame(raf);
      offChunk();
      session.close();
    };
  };

  const finish = (est: LatencyEstimate | null) => {
    cleanup?.();
    cleanup = null;
    if (!est) {
      intro('Not enough claps were heard (need at least 5 of 8). Clap louder or closer to the mic, or lower the sensitivity threshold in mic setup.');
      return;
    }
    const ms = Math.round(est.latency * 1000);
    const shaky = est.spread > 0.035;
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack', style: 'text-align:center;padding:32px' },
        h('div', { class: 'panel-title' }, 'Measured round-trip latency'),
        h('div', { class: 'big-note num' }, `${ms} ms`),
        h('div', { class: 'muted' }, `${est.hits} of ${MEASURED} claps heard · consistency ±${Math.round(est.spread * 1000)} ms`),
        shaky ? h('div', { class: 'notice warn' }, 'Your claps were a bit uneven. The result is usable, but a second run may be more accurate.') : null,
        h(
          'div',
          { class: 'row', style: 'justify-content:center' },
          h('button', { class: 'btn', onclick: () => void run() }, 'Run again'),
          h('button', { class: 'btn ghost', onclick: () => { app.store.updateSettings({ latencyMs: null }); app.go(next); } }, 'Use automatic'),
          h('button', { class: 'btn primary big', onclick: () => { app.store.updateSettings({ latencyMs: ms }); app.go(next); } }, `Save ${ms} ms`),
        ),
      ),
    );
  };

  intro();
  return { el, destroy: () => cleanup?.() };
}
