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
        descriptionRaw: card.rawCardText,
        priceRaw: card.priceRaw,
        locationRaw: card.locationRaw,
        imageUrls: [card.thumbnailUrl],
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

test("ordinary GraphQL search completes without serial detail requests", async () => {
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

test("GraphQL HTTP search flows through connector and run persistence without detail calls", async (t) => {
  const graphqlCalls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).includes("/marketplace/")) {
      return new Response('<script>"DTSGInitData",[],{"token":"test-token"}</script>', { status: 200 });
    }
    graphqlCalls.push(options.body);
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

  assert.equal(graphqlCalls.length, 1, "a routine run sends only the search GraphQL operation");
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(persisted[0].sourceItemId, "listing-graphql-1");
  assert.equal(persisted[0].imageUrls[0], "https://example.test/car.jpg");
});
