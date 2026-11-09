import { fmtTime } from '../../core/melody';
import { SONG } from '../../core/songpack';
import type { App, Screen } from '../app';
import { packFilesCard } from '../components/packFiles';
import { brandMark, fmtInt, h, icon } from '../dom';

export function homeScreen(app: App): Screen {
  const s = app.store.settings;
  const wave = heroWave();
  const status = h('div', { class: 'status-row' });
  const actions = h('div', { class: 'row', style: 'margin-top:24px' });
  const filesHost = h('div');
  const best = app.store.progress(SONG.id).best;
  const last = app.store.lastPosition(SONG.id);

  const renderStatus = () => {
    const ps = app.packStatus;
    const ready = !!ps?.pack;
    const latencyLabel = s.latencyMs !== null ? `Latency ${Math.round(s.latencyMs)} ms` : 'Latency: auto';
    status.replaceChildren(
      ...[
      h('span', { class: `chip ${ready ? 'ok' : 'warn'}` }, h('i', { class: 'dot' }), !ps ? 'Checking song files…' : ready ? (ps.pack!.referenceUrl ? 'Song files ready' : 'Instrumental ready · no reference track') : 'Song files needed'),
      h('span', { class: `chip ${app.micReady ? 'ok' : ''}` }, h('i', { class: 'dot' }), app.micReady ? 'Mic ready' : 'Mic: asks when you start'),
      h('span', { class: `chip ${s.latencyMs !== null ? 'ok' : ''}` }, h('i', { class: 'dot' }), latencyLabel),
      h('span', { class: `chip ${s.headphones ? 'accent' : 'warn'}` }, s.headphones ? 'Headphones' : 'Speakers'),
      ps?.pack && !ps.pack.lyrics ? h('span', { class: 'chip warn' }, 'No lyrics yet') : ps?.pack && !ps.pack.timing ? h('span', { class: 'chip warn' }, 'Lyrics not synced') : null,
      ].filter((x) => x !== null),
    );
    actions.replaceChildren(
      ...[
      h('button', { class: 'btn primary big', disabled: !ready, onclick: () => void app.startSession({ mode: 'sing' }) }, icon('sing', 'kbd-icon'), 'Sing'),
      h('button', { class: 'btn big', disabled: !ready, onclick: () => void app.startSession({ mode: 'practice' }) }, icon('practice', 'kbd-icon'), 'Practice'),
      ready && last > 5 && last < (ps!.pack!.melody.duration - 5)
        ? h('button', { class: 'btn ghost', onclick: () => void app.startSession({ mode: 'practice', startAt: last }) }, `Resume practice at ${fmtTime(last)}`)
        : null,
      ].filter((x) => x !== null),
    );
    filesHost.replaceChildren(ready ? h('div') : packFilesCard(app, renderStatus));
    if (!ready && ps) filesHost.prepend(h('p', { class: 'muted', style: 'margin:18px 0 10px' }, 'This site does not ship the song audio. Pick the two MP3s (and lyrics.txt) once; they stay in this browser.'));
  };

  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'topbar' },
      h('div', { class: 'brand' }, brandMark(), 'Pitch Hero'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: () => app.go({ name: 'monitor' }) }, icon('monitor', 'kbd-icon'), 'Pitch Monitor'),
      h('button', { class: 'btn ghost', onclick: () => app.go({ name: 'settings' }) }, icon('settings', 'kbd-icon'), 'Settings'),
    ),
    h(
      'section',
      { class: 'hero' },
      wave.el,
      h('div', { class: 'hud-label' }, 'Practice song'),
      h('h1', null, SONG.title),
      h('p', null, `${SONG.artist} · karaoke instrumental with a live pitch monitor, synced lyrics, slow-down practice and A–B looping.`),
      actions,
      status,
      best ? h('div', { class: 'row', style: 'margin-top:14px' }, h('span', { class: `grade-badge grade-${best.grade}` }, best.grade), h('span', { class: 'muted' }, `Best ${fmtInt(best.score)} · ${Math.round(best.accuracy)}% pitch accuracy`)) : null,
    ),
    filesHost,
    h(
      'div',
      { class: 'mode-grid' },
      modeCard('warmup', '2-Minute Warm-Up', 'Loosen up, lip trills, hum glides and sirens with a timer. Offered before the first session; available any time.', () => app.go({ name: 'warmup' })),
      modeCard('practice', 'Practice', 'Slow the track to 75 % or 50 % with pitch preserved, loop a hard section, keep the live pitch feedback. No score.', () => void app.startSession({ mode: 'practice' }), true),
      modeCard('sing', 'Sing', 'The full song over the instrumental with live pitch scoring and a results breakdown at the end.', () => void app.startSession({ mode: 'sing' })),
      modeCard('settings', 'Settings', 'Microphone, headphones, latency calibration, music volume, song files and lyric sync.', () => app.go({ name: 'settings' }), true),
    ),
    h(
      'p',
      { class: 'faint small', style: 'margin-top:34px' },
      'Everything runs in this browser; your microphone never leaves the device. ',
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); app.go({ name: 'setup' }); } }, 'Mic check'),
      ' · ',
      h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); app.go({ name: 'latency', next: { name: 'home' } }); } }, 'Calibrate latency'),
    ),
  );

  renderStatus();
  void app.loadPack().then(renderStatus);
  return { el, destroy: wave.stop };
}

function modeCard(ic: 'sing' | 'practice' | 'warmup' | 'settings', title: string, text: string, onclick: () => void, alt = false): HTMLElement {
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
