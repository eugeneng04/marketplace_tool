# Product Spec

## Product Name

Resale Intelligence App

## Goal

Build a local search and cache system for Facebook Marketplace listings, starting with cars. The app should cache every listing seen, parse listing details, deduplicate listings, track price changes, and help identify good deals.

## MVP Scope

The first version focuses only on Facebook Marketplace vehicle listings.

## Future Scope

The app should later support:
- wheels and tires
- office chairs
- bike parts
- generic resale items
- other sources such as Cars & Bids, Bring a Trailer, Craigslist, OfferUp, and eBay

## Core User Problems

- Facebook Marketplace search results are inconsistent.
- The same listing may disappear from later searches.
- It is difficult to compare listings across time.
- It is hard to filter for specific details like manual transmission, mileage, title status, color, and modifications.
- It is hard to know whether a listing is a good deal for the local area.

## Core Product Behavior

The app should:
- run saved search profiles
- cache every seen listing
- avoid duplicate listings
- parse listing title and description
- track price changes
- track first seen and last seen dates
- mark listings as new, saved, contacted, rejected, sold, or possibly gone
- show local Marketplace price trends
- score listings based on price and quality

## Non-Goals for MVP

The MVP should not include:
- Cars & Bids integration
- Bring a Trailer integration
- eBay integration
- mobile app
- notifications
- advanced AI valuation
- multi-user accounts
