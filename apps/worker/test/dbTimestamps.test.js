import test from "node:test";
import assert from "node:assert/strict";
import { createComp, upsertRawItemSnapshot } from "../src/db.js";

test("blank posted dates are stored as null for new and refreshed listings", async () => {
  const calls = [];
  let existing;
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("SELECT * FROM items")) return { rows: existing ? [existing] : [] };
      if (sql.includes("percentile_cont")) return { rows: [{ sample_size: 0 }] };
      return { rows: [], rowCount: 1 };
    },
    release() {}
  };
  const db = { pool: { async connect() { return client; }, async query(sql, values) {
    calls.push({ sql, values });
    return { rows: [], rowCount: 1 };
  } } };
  const rawItem = {
    source: "facebook_marketplace", sourceItemId: "listing-1",
    url: "https://facebook.test/listing-1", normalizedUrl: "https://facebook.test/listing-1",
    titleRaw: "2015 Honda Civic Si", sourceMetadata: { postedDate: "" }
  };

  const saved = await upsertRawItemSnapshot(db, { profile: { id: "profile-1", category: "vehicle", location: "Oakland" }, runId: "run-1", rank: 1, rawItem, observedAt: "2026-10-09T10:00:00Z" });
  existing = saved.item;
  const refreshed = await upsertRawItemSnapshot(db, { itemId: saved.itemId, rawItem: { ...rawItem, sourceMetadata: { postedDate: "", detailFetched: true } }, observedAt: "2026-10-09T11:00:00Z" });

  const inserts = calls.find(({ sql }) => sql.includes("INSERT INTO items"));
  assert.equal(inserts.values[17], null);
  assert.equal(refreshed.item.posted_at, null);
  assert.equal(refreshed.item.title_raw, "2015 Honda Civic Si");
  assert.equal(refreshed.item.last_scraped_at, "2026-10-09T11:00:00.000Z");
});

test("blank comparable sale dates are stored as null", async () => {
  let values;
  const db = { pool: { async query(_sql, queryValues) {
    values = queryValues;
    return { rows: [{ id: "comp-1" }] };
  } } };

  await createComp(db, "item-1", {
    source: "cars_and_bids", url: "https://example.test/auction", title: "Auction",
    soldPrice: 10000, soldAt: "", note: null
  });

  assert.equal(values[6], null);
});
