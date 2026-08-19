# Capybara Arena

Capybara Arena is a public CAD grading game for Cadybara-generated models. It
shows two STL models, lets a visitor choose the better model or mark the pair as
a tie, and stores append-only preference data in private Vercel Blob objects for
export and offline analysis.

The public dataset contains 94 renderable hosted Cadybara outputs, balanced
across three object categories:

- 30 wall-planter models
- 31 wall-hook models
- 33 snowman models

`GET /api/battle` sends only what a voter needs to judge a pair: id, family,
title, and the STL and preview URLs. The validator's own verdict on each model
(whether it passed, how confident it was, and its prose description of the spec)
is stripped before the pair goes out, so nobody is shown the grader's opinion of
what they are about to rate. That metadata is still in `public/data/items.json`
for offline analysis; it is just not in front of the voter. Raw generation
prompts are in neither place.

## Production Checklist

1. Import `https://github.com/aarohkandy/cad_grade` into Vercel.
2. Keep Vercel's root directory at the repository root.
3. Create or attach a Vercel Blob store to the project.
4. Add the production environment variables below for Production, Preview, and
   Development unless you intentionally want Preview isolated.
5. Make sure `LOCAL_VOTE_DIR` is not set in Vercel.
6. Deploy from the GitHub `main` branch.
7. Open `/api/health` and confirm:
   - `ready: true`
   - `storage: "ok"`
   - `storageMode: "blob"`
   - `missingEnv: []`
8. Run the production checker:

```bash
npm run check:production -- \
  --url https://YOUR_DEPLOYMENT
```

9. Open `/api/battle` and confirm it returns two automatically selected items.
10. Share the Vercel URL.
11. Pull votes through `/api/export` or `npm run pull:votes`.
12. Keep periodic JSONL exports outside git for analysis/backups.

Do not put production secrets in GitHub. GitHub contains the app, assets, API
routes, CI, and Vercel project config; Vercel owns the secret values and Blob
store connection.

## GitHub And Vercel

This repo is set up for Vercel GitHub deploys:

- `vercel.json` sets `npm ci`, `npm run build`, `dist`, clean URLs, cache
  headers for public dataset assets, and basic browser security headers.
- API routes live in `api/*.ts` and are deployed as Vercel Functions.
- Static assets and the public dataset live under `public/`.
- `.github/workflows/ci.yml` runs the formatting check, dataset validation,
  tests, and the production build on pushes and pull requests.
- `npm run check:production` verifies that the deployed URL is actually ready
  for public traffic.

The only required manual Vercel pieces are the Blob store attachment and the
four environment variables below.

## Environment

Set these in Vercel Project Settings -> Environment Variables:

```text
BLOB_READ_WRITE_TOKEN
IP_HASH_SALT
HOLD_VERIFY_SECRET
PRUNE_SECRET
```

`BLOB_READ_WRITE_TOKEN` is created when Vercel Blob is attached.
`IP_HASH_SALT` and `HOLD_VERIFY_SECRET` can be any long random secrets.

`PRUNE_SECRET` guards `POST /api/prune-votes`, the one route that deletes stored
votes. Leave it unset and the route refuses every request; set it and any caller
has to send the same value in an `x-prune-secret` header. Generate it the same
way as the other secrets.

Generate local secret values with Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For local serverless API testing, `LOCAL_VOTE_DIR` can point at a private local
folder. Do not set `LOCAL_VOTE_DIR` in Vercel production.

## Local Setup

```bash
npm install
npm run test
npm run build
npm run dev
```

The dataset is committed, so there is nothing to generate on a fresh clone.
`npm run check:dataset` verifies that every item in the manifest has its STL and
preview on disk. It also pins the launch counts (94 items, 30/31/33), so it is
expected to fail against a dataset rebuilt from a different set of runs.
`npm run dataset` rebuilds the manifest from the private Cadybara run tree and
refuses to run without it; if you do have that tree, point at the directory
containing `projects/`:

```bash
npm run dataset -- --sources-root ../path/to/parent
```

