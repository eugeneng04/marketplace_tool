# Database Design

## SearchProfile

Stores saved searches.

Fields:
- id
- name
- category
- query
- location
- radiusMiles
- minPrice
- maxPrice
- filtersJson
- enabled
- createdAt
- updatedAt

## SearchRun

Stores each time a search profile is run.

Fields:
- id
- searchProfileId
- source
- startedAt
- finishedAt
- status
- resultsFound
- newItems
- existingItems
- detailPagesOpened
- errorMessage

## Item

Stores the main cached listing.

Fields:
- id
- category
- source
- sourceItemId
- url
- normalizedUrl
- fingerprint
- titleRaw
- descriptionRaw
- priceRaw
- locationRaw
- imageUrls
- sellerRaw
- currentPrice
- locationCity
- locationRegion
- latitude
- longitude
- status
- firstSeenAt
- lastSeenAt
- lastScrapedAt
- possiblyGoneAt
- createdAt
- updatedAt

## ItemSnapshot

Stores listing state each time it is captured.

Fields:
- id
- itemId
- capturedAt
- titleRaw
- priceRaw
- parsedPrice
- descriptionRaw
- locationRaw
- imageUrls
- availabilityStatus

## SearchHit

Links an item to a search run.

Fields:
- id
- searchRunId
- itemId
- rank
- seenAt

## PriceHistory

Tracks price changes.

Fields:
- id
- itemId
- price
- priceRaw
- capturedAt

## ParseEvidence

Stores parser evidence for transparency.

Fields:
- id
- itemId
- field
- value
- confidence
- evidenceText
- parserVersion
- createdAt

## Modification

Stores detected modifications.

Fields:
- id
- itemId
- category
- modType
- modName
- brand
- confidence
- evidenceText

## PriceObservation

Stores observed asking prices for trend calculations.

Fields:
- id
- itemId
- source
- category
- searchProfileId
- observedPrice
- observedAt
- locationCity
- locationRegion
- attributesJson

## MarketTrendDaily

Stores aggregated daily trend data.

Fields:
- id
- category
- queryKey
- locationRegion
- date
- medianAsk
- p25Ask
- p75Ask
- listingCount
- newCount
- disappearedCount

## MarketSegment

Stores aggregated segment data.

Fields:
- id
- category
- segmentKey
- locationRegion
- medianPrice
- medianMileage
- sampleSize
- updatedAt

## Future Model: ComparableSale

Not needed in MVP 1, but reserved for future Cars & Bids, Bring a Trailer, and eBay sold comps.

Fields:
- id
- category
- source
- sourceItemId
- url
- titleRaw
- descriptionRaw
- soldPrice
- soldAt
- locationRaw
- imageUrls
- parsedAttributesJson
- modificationsJson
- conditionGrade
- confidence
- sourceMetadata
