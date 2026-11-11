import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import melodyJson from '../public/songs/old-town-road/melody.json';
import baseline from './fixtures/scoring-reviewed.json';
import { BeatMap, melodyToSong, parseMelody } from '../src/core/melody';
import { ScoreEngine, gradeFor } from '../src/core/scoring';
import { simulateSinger, type SingerOpts } from './helpers/singer';

// Captured from the reviewed scorer, using the deployed target pack. Each hash covers the
// complete ordered values, including per-frame judgments and every per-target result.
// Only golden-vector serialization rounds floating values to 1e-9; libm/V8 revisions can
// differ in their last bits. Inputs to the scorer and the summary assertions remain exact.
const cases: Record<string, SingerOpts> = {
  accurate: { sigmaCents: 3 },
  flat: { biasCents: -40, sigmaCents: 4 },
  mixed: { noteSigmaCents: 55, sigmaCents: 10, reaction: 0.08, gapFraction: 0.15, seed: 9 },
  latency: { latency: 0.18, reaction: 0.04, sigmaCents: 4 },
  octave: { octaveShift: -12, sigmaCents: 4 },
  silence: { silent: true },
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) => {
  if (typeof v !== 'number' || Number.isInteger(v)) return v;
  return Number.isFinite(v) ? Number(v.toFixed(9)) : { $number: String(v) };
})).digest('hex');

describe('scoring parity with reviewed commit 38c339f', () => {
  it('keeps the reviewed scorer and pitch math byte-identical for this reporting patch', () => {
    for (const [file, expected] of Object.entries(baseline.sourceSha256)) {
      const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url));
      expect(createHash('sha256').update(source).digest('hex')).toBe(expected);
    }
  });
  const melody = parseMelody(melodyJson);
  const map = new BeatMap(melody);
  const song = melodyToSong(melody, 'parity', 'Parity', [], map);
  for (const [name, opts] of Object.entries(cases)) {
    it(`preserves exact score outcomes and vectors within 1e-9: ${name}`, () => {
      const frames = simulateSinger(song, 5, map.secPerBeat, 512 / 48000, opts);
      const scorer = new ScoreEngine(song, { t0: 5, secPerBeat: map.secPerBeat, latency: opts.latency ?? 0, frameInterval: 512 / 48000, foldOctaves: true });
      const judges = frames.map((frame) => {
        const judgment = scorer.ingest(frame);
        scorer.advance(frame.time);
        return judgment;
      });
      scorer.finishAll();
      expect({
        frames: hash(frames), judges: hash(judges), notes: hash(scorer.results),
        score: scorer.score, grade: gradeFor(scorer.accuracyPct), accuracy: scorer.accuracyPct,
        timing: scorer.timingPct, counts: scorer.counts, streak: scorer.streak, bestStreak: scorer.bestStreak,
      }).toEqual(baseline.cases[name as keyof typeof baseline.cases]);
    });
  }
});
