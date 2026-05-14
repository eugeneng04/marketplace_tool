# MVP Roadmap

## MVP 1: Facebook Marketplace Cache for Vehicles

Goals:
- create search profiles
- run Facebook Marketplace searches
- cache all seen listing cards
- fetch details for new or stale listings
- dedupe listings
- track firstSeenAt and lastSeenAt
- parse basic vehicle fields
- show listings in local UI
- filter local listings

Parsed fields:
- price
- mileage
- transmission
- title status
- color
- year
- make
- model

## MVP 2: Better Vehicle Intelligence

Goals:
- parse modifications
- detect red flags
- track price changes
- add saved/rejected/contacted statuses
- add deal scoring
- add price history UI

## MVP 3: Marketplace Trends

Goals:
- compute local asking-price trends
- show median price by area
- show trends over 7, 30, and 90 days
- compare listing price to local segment median

## MVP 4: Multi-Category Support

Goals:
- add wheels/tires parser
- add office chair parser
- add bike part parser
- add category-specific filters
- add generic parser

## MVP 5: External Sold Comps

Goals:
- add Cars & Bids connector
- add Bring a Trailer connector
- add ComparableSale workflow
- match sold comps to active listings
- adjust valuation using sold comps
