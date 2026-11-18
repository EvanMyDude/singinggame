#!/usr/bin/env python3
"""
Writes the fixtures that check the browser port of the song analysis (src/analysis/) against
the Python reference (tools/prepare_song.py, tools/vocal_targets.py, librosa.pyin):

  tests/fixtures/analysis-contours.json   contours in, notes and stats out (numpy only)
  tests/fixtures/analysis-vocal.wav       a synthetic isolated vocal, 16-bit, 22,050 Hz
  tests/fixtures/analysis-vocal.json      what the reference makes of that WAV: pYIN f0,
                                          voicing, the level gate, notes, phrases

    .venv/bin/python tests/make_analysis_fixtures.py      (needs make song-tools)

Rerun it after changing the reference tools, and commit the outputs with the change. The
inputs are synthetic; they check that the port computes what the reference computes, not
how well either works on a recording.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
sys.path.insert(0, HERE)

import vocal_targets as vt  # noqa: E402

FIX = os.path.join(HERE, "fixtures")
SR = 22050
HOP = 256
HOP_S = HOP / SR


def contour(parts):
    midi: list[float] = []
    for seconds, pitch in parts:
        n = int(round(seconds / HOP_S))
        t = np.arange(n) * HOP_S
        if pitch is None:
            midi += [np.nan] * n
        elif callable(pitch):
            midi += list(pitch(t))
        elif isinstance(pitch, tuple):
            midi += list(np.linspace(pitch[0], pitch[1], n))
        else:
            midi += [float(pitch)] * n
    m = np.array(midi)
    return m, np.isfinite(m)


def realistic(seed: int, seconds: float) -> tuple[np.ndarray, np.ndarray]:
    """A long contour with what a tracked vocal has: vibrato, scoops, jitter, dropouts,
    octave blips, glides, breaths and the odd harmonic lock."""
    rng = np.random.default_rng(seed)
    n = int(seconds / HOP_S)
    midi = np.full(n, np.nan)
    i = int(0.3 / HOP_S)
    pitch = 62.0
    while i < n:
        dur = int(rng.uniform(0.08, 1.4) / HOP_S)
        j = min(n, i + dur)
        t = np.arange(j - i) * HOP_S
        kind = rng.random()
        if kind < 0.12:
            seg = np.linspace(pitch, pitch + rng.choice([-5, -3, 3, 5]), j - i)  # glide
        else:
            seg = pitch + rng.uniform(0, 0.6) * np.sin(2 * np.pi * rng.uniform(4.5, 6.5) * t)
            if rng.random() < 0.3:  # scoop into the note
                k = min(len(seg), int(rng.uniform(0.03, 0.2) / HOP_S))
                seg[:k] += np.linspace(-rng.uniform(0.5, 2.5), 0, k)
        seg = seg + rng.normal(0, 0.06, len(seg))
        if rng.random() < 0.15 and len(seg) > 12:  # octave blip
            a = int(rng.integers(0, len(seg) - 6))
            seg[a : a + int(rng.integers(2, 10))] += rng.choice([-12, 12])
        if rng.random() < 0.2 and len(seg) > 8:  # dropout
            a = int(rng.integers(1, len(seg) - 4))
            seg[a : a + int(rng.integers(1, 5))] = np.nan
        midi[i:j] = seg
        if rng.random() < 0.05:  # a short stray note far from the melody
            midi[j : j + 6] = pitch + 19
            j += 6
        i = j + int(rng.choice([0, 0, 0, rng.uniform(0.02, 0.8)]) / HOP_S)
        pitch = float(np.clip(pitch + rng.choice([-4, -2, -1, 0, 1, 2, 3, 5]), 50, 74))
    voiced = np.isfinite(midi) & (rng.random(n) > 0.01)
    return midi, voiced


def note_doc(n: vt.Note) -> dict:
    return {"start": n.start, "end": n.end, "midi": n.midi, "median": n.median, "madCents": n.mad_cents}


def bits(mask: np.ndarray) -> str:
    return "".join("1" if v else "0" for v in mask)


def stats_doc(s: dict) -> dict:
    return {k: v for k, v in s.items() if k not in ("inNote", "voiced")} | {"inNote": bits(s["inNote"]), "voiced": bits(s["voiced"])}


def nan_list(x: np.ndarray) -> list:
    return [None if not np.isfinite(v) else float(v) for v in x]


def contour_cases() -> dict:
    wide = lambda t: 64 + 0.9 * np.sin(2 * np.pi * 6.0 * t)  # noqa: E731
    cases = {
        "steady notes and silence": [(0.5, None), (0.5, 60.0), (0.4, 62.0), (0.3, None), (0.6, 64.0)],
        "vibrato": [(0.2, None), (2.0, wide), (0.2, None)],
        "long scoop": [(0.2, None), (0.3, (57.0, 60.0)), (0.8, 60.0), (0.2, None)],
        "slow bend": [(0.2, None), (1.2, (60.0, 61.5)), (0.2, None)],
        "slide between notes": [(0.2, None), (0.5, 60.0), (0.25, (60.0, 65.0)), (0.5, 65.0), (0.2, None)],
        "octave blip": [(0.2, None), (0.4, 60.0), (0.06, 72.0), (0.4, 60.0), (0.2, None)],
        "sustained octave leap": [(0.2, None), (0.6, 60.0), (0.6, 72.0), (0.2, None)],
        "fast run": [(0.2, None)] + [(0.12, float(m)) for m in (60, 62, 64, 65, 67, 69, 71, 72)] + [(0.2, None)],
        "stray note": [(0.3, None), (1.5, 60.0), (0.2, None), (0.15, 80.0), (0.2, None), (1.5, 62.0), (0.3, None)],
        "empty": [(0.5, None)],
    }
    out = []
    for name, parts in cases.items():
        m, v = contour(parts)
        m = np.round(m, 5)  # what the fixture stores is exactly what the reference saw
        notes, stats = vt.notes_from_contour(m, v, vt.Params(hop_s=HOP_S))
        out.append({"name": name, "midi": nan_list(m), "voiced": bits(v), "notes": [note_doc(n) for n in notes], "stats": stats_doc(stats)})
    for seed in (1, 2, 3):
        m, v = realistic(seed, 25.0)
        m = np.round(m, 5)
        notes, stats = vt.notes_from_contour(m, v, vt.Params(hop_s=HOP_S))
        out.append({"name": f"realistic {seed}", "midi": nan_list(m), "voiced": bits(v), "notes": [note_doc(n) for n in notes], "stats": stats_doc(stats)})
    return {"hop": HOP_S, "cases": out}


def vocal_fixture() -> tuple[np.ndarray, dict]:
    import librosa
    import soundfile as sf

    import extract_melody as xm
    import prepare_song as ps
    import synth_song

    notes = [
        (0.30, 0.50, 60, 0.0),
        (0.80, 0.40, 62, 0.0),
        (1.20, 1.00, 64, 0.5),
        (2.50, 0.35, 41, 0.0),  # low, near fmin
        (3.00, 0.45, 83, 0.2),  # high, near fmax
        (3.60, 0.25, 67, 0.0),
        (3.85, 0.25, 65, 0.0),
    ]
    y = synth_song.vocal(notes, 4.6, breaths=False).astype(np.float64)
    rng = np.random.default_rng(11)
    for start in (0.12, 2.27, 3.42):  # breaths: unpitched noise well above silence
        a = int(start * SR)
        y[a : a + int(0.12 * SR)] += 0.02 * rng.standard_normal(int(0.12 * SR))
    # A glide and some noise on top, so voicing decisions and the gate have work to do.
    a, b = int(2.25 * SR), int(2.45 * SR)
    m = np.linspace(55, 59, b - a)
    phase = 2 * np.pi * np.cumsum(440.0 * 2 ** ((m - 69) / 12)) / SR
    y[a:b] += 0.2 * np.sin(phase) * np.hanning(b - a)
    y += 0.002 * np.random.default_rng(5).standard_normal(len(y))
    y[int(4.3 * SR) :] *= 0.0
    wav = os.path.join(FIX, "analysis-vocal.wav")
    sf.write(wav, np.clip(y, -1, 1).astype(np.float32), SR, subtype="PCM_16")

    vocal = xm.load_mono(wav)  # exactly what prepare_song decodes
    f0, flag, prob = librosa.pyin(vocal, fmin=xm.FMIN, fmax=xm.FMAX, sr=SR, frame_length=xm.N_FFT, hop_length=HOP, fill_na=np.nan)
    rms = librosa.feature.rms(y=vocal, frame_length=ps.LEVEL_FRAME, hop_length=HOP, center=True)[0]
    midi, sung, present = ps.track_vocal(vocal, 35.0)
    tnotes, stats = vt.notes_from_contour(midi, sung, vt.Params(hop_s=HOP_S))
    phrases = xm.phrases_from(stats["voiced"], np.arange(len(midi)) * HOP_S, HOP_S)
    doc = {
        "librosa": librosa.__version__,
        "numpy": np.__version__,
        "sr": SR,
        "hop": HOP,
        "frameLength": xm.N_FFT,
        "fmin": xm.FMIN,
        "fmax": xm.FMAX,
        "samples": len(vocal),
        "f0": nan_list(f0),
        "voiced": bits(flag),
        "voicedProb": [float(v) for v in prob],
        "rms": [float(v) for v in rms],
        "present": bits(present),
        "sung": bits(sung),
        "notes": [note_doc(n) for n in tnotes],
        "phrases": [[a, b] for a, b in phrases],
    }
    return vocal, doc


def main() -> int:
    os.makedirs(FIX, exist_ok=True)
    with open(os.path.join(FIX, "analysis-contours.json"), "w", encoding="utf-8") as fh:
        json.dump(contour_cases(), fh, separators=(",", ":"))
    _, doc = vocal_fixture()
    with open(os.path.join(FIX, "analysis-vocal.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print("wrote tests/fixtures/analysis-contours.json, analysis-vocal.wav, analysis-vocal.json", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
