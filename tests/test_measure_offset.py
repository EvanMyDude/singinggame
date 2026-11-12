"""
tools/extract_melody.py measure_offset: the per-window check of the offset between the
instrumental and the full mix. Requires only NumPy.

The pairs are synthetic (tests/synth_song.py). They exercise the window and slope logic and
are not evidence about alignment quality on a recording.
"""
from __future__ import annotations

import contextlib
import io
import os
import sys
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import synth_song  # noqa: E402

from tools.extract_melody import measure_offset  # noqa: E402

SR = synth_song.SR
W = 8 * SR


def repeating(duration: float, period: float = 0.5, gain: float = 0.2, seed: int = 11) -> np.ndarray:
    """
    One noise pattern repeated every `period` seconds. synth_song.backing never repeats, so a
    window searched in the wrong place finds nothing there; music does repeat, and that is
    what gives such a window a peak strong enough to be kept.
    """
    p = int(period * SR)
    n = int(duration * SR)
    pattern = np.random.default_rng(seed).standard_normal(p)
    return (gain * np.tile(pattern, n // p + 1)[:n]).astype(np.float32)


def measure(inst: np.ndarray, full: np.ndarray) -> tuple[int, dict, str]:
    """measure_offset's result and what it logged."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        lag, info = measure_offset(inst, full)
    return lag, info, err.getvalue()


class MeasureOffset(unittest.TestCase):
    def test_mix_that_leads_by_seconds_reports_no_drift(self):
        notes, duration = synth_song.repeated(5)
        backing = synth_song.backing(duration)
        full = backing + synth_song.vocal(notes, duration)
        lag, info, logged = measure(synth_song.delayed(backing, 2.384), full)
        self.assertEqual(lag, -int(round(2.384 * SR)))
        self.assertGreaterEqual(info["windows"], 4)
        self.assertLess(abs(info["slopePpm"]), 5)
        self.assertLess(info["madSamples"], 2)
        self.assertNotIn("different speeds", logged)

    def test_clipped_first_window_is_skipped(self):
        # The mix leads by 46 ms, as Old Town Road's does. The first window's true match
        # starts before the mix does, and the repeating pattern offers it a wrong one.
        notes, duration = synth_song.repeated(5)
        backing = synth_song.backing(duration) + repeating(duration)
        full = backing + synth_song.vocal(notes, duration)
        lag, info, logged = measure(synth_song.delayed(backing, 0.046), full)
        self.assertEqual(lag, -int(round(0.046 * SR)))
        # Windows start at 0, 8, ..., 40 s; the one at 0 has a clipped search range.
        self.assertEqual(info["windows"], 5)
        self.assertLess(abs(info["slopePpm"]), 5)
        self.assertLess(info["madSamples"], 2)
        self.assertNotIn("different speeds", logged)

    def test_one_bad_window_does_not_fake_a_drift(self):
        notes, duration = synth_song.repeated(6)
        backing = synth_song.backing(duration)
        full = backing + synth_song.vocal(notes, duration)
        inst = synth_song.delayed(backing, 0.5).copy()
        # Replace one window of the instrumental with a copy of an earlier stretch: it then
        # matches the mix at the wrong place.
        inst[3 * W : 4 * W] = inst[3 * W - 9000 : 4 * W - 9000]
        lag, info, logged = measure(inst, full)
        self.assertEqual(lag, -int(round(0.5 * SR)))
        self.assertGreaterEqual(info["windows"], 4)
        self.assertLess(abs(info["slopePpm"]), 5)
        self.assertNotIn("different speeds", logged)

    def test_a_real_speed_difference_is_still_reported(self):
        n = 80 * SR
        # Noise below 80 Hz stays correlated over a few milliseconds of drift, as bass does.
        spectrum = np.fft.rfft(np.random.default_rng(5).standard_normal(n))
        spectrum[np.fft.rfftfreq(n, 1 / SR) > 80] = 0
        low = np.fft.irfft(spectrum, n).astype(np.float32)
        stretch = 1 + 400e-6  # 400 ppm longer
        slow = np.interp(np.arange(int(n * stretch)) / stretch, np.arange(n), low).astype(np.float32)
        _, info, logged = measure(slow, low)
        self.assertGreaterEqual(info["windows"], 4)
        self.assertAlmostEqual(abs(info["slopePpm"]), 400, delta=60)
        self.assertIn("different speeds", logged)


if __name__ == "__main__":
    unittest.main()
