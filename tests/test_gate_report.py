"""Audio-independent regressions for extraction diagnostics; requires only NumPy."""
import unittest

import numpy as np

from tools.extract_melody import DISAGREE_KINDS, GATE_REASONS, NoteSeg, gate_report


def segment(start, end, mad=0):
    return NoteSeg(start, end, 60, 60.0, mad, 1)


class GateReportTests(unittest.TestCase):
    def report(self, present, pyin, agree, diff, stable=(), unstable=(), hop=0.1,
               duration=None, min_gap=2.0):
        return gate_report(
            np.array(present, dtype=bool), np.array(pyin, dtype=bool),
            np.array(agree, dtype=bool), np.array(diff, dtype=float),
            list(stable), list(unstable), hop,
            len(present) * hop if duration is None else duration, min_gap,
        )

    def test_first_rejecting_gate_partitions_only_lost_present_frames(self):
        # One absent frame; two retained frames; then two frames for every gate.
        present = [False] + [True] * 10
        pyin = [True, True, True, False, False, True, True, True, True, True, True]
        agree = [True, True, True, False, False, False, False, True, True, True, True]
        diff = [0, 0, 0, np.nan, np.nan, 2, 12, 0, 0, 0, 0]
        out = self.report(present, pyin, agree, diff,
                          stable=[segment(0.1, 0.3)],
                          unstable=[segment(0.9, 1.1, 40)])
        self.assertEqual(out['lostSeconds'], {reason: 0.2 for reason in GATE_REASONS})
        self.assertAlmostEqual(sum(out['lostSeconds'].values()), 0.8)
        self.assertEqual(out['agreeSeconds'], 0.6)
        self.assertAlmostEqual(sum(out['disagreeSeconds'].values()), 0.2)

    def test_disagreement_subcategories_are_disjoint_and_additive(self):
        # Verify signed octave distance, strict octave tolerance, and near upper edge.
        diff = [12, -12, 24, -24, 12.59, 12.61, 0.6, -0.8, 1.499, 1.5, 4]
        out = self.report([True] * len(diff), [True] * len(diff),
                          [False] * len(diff), diff)
        self.assertEqual(out['disagreeSeconds'], {'octave': 0.5, 'near': 0.3, 'other': 0.3})
        self.assertAlmostEqual(sum(out['disagreeSeconds'].values()),
                               out['lostSeconds']['trackersDisagree'])
        self.assertEqual(set(out['disagreeSeconds']), set(DISAGREE_KINDS))

    def test_no_vocal_frames_do_not_become_losses(self):
        out = self.report([False] * 50, [True] * 50, [True] * 50, [12] * 50,
                          unstable=[segment(0, 5, 40)])
        self.assertEqual(out['agreeSeconds'], 0)
        self.assertTrue(all(v == 0 for v in out['lostSeconds'].values()))
        self.assertTrue(all(v == 0 for v in out['disagreeSeconds'].values()))
        self.assertEqual(len(out['gaps']), 1)
        self.assertEqual(out['gaps'][0]['present'], 0)

    def test_retained_spans_override_dropped_and_bridged_gate_frames(self):
        # A merged retained note can bridge a brief rejected frame. It is not lost.
        out = self.report([True] * 10, [False] * 10, [False] * 10, [np.nan] * 10,
                          stable=[segment(0.2, 0.6)],
                          unstable=[segment(0.4, 0.8, 40)])
        self.assertEqual(out['lostSeconds'], {
            'pyinUnvoiced': 0.4, 'trackersDisagree': 0, 'tooShort': 0, 'unstable': 0.2,
        })
        self.assertAlmostEqual(sum(out['lostSeconds'].values()), 0.6)

    def test_leading_interior_and_trailing_gaps_have_local_totals(self):
        n = 90
        pyin = [False] * 30 + [True] * 60
        agree = [False] * 30 + [True] * 10 + [False] * 30 + [True] * 20
        diff = [np.nan] * 30 + [0] * 10 + [12] * 30 + [0] * 20
        # Deliberately unsorted retained notes; output gaps must still be chronological.
        out = self.report([True] * n, pyin, agree, diff,
                          stable=[segment(6, 7), segment(2, 3)])
        self.assertEqual([(g['t'], g['e']) for g in out['gaps']], [(0, 2), (3, 6), (7, 9)])
        self.assertEqual(out['gaps'][0]['pyinUnvoiced'], 2)
        self.assertEqual(out['gaps'][1]['trackersDisagree'], 2)
        self.assertEqual(out['gaps'][1]['tooShort'], 1)
        self.assertEqual(out['gaps'][1]['disagree']['octave'], 2)
        self.assertEqual(out['gaps'][2]['tooShort'], 2)
        for gap in out['gaps']:
            self.assertAlmostEqual(sum(gap[k] for k in GATE_REASONS), gap['present'])
            self.assertAlmostEqual(sum(gap['disagree'].values()), gap['trackersDisagree'])

    def test_gap_cutoff_and_empty_target_list(self):
        out = self.report([True] * 60, [False] * 60, [False] * 60, [np.nan] * 60,
                          stable=[segment(1.9, 2.9), segment(4.9, 5.9)])
        self.assertEqual([(g['t'], g['e']) for g in out['gaps']], [(2.9, 4.9)])
        empty = self.report([True] * 30, [False] * 30, [False] * 30, [np.nan] * 30)
        self.assertEqual([(g['t'], g['e']) for g in empty['gaps']], [(0, 3)])
        self.assertEqual(empty['gaps'][0]['pyinUnvoiced'], 3)
        no_frames = self.report([], [], [], [], duration=0)
        self.assertEqual(no_frames['gaps'], [])
        self.assertTrue(all(v == 0 for v in no_frames['lostSeconds'].values()))

    def test_rounded_category_sums_allow_only_rounding_error(self):
        hop = 256 / 22050
        # Four category totals rounded separately can differ from one rounded total.
        out = self.report([True] * 7, [False, True, True, True, True, True, True],
                          [False, False, False, False, True, True, True],
                          [np.nan, 12, 0.8, 4, 0, 0, 0],
                          unstable=[segment(6 * hop, 7 * hop, 40)], hop=hop)
        self.assertLessEqual(abs(sum(out['lostSeconds'].values()) - round(7 * hop, 2)), 0.02)
        self.assertLessEqual(abs(sum(out['disagreeSeconds'].values()) -
                                 out['lostSeconds']['trackersDisagree']), 0.015)


if __name__ == '__main__':
    unittest.main()
