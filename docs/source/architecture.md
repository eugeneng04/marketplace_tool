# Architecture

## Overview

The app should use a modular architecture where Facebook Marketplace is only the first data source.

## Core Flow

Search Profile  
→ Facebook Marketplace Connector  
→ Raw Item Capture  
→ Cache Layer  
→ Deduplication  
→ Category Parser  
→ Snapshot and Price History Tracking  
→ Marketplace Trend Tracking  
→ Valuation and Deal Scoring  
→ UI

## Main Modules

### Web App

The frontend UI for creating search profiles, viewing listings, filtering results, and reviewing listing details.

### Worker

Runs search profiles, calls source connectors, processes listings, and updates the database.

### Core Package

Shared types, utility functions, status logic, scoring helpers, and deduplication helpers.

### Database Package

Database schema, migrations, and data-access functions.

### Parser Package

Category-specific parsers. MVP starts with vehicle parsing.

### Connectors Package

Source-specific data capture logic. MVP starts with Facebook Marketplace.

### Valuation Package

Deal scoring, price trend comparison, and local value estimates.

## Design Principle

The local database is the main search engine. Facebook Marketplace is only an input source.

## Modularity Requirement

Facebook-specific logic should stay inside the Facebook Marketplace connector. The rest of the app should work with normalized item objects.
