# Extraction evidence: recorded 175-note run

Evidence record ID: `old-town-road-recorded-2026-11-10-175`.
Status: **unverified recorded run; reproduction and original artifact remain open**.
This is a record of earlier documentation, not a diagnostic output generated in this patch.

## Provenance and missing identity

The source is section 4 of the design assessment as committed at
[`38c339f7ec48e29acc61f1d2ed8cb7d3e9247d01`](https://github.com/EvanMyDude/singinggame/blob/38c339f7ec48e29acc61f1d2ed8cb7d3e9247d01/docs/superpowers/specs/2026-11-08-pitch-hero-design.md).
Review of the repository checkout and its complete available Git history found no derived
JSON or run log for this diagnostic run. The source MP3s and residual WAV are also absent
from this checkout. No private browser data was read, and no audio rerun or listening check
was performed for this patch.

| Identity field | Evidence available |
| --- | --- |
| Reported run date | 2026-11-10; exact time and timezone not retained |
| Source signature | `594c7e902d9a`, reported by the assessment; not rechecked against audio |
| Signature algorithm | First 12 hex characters of SHA-1 over the concatenated binary SHA-1 digests of instrumental then reference, as implemented in the extractor |
| Extractor commit / local diff | Missing; the documentation commit is not proof of the executed extractor revision |
| Exact invocation and parameters | Missing; defaults must not be assumed to establish the command used |
| Python / dependency / libsndfile versions | Missing |
| Output note count | 175, reported in the assessment; output unavailable |
| Output SHA-256 | Missing; original derived JSON unavailable |
| Per-gap category data / run log | Missing; no reconstruction attempted |

## Figures previously recorded

These rounded values are preserved only for traceability to the source assessment. They are
not independently verified measurements and do not establish the deployed pack's rejection
breakdown. The assessment described approximately 48.5 s of detected reference-vocal time
without targets. The rounded categories below sum to 48.6 s; finer precision is unavailable.

| Measured category named in the assessment | Recorded seconds, unverified |
| --- | ---: |
| `pyinUnvoiced` | 18.1 |
| `trackersDisagree.other` | 13.7 |
| `trackersDisagree.octave` | 8.9 |
| `tooShort` | 6.2 |
| `trackersDisagree.near` | 1.4 |
| `unstable` | 0.3 |

The source assessment also asserted that length and stability gates rejected at most 0.1 s
each in the eight longest gaps, and octave disagreement contributed 0.1 to 1.1 s in each verse
gap. Without per-gap JSON those statements cannot be independently checked. They are not
used as a basis for target changes. The recorded difference from 174 to 175 notes has no
verified cause; library version differences were suggested, not demonstrated.

These are rejection categories in an estimated reference-vocal presence mask, not verified
vocal causes. Unvoiced pYIN does not prove unusable lead-vocal pitch. Octave disagreement does
not establish pitch class or which tracker is correct. Near disagreement does not establish
a slide. Neither the totals nor these labels prove which material could be recovered.

## Deployed pack remains a separate basis

The committed [melody.json](../../public/songs/old-town-road/melody.json) at the reviewed
commit has 174 notes and source signature `594c7e902d9a`. Its stored analysis contains
`presentSeconds: 91.7`, `scoredSeconds: 43.3`, `unstableDropped: 2`, and alignment metadata;
it does not contain `lostSeconds`, `disagreeSeconds` or per-gap diagnostics.
Its file SHA-256 is
`b9c6b01ceea3299f5422cb2339059840e2086dd1a49ae268fa43bb372ab9bb2a`.
These facts were read from the committed file, not inferred from the unavailable run.
The feedback patch does not overwrite the file or expand its target set.

## Closing the evidence gap

Follow the [separate-output reproduction procedure](../SONG_PACK.md#old-town-road).
Retain the generated derived report with its complete run identity, output hash and exact
versions. Link numerical diagnostic claims to that report. Keep audio, residual audio,
private lyrics and personal paths out of committed evidence. A replacement run can confirm
its own output, but cannot retroactively supply the missing identity of this recorded run.
