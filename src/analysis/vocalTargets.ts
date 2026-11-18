import { lineSlope, median, nanMedian, percentile, round2, roundHalfEven, searchSorted } from './numeric';

/**
 * Turn a frame-wise pitch contour of an isolated lead vocal into singable target notes.
 *
 * A port of tools/vocal_targets.py, which stays the reference: the same steps, parameters and
 * rejection accounting, checked against fixtures the Python module writes
 * (tests/fixtures/analysis-contours.json). See that module for why each step exists:
 * dropouts are bridged, short octave blips folded back, note changes found on a contour
 * smoothed over about one vibrato cycle, scoops trimmed, glides and stray notes rejected.
 */

export interface TargetParams {
  hopS: number;
  minNoteS: number;
  bridgeGapS: number;
  smoothS: number;
  splitSemitones: number;
  splitHoldS: number;
  coreTol: number;
  maxTrimS: number;
  maxMadCents: number;
  maxDrift: number;
  mergeGapS: number;
  outlierSemitones: number;
  outlierMaxS: number;
  outlierContextS: number;
  octaveRunS: number;
  octaveContextS: number;
}

export function targetParams(hopS: number): TargetParams {
  return {
    hopS,
    minNoteS: 0.1,
    bridgeGapS: 0.035,
    smoothS: 0.15,
    splitSemitones: 0.7,
    splitHoldS: 0.045,
    coreTol: 0.5,
    maxTrimS: 0.15,
    maxMadCents: 40,
    maxDrift: 0.5,
    mergeGapS: 0.06,
    outlierSemitones: 9,
    outlierMaxS: 0.3,
    outlierContextS: 5,
    octaveRunS: 0.15,
    octaveContextS: 0.25,
  };
}

export interface TargetNote {
  start: number;
  end: number;
  midi: number;
  /** Median sung pitch (fractional MIDI). */
  median: number;
  madCents: number;
}

export type LossReason = 'transition' | 'tooShort' | 'unstable' | 'outlier';

export interface ContourStats {
  voicedSeconds: number;
  scoredSeconds: number;
  lostSeconds: Record<LossReason, number>;
  octaveRepairSeconds: number;
  /** Per frame: inside a kept note. */
  inNote: Uint8Array;
  /** Per frame: voiced after bridging. */
  voiced: Uint8Array;
}

/** MIDI note numbers; NaN where the frequency is missing or not positive. */
export function hzToMidi(f0: ArrayLike<number>): Float64Array {
  const out = new Float64Array(f0.length);
  for (let i = 0; i < f0.length; i++) {
    const f = f0[i]!;
    out[i] = Number.isFinite(f) && f > 0 ? 69 + 12 * Math.log2(f / 440) : NaN;
  }
  return out;
}

/** Frames within `gateDb` of the track's loud level (its 95th percentile). */
export function levelGate(db: ArrayLike<number>, gateDb = 35): Uint8Array {
  const out = new Uint8Array(db.length);
  if (!db.length) return out;
  const thr = percentile(db, 95) - gateDb;
  for (let i = 0; i < db.length; i++) out[i] = db[i]! > thr ? 1 : 0;
  return out;
}

function frames(seconds: number, hopS: number, minimum = 1): number {
  return Math.max(minimum, roundHalfEven(seconds / hopS));
}

/** Centered moving median that ignores NaN; all-NaN windows give NaN. */
export function nanMedianFilter(x: ArrayLike<number>, size: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const w = Math.max(1, size) | 1;
  const pad = w >> 1;
  for (let i = 0; i < n; i++) out[i] = nanMedian(x, Math.max(0, i - pad), Math.min(n, i + pad + 1));
  return out;
}

