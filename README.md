# Capybara Arena

Capybara Arena is a public CAD grading game for Cadybara-generated models. It
shows two same-family STL models, lets a visitor choose the better model, and
stores append-only preference data in Supabase for later export and analysis.

The first public dataset contains 40 renderable hosted Cadybara outputs:

- 30 wall-planter models
- 10 wall-hook models

Snowman rows are intentionally excluded from V1 because the inspected batch had
no viewable STL cells.

## Local Setup

```bash
npm install
npm run dataset
npm run test
npm run build
npm run dev
```

Voting works as a UI demo without Supabase, but production data collection
requires the environment variables in `.env.example`.

## Supabase

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the SQL editor.
3. Add these Vercel environment variables:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ADMIN_EXPORT_TOKEN
IP_HASH_SALT
HOLD_VERIFY_SECRET
```

The app stores salted IP and user-agent hashes, not raw IP addresses or raw
user agents. Elo is private and only public aggregate counts are exposed.

## Vercel

Import `https://github.com/aarohkandy/cad_grade` into Vercel. Vercel detects
the Vite app and uses `vercel.json` for the build and output directory.

Useful checks after deploy:

```text
/api/health
/api/stats
/api/battle?family=any
```

Admin export requires an admin token:

```bash
curl -H "x-admin-token: $ADMIN_EXPORT_TOKEN" \
  "https://YOUR_DEPLOYMENT/api/export?format=json"
```

CSV export supports `table=votes`, `table=item_stats`, or `table=pair_stats`.

## Data Notes

Public STL and preview assets are committed under `public/dataset/v1`. Ratings,
session metadata, quality flags, and internal Elo stay in Supabase. Public
assets are downloadable by design.

## License

GPL-3.0-only.
