# BipWatch

An open layer for Bitcoin development and Bitcoin Improvement Proposals: data, metadata and evidence on top of the BIP repository, rendered as a static site.

Git holds the truth (`data/`), Postgres holds the work (an archive of the discussion around the BIPs), and the site is a static render of `data/`. Everything public has a source and a verbatim quote, and nothing a machine proposes reaches `data/` without a person merging it.

The full product and technical spec, with decisions and next work, is in [`docs/SPEC.md`](docs/SPEC.md).

## How it works

```
bitcoin/bips · GitHub · Delving Bitcoin · bitcoin-dev list
        │  collectors (scheduled GitHub Actions)
        ▼
Neon Postgres: raw archive, documents, BIP-mention index, extraction log
        │  LLM extractors (Claude API), validated against the archive
        ▼
data/  YAML claims with reviewed_by: null  ──  a person reviews and merges
        │
        ▼
site/  static pages + JSON API
```

- **Collectors** archive every source in full, not only threads about tracked BIPs, and tag each document with the BIPs it mentions (by number, by link to the spec or its pull requests, and by alias for tracked BIPs).
- **Header sync** keeps each `bip.yaml` in step with its spec header and opens a pull request that merges itself once CI passes.
- **Extractors** read archived documents about a tracked BIP and propose claims. Code, not the model, decides who a claim is about and which spec version it applies to, and every quote must match the archived text.
- **Review** is a person setting `provenance.reviewed_by` in a pull request. Until then the site marks a claim as pending.

## Where we are (2026-11-06)

