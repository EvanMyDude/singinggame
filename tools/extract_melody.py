#!/usr/bin/env python3
"""
Derive Pitch Hero's target vocal pitch track from a karaoke instrumental and the matching
full mix (same backing track, with the vocal).

    python3 tools/extract_melody.py "Old Town Road - Karaoke.mp3" "Old Town Road with Vocals.mp3" \
        -o public/songs/old-town-road/melody.json [--plot melody.png]

How it works
  1. Both files are decoded to mono at 22.05 kHz.
  2. The constant time offset between them is measured by cross-correlation (coarse, then
     verified per 8 s window so a speed mismatch would be caught instead of silently
     smearing the result). The instrumental's timeline is the song timeline; the offset
     is written out so the app can keep the reference track aligned when toggling.
  3. Spectral subtraction: a per-band gain of the instrumental inside the full mix is
     estimated robustly (median ratio over frames), then |V|^2 = |F|^2 - a*g^2*|I|^2 leaves a
     vocal-dominated residual, resynthesized with the full mix's phase. Time-domain
     subtraction does not work here because the two masters differ in compression/EQ.
  4. pYIN (probabilistic YIN with Viterbi smoothing) tracks the residual's fundamental.
     Frames are kept only when pYIN is confident AND the residual carries real energy
     relative to the mix, so backing leakage in vocal-free passages is not tracked.
  5. The frame track is segmented into notes (stable pitch for at least 100 ms); unstable
     or glissando-like stretches are not scored, since a target that is not a note would
     only produce noise in the score.

Dependencies: numpy, scipy, librosa (>= 0.10), soundfile (libsndfile with MP3 support).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass

import numpy as np

SR = 22050
N_FFT = 2048
HOP = 256
FMIN = 65.0  # C2
FMAX = 1100.0  # ~C#6


def log(*a: object) -> None:
    print(*a, file=sys.stderr)


def load_mono(path: str) -> np.ndarray:
    import soundfile as sf
    import librosa

    y, sr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR, res_type="soxr_hq")
    return y.astype(np.float32)


def xcorr_lag(x: np.ndarray, y: np.ndarray, max_lag: int) -> tuple[int, float]:
    """Lag l maximizing |sum x[n] y[n+l]| over |l| <= max_lag, and the normalized peak."""
    n = len(x)
    N = 1 << int(np.ceil(np.log2(n + len(y))))
    cc = np.fft.irfft(np.fft.rfft(y, N) * np.conj(np.fft.rfft(x, N)), N)
    lags = np.concatenate([np.arange(0, max_lag + 1), np.arange(-max_lag, 0)])
    vals = np.concatenate([cc[: max_lag + 1], cc[N - max_lag :]])
    k = int(np.argmax(np.abs(vals)))
    norm = vals[k] / (np.sqrt((x**2).sum() * (y**2).sum()) + 1e-12)
    return int(lags[k]), float(norm)


def measure_offset(inst: np.ndarray, full: np.ndarray) -> tuple[int, dict]:
    """Samples by which `full` leads `inst` (negative lag: the same event is earlier in full)."""
    n = min(len(inst), len(full))
    # Coarse: the middle 60 s, where both carry energy.
    mid = n // 2
    seg = min(60 * SR, n // 2)
    a = inst[mid - seg // 2 : mid + seg // 2]
    b = full[mid - seg // 2 : mid + seg // 2]
    lag, peak = xcorr_lag(a - a.mean(), b - b.mean(), 3 * SR)
    # Verify per window: a constant lag means identical speed; a trend means a stretch.
    W = 8 * SR
    rows = []
    for s in range(0, n - W - 3 * SR, W):
        x = inst[s : s + W]
        lo = max(0, s + lag - SR)
        hi = min(len(full), s + W + lag + SR)
        y = full[lo:hi]
        if len(y) < W:
            continue
        N = 1 << int(np.ceil(np.log2(len(y) + len(x))))
        cc = np.fft.irfft(np.fft.rfft(y - y.mean(), N) * np.conj(np.fft.rfft(x - x.mean(), N)), N)[: len(y) - len(x) + 1]
        k = int(np.argmax(np.abs(cc)))
        c = cc[k] / (np.sqrt((x**2).sum() * (y[k : k + len(x)] ** 2).sum()) + 1e-12)
        rows.append((s / SR, (lo + k) - s, c))
    good = [(t, l) for t, l, c in rows if abs(c) > 0.3]
    if len(good) >= 4:
        t = np.array([g[0] for g in good])
        l = np.array([g[1] for g in good], dtype=float)
        slope, icpt = np.polyfit(t, l, 1)
        med = float(np.median(l))
        mad = float(np.median(np.abs(l - med)))
        info = {"coarseLag": lag, "coarsePeak": peak, "windows": len(good), "medianLag": med, "madSamples": mad, "slopePpm": slope / SR * 1e6}
        if abs(slope / SR) > 2e-4:
            log(f"WARNING: the two files appear to run at different speeds ({slope / SR * 1e6:.0f} ppm); a single offset will not align them.")
        if mad > 0.01 * SR:
            log(f"WARNING: per-window offsets disagree (MAD {mad / SR * 1000:.1f} ms); check that both files are the same recording.")
        return int(round(med)), info
    log("WARNING: could not verify the offset per window; using the coarse estimate.")
    return lag, {"coarseLag": lag, "coarsePeak": peak, "windows": len(good)}


def align(inst: np.ndarray, full: np.ndarray, lag: int) -> tuple[np.ndarray, np.ndarray]:
    """Return (inst, full) on the instrumental's timeline: full[n + lag] <-> inst[n]."""
    if lag >= 0:
        full_al = full[lag:]
    else:
        full_al = np.concatenate([np.zeros(-lag, dtype=full.dtype), full])
    n = min(len(inst), len(full_al))
    return inst[:n], full_al[:n]


