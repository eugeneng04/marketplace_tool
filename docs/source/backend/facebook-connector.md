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

Only fetch detail pages for:
- new listings
- stale listings
- saved listings
- contacted listings
- listings missing important parsed fields
- listings with an incomplete detail refresh
- manual refresh requests

## Safety Constraint

Do not design around bypassing login protections, CAPTCHA, rate limits, or access controls.
