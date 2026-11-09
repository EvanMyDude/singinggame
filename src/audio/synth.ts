import { midiToHz } from '../core/music';
import type { AudioEngine } from './engine';

/**
 * The small set of synthesized sounds still used: a warm lead tone (reference notes) and
 * the calibration clicks. Every voice is scheduled at an exact AudioContext time and cleans
 * itself up.
 */

export type DrumKind = 'click' | 'clickAccent';

const waves = new WeakMap<BaseAudioContext, PeriodicWave>();

/** Warm, clearly pitched lead (strong fundamental, few harmonics). */
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

export function playDrum(engine: AudioEngine, dest: AudioNode, kind: DrumKind, when: number, vel: number): void {
  const ctx = engine.ctx;
  const g = ctx.createGain();
  g.connect(dest);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = kind === 'clickAccent' ? 1760 : 1320;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(0.5 * vel, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
  o.connect(g);
  o.start(when);
  o.stop(when + 0.06);
}

/** Short reference tone on the preview bus. */
export function previewNote(engine: AudioEngine, midi: number, dur = 0.9, when?: number): void {
  playLead(engine, engine.preview, midi, when ?? engine.ctx.currentTime + 0.02, dur, 0.7);
}