def spectral_subtract(inst: np.ndarray, full: np.ndarray, alpha: float = 1.6, floor: float = 0.02) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Vocal-dominated residual magnitude spectrogram.

    The two masters are only phase-coherent in the low band (bass and kick are the same
    samples; everything above ~250 Hz was rendered or processed differently), so the
    subtraction is hybrid: a complex least-squares fit of the instrumental into the full mix
    per bin over 4 s windows removes the coherent part (this also absorbs polarity
    inversion and level), and a magnitude subtraction with a robust per-band gain removes
    the rest. Harmonic/percussive separation then drops the percussive verticals that
    survive because transients never line up exactly. Returns (H, magF, coherence, F).
    """
    import librosa
    from scipy.ndimage import maximum_filter1d, uniform_filter1d

    F = librosa.stft(full, n_fft=N_FFT, hop_length=HOP)
    I = librosa.stft(inst, n_fft=N_FFT, hop_length=HOP)
    magF = np.abs(F)
    magI = np.abs(I)
    eps = 1e-9
    W = int(round(4.0 / (HOP / SR)))
    cross = F * np.conj(I)
    num = uniform_filter1d(cross.real, size=W, axis=1, mode="nearest") + 1j * uniform_filter1d(cross.imag, size=W, axis=1, mode="nearest")
    den = uniform_filter1d(magI**2, size=W, axis=1, mode="nearest") + eps
    powF = uniform_filter1d(magF**2, size=W, axis=1, mode="nearest") + eps
    w = num / den
    coh = np.abs(num) / np.sqrt(den * powF)
    R = F - (coh**2) * w * I
    magR = np.abs(R)
    # Robust per-band gain for the incoherent remainder: median |F|/|I| over frames where the
    # instrumental has energy in that band (vocal frames raise the ratio but are a minority).
    thresh = np.percentile(magI, 60, axis=1, keepdims=True)
    ratio = np.where(magI > thresh, magF / (magI + 1e-6), np.nan)
    with np.errstate(all="ignore"):
        g = np.nanmedian(ratio, axis=1)
    g = np.clip(np.nan_to_num(g, nan=1.0), 0.2, 4.0)
    g = np.convolve(np.pad(g, 4, mode="edge"), np.ones(9) / 9, mode="valid")
    est = (1 - coh**2) * g[:, None] * maximum_filter1d(magI, size=3, axis=1)
    powV = np.maximum(magR**2 - alpha * est**2, floor * magF**2)
    H, _ = librosa.decompose.hpss(np.sqrt(powV), kernel_size=(17, 31), margin=(1.5, 1.5))
    return H.astype(np.float32), magF, coh, F


def salience_track(H: np.ndarray, freqs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Harmonic-summation salience over 20-cent f0 candidates with a soft vocal-range prior,
    decoded by Viterbi so the track prefers continuity. Returns (f0 Hz, harmonicity),
    where harmonicity is the fraction of 100-2500 Hz residual energy explained by the first
    six harmonics of the tracked f0 (a per-frame confidence).
    """
    fmin, fmax, step = FMIN, FMAX, 20
    nb = int(np.round(1200 * np.log2(fmax / fmin) / step)) + 1
    cand = fmin * 2 ** (np.arange(nb) * step / 1200)
    nh = 8
    wh = 0.85 ** np.arange(nh)
    comp = H**0.6
    T = H.shape[1]
    sal = np.zeros((nb, T), dtype=np.float32)
    for h in range(1, nh + 1):
        fh = cand * h
        ok = fh < freqs[-1]
        idx = np.interp(fh[ok], freqs, np.arange(len(freqs)))
        lo = np.floor(idx).astype(int)
        fr = (idx - lo)[:, None]
        sal[ok] += wh[h - 1] * (comp[lo] * (1 - fr) + comp[np.minimum(lo + 1, len(freqs) - 1)] * fr)
    prior = np.exp(-0.5 * ((np.log2(cand / 230)) / 1.1) ** 2)
    obs = sal * prior[:, None]
    obsn = obs / (obs.max(axis=0) + 1e-9)
    d = np.arange(nb)
    trans = np.exp(-0.5 * ((d[:, None] - d[None, :]) / 2.0) ** 2)
    trans /= trans.sum(axis=1, keepdims=True)
    logtrans = np.log(trans + 1e-12)
    logobs = np.log(obsn + 1e-6)
    delta = logobs[:, 0].copy()
    psi = np.zeros((nb, T), dtype=np.int32)
    for k in range(1, T):
        m = delta[:, None] + logtrans
        psi[:, k] = np.argmax(m, axis=0)
        delta = m[psi[:, k], d] + logobs[:, k]
    path = np.zeros(T, dtype=int)
    path[-1] = int(np.argmax(delta))
    for k in range(T - 1, 0, -1):
        path[k - 1] = psi[path[k], k]
    f0 = cand[path].copy()
    for k in range(T):
        b = path[k]
        if 0 < b < nb - 1:
            y0, y1, y2 = obs[b - 1, k], obs[b, k], obs[b + 1, k]
            den = y0 - 2 * y1 + y2
            if den < 0:
                f0[k] = fmin * 2 ** ((b + 0.5 * (y0 - y2) / den) * step / 1200)
    band = (freqs >= 100) & (freqs <= 2500)
    tot = (H[band] ** 2).sum(axis=0) + 1e-9
    harm = np.zeros_like(tot)
    df = freqs[1] - freqs[0]
    for h in range(1, 7):
        idx = np.round(np.nan_to_num(f0) * h / df).astype(int)
        for off in (-1, 0, 1):
            j = np.clip(idx + off, 0, len(freqs) - 1)
            harm += H[j, np.arange(T)] ** 2
    return f0, harm / tot


