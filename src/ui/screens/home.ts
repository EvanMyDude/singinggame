import { noteNameWithOctave } from '../../core/music';
import { voiceTypeFor } from '../../core/range';
import type { App, Screen } from '../app';
import { brandMark, h, icon } from '../dom';

export function homeScreen(app: App): Screen {
  const data = app.store.data;
  const range = data.range;
  const s = app.store.settings;
  const latencyLabel = s.latencyMs !== null ? `Latency ${Math.round(s.latencyMs)} ms` : 'Latency: auto';

  const firstRun = !data.onboarded && !range;
  const wave = heroWave();

  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'brand' }, brandMark(), 'Pitchline'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => app.go({ name: 'settings' }) }, icon('settings', 'kbd-icon'), 'Settings'),
    ),
    h(
      'section',
      { class: 'hero' },
      wave.el,
      h('h1', null, 'Sing it ', h('span', { class: 'glow' }, 'on pitch'), '.'),
      h(
        'p',
        null,
        'Follow the glowing notes, match them with your voice, and watch the line light up. Everything runs on this device; your microphone never leaves it.',
      ),
      h(
        'div',
        { class: 'row', style: 'margin-top:26px' },
        h('button', { class: 'btn primary big', onclick: () => app.go({ name: 'songs' }) }, 'Choose a song'),
        firstRun
          ? h('button', { class: 'btn big', onclick: () => app.go({ name: 'setup', next: { name: 'range', next: { name: 'songs' } } }) }, 'Quick setup (1 min)')
          : null,
      ),
      h(
        'div',
        { class: 'status-row' },
        h('span', { class: `chip ${app.micReady ? 'ok' : ''}` }, h('i', { class: 'dot' }), app.micReady ? 'Mic ready' : 'Mic: asks when you start'),
        h(
          'span',
          { class: `chip ${range ? 'ok' : ''}` },
          h('i', { class: 'dot' }),
          range ? `Range ${noteNameWithOctave(range.low)}–${noteNameWithOctave(range.high)} · ${voiceTypeFor(range)}` : 'Vocal range: not set',
        ),
        h('span', { class: `chip ${s.latencyMs !== null ? 'ok' : ''}` }, h('i', { class: 'dot' }), latencyLabel),
        h('span', { class: `chip ${s.headphones ? 'accent' : 'warn'}` }, s.headphones ? 'Headphones' : 'Speakers'),
      ),
    ),
    h(
      'div',
      { class: 'mode-grid' },
      modeCard('play', 'Sing the Song', 'Full songs with backing band and guide melody. Earn points, build combos, beat your best.', () => app.go({ name: 'songs' })),
      modeCard('practice', 'Practice Section', 'Loop a tricky phrase at 75 % or 50 % speed. Hear the target note whenever you need it.', () => app.go({ name: 'songs' }), true),
      modeCard('trainer', 'Pitch Trainer', 'Short single notes and intervals with instant feedback. Lock each one in to score.', () => app.go({ name: 'trainer' }), true),
    ),
    h(
      'p',
      { class: 'faint small', style: 'margin-top:34px' },
      'Built-in songs are public-domain melodies and lyrics, arranged and synthesized in your browser. ',
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); app.go({ name: 'range' }); } }, range ? 'Re-check vocal range' : 'Check vocal range'),
      ' · ',
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); app.go({ name: 'latency' }); } }, 'Calibrate latency'),
    ),
  );
  return { el, destroy: wave.stop };
}

function modeCard(ic: 'play' | 'practice' | 'trainer', title: string, text: string, onclick: () => void, alt = false): HTMLElement {
  return h('button', { class: `mode-card ${alt ? 'alt' : ''}`, onclick }, icon(ic), h('h3', null, title), h('span', { class: 'muted small' }, text));
}

/** Decorative animated pitch lines behind the hero. */
function heroWave(): { el: HTMLCanvasElement; stop: () => void } {
  const c = h('canvas', { class: 'hero-wave', 'aria-hidden': 'true' });
  let raf = 0;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const draw = (t: number) => {
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    const time = t / 1000;
    // Target bars.
    const bars = [0.18, 0.32, 0.26, 0.4, 0.3, 0.22, 0.36];
    const bw = w / 9;
    for (let i = 0; i < bars.length; i++) {
      const x = ((i * bw * 1.3 - time * 40) % (w + bw * 2)) + w * 0.42;
      const xx = x > w ? x - (w + bw * 2) : x;
      const y = hh * (0.3 + bars[i]!);
      g.fillStyle = 'rgba(94,224,255,0.10)';
      g.beginPath();
      g.roundRect(xx, y - 6, bw, 12, 6);
      g.fill();
    }
    // Voice line.
    g.lineWidth = 2.5;
    g.strokeStyle = 'rgba(61,255,162,0.35)';
    g.beginPath();
    for (let x = w * 0.42; x < w; x += 4) {
      const p = (x - time * 40) / 90;
      const y = hh * 0.62 + Math.sin(p) * 16 + Math.sin(p * 2.3 + 1) * 7;
      if (x === w * 0.42) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    if (!reduce) raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  return { el: c, stop: () => cancelAnimationFrame(raf) };
}
