import test from "node:test";
import assert from "node:assert/strict";
import { runProfileSync } from "../src/syncEngine.js";
import { createFacebookConnector } from "../src/facebookConnector.js";
import { memoryObservationDbOps } from "./helpers/observationDbOps.js";

function makeDbOps() { return memoryObservationDbOps().ops; }

function makeConnector() {
  let detailRequests = 0;
  return {
    get detailRequests() { return detailRequests; },
    async captureListingCards() {
      return {
        capturedAt: new Date(),
        cards: [{
          rank: 1,
          sourceItemId: "listing-1",
          listingUrl: "https://www.facebook.com/marketplace/item/listing-1/",
          titleRaw: "2013 Honda Civic Si",
          priceRaw: "$12,000",
          locationRaw: "Oakland",
          thumbnailUrl: "https://example.test/thumb.jpg",
          rawCardText: "2013 Honda Civic Si $12,000 Oakland",
          sourceMetadata: { postedDate: new Date().toISOString() }
        }]
      };
    },
    normalizeCardToRawSourceItem(card) {
      return {
        sourceItemId: card.sourceItemId,
        normalizedUrl: card.listingUrl,
        url: card.listingUrl,
        titleRaw: card.titleRaw,
        descriptionRaw: undefined,
        priceRaw: card.priceRaw,
        locationRaw: card.locationRaw,
        imageUrls: [card.thumbnailUrl].filter(Boolean),
        sourceMetadata: card.sourceMetadata
      };
    },
    async fetchListingDetail(card) {
      detailRequests += 1;
      return {
        ...this.normalizeCardToRawSourceItem(card),
        descriptionRaw: "70,000 miles, manual transmission, clean title"
      };
    }
  };
}

