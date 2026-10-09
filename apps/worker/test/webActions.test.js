import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../web/src/app.js", import.meta.url), "utf8");
const actions = source.slice(source.indexOf("function showActionStatus("), source.indexOf("function thumbnail("));
function harness(overrides = {}) {
  const nodes = new Map();
  const context = vm.createContext({
    $: (id) => { if (!nodes.has(id)) nodes.set(id, { disabled: false, textContent: "" }); return nodes.get(id); },
    state: { profiles: [] },
    loadProfiles: async () => {}, loadGroups: async () => {}, loadListings: async () => {},
    loadRuns: async () => {}, loadDeals: async () => {}, loadAlerts: async () => {},
    loadSearchDefaults: async () => {}, loadVehicleGenerations: async () => {},
    ...overrides
  });
  vm.runInContext(actions, context);
  return context;
}

test("refresh reports partial failure, preserves progress until requests settle, and re-enables button", async () => {
  let finish;
  const context = harness({ loadListings: () => new Promise((resolve) => { finish = resolve; }), loadDeals: async () => { throw new Error("Service unavailable"); } });
  const pending = context.refreshAll();
  assert.equal(context.$("#refreshButton").disabled, true);
  await context.refreshAll();
  finish();
  await pending;
  assert.match(context.$("#refreshStatus").textContent, /Reload incomplete: Service unavailable/);
  assert.equal(context.$("#refreshButton").disabled, false);
  assert.equal(context.$("#refreshButton").textContent, "Reload saved");
});

test("run all continues after one search fails, skips paused searches, and reloads results after each run", async () => {
  const calls = [];
  let reloads = 0;
  const context = harness({
    state: { profiles: [{ id: "a", name: "First", enabled: true }, { id: "b", enabled: false }, { id: "c", name: "Last", enabled: true }] },
    api: async (path) => { calls.push(path); if (path.includes("/a/")) throw new Error("Facebook unavailable"); return { run: { newItems: 3 } }; },
    loadListings: async () => { reloads++; }
  });
  await context.runAllSaved();
  assert.deepEqual(calls, ["/profiles/a/run", "/profiles/c/run"]);
  assert.equal(reloads, 2);
  assert.match(context.$("#syncStatus").textContent, /1 of 2 searches completed. 3 new listings/);
  assert.match(context.$("#syncStatus").textContent, /First: Facebook unavailable/);
  assert.equal(context.$("#syncAllButton").disabled, false);
});

test("run all explains empty and unavailable saved searches", async () => {
  const empty = harness();
  await empty.runAllSaved();
  assert.match(empty.$("#syncStatus").textContent, /No enabled saved searches/);
  const failed = harness({ loadProfiles: async () => { throw new Error("Unauthorized"); } });
  await failed.runAllSaved();
  assert.match(failed.$("#syncStatus").textContent, /Could not run saved searches: Unauthorized/);
  assert.equal(failed.$("#syncAllButton").disabled, false);
});

