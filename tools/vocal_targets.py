"""
Turn a frame-wise pitch contour of an isolated lead vocal into singable target notes.

This module is numpy-only so the note logic can be tested without audio libraries. The
contour comes from `tools/prepare_song.py` (pYIN on the isolated vocal).

A real vocal is not a clean staircase, so each step below exists for one measured behavior:

  dropouts      voiced gaps of a few frames inside a held note are bridged
  octave blips  short runs one octave away from their surroundings are folded back
  vibrato       note changes are detected on a contour smoothed over about one vibrato
                cycle, so a held note with vibrato stays one note
  scoops/falls  a long approach or release is trimmed off the note; one shorter than the
                smoothing window (about 75 ms) stays inside the note, which keeps its pitch
  slides        a glide that never settles produces no target (unscored, not guessed)
  breaths,      unvoiced or below the level gate: no target
  consonants
  stray notes   a short note far from where the melody sits around it (a tracker locking
                onto a harmonic or subharmonic for a moment) produces no target

Whatever is rejected is counted by reason in `stats`, in seconds. Those are tracker
measurements, not verified statements about the performance.
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np

@dataclass(frozen=True)
class Params:
    hop_s: float
    #: Shortest target note (s).
    min_note_s: float = 0.10
    #: Voicing dropouts up to this long inside a run are bridged (s).
    bridge_gap_s: float = 0.035
    #: Median window used for change detection; about one vibrato cycle (s).
    smooth_s: float = 0.15
    #: A new note starts when the smoothed pitch leaves the note by more than this (semitones)...
    split_semitones: float = 0.7
    #: ...for at least this long (s).
    split_hold_s: float = 0.045
    #: Edge frames further than this from the note's pitch are trimmed (semitones)...
    core_tol: float = 0.5
    #: ...up to this much per edge (s).
    max_trim_s: float = 0.15
    #: Largest median absolute deviation of the smoothed pitch inside a note (cents).
    max_mad_cents: float = 40.0
    #: Largest pitch drift across a note: fitted slope of the smoothed pitch times the note's
    #: length (semitones). Half a semitone keeps the target within 25 cents of what was sung.
    max_drift: float = 0.5
    #: Same-pitch notes closer than this are joined (s).
    merge_gap_s: float = 0.06
    #: A note shorter than `outlier_max_s` and at least `outlier_semitones` from the
    #: duration-weighted median pitch of the notes within `outlier_context_s` of it is dropped.
    outlier_semitones: float = 9.0
    outlier_max_s: float = 0.3
    outlier_context_s: float = 5.0
    #: Longest run treated as an octave error rather than a real leap (s).
    octave_run_s: float = 0.15
    #: Context on each side used to judge an octave error (s).
    octave_context_s: float = 0.25


@dataclass
class Note:
    start: float
    end: float
    midi: int
    #: Median sung pitch (fractional MIDI).
    median: float
    mad_cents: float


def hz_to_midi(f0: np.ndarray) -> np.ndarray:
    """MIDI note numbers; NaN where the frequency is missing or not positive."""
    f = np.asarray(f0, dtype=float)
    ok = np.isfinite(f) & (f > 0)
    out = np.full(f.shape, np.nan)
    out[ok] = 69 + 12 * np.log2(f[ok] / 440.0)
    return out


def level_gate(db: np.ndarray, gate_db: float = 35.0) -> np.ndarray:
    """Frames within `gate_db` of the track's loud level (its 95th percentile)."""
    db = np.asarray(db, dtype=float)
    if not len(db):
        return np.zeros(0, dtype=bool)
    return db > (np.percentile(db, 95) - gate_db)


def _frames(seconds: float, hop_s: float, minimum: int = 1) -> int:
    return max(minimum, int(round(seconds / hop_s)))


def nanmedian_filter(x: np.ndarray, size: int) -> np.ndarray:
    """Centered moving median that ignores NaN; all-NaN windows give NaN."""
    x = np.asarray(x, dtype=float)
    if not len(x):
        return x.copy()
    size = max(1, size) | 1
    pad = size // 2
    xp = np.pad(np.asarray(x, dtype=float), pad, constant_values=np.nan)
    win = np.lib.stride_tricks.sliding_window_view(xp, size)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        return np.nanmedian(win, axis=1)


