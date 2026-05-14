# User Flows

## Create a Search Profile

1. User opens Search Profiles.
2. User clicks Create Search Profile.
3. User selects category.
4. User enters query.
5. User sets location and radius.
6. User sets filters.
7. User saves profile.

## Run a Search

1. User clicks Run Now on a search profile.
2. Backend worker runs the Facebook Marketplace connector.
3. App creates a SearchRun.
4. New listings are cached.
5. Existing listings are updated.
6. User sees new results in Listings.

## Review Listings

1. User opens Listings.
2. User filters by attributes.
3. User sorts by deal score or newest.
4. User opens a listing detail page.
5. User reviews parsed attributes, modifications, risk flags, and price history.
6. User saves, rejects, or marks contacted.

## Track Price Drops

1. App sees an existing listing again.
2. App compares the new price to the previous price.
3. If price changed, app creates a PriceHistory record.
4. User sees the price drop on Dashboard and Listing Detail.

## Mark Listing Possibly Gone

1. Listing has not appeared in recent searches.
2. App marks it as possibly gone after a configured threshold.
3. User can manually confirm sold, keep watching, or hide it.
