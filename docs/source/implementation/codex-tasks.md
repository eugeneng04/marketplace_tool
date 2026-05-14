# Codex Tasks

## Task 1: Create Project Structure

Create the base monorepo structure:

resale-intelligence/
  apps/
    web/
    worker/
  packages/
    core/
    db/
    parser/
    valuation/
    connectors/
      facebook-marketplace/
  docs/

Do not implement app logic yet.

## Task 2: Define Shared Types

Create shared TypeScript types for:
- SearchProfile
- SearchRun
- Item
- ItemSnapshot
- SearchHit
- PriceHistory
- RawSourceItem
- ParsedItem
- VehicleAttributes
- Modification
- DealScore

## Task 3: Database Schema

Create the database schema based on docs/backend/database-design.md.

## Task 4: Facebook Connector Design Stub

Create the Facebook Marketplace connector package with interface stubs only.

Do not implement scraping logic yet.

## Task 5: Parser Stubs

Create parser interfaces:
- BaseCategoryParser
- VehicleParser
- WheelsTiresParser
- OfficeChairParser
- BikePartParser
- GenericParser

## Task 6: UI Wireframe Components

Create frontend component stubs:
- SidebarNav
- DashboardPage
- SearchProfilesPage
- ListingsPage
- ListingDetailPage
- MarketTrendsPage
- ListingCard
- ListingTable
- FilterSidebar

## Task 7: MVP Implementation Plan

Break MVP 1 into smaller implementation tickets:
- create search profiles
- run search profile
- capture raw listings
- cache items
- dedupe items
- parse vehicle attributes
- display listings
- filter listings
