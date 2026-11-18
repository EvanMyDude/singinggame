import type { AnalysisInput, AnalysisReport, MelodyDoc } from './prepare';
import type { WorkerReply } from './worker';

/**
 * Main-thread side of the song analysis: decodes the picked files the way
 * tools/prepare_song.py does (mono, 22,050 Hz), fingerprints them, and runs the analysis in a
 * worker so the page stays responsive. Nothing is uploaded; everything stays in this browser.
 */

export const ANALYSIS_SR = 22050;

/** Decodes an audio file to mono float32 at 22,050 Hz (channels averaged, as soundfile + librosa). */
export async function decodeMono(file: Blob): Promise<Float32Array> {
  const bytes = await file.arrayBuffer();
  const Ctor: typeof OfflineAudioContext =
    window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  // decodeAudioData resamples to the context's rate; the context itself never renders.
  const ctx = new Ctor(1, 1, ANALYSIS_SR);
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(`${(file as File).name ?? 'The file'} could not be decoded by this browser. Try an MP3, M4A or WAV.`);
  }
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i]! += d[i]!;
  }
  const k = 1 / buf.numberOfChannels;
  for (let i = 0; i < out.length; i++) out[i]! *= k;
  return out;
}

/**
 * The `sources` signature prepare_song writes: the first 12 hex digits of SHA-1 over the
 * SHA-1 digests of the instrumental, the vocal and the mix, in that order.
 */
export async function sourceSignature(files: (Blob | null)[]): Promise<string | null> {
  if (!crypto?.subtle) return null;
  const parts: Uint8Array[] = [];
  for (const f of files) if (f) parts.push(new Uint8Array(await crypto.subtle.digest('SHA-1', await f.arrayBuffer())));
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', all));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

export interface AnalysisRun {
  promise: Promise<{ doc: MelodyDoc; report: AnalysisReport }>;
  cancel: () => void;
}

/** Runs the analysis in a worker. The input arrays are transferred, not copied. */
export function runAnalysis(input: AnalysisInput, onProgress: (stage: string, fraction: number) => void): AnalysisRun {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  let settle: { reject: (e: Error) => void } | null = null;
  const promise = new Promise<{ doc: MelodyDoc; report: AnalysisReport }>((resolve, reject) => {
    settle = { reject };
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.stage, m.fraction);
      else {
        worker.terminate();
        if (m.type === 'done') resolve({ doc: m.doc, report: m.report });
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The analysis stopped unexpectedly.'));
    };
  });
  const transfer = [input.instrumental.buffer, input.vocal.buffer, ...(input.mix ? [input.mix.buffer] : [])] as ArrayBuffer[];
  worker.postMessage(input, transfer);
  return {
    promise,
    cancel: () => {
      worker.terminate();
      settle?.reject(new Error('Cancelled.'));
    },
  };
}
