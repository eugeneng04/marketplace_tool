# Free Render + Neon deployment

This setup serves the UI and API at one HTTPS address. Render's internal search
scheduler is disabled. GitHub Actions wakes the service and calls POST /sync/due
hourly at minute 17. It runs only due search groups, with a PostgreSQL advisory
lock to prevent overlapping scheduled requests. Failed groups remain due.
Local development retains the internal scheduler by default.

## Accounts and deployment

Admin `POST /network/proxy-test` accepts `{"proxyServer":"http://PUBLIC_IPV4:PORT"}`
and tests HTTPS connectivity to the fixed `https://example.com/` target from the
Render HTTP client. It allows only public IPv4 HTTP proxies without credentials,
keeps TLS certificate verification enabled, disables redirects, and uses a
ten-second request timeout. A fresh request context receives no application
credentials or configured Facebook cookies. Results include HTTP status, expected
page verification, duration, and a sanitized failure category. HTTP 200 from the
diagnostic endpoint alone is not success; require `success: true` in its result.
This does not test Facebook access or configure collection to use the proxy.

1. Push the application and `.github/workflows/scheduled-searches.yml` to the
   default branch of your GitHub repository. Never commit `.env` or cookies.
2. Create a Neon Free project near your Render region. Copy the **direct**
   PostgreSQL connection string with `sslmode=require` (disable connection pooling
   in Neon's Connect dialog). The scheduler uses a session advisory lock and must
   not use Neon's transaction-mode pooled endpoint.
3. In Render, create a Blueprint from this repository using `render.yaml`.
   It creates one Free Docker web service and no Render database or paid services.
   The Dockerfile uses Playwright 1.63.0's official Ubuntu image, matching the
   worker's pinned `playwright-core` version. It serves the same Node UI/API.
4. Enter the Neon string as DATABASE_URL using Render's private environment settings.
   No FB_COOKIE is required; the connector defaults to logged-out page tokens. Start in mock mode if
   you want to verify deployment without live Facebook access.
5. Deploy. The application automatically creates/updates its database schema.
   Open `/health` and then the root URL on your phone. Enter the generated
   API_TOKEN in the app Settings and use the same HTTPS URL as its API URL.
6. In GitHub repository Settings > Secrets and variables > Actions, add:
   - RENDER_APP_URL: the HTTPS Render service URL (no path).
   - SCHEDULER_TOKEN: the generated SCHEDULER_TOKEN from Render (not API_TOKEN).
7. Create search groups in the app, add enabled searches, and set each group to
   an interval of at least 60 minutes. Ungrouped searches and manual-only groups
   are not automatically run. A fresh Neon database has none of your local data;
   recreate the searches or separately migrate your existing database.
8. In GitHub Actions, run “Scheduled searches” manually. Confirm it succeeds,
   then inspect the app's run history and listings. Test a live Facebook search:
   Facebook may restrict logged-out searches from a hosting IP.

## Free-tier operation and limitations

- Authenticated `POST /facebook/listing-html-test` with a numeric `listingId`
  tests a public listing through direct HTML GETs on Render. It sends no cookies,
  uses no browser or GraphQL POST, and returns only field availability and timings.
  Extraction matches the requested ID, excluding recommended listings. The test
  respects shared Facebook pacing and cooldown, bounds redirects and response size,
  and does not write listings. It does not prove search or scheduled collection works.
  Optional `proxyServer` selects an HTTP proxy with a public IPv4 address and port,
  using the same validation as `/network/proxy-test`. This path uses Playwright's
  HTTP client without launching Chromium. Each redirect uses a fresh context so
  Facebook's Set-Cookie headers are never replayed. TLS verification stays enabled;
  no app credentials or Facebook cookies are sent through the proxy. Network
  failures return a sanitized `proxy_request_failed` result. The proxy path
  rejects HTML over 5 MB after the HTTP client has buffered it; that check
  limits parsing, not download size or peak memory.
  The diagnostic does not change the proxy used by normal collection.

- For an existing Blueprint-managed Node service, sync the updated Blueprint to
  change its runtime to Docker. Pushing code alone does not change the runtime.
  Keep the existing service, URL, and private environment values. The container
  build never includes `.env` files or Facebook cookies.
- `Test Facebook browser` runs a bounded, temporary browser diagnostic. It does
  not write listings or replace the GraphQL collector. A successful browser test
  is still required before using this runtime for collection.

- `FB_MAX_REQUESTS_PER_MINUTE` is enforced across all Facebook clients in one
  worker process, including token-page, search, location, detail, and photo
  requests. Multiple worker processes do not share this in-memory limit.
- A search run saves Marketplace cards and returns without per-listing detail
  requests. It retains supplied vehicle fields and cached detail evidence.
  Missing filter evidence remains unverified; confirmed contradictions are
  mismatches. Only a current match with fresh, complete details can create an
  alert under the existing alert rules.
- Opening a saved listing renders saved data first, then conditionally refreshes
  missing, stale, or incomplete details. Fresh details reuse the cache.
  Automatic enrichment skips the separate gallery request. **Load photos**
  requests photo enrichment explicitly. Concurrent refreshes of one listing
  share a request within one worker process.
- Direct GraphQL detail requests recognize one narrow unavailable-listing
  rejection. The listing-detail document must return exactly one error object
  with the message `A server error field_exception occured. Check server logs for details.`
  The object can contain only `message`, `code`, `type`, and `path`. Its `code`
  and `type` must be absent or null, and the response cannot contain a top-level
  `error`. This rejection preserves the loaded Facebook session and discards
  any returned partial target. It starts no photo request, retry, or fallback.
  Unknown signatures, authentication failures, throttling, and transport errors
  remain failures. A failed click refresh preserves the last saved listing data.
- `getListingDetail` separately accepts the reviewed optional `delivery_data`
  field failure when the response has exactly one error with only `message`,
  `path`, `severity`, `mids`, and `debug_link`. The message must match the field
  exception above, the severity must be `ERROR`, and the path must be
  `viewer/marketplace_product_details_page/target/delivery_data`. The one `mids`
  value must be a nonblank string of at most 512 characters. `debug_link` must
  be null or a nonblank string of at most 2048 characters. Both string checks
  reject control characters. A top-level `error` property rejects recovery,
  including null. The failed field must be absent or null.
  Recovery requires the requested listing ID, nonblank title, description text,
  usable price and currency, location, seller ID and name, creation time, and
  boolean pending and sold flags. Empty description text is valid. Present
  photo, attribute, subtitle, location, and vehicle containers must have the
  consumed shapes. Clean responses retain their existing parser behavior.
  The decoder removes `delivery_data` from a copied target before recursive
  vehicle extraction. A validated recovery completes the domain refresh and
  persists `optionalOmission` with `field: "delivery_data"` and
  `signatureVersion: 1` in `parsed_attributes_json.marketplaceMetadata`.
  It does not retry solely for the unused field. Requested photo enrichment
  remains strict. Search, location, photo, and generic GraphQL requests cannot
  use this recovery.
- Card-only search does not mark details complete or clear an existing
  incomplete marker. A later click can retry the affected listing. Search and
  detail observation writes preserve cached fields and update numeric price,
  changed-price history, snapshots, parsed evidence, and scoring together.
  Hidden, rejected, and sold workflow states remain unchanged.
- Before testing Facebook, check authenticated `GET /collector/status` to
  identify the execution source. Enabled computer mode uses the collector.
  Collector errors that lose their listing-specific error identity remain fatal.
  `GET /facebook/listings/{id}` exposes a bounded `detailDiagnostic` on GraphQL
  rejection through the existing HTTP 500 response. It reports target presence,
  error count, known field names, unknown field count, numeric codes, type shape,
  and bounded schema field names. `unknownFields` includes at most 10 unknown
  error keys. `path` preserves at most 16 segments, with numeric indexes replaced
  by `[index]` and rejected segments replaced by `[other]`. Schema names must
  match `^[a-z_]{1,64}$` after session-secret removal. Names that match the
  credential denylist and strings outside that syntax are excluded. The check does not prove
  that a name belongs to Facebook's schema. The diagnostic includes no raw error
  message, unknown error-field values, or response.
  Local fixtures prove the decoder rules. They do not establish that the
  live upstream error has the recognized shape or that a saved Render run works.
  The diagnostic also reports enumerated severity, retry and reauthentication
  flags, array shape and count for `locations` and `mids`, and non-null presence
  for fixed listing fields. It reports the shape of `delivery_data`, the shape
  of `debug_link`, and at most three `mids` element types. Arbitrary metadata values and listing values remain
  excluded. Field presence does not prove that partial detail data is usable.
  Capture this safe diagnostic, then verify the saved run separately after an
  authorized deployment.
- HTTP 429 and Facebook GraphQL rate-limit errors (including code 1675004 in
  HTTP 200 responses) stop outgoing requests for five minutes when Facebook
  omits `Retry-After`; an explicit server retry time is honored. The cooldown is stored in PostgreSQL and survives worker
  restarts. Queued/manual requests fail immediately during the cooldown without
  contacting Facebook; rejected requests are not automatically retried.
  Authenticated `GET /facebook/status` reports the pause and next attempt time.
  The pause is an application backoff, not a guarantee Facebook's
  restriction will have expired. Run errors
  retain bounded Facebook error codes/messages with session credentials and
  links removed. Rate limiting cannot guarantee Facebook will accept access.

- The workflow retries the read-only health request to allow Render to wake.
  It waits up to nine minutes for the search POST, without automatically retrying
  that POST. A timeout can leave work running on Render; check run history before
  retrying. Successful groups advance only after their searches complete.
- If a process crashes mid-group, some completed profiles may run again next time.
  Listing and alert persistence already deduplicates entries. This is not an
  exactly-once job queue. Manual search runs aren't covered by the scheduler lock.
- Render Free can restart/sleep; scheduled executions are best effort. GitHub
  schedules can be delayed and run only from the default branch. Public-repository
  schedules may disable after 60 days without repository activity.
- GitHub Free private repositories include 2,000 runner minutes/month shared with
  other workflows. Hourly jobs averaging two minutes use about 1,488 minutes in a
  31-day month; three-minute jobs exceed 2,000. Start with a small search group,
  check actual usage, and reduce cadence if needed. Keep paid Actions overages
  disabled if $0 is a hard requirement. This is not guaranteed unlimited hosting.
- No database queries are made by the background scheduler when
  SCHEDULER_ENABLED=false. Neon can suspend after inactivity; actual search work
  and browsing still consume its compute/storage allowances.
- Monitor Neon storage: listing snapshots/history grow over time. This change
  doesn't delete existing history or add a retention policy.
- Keep API_TOKEN and SCHEDULER_TOKEN private. The UI is publicly loadable, but
  production API data requires API_TOKEN. Scheduled calls use SCHEDULER_TOKEN.
- FB_COOKIE is optional. Only opt into authenticated access if you choose to use it.

Pricing references:
- https://render.com/docs/free
- https://neon.com/pricing
- https://docs.github.com/en/billing/reference/product-usage-included
