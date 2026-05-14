-- Resale Intelligence MVP schema draft
-- Derived from docs/source/backend/database-design.md

CREATE TABLE search_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  query TEXT NOT NULL,
  location TEXT NOT NULL,
  radius_miles INTEGER NOT NULL,
  min_price INTEGER,
  max_price INTEGER,
  filters_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE search_runs (
  id TEXT PRIMARY KEY,
  search_profile_id TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  results_found INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  existing_items INTEGER NOT NULL DEFAULT 0,
  detail_pages_opened INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  FOREIGN KEY (search_profile_id) REFERENCES search_profiles(id)
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  source_item_id TEXT,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  fingerprint TEXT,
  title_raw TEXT NOT NULL,
  description_raw TEXT,
  price_raw TEXT,
  location_raw TEXT,
  image_urls TEXT NOT NULL,
  seller_raw TEXT,
  current_price INTEGER,
  location_city TEXT,
  location_region TEXT,
  latitude REAL,
  longitude REAL,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_scraped_at TEXT,
  possibly_gone_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE item_snapshots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  title_raw TEXT,
  price_raw TEXT,
  parsed_price INTEGER,
  description_raw TEXT,
  location_raw TEXT,
  image_urls TEXT NOT NULL,
  availability_status TEXT,
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE search_hits (
  id TEXT PRIMARY KEY,
  search_run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  seen_at TEXT NOT NULL,
  FOREIGN KEY (search_run_id) REFERENCES search_runs(id),
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE price_history (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  price_raw TEXT,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE parse_evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  confidence REAL NOT NULL,
  evidence_text TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE modifications (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  category TEXT NOT NULL,
  mod_type TEXT NOT NULL,
  mod_name TEXT NOT NULL,
  brand TEXT,
  confidence REAL NOT NULL,
  evidence_text TEXT NOT NULL,
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE price_observations (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  search_profile_id TEXT,
  observed_price INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  location_city TEXT,
  location_region TEXT,
  attributes_json TEXT,
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (search_profile_id) REFERENCES search_profiles(id)
);

CREATE TABLE market_trend_daily (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  query_key TEXT NOT NULL,
  location_region TEXT NOT NULL,
  date TEXT NOT NULL,
  median_ask INTEGER,
  p25_ask INTEGER,
  p75_ask INTEGER,
  listing_count INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  disappeared_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE market_segments (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  segment_key TEXT NOT NULL,
  location_region TEXT NOT NULL,
  median_price INTEGER,
  median_mileage INTEGER,
  sample_size INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE comparable_sales (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  source_item_id TEXT,
  url TEXT,
  title_raw TEXT,
  description_raw TEXT,
  sold_price INTEGER,
  sold_at TEXT,
  location_raw TEXT,
  image_urls TEXT,
  parsed_attributes_json TEXT,
  modifications_json TEXT,
  condition_grade TEXT,
  confidence REAL,
  source_metadata TEXT
);
