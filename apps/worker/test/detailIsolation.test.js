import test from "node:test";
import assert from "node:assert/strict";
import { FacebookGraphqlClient } from "../src/facebookGraphqlClient.js";
import { createFacebookGraphqlConnector } from "../src/facebookConnector.js";
import { createFacebookRequestLimiter } from "../src/facebookRequestLimiter.js";
import { runProfileSync } from "../src/syncEngine.js";

const fieldException = "A server error field_exception occured. Check server logs for details.";
const profile = {
  id: "profile-1", query: "Civic", category: "car", location: "Oakland",
  filtersJson: { latitude: 37, longitude: -122 }
};

function listing(id) {
  return {
    id, marketplace_listing_title: "2013 Honda Civic Si",
    listing_price: { formatted_amount: "$12,000" },
    primary_listing_photo: { image: { uri: `https://images.example/${id}.jpg` } },
    redacted_description: { text: "70,000 miles, manual transmission, clean title" }
  };
}

function detailPayload(id) {
  return { data: { viewer: { marketplace_product_details_page: { target: listing(id) } } } };
}

function setup(t, { ids = ["101", "102", "103"], rejected = { "102": { errors: [{ message: fieldException }] } }, refreshStates = new Map() } = {}) {
  const requests = [];
  let tokenPages = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).includes("/api/graphql/")) {
      tokenPages += 1;
      return new Response('"DTSGInitData",[],{"token":"page-secret"}');
    }
    const body = new URLSearchParams(options.body);
    const variables = JSON.parse(body.get("variables"));
    if (body.get("doc_id") === "7111939778879383") {
      return Response.json({ data: { marketplace_search: { feed_units: {
        edges: ids.map(id => ({ node: { listing: listing(id) } })),
        page_info: { has_next_page: false }
      } } } });
    }
    requests.push({ id: variables.targetId, docId: body.get("doc_id") });
    const response = rejected[variables.targetId];
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response ?? detailPayload(variables.targetId));
  });
  const scheduleRequest = createFacebookRequestLimiter({ now: () => 0, sleep: async () => {} });
  const client = new FacebookGraphqlClient({ useChromeCookies: false, scheduleRequest });
  const connector = createFacebookGraphqlConnector({ client, maxCardsPerRun: ids.length });
  const snapshots = [];
  const parsedItems = new Map();
  const finishes = [];
  const dbOps = {
    async startSearchRun() { return { id: "run-1" }; },
    async getItemRefreshState(_db, identity) { return refreshStates.get(identity.sourceItemId) ?? null; },
    async upsertRawItemSnapshot(_db, args) {
      snapshots.push(args.rawItem);
      const id = args.rawItem.sourceItemId;
      const prior = refreshStates.get(id);
      refreshStates.set(id, {
        ...prior, status: prior?.status ?? "new", title_raw: args.rawItem.titleRaw,
        description_raw: args.rawItem.descriptionRaw, image_urls: args.rawItem.imageUrls,
        price_raw: args.rawItem.priceRaw, current_price: args.parsedPrice,
        last_scraped_at: args.rawItem.sourceMetadata.detailFetched ? new Date().toISOString() : prior?.last_scraped_at
      });
      return { itemId: id, isNew: !prior };
    },
    async saveParsedItem(_db, id, parsed) {
      parsedItems.set(id, parsed);
      refreshStates.get(id).parsed_attributes_json = parsed.attributes;
    },
    async computeMarketStats() { return { medianPrice: 20000, sampleSize: 10 }; },
    async upsertDealScore() {},
    async finishSearchRun(_db, _id, summary, _profileId, alertIds) {
      finishes.push({ ...summary, alertIds });
      return summary.status === "completed" ? alertIds.length : 0;
    }
  };
  return { client, connector, requests, snapshots, parsedItems, finishes, refreshStates, rejected,
    get tokenPages() { return tokenPages; },
    run: () => runProfileSync({ db: {}, connector, profile, dbOps })
  };
}

test("one listing field rejection leaves that item incomplete and continues later details", async t => {
  const scenario = setup(t);
  await assert.rejects(scenario.run(), /detail/i);
  assert.deepEqual(scenario.requests.map(request => request.id), ["101", "102", "103"]);
  assert.equal(scenario.finishes.length, 1);
  assert.equal(scenario.finishes[0].status, "failed");
  assert.equal(scenario.finishes[0].detailPagesOpened, 2);
  assert.equal(scenario.finishes[0].alertsCreated, 0);
  assert.deepEqual(scenario.snapshots.map(raw => raw.sourceMetadata.detailFetched), [true, false, true]);
  assert.equal(scenario.parsedItems.get("102").attributes.detailRefresh.status, "incomplete");
  assert.equal(scenario.tokenPages, 1);
});
