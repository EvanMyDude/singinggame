import { listMics } from '../../audio/mic';
import { noteNameWithOctave } from '../../core/music';
import type { App, Route, Screen } from '../app';
import { backButton, h, slider, toggle } from '../dom';

/** Sensitivity slider 0..100 maps to a level gate of -25..-70 dBFS. */
export const gateFromSensitivity = (s: number) => -25 - s * 0.45;
export const sensitivityFromGate = (db: number) => Math.round((-25 - db) / 0.45);

export function levelPct(db: number): number {
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
}

export function setupScreen(app: App, route: Route): Screen {
  const next: Route = (route.name === 'setup' && route.next) || { name: 'songs' };
  const s = () => app.store.settings;
  const body = h('div', { class: 'stack' });
  let cleanup: (() => void) | null = null;

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:760px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' })), h('div', { class: 'spacer' })),
    flowSteps(route, 0),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, 'Microphone check'),
    h('p', { class: 'muted', style: 'margin:0 0 20px' }, 'Pitch detection runs entirely in this browser tab. No audio is recorded or uploaded.'),
    body,
  );

  const renderAsk = (error: string | null) => {
    body.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('p', { style: 'margin:0' }, 'Pitchline needs your microphone to hear your pitch. Your browser will ask for permission.'),
        error ? h('div', { class: 'notice bad' }, error) : null,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn primary big',
              onclick: async (e: Event) => {
                const b = e.currentTarget as HTMLButtonElement;
                b.disabled = true;
                b.textContent = 'Waiting for permission…';
                const err = await app.openMic();
                if (err) renderAsk(err);
                else void renderLive();
              },
            },
            'Allow microphone',
          ),
        ),
      ),
    );
  };

  const renderLive = async () => {
    cleanup?.();
    const rt = app.rt();
    const devices = await listMics();
    const currentId = rt.mic.deviceId;
    const select = h(
      'select',
      {
        'aria-label': 'Microphone',
        onchange: async () => {
          app.store.updateSettings({ deviceId: select.value });
          const err = await app.openMic(select.value);
          if (err) renderAsk(err);
          else void renderLive();
        },
      },
      ...devices.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === currentId }, d.label || `Microphone ${i + 1}`)),
    );
    if (!devices.length) select.append(h('option', null, rt.mic.label));

    const fill = h('div', { class: 'fill' });
    const peak = h('div', { class: 'peak' });
    const gate = h('div', { class: 'gate', title: 'Sensitivity threshold' });
    const meter = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Input level' }, fill, peak, gate);
    const note = h('div', { class: 'big-note num' }, '–');
    const cents = h('div', { class: 'muted' }, 'Sing any comfortable note');
    const status = h('div', { class: 'notice' }, 'Listening…');
    const sensVal = h('span', { class: 'val' });
    const placeGate = () => {
      gate.style.left = `${levelPct(s().gateDb)}%`;
      sensVal.textContent = `${sensitivityFromGate(s().gateDb)}`;
    };
    placeGate();
    const sens = slider({
      min: 0,
      max: 100,
      step: 1,
      value: sensitivityFromGate(s().gateDb),
      ariaLabel: 'Microphone sensitivity',
      onInput: (v) => {
        app.store.updateSettings({ gateDb: gateFromSensitivity(v) });
        app.applyAudioSettings();
        placeGate();
      },
    });

    let measuring = false;
    const autoBtn = h(
      'button',
      {
        class: 'btn',
        onclick: () => {
          if (measuring) return;
          measuring = true;
          autoBtn.textContent = 'Stay quiet…';
          const dbs: number[] = [];
          const off = rt.onFrame((f) => dbs.push(f.db));
          setTimeout(() => {
            off();
            measuring = false;
            autoBtn.textContent = 'Auto-set';
            dbs.sort((a, b) => a - b);
            const floor = dbs[Math.floor(dbs.length * 0.9)] ?? -70;
            const g = Math.max(-70, Math.min(-30, floor + 10));
            app.store.updateSettings({ gateDb: g });
            app.applyAudioSettings();
            sens.value = String(sensitivityFromGate(g));
            sens.dispatchEvent(new Event('input'));
          }, 1600);
        },
      },
      'Auto-set',
    );

    const headphones = toggle("I'm using headphones", s().headphones, async (v) => {
      app.store.updateSettings({ headphones: v, monitoring: v ? s().monitoring : false });
      const err = await app.openMic();
      if (err) renderAsk(err);
      else void renderLive();
    });

    body.replaceChildren(
      h(
        'div',
        { class: 'card stack' },
        h('div', { class: 'field' }, h('label', null, 'Input device'), select),
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Level'), meter),
        h('div', { class: 'row', style: 'align-items:flex-end;gap:18px' }, note, cents),
        status,
      ),
      h(
        'div',
        { class: 'card stack' },
        h(
          'div',
          { class: 'setting-row' },
          h('div', null, h('div', null, 'Sensitivity'), h('div', { class: 'desc' }, 'How quiet a sound still counts as singing (purple marker on the meter).')),
          h('div', { class: 'row', style: 'flex-wrap:nowrap;min-width:260px' }, sens, sensVal, autoBtn),
        ),
        h(
          'div',
          { class: 'setting-row' },
          h('div', null, headphones, h('div', { class: 'desc' }, s().headphones ? 'Best accuracy: the mic only hears you.' : 'Speakers: echo cancellation is on. Keep the guide melody quieter so the mic hears you, not the speakers.')),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary big', onclick: () => app.go(next) }, next.name === 'play' ? 'Start' : 'Continue'),
      ),
    );

    // Live level, pitch and warnings.
    let lastVoiced = 0;
    let voicedLoud = -100;
    let clipAt = -1;
    let peakHold = 0;
    let lastFrameTime = 0;
    const offFrame = rt.onFrame((f) => {
      lastFrameTime = performance.now();
      if (f.voiced) {
        lastVoiced = performance.now();
        voicedLoud = Math.max(voicedLoud - 0.15, f.db);
        note.textContent = noteNameWithOctave(f.displayMidi);
        const c = Math.round((f.displayMidi - Math.round(f.displayMidi)) * 100);
        cents.textContent = `${c >= 0 ? '+' : ''}${c} cents from ${noteNameWithOctave(Math.round(f.displayMidi))}`;
      }
    });
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      const p = rt.takePeak();
      if (p >= 0.985) clipAt = now;
      peakHold = Math.max(p, peakHold * 0.94);
      const f = rt.latest;
      const db = f ? f.db : -100;
      fill.style.width = `${levelPct(db)}%`;
      peak.style.left = `${levelPct(20 * Math.log10(Math.max(1e-6, peakHold)))}%`;
      if (now - lastVoiced > 600) {
        note.textContent = '–';
        cents.textContent = 'Sing any comfortable note';
      }
      if (now - lastFrameTime > 1500) {
        setStatus('bad', 'No audio is arriving from this microphone. Pick another device above.');
      } else if (now - clipAt < 1500) {
        setStatus('bad', 'Clipping: your input is too loud. Lower the mic level in your system sound settings or move back a little.');
      } else if (now - lastVoiced < 1500 && voicedLoud < -38) {
        setStatus('warn', 'A bit quiet. Move closer to the mic or raise its input level.');
      } else if (now - lastVoiced < 1500) {
        setStatus('good', 'Sounds good. Your voice is coming through clearly.');
      } else if (db > s().gateDb + 3) {
        setStatus('warn', 'Background noise is above the sensitivity line. Try Auto-set while staying quiet.');
      } else {
        setStatus('', 'Listening… sing a note to test.');
      }
      raf = requestAnimationFrame(loop);
    };
    const setStatus = (kind: string, text: string) => {
      const cls = `notice ${kind}`;
      if (status.className !== cls) status.className = cls;
      if (status.textContent !== text) status.textContent = text;
    };
    raf = requestAnimationFrame(loop);
    cleanup = () => {
      offFrame();
      cancelAnimationFrame(raf);
    };
  };

  if (app.micReady) void renderLive();
  else renderAsk(null);

  return { el, destroy: () => cleanup?.() };
}

/** Step dots for the first-run flow (mic -> range -> songs). */
export function flowSteps(route: Route, index: number): HTMLElement | null {
  const inFlow = 'next' in route && route.next !== undefined;
  if (!inFlow) return null;
  const total = route.name === 'setup' && route.next?.name === 'range' ? 2 : route.name === 'range' && index === 1 ? 2 : 1;
  if (total < 2) return null;
  return h('div', { class: 'steps', 'aria-hidden': 'true' }, ...Array.from({ length: total }, (_, i) => h('i', { class: i <= index ? 'on' : '' })));
}