test("new GraphQL listings persist cards without opening detail pages", async () => {
  const connector = makeConnector();
  const run = await runProfileSync({
    db: {}, connector, profile: { id: "profile-1", query: "Civic", filtersJson: {} },
    dbOps: makeDbOps()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(connector.detailRequests, 0);
});

test("all rich search cards persist without any detail requests", async () => {
  const connector = makeConnector();
  const [base] = (await connector.captureListingCards({})).cards;
  connector.captureListingCards = async () => ({
    capturedAt: new Date(),
    cards: Array.from({ length: 7 }, (_, index) => ({
      ...base,
      rank: index + 1,
      sourceItemId: `listing-${index + 1}`,
      listingUrl: `https://www.facebook.com/marketplace/item/listing-${index + 1}/`
    }))
  });

  const originalDetail = connector.fetchListingDetail.bind(connector);
  let active=0, maximumActive=0;
  connector.fetchListingDetail=async card=>{
    active++;maximumActive=Math.max(maximumActive,active);
    try {await new Promise(resolve=>setImmediate(resolve));return await originalDetail(card);}
    finally {active--;}
  };

  const run = await runProfileSync({
    db: {}, connector, profile: { id: "profile-1", query: "Civic", filtersJson: {} },
    dbOps: makeDbOps()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 7);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(connector.detailRequests, 0);
  assert.equal(maximumActive, 0);
});

test("cursor-only placeholder cards without a cache are excluded", async () => {
  const connector = makeConnector();
  connector.captureListingCards = async () => ({
    capturedAt: new Date(),
    cards: [{
      rank: 1,
      sourceItemId: "corvette-1",
      listingUrl: "https://www.facebook.com/marketplace/item/corvette-1/",
      titleRaw: "Marketplace listing",
      priceRaw: "",
      locationRaw: "",
      rawCardText: "Marketplace listing"
    }]
  });
  connector.fetchListingDetail = async (card) => ({
    ...connector.normalizeCardToRawSourceItem(card),
    titleRaw: "2020 Chevrolet Corvette",
    priceRaw: "$65,000",
    imageUrls: ["https://example.test/corvette.jpg"],
    sourceMetadata: { detailFetched: true }
  });
  const saved = [];
  const dbOps = makeDbOps();
  const persist = dbOps.upsertRawItemSnapshot;
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    const result = await persist(_db, args);
    saved.push(result.rawItem);
    return result;
  };

  const run = await runProfileSync({
    db: {}, connector, profile: { id: "profile-corvette", query: "corvette", filtersJson: {} }, dbOps
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 0);
  assert.equal(run.detailPagesOpened, 0);
  assert.deepEqual(saved, []);
});

test("placeholder cards reuse saved listing data instead of re-fetching every known result", async () => {
  const connector = makeConnector();
  connector.captureListingCards = async () => ({
    capturedAt: new Date(),
    cards: [{
      rank: 1,
      sourceItemId: "existing-corvette",
      listingUrl: "https://www.facebook.com/marketplace/item/existing-corvette/",
      titleRaw: "Marketplace listing",
      priceRaw: "",
      locationRaw: "",
      thumbnailUrl: "",
      rawCardText: "Marketplace listing"
    }]
  });
  const saved = [];
  const dbOps = makeDbOps();
  dbOps.getItemRefreshState = async () => ({
    status: "new",
    title_raw: "2020 Chevrolet Corvette",
    description_raw: "Clean title, 25,000 miles",
    price_raw: "$65,000",
    current_price: 65000,
    location_raw: "San Jose",
    image_urls: ["https://example.test/corvette.jpg"],
    seller_raw: "Seller",
    posted_at: new Date().toISOString(),
    last_scraped_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  });
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    const cache = await dbOps.getItemRefreshState();
    const memory = memoryObservationDbOps({ states: new Map([[args.rawItem.sourceItemId, cache]]) });
    const result = await memory.ops.upsertRawItemSnapshot(_db, args);
    saved.push(result.rawItem);
    return result;
  };

  const run = await runProfileSync({
    db: {}, connector, profile: { id: "profile-corvette", query: "corvette", filtersJson: {} }, dbOps
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(connector.detailRequests, 0);
  assert.equal(saved[0].titleRaw, "2020 Chevrolet Corvette");
  assert.equal(saved[0].priceRaw, "$65,000");
  assert.deepEqual(saved[0].imageUrls, ["https://example.test/corvette.jpg"]);
});

test("missing transmission persists as an unknown candidate", async () => {
  const connector = makeConnector();
  const run = await runProfileSync({
    db: {}, connector,
    profile: { id: "profile-1", query: "Civic", filtersJson: { transmission: "manual" } },
    dbOps: makeDbOps()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.matchCount, 0);
  assert.equal(run.unknownCount, 1);
  assert.equal(run.alertsCreated, 0);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(connector.detailRequests, 0);
});

test("known contradictions are excluded while missing required evidence remains visible", async () => {
  const connector = makeConnector();
  const [card] = (await connector.captureListingCards()).cards;
  connector.captureListingCards = async () => ({ capturedAt: new Date(), cards: [
    { ...card, sourceItemId: "unknown" },
    { ...card, sourceItemId: "automatic", titleRaw: "2013 Honda Civic Si automatic" },
    { ...card, sourceItemId: "manual", titleRaw: "2013 Honda Civic Si manual clean title" }
  ] });
  const memory = memoryObservationDbOps();
  const run = await runProfileSync({ db: {}, connector, dbOps: memory.ops,
    profile: { id: "manual-only", filtersJson: { transmission: "manual", cleanTitleOnly: true } } });
  assert.equal(run.resultsFound, 2);
  assert.equal(run.matchCount, 1);
  assert.equal(run.unknownCount, 1);
  assert.deepEqual(memory.snapshots.map(raw => raw.sourceItemId), ["unknown", "manual"]);
  assert.equal(run.alertsCreated, 0);
  assert.equal(connector.detailRequests, 0);
});

test("only qualified fresh cached details can produce alerts on a card-only run", async () => {
  const connector = makeConnector();
  const [card] = (await connector.captureListingCards()).cards;
  const now = new Date().toISOString();
  const makeCached = (id, fields = {}) => ({
    id, status: "new", title_raw: card.titleRaw,
    description_raw: "Manual transmission, clean title, 70,000 miles", price_raw: "$12,000", current_price: 12000,
    last_scraped_at: now, parsed_attributes_json: {}, ...fields
  });
  const states = new Map([
    ["fresh", makeCached("fresh")],
    ["stale", makeCached("stale", { last_scraped_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })],
    ["incomplete", makeCached("incomplete", { parsed_attributes_json: { detailRefresh: { status: "incomplete" } } })],
    ["unknown", makeCached("unknown", { description_raw: "Seller description" })]
  ]);
  connector.captureListingCards = async () => ({ capturedAt: new Date(), cards: [...states.keys()].map(id => ({ ...card, sourceItemId: id })) });
  const memory = memoryObservationDbOps({ states });
  const run = await runProfileSync({ db: {}, connector, dbOps: memory.ops,
    profile: { id: "manual-only", filtersJson: { transmission: "manual", cleanTitleOnly: true } } });
  assert.equal(run.resultsFound, 4);
  assert.equal(run.matchCount, 3);
  assert.equal(run.unknownCount, 1);
  assert.equal(run.alertsCreated, 1);
  assert.deepEqual(memory.finishes[0].alertIds, ["fresh"]);
  assert.equal(run.detailPagesOpened, 0);
});

test("confirmed generation contradictions exclude cards", async () => {
  const connector = makeConnector();
  const run = await runProfileSync({
    db: {}, connector,
    profile: {
      id: "profile-1", query: "Civic", filtersJson: {
        transmission: "manual",
        generation: { make: "Honda", model: "Civic", yearFrom: 2016, yearTo: 2020 }
      }
    },
    dbOps: makeDbOps()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 0);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(connector.detailRequests, 0);
});

test("GraphQL HTTP search persists cards with only the search operation", async (t) => {
  const graphqlCalls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("/marketplace/")) {
      return new Response('<script>"DTSGInitData",[],{"token":"test-token"}</script>', { status: 200 });
    }
    const docId = new URLSearchParams(options.body).get("doc_id");
    graphqlCalls.push(docId);
    if (docId === "26924013917190310") {
      return new Response(JSON.stringify({ data: { viewer: { marketplace_product_details_page: { target: {
        id: "listing-graphql-1",
        marketplace_listing_title: "2015 Honda Civic Si",
        redacted_description: { text: "Manual transmission; clean title; 72,000 miles" },
        listing_price: { formatted_amount: "$12,000" },
        primary_listing_photo: { image: { uri: "https://example.test/car.jpg" } }
      } } } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { marketplace_search: { feed_units: {
      edges: [{ node: { listing: {
        id: "listing-graphql-1",
        marketplace_listing_title: "2015 Honda Civic Si",
        listing_price: { formatted_amount: "$12,000" },
        creation_time: Math.floor(Date.now() / 1000),
        primary_listing_photo: { image: { uri: "https://example.test/car.jpg" } }
      } } }],
      page_info: { has_next_page: false }
    } } } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const connector = createFacebookConnector({ mode: "facebook_graphql", maxCardsPerRun: 25 });
  connector.client.scheduleRequest = (request) => request();
  const persisted = [];
  const dbOps = makeDbOps();
  const persist = dbOps.upsertRawItemSnapshot;
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    const result = await persist(_db, args);
    persisted.push(result.rawItem);
    return result;
  };
  const run = await runProfileSync({
    db: {}, connector,
    profile: {
      id: "profile-graphql", query: "Civic", location: "Oakland", radiusMiles: 25,
      filtersJson: { latitude: 37.8044, longitude: -122.2712 }
    },
    dbOps
  });

  assert.deepEqual(graphqlCalls, ["7111939778879383"]);
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(persisted[0].sourceItemId, "listing-graphql-1");
  assert.equal(persisted[0].imageUrls[0], "https://example.test/car.jpg");
  assert.equal(persisted[0].descriptionRaw, undefined);
});

test("placeholder GraphQL response persists the HTML fallback card without details", async (t) => {
  let graphqlCalls = 0;
  let pageCalls = 0;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const requestUrl = new URL(url);
    if (requestUrl.pathname === "/marketplace/search/") {
      pageCalls += 1;
      return new Response(`<a href="/marketplace/item/998877/?ref=search"><img src="https://images.example.test/corvette.jpg"><span>2007 Chevrolet Corvette Coupe 2D</span><span>$18,000</span><span>Lafayette, CA</span></a>`, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    if (requestUrl.pathname === "/marketplace/") {
      return new Response('<script>"DTSGInitData",[],{"token":"test-token"}</script>', { status: 200 });
    }
    graphqlCalls += 1;
    const docId = new URLSearchParams(options.body).get("doc_id");
    if (docId === "26924013917190310") {
      return new Response(JSON.stringify({ data: { viewer: { marketplace_product_details_page: { target: {
        id: "998877",
        marketplace_listing_title: "2007 Chevrolet Corvette Coupe 2D",
        redacted_description: { text: "Clean title and 48,000 miles" },
        listing_price: { formatted_amount: "$18,000" }
      } } } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: { marketplace_search: { feed_units: {
      edges: [{ node: { id: "feed-wrapper" } }],
      page_info: { end_cursor: JSON.stringify({ c2c: { sspi: ["998877"] } }), has_next_page: true }
    } } } }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const connector = createFacebookConnector({ mode: "facebook_graphql", maxCardsPerRun: 25 });
  connector.client.scheduleRequest = (request) => request();
  const persisted = [];
  const dbOps = makeDbOps();
  const persist = dbOps.upsertRawItemSnapshot;
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    const result = await persist(_db, args);
    persisted.push(result.rawItem);
    return result;
  };
  const run = await runProfileSync({
    db: {}, connector,
    profile: {
      id: "profile-corvette", query: "corvette", location: "San Jose, CA", radiusMiles: 25,
      filtersJson: { latitude: 37.3, longitude: -121.9 }
    },
    dbOps
  });

  assert.equal(graphqlCalls, 1);
  assert.equal(pageCalls, 1);
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(persisted[0].sourceItemId, "998877");
  assert.equal(persisted[0].titleRaw, "2007 Chevrolet Corvette Coupe 2D");
  assert.deepEqual(persisted[0].imageUrls, ["https://images.example.test/corvette.jpg"]);
  assert.equal(persisted[0].descriptionRaw, undefined);
});

test("a new manual card is not filtered by stale cached automatic attributes before the authoritative upsert", async () => {
  const connector = makeConnector();
  const cardTitle = "2013 Honda Civic Si manual";
  connector.captureListingCards = async () => ({
    capturedAt: new Date(),
    cards: [{
      rank: 1,
      sourceItemId: "stale-auto-1",
      listingUrl: "https://www.facebook.com/marketplace/item/stale-auto-1/",
      titleRaw: cardTitle,
      priceRaw: "$12,000",
      locationRaw: "Oakland",
      thumbnailUrl: "https://example.test/thumb.jpg",
      rawCardText: `${cardTitle} $12,000 Oakland`,
      sourceMetadata: { postedDate: new Date().toISOString() }
    }]
  });
  const staleCached = {
    status: "new",
    title_raw: "2013 Honda Civic Si",
    description_raw: "Automatic transmission",
    price_raw: "$12,000",
    current_price: 12000,
    location_raw: "Oakland",
    image_urls: [],
    seller_raw: null,
    posted_at: new Date().toISOString(),
    last_scraped_at: null,
    parsed_attributes_json: { marketplaceAttributes: { transmission: "Automatic" } }
  };
  const dbOps = makeDbOps();
  dbOps.getItemRefreshState = async () => staleCached;
  const seen = [];
  const inner = dbOps.upsertRawItemSnapshot;
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    seen.push(args.rawItem);
    return inner(_db, args);
  };
  const run = await runProfileSync({
    db: {}, connector,
    profile: { id: "manual-only", query: "Civic", filtersJson: { transmission: "manual" } },
    dbOps
  });
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.unknownCount + run.matchCount, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].titleRaw, cardTitle);
});
