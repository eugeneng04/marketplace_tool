# Facebook Marketplace Connector

## Purpose

The Facebook Marketplace connector captures listing data from Facebook Marketplace and normalizes it into the app's RawSourceItem format.

## Scope

MVP supports only Facebook Marketplace active listings.

## Responsibilities

The connector should:
- accept a SearchProfile or Marketplace search URL
- capture visible listing cards
- extract listing URL, possible listing ID, title, price, location, thumbnail, and rank
- fetch detail pages only when needed
- store raw card text and raw detail text
- normalize data into RawSourceItem
- avoid leaking Facebook-specific assumptions into other packages

## Non-Responsibilities

The connector should not:
- decide deal scores
- parse vehicle attributes
- calculate market trends
- manage listing statuses beyond source availability
- own deduplication business logic

## RawSourceItem

Fields:
- source
- sourceItemId
- url
- normalizedUrl
- titleRaw
- priceRaw
- descriptionRaw
- locationRaw
- imageUrls
- sellerRaw
- capturedAt
- sourceMetadata

## Detail Fetch Policy

Saved-search runs capture cards without per-listing detail requests. The database retains supplied card fields and cached detail evidence.

Opening a saved listing displays the cache, then checks whether details are missing, stale, or incomplete. Saved and contacted listings use a shorter freshness window. A forced manual refresh bypasses freshness. Automatic detail enrichment uses the existing GraphQL detail operation without a separate gallery request. Photo enrichment requires an explicit request.

Filter qualification is evaluated for each linked profile. Missing mileage, title, or transmission evidence stays unverified. Confirmed contradictions fail the relevant filters.

## Safety Constraint

Do not design around bypassing login protections, CAPTCHA, rate limits, or access controls.
