import test from "node:test";
import assert from "node:assert/strict";
import { getSearchDefaults, saveSearchDefaults } from "../src/db.js";

test("search defaults use saved values or the most common existing search area", async () => {
  let configured = null;
  const db = { pool: { async query(sql) {
    if (sql.includes("FROM app_settings")) return { rows: configured ? [{ value_json: configured }] : [] };
    return { rows: [{ location: "Oakland", radius_miles: 35 }] };
  } } };
  assert.deepEqual(await getSearchDefaults(db), { location: "Oakland", radiusMiles: 35 });
  configured = { location: "San Jose", radiusMiles: 50 };
  assert.deepEqual(await getSearchDefaults(db), configured);
});

test("saving search defaults validates and upserts the reusable city and radius", async () => {
  let call;
  const db = { pool: { async query(sql, values) { call = { sql, values }; return { rowCount: 1 }; } } };
  assert.deepEqual(await saveSearchDefaults(db, { location: "  Fremont ", radiusMiles: "45" }), { location: "Fremont", radiusMiles: 45 });
  assert.match(call.sql, /ON CONFLICT\(key\) DO UPDATE/);
  assert.deepEqual(JSON.parse(call.values[0]), { location: "Fremont", radiusMiles: 45 });
  await assert.rejects(saveSearchDefaults(db, { location: "", radiusMiles: 45 }), /city or ZIP/);
  await assert.rejects(saveSearchDefaults(db, { location: "Fremont", radiusMiles: 0 }), /between 1 and 500/);
});
