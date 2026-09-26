# Resale Intelligence

Backend-first MVP for local-first resale intelligence, designed to run as a web service.

## Current MVP focus

- search profile creation and management
- run tracking (`search_runs`)
- listing cache and snapshots
- price history tracking
- vehicle parsing + evidence capture
- basic local market scoring
- Render-ready deployment config

## Repository layout

- `apps/worker`: backend API + sync engine + CLI commands
- `packages/*`: domain and design scaffolding for future modularization
- `docs/source`: original product and architecture docs
- `docs/implementation`: implementation and deployment notes

## Runtime requirements

- Node 22+
- PostgreSQL 14+
- Docker, if using the included local Postgres setup

## Connector modes

- `mock`: deterministic synthetic Marketplace data for testing.
- `facebook_graphql`: standalone direct GraphQL Marketplace queries adapted from `jdcodes1/facebook-marketplace-mcp`, without MCP or an LLM in the loop.

`facebook_graphql` defaults to cookie-free Marketplace page tokens. Facebook may restrict logged-out searches depending on the server IP or query; deployment success does not guarantee live results. Set `FB_USE_CHROME_COOKIES=true` to explicitly enable local Chrome-session extraction, or optionally provide `FB_COOKIE`.

## Environment variables

- `DATABASE_URL` (required)
- `PORT` (optional, default `10000`)
- `API_TOKEN` (optional but recommended for non-health endpoints)
- `CONNECTOR_MODE` (`mock` or `facebook_graphql`)
- `PREFER_MANUAL_TRANSMISSION` (`true` or `false`)
- `MAX_CARDS_PER_RUN` (default `25`)

When using direct Facebook GraphQL:
- `CHROME_PROFILE` (optional, default `Default`)
- `FB_COOKIE` (optional authenticated session)
- `FB_USE_CHROME_COOKIES` (optional, default `false`; local macOS only)
- `FB_USER_AGENT` (optional)

Saved search profile sync with `CONNECTOR_MODE=facebook_graphql` requires coordinates in `filtersJson`, for example:

```json
{
  "name": "Bay Area Civic/Si",
  "category": "vehicle",
  "query": "civic si",
  "location": "San Francisco, CA",
  "radiusMiles": 50,
  "minPrice": 4000,
  "maxPrice": 20000,
  "filtersJson": {
    "latitude": 37.7749,
    "longitude": -122.4194
  }
}
```

When creating or updating profiles through the API, the server will try to resolve `location` into Marketplace coordinates automatically when `CONNECTOR_MODE=facebook_graphql` and coordinates are missing. Pass `"resolveLocation": false` to skip that lookup.

## Worker app commands

For local development, start Postgres first:

```bash
cp .env.example .env
npm run db:up
```

Then start the worker:

```bash
npm --workspace @resale-intelligence/worker run dev
```

The worker loads `.env` from the repo root automatically. Database migrations run on worker startup.

Other commands:

- `npm run sync:all` run all enabled profiles
- `npm run run:profile -- --profileId <id>` run one profile
- `npm run facebook:locations -- --query "San Francisco"` find Marketplace location coordinates without using the database
- `npm run facebook:search -- --query "civic si" --latitude 37.7749 --longitude -122.4194 --radiusKm 80 --minPrice 4000 --maxPrice 20000` run a direct Marketplace search without MCP or the database
- `npm run facebook:detail -- --listingId <facebookListingId>` fetch listing detail without using the database

## Web UI

Start the worker API in one terminal:

```bash
npm --workspace @resale-intelligence/worker run dev
```

Start the web UI in another terminal:

```bash
npm --workspace @resale-intelligence/web run dev
```

Open `http://localhost:5173`. The UI defaults to `http://localhost:10000` for the worker API and stores the API URL/token in local browser storage.

## API endpoints

- `GET /health`
- `POST /facebook/search`
- `GET /facebook/locations?query=<city>`
- `GET /facebook/listings/:listingId`
- `GET /profiles`
- `POST /profiles`
- `GET /profiles/:id`
- `PUT /profiles/:id`
- `PATCH /profiles/:id`
- `DELETE /profiles/:id`
- `POST /profiles/:id/run`
- `POST /sync/all`
- `GET /search-groups` and `POST /search-groups` for grouped model aliases and shared run intervals
- `POST /search-groups/:id/run` run enabled searches in a group
- `GET /runs?profileId=<id>&limit=50`
- `GET /listings?status=&make=&model=&transmission=&minPrice=&maxPrice=&limit=&offset=`
- `GET /listings/:id`
- `PATCH /listings/:id/status`
- `GET /deals?limit=30` ranked deals feed (score, confidence, verdict, reasons)
- `GET /alerts?limit=30&unreadOnly=true&profileId=<id>` in-app deal alerts
- `PATCH /alerts/:id/read` mark an alert read
- `GET /listings/:id/comps` auction comps with median sold price (911s labeled by generation: 996/997/991/992)
- `POST /listings/:id/comps` add a comp manually (BaT, Cars & Bids, or other)
- `POST /listings/:id/comps/fetch` auto-fetch sold comps from BaT model pages and the full Cars & Bids past-results archive (signed guest session, deduplicated, 911s narrowed to the listing's generation)
- `DELETE /comps/:id` remove a comp

Profiles accept per-search alert rules (`alertMinScore` 0-100, `alertMinConfidence` 0-1, `alertMaxAgeHours` in hours). When a completed profile search finds a listing meeting that profile's rules, a deduplicated in-app alert is created (`UNIQUE (profile_id, item_id)`). Low-confidence listings are shown as "Needs review" and never as confirmed good deals.

Search groups let related queries (for example, BRZ and FR-S) stay as separate Marketplace searches while sharing a manual or interval-based schedule. Locally, the worker checks due groups every 30 seconds. The free Render blueprint sets `SCHEDULER_ENABLED=false`; the included hourly GitHub Actions workflow calls `POST /sync/due` with a separate `SCHEDULER_TOKEN`, so Render and Neon can become idle between runs. See `docs/implementation/render-start.md` for account setup, secrets, and free-tier limits.

Saved vehicle searches also accept optional detail-based filters for transmission, year range, maximum mileage, clean-title mentions, and modification mentions. Those filters run against listing text/details after capture; missing claims are treated as not matching when a filter is required.

Direct Facebook search example:

```bash
curl -X POST http://localhost:10000/facebook/search \
  -H 'content-type: application/json' \
  -d '{"query":"civic si","latitude":37.7749,"longitude":-122.4194,"radiusKm":80,"minPrice":4000,"maxPrice":20000,"limit":20}'
```

Update listing status example:

```bash
curl -X PATCH http://localhost:10000/listings/<itemId>/status \
  -H 'content-type: application/json' \
  -d '{"status":"saved"}'
```

## Render deployment

Use the blueprint in `render.yaml`.

Deployment notes are in:
- `docs/implementation/render-start.md`