test("refresh confirms success and explains how to fetch new listings", async () => {
  const context = harness();
  await context.refreshAll();
  assert.match(context.$("#refreshStatus").textContent, /Saved data reloaded.*Run all saved/);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function savedView(id = "a", title = "2013 Scion FR-S") {
  return {
    item: {
      id, title_raw: title, current_price: 12500, price_raw: "$12,500", status: "new",
      location_raw: "Milpitas", seller_raw: "Alex", description_raw: "Saved seller description",
      image_urls: ["https://images.test/cover.jpg", "https://images.test/gallery.jpg"],
      parsed_attributes_json: {
        year: 2013, make: "scion", model: "fr-s", mileage: 65000, transmission: "manual",
        marketplaceAttributes: { exteriorColor: "Blue" },
        marketplaceMetadata: { customTitle: "Weekend coupe", subtitles: ["65K miles"], isPending: false }
      },
      posted_at: "2026-09-28T12:00:00Z", last_seen_at: "2026-10-09T12:00:00Z", last_scraped_at: null
    },
    priceHistory: [{ price: 12500, captured_at: "2026-10-09T12:00:00Z" }],
    qualifications: [
      { profileId: "manual", profileName: "Manual coupe", state: "unknown", failedFields: [], missingFields: ["cleanTitleOnly"] },
      { profileId: "auto", profileName: "Automatic coupe", state: "mismatch", failedFields: ["transmission"], missingFields: [] }
    ],
    detailRefresh: { state: "missing", needsRefresh: true, lastFetchedAt: null }
  };
}

function workflowHarness(request) {
  const nodes = new Map();
  const listeners = new Map();
  const messages = [];
  function node(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      const attributes = new Map();
      nodes.set(selector, {
        innerHTML: "", textContent: "", value: "", disabled: false, dataset: {},
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
        setAttribute: (key, value) => attributes.set(key, value),
        removeAttribute: (key) => attributes.delete(key), getAttribute: (key) => attributes.get(key),
        addEventListener: () => {}, closest() { return this; }
      });
    }
    return nodes.get(selector);
  }
  const context = vm.createContext({
    localStorage: { getItem: () => null },
    window: { location: { hostname: "resale.test", origin: "https://resale.test" } },
    document: {
      querySelector: node, querySelectorAll: () => [], body: node("body"),
      addEventListener: (name, callback) => listeners.set(name, callback)
    }
  });
  vm.runInContext(source.slice(0, source.lastIndexOf("\nbindEvents();")), context);
  context.api = request;
  context.toast = (message) => messages.push(message);
  context.bindEvents();
  return {
    context, node, messages,
    visible: () => node("#detailPanel").innerHTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    state: () => vm.runInContext("state", context),
    click: (dataset) => listeners.get("click")({ target: { dataset, classList: { contains: () => false }, closest() { return this; } } }),
    key: (key, dataset = {}) => listeners.get("keydown")({ key, target: { dataset, matches: () => true }, preventDefault() {} })
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const compView = { comps: [{ id: "sale", source: "bat", title_raw: "Sold FR-S", sold_price: 14000, mileage: 68000, transmission: "manual" }] };

test("saved listing is visible with known fields before held Facebook and comps requests finish", async () => {
  const detail = deferred();
  const comps = deferred();
  const bodies = [];
  const app = workflowHarness(async (path, options) => {
    if (path === "/listings/a") return savedView();
    if (path.endsWith("/refresh")) { bodies.push(JSON.parse(options.body)); return detail.promise; }
    if (path.endsWith("/comps")) return comps.promise;
    throw new Error(`Unexpected request ${path}`);
  });
  const opened = app.context.showListingDetail("a");
  await settle();
  assert.equal(app.node("#detailPanel").getAttribute("aria-hidden"), "false");
  for (const text of ["2013 Scion FR-S", "$12,500", "65,000 mi", "manual", "Saved seller description", "exteriorColor: Blue", "Weekend coupe", "65K miles", "isPending: false", "Manual coupe · Unverified", "Automatic coupe · Filters failed", "Failed: transmission", "Missing: clean title", "Search observed", "Details fetched n/a", "Checking Facebook details", "Finding completed auctions"]) {
    assert.ok(app.visible().includes(text), `Initial saved display must contain ${text}`);
  }
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/cover.jpg/);
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/gallery.jpg/);
  assert.deepEqual(bodies, [{ fetchPhotos: false }]);
  comps.resolve(compView);
  await settle();
  assert.ok(app.visible().includes("Sold FR-S"));
  assert.ok(app.visible().includes("Checking Facebook details"));
  detail.resolve({ listing: savedView(), cached: true });
  await opened;
  assert.ok(app.visible().includes("Sold FR-S"));
  assert.ok(app.visible().includes("65,000 mi"));
});

test("failed refresh keeps cache and independent comps; retry and photo clicks explicitly force refresh", async () => {
  const photo = deferred();
  const bodies = [];
  const app = workflowHarness(async (path, options) => {
    if (path === "/listings/a") return savedView();
    if (path.endsWith("/comps")) return compView;
    if (path.endsWith("/refresh")) {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) throw new Error("Facebook throttled");
      if (bodies.length === 3) return photo.promise;
      const listing = savedView();
      listing.item.current_price = 11000;
      listing.item.price_raw = "$12,500";
      listing.item.parsed_attributes_json.mileage = 65500;
      listing.item.image_urls = ["https://images.test/cover.jpg"];
      listing.priceHistory.push({ price: 11000, captured_at: "2026-10-09T13:00:00Z" });
      listing.detailRefresh = { state: "fresh", needsRefresh: false, lastFetchedAt: "2026-10-09T13:00:00Z" };
      listing.qualifications[0] = { profileId: "manual", profileName: "Manual coupe", state: "match", failedFields: [], missingFields: [] };
      return { listing, cached: false };
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await app.context.showListingDetail("a");
  assert.ok(app.visible().includes("Facebook detail refresh failed: Facebook throttled"));
  assert.ok(app.visible().includes("Retry details"));
  assert.ok(app.visible().includes("$12,500"));
  assert.ok(app.visible().includes("65,000 mi"));
  assert.ok(app.visible().includes("Sold FR-S"));
  await app.click({ refreshDetail: "a" });
  assert.ok(app.visible().includes("$11,000"));
  assert.ok(app.visible().includes("65,500 mi"));
  assert.ok(app.visible().includes("Details fresh"));
  assert.ok(app.visible().includes("Manual coupe · Filters match"));
  assert.ok(app.visible().includes("Automatic coupe · Filters failed"));
  assert.ok(app.visible().includes("Sold FR-S"));
  assert.equal(app.state().detailPanel.listing.data.priceHistory.length, 2);
  assert.match(app.visible(), /Price History \$12,500 .* \$11,000/);
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/gallery.jpg/);
  const loadingPhotos = app.click({ loadPhotos: "a" });
  await settle();
  assert.ok(app.visible().includes("Loading photos from Facebook"));
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/gallery.jpg/);
  photo.reject(new Error("Photo request unavailable"));
  await loadingPhotos;
  assert.ok(app.visible().includes("Photo request unavailable"));
  assert.ok(app.visible().includes("$11,000"));
  assert.deepEqual(bodies, [{ fetchPhotos: false }, { force: true, fetchPhotos: false }, { force: true, fetchPhotos: true }]);
});

test("Facebook enrichment renders updated history while comps are held and comps failure retains it", async () => {
  const comps = deferred();
  const listing = savedView();
  listing.item.title_raw = "Updated FR-S";
  listing.item.current_price = 10000;
  listing.priceHistory.push({ price: 10000, captured_at: "2026-10-09T13:00:00Z" });
  const app = workflowHarness(async (path) => {
    if (path === "/listings/a") return savedView();
    if (path.endsWith("/comps")) return comps.promise;
    if (path.endsWith("/refresh")) return { listing, cached: false };
    throw new Error(`Unexpected request ${path}`);
  });
  const opened = app.context.showListingDetail("a");
  await settle();
  assert.ok(app.visible().includes("Updated FR-S"));
  assert.ok(app.visible().includes("$10,000"));
  assert.ok(app.visible().includes("Finding completed auctions"));
  comps.reject(new Error("Auction service unavailable"));
  await opened;
  assert.ok(app.visible().includes("Auction lookup failed: Auction service unavailable"));
  assert.ok(app.visible().includes("Updated FR-S"));
  assert.equal(app.state().detailPanel.listing.data.priceHistory.length, 2);
});

test("late listing, Facebook success or failure, and comps responses cannot overwrite another item", async () => {
  for (const rejectDetail of [false, true]) {
    const detail = deferred();
    const comps = deferred();
    const oldGet = deferred();
    const app = workflowHarness(async (path) => {
      if (path === "/listings/old") return oldGet.promise;
      if (path === "/listings/a") return savedView();
      if (path === "/listings/b") return savedView("b", "2015 Subaru BRZ");
      if (path === "/listings/a/refresh") return detail.promise;
      if (path === "/listings/a/comps") return comps.promise;
      if (path === "/listings/b/refresh") return { listing: savedView("b", "2015 Subaru BRZ"), cached: true };
      if (path === "/listings/b/comps") return compView;
      throw new Error(`Unexpected request ${path}`);
    });
    const old = app.context.showListingDetail("old");
    const first = app.context.showListingDetail("a");
    await settle();
    await app.context.showListingDetail("b");
    const displayed = app.node("#detailPanel").innerHTML;
    oldGet.resolve(savedView("old", "Old listing"));
    if (rejectDetail) detail.reject(new Error("Old refresh failed"));
    else detail.resolve({ listing: savedView("a", "Old refreshed listing"), cached: false });
    comps.resolve({ comps: [{ ...compView.comps[0], title_raw: "Old auction" }] });
    await Promise.all([old, first]);
    assert.equal(app.node("#detailPanel").innerHTML, displayed);
    assert.ok(app.visible().includes("2015 Subaru BRZ"));
    assert.equal(app.state().detailPanel.itemId, "b");
  }
});

test("keyboard open, gallery selection, and Escape close survive late responses", async () => {
  const detail = deferred();
  const comps = deferred();
  const app = workflowHarness(async (path) => {
    if (path === "/listings/a") return savedView();
    if (path.endsWith("/comps")) return comps.promise;
    if (path.endsWith("/refresh")) return detail.promise;
    throw new Error(`Unexpected request ${path}`);
  });
  app.key("Enter", { openDetail: "a" });
  await settle();
  assert.ok(app.visible().includes("2013 Scion FR-S"));
  await app.click({ detailThumb: "https://images.test/gallery.jpg" });
  assert.equal(app.node("#detailHeroImage").src, "https://images.test/gallery.jpg");
  comps.resolve(compView);
  await settle();
  assert.match(app.node("#detailPanel").innerHTML, /id="detailHeroImage"[^>]+src="https:\/\/images.test\/gallery.jpg"/);
  app.key("Escape");
  assert.equal(app.node("#detailPanel").getAttribute("aria-hidden"), "true");
  detail.resolve({ listing: savedView(), cached: true });
  await settle();
  assert.equal(app.node("#detailPanel").getAttribute("aria-hidden"), "true");
  assert.equal(app.node("body").classList.contains("detail-open"), false);
});

test("global listing rows display per-profile qualification and server detail freshness", () => {
  const app = workflowHarness(async () => {});
  const view = savedView();
  app.state().listings = [{ ...view.item, qualifications: view.qualifications, detailRefresh: view.detailRefresh }];
  app.context.renderListings();
  const table = app.node("#listingsTableBody").innerHTML;
  assert.match(table, /Manual coupe · Unverified/);
  assert.match(table, /Automatic coupe · Filters failed/);
  assert.match(table, /Missing: clean title/);
  assert.match(table, /Details not fetched/);
  assert.match(table, /65,000 mi/);
  assert.match(table, /Search observed/);
});

test("manual photo success keeps cached gallery and automatic auction fetch is independent", async () => {
  const automaticComps = deferred();
  const calls = [];
  let compReads = 0;
  const app = workflowHarness(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    if (path === "/listings/a") return savedView();
    if (path.endsWith("/comps/fetch")) return automaticComps.promise;
    if (path.endsWith("/comps")) return ++compReads === 1 ? { comps: [] } : compView;
    if (path.endsWith("/refresh")) {
      const listing = savedView();
      if (JSON.parse(options.body).fetchPhotos) listing.item.image_urls = ["https://images.test/new-photo.jpg"];
      return { listing, cached: false };
    }
    throw new Error(`Unexpected request ${path}`);
  });
  const opened = app.context.showListingDetail("a");
  await settle();
  assert.ok(app.visible().includes("2013 Scion FR-S"));
  assert.ok(app.visible().includes("Finding completed auctions"));
  await app.click({ loadPhotos: "a" });
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/new-photo.jpg/);
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/gallery.jpg/);
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/cover.jpg/);
  assert.deepEqual(calls.filter((call) => call.path.endsWith("/refresh")).map((call) => call.body), [{ fetchPhotos: false }, { force: true, fetchPhotos: true }]);
  automaticComps.resolve({ comps: compView.comps });
  await opened;
  assert.ok(app.visible().includes("Sold FR-S"));
  assert.match(app.node("#detailPanel").innerHTML, /https:\/\/images.test\/new-photo.jpg/);
});

