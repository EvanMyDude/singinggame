import { FFT } from '../audio/pitch/fft';
import { roundHalfEven } from './numeric';

/**
 * Probabilistic YIN (Mauch & Dixon 2014), ported from librosa.pyin (librosa 1.0) with the
 * defaults tools/prepare_song.py relies on. The note thresholds in vocalTargets.ts were tuned
 * on this tracker's contours, so the port follows librosa step by step rather than
 * approximating it:
 *
 *   1. Frames centered on every hop (zero padding at the ends), the cumulative mean
 *      normalized difference from an FFT autocorrelation, as librosa computes it.
 *   2. Every trough of each frame gets a probability from a beta prior over 100 thresholds
 *      and a Boltzmann prior over trough order; the global minimum gets the no-trough mass.
 *   3. Candidates become 10-cent pitch bins (parabolic interpolation, round half to even;
 *      when two candidates land in one bin the longer period wins, as numpy's assignment
 *      does).
 *   4. Viterbi decoding over voiced and unvoiced copies of the bins with a triangular local
 *      transition, a 1 % voicing switch, and transitions below 1e-4 skipped (librosa's
 *      `transition_min_prob`).
 *
 * librosa computes the autocorrelation and difference function in float32 because the
 * decoded audio is float32, and everything after in float64; Math.fround marks the float32
 * steps so near-ties resolve the same way.
 * tests/analysis.test.ts checks the output against librosa on committed fixtures.
 */

export interface PyinOptions {
  sr: number;
  frameLength: number;
  hopLength: number;
  fmin: number;
  fmax: number;
}

export interface PyinResult {
  /** Hz per frame; NaN where unvoiced. Frame k is centered at sample k * hopLength. */
  f0: Float64Array;
  voiced: Uint8Array;
  voicedProb: Float64Array;
}

const N_THRESHOLDS = 100;
const BETA = [2, 18] as const;
const BOLTZMANN = 2;
const RESOLUTION = 0.1;
const MAX_TRANSITION_RATE = 35.92;
const SWITCH_PROB = 0.01;
const NO_TROUGH_PROB = 0.01;
const TRANSITION_MIN_PROB = 1e-4;
const TINY64 = 2.2250738585072014e-308;

/** Regularized incomplete beta I_x(a, b) for integer a, b (the binomial tail identity). */
function betaCdfInt(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const n = a + b - 1;
  let sum = 0;
  let c = 1; // C(n, j)
  for (let j = 0; j <= n; j++) {
    if (j >= a) sum += c * x ** j * (1 - x) ** (n - j);
    c = (c * (n - j)) / (j + 1);
  }
  return sum;
}

function boltzmannPmf(k: number, lambda: number, n: number): number {
  if (k < 0 || k >= n) return 0;
  return ((-Math.expm1(-lambda)) / (-Math.expm1(-lambda * n))) * Math.exp(-lambda * k);
}

/** The triangular local transition matrix (librosa.sequence.transition_local, wrap=False). */
function localTransition(nBins: number, width: number): Float64Array[] {
  const half = width >> 1;
  const rows: Float64Array[] = [];
  for (let i = 0; i < nBins; i++) {
    const row = new Float64Array(nBins);
    let sum = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(nBins - 1, i + half); j++) {
      // scipy.signal.windows.triang(M, sym=True) for odd M: 2n / (M + 1), n = 1..(M+1)/2.
      const w = (2 * ((width + 1) / 2 - Math.abs(j - i))) / (width + 1);
      row[j] = w;
      sum += w;
    }
    for (let j = 0; j < nBins; j++) row[j]! /= sum;
    rows.push(row);
  }
  return rows;
}

interface Candidates {
  /** Per frame, the start of its candidates in `bin` / `logp`. */
  offset: Int32Array;
  bin: Int32Array;
  prob: Float64Array;
  voicedProb: Float64Array;
}

