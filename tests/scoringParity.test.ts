import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import melodyJson from '../public/songs/old-town-road/melody.json';
import baseline from './fixtures/scoring-reviewed.json';
import { BeatMap, melodyToSong, parseMelody } from '../src/core/melody';
import { ScoreEngine, gradeFor } from '../src/core/scoring';
import { simulateSinger, type SingerOpts } from './helpers/singer';

// Captured from the reviewed scorer, using the deployed target pack. Each hash covers the
// complete ordered values, including per-frame judgments and every per-target result.
const cases: Record<string, SingerOpts> = {
  accurate: { sigmaCents: 3 },
  flat: { biasCents: -40, sigmaCents: 4 },
  mixed: { noteSigmaCents: 55, sigmaCents: 10, reaction: 0.08, gapFraction: 0.15, seed: 9 },
  latency: { latency: 0.18, reaction: 0.04, sigmaCents: 4 },
  octave: { octaveShift: -12, sigmaCents: 4 },
  silence: { silent: true },
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('scoring parity with reviewed commit 38c339f', () => {
  const melody = parseMelody(melodyJson);
  const map = new BeatMap(melody);
  const song = melodyToSong(melody, 'parity', 'Parity', [], map);
  for (const [name, opts] of Object.entries(cases)) {
    it(`keeps identical frames, score, grade, accuracy, judgments and streak: ${name}`, () => {
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
