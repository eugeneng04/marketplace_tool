import test from "node:test";
import assert from "node:assert/strict";
import { runProfileSync } from "../src/syncEngine.js";
import { createFacebookConnector } from "../src/facebookConnector.js";

function makeDbOps() {
  return {
    async startSearchRun() { return { id: "run-1" }; },
    async getItemRefreshState() { return null; },
    async upsertRawItemSnapshot() { return { itemId: "item-1", isNew: true }; },
    async saveParsedItem() {},
    async computeMarketStats() { return { medianPrice: 10000, sampleSize: 1 }; },
    async upsertDealScore() {},
    async finishSearchRun(_db, _runId, summary) {
      assert.equal(summary.status, "completed");
      return 0;
    }
  };
}

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

test("new GraphQL listings are enriched with a real description", async () => {
  const connector = makeConnector();
  const run = await runProfileSync({
    db: {}, connector, profile: { id: "profile-1", query: "Civic", filtersJson: {} },
    dbOps: makeDbOps()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 1);
  assert.equal(connector.detailRequests, 1);
});

test("all eligible details are fetched sequentially so the shared limiter can pace them", async () => {
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
  assert.equal(run.detailPagesOpened, 7);
  assert.equal(connector.detailRequests, 7);
  assert.equal(maximumActive, 1);
});

test("placeholder search cards fetch details before being counted and saved", async () => {
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
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    saved.push(args.rawItem);
    return { itemId: "corvette-item", isNew: true };
  };

  const run = await runProfileSync({
    db: {}, connector, profile: { id: "profile-corvette", query: "corvette", filtersJson: {} }, dbOps
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 1);
  assert.equal(saved[0].titleRaw, "2020 Chevrolet Corvette");
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
    saved.push(args.rawItem);
    return { itemId: "existing-corvette-item", isNew: false };
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

test("detail-dependent search filters still fetch listing details", async () => {
  const connector = makeConnector();
  const run = await runProfileSync({
    db: {}, connector,
    profile: { id: "profile-1", query: "Civic", filtersJson: { transmission: "manual" } },
    dbOps: makeDbOps()
  });

  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 1);
  assert.equal(connector.detailRequests, 1);
});

test("title and year filters eliminate cards before detail requests", async () => {
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

test("GraphQL HTTP search enriches a new listing and persists its description", async (t) => {
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
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    persisted.push(args.rawItem);
    return { itemId: "item-graphql-1", isNew: true };
  };
  const run = await runProfileSync({
    db: {}, connector,
    profile: {
      id: "profile-graphql", query: "Civic", location: "Oakland", radiusMiles: 25,
      filtersJson: { latitude: 37.8044, longitude: -122.2712 }
    },
    dbOps
  });

  assert.deepEqual(graphqlCalls, ["7111939778879383", "26924013917190310"]);
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 1);
  assert.equal(persisted[0].sourceItemId, "listing-graphql-1");
  assert.equal(persisted[0].imageUrls[0], "https://example.test/car.jpg");
  assert.equal(persisted[0].descriptionRaw, "Manual transmission; clean title; 72,000 miles");
});

test("placeholder GraphQL response falls back to Marketplace cards and enriches new results", async (t) => {
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
  dbOps.upsertRawItemSnapshot = async (_db, args) => {
    persisted.push(args.rawItem);
    return { itemId: "item-998877", isNew: true };
  };
  const run = await runProfileSync({
    db: {}, connector,
    profile: {
      id: "profile-corvette", query: "corvette", location: "San Jose, CA", radiusMiles: 25,
      filtersJson: { latitude: 37.3, longitude: -121.9 }
    },
    dbOps
  });

  assert.equal(graphqlCalls, 2);
  assert.equal(pageCalls, 1);
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 1);
  assert.equal(persisted[0].sourceItemId, "998877");
  assert.equal(persisted[0].titleRaw, "2007 Chevrolet Corvette Coupe 2D");
  assert.deepEqual(persisted[0].imageUrls, ["https://images.example.test/corvette.jpg"]);
  assert.equal(persisted[0].descriptionRaw, "Clean title and 48,000 miles");
});
