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

Prompts and proprietary generation text are not included in the public
manifest.

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
- `.github/workflows/ci.yml` runs dataset validation, tests, and production
  build on pushes and pull requests.
- `npm run check:production` verifies that the deployed URL is actually ready
  for public traffic.

The only required manual Vercel pieces are the Blob store attachment and the
three environment variables below.

## Environment

Set these in Vercel Project Settings -> Environment Variables:

```text
BLOB_READ_WRITE_TOKEN
IP_HASH_SALT
HOLD_VERIFY_SECRET
```

`BLOB_READ_WRITE_TOKEN` is created when Vercel Blob is attached.
`IP_HASH_SALT` and `HOLD_VERIFY_SECRET` can be any long random secrets.

Generate local secret values with Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For local serverless API testing, `LOCAL_VOTE_DIR` can point at a private local
folder. Do not set `LOCAL_VOTE_DIR` in Vercel production.

## Local Setup

```bash
npm install
npm run dataset
npm run test
npm run build
npm run dev
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
The pruning step requires local Blob credentials in `.env.local` or the shell
environment; without them the backup still writes local files but cannot delete
server blobs.

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

## Data Notes

Public STL and preview assets are committed under `public/dataset/v1`. Ratings,
session metadata, quality flags, and export records stay private in Vercel Blob.
Public assets are downloadable by design.

## License

GPL-3.0-only.
