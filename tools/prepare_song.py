#!/usr/bin/env python3
"""
Prepare a Pitch Hero song package from its source files.

    python3 tools/prepare_song.py public/songs/<id> [--title "..."] [--artist "..."]

The folder holds the files you provide:

  instrumental   the track you sing over                       (required)
  isolated vocal the lead vocal alone; the source of the target (required)
  full mix       the song with vocals; the Reference vocal track (optional)
  lyrics.txt     one lyric line per line, optional [Section] headers (optional)
  timing.json    lyric line times made with Settings > Sync lyrics   (optional)

Files are recognized by name ("instrumental"/"karaoke", "vocals only"/"acapella",
"full"/"with vocals"), by an existing song.json, or by the --instrumental/--vocal/--mix flags.
Nothing in the folder is renamed, and timing.json is only checked, never rewritten.

What is written:

  melody.json   target notes on the instrumental's timeline (same format the app reads)
  song.json     the song definition (title, artist, file names)
  ../index.json the list of songs the app offers (unless --no-register)

How the target is made
  1. All audio is decoded to mono at 22.05 kHz.
  2. Alignment. The instrumental's timeline is the song timeline. With a full mix, the
     offset of the instrumental and of the vocal inside the mix are both measured by
     cross-correlation, which places the vocal on the song timeline. Without a mix the two
     stems are assumed to start together (true for stems from one separation); the
     assumption is recorded and --vocal-offset overrides it.
  3. pYIN tracks the vocal's pitch. Frames count as sung when pYIN calls them voiced and
     the vocal is within --gate-db of its loud level, which drops breaths, reverb tails and
     separation residue in instrumental passages.
  4. tools/vocal_targets.py turns the contour into notes (vibrato, scoops, slides, octave
     blips and dropouts are handled there) and counts what it rejected, by reason.
  5. Key and tempo come from the instrumental; phrases come from where the vocal is present.

Dependencies: numpy, scipy, librosa (>= 0.10), soundfile (libsndfile with MP3 support);
matplotlib only for --plot. See tools/requirements.txt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract_melody as xm  # noqa: E402
import vocal_targets as vt  # noqa: E402

SR = xm.SR
HOP = xm.HOP
N_FFT = xm.N_FFT
LEVEL_FRAME = 512
AUDIO_EXT = (".mp3", ".m4a", ".wav", ".flac", ".ogg", ".aac")

# Checked in this order: a "vocals only" file also contains the word "vocal", and a
# "no vocals" file is an instrumental.
ROLE_PATTERNS = (
    ("instrumental", re.compile(r"karaoke|instrumental|\binst\b|backing|minus|\bno[ _-]?vocals?|without[ _-]vocals?")),
    ("vocal", re.compile(r"vocals?[ _-]?only|only[ _-]?vocals?|a[ _-]?cap+el+a|isolated|lead[ _-]?vocals?|vocal[ _-]?stem|^vocals?\b|\(vocals?\)")),
    ("mix", re.compile(r"\bfull\b|with[ _-]vocals?|original|\bmix\b|reference")),
)

log = xm.log


# ---------------------------------------------------------------- lyrics and timing

# JavaScript's \s, so the hash below matches src/core/lyrics.ts on every input.
_JS_SPACE = "\t\n\v\f\r    -     　﻿"
_JS_SPACES = re.compile(f"[{_JS_SPACE}]+")


def normalize_line(s: str) -> str:
    return _JS_SPACES.sub(" ", s).strip(" ")


def lyric_lines(text: str) -> list[str]:
    """Lyric lines as the app counts them: blank lines and [Section] headers excluded."""
    out = []
    for raw in re.sub(r"\r\n?", "\n", text).split("\n"):
        s = normalize_line(raw)
        if s and not re.fullmatch(r"\[(.+)\]", s):
            out.append(s)
    return out


def hash_lines(lines: list[str]) -> str:
    """FNV-1a 32-bit over UTF-16 code units, as hashLines in src/core/lyrics.ts."""
    h = 0x811C9DC5
    data = "\n".join(normalize_line(x) for x in lines).encode("utf-16-le", "surrogatepass")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def check_timing(timing: object, lines: list[str] | None, duration: float | None) -> tuple[bool, list[str]]:
    """
    Check a timing.json document against the lyric lines. Returns (usable, messages).

    `usable` means the app will load it as is. Messages name every rule that failed and
    what to change; a usable file can still carry warnings.
    """
    msgs: list[str] = []
    if not isinstance(timing, dict):
        return False, ["not a JSON object; expected {\"version\": 1, \"hash\": \"...\", \"lineCount\": N, \"lines\": [{\"start\": s, \"end\": s}, ...]}"]
    rows = timing.get("lines")
    if timing.get("version") != 1 or not isinstance(timing.get("hash"), str) or not isinstance(rows, list):
        missing = [k for k, ok in (("version: 1", timing.get("version") == 1), ("hash (string)", isinstance(timing.get("hash"), str)), ("lines (array)", isinstance(rows, list))) if not ok]
        msgs.append("unknown format: missing or wrong " + ", ".join(missing))
        if lines is not None:
            msgs.append(f"for this lyrics.txt use \"hash\": \"{hash_lines(lines)}\" and \"lineCount\": {len(lines)}, with one {{\"start\", \"end\"}} entry per lyric line")
        return False, msgs
    usable = True
    if lines is None:
        msgs.append("lyrics.txt is missing, so the lyric hash and line count could not be checked")
    else:
        want = hash_lines(lines)
        if len(rows) != len(lines):
            usable = False
            msgs.append(f"has {len(rows)} line entries but lyrics.txt has {len(lines)} lyric lines; they must match one to one")
        if timing["hash"] != want:
            usable = False
            msgs.append(f"hash is \"{timing['hash']}\" but this lyrics.txt hashes to \"{want}\": the timing was made for different lyric text (re-sync in the app, or set the hash if only the hash is wrong)")
    starts = [r.get("start") if isinstance(r, dict) else None for r in rows]
    ends = [r.get("end") if isinstance(r, dict) else None for r in rows]
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and np.isfinite(v)  # noqa: E731
    unset = [i + 1 for i, v in enumerate(starts) if not num(v)]
    if unset:
        msgs.append(f"{len(unset)} of {len(rows)} lines have no start time (first: line {unset[0]}); those lines will not show in sync")
    prev = None
    for i, v in enumerate(starts):
        if not num(v):
            continue
        if prev is not None and v < prev[1]:
            msgs.append(f"line {i + 1} starts at {v} s, before line {prev[0]} ({prev[1]} s); lines must be in song order")
            usable = False
            break
        prev = (i + 1, v)
    bad_end = [i + 1 for i, (a, b) in enumerate(zip(starts, ends)) if num(a) and num(b) and b <= a]
    if bad_end:
        msgs.append(f"line {bad_end[0]} ends at or before its start ({len(bad_end)} such lines)")
    if duration is not None:
        late = [i + 1 for i, v in enumerate(starts) if num(v) and v > duration]
        if late:
            usable = False
            msgs.append(f"line {late[0]} starts after the end of the instrumental ({duration:.1f} s): the times are on a different timeline")
    words = sum(1 for r in rows if isinstance(r, dict) and isinstance(r.get("words"), list))
    if words:
        msgs.append(f"{words} lines carry word times")
    return usable, msgs


# ---------------------------------------------------------------- files


def classify(name: str) -> str | None:
    """Role of an audio file from its name: instrumental, vocal, mix, or None."""
    n = name.lower()
    if not n.endswith(AUDIO_EXT):
        return None
    stem = os.path.splitext(n)[0]
    if stem in ("instrumental", "vocal", "vocals"):
        return "instrumental" if stem == "instrumental" else "vocal"
    if stem in ("reference", "mix", "full"):
        return "mix"
    for role, pat in ROLE_PATTERNS:
        if pat.search(stem):
            return role
    return None


def resolve_files(folder: str, existing: dict | None, args: argparse.Namespace) -> dict:
    """File names (inside the folder) per role: flags, then song.json, then names."""
    names = sorted(os.listdir(folder))
    found: dict[str, list[str]] = {"instrumental": [], "vocal": [], "mix": []}
    for n in names:
        role = classify(n)
        if role:
            found[role].append(n)
    prior = (existing or {}).get("files", {}) if existing else {}
    prior_kind = (existing or {}).get("referenceKind")
    out: dict[str, str | None] = {}
    for role, flag, prior_name in (
        ("instrumental", args.instrumental, prior.get("instrumental")),
        ("vocal", args.vocal, prior.get("vocal")),
        ("mix", args.mix, prior.get("reference") if prior_kind == "mix" else None),
    ):
        if flag:
            pick = os.path.basename(flag)
        elif prior_name and os.path.exists(os.path.join(folder, prior_name)):
            pick = prior_name
        elif len(found[role]) == 1:
            pick = found[role][0]
        elif len(found[role]) > 1:
            raise SystemExit(f"More than one file looks like the {role}: {', '.join(found[role])}. Say which with --{role}.")
        else:
            pick = None
        if pick and not os.path.exists(os.path.join(folder, pick)):
            raise SystemExit(f"{pick} is not in {folder}.")
        out[role] = pick
    for role, what in (("instrumental", "the track you sing over"), ("vocal", "the isolated lead vocal")):
        if not out[role]:
            audio = [n for n in names if n.lower().endswith(AUDIO_EXT)]
            raise SystemExit(f"No {role} found in {folder} ({what}). Audio files there: {', '.join(audio) or 'none'}. Name it with --{role}.")
    out["lyrics"] = os.path.basename(args.lyrics) if args.lyrics else prior.get("lyrics", "lyrics.txt")
    out["timing"] = prior.get("timing", "timing.json")
    out["melody"] = prior.get("melody", "melody.json")
    return out


def title_from_id(song_id: str) -> str:
    return " ".join(w.capitalize() for w in re.split(r"[-_]+", song_id) if w)


# ---------------------------------------------------------------- audio


def stem_offset(stem: np.ndarray, mix: np.ndarray) -> tuple[int, dict]:
    """
    Lag l (samples) with mix[n + l] <-> stem[n], for a stem that is one component of the mix.

    Coarse over the whole file, then checked per 8 s window where the stem is active, so a
    stem cut from a different master or running at a different speed is reported instead of
    silently shifting every target.
    """
    n = min(len(stem), len(mix))
    lag, peak = xm.xcorr_lag(stem[:n] - stem[:n].mean(), mix[:n] - mix[:n].mean(), 3 * SR)
    W = 8 * SR
    R = SR // 2
    level = np.sqrt(np.mean(stem**2)) + 1e-9
    rows = []
    for s in range(0, n - W, W):
        x = stem[s : s + W]
        lo = s + lag - R
        hi = s + W + lag + R
        if lo < 0 or hi > len(mix) or np.sqrt(np.mean(x**2)) < 0.5 * level:
            continue
        y = mix[lo:hi]
        N = 1 << int(np.ceil(np.log2(len(y) + len(x))))
        cc = np.fft.irfft(np.fft.rfft(y - y.mean(), N) * np.conj(np.fft.rfft(x - x.mean(), N)), N)[: len(y) - len(x) + 1]
        k = int(np.argmax(np.abs(cc)))
        c = cc[k] / (np.sqrt((x**2).sum() * (y[k : k + len(x)] ** 2).sum()) + 1e-12)
        rows.append((s / SR, lo + k - s, abs(float(c))))
    good = [(t, l) for t, l, c in rows if c > 0.2]
    info: dict = {"coarseLag": int(lag), "coarsePeak": round(float(peak), 3), "windows": len(good)}
    if len(good) >= 4:
        t = np.array([g[0] for g in good])
        l = np.array([g[1] for g in good], dtype=float)
        med = float(np.median(l))
        mad = float(np.median(np.abs(l - med)))
        slope = float(np.polyfit(t, l, 1)[0])
        info.update({"medianLag": med, "madSamples": mad, "slopePpm": round(slope / SR * 1e6, 3)})
        if abs(slope / SR) > 2e-4:
            log(f"WARNING: the vocal and the full mix run at different speeds ({slope / SR * 1e6:.0f} ppm); one offset will not align them.")
        if mad > 0.01 * SR:
            log(f"WARNING: per-window vocal offsets disagree (MAD {mad / SR * 1000:.1f} ms); check that the vocal was isolated from this mix.")
        return int(round(med)), info
    log("WARNING: could not verify the vocal offset per window; using the whole-file estimate.")
    return int(lag), info


def track_vocal(vocal: np.ndarray, gate_db: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(fractional MIDI, sung mask, present mask) per frame; frame k is at k * HOP / SR."""
    import librosa

    f0, flag, _ = librosa.pyin(vocal, fmin=xm.FMIN, fmax=xm.FMAX, sr=SR, frame_length=N_FFT, hop_length=HOP, fill_na=np.nan)
    # Level over a short window at the frame center: the pitch window is 93 ms long, and a
    # gate measured over it would open that much before a note and close that much after.
    rms = librosa.feature.rms(y=vocal, frame_length=LEVEL_FRAME, hop_length=HOP, center=True)[0]
    db = 20 * np.log10(np.maximum(rms, 1e-7))
    n = min(len(f0), len(db))
    midi = vt.hz_to_midi(f0[:n])
    present = vt.level_gate(db[:n], gate_db)
    return midi, present & flag[:n] & np.isfinite(midi), present


