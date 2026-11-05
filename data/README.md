# BipWatch open data

The public record behind bipwatch.com. Released under CC0: copy it, fork it, build on it.

This folder is meant to stand on its own and will move to its own repository once the pipeline writes to it.

## Layout

```
schemas/                 JSON Schemas (draft 2020-12) for every file below
bips/<NNNN>/bip.yaml     spec header facts + BipWatch classification
bips/<NNNN>/claims/*.yaml   one sourced claim per file
bips/<NNNN>/needs.yaml   0-5 needs assessment, citing claim ids
```

One claim per file keeps pull requests small and conflict-free when many are opened at once.

## Rules every claim follows

- `statement` is our reading, in our words. `source.quote` is the proof, copied verbatim and kept short.
- Spec sources cite the exact `revision` of bitcoin/bips. CI checks each quote against that revision.
- `provenance.extracted_by` says who or what wrote it (`human:<handle>` or `model:<id>`).
- `provenance.reviewed_by` stays `null` until a person approves it. The site shows unreviewed claims as pending.
- Aggregator and press sources are allowed but flagged as secondary on the site. Replace them with primary sources when possible.
