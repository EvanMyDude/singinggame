#!/usr/bin/env python3
"""
Decode a song folder's stems exactly as tools/prepare_song.py does, for the browser parity
check (tests/browserParity.test.ts). Writes mono float32 WAVs at 22,050 Hz and a small
description; changes nothing in the song folder.

    python3 tools/decode_song.py public/songs/<id> work/parity/<id>

The files are found the way prepare_song finds them (song.json, then names). The decoded
audio is derived from the recordings: keep it out of git (work/ is ignored).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract_melody as xm  # noqa: E402
import prepare_song as ps  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", help="song folder, e.g. public/songs/love-yourself")
    ap.add_argument("out", help="directory for the decoded WAVs")
    args = ap.parse_args(argv)

    import soundfile as sf

    folder = os.path.normpath(args.folder)
    existing = ps.read_json(os.path.join(folder, "song.json"))
    if not isinstance(existing, dict):
        raise SystemExit(f"{folder} has no song.json; run prepare-song on it first.")
    files = ps.resolve_files(folder, existing, argparse.Namespace(instrumental=None, vocal=None, mix=None, lyrics=None))
    reference_kind = existing.get("referenceKind") or ("mix" if files["mix"] else "vocal")
    os.makedirs(args.out, exist_ok=True)
    written = {}
    for role in ("instrumental", "vocal", "mix"):
        if not files[role]:
            continue
        y = xm.load_mono(os.path.join(folder, files[role]))
        path = os.path.join(args.out, f"{role}.wav")
        sf.write(path, y, xm.SR, subtype="FLOAT")
        written[role] = files[role]
        ps.log(f"{role}: {files[role]} -> {path} ({len(y) / xm.SR:.2f} s)")
    with open(os.path.join(args.out, "decoded.json"), "w", encoding="utf-8") as fh:
        json.dump({"song": os.path.basename(folder), "referenceKind": reference_kind, "files": written, "sr": xm.SR}, fh, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
