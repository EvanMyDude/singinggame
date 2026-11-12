"""
Synthetic song for the pipeline tests: a "vocal" with known notes, an unrelated backing
track and their mix, with known file offsets. Nothing here is real music; it exercises the
alignment and note logic, not extraction quality on a recording.
"""
from __future__ import annotations

import numpy as np

SR = 22050

#: (start s, duration s, MIDI, vibrato depth in semitones) on the master timeline.
NOTES = [
    (1.00, 0.50, 60, 0.0),
    (1.50, 0.50, 62, 0.0),
    (2.00, 1.20, 64, 0.5),
    (3.60, 0.30, 62, 0.0),
    (3.90, 0.30, 60, 0.0),
    (4.60, 1.00, 67, 0.3),
    (6.00, 0.25, 65, 0.0),
    (6.25, 0.25, 64, 0.0),
    (6.50, 0.80, 62, 0.0),
    (8.00, 1.50, 60, 0.6),
]
DURATION = 11.0


def vocal(notes=NOTES, duration: float = DURATION, breaths: bool = True, seed: int = 7) -> np.ndarray:
    n = int(duration * SR)
    y = np.zeros(n)
    rng = np.random.default_rng(seed)
    for start, dur, midi, vib in notes:
        a, b = int(start * SR), int((start + dur) * SR)
        t = np.arange(b - a) / SR
        m = midi + vib * np.sin(2 * np.pi * 5.8 * t)
        phase = 2 * np.pi * np.cumsum(440.0 * 2 ** ((m - 69) / 12)) / SR
        tone = sum(np.sin(h * phase) / h for h in range(1, 7))
        env = np.minimum(1.0, np.minimum(t, dur - t) / 0.015)
        y[a:b] += 0.25 * tone * env
    if breaths:
        # Unpitched noise in the gaps, well above silence, as a breath or consonant would be.
        for start in np.concatenate([np.array([0.6, 4.3, 7.4]) + k for k in np.arange(0, duration - 1, DURATION)]):
            a, b = int(start * SR), int((start + 0.25) * SR)
            y[a:b] += 0.02 * rng.standard_normal(b - a)
    return y.astype(np.float32)


def backing(duration: float = DURATION, bpm: float = 120.0, seed: int = 3) -> np.ndarray:
    """Tones, noise and a fresh noise burst per beat, so no two stretches correlate."""
    n = int(duration * SR)
    t = np.arange(n) / SR
    rng = np.random.default_rng(seed)
    # Mostly noise: steady tones alone correlate with themselves at any lag.
    y = 0.03 * np.sin(2 * np.pi * 98.0 * t) + 0.02 * np.sin(2 * np.pi * 311.1 * t)
    y += 0.1 * rng.standard_normal(n)
    m = int(0.03 * SR)
    decay = np.exp(-np.arange(m) / (0.004 * SR))
    for beat in np.arange(0.5, duration - 0.1, 60.0 / bpm):
        a = int(beat * SR)
        y[a : a + m] += (0.5 * decay * rng.standard_normal(m))[: n - a]
    return y.astype(np.float32)


def repeated(repeats: int) -> tuple[list, float]:
    """The note pattern played `repeats` times, and the resulting duration."""
    notes = [(s + k * DURATION, d, m, v) for k in range(repeats) for s, d, m, v in NOTES]
    return notes, DURATION * repeats


def delayed(y: np.ndarray, seconds: float) -> np.ndarray:
    return np.concatenate([np.zeros(int(round(seconds * SR)), dtype=y.dtype), y])


def write_song(folder: str, inst_delay: float = 0.040, vocal_delay: float = 0.015, with_mix: bool = True, names: dict | None = None, repeats: int = 1) -> dict:
    """Write WAV files for the synthetic song; returns the file names used."""
    import os

    import soundfile as sf

    names = names or {"instrumental": "Demo Instrumental.wav", "vocal": "Demo (Vocals Only).wav", "mix": "Demo Full.wav"}
    notes, duration = repeated(repeats)
    v, b = vocal(notes, duration), backing(duration)
    os.makedirs(folder, exist_ok=True)
    sf.write(os.path.join(folder, names["instrumental"]), delayed(b, inst_delay), SR)
    sf.write(os.path.join(folder, names["vocal"]), delayed(v, vocal_delay), SR)
    if with_mix:
        sf.write(os.path.join(folder, names["mix"]), v + b, SR)
    return names
