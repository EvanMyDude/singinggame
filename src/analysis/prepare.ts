import { measureLag, type LagInfo } from './align';
import { pyRound, round2 } from './numeric';
import { pyin } from './pyin';
import { estimateKey, estimateTempo } from './tempo';
import { hzToMidi, levelGate, notesFromContour, targetParams, type LossReason } from './vocalTargets';

/**
 * A song's target melody from its stems: the browser port of `analyze()` in
 * tools/prepare_song.py. Output is the melody.json format the app reads
 * (src/core/melody.ts), with `source.tool: "browser"`.
 *
 * Steps, as in the reference: the instrumental's timeline is the song timeline; with a full
 * mix, the instrumental and the vocal are both located inside it (align.ts); without one, the
 * stems are assumed to start together. pYIN tracks the vocal; frames count as sung when pYIN
 * calls them voiced and the vocal is within `gateDb` of its loud level; vocalTargets.ts makes
 * the notes. Tempo and key come from tempo.ts (simplified; they do not affect scoring).
 */

export const SR = 22050;
export const HOP = 256;
export const FRAME = 2048;
export const FMIN = 65;
export const FMAX = 1100;
const LEVEL_FRAME = 512;

export interface AnalysisInput {
  /** Mono audio at 22,050 Hz. */
  instrumental: Float32Array;
  vocal: Float32Array;
  mix: Float32Array | null;
  referenceKind: 'mix' | 'vocal';
  /** Vocal time = song time + offset; skips measuring. */
  vocalOffset?: number;
  gateDb?: number;
}

export interface AnalysisReport {
  lines: string[];
  warnings: string[];
  noteCount: number;
  scoredSeconds: number;
  presentSeconds: number;
  lostSeconds: Record<string, number>;
  range: [number, number] | null;
}

export interface MelodyDoc {
  version: 1;
  duration: number;
  referenceOffset: number;
  key: { tonic: number; mode: 'major' | 'minor' };
  bpm: number;
  firstBeat: number;
  tuningCents: number;
  hop: number;
  notes: { t: number; d: number; m: number; c: number }[];
  phrases: { t: number; e: number }[];
  source: { kind: 'isolated-vocal'; tracker: 'pyin'; tool: 'browser' };
  analysis: {
    alignment: Record<string, unknown>;
    presentSeconds: number;
    scoredSeconds: number;
    pitchedSeconds: number;
    lostSeconds: Record<string, number>;
    octaveRepairSeconds: number;
    tempoKey: 'browser-estimate';
  };
  sources?: string;
}

export type Progress = (stage: string, fraction: number) => void;

const r1 = (x: number) => pyRound(x, 1);
const r3 = (x: number) => pyRound(x, 3);
const r4 = (x: number) => pyRound(x, 4);

/** RMS in dB per frame, centered frames with zero padding (librosa.feature.rms, center=True). */
export function frameDb(y: ArrayLike<number>, frameLength: number, hop: number): Float64Array {
  const pad = frameLength >> 1;
  const n = 1 + Math.floor((y.length + 2 * pad - frameLength) / hop);
  const out = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    const start = t * hop - pad;
    for (let i = 0; i < frameLength; i++) {
      const k = start + i;
      if (k >= 0 && k < y.length) s += y[k]! * y[k]!;
    }
    const rms = Math.fround(Math.sqrt(s / frameLength));
    out[t] = Math.fround(20 * Math.log10(Math.max(rms, 1e-7)));
  }
  return out;
}

/** Frames where the vocal is sung, and where it is present (above the level gate). */
export function trackVocal(vocal: Float32Array, gateDb: number, onProgress?: (f: number) => void): { midi: Float64Array; sung: Uint8Array; present: Uint8Array } {
  const p = pyin(vocal, { sr: SR, frameLength: FRAME, hopLength: HOP, fmin: FMIN, fmax: FMAX }, onProgress);
  const db = frameDb(vocal, LEVEL_FRAME, HOP);
  const n = Math.min(p.f0.length, db.length);
  const midi = hzToMidi(p.f0.subarray(0, n));
  const present = levelGate(db.subarray(0, n), gateDb);
  const sung = new Uint8Array(n);
  for (let i = 0; i < n; i++) sung[i] = present[i] && p.voiced[i] && Number.isFinite(midi[i]!) ? 1 : 0;
  return { midi, sung, present };
}

/** Vocal phrases: voiced runs split at gaps over `gap` s, kept when at least `minLen` long. */
export function phrasesFrom(voiced: ArrayLike<number>, hopS: number, gap = 0.4, minLen = 0.3): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  let last: number | null = null;
  for (let k = 0; k < voiced.length; k++) {
    if (!voiced[k]) continue;
    const t = k * hopS;
    if (start === null) start = t;
    else if (last !== null && t - last > gap) {
      if (last + hopS - start >= minLen) out.push([start, last + hopS]);
      start = t;
    }
    last = t;
  }
  if (start !== null && last !== null && last + hopS - start >= minLen) out.push([start, last + hopS]);
  return out;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m: number) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

