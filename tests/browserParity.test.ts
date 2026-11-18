/// <reference types="node" />
/**
 * The browser analysis (src/analysis/) against a song's committed melody.json, on the song's
 * own recordings. Runs only when PARITY_DIR points at stems decoded by tools/decode_song.py
 * (they are derived from copyrighted audio and are not committed):
 *
 *   make parity SONG=love-yourself
 *
 * which decodes public/songs/<id>/ into work/parity/<id>/ and runs this file with
 * PARITY_DIR and MELODY_JSON set. Decoding with the Python tool keeps decoder differences out
 * of the comparison; the browser's own decoder is checked separately.
 *
 * Gates (docs/plans/2026-11-18-feat-vision-roadmap-plan.md, Phase 1): the browser targets
 * cover at least 95 % of the committed target seconds at the same MIDI note, and the note
 * count is within 5 %. The committed file was made by whatever librosa version was installed
 * then; a different version can account for small differences.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeSong } from '../src/analysis/prepare';
import { readWav } from './helpers/wav';

const DIR = process.env.PARITY_DIR;
const MELODY = process.env.MELODY_JSON;

type N = { t: number; d: number; m: number };

/** Seconds of `a` covered by notes of `b` with the same MIDI note. */
function coveredSeconds(a: readonly N[], b: readonly N[]): number {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      if (y.m !== x.m) continue;
      const lo = Math.max(x.t, y.t);
      const hi = Math.min(x.t + x.d, y.t + y.d);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

describe.skipIf(!DIR || !MELODY)('browser analysis matches the committed targets', () => {
  it('on the song’s own stems', () => {
    const desc = JSON.parse(readFileSync(join(DIR!, 'decoded.json'), 'utf8')) as { song: string; referenceKind: 'mix' | 'vocal' };
    const load = (role: string) => (existsSync(join(DIR!, `${role}.wav`)) ? readWav(join(DIR!, `${role}.wav`)).samples : null);
    const instrumental = load('instrumental')!;
    const vocal = load('vocal')!;
    const mix = load('mix');
    const want = JSON.parse(readFileSync(MELODY!, 'utf8')) as { notes: N[]; bpm: number; key: unknown; referenceOffset: number; analysis?: { alignment?: unknown } };
    const t0 = Date.now();
    const { doc, report } = analyzeSong({ instrumental, vocal, mix, referenceKind: desc.referenceKind });
    const secs = (Date.now() - t0) / 1000;
    const wantSeconds = want.notes.reduce((s, n) => s + n.d, 0);
    const gotSeconds = doc.notes.reduce((s, n) => s + n.d, 0);
    const recall = coveredSeconds(want.notes, doc.notes) / wantSeconds;
    const precision = coveredSeconds(doc.notes, want.notes) / gotSeconds;
    const countRatio = doc.notes.length / want.notes.length;
    const summary = [
      `song ${desc.song}: analyzed in ${secs.toFixed(1)} s`,
      `notes: browser ${doc.notes.length}, committed ${want.notes.length} (ratio ${countRatio.toFixed(3)})`,
      `target seconds: browser ${gotSeconds.toFixed(1)}, committed ${wantSeconds.toFixed(1)}`,
      `committed target time matched by the browser at the same note: ${(100 * recall).toFixed(2)} %`,
      `browser target time matched by the committed targets: ${(100 * precision).toFixed(2)} %`,
      `referenceOffset: browser ${doc.referenceOffset}, committed ${want.referenceOffset}`,
      `tempo (browser estimate, not compared): browser ${doc.bpm}, committed ${want.bpm}; key browser ${JSON.stringify(doc.key)}, committed ${JSON.stringify(want.key)}`,
      ...report.warnings.map((w) => `warning: ${w}`),
    ].join('\n');
    process.stdout.write(`\n${summary}\n`);
    writeFileSync(join(DIR!, 'parity-report.txt'), `${summary}\n`);
    writeFileSync(join(DIR!, 'browser-melody.json'), JSON.stringify(doc));
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(Math.abs(countRatio - 1)).toBeLessThanOrEqual(0.05);
  }, 600000);
});