def frame_db(x: np.ndarray) -> np.ndarray:
    import librosa

    rms = librosa.feature.rms(y=x, frame_length=N_FFT, hop_length=HOP, center=True)[0]
    return 20 * np.log10(np.maximum(rms, 1e-7))


@dataclass
class NoteSeg:
    start: float
    end: float
    midi: int
    median: float
    mad_cents: float
    frames: int


def segment_notes(times: np.ndarray, midi: np.ndarray, voiced: np.ndarray, hop_s: float) -> list[NoteSeg]:
    """Split the frame-wise track into stable-pitch segments."""
    segs: list[NoteSeg] = []
    n = len(midi)
    i = 0
    MIN_FRAMES = max(3, int(round(0.1 / hop_s)))
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        j = i
        vals: list[float] = []
        while j < n and voiced[j]:
            if vals:
                med = float(np.median(vals[-12:]))
                if abs(midi[j] - med) > 0.65 and len(vals) >= 3:
                    break
            vals.append(float(midi[j]))
            j += 1
        if len(vals) >= MIN_FRAMES:
            arr = np.array(vals)
            med = float(np.median(arr))
            mad = float(np.median(np.abs(arr - med))) * 100
            segs.append(NoteSeg(start=float(times[i]), end=float(times[j - 1] + hop_s), midi=int(round(med)), median=med, mad_cents=mad, frames=len(vals)))
        i = j if j > i else i + 1
    # Merge adjacent same-pitch segments separated by tiny gaps (pYIN flicker).
    merged: list[NoteSeg] = []
    for s in segs:
        if merged and merged[-1].midi == s.midi and s.start - merged[-1].end < 0.06:
            p = merged[-1]
            tot = p.frames + s.frames
            merged[-1] = NoteSeg(p.start, s.end, p.midi, (p.median * p.frames + s.median * s.frames) / tot, max(p.mad_cents, s.mad_cents), tot)
        else:
            merged.append(s)
    return merged


