"""
tools/prepare_song.py: lyric hash parity with the app, timing.json checks, file naming, and
(when librosa and soundfile are installed) the whole command on a synthetic song.

    python3 -m unittest discover -s tests -p 'test_*.py' -v

The synthetic song checks alignment and note logic. It is not evidence about extraction
quality on a real recording.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
sys.path.insert(0, HERE)

import prepare_song as ps  # noqa: E402

HAVE_AUDIO = all(importlib.util.find_spec(m) for m in ("librosa", "soundfile", "scipy"))


class LyricHash(unittest.TestCase):
    def test_matches_the_shared_vectors(self):
        with open(os.path.join(HERE, "fixtures", "lyrics-hash.json"), encoding="utf-8") as fh:
            cases = json.load(fh)["cases"]
        self.assertGreater(len(cases), 3)
        for c in cases:
            lines = ps.lyric_lines(c["text"])
            self.assertEqual(lines, c["lines"])
            self.assertEqual(ps.hash_lines(lines), c["hash"])


class Classify(unittest.TestCase):
    def test_roles_match_the_shared_table(self):
        with open(os.path.join(HERE, "fixtures", "audio-roles.json"), encoding="utf-8") as fh:
            cases = json.load(fh)["cases"]
        self.assertGreater(len(cases), 10)
        for name, role in cases:
            self.assertEqual(ps.classify(name), role, name)
        self.assertIsNone(ps.classify("lyrics.txt"))

    def test_title_from_id(self):
        self.assertEqual(ps.title_from_id("love-yourself"), "Love Yourself")


class CheckTiming(unittest.TestCase):
    LINES = ["one", "two", "three"]

    def doc(self, **over):
        d = {"version": 1, "hash": ps.hash_lines(self.LINES), "lineCount": 3, "lines": [{"start": 1.0, "end": 2.0}, {"start": 2.5, "end": 3.0}, {"start": 4.0, "end": 5.0}]}
        d.update(over)
        return d

    def test_good_file_is_usable(self):
        ok, msgs = ps.check_timing(self.doc(), self.LINES, 10.0)
        self.assertTrue(ok)
        self.assertEqual(msgs, [])

    def test_unknown_shape_says_what_to_use(self):
        ok, msgs = ps.check_timing([{"time": 1.0, "text": "one"}], self.LINES, 10.0)
        self.assertFalse(ok)
        ok, msgs = ps.check_timing({"lines": [{"start": 1}]}, self.LINES, 10.0)
        self.assertFalse(ok)
        text = " ".join(msgs)
        self.assertIn("version: 1", text)
        self.assertIn(ps.hash_lines(self.LINES), text)

    def test_wrong_lyrics_hash_and_count(self):
        ok, msgs = ps.check_timing(self.doc(hash="deadbeef"), self.LINES, 10.0)
        self.assertFalse(ok)
        self.assertIn("deadbeef", " ".join(msgs))
        ok, msgs = ps.check_timing(self.doc(lines=[{"start": 1.0, "end": 2.0}]), self.LINES, 10.0)
        self.assertFalse(ok)
        self.assertIn("1 line entries", " ".join(msgs))

    def test_out_of_order_and_off_timeline(self):
        ok, msgs = ps.check_timing(self.doc(lines=[{"start": 3.0, "end": 3.5}, {"start": 2.0, "end": 2.5}, {"start": 4.0, "end": 5.0}]), self.LINES, 10.0)
        self.assertFalse(ok)
        self.assertIn("song order", " ".join(msgs))
        ok, msgs = ps.check_timing(self.doc(), self.LINES, 3.0)
        self.assertFalse(ok)
        self.assertIn("different timeline", " ".join(msgs))

    def test_unset_lines_warn_but_load(self):
        ok, msgs = ps.check_timing(self.doc(lines=[{"start": 1.0, "end": 2.0}, {"start": None, "end": None}, {"start": 4.0, "end": 5.0}]), self.LINES, 10.0)
        self.assertTrue(ok)
        self.assertIn("no start time", " ".join(msgs))

    def test_lines_that_do_not_cover_the_singing_are_reported(self):
        # Singing from 3 s to 200 s; the three lines end at 5 s.
        notes = [{"t": float(t), "d": 0.8, "m": 60, "c": 0} for t in range(3, 200)]
        ok, msgs = ps.check_timing(self.doc(), self.LINES, 240.0, notes)
        self.assertTrue(ok)
        self.assertIn("does not cover the whole song", " ".join(msgs))
        covered = [{"t": 1.0, "d": 0.8, "m": 60, "c": 0}, {"t": 2.6, "d": 0.3, "m": 62, "c": 0}, {"t": 4.1, "d": 0.8, "m": 60, "c": 0}]
        self.assertEqual(ps.check_timing(self.doc(), self.LINES, 10.0, covered), (True, []))

    def test_without_lyrics_the_hash_is_not_judged(self):
        ok, msgs = ps.check_timing(self.doc(hash="deadbeef"), None, 10.0)
        self.assertTrue(ok)
        self.assertIn("lyrics.txt is missing", " ".join(msgs))


@unittest.skipUnless(HAVE_AUDIO, "needs librosa, scipy and soundfile (pip install -r tools/requirements.txt)")
class PrepareSyntheticSong(unittest.TestCase):
    """The whole command on WAV files whose notes and offsets are known."""

    INST_DELAY = 0.040
    VOCAL_DELAY = 0.015

    @classmethod
    def setUpClass(cls):
        import synth_song

        cls.synth = synth_song
        cls.tmp = tempfile.TemporaryDirectory()
        cls.folder = os.path.join(cls.tmp.name, "songs", "demo-song")
        synth_song.write_song(cls.folder, cls.INST_DELAY, cls.VOCAL_DELAY, repeats=4)
        with open(os.path.join(cls.folder, "lyrics.txt"), "w", encoding="utf-8") as fh:
            fh.write("[Verse]\nline one\nline two\n")
        cls.timing = {"version": 1, "hash": ps.hash_lines(["line one", "line two"]), "lineCount": 2, "lines": [{"start": 1.0, "end": 4.0}, {"start": 4.5, "end": 7.0}]}
        with open(os.path.join(cls.folder, "timing.json"), "w", encoding="utf-8") as fh:
            json.dump(cls.timing, fh)
        ps.main([cls.folder, "--title", "Demo Song", "--artist", "Nobody"])
        with open(os.path.join(cls.folder, "melody.json"), encoding="utf-8") as fh:
            cls.melody = json.load(fh)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def expected(self):
        notes, _ = self.synth.repeated(4)
        # Song time is the instrumental file's time: master time plus the instrumental's delay.
        return [(s + self.INST_DELAY, d, m) for s, d, m, _ in notes]

    def test_every_note_is_recovered_on_the_song_timeline(self):
        got = self.melody["notes"]
        want = self.expected()
        self.assertEqual([n["m"] for n in got], [m for _, _, m in want])
        for n, (s, d, _) in zip(got, want):
            self.assertAlmostEqual(n["t"], s, delta=0.05)
            self.assertAlmostEqual(n["t"] + n["d"], s + d, delta=0.06)

    def test_offsets_are_measured(self):
        self.assertAlmostEqual(self.melody["referenceOffset"], -self.INST_DELAY, delta=0.002)
        vocal = self.melody["analysis"]["alignment"]["vocal"]
        self.assertEqual(vocal["method"], "measured")
        # Song time = vocal file time + songOffsetSeconds.
        self.assertAlmostEqual(vocal["songOffsetSeconds"], self.INST_DELAY - self.VOCAL_DELAY, delta=0.002)

    def test_metadata_fits_the_app(self):
        m = self.melody
        self.assertEqual(m["version"], 1)
        self.assertAlmostEqual(m["duration"], 44.0 + self.INST_DELAY, delta=0.01)
        self.assertEqual(m["source"]["kind"], "isolated-vocal")
        target = sum(n["d"] for n in m["notes"])
        # src/core/melody.ts drops presentSeconds unless it covers the targets and fits the song.
        self.assertGreaterEqual(m["analysis"]["presentSeconds"] + 0.1, target)
        self.assertLessEqual(m["analysis"]["presentSeconds"], m["duration"] + 0.1)
        self.assertGreater(len(m["phrases"]), 4)
        self.assertGreater(m["analysis"]["lostSeconds"]["unpitched"], 1.0)

    def test_song_definition_and_registry(self):
        with open(os.path.join(self.folder, "song.json"), encoding="utf-8") as fh:
            song = json.load(fh)
        self.assertEqual(song["id"], "demo-song")
        self.assertEqual((song["title"], song["artist"]), ("Demo Song", "Nobody"))
        self.assertEqual(song["referenceKind"], "mix")
        self.assertEqual(song["files"]["instrumental"], "Demo Instrumental.wav")
        self.assertEqual(song["files"]["reference"], "Demo Full.wav")
        self.assertEqual(song["files"]["vocal"], "Demo (Vocals Only).wav")
        with open(os.path.join(os.path.dirname(self.folder), "index.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {"version": 1, "songs": ["demo-song"]})

    def test_timing_file_is_left_untouched(self):
        with open(os.path.join(self.folder, "timing.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), self.timing)

    def test_rerun_is_idempotent_and_keeps_the_definition(self):
        before = self.melody["notes"]
        ps.main([self.folder])
        with open(os.path.join(self.folder, "melody.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["notes"], before)
        with open(os.path.join(self.folder, "song.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["title"], "Demo Song")
        with open(os.path.join(os.path.dirname(self.folder), "index.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["songs"], ["demo-song"])


@unittest.skipUnless(HAVE_AUDIO, "needs librosa, scipy and soundfile (pip install -r tools/requirements.txt)")
class MeasureLag(unittest.TestCase):
    """The offset check when the mix starts seconds before the other files, as real files do."""

    def test_mix_that_starts_earlier_is_not_reported_as_a_speed_difference(self):
        import numpy as np
        import synth_song

        notes, duration = synth_song.repeated(5)
        v, b = synth_song.vocal(notes, duration), synth_song.backing(duration)
        mix = v + b
        inst = synth_song.delayed(b, 2.384)
        vocal = synth_song.delayed(v, 0.311)[: len(v) - synth_song.SR]
        lag, info = ps.measure_lag(inst, mix, "the instrumental", 0.3, active_only=False)
        self.assertEqual(lag, -int(round(2.384 * synth_song.SR)))
        self.assertGreaterEqual(info["windows"], 4)
        self.assertLess(abs(info["slopePpm"]), 5)
        self.assertLess(info["madSamples"], 2)
        lag, info = ps.measure_lag(vocal, mix, "the vocal", 0.2, active_only=True)
        self.assertEqual(lag, -int(round(0.311 * synth_song.SR)))
        self.assertLess(abs(info["slopePpm"]), 5)

    def test_one_bad_window_does_not_fake_a_drift(self):
        import numpy as np
        import synth_song

        notes, duration = synth_song.repeated(6)
        b = synth_song.backing(duration)
        mix = b + synth_song.vocal(notes, duration)
        inst = synth_song.delayed(b, 0.5).copy()
        # Replace one window of the instrumental with a copy of an earlier stretch: it then
        # matches the mix at the wrong place.
        W = 8 * synth_song.SR
        inst[3 * W : 4 * W] = inst[3 * W - 9000 : 4 * W - 9000]
        lag, info = ps.measure_lag(inst, mix, "the instrumental", 0.3, active_only=False)
        self.assertEqual(lag, -int(round(0.5 * synth_song.SR)))
        self.assertLess(abs(info["slopePpm"]), 5)

    def test_a_real_speed_difference_is_still_reported(self):
        import librosa
        import numpy as np
        import synth_song
        from scipy.signal import butter, sosfiltfilt

        n = 80 * synth_song.SR
        # Low-passed noise stays correlated over a few milliseconds of drift, as bass does.
        low = sosfiltfilt(butter(4, 80, fs=synth_song.SR, output="sos"), np.random.default_rng(5).standard_normal(n)).astype(np.float32)
        slow = librosa.resample(low, orig_sr=10000, target_sr=10004, res_type="soxr_hq")  # 400 ppm longer
        _, info = ps.measure_lag(slow, low, "the instrumental", 0.3, active_only=False)
        self.assertGreaterEqual(info["windows"], 4)
        self.assertAlmostEqual(abs(info["slopePpm"]), 400, delta=60)
        # Broadband content decorrelates instead: the offset is then reported as unverified.
        wide = synth_song.backing(66.0)
        slow = librosa.resample(wide, orig_sr=10000, target_sr=10010, res_type="soxr_hq")
        _, info = ps.measure_lag(slow, wide, "the instrumental", 0.3, active_only=False)
        self.assertLess(info["windows"], 4)


@unittest.skipUnless(HAVE_AUDIO, "needs librosa, scipy and soundfile (pip install -r tools/requirements.txt)")
class PrepareWithoutMix(unittest.TestCase):
    def test_stems_only_assume_alignment_and_layer_the_vocal(self):
        import synth_song

        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "songs", "stems-only")
            synth_song.write_song(folder, 0.0, 0.0, with_mix=False)
            ps.main([folder, "--no-register"])
            with open(os.path.join(folder, "melody.json"), encoding="utf-8") as fh:
                melody = json.load(fh)
            with open(os.path.join(folder, "song.json"), encoding="utf-8") as fh:
                song = json.load(fh)
            self.assertEqual(melody["analysis"]["alignment"]["vocal"]["method"], "assumed")
            self.assertEqual(melody["referenceOffset"], 0)
            self.assertEqual([n["m"] for n in melody["notes"]], [m for _, _, m, _ in synth_song.NOTES])
            self.assertEqual(song["referenceKind"], "vocal")
            self.assertEqual(song["files"]["reference"], song["files"]["vocal"])
            self.assertFalse(os.path.exists(os.path.join(tmp, "songs", "index.json")))


if __name__ == "__main__":
    unittest.main()
