import type { VoiceFrame } from '../../audio/pitch/tracker';
import { midiToHz, noteNameWithOctave } from '../../core/music';
import { zoneFor } from '../../core/scoring';
import type { App, Screen } from '../app';
import { backButton, h, slider } from '../dom';
import { zoneColor } from '../render/colors';
import { PitchGraph, centsFromNearest, clampView, defaultView, followView, shiftView, zoomView } from '../render/pitchGraph';
import { gateFromSensitivity, sensitivityFromGate } from './setup';

/** Vocal Pitch Monitor: a free-running real-time pitch graph with note, Hz and cents readout. */
export function monitorScreen(app: App): Screen {
  const canvas = h('canvas', { class: 'monitor-canvas', 'aria-label': 'Real-time pitch graph' });
  const graph = new PitchGraph(canvas, defaultView(null));
  let follow = true;

  const dot = h('i', { class: 'monitor-dot' });
  const noteEl = h('span', { class: 'monitor-note' }, '–');
  const hzEl = h('span', { class: 'monitor-hz num' }, '');
  const centsEl = h('span', { class: 'monitor-cents num' }, '');
  const msg = h('div', { class: 'notice bad', style: 'display:none;margin-top:12px' });

  const startBtn = h('button', { class: 'btn primary', onclick: () => void toggleRun() }, 'Start');
  const holdBtn = h('button', { class: 'btn', 'aria-pressed': 'false', onclick: () => toggleHold(), disabled: true }, 'Hold');
  const sensVal = h('span', { class: 'val' }, String(sensitivityFromGate(app.store.settings.gateDb)));

  const setView = (v: typeof graph.view, manual: boolean) => {
    graph.view = v;
    if (manual) follow = false;
  };

  let running = false;
  let held = false;
  let heldAt = 0;
  let off: (() => void) | null = null;
  let current: number | null = null;
  let lastVoiced = -Infinity;
  let clock = { ctx: 0, perf: 0 };

  const onFrame = (f: VoiceFrame) => {
    if (held) return;
    graph.push(f.time, f.voiced ? f.displayMidi : NaN);
    if (f.voiced) {
      current = f.displayMidi;
      lastVoiced = performance.now();
      if (follow) setView(followView(graph.view, f.displayMidi), false);
      const c = centsFromNearest(f.displayMidi);
      noteEl.textContent = noteNameWithOctave(f.displayMidi);
      hzEl.textContent = `${midiToHz(f.displayMidi).toFixed(1)} Hz`;
      const r = Math.round(c);
      centsEl.textContent = `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)} ¢`;
      centsEl.style.color = zoneColor(zoneFor(Math.abs(c)));
    }
  };

  const toggleRun = async () => {
    msg.style.display = 'none';
    if (running) {
      stop();
      return;
    }
    startBtn.disabled = true;
    if (!app.micReady) {
      const err = await app.openMic();
      if (err) {
        startBtn.disabled = false;
        msg.textContent = err;
        msg.style.display = '';
        return;
      }
    }
    startBtn.disabled = false;
    const rt = app.rt();
    off = rt.onFrame(onFrame);
    running = true;
    held = false;
    startBtn.textContent = 'Stop';
    startBtn.className = 'btn stop';
    holdBtn.disabled = false;
    holdBtn.textContent = 'Hold';
    holdBtn.setAttribute('aria-pressed', 'false');
  };

  /** Stop listening and release the microphone (the browser's mic indicator turns off). */
  const stop = () => {
    off?.();
    off = null;
    running = false;
    held = false;
    current = null;
    if (app.micReady) app.rt().mic.close();
    startBtn.textContent = 'Start';
    startBtn.className = 'btn primary';
    holdBtn.disabled = true;
    holdBtn.textContent = 'Hold';
    holdBtn.setAttribute('aria-pressed', 'false');
    dot.className = 'monitor-dot';
  };

  const toggleHold = () => {
    if (!running) return;
    held = !held;
    if (held) heldAt = nowCtx();
    holdBtn.textContent = held ? 'Resume' : 'Hold';
    holdBtn.setAttribute('aria-pressed', String(held));
  };

  /** Smooth AudioContext clock for scrolling (currentTime advances in audio-block steps). */
  const nowCtx = () => {
    if (!app.micReady && !running) return clock.ctx;
    const ctx = app.rt().engine.ctx;
    const p = performance.now();
    if (ctx.currentTime !== clock.ctx) clock = { ctx: ctx.currentTime, perf: p };
    return Math.min(ctx.currentTime + 0.05, clock.ctx + (p - clock.perf) / 1000) - 0.03;
  };

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const voicedNow = running && !held && performance.now() - lastVoiced < 150;
    if (running && !held && !voicedNow) current = null;
    dot.className = `monitor-dot ${voicedNow ? 'on' : running ? 'listening' : ''}`;
    if (!voicedNow && running && !held) {
      noteEl.style.opacity = '0.45';
    } else noteEl.style.opacity = '1';
    graph.draw(held ? heldAt : nowCtx(), held ? null : current);
  };
  raf = requestAnimationFrame(loop);

  const btn = (label: string, aria: string, fn: () => void) => h('button', { class: 'btn', 'aria-label': aria, onclick: fn }, label);

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:900px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' })), h('div', { class: 'spacer' })),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Vocal Pitch Monitor'),
    h('p', { class: 'muted', style: 'margin:0 0 14px' }, 'Real-time pitch graph. Sing, hum or play a note and watch where it lands.'),
    h('span', { class: 'chip ok' }, h('i', { class: 'dot' }), 'Runs on this device · no uploads'),
    h(
      'div',
      { class: 'card monitor-card', style: 'margin-top:18px' },
      h('div', { class: 'monitor-readout' }, dot, noteEl, hzEl, centsEl),
      h('div', { class: 'monitor-plot' }, canvas),
      h(
        'div',
        { class: 'monitor-controls' },
        h('div', { class: 'row' }, startBtn, holdBtn, btn('Clear', 'Clear graph', () => graph.clear())),
        h(
          'div',
          { class: 'row' },
          btn('Zoom +', 'Zoom in (fewer notes)', () => setView(zoomView(graph.view, 1), true)),
          btn('Zoom −', 'Zoom out (more notes)', () => setView(zoomView(graph.view, -1), true)),
          btn('Range ▲', 'Move range up', () => setView(shiftView(graph.view, 2), true)),
          btn('Range ▼', 'Move range down', () => setView(shiftView(graph.view, -2), true)),
          h(
            'button',
            {
              class: 'btn ghost',
              onclick: () => {
                follow = true;
                setView(clampView(defaultView(null)), false);
              },
            },
            'Reset',
          ),
        ),
        h(
          'div',
          { class: 'row', style: 'flex-wrap:nowrap' },
          h('span', { class: 'field-label', style: 'min-width:86px' }, 'Sensitivity'),
          slider({
            min: 0,
            max: 100,
            step: 1,
            value: sensitivityFromGate(app.store.settings.gateDb),
            ariaLabel: 'Microphone sensitivity',
            onInput: (v) => {
              sensVal.textContent = String(v);
              app.store.updateSettings({ gateDb: gateFromSensitivity(v) });
              app.applyAudioSettings();
            },
          }),
          sensVal,
        ),
      ),
      msg,
      h('p', { class: 'faint tiny', style: 'margin:12px 0 0' }, 'Line color shows how centered you are on the nearest note: green within ±10 cents, yellow ±25, orange ±50. The view follows your voice until you move it; Reset restores it.'),
    ),
  );

  // Start right away when the mic is already open (no permission prompt needed).
  if (app.micReady) void toggleRun();

  return {
    el,
    destroy: () => {
      cancelAnimationFrame(raf);
      off?.();
    },
  };
}
