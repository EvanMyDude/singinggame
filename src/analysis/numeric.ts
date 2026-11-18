/**
 * Small numeric helpers with numpy's semantics, so the analysis ported from tools/*.py makes
 * the same decisions as the Python reference (tests/fixtures/analysis-*.json check this).
 */

/** Python's round(): halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Median of finite values (numpy.median on a slice without NaN). NaN for an empty input. */
export function median(values: ArrayLike<number>, from = 0, to = values.length): number {
  const n = to - from;
  if (n <= 0) return NaN;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = values[from + i]!;
  a.sort();
  const h = n >> 1;
  return n % 2 ? a[h]! : (a[h - 1]! + a[h]!) / 2;
}

/** numpy.nanmedian: NaN values are ignored; all-NaN gives NaN. */
export function nanMedian(values: ArrayLike<number>, from = 0, to = values.length): number {
  const a: number[] = [];
  for (let i = from; i < to; i++) {
    const v = values[i]!;
    if (!Number.isNaN(v)) a.push(v);
  }
  return median(a);
}

/** numpy.percentile with the default linear interpolation. */
export function percentile(values: ArrayLike<number>, q: number): number {
  const n = values.length;
  if (!n) return NaN;
  const a = Float64Array.from(values as ArrayLike<number>).sort();
  const pos = ((n - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const frac = pos - lo;
  return a[lo]! + (a[hi]! - a[lo]!) * frac;
}

/** Slope of the least-squares line through (k, y[k]) for k = 0..n-1 (numpy.polyfit degree 1). */
export function lineSlope(y: ArrayLike<number>, from: number, to: number): number {
  const n = to - from;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  let ym = 0;
  for (let i = from; i < to; i++) ym += y[i]!;
  ym /= n;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < n; k++) {
    const dx = k - xm;
    sxy += dx * (y[from + k]! - ym);
    sxx += dx * dx;
  }
  return sxy / sxx;
}

/** Index of the first element >= value in an ascending array (numpy.searchsorted, side left). */
export function searchSorted(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Python's round(x, digits) for digits >= 1: rounds the exact binary value of x, so 30.05
 * (stored as 30.0500000000000007...) goes up. toFixed rounds the exact value too, except on
 * an exact tie, which it breaks upward where Python goes to even.
 */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const scale = 10 ** digits;
  const k = Math.floor(x * scale);
  // An exact tie is (2k + 1) / (2 * 10^d); it is a double only when 5^d divides 2k + 1.
  // (The product x * 10^d alone cannot tell: 2.675 * 100 rounds to exactly 267.5.)
  const odd = 2 * k + 1;
  if (Number.isSafeInteger(odd) && odd % 5 ** digits === 0 && odd / (2 * scale) === x) return (k % 2 === 0 ? k : k + 1) / scale;
  const r = Number(x.toFixed(digits));
  return r === 0 ? 0 : r;
}

/** Python's round(x, 2) for the seconds this module reports. */
export function round2(x: number): number {
  return pyRound(x, 2);
}
