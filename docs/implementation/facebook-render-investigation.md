# Facebook / Render investigation — September 29, 2026

## Live checks

| Method | Outcome |
| --- | --- |
| Deployed `/health` | HTTP 200, service healthy |
| Local GraphQL client with configured Facebook cookie | Successful Marketplace search; three parsed listings; two requests |
| Local GraphQL client with no cookies | Successful Marketplace search; three parsed listings; two requests |
| One deployed `corvette` / Milpitas / 100-mile saved search | Failed with code `1675004: Rate limit exceeded`, rejected operation `Marketplace search`; zero results and zero detail pages |

Local requests were paced at three per minute, with a maximum of three requests per scenario. Both scenarios used the same client and document ID, requesting `corvette` around approximate Milpitas coordinates (37.4323, -121.8996), radius 161 km, result limit three. Both returned rich GraphQL cards, without needing the HTML search fallback. No credentials or listing payloads were saved in the diagnostic output.

The new deployed run is displayed as September 29, 7:09 PM in the app. The previous recorded run was September 28, 9:36 PM: approximately 22 hours apart. This weakens the hypothesis that a short burst from our own saved-search runs alone causes the failure, but does not exclude other traffic or a longer-lived restriction.

The Render dashboard showed commit `d0c7bdf` deployed and an `FB_COOKIE` environment variable configured. Its value was not revealed or compared with the local cookie. Therefore, the previous explanation that Render is definitely logged out is unsupported.

## Confirmed application bug and local fix

The successful local `/api/graphql/` replies were HTTP 200 with `Content-Type: text/html; charset="utf-8"`, despite containing JSON. The limiter previously skipped all `text/html` responses. A GraphQL rate-limit error with that same header could bypass the cooldown and allow more queued requests.

The limiter now identifies JSON from its body prefix, accepting Facebook's `for (;;);` prefix regardless of content type. Actual HTML is ignored. This fixes cooldown detection; it does not make Facebook accept the first rejected request.

Regression testing first reproduced the failure: two queued requests executed instead of one. After the fix, the rejection stops queued work and persists the five-minute cooldown. The Facebook request and GraphQL client suites passed all 33 tests. `git diff --check` passed. The fix has not been deployed.

## Current interpretation and remaining comparison

An environment-dependent Facebook restriction is the leading hypothesis. Render documents that outbound IP ranges are shared across services in a region ([Render documentation](https://render.com/docs/outbound-ip-addresses)). Meta describes detecting and blocking automated activity using multiple approaches ([Meta explanation](https://about.fb.com/news/2021/04/how-we-combat-scraping/)). These sources establish plausible mechanisms, not proof that this service's IP is blocked.

The tests do not isolate outbound IP from cookie/session context or runtime differences. Local execution used Node 24.19.0; the deployment configuration specifies Node 22. The exact deployed cookie and resolved profile coordinates were not compared. The next decisive experiment is a bounded same-runtime, same-configuration comparison from local and Render, logging only status, content type, operation, error code, and a session-equality indicator. Deploying the cooldown fix first will prevent subsequent tests from continuing through a detected rejection.
