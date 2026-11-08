import { midiToHz } from '../core/music';
import type { DrumKind, TonePart } from '../core/arrange';
import type { AudioEngine } from './engine';

/**
 * Small synthesized instrument set. Every voice is scheduled at an exact AudioContext time
 * and cleans itself up; nothing here allocates per audio frame.
 */

const waves = new WeakMap<BaseAudioContext, PeriodicWave>();

/** Warm, clearly pitched lead for the guide melody (strong fundamental, few harmonics). */
function leadWave(ctx: BaseAudioContext): PeriodicWave {
  let w = waves.get(ctx);
  if (!w) {
    const harm = [0, 1, 0.42, 0.2, 0.1, 0.05, 0.025];
    const real = new Float32Array(harm.length);
    const imag = Float32Array.from(harm);
    w = ctx.createPeriodicWave(real, imag);
    waves.set(ctx, w);
  }
  return w;
}

export function playLead(engine: AudioEngine, dest: AudioNode, midi: number, when: number, dur: number, vel = 0.5): void {
  const ctx = engine.ctx;
  const f = midiToHz(midi);
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(leadWave(ctx));
  osc.frequency.value = f;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(9000, f * 8);
  lp.Q.value = 0.3;
  const g = ctx.createGain();
  const peak = 0.34 * vel;
  const end = when + Math.max(0.06, dur - 0.02);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.022);
  g.gain.setTargetAtTime(peak * 0.78, when + 0.03, 0.12);
  g.gain.setValueAtTime(peak * 0.78, end);
  g.gain.linearRampToValueAtTime(0, end + 0.09);
  osc.connect(lp).connect(g).connect(dest);
  osc.start(when);
  osc.stop(end + 0.12);
}

/** FM electric-piano style keys. */
function playKeys(engine: AudioEngine, dest: AudioNode, midi: number, when: number, dur: number, vel: number): void {
  const ctx = engine.ctx;
  const f = midiToHz(midi);
  const car = ctx.createOscillator();
  car.frequency.value = f;
  const mod = ctx.createOscillator();
  mod.frequency.value = f;
  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(f * 1.4, when);
  modGain.gain.exponentialRampToValueAtTime(f * 0.15, when + 0.6);
  mod.connect(modGain).connect(car.frequency);
  const g = ctx.createGain();
  const peak = 0.22 * vel;
  const end = when + Math.max(0.08, dur);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.006);
  g.gain.setTargetAtTime(peak * 0.25, when + 0.01, 0.5);
  g.gain.setTargetAtTime(0, end, 0.09);
  car.connect(g).connect(dest);
  car.start(when);
  mod.start(when);
  car.stop(end + 0.6);
  mod.stop(end + 0.6);
}

function playPad(engine: AudioEngine, dest: AudioNode, midi: number, when: number, dur: number, vel: number): void {
  const ctx = engine.ctx;
  const f = midiToHz(midi);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1100;
  lp.Q.value = 0.5;
  const g = ctx.createGain();
  const peak = 0.07 * vel;
  const end = when + Math.max(0.2, dur);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + Math.min(0.3, dur * 0.4));
  g.gain.setValueAtTime(peak, end);
  g.gain.linearRampToValueAtTime(0, end + 0.35);
  for (const det of [-7, 7]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.detune.value = det;
    o.connect(lp);
    o.start(when);
    o.stop(end + 0.4);
  }
  lp.connect(g).connect(dest);
}

function playBass(engine: AudioEngine, dest: AudioNode, midi: number, when: number, dur: number, vel: number): void {
  const ctx = engine.ctx;
  const f = midiToHz(midi);
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = f;
  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.value = f;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const g = ctx.createGain();
  const peak = 0.42 * vel;
  const end = when + Math.max(0.08, dur - 0.03);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(peak, when + 0.012);
  g.gain.setTargetAtTime(peak * 0.6, when + 0.02, 0.25);
  g.gain.setValueAtTime(peak * 0.6, end);
  g.gain.linearRampToValueAtTime(0, end + 0.07);
  o.connect(lp);
  sub.connect(lp);
  lp.connect(g).connect(dest);
  o.start(when);
  sub.start(when);
  o.stop(end + 0.1);
  sub.stop(end + 0.1);
}

export function playTone(engine: AudioEngine, dest: AudioNode, part: TonePart, midi: number, when: number, dur: number, vel: number): void {
  if (part === 'keys') playKeys(engine, dest, midi, when, dur, vel);
  else if (part === 'pad') playPad(engine, dest, midi, when, dur, vel);
  else playBass(engine, dest, midi, when, dur, vel);
}

export function playDrum(engine: AudioEngine, dest: AudioNode, kind: DrumKind, when: number, vel: number): void {
  const ctx = engine.ctx;
  const g = ctx.createGain();
  g.connect(dest);
  switch (kind) {
    case 'kick': {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(130, when);
      o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      g.gain.setValueAtTime(0.8 * vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.32);
      o.connect(g);
      o.start(when);
      o.stop(when + 0.34);
      break;
    }
    case 'snare': {
      const n = ctx.createBufferSource();
      n.buffer = engine.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900;
      bp.Q.value = 0.8;
      g.gain.setValueAtTime(0.5 * vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
      n.connect(bp).connect(g);
      n.start(when, Math.random() * 0.5);
      n.stop(when + 0.2);
      break;
    }
    case 'hat': {
      const n = ctx.createBufferSource();
      n.buffer = engine.noiseBuffer;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7500;
      g.gain.setValueAtTime(0.35 * vel, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      n.connect(hp).connect(g);
      n.start(when, Math.random() * 0.5);
      n.stop(when + 0.06);
      break;
    }
    case 'click':
    case 'clickAccent': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = kind === 'clickAccent' ? 1760 : 1320;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.5 * vel, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
      o.connect(g);
      o.start(when);
      o.stop(when + 0.06);
      break;
    }
  }
}

/** Short reference tone on the preview bus (Hear Target Note, trainer prompts). */
export function previewNote(engine: AudioEngine, midi: number, dur = 0.9, when?: number): void {
  playLead(engine, engine.preview, midi, when ?? engine.ctx.currentTime + 0.02, dur, 0.7);
}

/** Two-note success chime on the preview bus. */
export function chime(engine: AudioEngine, base = 84): void {
  const t = engine.ctx.currentTime + 0.01;
  playKeys(engine, engine.preview, base, t, 0.25, 0.5);
  playKeys(engine, engine.preview, base + 7, t + 0.08, 0.35, 0.45);
}
