# Facebook / Render investigation — September 29, 2026

## Live checks

| Method | Outcome |
| --- | --- |
| Deployed `/health` | HTTP 200, service healthy |
| Local GraphQL client with configured Facebook cookie | Successful Marketplace search; three parsed listings; two requests |
| Local GraphQL client with no cookies | Successful Marketplace search; three parsed listings; two requests |
| One deployed `corvette` / Milpitas / 100-mile saved search | Failed with code `1675004: Rate limit exceeded`, rejected operation `Marketplace search`; zero results and zero detail pages |
| Chromium browser on Render before cookie refresh | Browser launched; Marketplace returned HTTP 302; final page was `login_required`; zero visible listings |
| Safe session comparison before cookie refresh | Render has both `c_user` and `xs`, but their combined SHA-256 fingerprint did not match local |
| Chromium browser after user refreshed cookie | Marketplace redirect led to HTTP 200; browser or page closed during listing observation; zero listings |

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

The user subsequently refreshed Render's cookie. The new session has not been compared with local using the fingerprint helper; the earlier mismatch does not establish a current mismatch.

## Tests after cookie refresh

The original output at `2026-09-30T06:05:13.513Z` recorded only a Marketplace HTTP 302 and a generic navigation failure. Redirect observation was incomplete. Commit `537e009` added safe redirect and network-error categories, avoided reading document redirect bodies, and prevented aborting routes already continued. All 106 worker tests passed.

The rerun at `06:13:29.745Z` recorded a Marketplace HTTP 302 redirect to another Marketplace URL, followed by HTTP 200. It failed without visible listings. Commit `748f042` then distinguished browser closure, page crashes, and navigation interruption, and recorded the stage of failure. Its rerun at `06:18:18.634Z` finished at `06:18:50.534Z` with `navigationFailureCode: browser_or_page_closed` and `failureStage: observe_listings`. Neither run recorded a login redirect, GraphQL rate-limit response, or visible listings. HTTP 200 does not by itself establish a valid session or successful collection.

The Render dashboard confirms a 512 MB memory limit. Memory/CPU usage graphs are unavailable on this free service; the dashboard requires paid compute to view them. The Chromium package recommends 1600 MB or more ([package documentation](https://github.com/Sparticuz/chromium)). Memory exhaustion is a plausible cause of browser closure, but has not yet been confirmed. Commit `0b8a2ef` adds cgroup v2 memory counters before and after the diagnostic to detect container OOM kills without exposing credentials. All 12 browser diagnostic tests passed.

The memory-counter rerun (`06:26:33.549Z` to `06:27:01.302Z`) reproduced HTTP 302 → HTTP 200 → browser/page closure during listing observation. Container `oom`, `oom_kill`, and `oom_group_kill` remained zero; `oomKillDelta` was zero. Memory was 56,721,408 bytes before launch and 413,315,072 bytes after failure, against a 536,870,912-byte limit. These endpoint snapshots are not peak usage, but there is no evidence of a container OOM kill. The full worker suite passed 108 tests.

Commit `838de9f` tests removing Chromium's `--single-process` launch flag on Render. Chromium documents that this mode couples renderer crashes to loss of the browser process ([process model documentation](https://chromium.googlesource.com/playground/chromium-org-site/+/refs/heads/main/developers/design-documents/process-models.md)). This is a runtime experiment, not a proven explanation or Facebook-access workaround.

The multiprocess rerun (`06:29:37.194Z` to `06:30:04.203Z`) again recorded Marketplace HTTP 302 → HTTP 200. This time Playwright emitted `pageCrashed: true` and `navigationFailureCode: page_crashed` during listing observation, while the container OOM counters remained zero. Memory after failure was 444,993,536 bytes. Removing single-process mode isolated the failure to the renderer but did not fix it.

The deployed collector still does not work end to end. The current browser blocker is a confirmed renderer crash, with its root cause still unknown. The next runtime comparison should use Playwright's matching Chromium distribution in a supported container, rather than the Lambda Chromium package. A paid memory upgrade is not yet justified by an observed OOM kill; Facebook acceptance still needs a separate successful search test.

## Listing detail recovery, October 9, 2026

The Render investigation at deployed commit `c07d626` identified a different direct GraphQL failure. Its error has exactly `message`, `path`, `severity`, `mids`, and `debug_link`. The message matches the existing field exception, the severity is `ERROR`, and the path is `viewer/marketplace_product_details_page/target/delivery_data`. The error has one `mids` element and no `code`, `type`, or `extensions`. The response has no top-level `error`. Listing core data is present. The capture did not establish the `debug_link` value shape.

The detail decoder now recognizes this signature only with conservative metadata and domain-data validation. It accepts absent or null `delivery_data` and excludes that field from a copied target before vehicle extraction. No consumer reads that subtree directly. Recursive extraction could otherwise consume its descendants. The connector carries only `{ field: "delivery_data", signatureVersion: 1 }` as `optionalOmission`. The vehicle parser preserves this evidence in the existing persisted Marketplace metadata. A validated domain refresh follows the existing success path. Other signatures and required-data gaps remain fatal, and the earlier unavailable-listing rule remains unchanged.

Mocked HTTP regression tests first reproduced rejection of the reviewed response and failure of its saved refresh. The corrected decoder passes these tests, including the actual connector, vehicle parser, and sync persistence callback. Tests cover malformed metadata, missing required fields, malformed consumed containers, authentication, throttling, other operations, and failed requested photo enrichment. No private metadata values are retained in omission evidence or rejection diagnostics.

This local verification does not establish the live nullable field and metadata shapes, signed-in Facebook identity, profile filtering, or saved ingestion. After deployment, a direct detail replay must establish whether the conservative checks accept the current response. A saved run must then verify collection separately. Rejected detail diagnostics report bounded value shapes without their values.