def bridge_gaps(midi: np.ndarray, voiced: np.ndarray, max_gap: int) -> tuple[np.ndarray, np.ndarray]:
    """Fill unvoiced gaps of at most `max_gap` frames that have voiced frames on both sides."""
    midi = np.array(midi, dtype=float)
    voiced = np.array(voiced, dtype=bool)
    n = len(voiced)
    i = 0
    while i < n:
        if voiced[i]:
            i += 1
            continue
        j = i
        while j < n and not voiced[j]:
            j += 1
        if 0 < i and j < n and j - i <= max_gap:
            midi[i:j] = np.interp(np.arange(i, j), [i - 1, j], [midi[i - 1], midi[j]])
            voiced[i:j] = True
        i = j
    return midi, voiced


def repair_octaves(midi: np.ndarray, voiced: np.ndarray, p: Params) -> tuple[np.ndarray, int]:
    """
    Fold short runs that sit one octave from their surroundings back onto them.

    The reference is the median pitch within `octave_context_s` on each side, so a run
    shorter than the context is a minority there and stands out, while a sustained octave
    leap becomes the reference itself and is left alone. Returns (midi, frames repaired).
    """
    out = np.array(midi, dtype=float)
    v = np.asarray(voiced, dtype=bool)
    ref = nanmedian_filter(np.where(v, out, np.nan), 2 * _frames(p.octave_context_s, p.hop_s) + 1)
    d = out - ref
    max_run = _frames(p.octave_run_s, p.hop_s)
    fixed = 0
    for sign in (1, -1):
        cand = v & np.isfinite(d) & (np.abs(d - 12 * sign) < 1.0)
        i = 0
        n = len(cand)
        while i < n:
            if not cand[i]:
                i += 1
                continue
            j = i
            while j < n and cand[j]:
                j += 1
            if j - i <= max_run:
                out[i:j] -= 12 * sign
                fixed += j - i
            i = j
    return out, fixed


def _segments(s: np.ndarray, voiced: np.ndarray, p: Params) -> list[tuple[int, int]]:
    """Split each voiced run where the smoothed pitch leaves the current note and stays away."""
    hold = _frames(p.split_hold_s, p.hop_s, 2)
    out: list[tuple[int, int]] = []
    n = len(s)
    i = 0
    while i < n:
        if not voiced[i]:
            i += 1
            continue
        end = i
        while end < n and voiced[end]:
            end += 1
        a = i
        while a < end:
            vals = [float(s[a])]
            k = a + 1
            while k < end:
                center = float(np.median(vals))
                if abs(s[k] - center) > p.split_semitones and np.all(np.abs(s[k : min(end, k + hold)] - center) > p.split_semitones):
                    break
                vals.append(float(s[k]))
                k += 1
            out.append((a, k))
            a = k
        i = end
    return out


def isolated_outliers(notes: list[Note], p: Params) -> list[bool]:
    """
    Marks short notes that sit far from the melody around them.

    A tracker can lock onto a harmonic or subharmonic for a fraction of a second, most often
    on an isolated syllable where the frame-level octave repair has no neighbours to compare
    with. The result is a brief note an octave or more from everything near it. Real leaps
    that large exist, so only notes shorter than `outlier_max_s` are judged, and only against
    at least one second of other notes within `outlier_context_s`.
    """
    if not notes:
        return []
    mid = np.array([(n.start + n.end) / 2 for n in notes])
    dur = np.array([n.end - n.start for n in notes])
    pitch = np.array([float(n.midi) for n in notes])
    out = []
    for i, n in enumerate(notes):
        near = np.abs(mid - mid[i]) <= p.outlier_context_s
        near[i] = False
        if dur[i] >= p.outlier_max_s or dur[near].sum() < 1.0:
            out.append(False)
            continue
        order = np.argsort(pitch[near])
        cum = np.cumsum(dur[near][order])
        center = pitch[near][order][int(np.searchsorted(cum, cum[-1] / 2))]
        out.append(bool(abs(pitch[i] - center) >= p.outlier_semitones))
    return out


