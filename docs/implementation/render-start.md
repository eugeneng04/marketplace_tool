# Render Deployment Start Guide

## What this setup includes

- `resale-intelligence-api` web service on Render
- managed Postgres database
- backend-only API (no frontend dependency)

This blueprint is configured to remain on free plans by default.

## Deploy steps

1. Push this repository to GitHub.
2. In Render, click **New** > **Blueprint**.
3. Connect your repo and deploy using `render.yaml`.
4. Wait for database and web service provisioning.
5. Copy `API_TOKEN` from service environment variables.
6. Run initial migration from Render Shell:
   - `npm run migrate`
7. Seed a profile (optional):
   - `npm run seed:demo`
8. Call API:
   - `GET /health`
   - `GET /profiles` (with `Authorization: Bearer <API_TOKEN>`)
   - `POST /profiles/:id/run`

## Optional scheduled sync (paid path)

Render cron services are paid. If you want scheduled syncs, add a Render cron service that runs:

```bash
npm run sync:all
```

As a free alternative, trigger `POST /sync/all` from an external scheduler you control.

## API quick start

### Create profile

```bash
curl -X POST "$BASE_URL/profiles" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"Bay Area Civic Si",
    "category":"vehicle",
    "query":"civic si",
    "location":"bay-area",
    "radiusMiles":50,
    "minPrice":4000,
    "maxPrice":20000,
    "filtersJson":{"transmission":"manual"}
  }'
```

### Run one profile

```bash
curl -X POST "$BASE_URL/profiles/<PROFILE_ID>/run" \
  -H "Authorization: Bearer $API_TOKEN"
```

### List listings

```bash
curl "$BASE_URL/listings?make=honda&transmission=manual&limit=20" \
  -H "Authorization: Bearer $API_TOKEN"
```
