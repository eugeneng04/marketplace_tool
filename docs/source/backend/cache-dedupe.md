# Cache and Deduplication Design

## Cache-First Rule

Every seen listing should be saved permanently unless deleted by the user.

## New Listing Workflow

1. Capture listing card.
2. Normalize source item.
3. Check for duplicate.
4. If new, create Item.
5. Create ItemSnapshot.
6. Parse available card fields.
7. Create PriceObservation and deal score in the observation transaction.
8. Retain candidates with missing filter evidence as unverified.

## Existing Listing Workflow

1. Capture listing card.
2. Match to existing Item.
3. Update lastSeenAt.
4. Create SearchHit.
5. Create ItemSnapshot.
6. Check for price changes.
7. Reparse retained card and detail fields, preserving cached evidence.
8. Update numeric price, changed-price history, and deal score in the observation transaction.

## Listing Statuses

- new
- watching
- saved
- contacted
- rejected
- sold
- possibly_gone
- hidden

## Refresh Policy

Search runs save cards without detail requests. Search observations update `last_seen_at`; successful detail observations update `last_scraped_at` separately. Concurrent observation writes lock the item row, and older observations cannot overwrite newer data.

Opening a listing conditionally fetches missing, stale, or incomplete details. Ordinary details default to a 24-hour freshness window; saved and contacted listings use at most 12 hours. Linked profiles can set `staleDetailHours`. Fresh details return the cache unless the caller requests `force: true`. Extra photos require `fetchPhotos: true`.

Collection preserves user workflow status, descriptions, photos, structured fields, and parsed evidence. Missing required filter evidence remains unverified for the relevant profile. Only a current match with fresh, complete details is eligible for deal alerts.

## Dedupe Layers

### Strong Match

- same sourceItemId
- same normalizedUrl

### Medium Match

For vehicles:
- same year
- same make
- same model
- same trim
- similar mileage
- similar price
- same location

### Fuzzy Match

- similar title
- similar description
- similar image URLs
- similar price
- similar location

## Fingerprint Examples

Vehicle:
year | make | model | trim | mileage bucket | location

Office chair:
brand | model | size | version | location

Wheels:
brand | model | diameter | width | bolt pattern | offset | location
