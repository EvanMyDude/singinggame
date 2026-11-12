/// <reference types="node" />
/**
 * End-to-end check of a song's scoring target: its reference vocal is fed through the app's
 * own pitch tracker and scored against its melody.json with a perfect clock. If the target
 * is usable, "singing exactly like the reference" must score well.
 *
 * Runs only when VOCAL_WAV points at the vocal as a WAV file (it is derived from copyrighted
 * audio and is not committed):
 *
 *   npm run prepare-song -- public/songs/<id> --vocal-wav /tmp/vocal.wav
 *   VOCAL_WAV=/tmp/vocal.wav MELODY_JSON=public/songs/<id>/melody.json npm test -- referenceVocal
 *
 * MELODY_JSON defaults to Old Town Road, whose vocal is the residual written by
 * `tools/extract_melody.py --residual-wav` (RESIDUAL_WAV is accepted as the older name).
 */
import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { PitchTracker } from '../src/audio/pitch/tracker';
import { BeatMap, buildSections, melodyToSong, parseMelody } from '../src/core/melody';
import { ScoreEngine, gradeFor } from '../src/core/scoring';

const VOCAL_WAV = process.env.VOCAL_WAV || process.env.RESIDUAL_WAV;
const MELODY_JSON = process.env.MELODY_JSON || 'public/songs/old-town-road/melody.json';

/** Mono samples of a PCM or float WAV file (channels are averaged). */
function readWav(path: string): { sr: number; data: Float32Array } {
  const buf = readFileSync(path);
  const fmt = buf.readUInt16LE(20);
  const channels = buf.readUInt16LE(22);
  const sr = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const bytes = bits / 8;
  let off = 12;
  while (off < buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const frames = Math.floor(Math.min(size, buf.length - off - 8) / (bytes * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const at = off + 8 + (i * channels + c) * bytes;
          sum += bits === 16 ? buf.readInt16LE(at) / 32768 : fmt === 3 ? buf.readFloatLE(at) : buf.readInt32LE(at) / 2147483648;
        }
        out[i] = sum / channels;
      }
      return { sr, data: out };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

describe.skipIf(!VOCAL_WAV)('reference vocal scored against the song target', () => {
  it('scores the reference vocal itself highly', () => {
    const wav = readWav(VOCAL_WAV!);
    const raw = JSON.parse(readFileSync(MELODY_JSON, 'utf8')) as { analysis?: { alignment?: { vocal?: { songOffsetSeconds?: number } } } };
    const melody = parseMelody(raw);
    // Song time = vocal file time + shift (0 for a residual already on the song timeline).
    const shift = raw.analysis?.alignment?.vocal?.songOffsetSeconds ?? 0;
    const map = new BeatMap(melody);
    const song = melodyToSong(melody, 'x', 'X', buildSections(melody, null, null), map);
    const tracker = new PitchTracker(wav.sr, { gateDb: -40 });
    const t0 = map.seconds(0) - shift; // the clock is the vocal file's own time
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
    const worst = eng.results.filter((r) => r.judgment === 'off' || r.judgment === 'miss').map((r) => `${map.seconds(r.start).toFixed(1)}s m${r.midi} ${r.judgment} bias ${r.biasCents.toFixed(0)}`);
    console.log('off or missed notes:', worst.slice(0, 30).join(' | '));
    expect(eng.accuracyPct).toBeGreaterThan(75);
  });
});
