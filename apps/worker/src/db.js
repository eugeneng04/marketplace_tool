import { Pool } from "pg";
import { createId, nowIso } from "./utils.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS search_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  query TEXT NOT NULL,
  location TEXT NOT NULL,
  radius_miles INTEGER NOT NULL,
  min_price INTEGER,
  max_price INTEGER,
  filters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS search_runs (
  id TEXT PRIMARY KEY,
  search_profile_id TEXT NOT NULL REFERENCES search_profiles(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  results_found INTEGER NOT NULL DEFAULT 0,
  new_items INTEGER NOT NULL DEFAULT 0,
  existing_items INTEGER NOT NULL DEFAULT 0,
  detail_pages_opened INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS items (
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
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  seller_raw TEXT,
  current_price INTEGER,
  location_city TEXT,
  location_region TEXT,
  status TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_scraped_at TIMESTAMPTZ,
  possibly_gone_at TIMESTAMPTZ,
  parsed_attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  red_flags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  positive_signals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  parser_version TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS item_snapshots (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  captured_at TIMESTAMPTZ NOT NULL,
  title_raw TEXT,
  price_raw TEXT,
  parsed_price INTEGER,
  description_raw TEXT,
  location_raw TEXT,
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  availability_status TEXT
);

CREATE TABLE IF NOT EXISTS search_hits (
  id TEXT PRIMARY KEY,
  search_run_id TEXT NOT NULL REFERENCES search_runs(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  price INTEGER NOT NULL,
  price_raw TEXT,
  captured_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS parse_evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value TEXT,
  confidence REAL NOT NULL,
  evidence_text TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS modifications (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  mod_type TEXT NOT NULL,
  mod_name TEXT NOT NULL,
  brand TEXT,
  confidence REAL NOT NULL,
  evidence_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deal_scores (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  price_score INTEGER NOT NULL,
  quality_score INTEGER NOT NULL,
  confidence REAL NOT NULL,
  estimated_low INTEGER,
  estimated_high INTEGER,
  verdict TEXT NOT NULL,
  explanation_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  scored_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_normalized_url ON items(normalized_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_source_item ON items(source, source_item_id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_filters ON items(category, status, current_price, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_search_runs_profile_started ON search_runs(search_profile_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_scores_item_id ON deal_scores(item_id);
`;

export function createDb(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000
  });

  return {
    pool,
    close: async () => {
      await pool.end();
    }
  };
}

export async function migrate(db) {
  await db.pool.query(SCHEMA_SQL);
}

function mapProfileRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    query: row.query,
    location: row.location,
    radiusMiles: row.radius_miles,
    minPrice: row.min_price,
    maxPrice: row.max_price,
    filtersJson: row.filters_json ?? {},
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function createProfile(db, input) {
  const now = nowIso();
  const id = createId();
  const result = await db.pool.query(
    `
    INSERT INTO search_profiles (
      id, name, category, query, location, radius_miles, min_price, max_price, filters_json, enabled, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$11)
    RETURNING *
    `,
    [
      id,
      input.name,
      input.category,
      input.query,
      input.location,
      input.radiusMiles,
      input.minPrice,
      input.maxPrice,
      JSON.stringify(input.filtersJson ?? {}),
      input.enabled,
      now
    ]
  );

  return mapProfileRow(result.rows[0]);
}

export async function listProfiles(db) {
  const result = await db.pool.query("SELECT * FROM search_profiles ORDER BY created_at DESC");
  return result.rows.map(mapProfileRow);
}

export async function getProfile(db, profileId) {
  const result = await db.pool.query("SELECT * FROM search_profiles WHERE id = $1", [profileId]);
  if (result.rows.length === 0) {
    return null;
  }

  return mapProfileRow(result.rows[0]);
}

export async function listEnabledProfiles(db) {
  const result = await db.pool.query("SELECT * FROM search_profiles WHERE enabled = TRUE ORDER BY created_at ASC");
  return result.rows.map(mapProfileRow);
}

export async function startSearchRun(db, profileId, source) {
  const runId = createId();
  const startedAt = nowIso();

  await db.pool.query(
    `
    INSERT INTO search_runs (
      id, search_profile_id, source, started_at, status, results_found, new_items, existing_items, detail_pages_opened
    ) VALUES ($1,$2,$3,$4,'running',0,0,0,0)
    `,
    [runId, profileId, source, startedAt]
  );

  return { id: runId, startedAt };
}

export async function finishSearchRun(db, runId, summary) {
  await db.pool.query(
    `
    UPDATE search_runs
    SET finished_at = $2,
        status = $3,
        results_found = $4,
        new_items = $5,
        existing_items = $6,
        detail_pages_opened = $7,
        error_message = $8
    WHERE id = $1
    `,
    [
      runId,
      nowIso(),
      summary.status,
      summary.resultsFound,
      summary.newItems,
      summary.existingItems,
      summary.detailPagesOpened,
      summary.errorMessage ?? null
    ]
  );
}

export async function listRuns(db, profileId, limit = 50) {
  const params = [];
  let where = "";

  if (profileId) {
    params.push(profileId);
    where = `WHERE search_profile_id = $${params.length}`;
  }

  params.push(limit);

  const result = await db.pool.query(
    `
    SELECT * FROM search_runs
    ${where}
    ORDER BY started_at DESC
    LIMIT $${params.length}
    `,
    params
  );

  return result.rows;
}

export async function upsertRawItemSnapshot(db, args) {
  const { profile, runId, rank, rawItem, parsedPrice } = args;
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `
      SELECT * FROM items
      WHERE normalized_url = $1
         OR (source = $2 AND source_item_id = $3)
      ORDER BY updated_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [rawItem.normalizedUrl, rawItem.source, rawItem.sourceItemId ?? null]
    );

    let itemId;
    let isNew = false;
    let previousPrice = null;
    const now = nowIso();

    if (existingResult.rows.length === 0) {
      itemId = createId();
      isNew = true;
      await client.query(
        `
        INSERT INTO items (
          id, category, source, source_item_id, url, normalized_url, fingerprint,
          title_raw, description_raw, price_raw, location_raw, image_urls, seller_raw,
          current_price, location_city, location_region, status,
          first_seen_at, last_seen_at, last_scraped_at,
          created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,'new',$17,$17,$17,$17,$17
        )
        `,
        [
          itemId,
          profile.category,
          rawItem.source,
          rawItem.sourceItemId ?? null,
          rawItem.url,
          rawItem.normalizedUrl,
          rawItem.fingerprint ?? null,
          rawItem.titleRaw,
          rawItem.descriptionRaw ?? null,
          rawItem.priceRaw ?? null,
          rawItem.locationRaw ?? null,
          JSON.stringify(rawItem.imageUrls ?? []),
          rawItem.sellerRaw ?? null,
          parsedPrice,
          rawItem.locationCity ?? null,
          rawItem.locationRegion ?? profile.location,
          now
        ]
      );

      if (parsedPrice !== null) {
        await client.query(
          "INSERT INTO price_history (id, item_id, price, price_raw, captured_at) VALUES ($1,$2,$3,$4,$5)",
          [createId(), itemId, parsedPrice, rawItem.priceRaw ?? null, now]
        );
      }
    } else {
      const existing = existingResult.rows[0];
      itemId = existing.id;
      previousPrice = existing.current_price;
      await client.query(
        `
        UPDATE items
        SET
          title_raw = $2,
          description_raw = COALESCE($3, description_raw),
          price_raw = COALESCE($4, price_raw),
          location_raw = COALESCE($5, location_raw),
          image_urls = $6::jsonb,
          seller_raw = COALESCE($7, seller_raw),
          current_price = COALESCE($8, current_price),
          source_item_id = COALESCE($9, source_item_id),
          last_seen_at = $10,
          last_scraped_at = $10,
          updated_at = $10
        WHERE id = $1
        `,
        [
          itemId,
          rawItem.titleRaw,
          rawItem.descriptionRaw ?? null,
          rawItem.priceRaw ?? null,
          rawItem.locationRaw ?? null,
          JSON.stringify(rawItem.imageUrls ?? []),
          rawItem.sellerRaw ?? null,
          parsedPrice,
          rawItem.sourceItemId ?? null,
          now
        ]
      );

      if (parsedPrice !== null && previousPrice !== parsedPrice) {
        await client.query(
          "INSERT INTO price_history (id, item_id, price, price_raw, captured_at) VALUES ($1,$2,$3,$4,$5)",
          [createId(), itemId, parsedPrice, rawItem.priceRaw ?? null, now]
        );
      }
    }

    await client.query(
      "INSERT INTO search_hits (id, search_run_id, item_id, rank, seen_at) VALUES ($1,$2,$3,$4,$5)",
      [createId(), runId, itemId, rank, now]
    );

    await client.query(
      `
      INSERT INTO item_snapshots (
        id, item_id, captured_at, title_raw, price_raw, parsed_price, description_raw, location_raw, image_urls, availability_status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      `,
      [
        createId(),
        itemId,
        now,
        rawItem.titleRaw,
        rawItem.priceRaw ?? null,
        parsedPrice,
        rawItem.descriptionRaw ?? null,
        rawItem.locationRaw ?? null,
        JSON.stringify(rawItem.imageUrls ?? []),
        "active"
      ]
    );

    await client.query("COMMIT");

    return {
      itemId,
      isNew,
      priceChanged: parsedPrice !== null && previousPrice !== null && previousPrice !== parsedPrice
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function saveParsedItem(db, itemId, parsed) {
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `
      UPDATE items
      SET parsed_attributes_json = $2::jsonb,
          red_flags_json = $3::jsonb,
          positive_signals_json = $4::jsonb,
          parser_version = $5,
          updated_at = $6
      WHERE id = $1
      `,
      [
        itemId,
        JSON.stringify(parsed.attributes),
        JSON.stringify(parsed.redFlags),
        JSON.stringify(parsed.positiveSignals),
        parsed.parserVersion,
        nowIso()
      ]
    );

    await client.query("DELETE FROM parse_evidence WHERE item_id = $1", [itemId]);
    for (const evidence of parsed.evidence) {
      await client.query(
        `
        INSERT INTO parse_evidence (id, item_id, field, value, confidence, evidence_text, parser_version, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [
          createId(),
          itemId,
          evidence.field,
          evidence.value === null || evidence.value === undefined ? null : `${evidence.value}`,
          evidence.confidence,
          evidence.evidenceText,
          parsed.parserVersion,
          nowIso()
        ]
      );
    }

    await client.query("DELETE FROM modifications WHERE item_id = $1", [itemId]);
    for (const mod of parsed.modifications) {
      await client.query(
        `
        INSERT INTO modifications (id, item_id, category, mod_type, mod_name, brand, confidence, evidence_text)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `,
        [createId(), itemId, "vehicle", mod.modType, mod.modName, mod.brand ?? null, mod.confidence, mod.evidenceText]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listListings(db, filters = {}) {
  const conditions = [];
  const params = [];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }

  if (filters.minPrice !== null && filters.minPrice !== undefined) {
    params.push(filters.minPrice);
    conditions.push(`current_price >= $${params.length}`);
  }

  if (filters.maxPrice !== null && filters.maxPrice !== undefined) {
    params.push(filters.maxPrice);
    conditions.push(`current_price <= $${params.length}`);
  }

  if (filters.make) {
    params.push(filters.make.toLowerCase());
    conditions.push(`LOWER(parsed_attributes_json->>'make') = $${params.length}`);
  }

  if (filters.model) {
    params.push(filters.model.toLowerCase());
    conditions.push(`LOWER(parsed_attributes_json->>'model') = $${params.length}`);
  }

  if (filters.transmission) {
    params.push(filters.transmission.toLowerCase());
    conditions.push(`LOWER(parsed_attributes_json->>'transmission') = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.min(filters.limit, 200)) : 50;
  const offset = Number.isFinite(filters.offset) ? Math.max(0, filters.offset) : 0;

  params.push(limit);
  params.push(offset);

  const result = await db.pool.query(
    `
    SELECT
      i.*,
      ds.score AS deal_score,
      ds.price_score,
      ds.quality_score,
      ds.confidence AS deal_confidence,
      ds.estimated_low,
      ds.estimated_high,
      ds.verdict,
      ds.explanation_json,
      ds.scored_at
    FROM items i
    LEFT JOIN deal_scores ds ON ds.item_id = i.id
    ${whereClause}
    ORDER BY i.last_seen_at DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );

  return result.rows;
}

export async function getListingById(db, itemId) {
  const listingResult = await db.pool.query(
    `
    SELECT i.*, ds.score AS deal_score, ds.price_score, ds.quality_score, ds.confidence AS deal_confidence,
           ds.estimated_low, ds.estimated_high, ds.verdict, ds.explanation_json, ds.scored_at
    FROM items i
    LEFT JOIN deal_scores ds ON ds.item_id = i.id
    WHERE i.id = $1
    `,
    [itemId]
  );

  if (listingResult.rows.length === 0) {
    return null;
  }

  const [item] = listingResult.rows;

  const [historyResult, evidenceResult, modificationsResult] = await Promise.all([
    db.pool.query("SELECT * FROM price_history WHERE item_id = $1 ORDER BY captured_at DESC LIMIT 100", [itemId]),
    db.pool.query("SELECT * FROM parse_evidence WHERE item_id = $1 ORDER BY created_at DESC", [itemId]),
    db.pool.query("SELECT * FROM modifications WHERE item_id = $1", [itemId])
  ]);

  return {
    item,
    priceHistory: historyResult.rows,
    parseEvidence: evidenceResult.rows,
    modifications: modificationsResult.rows
  };
}

export async function computeMarketStats(db, args) {
  const result = await db.pool.query(
    `
    SELECT
      COUNT(*)::INTEGER AS sample_size,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY current_price) AS median_price,
      percentile_cont(0.25) WITHIN GROUP (ORDER BY current_price) AS p25_price,
      percentile_cont(0.75) WITHIN GROUP (ORDER BY current_price) AS p75_price
    FROM items
    WHERE category = $1
      AND id <> $2
      AND current_price IS NOT NULL
      AND ($3::TEXT IS NULL OR LOWER(parsed_attributes_json->>'make') = LOWER($3))
      AND ($4::TEXT IS NULL OR LOWER(parsed_attributes_json->>'model') = LOWER($4))
      AND ($5::TEXT IS NULL OR location_region = $5)
    `,
    [args.category, args.excludeItemId, args.make ?? null, args.model ?? null, args.locationRegion ?? null]
  );

  return result.rows[0];
}

export async function upsertDealScore(db, itemId, score) {
  await db.pool.query(
    `
    INSERT INTO deal_scores (
      id, item_id, score, price_score, quality_score, confidence,
      estimated_low, estimated_high, verdict, explanation_json, scored_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11
    )
    ON CONFLICT (item_id) DO UPDATE SET
      score = EXCLUDED.score,
      price_score = EXCLUDED.price_score,
      quality_score = EXCLUDED.quality_score,
      confidence = EXCLUDED.confidence,
      estimated_low = EXCLUDED.estimated_low,
      estimated_high = EXCLUDED.estimated_high,
      verdict = EXCLUDED.verdict,
      explanation_json = EXCLUDED.explanation_json,
      scored_at = EXCLUDED.scored_at
    `,
    [
      createId(),
      itemId,
      score.score,
      score.priceScore,
      score.qualityScore,
      score.confidence,
      score.estimatedLow,
      score.estimatedHigh,
      score.verdict,
      JSON.stringify(score.explanation),
      nowIso()
    ]
  );
}
