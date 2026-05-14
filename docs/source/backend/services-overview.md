# Backend Services Overview

## Goal

The backend should run searches, capture listings, cache data, parse listing text, deduplicate listings, track price history, and calculate marketplace trends.

## Main Services

### SearchProfileService

Creates and manages saved searches.

### SearchRunService

Runs a search profile and records search results.

### FacebookMarketplaceConnector

Captures Marketplace listing cards and listing details.

### CacheService

Determines whether a listing is new or already known.

### DedupeService

Detects duplicate or relisted items.

### ParserService

Runs category parsers on raw listing data.

### PriceHistoryService

Tracks price changes.

### TrendService

Calculates local Marketplace price trends.

### ValuationService

Scores listings based on local asking prices and parsed attributes.

## MVP Backend Scope

MVP should support:
- Facebook Marketplace as the only source
- vehicle category as the primary parser
- local cache
- deduplication
- price tracking
- basic deal scoring
