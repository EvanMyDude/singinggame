/** Deterministic test signal generators. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sine(hz: number, sr: number, n: number, amp = 0.5, phase = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(phase + (2 * Math.PI * hz * i) / sr);
  return out;
}

/**
 * Voice-like tone: harmonic series shaped by two formant bumps, optional vibrato
 * (depth in cents, rate in Hz), optional missing fundamental, optional noise.
 */
export function voice(
  hz: number,
  sr: number,
  n: number,
  opts: {
    amp?: number;
    vibratoCents?: number;
    vibratoHz?: number;
    dropFundamental?: boolean;
    noise?: number;
    seed?: number;
    formants?: [number, number];
  } = {},
): Float32Array {
  const amp = opts.amp ?? 0.3;
  const vibC = opts.vibratoCents ?? 0;
  const vibHz = opts.vibratoHz ?? 5.5;
  const [f1, f2] = opts.formants ?? [700, 1200];
  const rand = mulberry32(opts.seed ?? 1);
  const out = new Float32Array(n);
  const harmonics: { k: number; a: number }[] = [];
  for (let k = 1; k * hz < Math.min(sr / 2 - 200, 6000); k++) {
    if (k === 1 && opts.dropFundamental) continue;
    const f = k * hz;
    const env =
      1 / k +
      0.8 * Math.exp(-(((f - f1) / 180) ** 2)) +
      0.5 * Math.exp(-(((f - f2) / 220) ** 2));
    harmonics.push({ k, a: env });
  }
  const norm = harmonics.reduce((s, h) => s + h.a, 0);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f0 = hz * Math.pow(2, (vibC * Math.sin(2 * Math.PI * vibHz * t)) / 1200);
    phase += (2 * Math.PI * f0) / sr;
    let s = 0;
    for (const h of harmonics) s += h.a * Math.sin(h.k * phase);
    out[i] = (amp * s) / norm + (opts.noise ?? 0) * (rand() * 2 - 1);
  }
  return out;
}

export function noise(sr: number, n: number, amp = 0.3, seed = 7): Float32Array {
  void sr;
  const rand = mulberry32(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (rand() * 2 - 1);
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
