# MVP 1 Ticket Breakdown

## T1: Search Profile CRUD
- Implement create, edit, enable, disable, and delete for search profiles.
- Persist `filtersJson`, radius, query, and location fields.
- Add unit tests for validation and defaults.

## T2: Run Search Profile Job
- Add worker job handler to run one profile on demand.
- Record `SearchRun` lifecycle from start to finish.
- Persist result counts and errors.

## T3: Capture Raw Listings
- Implement Facebook listing-card capture interface.
- Store rank and card-level raw data.
- Generate `SearchHit` rows for each seen listing.

## T4: Cache Items and Snapshots
- Normalize raw source data to `Item` and `ItemSnapshot`.
- Upsert by strong identity (`sourceItemId`, `normalizedUrl`).
- Always append snapshot for each seen listing.

## T5: Dedupe and Fingerprinting
- Add medium/fuzzy dedupe helpers for vehicles.
- Create initial vehicle fingerprint generator.
- Keep source-specific assumptions isolated in connector package.

## T6: Parse Vehicle Attributes
- Implement extraction for year, make, model, mileage, transmission, and title status.
- Store parse evidence and parser version per field.
- Add red-flag and positive-signal detection.

## T7: Listings UI and Filtering
- Build listings table/card switch.
- Implement filter sidebar for vehicle fields.
- Add listing detail page sections for parsed data and price history.