test("a previous opening of the same item cannot overwrite its newly loaded view", async () => {
  const oldDetail = deferred();
  let refreshes = 0;
  let reads = 0;
  const app = workflowHarness(async (path) => {
    if (path === "/listings/a") return savedView("a", ++reads === 1 ? "First opening" : "Second opening");
    if (path.endsWith("/comps")) return compView;
    if (path.endsWith("/refresh")) return ++refreshes === 1 ? oldDetail.promise : { listing: savedView("a", "Second opening"), cached: true };
    throw new Error(`Unexpected request ${path}`);
  });
  const first = app.context.showListingDetail("a");
  await settle();
  await app.context.showListingDetail("a");
  oldDetail.resolve({ listing: savedView("a", "First opening refreshed"), cached: false });
  await first;
  assert.ok(app.visible().includes("Second opening"));
  assert.equal(app.state().detailPanel.listing.data.item.title_raw, "Second opening");
});

test("profile run displays saved card results with unverified count and a clear failed run", async () => {
  const app = workflowHarness(async () => ({ run: { resultsFound: 4, newItems: 2, unknownCount: 3, detailPagesOpened: 0, alertsCreated: 0 } }));
  let reloads = 0;
  for (const name of ["loadListings", "loadRuns", "loadDeals", "loadAlerts"]) app.context[name] = async () => { reloads++; };
  const button = { textContent: "Run", disabled: false };
  await app.context.runProfile("manual", button);
  assert.equal(app.messages.at(-1), "Run finished: 4 results, 2 new, 3 unverified, 0 alerts");
  assert.equal(reloads, 4);
  assert.equal(button.textContent, "Run");
  assert.equal(button.disabled, false);
  app.context.api = async () => ({ run: { status: "failed", errorMessage: "Facebook unavailable" } });
  await app.context.runProfile("manual", button);
  assert.equal(app.messages.at(-1), "Search failed: Facebook unavailable");
  assert.equal(reloads, 8);
});


test("deal cards require fresh details and matching filters before showing confirmed", () => {
  const app = workflowHarness(async () => {});
  const scored = { deal_score: 85, deal_confidence: 0.9, verdict: "Strong candidate" };
  for (const state of ["missing", "stale", "incomplete"]) {
    const display = app.context.dealDisplay({ ...scored, detailRefresh: { state } });
    assert.equal(display.confirmed, false);
    assert.equal(display.label, "Needs review · unverified details or filters");
  }
  for (const state of ["unknown", "mismatch"]) {
    const display = app.context.dealDisplay({ ...scored, detailRefresh: { state: "fresh" }, qualifications: [{ state }] });
    assert.equal(display.confirmed, false);
    assert.equal(display.tone, "caution");
  }
  const display = app.context.dealDisplay({ ...scored, detailRefresh: { state: "fresh" }, qualifications: [{ state: "match" }] });
  assert.equal(display.confirmed, true);
  assert.equal(display.label, "Strong candidate");
});