export function analyzeSong(input: AnalysisInput, onProgress: Progress = () => {}): { doc: MelodyDoc; report: AnalysisReport } {
  const { instrumental: inst, vocal, mix, referenceKind } = input;
  const gateDb = input.gateDb ?? 35;
  const hopS = HOP / SR;
  const lines: string[] = [];
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  const alignment: Record<string, unknown> = {};
  let lagIm = 0;
  let shift: number;

  onProgress('Aligning the files', 0);
  if (mix) {
    const r = measureLag(inst, mix, SR, 'the instrumental', 0.3, false, warn);
    lagIm = r.lag;
    alignment.mix = r.info;
    lines.push(`Full mix leads the instrumental by ${((-lagIm / SR) * 1000).toFixed(1)} ms.`);
  }
  if (input.vocalOffset !== undefined) {
    shift = -input.vocalOffset;
    alignment.vocal = { method: 'given', offsetSeconds: input.vocalOffset };
  } else if (mix) {
    const r = measureLag(vocal, mix, SR, 'the vocal', 0.2, true, warn);
    shift = (r.lag - lagIm) / SR;
    alignment.vocal = { method: 'measured', ...(r.info as LagInfo) };
    lines.push(`The vocal sits ${(shift * 1000 >= 0 ? '+' : '') + (shift * 1000).toFixed(1)} ms from the instrumental's timeline.`);
  } else {
    shift = 0;
    alignment.vocal = { method: 'assumed', offsetSeconds: 0 };
    lines.push('No full mix to measure against: the vocal and the instrumental are assumed to start together.');
  }
  (alignment.vocal as Record<string, unknown>).songOffsetSeconds = r4(shift);

  onProgress('Tracking the vocal pitch', 0.05);
  const { midi, sung, present: present0 } = trackVocal(vocal, gateDb, (f) => onProgress('Tracking the vocal pitch', 0.05 + 0.8 * f));
  onProgress('Finding the notes', 0.86);
  const { notes, stats } = notesFromContour(midi, sung, targetParams(hopS));
  const n = midi.length;
  const present = new Uint8Array(n);
  for (let i = 0; i < n; i++) present[i] = present0[i] || stats.inNote[i] ? 1 : 0;
  const duration = inst.length / SR;
  const onSong = (t: number) => t + shift;

  const outNotes: MelodyDoc['notes'] = [];
  for (const nt of notes) {
    const a = Math.max(0, onSong(nt.start));
    const b = Math.min(duration, onSong(nt.end));
    if (b - a >= 0.05) outNotes.push({ t: r3(a), d: r3(b - a), m: nt.midi, c: r3(nt.median - nt.midi) });
  }
  const phrases = phrasesFrom(stats.voiced, hopS)
    .map(([a, b]) => [Math.max(0, onSong(a)), Math.min(duration, onSong(b))] as [number, number])
    .filter(([a, b]) => b > a);

  onProgress('Estimating tempo and key', 0.9);
  const tempo = estimateTempo(inst, SR);
  const key = estimateKey(outNotes.map((x) => ({ midi: x.m, dur: x.d })));
  const devs = notes.length ? notes.map((x) => (x.median - x.midi) * 100) : [0];
  const tuning = devs.reduce((s, v) => s + v, 0) / devs.length;
  const secs = (m: Uint8Array, exclude?: Uint8Array) => {
    let c = 0;
    for (let i = 0; i < m.length; i++) if (m[i] && !(exclude && exclude[i])) c++;
    return round2(c * hopS);
  };
  const lost: Record<string, number> = { unpitched: secs(present, stats.voiced) };
  for (const k of Object.keys(stats.lostSeconds) as LossReason[]) lost[k] = stats.lostSeconds[k];
  const scored = r1(outNotes.reduce((s, x) => s + x.d, 0));

  const refOffset = referenceKind === 'mix' ? lagIm / SR : -shift;
  const doc: MelodyDoc = {
    version: 1,
    duration: r3(duration),
    referenceOffset: r4(refOffset) || 0,
    key: { tonic: key.tonic, mode: key.mode },
    bpm: pyRound(tempo.bpm, 2),
    firstBeat: r3(tempo.firstBeat),
    tuningCents: r1(tuning),
    hop: pyRound(hopS, 6),
    notes: outNotes,
    phrases: phrases.map(([a, b]) => ({ t: r3(a), e: r3(b) })),
    source: { kind: 'isolated-vocal', tracker: 'pyin', tool: 'browser' },
    analysis: {
      alignment,
      presentSeconds: r1(secs(present)),
      scoredSeconds: scored,
      pitchedSeconds: stats.voicedSeconds,
      lostSeconds: lost,
      octaveRepairSeconds: stats.octaveRepairSeconds,
      tempoKey: 'browser-estimate',
    },
  };

  lines.push(`Tempo estimate ${doc.bpm.toFixed(1)} BPM; key estimate ${NAMES[key.tonic]} ${key.mode}.`);
  lines.push(`Vocal present ${secs(present).toFixed(1)} s; pitched ${stats.voicedSeconds.toFixed(1)} s; targets ${scored.toFixed(1)} s in ${outNotes.length} notes, ${phrases.length} phrases.`);
  lines.push(`Present but without a target (s): ${Object.entries(lost).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}; octave repairs ${stats.octaveRepairSeconds.toFixed(2)} s.`);
  let range: [number, number] | null = null;
  if (outNotes.length) {
    const ms = outNotes.map((x) => x.m);
    range = [Math.min(...ms), Math.max(...ms)];
    const off = devs.map(Math.abs);
    lines.push(`Range ${noteName(range[0])} to ${noteName(range[1])}; mean deviation from equal temperament ${tuning >= 0 ? '+' : ''}${tuning.toFixed(1)} cents.`);
    lines.push(`Distance of the sung pitch from its target semitone: ${off.filter((v) => v <= 25).length} notes within 25 cents, ${off.filter((v) => v > 25 && v <= 40).length} at 25 to 40, ${off.filter((v) => v > 40).length} beyond 40.`);
  } else {
    warn('No target notes were produced. Check that the vocal file is the isolated vocal.');
  }
  const presentSeconds = secs(present);
  onProgress('Done', 1);
  return {
    doc,
    report: { lines, warnings, noteCount: outNotes.length, scoredSeconds: scored, presentSeconds, lostSeconds: lost, range },
  };
}
