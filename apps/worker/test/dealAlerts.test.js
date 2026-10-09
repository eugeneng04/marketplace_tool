import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ALERT_RULES,
  getDealDisplay,
  listingAgeHours,
  meetsAlertRules,
  normalizeAlertRules
} from "../src/dealAlerts.js";

test("alert rules default when profile has no custom settings", () => {
  const rules = normalizeAlertRules({ filtersJson: {} });
  assert.deepEqual(rules, DEFAULT_ALERT_RULES);
});

test("alert rules read per-profile settings", () => {
  const rules = normalizeAlertRules({
    alertMinScore: 80,
    alertMinConfidence: 0.7,
    alertMaxAgeHours: 24,
    filtersJson: {}
  });
  assert.equal(rules.minScore, 80);
  assert.equal(rules.minConfidence, 0.7);
  assert.equal(rules.maxAgeHours, 24);
});

test("alerts require min score, min confidence, and max age", () => {
  const profile = { alertMinScore: 70, alertMinConfidence: 0.5, alertMaxAgeHours: 72, filtersJson: {} };
  const freshItem = { posted_at: new Date().toISOString(), status: "new" };

  assert.equal(meetsAlertRules({ profile, deal: { score: 85, confidence: 0.8 }, item: freshItem }).ok, true);
  assert.equal(meetsAlertRules({ profile, deal: { score: 60, confidence: 0.8 }, item: freshItem }).ok, false);
  assert.equal(meetsAlertRules({ profile, deal: { score: 85, confidence: 0.2 }, item: freshItem }).ok, false);

  const oldItem = { posted_at: new Date(Date.now() - 100 * 3_600_000).toISOString(), status: "new" };
  assert.equal(meetsAlertRules({ profile, deal: { score: 90, confidence: 0.9 }, item: oldItem }).ok, false);
});

test("alerts skip excluded statuses and dedupe relies on unique constraint", () => {
  const profile = { alertMinScore: 10, alertMinConfidence: 0.1, alertMaxAgeHours: 5000, filtersJson: {} };
  const soldItem = { posted_at: new Date().toISOString(), status: "sold" };
  assert.equal(
    meetsAlertRules({ profile, deal: { score: 95, confidence: 0.9 }, item: soldItem }).ok,
    false
  );
});

test("listing age falls back when posted_at is missing", () => {
  assert.equal(listingAgeHours({}, Date.now()), 0);
  const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const age = listingAgeHours({ posted_at: twoHoursAgo }, Date.now());
  assert.ok(age >= 1.9 && age <= 2.1);
});

test("low-confidence listings are never labelled as confirmed good deals", () => {
  const lowConfidence = getDealDisplay({ score: 92, confidence: 0.2, verdict: "Strong candidate" });
  assert.equal(lowConfidence.label, "Needs review – low confidence");
  assert.equal(lowConfidence.confirmed, false);

  const confirmed = getDealDisplay({ score: 92, confidence: 0.8, verdict: "Strong candidate" });
  assert.equal(confirmed.label, "Strong candidate");
  assert.equal(confirmed.confirmed, true);

  const fairLow = getDealDisplay({ score: 70, confidence: 0.55, verdict: "Fair value" });
  assert.equal(fairLow.confirmed, false);
});

test("listing sort falls back to newest for unknown values", async () => {
  const { normalizeListingSort } = await import("../src/db.js");
  assert.ok(normalizeListingSort("price_asc").includes("current_price ASC"));
  assert.ok(normalizeListingSort("price_desc").includes("current_price DESC"));
  assert.ok(normalizeListingSort("score").includes("ds.score DESC"));
  assert.ok(normalizeListingSort("oldest").includes("posted_at ASC"));
  assert.ok(normalizeListingSort("recent").includes("last_seen_at DESC"));
  assert.equal(normalizeListingSort("bogus"), normalizeListingSort("newest"));
  assert.equal(normalizeListingSort(undefined), normalizeListingSort("newest"));
});

test("completed runs persist deduplicated alerts in the same transaction", async () => {
  const { finishSearchRun } = await import("../src/db.js");
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push({ sql: sql.trim(), values });
      return { rowCount: sql.includes("INSERT INTO deal_alerts") ? 1 : 1 };
    },
    release() {}
  };
  const db = { pool: { async connect() { return client; } } };
  const created = await finishSearchRun(db, "run-1", {
    status: "completed", resultsFound: 2, newItems: 2, existingItems: 0, detailPagesOpened: 2
  }, "profile-1", ["item-1", "item-1", "item-2"]);

  assert.equal(created, 2);
  assert.equal(statements[0].sql, "BEGIN");
  assert.equal(statements.filter(({ sql }) => sql.startsWith("INSERT INTO deal_alerts")).length, 2);
  assert.ok(statements.some(({ sql, values }) => sql.startsWith("UPDATE search_runs") && values[2] === "completed"));
  assert.equal(statements.at(-1).sql, "COMMIT");
});

test("failed runs never persist alerts", async () => {
  const { finishSearchRun } = await import("../src/db.js");
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql.trim());
      return { rowCount: 1 };
    },
    release() {}
  };
  const db = { pool: { async connect() { return client; } } };
  await finishSearchRun(db, "run-2", {
    status: "failed", resultsFound: 0, newItems: 0, existingItems: 0, detailPagesOpened: 0,
    errorMessage: "capture failed"
  }, "profile-1", ["item-1"]);

  assert.equal(statements.some((sql) => sql.includes("INSERT INTO deal_alerts")), false);
  assert.equal(statements.at(-1), "COMMIT");
});