`npm run dev` starts the Vite frontend and local API middleware on
`http://127.0.0.1:5173`. Local API votes are written to the ignored
`.local-data/blob` folder by default.

To match Vercel's runtime locally, set `LOCAL_VOTE_DIR` before starting the
server.

PowerShell example:

```powershell
$env:LOCAL_VOTE_DIR=".local-data/blob"
$env:IP_HASH_SALT="local-hash-salt"
$env:HOLD_VERIFY_SECRET="local-hold-secret"
npm run dev
```

`npm run test` is the unit and API suite and needs nothing extra. The browser
tests are separate: `npm run playwright:test` serves the built `dist` with
`vite preview` and drives the arena in Chromium at desktop and phone sizes, so
run `npm run build` first, and `npx playwright install chromium` once on a new
machine.

## Data Storage

No Supabase database is required.

Every vote is written as one private JSON object:

```text
votes/v1/YYYY-MM-DD/<timestamp>_<vote-id>.json
```

The API also writes private session-pair marker objects to reduce repeat voting
from the same browser session. Public stats come from a best-effort summary
object at `derived/v1/stats-summary.json`. The summary can be slightly stale
under high concurrency; raw vote blobs are the source of truth.

The app stores salted IP and user-agent hashes, not raw IP addresses or raw
user agents. Internal Elo-like scoring is private and derived from accepted
votes.

## Local Backups And Analysis

For production, local backup files under `exports/live-backups/` are the durable
source of truth. Vercel Blob is the live collection buffer.

Pull all raw vote blobs, save local snapshots, update daily deduped JSONL files,
run analysis, and safely prune already-backed-up raw vote blobs older than the
current UTC hour:

```bash
npm run backup:live -- \
  --url https://cadbattle.vercel.app \
  --out exports/live-backups \
  --prune completed-hour
```

The backup command never deletes `derived/v1/stats-summary.json`,
`session-pairs/v1/*`, current-hour votes, or anything outside `votes/v1/`.
Deletion only happens after the snapshot and daily JSONL files verify.

To rebuild the boss/team analysis dashboard from local backups:

```bash
npm run process:data
```

Outputs:

- `exports/analysis/latest/index.html`
- `exports/analysis/latest/summary.md`
- CSV and JSON files for items, pairs, sessions, coverage gaps, anomalies, and
  raw-vs-clean rankings

`npm run process:data` needs at least one backup snapshot under
`exports/live-backups/`, so run `npm run backup:live` first (or pass
`--in <dir>`). With none it exits 1 and says so rather than writing an analysis
of zero votes, which reads exactly like a real analysis of an arena nobody
voted in.

To browse those outputs with the Elo trend graphs:

```bash
npm run serve:trends
```

That serves `exports/analysis/latest` on `http://127.0.0.1:5175`
(`ANALYSIS_PORT` and `ANALYSIS_HOST` override it). It needs
`npm run process:data` to have run first and exits 1 naming it if not.

Install the hourly macOS backup task:

```bash
npm run backup:install-hourly
```

Remove it:

```bash
npm run backup:uninstall-hourly
```

The macOS task uses `launchd`, runs once an hour, writes logs under
`exports/live-backups/logs`, pulls from `https://cadbattle.vercel.app`, rebuilds
analysis, and prunes completed-hour raw vote blobs from Vercel Blob only after
they exist in both the timestamped local snapshot and the local daily archive.

The normal path prunes directly with `BLOB_READ_WRITE_TOKEN`. If the Blob
listing fails the backup falls back to `/api/export` and asks the deployed app
to delete only those verified old raw vote paths. That fallback needs
`PRUNE_SECRET` in the local `.env.local`, matching the value set in Vercel.
Without it the run still writes its snapshot and rebuilds analysis, then exits 1
with the prune recorded as failed in `prune-manifest.json`. The blobs stay put
rather than being silently skipped.

Windows scheduled task helpers are still available as
`backup:install-hourly:windows` and `backup:uninstall-hourly:windows`.