export function pyin(y: ArrayLike<number>, o: PyinOptions, onProgress?: (fraction: number) => void): PyinResult {
  const { sr, frameLength: L, hopLength: hop, fmin, fmax } = o;
  const minPeriod = Math.floor(sr / fmax);
  const maxPeriod = Math.min(Math.ceil(sr / fmin), L - 1);
  const nPeriods = maxPeriod - minPeriod + 1;
  const pad = L >> 1;
  const nFrames = 1 + Math.floor((y.length + 2 * pad - L) / hop);

  const thresholds = new Float64Array(N_THRESHOLDS + 1);
  for (let i = 0; i <= N_THRESHOLDS; i++) thresholds[i] = i === N_THRESHOLDS ? 1 : i * (1 / N_THRESHOLDS);
  const betaProbs = new Float64Array(N_THRESHOLDS);
  for (let i = 0; i < N_THRESHOLDS; i++) betaProbs[i] = betaCdfInt(thresholds[i + 1]!, BETA[0], BETA[1]) - betaCdfInt(thresholds[i]!, BETA[0], BETA[1]);
  const binsPerSemitone = Math.ceil(1 / RESOLUTION);
  const nBins = Math.floor(12 * binsPerSemitone * Math.log2(fmax / fmin)) + 1;

  // ---- 1-3: YIN per frame, trough probabilities, candidate bins ----
  let nfft = 1;
  while (nfft < 2 * L - 1) nfft <<= 1;
  const fft = new FFT(nfft);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const pr = new Float64Array(nfft);
  const pi = new Float64Array(nfft);
  const sample = (frame: number, i: number) => {
    const k = frame * hop + i - pad;
    return k >= 0 && k < y.length ? Math.fround(y[k]!) : 0;
  };
  const a = new Float64Array(maxPeriod + 1); // autocorrelation r(0..maxPeriod)
  const yin = new Float64Array(nPeriods);
  const d = new Float64Array(maxPeriod + 1);
  const offset = new Int32Array(nFrames + 1);
  const binList: number[] = [];
  const probList: number[] = [];
  const voicedProb = new Float64Array(nFrames);
  const frameProb = new Float64Array(nBins);
  const troughs: number[] = [];
  const troughProbs: number[] = [];

  for (let frame = 0; frame < nFrames; frame++) {
    // One frame per transform. Packing two real frames into one complex transform would
    // halve the work but leaks ~1e-17 of a loud frame into a silent neighbour, and YIN's
    // ratio turns that into troughs librosa (one real FFT per frame) never sees.
    re.fill(0);
    im.fill(0);
    let energy = 0;
    for (let i = 0; i < L; i++) {
      const v = sample(frame, i);
      re[i] = v;
      energy += v * v;
    }
    if (energy === 0) {
      a.fill(0);
    } else {
      fft.transform(re, im);
      for (let k = 0; k < nfft; k++) {
        pr[k] = re[k]! * re[k]! + im[k]! * im[k]!;
        pi[k] = 0;
      }
      fft.transform(pr, pi, true);
      for (let q = 0; q <= maxPeriod; q++) a[q] = Math.fround(pr[q]! / nfft);
    }

    if (onProgress && frame % 256 === 0) onProgress((0.5 * frame) / nFrames);
    // Energy prefix sums c[m] = sum_{i<=m} x_i^2, then d(k) = 2 (r(0) - r(k)) - c[k-1].
    let c = 0;
    d[0] = 0;
    for (let k = 1; k <= maxPeriod; k++) {
      const v = sample(frame, k - 1);
      c = Math.fround(c + Math.fround(v * v));
      d[k] = Math.fround(2 * (a[0]! - a[k]!) - c);
    }
    // yin(k) = d(k) / mean(d(1..k)): the running sum is float32 (numpy cumsum of the
    // float32 difference), the division by k is float64 (an int64 range), as in librosa.
    let run = 0;
    for (let k = 1; k <= maxPeriod; k++) {
      run = Math.fround(run + d[k]!);
      if (k >= minPeriod) yin[k - minPeriod] = d[k]! / (run / k + TINY64);
    }

    // Troughs: x[i] < x[i-1] and x[i] <= x[i+1]; the last if below its neighbour; the
    // first if below the second.
    troughs.length = 0;
    if (yin[0]! < yin[1]!) troughs.push(0);
    for (let q = 1; q < nPeriods - 1; q++) if (yin[q]! < yin[q - 1]! && yin[q]! <= yin[q + 1]!) troughs.push(q);
    if (yin[nPeriods - 1]! < yin[nPeriods - 2]!) troughs.push(nPeriods - 1);
    offset[frame] = binList.length;
    if (!troughs.length) {
      voicedProb[frame] = 0;
      continue;
    }
    troughProbs.length = 0;
    for (let t = 0; t < troughs.length; t++) troughProbs.push(0);
    for (let j = 0; j < N_THRESHOLDS; j++) {
      const thr = thresholds[j + 1]!;
      let n = 0;
      for (const q of troughs) if (yin[q]! < thr) n++;
      let pos = -1;
      for (let t = 0; t < troughs.length; t++) {
        if (yin[troughs[t]!]! < thr) {
          pos++;
          troughProbs[t]! += boltzmannPmf(pos, BOLTZMANN, n) * betaProbs[j]!;
        }
      }
    }
    let gm = 0;
    for (let t = 1; t < troughs.length; t++) if (yin[troughs[t]!]! < yin[troughs[gm]!]!) gm = t;
    let below = 0;
    for (let j = 0; j < N_THRESHOLDS; j++) if (!(yin[troughs[gm]!]! < thresholds[j + 1]!)) below++;
    let noTrough = 0;
    for (let j = 0; j < below; j++) noTrough += betaProbs[j]!;
    troughProbs[gm]! += NO_TROUGH_PROB * noTrough;

    frameProb.fill(0);
    const touched: number[] = [];
    for (let t = 0; t < troughs.length; t++) {
      const prob = troughProbs[t]!;
      if (prob === 0) continue;
      const q = troughs[t]!;
      const interior = q > 0 && q < nPeriods - 1;
      const qs = Math.min(Math.max(q, 1), nPeriods - 2);
      const vc = yin[qs]!;
      const vp = yin[qs + 1]!;
      const vm = yin[qs - 1]!;
      const aa = vp + vm - 2 * vc;
      const bb = 0.5 * (vp - vm);
      const shift = interior && Math.abs(bb) < Math.abs(aa) ? -bb / aa : 0;
      const period = minPeriod + q + shift;
      const f = sr / period;
      const bin = Math.min(Math.max(roundHalfEven(12 * binsPerSemitone * Math.log2(f / fmin)), 0), nBins);
      if (bin >= nBins) continue; // lands on the first unvoiced state, which is overwritten
      if (frameProb[bin] === 0) touched.push(bin);
      frameProb[bin] = prob; // a later (longer-period) candidate replaces an earlier one
    }
    let vsum = 0;
    for (const b of touched) vsum += frameProb[b]!;
    voicedProb[frame] = Math.min(1, Math.max(0, vsum));
    touched.sort((x, z) => x - z);
    for (const b of touched) {
      if (frameProb[b] === 0) continue;
      binList.push(b);
      probList.push(frameProb[b]!);
    }
  }
  offset[nFrames] = binList.length;
  const cand: Candidates = { offset, bin: Int32Array.from(binList), prob: Float64Array.from(probList), voicedProb };

  // ---- 4: Viterbi ----
  const maxSemitonesPerFrame = roundHalfEven((MAX_TRANSITION_RATE * 12 * hop) / sr);
  const width = maxSemitonesPerFrame * binsPerSemitone + 1;
  const T = localTransition(nBins, width);
  // librosa.sequence.transition_loop(2, 1 - switch_prob): the off-diagonal is (1 - p) / 1.
  const stay = 1 - SWITCH_PROB;
  const sw = (1 - stay) / (2 - 1);
  const S = 2 * nBins;
  const thr = Math.log(TRANSITION_MIN_PROB + TINY64);
  // Predecessors of each state with their log transition, in increasing state order.
  const predStart = new Int32Array(S + 1);
  const predState: number[] = [];
  const predLog: number[] = [];
  for (let j = 0; j < S; j++) {
    predStart[j] = predState.length;
    const vj = j < nBins ? 0 : 1;
    const bj = j % nBins;
    for (let k = 0; k < S; k++) {
      const vk = k < nBins ? 0 : 1;
      const bk = k % nBins;
      const t = T[bk]![bj]!;
      if (t === 0) continue;
      const lt = Math.log((vk === vj ? stay : sw) * t + TINY64);
      if (lt >= thr) {
        predState.push(k);
        predLog.push(lt);
      }
    }
  }
  predStart[S] = predState.length;
  const pState = Int32Array.from(predState);
  const pLog = Float64Array.from(predLog);

  const logEps = Math.log(TINY64);
  const logInit = Math.log(1 / S + TINY64);
  const ptr = new Uint16Array(nFrames * S);
  let prev = new Float64Array(S);
  let cur = new Float64Array(S);
  const obs = new Float64Array(S);
  const fillObs = (t: number) => {
    obs.fill(logEps, 0, nBins);
    for (let c = cand.offset[t]!; c < cand.offset[t + 1]!; c++) obs[cand.bin[c]!] = Math.log(cand.prob[c]! + TINY64);
    const u = Math.log((1 - cand.voicedProb[t]!) / nBins + TINY64);
    obs.fill(u, nBins, S);
  };
  fillObs(0);
  for (let j = 0; j < S; j++) prev[j] = obs[j]! + logInit;
  for (let t = 1; t < nFrames; t++) {
    fillObs(t);
    const base = t * S;
    for (let j = 0; j < S; j++) {
      let best = -Infinity;
      let arg = 0;
      for (let p = predStart[j]!; p < predStart[j + 1]!; p++) {
        const c = prev[pState[p]!]! + pLog[p]!;
        if (c > best) {
          best = c;
          arg = pState[p]!;
        }
      }
      ptr[base + j] = arg;
      cur[j] = obs[j]! + best;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    if (onProgress && t % 1024 === 0) onProgress(0.5 + (0.5 * t) / nFrames);
  }
  let state = 0;
  for (let j = 1; j < S; j++) if (prev[j]! > prev[state]!) state = j;
  const f0 = new Float64Array(nFrames);
  const voiced = new Uint8Array(nFrames);
  for (let t = nFrames - 1; t >= 0; t--) {
    voiced[t] = state < nBins ? 1 : 0;
    f0[t] = voiced[t] ? fmin * 2 ** ((state % nBins) / (12 * binsPerSemitone)) : NaN;
    if (t > 0) state = ptr[t * S + state]!;
  }
  onProgress?.(1);
  return { f0, voiced, voicedProb: cand.voicedProb };
}
