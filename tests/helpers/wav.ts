/// <reference types="node" />
import { readFileSync } from 'fs';

/**
 * Reads a mono or multi-channel WAV (16-bit PCM or 32-bit float) as mono float32, the way
 * soundfile reads it for tools/prepare_song.py (PCM / 32768, channels averaged).
 */
export function readWav(path: string): { sr: number; samples: Float32Array } {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path} is not a WAV file`);
  let pos = 12;
  let fmt: { format: number; channels: number; sr: number; bits: number } | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      if (format === 0xfffe) format = dv.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: dv.getUint16(body + 2, true), sr: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt) throw new Error(`${path}: data before fmt`);
      const bytes = fmt.bits / 8;
      const frames = Math.floor(size / (bytes * fmt.channels));
      const out = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (f * fmt.channels + c) * bytes;
          if (fmt.format === 1 && fmt.bits === 16) s += dv.getInt16(o, true) / 32768;
          else if (fmt.format === 3 && fmt.bits === 32) s += dv.getFloat32(o, true);
          else throw new Error(`${path}: unsupported WAV format ${fmt.format}/${fmt.bits}`);
        }
        out[f] = s / fmt.channels;
      }
      return { sr: fmt.sr, samples: out };
    }
    pos = body + size + (size & 1);
  }
  throw new Error(`${path}: no audio data`);
}
