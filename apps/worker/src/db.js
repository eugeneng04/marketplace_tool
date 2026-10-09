import { Pool } from "pg";
import { createId, nowIso, parsePrice } from "./utils.js";
import { mergeListingObservation, rawItemFromListing, listingCollectionState, parseListingObservation } from "./listingDetails.js";
import { qualifyProfile } from "./profileQualification.js";
import { scoreListing } from "./dealScoring.js";
import { SUGGESTED_GENERATIONS, validateGeneration } from "./vehicleGenerations.js";

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
  alert_min_score INTEGER NOT NULL DEFAULT 70,
  alert_min_confidence REAL NOT NULL DEFAULT 0.5,
  alert_max_age_hours INTEGER NOT NULL DEFAULT 72,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS search_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  interval_minutes INTEGER NOT NULL DEFAULT 0 CHECK (interval_minutes >= 0),
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS collector_jobs (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  args_json JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  result_json JSONB,
  error_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicle_generations (
  id TEXT PRIMARY KEY,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  code TEXT NOT NULL,
  year_from INTEGER NOT NULL,
  year_to INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(make, model, code)
);
INSERT INTO vehicle_generations(id,make,model,code,year_from,year_to,source,created_at,updated_at)
VALUES ${SUGGESTED_GENERATIONS.map((entry, i) => `('generation-suggested-${i + 1}','${entry.make}','${entry.model}','${entry.code}',${entry.yearFrom},${entry.yearTo},'suggested',NOW(),NOW())`).join(",")}
ON CONFLICT(make,model,code) DO NOTHING;
ALTER TABLE search_profiles ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES search_groups(id) ON DELETE SET NULL;
INSERT INTO search_groups(id, name, interval_minutes, next_run_at, created_at, updated_at)
SELECT 'group-subaru-brz-frs', 'Subaru BRZ + Scion FR-S', 0, NULL, NOW(), NOW()
WHERE EXISTS (SELECT 1 FROM search_profiles WHERE LOWER(TRIM(name)) = 'brz' OR LOWER(TRIM(query)) = 'brz')
  AND EXISTS (SELECT 1 FROM search_profiles WHERE LOWER(TRIM(name)) = 'frs' OR LOWER(TRIM(query)) = 'frs')
ON CONFLICT (name) DO NOTHING;
UPDATE search_profiles SET group_id = (
  SELECT id FROM search_groups WHERE name = 'Subaru BRZ + Scion FR-S'
)
WHERE group_id IS NULL
  AND (LOWER(TRIM(name)) IN ('brz', 'frs') OR LOWER(TRIM(query)) IN ('brz', 'frs'))
  AND EXISTS (SELECT 1 FROM search_groups WHERE name = 'Subaru BRZ + Scion FR-S');

ALTER TABLE search_profiles ADD COLUMN IF NOT EXISTS alert_min_score INTEGER NOT NULL DEFAULT 70;
ALTER TABLE search_profiles ADD COLUMN IF NOT EXISTS alert_min_confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE search_profiles ADD COLUMN IF NOT EXISTS alert_max_age_hours INTEGER NOT NULL DEFAULT 72;

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
  posted_at TIMESTAMPTZ,
  last_scraped_at TIMESTAMPTZ,
  possibly_gone_at TIMESTAMPTZ,
  parsed_attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  red_flags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  positive_signals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  parser_version TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE items ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

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

CREATE TABLE IF NOT EXISTS deal_alerts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES search_profiles(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  read_at TIMESTAMPTZ,
  UNIQUE (profile_id, item_id)
);

CREATE TABLE IF NOT EXISTS comparable_sales (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  url TEXT,
  title_raw TEXT,
  sold_price INTEGER NOT NULL,
  sold_at TIMESTAMPTZ,
  mileage INTEGER,
  transmission TEXT NOT NULL DEFAULT 'unknown',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE comparable_sales ADD COLUMN IF NOT EXISTS mileage INTEGER;
ALTER TABLE comparable_sales ADD COLUMN IF NOT EXISTS transmission TEXT NOT NULL DEFAULT 'unknown';

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_normalized_url ON items(normalized_url);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_source_item ON items(source, source_item_id) WHERE source_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_filters ON items(category, status, current_price, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_search_runs_profile_started ON search_runs(search_profile_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deal_scores_item_id ON deal_scores(item_id);
CREATE INDEX IF NOT EXISTS idx_deal_alerts_created ON deal_alerts(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comps_item_url ON comparable_sales(item_id, url);
`;

function nullableTimestamp(value) {
  return value === "" || (typeof value === "string" && value.trim() === "") ? null : value ?? null;
}

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

export async function recoverInterruptedSearchRuns(db) {
  await db.pool.query(`
    UPDATE search_runs
    SET status = 'failed', finished_at = NOW(),
        error_message = COALESCE(error_message, 'Run was interrupted when the worker restarted.')
    WHERE status = 'running'
  `);
}

function mapGeneration(row) {
  return { id: row.id, make: row.make, model: row.model, code: row.code, yearFrom: row.year_from, yearTo: row.year_to, source: row.source };
}

export async function listVehicleGenerations(db) {
  const result = await db.pool.query("SELECT * FROM vehicle_generations WHERE source <> 'hidden' ORDER BY make, model, year_from, code");
  return result.rows.map(mapGeneration);
}

export async function createVehicleGeneration(db, input) {
  const generation = validateGeneration(input);
  const now = nowIso();
  const result = await db.pool.query("INSERT INTO vehicle_generations(id,make,model,code,year_from,year_to,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'manual',$7,$7) RETURNING *", [createId(), generation.make, generation.model, generation.code, generation.yearFrom, generation.yearTo, now]);
  return mapGeneration(result.rows[0]);
}

export async function updateVehicleGeneration(db, id, input) {
  const generation = validateGeneration(input);
  const result = await db.pool.query("UPDATE vehicle_generations SET make=$2,model=$3,code=$4,year_from=$5,year_to=$6,source='manual',updated_at=NOW() WHERE id=$1 RETURNING *", [id, generation.make, generation.model, generation.code, generation.yearFrom, generation.yearTo]);
  return result.rows[0] ? mapGeneration(result.rows[0]) : null;
}

export async function deleteVehicleGeneration(db, id) {
  const hidden = await db.pool.query("UPDATE vehicle_generations SET source='hidden',updated_at=NOW() WHERE id=$1 AND source='suggested'", [id]);
  if (hidden.rowCount > 0) return true;
  const result = await db.pool.query("DELETE FROM vehicle_generations WHERE id=$1", [id]);
  return result.rowCount > 0;
}

export async function getSearchDefaults(db) {
  const saved = await db.pool.query("SELECT value_json FROM app_settings WHERE key='search_defaults'");
  if (saved.rows[0]?.value_json) return saved.rows[0].value_json;
  const common = await db.pool.query(`SELECT location, radius_miles FROM search_profiles GROUP BY location, radius_miles ORDER BY COUNT(*) DESC, MAX(updated_at) DESC LIMIT 1`);
  const row = common.rows[0];
  return { location: row?.location ?? "Milpitas", radiusMiles: row?.radius_miles ?? 50 };
}

export async function saveSearchDefaults(db, input) {
  const location = `${input.location ?? ""}`.trim();
  const radiusMiles = Math.round(Number(input.radiusMiles));
  if (!location) throw new Error("Default city or ZIP code is required.");
  if (!Number.isFinite(radiusMiles) || radiusMiles < 1 || radiusMiles > 500) throw new Error("Default radius must be between 1 and 500 miles.");
  const value = { location, radiusMiles };
  await db.pool.query(`INSERT INTO app_settings(key,value_json,updated_at) VALUES('search_defaults',$1::jsonb,$2) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json, updated_at=EXCLUDED.updated_at`, [JSON.stringify(value), nowIso()]);
  return value;
}

export async function listSearchGroups(db) {
  const result = await db.pool.query(`SELECT g.*, COALESCE(json_agg(json_build_object('id',p.id,'name',p.name,'query',p.query,'enabled',p.enabled)) FILTER (WHERE p.id IS NOT NULL), '[]') AS profiles FROM search_groups g LEFT JOIN search_profiles p ON p.group_id=g.id GROUP BY g.id ORDER BY g.name`);
  return result.rows.map((row) => ({ id: row.id, name: row.name, intervalMinutes: row.interval_minutes, nextRunAt: row.next_run_at, profiles: row.profiles }));
}

export async function createSearchGroup(db, { name, intervalMinutes = 0 }) {
  const now = nowIso();
  const id = createId();
  const minutes = Math.max(0, Math.min(10080, Math.round(Number(intervalMinutes) || 0)));
  const result = await db.pool.query(`INSERT INTO search_groups(id,name,interval_minutes,next_run_at,created_at,updated_at) VALUES($1,$2,$3,CASE WHEN $3 > 0 THEN NOW() + ($3 * INTERVAL '1 minute') END,$4,$4) RETURNING *`, [id, `${name}`.trim(), minutes, now]);
  const row = result.rows[0];
  return { id: row.id, name: row.name, intervalMinutes: row.interval_minutes, nextRunAt: row.next_run_at, profiles: [] };
}

export async function updateSearchGroupSchedule(db, groupId, intervalMinutes) {
  const minutes = Math.max(0, Math.min(10080, Math.round(Number(intervalMinutes) || 0)));
  const result = await db.pool.query("UPDATE search_groups SET interval_minutes=$2, next_run_at=CASE WHEN $2 > 0 THEN NOW() + ($2 * INTERVAL '1 minute') ELSE NULL END, updated_at=NOW() WHERE id=$1 RETURNING *", [groupId, minutes]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { id: row.id, name: row.name, intervalMinutes: row.interval_minutes, nextRunAt: row.next_run_at };
}

export async function updateProfileGroup(db, profileId, groupId) {
  const result = await db.pool.query('UPDATE search_profiles SET group_id=$2, updated_at=NOW() WHERE id=$1 RETURNING id', [profileId, groupId || null]);
  return result.rowCount > 0;
}

export async function listDueSearchGroups(db) {
  const result = await db.pool.query('SELECT * FROM search_groups WHERE interval_minutes > 0 AND next_run_at <= NOW() ORDER BY next_run_at');
  return result.rows;
}

export async function advanceSearchGroup(db, groupId, intervalMinutes) {
  await db.pool.query("UPDATE search_groups SET next_run_at=NOW() + ($2 * INTERVAL '1 minute'), updated_at=NOW() WHERE id=$1", [groupId, intervalMinutes]);
}

function mapProfileRow(row) {
  const filters = row.filters_json ?? {};
  return {
    id: row.id,
    groupId: row.group_id ?? null,
    name: row.name,
    category: row.category,
    query: row.query,
    location: row.location,
    radiusMiles: row.radius_miles,
    minPrice: row.min_price,
    maxPrice: row.max_price,
    filtersJson: filters,
    enabled: row.enabled,
    alertMinScore:
      row.alert_min_score ?? filters.alertMinScore ?? filters.alert_min_score ?? 70,
    alertMinConfidence:
      row.alert_min_confidence ?? filters.alertMinConfidence ?? filters.alert_min_confidence ?? 0.5,
    alertMaxAgeHours:
      row.alert_max_age_hours ?? filters.alertMaxAgeHours ?? filters.alert_max_age_hours ?? 72,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function normalizeAlertInput(input = {}, fallback = {}) {
  const pick = (value, fb) => {
    if (value === undefined || value === null || value === "") {
      return fb;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fb;
  };

  const minScore = Math.min(100, Math.max(0, Math.round(pick(input.alertMinScore ?? input.alert_min_score, fallback.alertMinScore ?? 70))));
  let minConfidence = pick(
    input.alertMinConfidence ?? input.alert_min_confidence,
    fallback.alertMinConfidence ?? 0.5
  );
  if (minConfidence > 1) {
    minConfidence /= 100;
  }
  minConfidence = Math.min(1, Math.max(0, minConfidence));
  const maxAgeRaw = pick(input.alertMaxAgeHours ?? input.alert_max_age_hours, fallback.alertMaxAgeHours ?? 72);
  const maxAgeHours = maxAgeRaw === null || maxAgeRaw === undefined ? 72 : Math.max(1, Math.round(maxAgeRaw));

  return { minScore, minConfidence, maxAgeHours };
}

export async function createProfile(db, input) {
  const now = nowIso();
  const id = createId();
  const alerts = normalizeAlertInput(input, {});
  const result = await db.pool.query(
    `
    INSERT INTO search_profiles (
      id, name, category, query, location, radius_miles, min_price, max_price, filters_json, enabled, group_id,
      alert_min_score, alert_min_confidence, alert_max_age_hours, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$15)
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
      input.groupId ?? null,
      alerts.minScore,
      alerts.minConfidence,
      alerts.maxAgeHours,
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

export async function updateProfile(db, profileId, input) {
  const existing = await getProfile(db, profileId);
  if (!existing) {
    return null;
  }

  const alerts = normalizeAlertInput(input, existing);
  const updated = {
    name: input.name !== undefined ? `${input.name}` : existing.name,
    category: input.category !== undefined ? `${input.category}` : existing.category,
    query: input.query !== undefined ? `${input.query}` : existing.query,
    location: input.location !== undefined ? `${input.location}` : existing.location,
    radiusMiles: input.radiusMiles !== undefined ? input.radiusMiles : existing.radiusMiles,
    minPrice: input.minPrice !== undefined ? input.minPrice : existing.minPrice,
    maxPrice: input.maxPrice !== undefined ? input.maxPrice : existing.maxPrice,
    filtersJson:
      input.filtersJson && typeof input.filtersJson === "object" ? input.filtersJson : existing.filtersJson ?? {},
    enabled: input.enabled !== undefined ? input.enabled !== false : existing.enabled
  };

  const result = await db.pool.query(
    `
    UPDATE search_profiles
    SET name = $2,
        category = $3,
        query = $4,
        location = $5,
        radius_miles = $6,
        min_price = $7,
        max_price = $8,
        filters_json = $9::jsonb,
        enabled = $10,
        alert_min_score = $11,
        alert_min_confidence = $12,
        alert_max_age_hours = $13,
        updated_at = $14
    WHERE id = $1
    RETURNING *
    `,
    [
      profileId,
      updated.name,
      updated.category,
      updated.query,
      updated.location,
      updated.radiusMiles,
      updated.minPrice,
      updated.maxPrice,
      JSON.stringify(updated.filtersJson),
      updated.enabled,
      alerts.minScore,
      alerts.minConfidence,
      alerts.maxAgeHours,
      nowIso()
    ]
  );

  return mapProfileRow(result.rows[0]);
}

export async function listDeals(db, limit = 30) {
  const result = await db.pool.query(
    `
    SELECT i.*, ds.score AS deal_score, ds.price_score, ds.quality_score,
           ds.confidence AS deal_confidence, ds.estimated_low, ds.estimated_high,
           ds.verdict, ds.explanation_json, ds.scored_at
    FROM items i
    JOIN deal_scores ds ON ds.item_id = i.id
    WHERE i.status NOT IN ('hidden', 'rejected', 'sold', 'possibly_gone')
    ORDER BY ds.score DESC, ds.confidence DESC, i.posted_at DESC NULLS LAST, i.last_seen_at DESC
    LIMIT $1
    `,
    [Math.max(1, Math.min(Number(limit) || 30, 100))]
  );
  return addListingCollectionState(db, result.rows);
}

export async function createDealAlert(db, profileId, itemId) {
  const result = await db.pool.query(
    `INSERT INTO deal_alerts (id, profile_id, item_id, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (profile_id, item_id) DO NOTHING
     RETURNING id`,
    [createId(), profileId, itemId, nowIso()]
  );
  return result.rowCount > 0;
}

export async function listDealAlerts(db, options = {}) {
  const normalized = typeof options === "number" ? { limit: options } : options ?? {};
  const limitInput = normalized.limit ?? 30;
  const limit = Math.max(1, Math.min(Number(limitInput) || 30, 100));
  const conditions = [];
  const params = [];

  if (normalized.unreadOnly) {
    conditions.push("a.read_at IS NULL");
  }

  if (normalized.profileId) {
    params.push(normalized.profileId);
    conditions.push(`a.profile_id = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const result = await db.pool.query(
    `SELECT a.id, a.profile_id, a.item_id, a.created_at, a.read_at,
            p.name AS profile_name, i.title_raw, i.current_price, i.price_raw,
            i.location_raw, i.image_urls, i.url, i.posted_at, i.last_seen_at, i.status,
            ds.score AS deal_score, ds.confidence AS deal_confidence, ds.verdict, ds.explanation_json
     FROM deal_alerts a
     JOIN search_profiles p ON p.id = a.profile_id
     JOIN items i ON i.id = a.item_id
     LEFT JOIN deal_scores ds ON ds.item_id = i.id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

export async function markDealAlertRead(db, alertId) {
  const result = await db.pool.query(
    "UPDATE deal_alerts SET read_at = COALESCE(read_at, $2) WHERE id = $1 RETURNING id",
    [alertId, nowIso()]
  );
  return result.rowCount > 0;
}

export async function createComp(db, itemId, comp) {
  const result = await db.pool.query(
    `
    INSERT INTO comparable_sales (id, item_id, source, url, title_raw, sold_price, sold_at, mileage, transmission, note, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11)
    ON CONFLICT (item_id, url) DO NOTHING
    RETURNING *
    `,
    [
      createId(),
      itemId,
      comp.source,
      comp.url,
      comp.title,
      comp.soldPrice,
      nullableTimestamp(comp.soldAt),
      comp.mileage ?? null,
      comp.transmission ?? "unknown",
      comp.note,
      nowIso()
    ]
  );
  return result.rows[0] ?? null;
}

export async function listCompsByItem(db, itemId) {
  const result = await db.pool.query(
    "SELECT * FROM comparable_sales WHERE item_id = $1 ORDER BY sold_at DESC NULLS LAST, created_at DESC",
    [itemId]
  );
  return result.rows;
}

export async function deleteComp(db, compId) {
  const result = await db.pool.query("DELETE FROM comparable_sales WHERE id = $1 RETURNING id", [compId]);
  return result.rows.length > 0;
}

export async function deleteProfile(db, profileId) {
  const result = await db.pool.query("DELETE FROM search_profiles WHERE id = $1 RETURNING id", [profileId]);
  return result.rows.length > 0;
}

export async function listEnabledProfiles(db) {
  const result = await db.pool.query("SELECT * FROM search_profiles WHERE enabled = TRUE ORDER BY created_at ASC");
  return result.rows.map(mapProfileRow);
}

export async function getItemRefreshState(db, identity) {
  if (!identity.normalizedUrl && !identity.sourceItemId) {
    return null;
  }

  const result = await db.pool.query(
    `
    SELECT * FROM items
    WHERE ($1::TEXT IS NOT NULL AND normalized_url = $1)
       OR ($2::TEXT IS NOT NULL AND source = 'facebook_marketplace' AND source_item_id = $2)
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [identity.normalizedUrl ?? null, identity.sourceItemId ?? null]
  );

  return result.rows[0] ?? null;
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

export async function finishSearchRun(db, runId, summary, alertProfileId = null, alertItemIds = []) {
  const client = await db.pool.connect();
  let alertsCreated = 0;
  try {
    await client.query("BEGIN");
    if (summary.status === "completed" && alertProfileId) {
      for (const itemId of new Set(alertItemIds)) {
        const result = await client.query(
          `INSERT INTO deal_alerts (id, profile_id, item_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (profile_id, item_id) DO NOTHING
           RETURNING id`,
          [createId(), alertProfileId, itemId, nowIso()]
        );
        alertsCreated += result.rowCount;
      }
    }
    await client.query(
      `UPDATE search_runs
       SET finished_at = $2, status = $3, results_found = $4, new_items = $5,
           existing_items = $6, detail_pages_opened = $7, error_message = $8
       WHERE id = $1`,
      [runId, nowIso(), summary.status, summary.resultsFound, summary.newItems,
        summary.existingItems, summary.detailPagesOpened, summary.errorMessage ?? null]
    );
    await client.query("COMMIT");
    return alertsCreated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listRuns(db, profileId, limit = 50) {
  // A worker restart can interrupt a run after its initial INSERT and leave a
  // permanent "running" row. Runs normally finish well inside this window.
  await db.pool.query(`
    UPDATE search_runs
    SET status = 'failed', finished_at = NOW(),
        error_message = COALESCE(error_message, 'Run was interrupted before it could finish.')
    WHERE status = 'running' AND started_at < NOW() - INTERVAL '15 minutes'
  `);

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
  const { profile, runId, rank, itemId: requestedItemId, preferManualTransmission } = args;
  const observedAt = new Date(args.observedAt ?? args.rawItem.capturedAt ?? nowIso()).toISOString();
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const existingResult = await client.query(
      `SELECT * FROM items
       WHERE ($1::TEXT IS NOT NULL AND id = $1)
          OR ($1::TEXT IS NULL AND (normalized_url = $2 OR (source = $3 AND source_item_id = $4)))
       ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [requestedItemId ?? null, args.rawItem.normalizedUrl, args.rawItem.source, args.rawItem.sourceItemId ?? null]
    );
    const existing = existingResult.rows[0];
    if (requestedItemId && !existing) throw new Error("Listing not found");
    const itemId = existing?.id ?? createId();
    const isNew = !existing;
    const latestObservation = existing ? Math.max(
      new Date(existing.last_seen_at ?? 0).getTime(),
      new Date(existing.last_scraped_at ?? 0).getTime()
    ) : 0;
    const applied = new Date(observedAt).getTime() >= latestObservation;
    const rawItem = applied ? mergeListingObservation(existing, args.rawItem) : rawItemFromListing(existing);
    const priorEvidence = existing ? (await client.query(
      'SELECT field,value,confidence,evidence_text AS "evidenceText" FROM parse_evidence WHERE item_id=$1', [itemId]
    )).rows : [];
    const priorModifications = existing ? (await client.query(
      'SELECT mod_type AS "modType",mod_name AS "modName",brand,confidence,evidence_text AS "evidenceText" FROM modifications WHERE item_id=$1', [itemId]
    )).rows : [];
    const parsed = parseListingObservation(existing, applied ? args.rawItem : {}, {
      evidence: priorEvidence, modifications: priorModifications
    });
    const qualification = profile ? qualifyProfile(profile, rawItem, parsed) : null;
    if (qualification?.state === "mismatch") {
      await client.query("COMMIT");
      return { itemId, isNew: false, excluded: true, qualification };
    }
    const detailFetched = applied && args.rawItem.sourceMetadata?.detailFetched === true;
    const parsedPrice = parsePrice(rawItem.priceRaw) ?? existing?.current_price ?? null;
    const previousAttributes = existing?.parsed_attributes_json ?? {};
    if (detailFetched) parsed.attributes.detailRefresh = { status: "complete", attemptedAt: observedAt };
    else if (previousAttributes.detailRefresh) parsed.attributes.detailRefresh = previousAttributes.detailRefresh;
    if (parsedPrice !== null) parsed.attributes.price = parsedPrice;
    const previousPrice = existing?.current_price ?? null;
    const item = {
      ...existing, id: itemId, category: existing?.category ?? profile.category,
      source: existing?.source ?? rawItem.source, source_item_id: rawItem.sourceItemId ?? existing?.source_item_id,
      url: existing?.url ?? rawItem.url, normalized_url: existing?.normalized_url ?? rawItem.normalizedUrl,
      title_raw: rawItem.titleRaw, description_raw: rawItem.descriptionRaw ?? null,
      price_raw: rawItem.priceRaw ?? null, current_price: parsedPrice,
      location_raw: rawItem.locationRaw ?? null, location_city: rawItem.locationCity ?? null,
      location_region: rawItem.locationRegion ?? existing?.location_region ?? profile?.location ?? null,
      image_urls: rawItem.imageUrls ?? [], seller_raw: rawItem.sellerRaw ?? null,
      posted_at: nullableTimestamp(rawItem.sourceMetadata?.postedDate),
      status: existing?.status ?? "new", first_seen_at: existing?.first_seen_at ?? observedAt,
      last_seen_at: runId || isNew ? observedAt : existing.last_seen_at,
      last_scraped_at: detailFetched ? observedAt : existing?.last_scraped_at ?? null,
      parsed_attributes_json: parsed.attributes
    };
    if (isNew) {
      await client.query(
        `INSERT INTO items (
           id, category, source, source_item_id, url, normalized_url, fingerprint,
           title_raw, description_raw, price_raw, location_raw, image_urls, seller_raw,
           current_price, location_city, location_region, status, first_seen_at, last_seen_at,
           posted_at, last_scraped_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,'new',$17,$17,$18,$19,$17,$17)`,
        [itemId, item.category, item.source, item.source_item_id ?? null, item.url, item.normalized_url,
          rawItem.fingerprint ?? null, item.title_raw, item.description_raw, item.price_raw, item.location_raw,
          JSON.stringify(item.image_urls), item.seller_raw, parsedPrice, item.location_city,
          item.location_region, observedAt, item.posted_at, item.last_scraped_at]
      );
    } else if (applied) {
      await client.query(
        `UPDATE items SET title_raw=$2, description_raw=$3, price_raw=$4, location_raw=$5,
           image_urls=$6::jsonb, seller_raw=$7, current_price=$8, source_item_id=COALESCE($9,source_item_id),
           posted_at=COALESCE($10::timestamptz,posted_at), last_seen_at=$11, last_scraped_at=$12,
           location_city=COALESCE($13,location_city), location_region=COALESCE($14,location_region), updated_at=$15
         WHERE id=$1`,
        [itemId, item.title_raw, item.description_raw, item.price_raw, item.location_raw,
          JSON.stringify(item.image_urls), item.seller_raw, parsedPrice, item.source_item_id ?? null,
          item.posted_at, item.last_seen_at, item.last_scraped_at, item.location_city, item.location_region, observedAt]
      );
    }
    if (applied && parsedPrice !== null && previousPrice !== parsedPrice) {
      await client.query("INSERT INTO price_history (id,item_id,price,price_raw,captured_at) VALUES ($1,$2,$3,$4,$5)",
        [createId(), itemId, parsedPrice, rawItem.priceRaw ?? null, observedAt]);
    }
    if (runId) {
      await client.query("INSERT INTO search_hits (id,search_run_id,item_id,rank,seen_at) VALUES ($1,$2,$3,$4,$5)",
        [createId(), runId, itemId, rank, observedAt]);
    }
    if (applied) {
      await client.query(
        `INSERT INTO item_snapshots (id,item_id,captured_at,title_raw,price_raw,parsed_price,description_raw,location_raw,image_urls,availability_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [createId(), itemId, observedAt, rawItem.titleRaw, rawItem.priceRaw ?? null, parsedPrice,
          rawItem.descriptionRaw ?? null, rawItem.locationRaw ?? null, JSON.stringify(rawItem.imageUrls ?? []),
          rawItem.sourceMetadata?.isSold ? "sold" : rawItem.sourceMetadata?.isPending ? "pending" : "active"]
      );
      await writeParsedItem(client, itemId, parsed, observedAt);
    }
    const marketStats = await computeMarketStats({ pool: client }, {
      category: item.category, excludeItemId: itemId, make: parsed.attributes.make ?? null,
      model: parsed.attributes.model ?? null, locationRegion: item.location_region
    });
    const score = scoreListing({ itemPrice: parsedPrice, parsed, marketStats, preferManualTransmission });
    if (applied) await upsertDealScore({ pool: client }, itemId, score, observedAt);
    await client.query("COMMIT");
    return { itemId, isNew, applied, rawItem, parsed, score, item, qualification,
      priceChanged: applied && previousPrice !== null && previousPrice !== parsedPrice };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function writeParsedItem(client, itemId, parsed, observedAt) {
  await client.query(
    `UPDATE items SET parsed_attributes_json=$2::jsonb, red_flags_json=$3::jsonb,
       positive_signals_json=$4::jsonb, parser_version=$5 WHERE id=$1`,
    [itemId, JSON.stringify(parsed.attributes), JSON.stringify(parsed.redFlags), JSON.stringify(parsed.positiveSignals), parsed.parserVersion]
  );
  await client.query("DELETE FROM parse_evidence WHERE item_id=$1", [itemId]);
  for (const evidence of parsed.evidence) {
    await client.query(
      `INSERT INTO parse_evidence (id,item_id,field,value,confidence,evidence_text,parser_version,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [createId(), itemId, evidence.field, evidence.value == null ? null : `${evidence.value}`,
        evidence.confidence, evidence.evidenceText, parsed.parserVersion, observedAt]
    );
  }
  await client.query("DELETE FROM modifications WHERE item_id=$1", [itemId]);
  for (const mod of parsed.modifications) {
    await client.query(
      `INSERT INTO modifications (id,item_id,category,mod_type,mod_name,brand,confidence,evidence_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [createId(), itemId, "vehicle", mod.modType, mod.modName, mod.brand ?? null, mod.confidence, mod.evidenceText]
    );
  }
}

export async function markDetailRefreshIncomplete(db, itemId, observedAt, error) {
  const marker = { status: "incomplete", attemptedAt: observedAt,
    reason: error.name === "ListingDetailUnavailableError" ? "listing_rejected" : "refresh_failed",
    ...(error.code === "FACEBOOK_COOLDOWN" ? { retryAt: new Date(error.retryAt).toISOString() } : {}) };
  await db.pool.query(
    `UPDATE items SET parsed_attributes_json=jsonb_set(parsed_attributes_json,'{detailRefresh}',$3::jsonb)
     WHERE id=$1 AND (last_scraped_at IS NULL OR last_scraped_at <= $2::timestamptz)
       AND (parsed_attributes_json->'detailRefresh'->>'attemptedAt' IS NULL
         OR (parsed_attributes_json->'detailRefresh'->>'attemptedAt')::timestamptz <= $2::timestamptz)`,
    [itemId, observedAt, JSON.stringify(marker)]
  );
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

  if (filters.q) {
    params.push(`%${filters.q.trim()}%`);
    conditions.push(
      `(i.title_raw ILIKE $${params.length} OR i.location_raw ILIKE $${params.length} OR i.description_raw ILIKE $${params.length})`
    );
  }

  if (Number.isFinite(filters.yearMin)) {
    params.push(Math.round(filters.yearMin));
    conditions.push(
      `(parsed_attributes_json->>'year' ~ '^[0-9]+$' AND (parsed_attributes_json->>'year')::INTEGER >= $${params.length})`
    );
  }

  if (Number.isFinite(filters.yearMax)) {
    params.push(Math.round(filters.yearMax));
    conditions.push(
      `(parsed_attributes_json->>'year' ~ '^[0-9]+$' AND (parsed_attributes_json->>'year')::INTEGER <= $${params.length})`
    );
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.min(filters.limit, 200)) : 50;
  const offset = Number.isFinite(filters.offset) ? Math.max(0, filters.offset) : 0;

  params.push(limit);
  params.push(offset);

  const orderBy = normalizeListingSort(filters.sort);

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
    ${orderBy}
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );

  return addListingCollectionState(db, result.rows);
}

async function addListingCollectionState(db, items) {
  if (!items.length) return [];
  const [linked, modifications] = await Promise.all([db.pool.query(
    `SELECT DISTINCT sh.item_id, p.* FROM search_hits sh
     JOIN search_runs r ON r.id=sh.search_run_id
     JOIN search_profiles p ON p.id=r.search_profile_id
     WHERE sh.item_id=ANY($1::TEXT[]) ORDER BY sh.item_id,p.name,p.id`,
    [items.map(item => item.id)]
  ), db.pool.query("SELECT item_id,mod_type,mod_name FROM modifications WHERE item_id=ANY($1::TEXT[])", [items.map(item => item.id)])]);
  const profilesByItem = new Map();
  for (const row of linked.rows) {
    const profiles = profilesByItem.get(row.item_id) ?? [];
    profiles.push(mapProfileRow(row));
    profilesByItem.set(row.item_id, profiles);
  }
  const now = Date.now();
  const modificationsByItem = new Map();
  for (const row of modifications.rows) {
    const entries = modificationsByItem.get(row.item_id) ?? [];
    entries.push(row);
    modificationsByItem.set(row.item_id, entries);
  }
  return items.map(item => ({ ...item, ...listingCollectionState(item, profilesByItem.get(item.id) ?? [], now,
    modificationsByItem.get(item.id) ?? []) }));
}

const LISTING_SORTS = {
  newest: "ORDER BY i.posted_at DESC NULLS LAST, i.last_seen_at DESC",
  oldest: "ORDER BY i.posted_at ASC NULLS LAST, i.last_seen_at ASC",
  price_asc: "ORDER BY i.current_price ASC NULLS LAST, i.last_seen_at DESC",
  price_desc: "ORDER BY i.current_price DESC NULLS LAST, i.last_seen_at DESC",
  score: "ORDER BY ds.score DESC NULLS LAST, ds.confidence DESC NULLS LAST, i.last_seen_at DESC"
};

export function normalizeListingSort(sort) {
  return LISTING_SORTS[sort] ?? LISTING_SORTS.newest;
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

  const [item] = await addListingCollectionState(db, listingResult.rows);

  const [historyResult, evidenceResult, modificationsResult] = await Promise.all([
    db.pool.query("SELECT * FROM price_history WHERE item_id = $1 ORDER BY captured_at DESC LIMIT 100", [itemId]),
    db.pool.query("SELECT * FROM parse_evidence WHERE item_id = $1 ORDER BY created_at DESC", [itemId]),
    db.pool.query("SELECT * FROM modifications WHERE item_id = $1", [itemId])
  ]);

  return {
    item,
    qualifications: item.qualifications,
    detailRefresh: item.detailRefresh,
    priceHistory: historyResult.rows,
    parseEvidence: evidenceResult.rows,
    modifications: modificationsResult.rows
  };
}

export async function deleteListing(db, itemId) {
  const result = await db.pool.query("DELETE FROM items WHERE id = $1 RETURNING id", [itemId]);
  return result.rows.length > 0;
}

export async function updateListingStatus(db, itemId, status) {
  const allowedStatuses = new Set(["new", "watching", "saved", "contacted", "rejected", "sold", "possibly_gone", "hidden"]);
  if (!allowedStatuses.has(status)) {
    throw new Error(`Unsupported listing status: ${status}`);
  }

  const result = await db.pool.query(
    `
    UPDATE items
    SET status = $2,
        updated_at = $3
    WHERE id = $1
    RETURNING *
    `,
    [itemId, status, nowIso()]
  );

  return result.rows[0] ?? null;
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

export async function upsertDealScore(db, itemId, score, scoredAt = nowIso()) {
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
      scoredAt
    ]
  );
}
