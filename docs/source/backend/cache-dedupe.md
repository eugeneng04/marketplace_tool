# Cache and Deduplication Design

## Cache-First Rule

Every seen listing should be saved permanently unless deleted by the user.

## New Listing Workflow

1. Capture listing card.
2. Normalize source item.
3. Check for duplicate.
4. If new, create Item.
5. Create ItemSnapshot.
6. Fetch detail if needed.
7. Parse item.
8. Create PriceObservation.

## Existing Listing Workflow

1. Capture listing card.
2. Match to existing Item.
3. Update lastSeenAt.
4. Create SearchHit.
5. Create ItemSnapshot.
6. Check for price changes.
7. Only fetch detail if stale or needed.

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

- new listing: fetch detail immediately
- existing listing: update lastSeenAt only
- saved listing: refresh every 12–24 hours
- contacted listing: refresh every 12 hours
- rejected listing: never refresh
- possibly gone listing: check weekly or manually

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