def notes_from_contour(midi: np.ndarray, voiced: np.ndarray, p: Params) -> tuple[list[Note], dict]:
    """
    Target notes from a contour.

    `midi` is fractional MIDI per frame (NaN allowed where unvoiced); `voiced` marks frames
    that are pitched and loud enough to be the lead vocal. Frame k is at time k * hop_s.
    Returns the notes in time order and `stats` (seconds by outcome).
    """
    midi = np.asarray(midi, dtype=float)
    voiced = np.asarray(voiced, dtype=bool) & np.isfinite(midi)
    n = len(midi)
    hop = p.hop_s
    midi, voiced_b = bridge_gaps(midi, voiced, _frames(p.bridge_gap_s, hop))
    raw, octave_frames = repair_octaves(midi, voiced_b, p)
    s = np.where(voiced_b, nanmedian_filter(np.where(voiced_b, raw, np.nan), _frames(p.smooth_s, hop)), np.nan)

    min_frames = _frames(p.min_note_s, hop, 3)
    max_trim = _frames(p.max_trim_s, hop)
    reason = {k: np.zeros(n, dtype=bool) for k in ("transition", "tooShort", "unstable")}
    kept: list[tuple[int, int, Note]] = []
    for a, b in _segments(s, voiced_b, p):
        center = float(np.median(s[a:b]))
        a2, b2 = a, b
        while a2 < b and a2 - a < max_trim and abs(s[a2] - center) > p.core_tol:
            a2 += 1
        while b2 > a2 and b - b2 < max_trim and abs(s[b2 - 1] - center) > p.core_tol:
            b2 -= 1
        if b2 - a2 < min_frames:
            reason["tooShort"][a:b] = True
            continue
        core = s[a2:b2]
        mad = float(np.median(np.abs(core - np.median(core)))) * 100
        # A glide can pass the spread test while never settling: reject it by its slope.
        drift = abs(float(np.polyfit(np.arange(b2 - a2), core, 1)[0])) * (b2 - a2)
        if mad > p.max_mad_cents or drift > p.max_drift:
            reason["unstable"][a:b] = True
            continue
        reason["transition"][a:a2] = True
        reason["transition"][b2:b] = True
        med = float(np.median(raw[a2:b2]))
        kept.append((a2, b2, Note(a2 * hop, b2 * hop, int(round(med)), med, mad)))

    notes: list[Note] = []
    spans: list[list[int]] = []
    for a, b, note in kept:
        if notes and notes[-1].midi == note.midi and note.start - notes[-1].end < p.merge_gap_s:
            prev = notes[-1]
            wa, wb = prev.end - prev.start, note.end - note.start
            notes[-1] = Note(prev.start, note.end, prev.midi, (prev.median * wa + note.median * wb) / (wa + wb), max(prev.mad_cents, note.mad_cents))
            spans[-1][1] = b
        else:
            notes.append(note)
            spans.append([a, b])

    reason["outlier"] = np.zeros(n, dtype=bool)
    stray = isolated_outliers(notes, p)
    for (a, b), drop in zip(spans, stray):
        if drop:
            reason["outlier"][a:b] = True
    notes = [nt for nt, drop in zip(notes, stray) if not drop]
    spans = [sp for sp, drop in zip(spans, stray) if not drop]

    in_note = np.zeros(n, dtype=bool)
    for a, b in spans:
        in_note[a:b] = True
    secs = lambda m: round(float(np.count_nonzero(m) * hop), 2)  # noqa: E731
    stats = {
        "voicedSeconds": secs(voiced_b),
        "scoredSeconds": secs(in_note),
        "lostSeconds": {k: secs(reason[k] & ~in_note) for k in ("transition", "tooShort", "unstable", "outlier")},
        "octaveRepairSeconds": round(octave_frames * hop, 2),
        "inNote": in_note,
        "voiced": voiced_b,
    }
    return notes, stats
