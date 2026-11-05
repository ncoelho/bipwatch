# BipWatch

An open layer for Bitcoin development and Bitcoin Improvement Proposals: data, metadata and evidence on top of the BIP repository, rendered as a static site.

Git holds the truth (`data/`), the site is a static render of it (`site/`). Collectors, Postgres and LLM extraction come next and will write to `data/` through pull requests.

The full product and technical spec, including decisions and next work, is in [`docs/SPEC.md`](docs/SPEC.md).

## Repo

```
data/            the open data layer (CC0); see data/README.md
packages/data/   TypeScript loader + validator for data/
packages/collect/ collectors, Postgres archive and BIP-mention index
site/            Astro site: BIP pages and a static JSON API
.github/         CI: validate on every PR, build on main + nightly
```

## Commands

```sh
nvm use                                # Node from .nvmrc (Astro needs >=22.23.4)
npm install
npm run validate                       # schema and consistency checks
npm run validate -- --bips ../bips     # also match spec quotes against a clone of bitcoin/bips
npm run dev                            # local site at http://localhost:4321
npm run build                          # validate, then build site/dist
npm test                               # unit tests (collectors, mention index)
neon env pull                          # Neon DATABASE_URL(_UNPOOLED) into .env.local (after `neon login`)
npm run migrate                        # apply SQL migrations to Neon (uses the unpooled URL)
npm run test:db --workspace @bipwatch/collect   # runner + migrations against Neon, in a throwaway schema
npm run collect -- --source bips-repo  # run one collector (bips-repo, delving, mailing-list, github), or --all
npm run sync-headers -- --bips ../bips # re-sync bip.yaml facts from spec headers (--dry-run to preview)
```

Collectors read `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (migrations) and `GITHUB_TOKEN` (locally: `export GITHUB_TOKEN=$(gh auth token)`) from the environment, `.env.local` (written by `neon env pull`) or `.env` (see `.env.example`). `neon.ts` declares the Neon project config.

To check spec quotes locally, clone bitcoin/bips next to this repo:

```sh
git clone --filter=blob:none --no-checkout https://github.com/bitcoin/bips.git ../bips
```

## What the build produces

- `/` tracked proposals and the rest of the dataset
- `/bip/<n>/` one page per BIP, rendered with its stage template (only `complete` exists so far)
- `/api/bips.json` and `/api/bips/<n>.json` the same data the pages use

## Adding a claim by hand

1. Create `data/bips/<NNNN>/claims/<id>.yaml`, with the filename matching `id`.
2. Fill `source` with a URL and a short verbatim quote. For spec sources, add the bitcoin/bips commit as `revision`.
3. Run `npm run validate -- --bips ../bips` and open a pull request.

## Status

- [x] Data schemas and validator
- [x] BIP 352 hand-filled record (18 claims, needs assessment, pending review)
- [x] Static site and JSON API
- [ ] Collectors for the BIP repo, GitHub, Delving Bitcoin and the mailing list
- [ ] LLM extractors behind a pull-request review queue
- [ ] Chain and network series for consensus BIPs
- [ ] Signed contribution intake

## Licence

Code is MIT (see `LICENSE`). Everything under `data/` is CC0.
