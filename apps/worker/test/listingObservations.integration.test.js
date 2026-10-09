import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import {
  createDb, createProfile, getListingById, listDeals, listListings, markDetailRefreshIncomplete,
  migrate, startSearchRun, updateListingStatus, updateProfile, upsertRawItemSnapshot
} from "../src/db.js";
import { createApp } from "../src/server.js";
import { runProfileSync } from "../src/syncEngine.js";
import { createListingRefresh } from "../src/listingRefresh.js";
import { createFacebookGraphqlConnector } from "../src/facebookConnector.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

function rawObservation(key, overrides = {}) {
  const url = `https://www.facebook.com/marketplace/item/${key}/`;
  return {
    source: "facebook_marketplace", sourceItemId: key, url, normalizedUrl: url,
    titleRaw: "2013 Honda Civic Si", priceRaw: "$25,000", locationRaw: "Oakland",
    imageUrls: ["https://images.test/thumb.jpg"], sourceMetadata: { currency: "USD" }, ...overrides
  };
}

test("PostgreSQL listing observations", {
  skip: databaseUrl ? false : "Set TEST_DATABASE_URL to a disposable local PostgreSQL database to run integration coverage."
}, async t => {
  const target = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "Integration database must be local");
  assert.match(target.pathname, /(?:test|fast_details)/, "Integration database must be disposable");
  const schema = `listing_observations_${randomUUID().replaceAll("-", "")}`;
  const admin = createDb(databaseUrl);
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  let db;
  const timestamp = minutes => new Date(Date.now() - minutes * 60_000).toISOString();

  async function seed({ raw = {}, filters = {}, name = randomUUID(), observedAt = timestamp(60) } = {}) {
    const profile = await createProfile(db, {
      name, category: "vehicle", query: "Civic", location: name, radiusMiles: 50,
      minPrice: null, maxPrice: null, filtersJson: filters, enabled: true
    });
    const run = await startSearchRun(db, profile.id, "facebook_marketplace");
    const observation = rawObservation(randomUUID(), { locationRegion: name, ...raw });
    const saved = await upsertRawItemSnapshot(db, { profile, runId: run.id, rank: 1, rawItem: observation, observedAt });
    return { profile, run, observation, saved, observedAt };
  }

  async function savedGraph(itemId) {
    const tables = ["items", "price_history", "item_snapshots", "parse_evidence", "modifications", "deal_scores", "search_hits"];
    return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.pool.query(
      `SELECT * FROM ${table} WHERE ${table === "items" ? "id" : "item_id"}=$1 ORDER BY id`, [itemId]
    )).rows])));
  }

  async function waitForLocks(applicationNames, expected) {
    const deadline = Date.now() + 5000;
    let waiting;
    do {
      waiting = (await admin.pool.query(
        "SELECT COUNT(*)::INTEGER AS waiting FROM pg_stat_activity WHERE application_name=ANY($1::TEXT[]) AND wait_event_type='Lock'",
        [applicationNames]
      )).rows[0].waiting;
      if (waiting === expected) break;
      await setTimeout(10);
    } while (Date.now() < deadline);
    assert.equal(waiting, expected, "Both writers must wait for actual PostgreSQL row locks before releasing the blocker");
  }

  try {
    const identity = await admin.pool.query("SELECT current_database() AS database");
    assert.equal(identity.rows[0].database, target.pathname.slice(1));
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    db = createDb(scopedUrl.href);
    await migrate(db);

    await t.test("commits price, history, snapshot, evidence, modifications and score while retaining cached facts and user status", async () => {
      const fixture = await seed({ raw: {
        descriptionRaw: "Manual transmission. Clean title. 70,000 miles. Coilovers.",
        imageUrls: ["https://images.test/thumb.jpg", "https://images.test/gallery.jpg"], sellerRaw: "Saved seller",
        vehicleAttributes: { transmission: "Manual", trim: "Si" },
        sourceMetadata: { detailFetched: true, sellerId: "seller-1", customTitle: "Sport coupe", subtitles: ["70,000 miles"], currency: "USD" }
      } });
      await updateListingStatus(db, fixture.saved.itemId, "saved");
      await db.pool.query("UPDATE items SET parsed_attributes_json=parsed_attributes_json || '{\"cachedField\":\"retained\"}'::jsonb WHERE id=$1", [fixture.saved.itemId]);
      for (const priceRaw of ["$18,000", "$20,000", "$22,000"]) {
        await upsertRawItemSnapshot(db, { profile: fixture.profile,
          rawItem: rawObservation(randomUUID(), { priceRaw, locationRegion: fixture.profile.location }), observedAt: timestamp(50) });
      }
      const observedAt = timestamp(20);
      await upsertRawItemSnapshot(db, { profile: fixture.profile, runId: fixture.run.id, rank: 2, observedAt,
        rawItem: rawObservation(fixture.observation.sourceItemId, {
          priceRaw: "$16,000", imageUrls: ["https://images.test/new-thumb.jpg"],
          vehicleAttributes: { transmission: "", condition: "Used" },
          sourceMetadata: { detailFetched: false, subtitles: [], sellerId: null }
        }) });
      const result = await getListingById(db, fixture.saved.itemId);
      assert.equal(result.item.price_raw, "$16,000");
      assert.equal(result.item.current_price, 16000);
      assert.equal(result.item.parsed_attributes_json.price, 16000);
      assert.equal(result.item.description_raw, "Manual transmission. Clean title. 70,000 miles. Coilovers.");
      assert.equal(result.item.status, "saved");
      assert.equal(result.item.seller_raw, "Saved seller");
      assert.equal(result.item.parsed_attributes_json.cachedField, "retained");
      assert.deepEqual(result.item.parsed_attributes_json.marketplaceAttributes, { transmission: "Manual", trim: "Si", condition: "Used" });
      assert.deepEqual(result.item.parsed_attributes_json.marketplaceMetadata.subtitles, ["70,000 miles"]);
      assert.equal(result.item.parsed_attributes_json.marketplaceMetadata.sellerId, "seller-1");
      assert.deepEqual(result.item.image_urls, ["https://images.test/thumb.jpg", "https://images.test/gallery.jpg", "https://images.test/new-thumb.jpg"]);
      assert.equal(result.item.last_seen_at.toISOString(), observedAt);
      assert.equal(result.item.last_scraped_at.toISOString(), fixture.observedAt);
      assert.deepEqual(result.priceHistory.map(row => row.price), [16000, 25000]);
      assert.equal(result.parseEvidence.find(row => row.field === "price").evidence_text, "$16,000");
      const mileage = result.parseEvidence.find(row => row.field === "mileage");
      assert.equal(mileage.value, "70000");
      assert.equal(mileage.confidence, 0.75);
      assert.equal(mileage.evidence_text, "70,000 miles");
      assert.deepEqual(result.modifications.map(row => row.mod_name), ["coilovers"]);
      assert.equal(result.item.price_score, 99);
      assert.equal(result.item.quality_score, 77);
      assert.equal(result.item.deal_score, 90);
      const graph = await savedGraph(fixture.saved.itemId);
      assert.equal(graph.item_snapshots.length, 2);
      assert.equal(graph.search_hits.length, 2);
      assert.deepEqual(graph.item_snapshots.map(row => row.parsed_price).sort((a, b) => a - b), [16000, 25000]);
    });

    await t.test("a late PostgreSQL score failure rolls back every existing and new listing write", async () => {
      const fixture = await seed({ raw: {
        descriptionRaw: "Manual. Clean title. 70,000 miles. Coilovers.", sourceMetadata: { detailFetched: true }
      } });
      const before = await savedGraph(fixture.saved.itemId);
      const newObservation = rawObservation(randomUUID(), { priceRaw: "$14,000", descriptionRaw: "Automatic. Rebuilt title. 99,000 miles. Aftermarket wheels." });
      await db.pool.query("ALTER TABLE deal_scores ADD CONSTRAINT reject_integration_score CHECK (score < 0) NOT VALID");
      try {
        await assert.rejects(upsertRawItemSnapshot(db, { itemId: fixture.saved.itemId, runId: fixture.run.id, rank: 2,
          rawItem: { ...newObservation, sourceItemId: fixture.observation.sourceItemId, sourceMetadata: { detailFetched: true } },
          observedAt: timestamp(10) }), { code: "23514", constraint: "reject_integration_score" });
        assert.deepEqual(await savedGraph(fixture.saved.itemId), before);
        await assert.rejects(upsertRawItemSnapshot(db, { profile: fixture.profile, runId: fixture.run.id, rank: 3,
          rawItem: newObservation, observedAt: timestamp(10) }), { code: "23514", constraint: "reject_integration_score" });
        assert.equal((await db.pool.query("SELECT COUNT(*)::INTEGER AS count FROM items WHERE source_item_id=$1", [newObservation.sourceItemId])).rows[0].count, 0);
        assert.deepEqual(await savedGraph(fixture.saved.itemId), before);
      } finally {
        await db.pool.query("ALTER TABLE deal_scores DROP CONSTRAINT reject_integration_score");
      }
      const recovered = await upsertRawItemSnapshot(db, { profile: fixture.profile, runId: fixture.run.id, rank: 3,
        rawItem: newObservation, observedAt: timestamp(10) });
      assert.equal(recovered.isNew, true);
      assert.equal((await getListingById(db, recovered.itemId)).item.current_price, 14000);
    });

    await t.test("queued row locks reject an older observation after a newer detail transaction commits", async () => {
      const fixture = await seed({ raw: {
        descriptionRaw: "Manual. Clean title. 70,000 miles. Coilovers.", sourceMetadata: { detailFetched: true }
      } });
      await updateListingStatus(db, fixture.saved.itemId, "contacted");
      const newerAt = timestamp(10);
      const olderAt = timestamp(20);
      const names = [`listing_new_${randomUUID()}`, `listing_old_${randomUUID()}`];
      const connections = names.map(name => {
        const url = new URL(scopedUrl);
        url.searchParams.set("application_name", name);
        return createDb(url.href);
      });
      const blocker = await db.pool.connect();
      const pending = [];
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT id FROM items WHERE id=$1 FOR UPDATE", [fixture.saved.itemId]);
        pending.push(upsertRawItemSnapshot(connections[0], { itemId: fixture.saved.itemId, observedAt: newerAt,
          rawItem: rawObservation(fixture.observation.sourceItemId, { priceRaw: "$16,000",
            descriptionRaw: "Manual. Clean title. 75,000 miles. Coilovers.", sourceMetadata: { detailFetched: true } }) }));
        await waitForLocks([names[0]], 1);
        pending.push(upsertRawItemSnapshot(connections[1], { itemId: fixture.saved.itemId, observedAt: olderAt,
          rawItem: rawObservation(fixture.observation.sourceItemId, { priceRaw: "$30,000",
            descriptionRaw: "Automatic. Salvage title. 200,000 miles.", sourceMetadata: { detailFetched: true } }) }));
        await waitForLocks(names, 2);
        await blocker.query("COMMIT");
        const [newer, older] = await Promise.all(pending);
        assert.equal(newer.applied, true);
        assert.equal(older.applied, false);
        const result = await getListingById(db, fixture.saved.itemId);
        assert.equal(result.item.current_price, 16000);
        assert.equal(result.item.description_raw, "Manual. Clean title. 75,000 miles. Coilovers.");
        assert.equal(result.item.status, "contacted");
        assert.equal(result.item.last_seen_at.toISOString(), fixture.observedAt);
        assert.equal(result.item.last_scraped_at.toISOString(), newerAt);
        assert.deepEqual(result.priceHistory.map(row => row.price), [16000, 25000]);
        assert.equal((await savedGraph(fixture.saved.itemId)).item_snapshots.length, 2);
        assert.equal(result.parseEvidence.find(row => row.field === "price").value, "16000");
        assert.equal(result.item.scored_at.toISOString(), newerAt);
        await markDetailRefreshIncomplete(db, fixture.saved.itemId, olderAt, new Error("Old request failed"));
        assert.equal((await getListingById(db, fixture.saved.itemId)).detailRefresh.state, "fresh");
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.allSettled(pending);
        await Promise.all(connections.map(connection => connection.close()));
      }
    });

    await t.test("later card titles retain prior parsed facts, original evidence and modifications when no contradiction is supplied", async () => {
      const fixture = await seed({
        raw: { titleRaw: "2013 Honda Civic manual clean title 70,000 miles coilovers" },
        filters: { transmission: "manual", cleanTitleOnly: true, modifiedOnly: true }
      });
      await upsertRawItemSnapshot(db, { profile: fixture.profile, runId: fixture.run.id, rank: 2,
        rawItem: rawObservation(fixture.observation.sourceItemId, { titleRaw: "Honda Civic Si", priceRaw: "$24,000" }), observedAt: timestamp(20) });
      const result = await getListingById(db, fixture.saved.itemId);
      assert.equal(result.item.parsed_attributes_json.transmission, "manual");
      assert.equal(result.item.parsed_attributes_json.year, 2013);
      assert.equal(result.item.parsed_attributes_json.titleStatus, "clean title");
      assert.equal(result.parseEvidence.find(row => row.field === "transmission")?.evidence_text, "manual keyword");
      assert.equal(result.parseEvidence.find(row => row.field === "year")?.value, "2013");
      assert.deepEqual(result.modifications.map(row => row.mod_name), ["coilovers"]);
      assert.deepEqual(result.qualifications.map(row => row.state), ["match"]);
      await upsertRawItemSnapshot(db, { itemId: fixture.saved.itemId,
        rawItem: rawObservation(fixture.observation.sourceItemId, { titleRaw: "Honda Civic automatic rebuilt title stock" }), observedAt: timestamp(10) });
      const contradicted = await getListingById(db, fixture.saved.itemId);
      assert.equal(contradicted.item.parsed_attributes_json.transmission, "automatic");
      assert.equal(contradicted.item.parsed_attributes_json.titleStatus, "rebuilt title");
      assert.equal(contradicted.parseEvidence.find(row => row.field === "transmission").evidence_text, "automatic keyword");
      assert.deepEqual(contradicted.modifications, []);
      assert.deepEqual(contradicted.qualifications[0].failedFields, ["transmission", "cleanTitleOnly", "modifiedOnly"]);
      const connector = createFacebookGraphqlConnector({ client: { async getListingDetail(id) {
        return { id, title: "2013 Honda Civic Si", description: "Manual. Clean title. 80,000 miles. Coilovers.",
          price: "$16,000", images: [], vehicleAttributes: {} };
      } } });
      const refresh = createListingRefresh({ db, connector });
      const refreshed = await refresh(fixture.saved.itemId, { force: true });
      assert.equal(refreshed.listing.item.parsed_attributes_json.mileage, 80000);
      assert.equal(refreshed.listing.item.parsed_attributes_json.transmission, "manual");
      assert.equal(refreshed.listing.parseEvidence.find(row => row.field === "mileage").evidence_text, "80,000 miles");
      assert.deepEqual(refreshed.listing.qualifications.map(row => row.state), ["match"]);
    });

    await t.test("listings, deals and detail views derive qualifications from the current linked profiles", async () => {
      const fixture = await seed({ raw: { vehicleAttributes: { transmission: "Manual" } }, filters: { transmission: "manual" } });
      const second = await createProfile(db, {
        name: "Title qualification", category: "vehicle", query: "Civic", location: fixture.profile.location, radiusMiles: 50,
        minPrice: null, maxPrice: null, filtersJson: { cleanTitleOnly: true }, enabled: true
      });
      const secondRun = await startSearchRun(db, second.id, "facebook_marketplace");
      await upsertRawItemSnapshot(db, { profile: second, runId: secondRun.id, rank: 1, rawItem: fixture.observation, observedAt: timestamp(30) });
      const view = await getListingById(db, fixture.saved.itemId);
      assert.deepEqual(Object.fromEntries(view.qualifications.map(row => [row.profileId, row.state])), {
        [fixture.profile.id]: "match", [second.id]: "unknown"
      });
      await updateProfile(db, fixture.profile.id, { filtersJson: { transmission: "automatic" } });
      const [listings, deals, detail] = await Promise.all([
        listListings(db, { profileId: fixture.profile.id, limit: 200 }), listDeals(db, 100), getListingById(db, fixture.saved.itemId)
      ]);
      for (const item of [listings.find(row => row.id === fixture.saved.itemId), deals.find(row => row.id === fixture.saved.itemId), detail.item]) {
        assert.deepEqual(item.qualifications.find(row => row.profileId === fixture.profile.id), {
          profileId: fixture.profile.id, profileName: fixture.profile.name, state: "mismatch", failedFields: ["transmission"], missingFields: []
        });
        assert.deepEqual(item.qualifications.find(row => row.profileId === second.id), {
          profileId: second.id, profileName: "Title qualification", state: "unknown", failedFields: [], missingFields: ["cleanTitleOnly"]
        });
        assert.equal(item.detailRefresh.state, "missing");
      }
      assert.deepEqual(detail.qualifications, detail.item.qualifications);
    });

    await t.test("card-only saved runs persist unknown candidates, exclude known contradictions and create no unverified alerts", async () => {
      const fixture = await seed({ filters: { transmission: "manual", cleanTitleOnly: true } });
      const connector = {
        async captureListingCards() { return { capturedAt: new Date(), cards: [
          { ...rawObservation(randomUUID()), rank: 1 },
          { ...rawObservation(randomUUID(), { titleRaw: "2013 Honda Civic automatic clean title" }), rank: 2 },
          { ...rawObservation(randomUUID(), { titleRaw: "2013 Honda Civic manual clean title" }), rank: 3 }
        ] }; },
        normalizeCardToRawSourceItem(card) { return card; },
        async fetchListingDetail() { throw new Error("A card-only run must never fetch details"); }
      };
      const run = await runProfileSync({ db, connector, profile: fixture.profile });
      assert.equal(run.status, "completed");
      assert.equal(run.resultsFound, 2);
      assert.equal(run.matchCount, 1);
      assert.equal(run.unknownCount, 1);
      assert.equal(run.detailPagesOpened, 0);
      assert.equal(run.alertsCreated, 0);
      const savedRun = (await db.pool.query("SELECT * FROM search_runs WHERE id=$1", [run.runId])).rows[0];
      assert.equal(savedRun.status, "completed");
      assert.equal(savedRun.results_found, 2);
      assert.equal(savedRun.detail_pages_opened, 0);
      const found = (await db.pool.query("SELECT i.* FROM items i JOIN search_hits h ON h.item_id=i.id WHERE h.search_run_id=$1 ORDER BY h.rank", [run.runId])).rows;
      assert.equal(found.length, 2);
      assert.deepEqual(found.map(row => row.current_price), [25000, 25000]);
      assert.deepEqual(found.map(row => row.last_scraped_at), [null, null]);
      assert.equal((await db.pool.query("SELECT COUNT(*)::INTEGER AS count FROM deal_alerts WHERE profile_id=$1", [fixture.profile.id])).rows[0].count, 0);
    });

    await t.test("stale rejected observations cannot create an alert from fresh cached qualification and score", async () => {
      const fixture = await seed({ filters: { transmission: "manual", cleanTitleOnly: true }, raw: {
        descriptionRaw: "Manual. Clean title. 70,000 miles.",
        sourceMetadata: { detailFetched: true, postedDate: timestamp(60) }
      } });
      const profile = await updateProfile(db, fixture.profile.id, { alertMinScore: 0, alertMinConfidence: 0, alertMaxAgeHours: 72 });
      let capturedAt = new Date(new Date(fixture.observedAt).getTime() - 60_000);
      const connector = {
        async captureListingCards() { return { capturedAt, cards: [{ ...fixture.observation, priceRaw: "$16,000", rank: 1 }] }; },
        normalizeCardToRawSourceItem(card) { return card; },
        async fetchListingDetail() { throw new Error("A card-only run must never fetch details"); }
      };
      const stale = await runProfileSync({ db, connector, profile });
      assert.equal(stale.resultsFound, 1);
      assert.equal(stale.matchCount, 1);
      assert.equal(stale.alertsCreated, 0);
      assert.equal((await getListingById(db, fixture.saved.itemId)).item.current_price, 25000);
      assert.equal((await db.pool.query("SELECT COUNT(*)::INTEGER AS count FROM deal_alerts WHERE profile_id=$1", [profile.id])).rows[0].count, 0);
      capturedAt = new Date();
      const current = await runProfileSync({ db, connector, profile });
      assert.equal(current.alertsCreated, 1);
      assert.equal((await getListingById(db, fixture.saved.itemId)).item.current_price, 16000);
      assert.equal((await db.pool.query("SELECT COUNT(*)::INTEGER AS count FROM deal_alerts WHERE profile_id=$1", [profile.id])).rows[0].count, 1);
    });

    await t.test("HTTP refresh defaults avoid photos, support conditional cached reads, force retries and preserve saved data on failures", async () => {
      const fixture = await seed();
      await updateListingStatus(db, fixture.saved.itemId, "saved");
      const calls = [];
      let failure;
      const connector = { async fetchListingDetail(card, options) {
        calls.push(options);
        if (failure) throw failure;
        return rawObservation(card.sourceItemId, { titleRaw: card.titleRaw, priceRaw: "$16,000", descriptionRaw: "",
          imageUrls: options.fetchPhotos ? ["https://images.test/loaded-gallery.jpg"] : [], vehicleAttributes: { transmission: "Manual" } });
      } };
      const app = await createApp({ config: {
        nodeEnv: "test", databaseUrl: scopedUrl.href, apiToken: "local-integration", schedulerEnabled: false,
        schedulerToken: "local-scheduler", connectorMode: "mock", maxCardsPerRun: 25
      }, connector });
      await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      const request = async (path, body) => {
        const response = await fetch(`${origin}${path}`, {
          method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer local-integration", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
        return { status: response.status, body: await response.json() };
      };
      try {
        const unauthenticatedHtml = await fetch(`${origin}/facebook/listing-html-test`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId: '123' })
        });
        assert.equal(unauthenticatedHtml.status, 401);
        const invalidHtml = await request('/facebook/listing-html-test', { listingId: '../' });
        assert.equal(invalidHtml.status, 400);
        const path = `/listings/${fixture.saved.itemId}/refresh`;
        const initial = await request(path, {});
        assert.equal(initial.status, 200);
        assert.equal(initial.body.cached, false);
        assert.equal(initial.body.listing.item.current_price, 16000);
        assert.equal(initial.body.listing.item.status, "saved");
        assert.equal(initial.body.listing.item.last_seen_at, fixture.observedAt);
        assert.equal(initial.body.listing.detailRefresh.state, "fresh");
        assert.deepEqual(initial.body.listing.item.image_urls, ["https://images.test/thumb.jpg"]);
        const fetchedAt = initial.body.listing.item.last_scraped_at;
        const cached = await request(path, { fetchPhotos: false });
        assert.equal(cached.status, 200);
        assert.equal(cached.body.cached, true);
        assert.equal(cached.body.listing.item.last_scraped_at, fetchedAt);
        assert.deepEqual(calls, [{ fetchPhotos: false }]);
        const forced = await request(path, { force: true });
        assert.equal(forced.status, 200);
        assert.equal(forced.body.cached, false);
        assert.deepEqual(calls, [{ fetchPhotos: false }, { fetchPhotos: false }]);
        const photos = await request(path, { fetchPhotos: true });
        assert.equal(photos.status, 200);
        assert.deepEqual(photos.body.listing.item.image_urls, ["https://images.test/thumb.jpg", "https://images.test/loaded-gallery.jpg"]);
        assert.deepEqual(calls[2], { fetchPhotos: true });
        const before = await getListingById(db, fixture.saved.itemId);
        failure = new Error("Local integration rejection");
        const failed = await request(path, { force: true });
        assert.equal(failed.status, 500);
        const preserved = await getListingById(db, fixture.saved.itemId);
        assert.equal(preserved.item.current_price, 16000);
        assert.equal(preserved.item.last_seen_at.toISOString(), fixture.observedAt);
        assert.equal(preserved.item.last_scraped_at.toISOString(), before.item.last_scraped_at.toISOString());
        assert.deepEqual(preserved.item.image_urls, before.item.image_urls);
        assert.deepEqual(preserved.priceHistory, before.priceHistory);
        assert.equal(preserved.detailRefresh.state, "incomplete");
        failure = undefined;
        const retried = await request(path, {});
        assert.equal(retried.status, 200);
        assert.equal(retried.body.listing.detailRefresh.state, "fresh");
        assert.equal(retried.body.cached, false);
        assert.equal((await request("/listings/missing/refresh", {})).status, 404);
      } finally {
        await app.close();
      }
    });
  } finally {
    await db?.close();
    await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.close();
  }
});
