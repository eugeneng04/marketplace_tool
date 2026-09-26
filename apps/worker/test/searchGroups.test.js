import test from "node:test";
import assert from "node:assert/strict";
import { createProfile, createSearchGroup, listSearchGroups, updateSearchGroupSchedule } from "../src/db.js";

test("search groups retain aliases and shared cadence", async () => {
  let inserted;
  const db = { pool: { async query(sql, values) {
    if (sql.includes("INSERT INTO search_groups")) {
      inserted = values;
      return { rows: [{ id: values[0], name: values[1], interval_minutes: values[2], next_run_at: null }] };
    }
    return { rows: [{ id: "g1", name: "Subaru twins", interval_minutes: 360, next_run_at: null, profiles: [{ id: "p1", query: "BRZ" }, { id: "p2", query: "FR-S" }] }] };
  } } };

  const created = await createSearchGroup(db, { name: "Subaru twins", intervalMinutes: 360 });
  assert.equal(created.name, "Subaru twins");
  assert.equal(created.intervalMinutes, 360);
  assert.equal(inserted[2], 360);
  const [group] = await listSearchGroups(db);
  assert.deepEqual(group.profiles.map((profile) => profile.query), ["BRZ", "FR-S"]);
});

test("a new search can be created directly inside a group", async () => {
  let inserted;
  const row = {
    id: "p-new", group_id: "g1", name: "BRZ", category: "vehicle", query: "subaru brz",
    location: "San Jose", radius_miles: 25, min_price: null, max_price: null,
    filters_json: {}, enabled: true, alert_min_score: 70, alert_min_confidence: 0.5,
    alert_max_age_hours: 72, created_at: new Date(), updated_at: new Date()
  };
  const db = { pool: { async query(_sql, values) { inserted = values; return { rows: [row] }; } } };
  const profile = await createProfile(db, {
    name: "BRZ", category: "vehicle", query: "subaru brz", location: "San Jose",
    radiusMiles: 25, minPrice: null, maxPrice: null, filtersJson: {}, enabled: true, groupId: "g1"
  });
  assert.equal(inserted[10], "g1");
  assert.equal(profile.groupId, "g1");
});

test("a group's run interval can be changed later", async () => {
  const db = { pool: { async query(_sql, values) {
    assert.deepEqual(values, ["g1", 1440]);
    return { rows: [{ id: "g1", name: "Subaru twins", interval_minutes: 1440, next_run_at: new Date() }] };
  } } };
  const group = await updateSearchGroupSchedule(db, "g1", 1440);
  assert.equal(group.intervalMinutes, 1440);
});