def analyze(inst: np.ndarray, vocal: np.ndarray, mix: np.ndarray | None, reference_kind: str, vocal_offset: float | None, gate_db: float) -> tuple[dict, dict]:
    """The melody.json document (without the source signature) and plot data."""
    hop_s = HOP / SR
    alignment: dict = {}
    lag_im = 0
    if mix is not None:
        lag_im, info = xm.measure_offset(inst, mix)
        alignment["mix"] = {k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v) for k, v in info.items()}
        log(f"offset: full mix leads instrumental by {-lag_im / SR * 1000:.1f} ms")
    if vocal_offset is not None:
        # Vocal time = song time + vocal_offset.
        shift = -vocal_offset
        alignment["vocal"] = {"method": "given", "offsetSeconds": vocal_offset}
    elif mix is not None:
        lag_vm, info = stem_offset(vocal, mix)
        # mix time = vocal time + lag_vm = song time + lag_im, so song time = vocal time + (lag_vm - lag_im).
        shift = (lag_vm - lag_im) / SR
        alignment["vocal"] = {"method": "measured", **{k: (round(float(v), 3) if isinstance(v, (float, np.floating)) else v) for k, v in info.items()}}
        log(f"offset: vocal sits {shift * 1000:+.1f} ms from the instrumental's timeline (applied to the targets)")
    else:
        shift = 0.0
        alignment["vocal"] = {"method": "assumed", "offsetSeconds": 0.0}
        log("offset: no full mix to measure against; assuming the vocal and the instrumental start together (--vocal-offset overrides)")

    # Song time = vocal file time + songOffsetSeconds.
    alignment["vocal"]["songOffsetSeconds"] = round(shift, 4)

    log("pitch tracking (pYIN on the isolated vocal)…")
    midi, sung, present = track_vocal(vocal, gate_db)
    notes, stats = vt.notes_from_contour(midi, sung, vt.Params(hop_s=hop_s))
    present = present | stats["inNote"]
    times = np.arange(len(midi)) * hop_s
    duration = len(inst) / SR

    def on_song(t: float) -> float:
        return t + shift

    out_notes = []
    for nt in notes:
        a, b = max(0.0, on_song(nt.start)), min(duration, on_song(nt.end))
        if b - a >= 0.05:
            out_notes.append({"t": round(a, 3), "d": round(b - a, 3), "m": nt.midi, "c": round(nt.median - nt.midi, 3)})
    phrases = [(max(0.0, on_song(a)), min(duration, on_song(b))) for a, b in xm.phrases_from(stats["voiced"], times, hop_s)]
    phrases = [(a, b) for a, b in phrases if b > a]

    tonic, mode, r = xm.estimate_key(inst)
    bpm, first_beat = xm.estimate_tempo(inst)
    dev = np.array([(nt.median - nt.midi) * 100 for nt in notes]) if notes else np.array([0.0])
    secs = lambda m: round(float(np.count_nonzero(m) * hop_s), 2)  # noqa: E731
    lost = {"unpitched": secs(present & ~stats["voiced"]), **stats["lostSeconds"]}
    scored = round(sum(n["d"] for n in out_notes), 1)

    log(f"tempo estimate: {bpm:.1f} BPM, first beat at {first_beat:.3f} s; key estimate {xm.NAMES[tonic]} {mode} (r={r:.2f})")
    log(f"vocal present {secs(present):.1f} s; pitched {stats['voicedSeconds']:.1f} s; targets {scored:.1f} s in {len(out_notes)} notes, {len(phrases)} phrases")
    log("present but no target (s): " + ", ".join(f"{k} {v:.1f}" for k, v in lost.items()) + f"; octave repairs {stats['octaveRepairSeconds']:.2f} s")
    if out_notes:
        import librosa

        ms = [n["m"] for n in out_notes]
        log(f"range {librosa.midi_to_note(min(ms))} to {librosa.midi_to_note(max(ms))}; median note {np.median([n['d'] for n in out_notes]):.2f} s; mean deviation from equal temperament {dev.mean():+.1f} cents")
    else:
        log("WARNING: no target notes were produced; check that --vocal is the isolated vocal and try a larger --gate-db.")

    if reference_kind == "mix":
        ref_offset = lag_im / SR
    elif reference_kind == "vocal":
        ref_offset = -shift
    else:
        ref_offset = 0.0
    doc = {
        "version": 1,
        "duration": round(duration, 3),
        # Reference track time = song time + referenceOffset (the track song.json names as the reference).
        "referenceOffset": round(ref_offset, 4),
        "key": {"tonic": tonic, "mode": mode},
        "bpm": round(bpm, 2),
        "firstBeat": round(first_beat, 3),
        "tuningCents": round(float(dev.mean()), 1),
        "hop": round(hop_s, 6),
        "notes": out_notes,
        "phrases": [{"t": round(a, 3), "e": round(b, 3)} for a, b in phrases],
        "source": {"kind": "isolated-vocal", "tracker": "pyin", "tool": "tools/prepare_song.py"},
        "analysis": {
            "alignment": alignment,
            "presentSeconds": round(secs(present), 1),
            "scoredSeconds": scored,
            "pitchedSeconds": stats["voicedSeconds"],
            "lostSeconds": lost,
            "octaveRepairSeconds": stats["octaveRepairSeconds"],
        },
    }
    return doc, {"times": times, "midi": midi, "sung": sung, "present": present, "shift": shift}