def phrases_from(voiced: np.ndarray, times: np.ndarray, hop_s: float, gap: float = 0.4, min_len: float = 0.3) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    start = None
    last = None
    for t, v in zip(times, voiced):
        if v:
            if start is None:
                start = t
            elif last is not None and t - last > gap:
                if last + hop_s - start >= min_len:
                    out.append((float(start), float(last + hop_s)))
                start = t
            last = t
    if start is not None and last is not None and last + hop_s - start >= min_len:
        out.append((float(start), float(last + hop_s)))
    return out


KEY_PROFILES = {
    "major": np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]),
    "minor": np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]),
}
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def estimate_key(y: np.ndarray) -> tuple[int, str, float]:
    import librosa

    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=2048).mean(axis=1)
    best = (0, "major", -2.0)
    for mode, prof in KEY_PROFILES.items():
        for tonic in range(12):
            r = np.corrcoef(np.roll(prof, tonic), chroma)[0, 1]
            if r > best[2]:
                best = (tonic, mode, float(r))
    return best


def estimate_tempo(y: np.ndarray) -> tuple[float, float]:
    """Tempo (BPM) and the time of the first tracked beat, from the instrumental."""
    import librosa

    tempo, beats = librosa.beat.beat_track(y=y, sr=SR, hop_length=512, units="time")
    bpm = float(np.atleast_1d(tempo)[0])
    first = float(beats[0]) if len(beats) else 0.0
    # Pop/trap tempos are usually quoted between 70 and 140 BPM.
    while bpm > 150:
        bpm /= 2
    while bpm < 70:
        bpm *= 2
    return bpm, first


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("instrumental")
    ap.add_argument("full")
    ap.add_argument("-o", "--out", required=True, help="melody.json path")
    ap.add_argument("--plot", help="write a diagnostic PNG (needs matplotlib)")
    ap.add_argument("--alpha", type=float, default=1.4, help="over-subtraction factor")
    ap.add_argument("--residual-wav", help="also write the vocal residual (for listening checks)")
    args = ap.parse_args()

    import librosa

    log("decoding…")
    inst = load_mono(args.instrumental)
    full = load_mono(args.full)
    log(f"instrumental {len(inst) / SR:.2f} s, full {len(full) / SR:.2f} s")

    lag, info = measure_offset(inst, full)
    log(f"offset: full leads instrumental by {-lag / SR * 1000:.1f} ms ({info})")
    inst_a, full_a = align(inst, full, lag)

    log("spectral subtraction…")
    H, magF, coh, F = spectral_subtract(inst_a, full_a, alpha=args.alpha)
    freqs = librosa.fft_frequencies(sr=SR, n_fft=N_FFT)
    T = H.shape[1]
    hop_s = HOP / SR
    times = librosa.frames_to_time(np.arange(T), sr=SR, hop_length=HOP)
    resid = librosa.istft(H * np.exp(1j * np.angle(F)), hop_length=HOP, length=len(full_a)).astype(np.float32)
    if args.residual_wav:
        import soundfile as sf

        sf.write(args.residual_wav, resid / max(1e-6, np.abs(resid).max()) * 0.9, SR)

    log("pitch tracking (salience + pYIN)…")
    f0s, harmonicity = salience_track(H, freqs)
    f0p, vflag, _ = librosa.pyin(resid, fmin=FMIN, fmax=FMAX, sr=SR, frame_length=N_FFT, hop_length=HOP, fill_na=np.nan)
    n = min(T, len(f0p))
    f0s, harmonicity, f0p, vflag, times = f0s[:n], harmonicity[:n], f0p[:n], vflag[:n], times[:n]
    # Vocal presence: residual energy in the vocal band relative to the mix, and the tracked
    # pitch must explain the residual (harmonicity). This is pitch-tracker independent and is
    # what the phrase list (used for lyric sync) is built from.
    band = (freqs >= 150) & (freqs <= 4000)
    eV = 20 * np.log10(np.sqrt((H[band, :n] ** 2).sum(axis=0)) + 1e-7)
    eF = 20 * np.log10(np.sqrt((magF[band, :n] ** 2).sum(axis=0)) + 1e-7)
    present = ((eV - eF) > -8) & (harmonicity > 0.45)
    midi_s = 69 + 12 * np.log2(f0s / 440)
    midi_p = np.where(np.isfinite(f0p), 69 + 12 * np.log2(np.where(np.isfinite(f0p), f0p, 440) / 440), np.nan)
    # Two independent trackers must agree (within 60 cents, no octave forgiveness) for a frame
    # to become part of a scored note; disagreement means the target is not trustworthy there.
    agree = vflag & np.isfinite(midi_p) & (np.abs(midi_p - midi_s) < 0.6)
    voiced = present & agree
    midi = np.where(agree, (midi_s + midi_p) / 2, midi_s)
    from scipy.ndimage import median_filter

    midi_m = median_filter(midi, size=5, mode="nearest")

    segs = segment_notes(times, midi_m, voiced, hop_s)
    stable = [s for s in segs if s.mad_cents <= 35 and s.end - s.start >= 0.1]
    unstable = [s for s in segs if s not in stable]
    phr = phrases_from(present, times, hop_s)

    tonic, mode, r = estimate_key(inst_a)
    bpm, first_beat = estimate_tempo(inst_a)
    log(f"tempo estimate: {bpm:.1f} BPM, first beat at {first_beat:.3f} s")
    scale = {0, 2, 4, 5, 7, 9, 11} if mode == "major" else {0, 2, 3, 5, 7, 8, 10}
    in_scale = sum(1 for s in stable if (s.midi - tonic) % 12 in scale)
    dev = np.array([(s.median - s.midi) * 100 for s in stable]) if stable else np.array([0.0])
    hist = np.zeros(12)
    for s in stable:
        hist[s.midi % 12] += s.end - s.start

    log(f"vocal present: {present.mean() * 100:.1f}% of frames ({present.sum() * hop_s:.1f} s); trackers agree on {voiced.mean() * 100:.1f}% ({voiced.sum() * hop_s:.1f} s)")
    log(f"notes: {len(stable)} stable (+{len(unstable)} unstable dropped), phrases: {len(phr)}")
    if stable:
        ms = [s.midi for s in stable]
        log(f"range: {librosa.midi_to_note(min(ms))}–{librosa.midi_to_note(max(ms))}; median note length {np.median([s.end - s.start for s in stable]):.2f} s")
        log(f"tuning: mean deviation from equal temperament {dev.mean():+.1f} cents (sd {dev.std():.1f})")
    log(f"key estimate (instrumental chroma): {NAMES[tonic]} {mode} (r={r:.2f}); {in_scale}/{len(stable)} notes in scale")
    log("pitch-class time (s): " + ", ".join(f"{NAMES[i]} {hist[i]:.1f}" for i in np.argsort(-hist)[:7]))

    sig = hashlib.sha1()
    for p in (args.instrumental, args.full):
        with open(p, "rb") as fh:
            sig.update(hashlib.sha1(fh.read()).digest())
    out = {
        "version": 1,
        "duration": round(len(inst_a) / SR, 3),
        # Reference (full mix) time = song time + referenceOffset.
        "referenceOffset": round(lag / SR, 4),
        "key": {"tonic": tonic, "mode": mode},
        "bpm": round(bpm, 2),
        "firstBeat": round(first_beat, 3),
        "tuningCents": round(float(dev.mean()), 1),
        "hop": round(hop_s, 6),
        "notes": [{"t": round(s.start, 3), "d": round(s.end - s.start, 3), "m": s.midi, "c": round(s.median - s.midi, 3)} for s in stable],
        "phrases": [{"t": round(a, 3), "e": round(b, 3)} for a, b in phr],
        "sources": sig.hexdigest()[:12],
        "analysis": {"alignment": {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v) for k, v in info.items()}, "presentSeconds": round(float(present.sum() * hop_s), 1), "scoredSeconds": round(float(sum(x.end - x.start for x in stable)), 1), "unstableDropped": len(unstable)},
    }
    with open(args.out, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    log(f"wrote {args.out} ({len(out['notes'])} notes)")

    if args.plot:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(3, 1, figsize=(22, 12), sharex=True, gridspec_kw={"height_ratios": [1, 3, 1]})
        axes[0].plot(times, eF, lw=0.6, label="mix (150-4k)")
        axes[0].plot(times, eV, lw=0.6, label="residual (150-4k)")
        axes[0].legend(loc="upper right")
        axes[0].set_ylabel("dB")
        ax = axes[1]
        D = librosa.amplitude_to_db(H[: N_FFT // 8, :n], ref=np.max)
        ax.imshow(D, origin="lower", aspect="auto", extent=[0, times[-1], 0, SR / 2 / 4], cmap="magma", vmin=-70, vmax=0)
        ax.set_ylabel("Hz (residual)")
        ax.set_ylim(60, 1200)
        ax.plot(times, np.where(present, f0s, np.nan), ".", ms=1.2, color="#a08cff", alpha=0.6)
        ax.plot(times, np.where(voiced, f0p, np.nan), ".", ms=1.5, color="#5ee0ff")
        for s in stable:
            f = 440 * 2 ** ((s.midi - 69) / 12)
            ax.plot([s.start, s.end], [f, f], color="#3dffa2", lw=2)
        for s in unstable:
            f = 440 * 2 ** ((s.midi - 69) / 12)
            ax.plot([s.start, s.end], [f, f], color="#ff4d6d", lw=1.5, alpha=0.6)
        axes[2].plot(times, harmonicity, lw=0.6)
        for a, b in phr:
            axes[2].axvspan(a, b, color="#a08cff", alpha=0.25)
        axes[2].set_ylabel("harmonicity / phrases")
        axes[2].set_xlabel("song time (s)")
        fig.tight_layout()
        fig.savefig(args.plot, dpi=90)
        log(f"wrote {args.plot}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
