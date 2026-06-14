# Capybara Arena

Capybara Arena is a public CAD grading game for Cadybara-generated models. It
shows two same-family STL models, lets a visitor choose the better model or mark
the pair as similar, and stores append-only preference data in private Vercel
Blob objects for export and offline analysis.

The first public dataset contains 40 renderable hosted Cadybara outputs:

- 30 wall-planter models
- 10 wall-hook models

Snowman rows are intentionally excluded from V1 because the inspected batch had
no viewable STL cells.

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
  --url https://YOUR_DEPLOYMENT \
  --token YOUR_ADMIN_EXPORT_TOKEN
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
four secret environment variables.

## Environment

Set these in Vercel Project Settings -> Environment Variables:

```text
BLOB_READ_WRITE_TOKEN
ADMIN_EXPORT_TOKEN
IP_HASH_SALT
HOLD_VERIFY_SECRET
```

`BLOB_READ_WRITE_TOKEN` is created when Vercel Blob is attached. The admin
token can be any long random secret. `IP_HASH_SALT` and `HOLD_VERIFY_SECRET`
should also be long random secrets.

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

To match Vercel's runtime locally, or to enable admin export from dev, set
`LOCAL_VOTE_DIR` and `ADMIN_EXPORT_TOKEN` before starting the server.

PowerShell example:

```powershell
$env:LOCAL_VOTE_DIR=".local-data/blob"
$env:ADMIN_EXPORT_TOKEN="local-secret"
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

## Battle Selection

Visitors do not choose a model family. The server selects same-family battles
automatically so the data stays useful:

- balance average vote exposure per item across families
- avoid pairs already seen by the current browser session when possible
- prioritize under-sampled items
- avoid over-repeating the same pair
- prefer closer Elo matchups once both items have enough scoring history

## Export

Admin export requires `ADMIN_EXPORT_TOKEN`:

```bash
curl -H "x-admin-token: $ADMIN_EXPORT_TOKEN" \
  "https://YOUR_DEPLOYMENT/api/export?format=json"
```

Limit to one day when pulling often:

```bash
curl -H "x-admin-token: $ADMIN_EXPORT_TOKEN" \
  "https://YOUR_DEPLOYMENT/api/export?format=json&date=2026-06-12"
```

CSV export supports `table=votes`, `table=item_stats`, `table=pair_stats`, or
`table=quality_flags`:

```bash
curl -H "x-admin-token: $ADMIN_EXPORT_TOKEN" \
  "https://YOUR_DEPLOYMENT/api/export?format=csv&table=votes" \
  > votes.csv
```

The pull helper writes JSONL:

```bash
ADMIN_EXPORT_TOKEN=... npm run pull:votes -- \
  --url https://YOUR_DEPLOYMENT \
  --date 2026-06-12 \
  --out exports/votes-2026-06-12.jsonl
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