def write_plot(path: str, doc: dict, plot: dict) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    t = plot["times"] + plot["shift"]
    fig, ax = plt.subplots(figsize=(22, 7))
    ax.plot(t, np.where(plot["sung"], plot["midi"], np.nan), ".", ms=1.5, color="#5ee0ff", label="pYIN (sung frames)")
    for n in doc["notes"]:
        ax.plot([n["t"], n["t"] + n["d"]], [n["m"], n["m"]], color="#22aa66", lw=3, solid_capstyle="butt")
    for p in doc["phrases"]:
        ax.axvspan(p["t"], p["e"], color="#a08cff", alpha=0.12)
    ax.set_xlabel("song time (s)")
    ax.set_ylabel("MIDI note")
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(path, dpi=90)
    log(f"wrote {path}")


# ---------------------------------------------------------------- main


def read_json(path: str) -> object | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None


def write_json(path: str, doc: object, compact: bool = False) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        if compact:
            json.dump(doc, fh, separators=(",", ":"), ensure_ascii=False)
        else:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")


def report_timing(folder: str, files: dict, duration: float | None) -> None:
    lyrics_path = os.path.join(folder, files["lyrics"])
    lines = None
    if os.path.exists(lyrics_path):
        with open(lyrics_path, encoding="utf-8-sig") as fh:
            lines = lyric_lines(fh.read())
        log(f"lyrics: {len(lines)} lyric lines in {files['lyrics']} (hash {hash_lines(lines)})")
    else:
        log(f"lyrics: {files['lyrics']} not found; the song will play without lyrics")
    timing_path = os.path.join(folder, files["timing"])
    try:
        timing = read_json(timing_path)
    except json.JSONDecodeError as e:
        log(f"timing: {files['timing']} is not valid JSON ({e}); NOT usable")
        return
    if timing is None:
        log(f"timing: no {files['timing']} yet. Make it in the app: Settings > Sync lyrics > Save timing, then put the downloaded file in {folder}/")
        return
    usable, msgs = check_timing(timing, lines, duration)
    log(f"timing: {files['timing']} is " + ("usable as is" if usable else "NOT usable as is") + " (left unchanged)")
    for m in msgs:
        log(f"  - {m}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="song folder, e.g. public/songs/love-yourself")
    ap.add_argument("--title")
    ap.add_argument("--artist")
    ap.add_argument("--instrumental", help="file name of the track you sing over")
    ap.add_argument("--vocal", help="file name of the isolated lead vocal")
    ap.add_argument("--mix", help="file name of the full mix (optional)")
    ap.add_argument("--lyrics", help="file name of the lyrics text (default lyrics.txt)")
    ap.add_argument("--reference", choices=("mix", "vocal", "none"), help="what the Reference vocal toggle plays (default: the full mix if there is one, else the isolated vocal)")
    ap.add_argument("--vocal-offset", type=float, help="seconds by which the vocal file lags the instrumental (vocal time = song time + offset); skips measuring")
    ap.add_argument("--gate-db", type=float, default=35.0, help="how far below the vocal's loud level still counts as singing (default 35)")
    ap.add_argument("--plot", help="write a PNG of the contour and the target notes (needs matplotlib)")
    ap.add_argument("--vocal-wav", help="also write the decoded vocal as a mono WAV (input for tests/referenceVocal.test.ts)")
    ap.add_argument("--no-register", action="store_true", help="do not add the song to songs/index.json")
    ap.add_argument("--check-only", action="store_true", help="only check lyrics.txt and timing.json; write nothing")
    args = ap.parse_args(argv)

    folder = os.path.normpath(args.folder)
    if not os.path.isdir(folder):
        raise SystemExit(f"{folder} is not a folder.")
    song_id = os.path.basename(folder)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", song_id):
        raise SystemExit(f"The folder name is the song id; use lowercase letters, digits and dashes (got \"{song_id}\").")
    song_path = os.path.join(folder, "song.json")
    existing = read_json(song_path)
    if existing is not None and not isinstance(existing, dict):
        raise SystemExit(f"{song_path} is not a JSON object.")

    if args.check_only:
        prior = (existing or {}).get("files", {})
        files = {"lyrics": os.path.basename(args.lyrics) if args.lyrics else prior.get("lyrics", "lyrics.txt"), "timing": prior.get("timing", "timing.json")}
        melody = read_json(os.path.join(folder, prior.get("melody", "melody.json")))
        report_timing(folder, files, melody.get("duration") if isinstance(melody, dict) else None)
        return 0

    files = resolve_files(folder, existing, args)
    reference_kind = args.reference or (existing or {}).get("referenceKind") or ("mix" if files["mix"] else "vocal")
    if reference_kind == "mix" and not files["mix"]:
        raise SystemExit("--reference mix needs a full mix file (--mix).")
    log(f"song {song_id}: instrumental \"{files['instrumental']}\", vocal \"{files['vocal']}\", full mix " + (f"\"{files['mix']}\"" if files["mix"] else "none"))

    log("decoding…")
    inst = xm.load_mono(os.path.join(folder, files["instrumental"]))
    vocal = xm.load_mono(os.path.join(folder, files["vocal"]))
    mix = xm.load_mono(os.path.join(folder, files["mix"])) if files["mix"] else None
    log(f"instrumental {len(inst) / SR:.2f} s, vocal {len(vocal) / SR:.2f} s" + (f", full mix {len(mix) / SR:.2f} s" if mix is not None else ""))

    if args.vocal_wav:
        import soundfile as sf

        sf.write(args.vocal_wav, vocal, SR, subtype="PCM_16")
        log(f"wrote {args.vocal_wav}")

    doc, plot = analyze(inst, vocal, mix, reference_kind, args.vocal_offset, args.gate_db)
    sig = hashlib.sha1()
    for role in ("instrumental", "vocal", "mix"):
        if files[role]:
            with open(os.path.join(folder, files[role]), "rb") as fh:
                sig.update(hashlib.sha1(fh.read()).digest())
    doc["sources"] = sig.hexdigest()[:12]
    melody_path = os.path.join(folder, files["melody"])
    write_json(melody_path, doc, compact=True)
    log(f"wrote {melody_path} ({len(doc['notes'])} notes)")

    song = dict(existing or {})
    song.update({
        "version": 1,
        "id": song_id,
        "title": args.title or song.get("title") or title_from_id(song_id),
        "artist": args.artist if args.artist is not None else song.get("artist", ""),
        "files": {
            "instrumental": files["instrumental"],
            **({"reference": files["mix"] if reference_kind == "mix" else files["vocal"]} if reference_kind != "none" else {}),
            "vocal": files["vocal"],
            "lyrics": files["lyrics"],
            "timing": files["timing"],
            "melody": files["melody"],
        },
        "referenceKind": reference_kind,
        "targets": {"source": "isolated-vocal"},
    })
    write_json(song_path, song)
    log(f"wrote {song_path}")

    if not args.no_register:
        index_path = os.path.join(os.path.dirname(folder), "index.json")
        index = read_json(index_path) or {"version": 1, "songs": []}
        if not isinstance(index, dict) or not isinstance(index.get("songs"), list):
            raise SystemExit(f"{index_path} is not a song index.")
        if song_id not in index["songs"]:
            index["songs"].append(song_id)
            write_json(index_path, index)
            log(f"registered {song_id} in {index_path}")
        else:
            log(f"{song_id} is already registered in {index_path}")

    report_timing(folder, files, doc["duration"])
    if args.plot:
        write_plot(args.plot, doc, plot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
