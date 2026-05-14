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

## Environment variables

- `DATABASE_URL` (required)
- `PORT` (optional, default `10000`)
- `API_TOKEN` (optional but recommended for non-health endpoints)
- `CONNECTOR_MODE` (`mock` for MVP seed runs)
- `PREFER_MANUAL_TRANSMISSION` (`true` or `false`)

## Worker app commands

From `apps/worker`:

```bash
npm install
npm run migrate
npm run seed:demo
npm start
```

Other commands:

- `npm run sync:all` run all enabled profiles
- `npm run run:profile -- --profileId <id>` run one profile

## API endpoints

- `GET /health`
- `GET /profiles`
- `POST /profiles`
- `POST /profiles/:id/run`
- `POST /sync/all`
- `GET /runs?profileId=<id>&limit=50`
- `GET /listings?status=&make=&model=&transmission=&minPrice=&maxPrice=&limit=&offset=`
- `GET /listings/:id`

## Render deployment

Use the blueprint in `render.yaml`.

Deployment notes are in:
- `docs/implementation/render-start.md`
