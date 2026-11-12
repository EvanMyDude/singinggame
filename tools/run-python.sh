#!/bin/sh
# Runs a Python tool with the project's virtualenv when there is one (make song-tools),
# otherwise with the system python3.
if [ -x .venv/bin/python ]; then exec .venv/bin/python "$@"; fi
exec python3 "$@"
