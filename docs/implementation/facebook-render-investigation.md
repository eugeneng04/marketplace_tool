# Facebook / Render investigation — September 29, 2026

## Live checks

| Method | Outcome |
| --- | --- |
| Deployed `/health` | HTTP 200, service healthy |
| Local GraphQL client with configured Facebook cookie | Successful Marketplace search; three parsed listings; two requests |
| Local GraphQL client with no cookies | Successful Marketplace search; three parsed listings; two requests |
| One deployed `corvette` / Milpitas / 100-mile saved search | Failed with code `1675004: Rate limit exceeded`, rejected operation `Marketplace search`; zero results and zero detail pages |
| Chromium browser on Render with its configured cookie | Browser launched; Marketplace returned HTTP 302; final page was `login_required`; zero visible listings |
| Safe session comparison | Render has both `c_user` and `xs`, but their combined SHA-256 fingerprint does not match local |

Local requests were paced at three per minute, with a maximum of three requests per scenario. Both scenarios used the same client and document ID, requesting `corvette` around approximate Milpitas coordinates (37.4323, -121.8996), radius 161 km, result limit three. Both returned rich GraphQL cards, without needing the HTML search fallback. No credentials or listing payloads were saved in the diagnostic output.

The new deployed run is displayed as September 29, 7:09 PM in the app. The previous recorded run was September 28, 9:36 PM: approximately 22 hours apart. This weakens the hypothesis that a short burst from our own saved-search runs alone causes the failure, but does not exclude other traffic or a longer-lived restriction.

The Render dashboard initially showed commit `d0c7bdf` deployed and an `FB_COOKIE` environment variable configured. The later browser experiment on deployed commit `ad86040` confirmed that the configured session redirects to login. The session differs from local; this does not establish whether it is expired, revoked, or rejected because of its network context. Cookie values were never displayed.

## Confirmed application bug and local fix

The successful local `/api/graphql/` replies were HTTP 200 with `Content-Type: text/html; charset="utf-8"`, despite containing JSON. The limiter previously skipped all `text/html` responses. A GraphQL rate-limit error with that same header could bypass the cooldown and allow more queued requests.

The limiter now identifies JSON from its body prefix, accepting Facebook's `for (;;);` prefix regardless of content type. Actual HTML is ignored. This fixes cooldown detection; it does not make Facebook accept the first rejected request.

Regression testing first reproduced the failure: two queued requests executed instead of one. After the fix, the rejection stops queued work and persists the five-minute cooldown. The full worker suite passed all 103 tests, including browser diagnostic tests. `git diff --check` passed. The cooldown fix and browser diagnostic are deployed.

## Deployed browser experiment

The refined experiment ran from `2026-09-30T02:32:03.648Z` to `2026-09-30T02:32:29.695Z` (September 29 in Pacific time), using Node `v22.23.3` and Chromium `153.0.8010.0`. It searched `corvette`, seeded a temporary browser context with Render's existing `FB_COOKIE`, and enforced a maximum of four GraphQL requests and three document requests through the existing request limiter. No listing writes occurred.

The recorded Marketplace document response was HTTP 302, and the final browser pathname was categorized as `login_required`, not a security checkpoint. There were zero visible listing links and no recorded GraphQL requests. A `requestFailure` flag also occurred; redirect-chain response recording is incomplete, so the diagnostic does not claim a complete network trace. The final login page and session mismatch were independently observed in its sanitized output. An earlier browser run also reached a login/challenge page.

The comparison hashes only the `c_user` and `xs` values. The local fingerprint was recomputed with the same helper and confirmed to equal the submitted fingerprint. Render returned `sessionMatchesLocal: false`. This establishes a configuration difference without exposing either cookie. These tests used temporary browser contexts; they did not test a persistent browser profile or a fresh sign-in from Render.

## Current interpretation and remaining comparison

An environment-dependent Facebook restriction is the leading hypothesis. Render documents that outbound IP ranges are shared across services in a region ([Render documentation](https://render.com/docs/outbound-ip-addresses)). Meta describes detecting and blocking automated activity using multiple approaches ([Meta explanation](https://about.fb.com/news/2021/04/how-we-combat-scraping/)). These sources establish plausible mechanisms, not proof that this service's IP is blocked.

The tests do not isolate outbound IP from cookie/session context or runtime differences. Local execution used Node 24.19.0; the browser deployment used Node 22.23.3. The browser search used the account's default location, while the local GraphQL test specified Milpitas. Because the sessions demonstrably differ, an IP-only diagnosis is premature.

The next step is for the user to refresh Render's `FB_COOKIE` with the working session through Render's environment settings, redeploy, and repeat the bounded browser and GraphQL checks. Changing the authentication credential in the dashboard requires the user to complete the entry and submission. If the same session still redirects or the search remains rate limited, a persistent cloud browser session or another cloud host remains an experiment, with no guarantee of Facebook acceptance.