Before sharing widely, run a browser-level production vote and confirm it lands
locally:

```bash
npm run backup:test-click
```

## Battle Selection

Visitors do not choose a model family. The server selects global battles across
all active models automatically so the data stays useful:

- prioritize under-sampled items
- avoid pairs already seen by the current browser session when possible
- avoid over-repeating the same pair
- prefer closer Elo matchups once both items have enough scoring history
- add a small random jitter so the queue does not feel repetitive

Items without live votes still receive deterministic starting Elo estimates from
their validation metadata, specificity, generation attempt, latency, prompt
label, and source hash. Live votes then move those ratings normally.

`GET /api/battle?family=wall_planter`, `wall_hook`, or `snowman` remains
available as a debug filter for same-family battles.

## Export

Export is intentionally unlisted but not locked behind login. Anyone who knows
the endpoint can pull it, so do not link it in the UI.

```bash
curl "https://YOUR_DEPLOYMENT/api/export?format=json"
```

Limit to one day when pulling often:

```bash
curl "https://YOUR_DEPLOYMENT/api/export?format=json&date=2026-06-12"
```

`date` has to be `YYYY-MM-DD` and `limit` a positive whole number; anything else
is a `400` (`invalid_date` / `invalid_limit`) rather than a 500. Leaving either
one off, or passing it empty, means "no date filter" and the 10,000 default.

The JSON body also carries `unreadableCount`: stored records that would not parse
and were skipped, so one damaged object degrades a pull instead of failing it.
Non-zero means something in the store needs a human; the path is in the function
log. The CSV format has nowhere to put that field and does not report it.

CSV export supports `table=votes`, `table=item_stats`, `table=pair_stats`, or
`table=quality_flags`:

```bash
curl "https://YOUR_DEPLOYMENT/api/export?format=csv&table=votes" \
  > votes.csv
```

The pull helper writes JSONL:

```bash
npm run pull:votes -- \
  --url https://YOUR_DEPLOYMENT \
  --date 2026-06-12 \
  --out exports/votes-2026-06-12.jsonl
```

For launch/testing sessions, pull a full timestamped snapshot:

```bash
npm run pull:data -- \
  --url https://YOUR_DEPLOYMENT \
  --out exports/vercel-test
```

That writes `health.json`, `stats.json`, `export.json`, `votes.jsonl`, and CSVs
for votes, item stats, pair stats, and quality flags. To keep polling while
people test:

```bash
npm run pull:data -- \
  --url https://YOUR_DEPLOYMENT \
  --out exports/vercel-test \
  --watch 30
```

## Public API

- `GET /api/battle`
- `POST /api/vote`
- `GET /api/stats`
- `GET /api/export?format=json|csv`
- `GET /api/health`

`POST /api/vote` answers a body it cannot use with a 400 rather than a 500:
`invalid_json` for a body that is not JSON, `invalid_payload` for one that is not
an object or whose ids and timestamps are nested values or run past 300
characters, and `invalid_items` for item ids that are not in the dataset. A
storage backend that is not configured is a 503. A vote it can store but
does not trust is still a 200: it lands with `accepted_for_scoring: false` and
the reasons in `quality_flags`, because a rejected vote is more useful in the
dataset than missing from it.

The hold challenge `GET /api/battle` issues is signed for that battle and is
spent by the first vote that clears it. Sending it again, or pointing it at a
different battle, stores the vote with `hold_passed: false` and a `hold_replayed`
or `bad_hold_token` flag. Spending it is a create-if-absent write, so a burst of
replays sent at once settles the same way a loop does: one of them keeps the
vote and the rest are flagged. The challenge is claimed just before the vote is
written, so a storage failure at that moment burns it: the voter's retry is
still stored, it just does not count toward scoring.

## Data Notes

Public STL and preview assets are committed under `public/dataset/v1`. Ratings,
session metadata, quality flags, and export records stay private in Vercel Blob.
Public assets are downloadable by design.

## License

GPL-3.0-only.
