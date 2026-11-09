/// <reference types="node" />
/**
 * End-to-end check of the scoring target: the isolated reference vocal (written by
 * `tools/extract_melody.py --residual-wav`) is fed through the app's own pitch tracker and
 * scored against melody.json with a perfect clock. If the extraction is usable, "singing
 * exactly like the reference" must score well. Runs only when RESIDUAL_WAV points at the file
 * (it is derived from copyrighted audio and is not committed).
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { PitchTracker } from '../src/audio/pitch/tracker';
import { BeatMap, buildSections, melodyToSong, parseMelody } from '../src/core/melody';
import { ScoreEngine, gradeFor } from '../src/core/scoring';
import melodyJson from '../public/songs/old-town-road/melody.json';

function readWav(path: string): { sr: number; data: Float32Array } {
  const buf = readFileSync(path);
  const sr = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const fmt = buf.readUInt16LE(20);
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = bits === 16 ? size / 2 : size / 4;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = bits === 16 ? buf.readInt16LE(off + 8 + i * 2) / 32768 : fmt === 3 ? buf.readFloatLE(off + 8 + i * 4) : buf.readInt32LE(off + 8 + i * 4) / 2147483648;
      return { sr, data: out };
    }
    off += 8 + size;
  }
  throw new Error('no data chunk');
}

describe.skipIf(!process.env.RESIDUAL_WAV)('reference vocal scored against the extracted melody', () => {
  it('scores the reference vocal itself highly', () => {
    const wav = readWav(process.env.RESIDUAL_WAV!);
    const melody = parseMelody(melodyJson);
    const map = new BeatMap(melody);
    const song = melodyToSong(melody, 'x', 'X', buildSections(melody, null, null), map);
    const tracker = new PitchTracker(wav.sr, { gateDb: -40 });
    const t0 = map.seconds(0); // song time 0 at ctx time 0: ctx time == song time
    const eng = new ScoreEngine(song, { t0, secPerBeat: map.secPerBeat, latency: 0, frameInterval: tracker.hop / wav.sr, foldOctaves: true, startBeat: 0 });
    const chunk = 512;
    let voiced = 0;
    let total = 0;
    for (let i = 0; i + chunk <= wav.data.length; i += chunk) {
      for (const f of tracker.push(wav.data.subarray(i, i + chunk), i / wav.sr)) {
        total++;
        if (f.voiced) voiced++;
        eng.ingest(f);
        eng.advance(f.time);
      }
    }
    eng.finishAll();
    const c = eng.counts;
    console.log(`voiced ${((100 * voiced) / total).toFixed(1)}% · accuracy ${eng.accuracyPct.toFixed(1)}% grade ${gradeFor(eng.accuracyPct)} · timing ${eng.timingPct.toFixed(1)}% · perfect ${c.perfect} great ${c.great} good ${c.good} off ${c.off} miss ${c.miss} of ${song.notes.length}`);
    const offNotes = eng.results.filter((r) => r.judgment === 'off').map((r) => `${map.seconds(r.start).toFixed(1)}s m${r.midi} bias ${r.biasCents.toFixed(0)}`);
    console.log('off notes:', offNotes.slice(0, 20).join(' | '));
    expect(eng.accuracyPct).toBeGreaterThan(75);
  });
});
