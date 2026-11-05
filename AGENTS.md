# Instructions for coding agents

Read `docs/SPEC.md` before making changes. It explains what BipWatch is, the decisions already made, the data model, and the next work with acceptance criteria (section 6).

## Rules

- Run `npm run validate -- --bips ../bips` before committing anything under `data/` or `packages/data/`. If `../bips` is missing, clone it: `git clone --filter=blob:none --no-checkout https://github.com/bitcoin/bips.git ../bips`.
- Every claim needs a source URL and, for prose kinds, a short verbatim `quote`. Never invent or reword a quote.
- Machine-written claims keep `provenance.reviewed_by: null`. Only a person sets a reviewer.
- One claim per file; the filename equals the claim `id`.
- Schema changes update the JSON Schema, `packages/data/src/types.ts`, the validator and existing data in one commit.
- Code does what code can do. LLMs are only for reading prose, and their output goes through the validator and a pull request.
- Keep CI on `main` green. Prefer small commits.
- Ask the owner before choosing paid services or hosting (Postgres host, deploy target).
