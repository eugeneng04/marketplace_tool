# Frontend Components

## Layout Components

### SidebarNav

Main app navigation.

### TopBar

Search bar, user controls, and global actions.

### PageHeader

Page title, description, and page-level actions.

## Listing Components

### ListingCard

Shows a compact listing summary.

Fields:
- image
- title
- price
- location
- mileage
- transmission
- title status
- deal score
- status
- first seen
- last seen

Actions:
- save
- reject
- mark contacted
- open detail

### ListingTable

Data-table view of listings.

### ListingStatusBadge

Shows status:
- new
- watching
- saved
- contacted
- rejected
- sold
- possibly gone
- hidden

### DealScoreBadge

Shows deal score with color-coded quality.

### RiskFlagBadge

Shows red flags such as salvage, no title, no smog, or check engine light.

### ModificationBadge

Shows detected modifications.

## Filter Components

### FilterSidebar

Container for filters.

### PriceRangeFilter

Minimum and maximum price.

### VehicleFilters

Vehicle-specific filters:
- mileage
- transmission
- title status
- color
- year
- make
- model
- trim

### StatusFilter

Filters by listing status.

## Search Profile Components

### SearchProfileCard

Shows one saved search profile.

### SearchProfileForm

Create or edit a search profile.

## Detail Page Components

### ImageGallery

Listing images.

### ParsedAttributesTable

Structured parsed fields.

### PriceHistoryPanel

Shows price changes over time.

### RawDescriptionPanel

Shows original listing text.

### NotesPanel

User notes and status controls.

## Trend Components

### MarketTrendSummaryCard

Shows median price and sample size.

### TrendChart

Displays price trend over time.

### SegmentComparisonTable

Compares marketplace segments.
