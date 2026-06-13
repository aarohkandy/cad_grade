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
2. Create or attach a Vercel Blob store to the project.
3. Add the production environment variables below.
4. Deploy.
5. Open `/api/health` and confirm `storage: "ok"` and `storageMode: "blob"`.
6. Open `/api/battle` and confirm it returns two automatically selected items.
7. Submit one vote in the arena.
8. Pull the vote through `/api/export` or `npm run pull:votes`.
9. Keep periodic JSONL exports outside git for analysis/backups.

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

`npm run dev` starts the Vite frontend. To exercise the API routes locally, run
the app through Vercel's local dev server with `LOCAL_VOTE_DIR` and
`ADMIN_EXPORT_TOKEN` set.

PowerShell example:

```powershell
$env:LOCAL_VOTE_DIR=".local-data/blob"
$env:ADMIN_EXPORT_TOKEN="local-secret"
$env:IP_HASH_SALT="local-hash-salt"
$env:HOLD_VERIFY_SECRET="local-hold-secret"
npx vercel dev --listen 127.0.0.1:3000
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
