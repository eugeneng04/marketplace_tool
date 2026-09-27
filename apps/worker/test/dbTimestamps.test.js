import test from "node:test";
import assert from "node:assert/strict";
import { createComp, updateListingDetail, upsertRawItemSnapshot } from "../src/db.js";

test("blank posted dates are stored as null for new and refreshed listings", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("SELECT * FROM items")) return { rows: [] };
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

  await upsertRawItemSnapshot(db, { profile: { id: "profile-1", category: "vehicle", location: "Oakland" }, runId: "run-1", rank: 1, rawItem, parsedPrice: null });
  await updateListingDetail(db, "item-1", rawItem);

  const inserts = calls.find(({ sql }) => sql.includes("INSERT INTO items"));
  const refresh = calls.find(({ sql }) => sql.includes("posted_at = COALESCE($8::timestamptz"));
  assert.equal(inserts.values[17], null);
  assert.equal(refresh.values[7], null);
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