/** Fill unvoiced gaps of at most `maxGap` frames that have voiced frames on both sides. */
export function bridgeGaps(midiIn: ArrayLike<number>, voicedIn: ArrayLike<number>, maxGap: number): { midi: Float64Array; voiced: Uint8Array } {
  const midi = Float64Array.from(midiIn);
  const voiced = Uint8Array.from(voicedIn, (v) => (v ? 1 : 0));
  const n = voiced.length;
  let i = 0;
  while (i < n) {
    if (voiced[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !voiced[j]) j++;
    if (i > 0 && j < n && j - i <= maxGap) {
      // numpy.interp's formula, so the bridged values match the reference bit for bit.
      const a = midi[i - 1]!;
      const slope = (midi[j]! - a) / (j - (i - 1));
      for (let k = i; k < j; k++) {
        midi[k] = slope * (k - (i - 1)) + a;
        voiced[k] = 1;
      }
    }
    i = j;
  }
  return { midi, voiced };
}

/**
 * Fold short runs that sit one octave from their surroundings back onto them. The
 * reference is the median pitch within `octaveContextS` on each side, so a short run is a
 * minority there while a sustained octave leap becomes the reference itself.
 */
export function repairOctaves(midi: ArrayLike<number>, voiced: ArrayLike<number>, p: TargetParams): { midi: Float64Array; fixed: number } {
  const out = Float64Array.from(midi);
  const n = out.length;
  const masked = new Float64Array(n);
  for (let i = 0; i < n; i++) masked[i] = voiced[i] ? out[i]! : NaN;
  const ref = nanMedianFilter(masked, 2 * frames(p.octaveContextS, p.hopS) + 1);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = out[i]! - ref[i]!;
  const maxRun = frames(p.octaveRunS, p.hopS);
  let fixed = 0;
  for (const sign of [1, -1]) {
    const cand = (k: number) => !!voiced[k] && Number.isFinite(d[k]!) && Math.abs(d[k]! - 12 * sign) < 1;
    let i = 0;
    while (i < n) {
      if (!cand(i)) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && cand(j)) j++;
      if (j - i <= maxRun) {
        for (let k = i; k < j; k++) out[k]! -= 12 * sign;
        fixed += j - i;
      }
      i = j;
    }
  }
  return { midi: out, fixed };
}

/** Sorted multiset of numbers with an O(n) insert and O(1) median (notes are short). */
class RunningMedian {
  private readonly a: number[] = [];
  push(v: number): void {
    this.a.splice(searchSorted(this.a, v), 0, v);
  }
  get value(): number {
    const n = this.a.length;
    const h = n >> 1;
    return n % 2 ? this.a[h]! : (this.a[h - 1]! + this.a[h]!) / 2;
  }
}

/** Split each voiced run where the smoothed pitch leaves the current note and stays away. */
function segments(s: Float64Array, voiced: Uint8Array, p: TargetParams): [number, number][] {
  const hold = frames(p.splitHoldS, p.hopS, 2);
  const out: [number, number][] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (!voiced[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && voiced[end]) end++;
    let a = i;
    while (a < end) {
      const vals = new RunningMedian();
      vals.push(s[a]!);
      let k = a + 1;
      while (k < end) {
        const center = vals.value;
        if (Math.abs(s[k]! - center) > p.splitSemitones) {
          let away = true;
          for (let q = k; q < Math.min(end, k + hold); q++) {
            if (!(Math.abs(s[q]! - center) > p.splitSemitones)) {
              away = false;
              break;
            }
          }
          if (away) break;
        }
        vals.push(s[k]!);
        k++;
      }
      out.push([a, k]);
      a = k;
    }
    i = end;
  }
  return out;
}

/** Marks short notes that sit far from the melody around them (a tracker locking onto a harmonic). */
export function isolatedOutliers(notes: readonly TargetNote[], p: TargetParams): boolean[] {
  const mid = notes.map((x) => (x.start + x.end) / 2);
  const dur = notes.map((x) => x.end - x.start);
  return notes.map((x, i) => {
    const near: number[] = [];
    let total = 0;
    for (let j = 0; j < notes.length; j++) {
      if (j !== i && Math.abs(mid[j]! - mid[i]!) <= p.outlierContextS) {
        near.push(j);
        total += dur[j]!;
      }
    }
    if (dur[i]! >= p.outlierMaxS || total < 1) return false;
    near.sort((a, b) => notes[a]!.midi - notes[b]!.midi);
    const cum: number[] = [];
    let c = 0;
    for (const j of near) {
      c += dur[j]!;
      cum.push(c);
    }
    const center = notes[near[searchSorted(cum, c / 2)]!]!.midi;
    return Math.abs(x.midi - center) >= p.outlierSemitones;
  });
}

/**
 * Target notes from a contour. `midi` is fractional MIDI per frame (NaN where unvoiced);
 * `voiced` marks frames that are pitched and loud enough to be the lead vocal. Frame k is at
 * time k * hopS.
 */
