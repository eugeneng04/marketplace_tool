import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDb, createProfile, getItemRefreshState, migrate, saveParsedItem,
  startSearchRun, upsertRawItemSnapshot
} from "../src/db.js";
import { ListingDetailUnavailableError } from "../src/facebookGraphqlClient.js";
import { runProfileSync, shouldFetchDetail } from "../src/syncEngine.js";
import { parseVehicleListing } from "../src/vehicleParser.js";

const testUrl = process.env.RESALE_DETAIL_TEST_DATABASE_URL;
assert.ok(testUrl, "RESALE_DETAIL_TEST_DATABASE_URL must identify a temporary synthetic database");
const connectionUrl = new URL(testUrl);
assert.equal(connectionUrl.pathname, "/resale_detail_atomic");
assert.equal(connectionUrl.hostname, "");
assert.match(connectionUrl.searchParams.get("host") ?? "", /^\/(?:private\/)?tmp\//);

function rawItem(id, detailFetched = false) {
  const url = `https://example.test/marketplace/${id}`;
  return {
    source: "facebook_marketplace", sourceItemId: id, url, normalizedUrl: url,
    titleRaw: "2013 Honda Civic Si", priceRaw: "$12,000", locationRaw: "Oakland",
    descriptionRaw: "70,000 miles, manual transmission, clean title",
    imageUrls: ["https://images.example/civic.jpg"],
    sourceMetadata: { detailFetched, postedDate: "2026-10-01T12:00:00Z" }
  };
}

test("detail refresh persistence uses the snapshot transaction in PostgreSQL", async t => {
  const schema = `detail_atomic_${randomUUID().replaceAll("-", "")}`;
  const admin = createDb(testUrl);
  await admin.pool.query(`CREATE SCHEMA ${schema}`);
  connectionUrl.searchParams.set("options", `-c search_path=${schema}`);
  const db = createDb(connectionUrl.toString());
  try {
    await migrate(db);
    const profile = await createProfile(db, {
      name: "Synthetic Civic", query: "Civic", category: "car", location: "Oakland",
      radiusMiles: 10, minPrice: null, maxPrice: null, enabled: true, filtersJson: {}
    });
    async function snapshot(raw, detailRefresh) {
      const run = await startSearchRun(db, profile.id, "facebook_marketplace");
      return upsertRawItemSnapshot(db, {
        profile, runId: run.id, rank: 1, rawItem: raw, parsedPrice: 12000, detailRefresh
      });
    }
    async function seed(id, detailRefresh) {
      const raw = rawItem(id, true);
      const result = await snapshot(raw);
      const parsed = parseVehicleListing(raw);
      parsed.attributes.retainedAttribute = "cached";
      if (detailRefresh) parsed.attributes.detailRefresh = detailRefresh;
      await saveParsedItem(db, result.itemId, parsed);
      return result.itemId;
    }
    const refresh = id => getItemRefreshState(db, { sourceItemId: id });

    await t.test("a parser transaction failure cannot erase the rejected detail retry", async () => {
      const id = "parser-failure";
      const itemId = await seed(id, { status: "complete", runId: "prior-run" });
      await db.pool.query("UPDATE items SET price_raw = '$13,000', current_price = 14000 WHERE id = $1", [itemId]);
      const prior = await refresh(id);
      assert.equal(shouldFetchDetail(prior, 24), true);
      await db.pool.query(`
        CREATE FUNCTION fail_parser() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic parser failure'; END $$;
        CREATE TRIGGER fail_parser BEFORE DELETE ON parse_evidence
        FOR EACH STATEMENT EXECUTE FUNCTION fail_parser()
      `);
      let rejectDetail = true;
      let requests = 0;
      const raw = rawItem(id);
      const connector = {
        async captureListingCards() { return { capturedAt: new Date(), cards: [{ rank: 1, titleRaw: raw.titleRaw }] }; },
        normalizeCardToRawSourceItem() { return raw; },
        async fetchListingDetail() {
          requests += 1;
          if (rejectDetail) throw new ListingDetailUnavailableError("Synthetic listing rejection", id);
          return rawItem(id, true);
        }
      };
      await assert.rejects(runProfileSync({ db, connector, profile }), /synthetic parser failure/);
      await db.pool.query("DROP TRIGGER fail_parser ON parse_evidence");
      const stored = await refresh(id);
      assert.equal(stored.price_raw, "$12,000");
      assert.equal(stored.current_price, 12000);
      assert.equal(stored.last_scraped_at.toISOString(), prior.last_scraped_at.toISOString());
      assert.equal(stored.parsed_attributes_json.retainedAttribute, "cached");
      rejectDetail = false;
      const next = await runProfileSync({ db, connector, profile });
      assert.equal(next.status, "completed");
      assert.equal(next.detailPagesOpened, 1);
      assert.equal(requests, 2);
      assert.equal(stored.parsed_attributes_json.detailRefresh.status, "incomplete");
      assert.equal(stored.parsed_attributes_json.detailRefresh.reason, "listing_rejected");
      assert.equal(shouldFetchDetail(stored, 24), true);
      assert.equal((await refresh(id)).parsed_attributes_json.detailRefresh.status, "complete");
      assert.equal(shouldFetchDetail(await refresh(id), 24), false);
    });

    await t.test("a snapshot failure rolls back the marker and price together", async () => {
      const id = "snapshot-failure";
      const itemId = await seed(id, { status: "complete", runId: "prior-run" });
      await db.pool.query("UPDATE items SET current_price = 14000 WHERE id = $1", [itemId]);
      const prior = await refresh(id);
      const counts = (await db.pool.query("SELECT (SELECT count(*) FROM price_history) AS prices, (SELECT count(*) FROM search_hits) AS hits")).rows[0];
      await db.pool.query(`
        CREATE FUNCTION fail_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic snapshot failure'; END $$;
        CREATE TRIGGER fail_snapshot BEFORE INSERT ON item_snapshots
        FOR EACH STATEMENT EXECUTE FUNCTION fail_snapshot()
      `);
      await assert.rejects(snapshot(rawItem(id), { status: "incomplete" }), /synthetic snapshot failure/);
      await assert.rejects(snapshot(rawItem("new-snapshot-failure"), { status: "incomplete" }), /synthetic snapshot failure/);
      await db.pool.query("DROP TRIGGER fail_snapshot ON item_snapshots");
      assert.deepEqual(await refresh(id), prior);
      assert.equal(await refresh("new-snapshot-failure"), null);
      assert.deepEqual((await db.pool.query("SELECT (SELECT count(*) FROM price_history) AS prices, (SELECT count(*) FROM search_hits) AS hits")).rows[0], counts);
    });

    await t.test("missing markers preserve attributes and complete markers replace incomplete ones", async () => {
      const id = "marker-semantics";
      await seed(id);
      const prior = await refresh(id);
      await snapshot(rawItem(id));
      assert.deepEqual((await refresh(id)).parsed_attributes_json, prior.parsed_attributes_json);
      const incomplete = { status: "incomplete", reason: "listing_rejected", runId: "failed-run" };
      await snapshot(rawItem(id), incomplete);
      const pending = await refresh(id);
      assert.deepEqual(pending.parsed_attributes_json, { ...prior.parsed_attributes_json, detailRefresh: incomplete });
      assert.equal(pending.last_scraped_at.toISOString(), prior.last_scraped_at.toISOString());
      assert.equal(shouldFetchDetail(pending, 24), true);
      const complete = { status: "complete", attemptedAt: "2026-10-09T12:00:00Z", runId: "success-run" };
      await snapshot(rawItem(id, true), complete);
      const completed = await refresh(id);
      assert.deepEqual(completed.parsed_attributes_json, { ...prior.parsed_attributes_json, detailRefresh: complete });
      assert.equal(shouldFetchDetail(completed, 24), false);
      await snapshot(rawItem("new-incomplete"), incomplete);
      const fresh = await refresh("new-incomplete");
      assert.deepEqual(fresh.parsed_attributes_json, { detailRefresh: incomplete });
      assert.equal(fresh.last_scraped_at, null);
      assert.equal(shouldFetchDetail(fresh, 24), true);
    });
  } finally {
    await db.close();
    await admin.pool.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.close();
  }
});
