import type { VoiceFrame } from '../../audio/pitch/tracker';
import type { App, Route, Screen } from '../app';
import { backButton, h, icon } from '../dom';
import { PitchGraph, defaultView, followView } from '../render/pitchGraph';

/**
 * 2-minute vocal warm-up: four 30-second steps with a countdown, one instruction each and a
 * preview of the next step. Optional live pitch graph (starts the mic only on request).
 */
interface Step {
  title: string;
  instruction: string;
  seconds: number;
}

export const WARMUP_STEPS: Step[] = [
  { title: 'Loosen up', instruction: 'Drop your shoulders, let the jaw hang loose, and breathe low and slow into your belly.', seconds: 30 },
  { title: 'Lip trills', instruction: 'Blow a steady "brrr" through loose lips and let it drift gently up and down. No pushing.', seconds: 30 },
  { title: 'Hum and glide', instruction: 'Hum "mmm" and slide slowly between an easy low note and an easy high note. Keep it light.', seconds: 30 },
  { title: 'Easy sirens', instruction: 'On "oo", siren softly from low to high and back inside your comfortable range.', seconds: 30 },
];

export function warmupScreen(app: App, route: Route): Screen {
  const next: Route | null = (route.name === 'warmup' && route.next) || null;
  const total = WARMUP_STEPS.reduce((s, x) => s + x.seconds, 0);

  let step = 0;
  let remaining = WARMUP_STEPS[0]!.seconds;
  let running = false;
  let done = false;
  let timer: number | null = null;
  let lastTick = 0;

  const ringLen = 2 * Math.PI * 54;
  const ring = h('div', { class: 'ring-wrap' });
  ring.innerHTML = `<svg class="ring-svg" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8"/><circle class="ring-fg" cx="60" cy="60" r="54" fill="none" stroke="#5ee0ff" stroke-width="8" stroke-linecap="round" stroke-dasharray="${ringLen}" stroke-dashoffset="0" transform="rotate(-90 60 60)"/></svg>`;
  const ringFg = ring.querySelector<SVGCircleElement>('.ring-fg')!;
  const countEl = h('div', { class: 'warm-count num' }, '0:30');
  const stepLabel = h('div', { class: 'hud-label' }, 'Step 1 of 4');
  const titleEl = h('h2', { class: 'warm-title' }, '');
  const instrEl = h('p', { class: 'warm-instr' }, '');
  const nextEl = h('div', { class: 'muted small' }, '');
  const totalEl = h('div', { class: 'faint tiny num' }, '');
  const startBtn = h('button', { class: 'btn primary big', onclick: () => toggle() }, 'Start Warm-Up');
  const skipStepBtn = h('button', { class: 'btn', onclick: () => advance(), disabled: true }, 'Skip step');
  const skipBtn = h('button', { class: 'btn ghost', onclick: () => leave() }, next ? 'Skip' : 'Back');
  const steps = h('div', { class: 'steps', 'aria-hidden': 'true' }, ...WARMUP_STEPS.map((_, i) => h('i', { class: i === 0 ? 'on' : '' })));

  // Optional live pitch graph.
  const canvas = h('canvas', { class: 'monitor-canvas', 'aria-label': 'Live pitch' });
  const graph = new PitchGraph(canvas, defaultView(null));
  graph.windowSec = 6;
  const graphWrap = h('div', { class: 'warm-graph', style: 'display:none' }, canvas);
  const micBtn = h('button', { class: 'btn', onclick: () => void toggleMic() }, icon('mic', 'kbd-icon'), 'Show my pitch');
  const micMsg = h('div', { class: 'notice bad', style: 'display:none' });
  let off: (() => void) | null = null;
  let current: number | null = null;
  let lastVoiced = 0;
  let raf = 0;
  const onFrame = (f: VoiceFrame) => {
    graph.push(f.time, f.voiced ? f.displayMidi : NaN);
    if (f.voiced) {
      current = f.displayMidi;
      lastVoiced = performance.now();
      graph.view = followView(graph.view, f.displayMidi);
    }
  };
  const toggleMic = async () => {
    if (off) {
      off();
      off = null;
      graphWrap.style.display = 'none';
      micBtn.replaceChildren(icon('mic', 'kbd-icon'), 'Show my pitch');
      return;
    }
    if (!app.micReady) {
      const err = await app.openMic();
      if (err) {
        micMsg.textContent = err;
        micMsg.style.display = '';
        return;
      }
    }
    micMsg.style.display = 'none';
    off = app.rt().onFrame(onFrame);
    graphWrap.style.display = '';
    micBtn.replaceChildren(icon('mic', 'kbd-icon'), 'Hide pitch');
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!off) return;
      const voicedNow = performance.now() - lastVoiced < 150;
      graph.draw(app.rt().engine.ctx.currentTime - 0.03, voicedNow ? current : null);
    };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  };

  const render = () => {
    const s = WARMUP_STEPS[step]!;
    stepLabel.textContent = done ? 'Done' : `Step ${step + 1} of ${WARMUP_STEPS.length}`;
    titleEl.textContent = done ? 'Warmed up' : s.title;
    instrEl.textContent = done ? 'Nice and easy. Keep that relaxed feeling while you sing.' : s.instruction;
    const nx = WARMUP_STEPS[step + 1];
    nextEl.textContent = done ? '' : nx ? `Next: ${nx.title}` : 'Last step';
    countEl.textContent = done ? '✓' : fmt(remaining);
    ringFg.setAttribute('stroke-dashoffset', String(done ? 0 : ringLen * (1 - remaining / s.seconds)));
    const elapsed = WARMUP_STEPS.slice(0, step).reduce((a, x) => a + x.seconds, 0) + (done ? s.seconds : s.seconds - remaining);
    totalEl.textContent = `${fmt(Math.max(0, total - elapsed))} left of ${fmt(total)}`;
    steps.querySelectorAll('i').forEach((i, k) => i.classList.toggle('on', k <= step || done));
    startBtn.textContent = done ? (next ? 'Start singing' : 'Back to home') : running ? 'Pause' : remaining < s.seconds || step > 0 ? 'Resume' : 'Start Warm-Up';
    skipStepBtn.disabled = done;
  };

  const tick = () => {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    remaining -= dt;
    if (remaining <= 0) {
      if (step + 1 < WARMUP_STEPS.length) {
        step++;
        remaining = WARMUP_STEPS[step]!.seconds;
        cue();
      } else {
        stop();
        done = true;
      }
    }
    render();
  };

  const cue = () => {
    // A soft two-note chime marks each new step so the eyes can stay closed.
    try {
      const rt = app.rt();
      const t = rt.engine.ctx.currentTime + 0.01;
      const g = rt.engine.ctx.createGain();
      g.gain.value = 0.25;
      g.connect(rt.engine.out);
      for (const [f, d] of [[880, 0], [1320, 0.12]] as const) {
        const o = rt.engine.ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const e = rt.engine.ctx.createGain();
        e.gain.setValueAtTime(0, t + d);
        e.gain.linearRampToValueAtTime(1, t + d + 0.01);
        e.gain.exponentialRampToValueAtTime(0.001, t + d + 0.35);
        o.connect(e).connect(g);
        o.start(t + d);
        o.stop(t + d + 0.4);
      }
    } catch {
      /* no audio yet: silent cue */
    }
  };

  const start = () => {
    running = true;
    lastTick = performance.now();
    timer = window.setInterval(tick, 200);
    void app.rt().engine.resume();
    render();
  };
  const stop = () => {
    running = false;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    render();
  };
  const toggle = () => {
    if (done) {
      leave();
      return;
    }
    if (running) stop();
    else start();
  };
  const advance = () => {
    if (done) return;
    if (step + 1 < WARMUP_STEPS.length) {
      step++;
      remaining = WARMUP_STEPS[step]!.seconds;
      if (running) lastTick = performance.now();
    } else {
      stop();
      done = true;
    }
    render();
  };
  const leave = () => {
    if (next) void app.continueTo(next);
    else app.go({ name: 'home' });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape') leave();
  };
  window.addEventListener('keydown', onKey);

  const el = h(
    'div',
    { class: 'screen', style: 'max-width:820px' },
    h('div', { class: 'topbar' }, backButton(() => app.go({ name: 'home' }), 'Home'), h('div', { class: 'spacer' })),
    h('h2', { style: 'font-size:32px;margin-bottom:6px' }, '2-Minute Vocal Warm-Up'),
    h('p', { class: 'muted', style: 'margin:0 0 18px' }, 'Four easy steps. Everything stays soft and comfortable: if anything strains, tickles too much or hurts, stop and rest.'),
    steps,
    h(
      'div',
      { class: 'card warm-card' },
      h('div', { class: 'warm-ring' }, ring, countEl),
      h('div', { class: 'stack', style: 'gap:8px' }, stepLabel, titleEl, instrEl, nextEl, totalEl),
    ),
    h('div', { class: 'row', style: 'margin-top:16px' }, startBtn, skipStepBtn, micBtn, h('div', { class: 'grow' }), skipBtn),
    micMsg,
    graphWrap,
    h('p', { class: 'faint tiny', style: 'margin-top:14px' }, h('span', { class: 'kbd' }, 'Space'), ' start / pause · ', h('span', { class: 'kbd' }, 'Esc'), next ? ' skip to the song' : ' back'),
  );
  render();

  return {
    el,
    destroy: () => {
      stop();
      off?.();
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    },
  };
}

function fmt(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
