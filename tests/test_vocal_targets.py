"""
Note logic of tools/vocal_targets.py on hand-built contours (numpy only, no audio).

    python3 -m unittest discover -s tests -p 'test_*.py' -v
"""
from __future__ import annotations

import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))

import vocal_targets as vt  # noqa: E402

HOP = 256 / 22050
P = vt.Params(hop_s=HOP)


def contour(parts: list[tuple[float, object]]) -> tuple[np.ndarray, np.ndarray]:
    """Build (midi, voiced) from (seconds, pitch) parts; pitch None is silence, a float is a
    steady pitch, a (from, to) tuple is a linear glide, a callable maps time (s) to pitch."""
    midi: list[float] = []
    for seconds, pitch in parts:
        n = int(round(seconds / HOP))
        t = np.arange(n) * HOP
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


def run(parts):
    return vt.notes_from_contour(*contour(parts), P)


class NotesFromContour(unittest.TestCase):
    def assertTimes(self, note: vt.Note, start: float, end: float, tol: float = 0.03) -> None:
        self.assertAlmostEqual(note.start, start, delta=tol)
        self.assertAlmostEqual(note.end, end, delta=tol)

    def test_steady_notes_and_silence(self):
        notes, stats = run([(0.5, None), (0.5, 60.0), (0.4, 62.0), (0.3, None), (0.6, 64.0)])
        self.assertEqual([n.midi for n in notes], [60, 62, 64])
        self.assertTimes(notes[0], 0.5, 1.0)
        self.assertTimes(notes[1], 1.0, 1.4)
        self.assertTimes(notes[2], 1.7, 2.3)
        self.assertAlmostEqual(stats["scoredSeconds"], 1.5, delta=0.05)

    def test_vibrato_stays_one_note(self):
        wide = lambda t: 64 + 0.9 * np.sin(2 * np.pi * 6.0 * t)  # noqa: E731
        notes, _ = run([(0.2, None), (2.0, wide), (0.2, None)])
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0].midi, 64)
        self.assertTimes(notes[0], 0.2, 2.2, tol=0.06)

    def test_long_scoop_is_trimmed_off_the_note(self):
        notes, stats = run([(0.2, None), (0.2, (61.5, 64.0)), (0.8, 64.0), (0.2, None)])
        self.assertEqual([n.midi for n in notes], [64])
        self.assertGreater(notes[0].start, 0.2 + 0.1)
        self.assertLess(notes[0].start, 0.2 + 0.22)
        self.assertAlmostEqual(notes[0].end, 1.2, delta=0.03)

    def test_short_scoop_stays_in_the_note_at_the_right_pitch(self):
        notes, _ = run([(0.2, None), (0.06, (62.8, 64.0)), (0.8, 64.0), (0.2, None)])
        self.assertEqual([n.midi for n in notes], [64])
        self.assertAlmostEqual(notes[0].median, 64.0, delta=0.05)
        self.assertTimes(notes[0], 0.2, 1.06)

    def test_slow_bend_that_never_settles_is_not_a_target(self):
        notes, _ = run([(0.2, None), (1.0, (60.0, 62.0)), (0.2, None)])
        self.assertEqual(notes, [])

    def test_slightly_drifting_held_note_is_kept(self):
        notes, _ = run([(0.2, None), (1.0, (62.0, 62.3)), (0.2, None)])
        self.assertEqual([n.midi for n in notes], [62])

    def test_slide_between_notes_is_not_a_target(self):
        notes, stats = run([(0.6, 60.0), (0.3, (60.0, 65.0)), (0.6, 65.0)])
        self.assertEqual([n.midi for n in notes], [60, 65])
        self.assertLess(notes[0].end, 0.6 + 0.06)
        self.assertGreater(notes[1].start, 0.9 - 0.06)
        lost = stats["lostSeconds"]
        self.assertGreater(lost["transition"] + lost["tooShort"] + lost["unstable"], 0.15)

    def test_pure_glide_produces_no_target(self):
        notes, _ = run([(0.2, None), (1.0, (60.0, 72.0)), (0.2, None)])
        self.assertEqual(notes, [])

    def test_octave_blip_is_folded_back(self):
        notes, stats = run([(0.4, 57.0), (0.07, 69.0), (0.4, 57.0)])
        self.assertEqual([n.midi for n in notes], [57])
        self.assertTimes(notes[0], 0.0, 0.87)
        self.assertGreater(stats["octaveRepairSeconds"], 0.04)

    def test_sustained_octave_leap_is_kept(self):
        notes, stats = run([(0.6, 57.0), (0.6, 69.0)])
        self.assertEqual([n.midi for n in notes], [57, 69])
        self.assertEqual(stats["octaveRepairSeconds"], 0.0)

    def test_tracker_dropout_is_bridged_but_a_real_gap_splits(self):
        notes, _ = run([(0.4, 60.0), (0.025, None), (0.4, 60.0)])
        self.assertEqual(len(notes), 1)
        notes, _ = run([(0.4, 60.0), (0.15, None), (0.4, 60.0)])
        self.assertEqual([n.midi for n in notes], [60, 60])

    def test_blips_shorter_than_a_note_are_dropped(self):
        notes, stats = run([(0.3, None), (0.05, 67.0), (0.3, None), (0.5, 60.0)])
        self.assertEqual([n.midi for n in notes], [60])
        self.assertGreater(stats["lostSeconds"]["tooShort"], 0.03)

    def test_fast_run_keeps_each_note(self):
        notes, _ = run([(0.14, 60.0), (0.14, 62.0), (0.14, 64.0), (0.14, 65.0)])
        self.assertEqual([n.midi for n in notes], [60, 62, 64, 65])

    def test_short_stray_note_far_from_the_melody_is_dropped(self):
        # An isolated syllable tracked an octave up, and one tracked an octave and a half down.
        melody = [(0.5, 54.0), (0.2, None), (0.5, 56.0), (0.2, None), (0.6, 52.0), (0.3, None)]
        notes, stats = run(melody + [(0.15, 64.0), (0.3, None)] + melody + [(0.2, 37.0), (0.3, None)] + melody)
        self.assertEqual(sorted({n.midi for n in notes}), [52, 54, 56])
        self.assertEqual(len(notes), 9)
        self.assertAlmostEqual(stats["lostSeconds"]["outlier"], 0.35, delta=0.05)

    def test_stray_note_rule_keeps_real_melody(self):
        # A fifth away is melody, however short; a held note is kept however far.
        melody = [(0.5, 54.0), (0.2, None), (0.5, 56.0), (0.2, None), (0.6, 52.0), (0.3, None)]
        notes, _ = run(melody + [(0.15, 47.0), (0.3, None)] + melody + [(0.5, 66.0), (0.3, None)] + melody)
        self.assertIn(47, [n.midi for n in notes])
        self.assertIn(66, [n.midi for n in notes])
        # With nothing around it there is no melody to be far from.
        notes, _ = run([(0.3, None), (0.2, 70.0), (0.3, None)])
        self.assertEqual([n.midi for n in notes], [70])

    def test_notes_are_ordered_and_do_not_overlap(self):
        rng = np.random.default_rng(1)
        parts = []
        for _ in range(60):
            parts.append((float(rng.uniform(0.05, 0.6)), None if rng.random() < 0.25 else float(rng.integers(55, 72)) + float(rng.normal(0, 0.1))))
        notes, stats = run(parts)
        self.assertGreater(len(notes), 10)
        for a, b in zip(notes, notes[1:]):
            self.assertLessEqual(a.end, b.start + 1e-9)
        for n in notes:
            self.assertGreaterEqual(n.end - n.start, P.min_note_s - HOP)
        self.assertLessEqual(stats["scoredSeconds"], stats["voicedSeconds"] + 1e-6)

    def test_empty_and_unvoiced_input(self):
        self.assertEqual(vt.notes_from_contour(np.array([]), np.array([], dtype=bool), P)[0], [])
        notes, stats = run([(1.0, None)])
        self.assertEqual(notes, [])
        self.assertEqual(stats["scoredSeconds"], 0.0)


class Helpers(unittest.TestCase):
    def test_hz_to_midi(self):
        m = vt.hz_to_midi(np.array([440.0, 220.0, np.nan, 0.0]))
        self.assertAlmostEqual(m[0], 69)
        self.assertAlmostEqual(m[1], 57)
        self.assertTrue(np.isnan(m[2]) and np.isnan(m[3]))

    def test_level_gate_is_relative_to_the_loud_level(self):
        db = np.array([-20.0] * 50 + [-50.0] * 20 + [-80.0] * 30)
        g = vt.level_gate(db, 35)
        self.assertTrue(g[:70].all())
        self.assertFalse(g[70:].any())


if __name__ == "__main__":
    unittest.main()