export function notesFromContour(midiIn: ArrayLike<number>, voicedIn: ArrayLike<number | boolean>, p: TargetParams): { notes: TargetNote[]; stats: ContourStats } {
  const n = midiIn.length;
  const hop = p.hopS;
  const voiced0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) voiced0[i] = voicedIn[i] && Number.isFinite(midiIn[i]!) ? 1 : 0;
  const { midi, voiced: vb } = bridgeGaps(midiIn, voiced0, frames(p.bridgeGapS, hop));
  const { midi: raw, fixed: octaveFrames } = repairOctaves(midi, vb, p);
  const masked = new Float64Array(n);
  for (let i = 0; i < n; i++) masked[i] = vb[i] ? raw[i]! : NaN;
  const smooth = nanMedianFilter(masked, frames(p.smoothS, hop));
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = vb[i] ? smooth[i]! : NaN;

  const minFrames = frames(p.minNoteS, hop, 3);
  const maxTrim = frames(p.maxTrimS, hop);
  const reason: Record<LossReason, Uint8Array> = { transition: new Uint8Array(n), tooShort: new Uint8Array(n), unstable: new Uint8Array(n), outlier: new Uint8Array(n) };
  const kept: { a: number; b: number; note: TargetNote }[] = [];
  for (const [a, b] of segments(s, vb, p)) {
    const center = median(s, a, b);
    let a2 = a;
    let b2 = b;
    while (a2 < b && a2 - a < maxTrim && Math.abs(s[a2]! - center) > p.coreTol) a2++;
    while (b2 > a2 && b - b2 < maxTrim && Math.abs(s[b2 - 1]! - center) > p.coreTol) b2--;
    if (b2 - a2 < minFrames) {
      reason.tooShort.fill(1, a, b);
      continue;
    }
    const coreMed = median(s, a2, b2);
    const dev = new Float64Array(b2 - a2);
    for (let k = a2; k < b2; k++) dev[k - a2] = Math.abs(s[k]! - coreMed);
    const mad = median(dev) * 100;
    // A glide can pass the spread test while never settling: reject it by its slope.
    const drift = Math.abs(lineSlope(s, a2, b2)) * (b2 - a2);
    if (mad > p.maxMadCents || drift > p.maxDrift) {
      reason.unstable.fill(1, a, b);
      continue;
    }
    reason.transition.fill(1, a, a2);
    reason.transition.fill(1, b2, b);
    const med = median(raw, a2, b2);
    kept.push({ a: a2, b: b2, note: { start: a2 * hop, end: b2 * hop, midi: roundHalfEven(med), median: med, madCents: mad } });
  }

  let notes: TargetNote[] = [];
  let spans: [number, number][] = [];
  for (const { a, b, note } of kept) {
    const prev = notes[notes.length - 1];
    if (prev && prev.midi === note.midi && note.start - prev.end < p.mergeGapS) {
      const wa = prev.end - prev.start;
      const wb = note.end - note.start;
      notes[notes.length - 1] = { start: prev.start, end: note.end, midi: prev.midi, median: (prev.median * wa + note.median * wb) / (wa + wb), madCents: Math.max(prev.madCents, note.madCents) };
      spans[spans.length - 1]![1] = b;
    } else {
      notes.push(note);
      spans.push([a, b]);
    }
  }

  const stray = isolatedOutliers(notes, p);
  spans.forEach(([a, b], i) => {
    if (stray[i]) reason.outlier.fill(1, a, b);
  });
  notes = notes.filter((_, i) => !stray[i]);
  spans = spans.filter((_, i) => !stray[i]);

  const inNote = new Uint8Array(n);
  for (const [a, b] of spans) inNote.fill(1, a, b);
  const secs = (m: Uint8Array, exclude?: Uint8Array) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (m[i] && !(exclude && exclude[i])) c++;
    return round2(c * hop);
  };
  return {
    notes,
    stats: {
      voicedSeconds: secs(vb),
      scoredSeconds: secs(inNote),
      lostSeconds: {
        transition: secs(reason.transition, inNote),
        tooShort: secs(reason.tooShort, inNote),
        unstable: secs(reason.unstable, inNote),
        outlier: secs(reason.outlier, inNote),
      },
      octaveRepairSeconds: round2(octaveFrames * hop),
      inNote,
      voiced: vb,
    },
  };
}