**Live**
- Archive in Neon: the whole bitcoin-dev list since 2011 (~24.7k messages), every public Delving Bitcoin post (~4.9k), every bitcoin/bips pull request, review and comment (~24k), and the bitcoin/bips commits for BIPs we hold records for (~100). About 270 BIP numbers are indexed across it.
- Collectors on schedule: `bips-repo` every 30 min, `delving` every 30 min, `github` and `mailing-list` hourly. A freshness check runs hourly and fails (GitHub emails the owner) when a source falls behind.
- Header sync: proven end to end (bitcoin/bips bumped BIP 375 to 0.1.3; the bot opened #2 and it merged itself after `validate`).
- Tracking a new BIP uses its whole history: mentions are re-tagged when aliases change, its full commit history is collected, and extraction starts from the beginning of the archive for it.

**In progress**
- BIP 352 is the one tracked BIP, with 18 hand-written claims, 106 extracted stances and a needs assessment, all pending review.
- LLM extraction (SPEC 6.2): the `stance` task (v2) ran over the ~1,580 archived documents about BIP 352 and its stances were merged (#3, #5), all pending review. A daily workflow that opens one pull request per tracked BIP with new stances is built and switched off (see Extraction below). Each is scoped to the proposal, one change to its text, or an implementation, so an ACK of an amendment is not shown as support for the BIP. The BIP 352 page shows them under "Who has taken a position". The pull-request bot that opens such PRs on its own is not built yet.

**Not started**
- Deployment is on hold until the project is ready. The deploy step exists but is switched off (see Deployment below).
- The other initial BIPs (353, 54, 448, and two still to choose).
- Stage templates other than `complete`, and the rest of the consensus signaling module (stakeholder groups, coverage, signed attestations).
- Chain and network series for consensus BIPs; signed contribution intake.

## Repo

```
data/              the open data layer (CC0); see data/README.md
  bips/<NNNN>/       bip.yaml, claims/*.yaml, needs.yaml
  people.yaml        one identity per person with several names or logins
  schemas/           JSON Schemas for all of the above
packages/data/     TypeScript loader + validator for data/
packages/collect/  collectors, Postgres migrations, mention index, header sync, freshness
packages/extract/  LLM extractors that propose claims (stance so far)
site/              Astro site: BIP pages, a Sources section, static JSON API
docs/SPEC.md       product and technical spec
.github/workflows/ validate (every PR, required on main), build, one per collector,
                   freshness, reindex-mentions
```

## Setup

```sh
nvm use                                # Node 22.23.4 from .nvmrc (Astro needs >=22.23.4)
npm install
git clone --filter=blob:none --no-checkout https://github.com/bitcoin/bips.git ../bips
```

Credentials, all git-ignored:

| What | Where | Used by |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | `.env.local`, written by `neon env pull` after `neon login` | collectors, migrations, freshness, extraction |
| `ANTHROPIC_API_KEY` | `.env.anthropic` (owner-only; not touched by `neon env pull`) | extraction only |
| `GITHUB_TOKEN` | `export GITHUB_TOKEN=$(gh auth token)` | the `github` collector |

In CI the repository has these secrets: `DATABASE_URL` and `BOT_TOKEN` (a fine-grained token the header-sync bot opens pull requests with, so `validate` runs on them and auto-merge works). Deployment will add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. A ruleset on `main` requires `validate`; repository admins can bypass it.

npm is pinned to 11.21.1 (`packageManager` in `package.json`; Node 22's bundled npm 10 crashes resolving vitest 4's peer dependencies). Every workflow sets up Node and npm through `.github/actions/setup`.

## Deployment

**On hold:** the project is not ready to be published. `build.yml` builds the site on every push to `main` and nightly; its deploy step is switched off.

The deploy step uploads `site/dist` to Cloudflare Pages (project `bipwatch`, created on the first deploy) with `wrangler`. To switch it on:

1. Add the repository secret `CLOUDFLARE_ACCOUNT_ID`: shown in the Cloudflare dashboard (Workers & Pages, right-hand column).
2. Add the repository secret `CLOUDFLARE_API_TOKEN`: My Profile → API Tokens → Create token → custom token with **Account · Cloudflare Pages · Edit**, limited to that account.
3. Add the repository variable `DEPLOY_ENABLED` with the value `true` (Settings → Secrets and variables → Actions → Variables). Without it nothing is published, even with the secrets in place; with it, missing secrets fail the build.
4. Consider building every few hours instead of nightly, so the Sources section stays current on the live site.

The site is then at `https://bipwatch.pages.dev`. For `bipwatch.com`, add it as a custom domain on the Pages project (Workers & Pages → bipwatch → Custom domains); Cloudflare sets the DNS record if the domain's DNS is on Cloudflare.

## Commands

Data and site:

```sh
npm run validate -- --bips ../bips     # schemas, consistency, spec quotes at their cited revision
npm run dev                            # local site at http://localhost:4321
npm run build                          # validate, then build site/dist
# Both refresh data/freshness.json (the Sources section) first when a
# database is configured and reachable; otherwise they keep the old snapshot.
npm test                               # unit tests
```

Archive (needs the database):

```sh
npm run migrate                        # apply SQL migrations
npm run collect -- --source delving    # one collector (bips-repo, github, delving, mailing-list) or --all
npm run sync-headers -- --bips ../bips # re-sync bip.yaml facts from spec headers (--dry-run to preview)
npm run freshness                      # fail if a source is overdue; --export data/freshness.json for the site
npm run reindex-mentions -- --if-changed   # re-tag the archive after a BIP's aliases or tracking change
npm run test:db --workspace @bipwatch/collect   # tests against Neon, in a throwaway schema
```

Extraction (spends Claude API tokens; try `--dry-run` with a small `--limit` first):

```sh
npm run extract -- --task stance --bip 352 --limit 20 --dry-run
npm run extract -- --task stance --bip 352 --limit 200 --budget 600000
```

Each run is per BIP and resumes where that BIP's last run stopped. A dry run writes no files and does not move the cursor; `--source` and `--doc` pick a sample for it. `--summary <file>` writes a pull request description for the claims written.

## Extraction

`.github/workflows/extract.yml` runs the stance extractor every day for each tracked BIP and opens one pull request per BIP with the claims it proposed (labelled `claims`, never merged automatically). It is **off**. To switch it on (Settings → Secrets and variables → Actions):

1. Secret `ANTHROPIC_API_KEY`: a Claude API key, ideally a dedicated one with a spend limit in the Anthropic Console.
2. Variable `EXTRACT_ENABLED` = `true`.
3. Optional variables: `EXTRACT_BUDGET_TOKENS` (per BIP per run, default 300000, about $1.30) and `EXTRACT_LIMIT_DOCS` (default 200).

A newly tracked BIP starts from the beginning of the archive, so its first days spend up to the budget each day until it catches up. "Run workflow" on the Actions tab runs it on demand, optionally for one BIP.

## What the build produces

- `/` tracked proposals, the rest of the dataset, and when each source was last collected
- `/bip/<n>/` one page per BIP, rendered with its stage template (only `complete` exists so far)
- `/api/bips.json` and `/api/bips/<n>.json` the same data the pages use
- `/api/freshness.json` when each source last succeeded and how much it holds (empty when built without a database)

## Reviewing claims

A claim is reviewed when a person sets `provenance.reviewed_by` to their handle and `provenance.reviewed` to the date, in a pull request. Before that:

1. Open `source.url` and find `source.quote` there, word for word.
2. Check that `statement` is a fair reading of the quote, not stronger than it.
3. For stances, check `scope`: an ACK on a pull request that amends the BIP is `change`, not `proposal`.
4. Fix or delete the claim in the same pull request if it is wrong.

## Tracking a new BIP

1. Add `data/bips/<NNNN>/bip.yaml` with `tracked: true`, its category, template and `aliases` (names people use for it), and merge it.
2. The `reindex-mentions` workflow re-tags the archive with the new aliases, and the next `bips-repo` run collects its full commit history.
3. Run extraction with `--bip <NNNN>` (estimate the cost first from how many documents mention it).

## Adding a claim by hand

1. Create `data/bips/<NNNN>/claims/<id>.yaml`, with the filename matching `id`.
2. Fill `source` with a URL and a short verbatim quote. For spec sources, add the bitcoin/bips commit as `revision`.
3. Run `npm run validate -- --bips ../bips` and open a pull request.

## Status

- [x] Data schemas and validator
- [x] BIP 352 hand-filled record (18 claims, needs assessment, pending review)
- [x] Static site and JSON API
- [x] Collectors for the BIP repo, GitHub, Delving Bitcoin and the mailing list, with mention index and freshness monitor
- [x] Header sync with self-merging pull requests
- [ ] LLM extractors behind a pull-request review queue (stance task and daily PR bot built; bot switched off; other tasks not yet)
- [ ] Review of the BIP 352 claims
- [ ] Deployment (workflow ready, on hold until the project is ready)
- [ ] Seed the focus BIPs: 54, 448, 360, 77, 353 + 321 (352 is done)
- [ ] Chain and network series for consensus BIPs
- [ ] Signed contribution intake

## Licence

Code is MIT (see `LICENSE`). Everything under `data/` is CC0.
