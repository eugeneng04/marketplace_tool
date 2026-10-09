import test from "node:test";
import assert from "node:assert/strict";
import { FacebookGraphqlClient, ListingDetailUnavailableError } from "../src/facebookGraphqlClient.js";
import { createFacebookGraphqlConnector } from "../src/facebookConnector.js";
import { createFacebookRequestLimiter } from "../src/facebookRequestLimiter.js";
import { runProfileSync, shouldFetchDetail } from "../src/syncEngine.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { executeCollectorJob } from "../src/collectorAgent.js";

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

function setup(t, { ids = ["101", "102", "103"], rejected = { "102": { errors: [{ message: fieldException }] } }, refreshStates = new Map(), operations = {}, parserFailures = 0 } = {}) {
  const requests = [];
  let tokenPages = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!String(url).includes("/api/graphql/")) {
      tokenPages += 1;
      return new Response('"DTSGInitData",[],{"token":"page-secret"}');
    }
    const body = new URLSearchParams(options.body);
    const variables = JSON.parse(body.get("variables"));
    if (operations[body.get("doc_id")]) return Response.json(operations[body.get("doc_id")]);
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
        last_scraped_at: args.rawItem.sourceMetadata.detailFetched ? new Date().toISOString() : prior?.last_scraped_at,
        parsed_attributes_json: { ...prior?.parsed_attributes_json,
          ...(args.detailRefresh ? { detailRefresh: args.detailRefresh } : {}) }
      });
      return { itemId: id, isNew: !prior };
    },
    async saveParsedItem(_db, id, parsed) {
      if (parserFailures > 0) {
        parserFailures -= 1;
        throw new Error("Synthetic parser failure");
      }
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
    run: (runProfile = profile) => runProfileSync({ db: {}, connector, profile: runProfile, dbOps })
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

test("an errored partial target is discarded without photos or fallback and preserves the session", async t => {
  const scenario = setup(t, { rejected: { "102": { ...detailPayload("102"), errors: [{ message: fieldException }] } } });
  const session = await scenario.client.ensureSession();
  await assert.rejects(scenario.client.getListingDetail("102"), error => {
    assert.equal(error instanceof ListingDetailUnavailableError, true);
    assert.equal(error.sourceItemId, "102");
    assert.equal(error.facebookDetailDiagnostic.targetPresent, true);
    return true;
  });
  assert.equal(scenario.client.session, session);
  assert.deepEqual(scenario.requests, [{ id: "102", docId: "26924013917190310" }]);
  const next = await scenario.client.getListingDetail("103", { fetchPhotos: false });
  assert.equal(next.id, "103");
  assert.equal(scenario.tokenPages, 1);
});

for (const [name, response, pattern] of [
  ["unknown code", { errors: [{ message: fieldException, code: 999 }] }, /999/],
  ["unknown type", { errors: [{ message: fieldException, type: "AuthenticationError" }] }, /field_exception/],
  ["extension code", { errors: [{ message: fieldException, extensions: { code: 999 } }] }, /999/],
  ["extension type", { errors: [{ message: fieldException, extensions: { type: "UnknownError" } }] }, /field_exception/],
  ["mixed errors", { errors: [{ message: fieldException }, { message: "Login required" }] }, /Login required/],
  ["duplicate errors", { errors: [{ message: fieldException }, { message: fieldException }] }, /field_exception/],
  ["top-level error", { error: 123, errors: [{ message: fieldException }] }, /field_exception/],
  ["null top-level error", { error: null, errors: [{ message: fieldException }] }, /field_exception/],
  ["different message", { errors: [{ message: "Please log in" }] }, /Please log in/],
  ["sanitizer lookalike", { errors: [{ message: `${fieldException}<b></b>` }] }, /field_exception/],
  ["malformed error object", { errors: [fieldException] }, /rejected/],
  ["malformed errors envelope", { errors: { message: fieldException } }, /rejected/],
  ["unknown error fields", { errors: [{ message: fieldException, severity: "CRITICAL" }] }, /field_exception/],
  ["HTTP 401", new Response("", { status: 401 }), /session/],
  ["HTTP 403", new Response("", { status: 403 }), /session/],
  ["HTTP 500", new Response("", { status: 500 }), /HTTP 500/],
  ["cooldown code", { errors: [{ message: fieldException, code: 1675004 }] }, /rate limit/],
  ["network failure", new Error("Network failed"), /Network failed/],
  ["timeout", new Error("Request timed out"), /timed out/],
  ["parse failure", new Response("invalid JSON"), /Could not parse/]
]) {
  test(`${name} stops later details and preserves failed finalization`, async t => {
    const scenario = setup(t, { rejected: { "102": response } });
    await assert.rejects(scenario.run(), pattern);
    assert.deepEqual(scenario.requests.map(request => request.id), ["101", "102"]);
    assert.equal(scenario.finishes[0].status, "failed");
    assert.equal(scenario.finishes[0].detailPagesOpened, 1);
    assert.equal(scenario.finishes[0].alertsCreated, 0);
    if (!(response instanceof Response) && !(response instanceof Error) && name !== "cooldown code") {
      assert.equal(scenario.client.session, null);
    }
  });
}

for (const docId of ["7111939778879383", "5585904654783609", "10059604367394414", "unknown-doc"]) {
  test(`field rejection remains fatal outside the listing detail document ${docId}`, async t => {
    const response = { errors: [{ message: fieldException }] };
    const scenario = setup(t, { operations: { [docId]: response } });
    await assert.rejects(scenario.client.graphqlRequest(docId, { targetId: "102" }), error => {
      assert.equal(error instanceof ListingDetailUnavailableError, false);
      assert.match(error.message, /field_exception/);
      return true;
    });
    assert.equal(scenario.client.session, null);
  });
}

test("a fatal error after an isolated failure stops the queue and retains both failures", async t => {
  const scenario = setup(t, { ids: ["101", "102", "103", "104"], rejected: {
    "102": { errors: [{ message: fieldException }] },
    "103": { errors: [{ message: "Fatal query error", code: 456 }] }
  } });
  await assert.rejects(scenario.run(), error => {
    assert.match(error.message, /456: Fatal query error/);
    assert.match(error.message, /1 succeeded; 1 rejected listing.*102/);
    return true;
  });
  assert.deepEqual(scenario.requests.map(request => request.id), ["101", "102", "103"]);
  assert.match(scenario.finishes[0].errorMessage, /Fatal query error.*102/);
  assert.equal(scenario.parsedItems.get("104").attributes.detailRefresh.reason, "collection_interrupted");
});

test("multiple isolated failures retain a bounded summary before profile filtering", async t => {
  const ids = Array.from({ length: 14 }, (_, index) => `${101 + index}`);
  const rejected = Object.fromEntries(ids.map(id => [id, { errors: [{ message: fieldException }] }]));
  const scenario = setup(t, { ids, rejected });
  await assert.rejects(scenario.run({ ...profile, filtersJson: { ...profile.filtersJson, transmission: "manual" } }), /14 rejected listing/);
  assert.equal(scenario.requests.length, 14);
  assert.equal(scenario.snapshots.length, 0);
  assert.equal(scenario.finishes[0].resultsFound, 0);
  assert.match(scenario.finishes[0].errorMessage, /101, 102.*110, and 4 more/);
  assert.doesNotMatch(scenario.finishes[0].errorMessage, /111|112|113|114/);
});

function cachedState(overrides = {}) {
  return {
    id: "102", status: "saved", title_raw: "2013 Honda Civic Si",
    description_raw: "70,000 miles, manual transmission, clean title",
    image_urls: ["https://images.example/cached.jpg"], price_raw: "$13,000", current_price: 14000,
    last_scraped_at: new Date().toISOString(),
    parsed_attributes_json: { marketplaceMetadata: { detailFetched: true } }, ...overrides
  };
}

test("an incomplete cached refresh retries after persistence removes its price mismatch", async t => {
  const scenario = setup(t, { ids: ["102"], refreshStates: new Map([["102", cachedState()]]) });
  await assert.rejects(scenario.run(), /102/);
  const incomplete = scenario.refreshStates.get("102");
  assert.equal(incomplete.current_price, 12000);
  assert.equal(incomplete.price_raw, "$12,000");
  assert.equal(scenario.snapshots[0].sourceMetadata.detailFetched, false);
  assert.equal(shouldFetchDetail(incomplete, 24), true);
  delete scenario.rejected["102"];
  const run = await scenario.run();
  assert.equal(run.status, "completed");
  assert.equal(run.detailPagesOpened, 1);
  assert.deepEqual(scenario.requests.map(request => request.id), ["102", "102"]);
  assert.equal(scenario.parsedItems.get("102").attributes.detailRefresh.status, "complete");
  assert.equal(shouldFetchDetail(scenario.refreshStates.get("102"), 24), false);
});

test("a parser failure after the snapshot still retries rejected cached details", async t => {
  const scenario = setup(t, {
    ids: ["102"], parserFailures: 1,
    refreshStates: new Map([["102", cachedState({
      parsed_attributes_json: { detailRefresh: { status: "complete" } }
    })]])
  });
  await assert.rejects(scenario.run(), /Synthetic parser failure/);
  const incomplete = scenario.refreshStates.get("102");
  assert.equal(incomplete.current_price, 12000);
  assert.equal(incomplete.price_raw, "$12,000");
  assert.equal(incomplete.parsed_attributes_json.detailRefresh.status, "incomplete");
  assert.equal(shouldFetchDetail(incomplete, 24), true);
  delete scenario.rejected["102"];
  const next = await scenario.run();
  assert.equal(next.status, "completed");
  assert.equal(next.detailPagesOpened, 1);
  assert.deepEqual(scenario.requests.map(request => request.id), ["102", "102"]);
  assert.equal(scenario.parsedItems.get("102").attributes.detailRefresh.status, "complete");
});

test("excluded cached failures retain the original refresh trigger without saving excluded items", async t => {
  const prior = cachedState({ description_raw: "70,000 miles, automatic transmission" });
  const scenario = setup(t, { ids: ["102"], refreshStates: new Map([["102", prior]]) });
  const filtered = { ...profile, filtersJson: { ...profile.filtersJson, transmission: "manual" } };
  await assert.rejects(scenario.run(filtered), /102/);
  assert.equal(scenario.snapshots.length, 0);
  assert.equal(scenario.refreshStates.get("102"), prior);
  assert.equal(prior.current_price, 14000);
  assert.equal(prior.price_raw, "$13,000");
  assert.equal(shouldFetchDetail(prior, 24), true);
  await assert.rejects(scenario.run(filtered), /102/);
  assert.deepEqual(scenario.requests.map(request => request.id), ["102", "102"]);
});

test("incomplete refresh markers still respect hidden, sold, and rejected status", () => {
  const state = cachedState({ parsed_attributes_json: { detailRefresh: { status: "incomplete" } } });
  assert.equal(shouldFetchDetail(state, 24), true);
  for (const status of ["hidden", "sold", "rejected"]) {
    assert.equal(shouldFetchDetail({ ...state, status }, 24), false);
  }
});

test("unknown detail diagnostics expose bounded structure through the API error response", async t => {
  const scenario = setup(t, { rejected: { "102": {
    ...detailPayload("102"), errors: [{ message: "private page-secret https://secret.example/?token=private",
      code: 999, type: "page-secret", path: ["viewer", "target", "page-secret", "https://secret.example/?token=private"],
      cookie: "private", extensions: { token: "private" } }]
  } } });
  let rejection;
  await assert.rejects(scenario.client.getListingDetail("102"), error => { rejection = error; return true; });
  const source = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const start = source.indexOf('      const message = error instanceof Error ? error.message : "Unexpected error";');
  const end = source.indexOf("\n    }\n  });", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ Error, Date, Math, sendJson: (_res, status, body) => ({ status, body }) });
  const sendError = vm.runInContext(`(error, res) => { ${source.slice(start, end)} }`, context);
  const response = sendError(rejection, {});
  assert.equal(response.status, 500);
  assert.equal(response.body.detailDiagnostic.targetPresent, true);
  assert.equal(response.body.detailDiagnostic.errors[0].code, 999);
  assert.equal(response.body.detailDiagnostic.errors[0].typePresent, true);
  assert.equal(response.body.detailDiagnostic.errors[0].typeShape, "string");
  assert.equal(JSON.stringify(response.body.detailDiagnostic.errors[0].knownFields), '["message","code","type","path","extensions"]');
  assert.equal(response.body.detailDiagnostic.errors[0].unknownFieldCount, 1);
  assert.equal(response.body.detailDiagnostic.errors[0].extensionsPresent, true);
  assert.equal(JSON.stringify(response.body.detailDiagnostic.errors[0].path), '["viewer","target","[other]","[other]"]');
  assert.doesNotMatch(JSON.stringify(response.body.detailDiagnostic), /private|page-secret|secret\.example|token|cookie/);
  assert.equal(scenario.client.session, null);
});

test("detail diagnostics report fixed metadata and target presence without private values", async t => {
  const response = detailPayload("102");
  Object.assign(response.data.viewer.marketplace_product_details_page.target, {
    location: null, location_text: { text: "private-location" },
    vehicle_transmission_type: "private-transmission", vehicle_odometer_data: { value: "private-mileage" }
  });
  response.errors = [{ message: fieldException, severity: "CRITICAL", is_transient: false,
    requires_reauth: null, allow_user_retry: true, api_error_code: "private-api-code",
    summary: "private-summary", description: "private-description", locations: [{ line: "private-line" }],
    path: ["viewer", "marketplace_product_details_page", "target", "vehicle_transmission_type", "private-leaf"] }];
  const scenario = setup(t, { rejected: { "102": response } });
  await assert.rejects(scenario.client.getListingDetail("102"), error => {
    assert.equal(error instanceof ListingDetailUnavailableError, false);
    const diagnostic = error.facebookDetailDiagnostic;
    const metadata = diagnostic.errors[0];
    assert.equal(metadata.severity, "CRITICAL");
    assert.deepEqual(metadata.flags, { is_transient: false, allow_user_retry: true, requires_reauth: null });
    assert.equal(metadata.unknownFieldCount, 0);
    for (const field of ["locations", "api_error_code", "summary", "description"]) assert.ok(metadata.knownFields.includes(field));
    assert.deepEqual(metadata.path, ["viewer", "marketplace_product_details_page", "target", "vehicle_transmission_type", "[other]"]);
    assert.equal(diagnostic.targetFields.id, true);
    assert.equal(diagnostic.targetFields.marketplace_listing_title, true);
    assert.equal(diagnostic.targetFields.listing_price, true);
    assert.equal(diagnostic.targetFields.redacted_description, true);
    assert.equal(diagnostic.targetFields.location, false);
    assert.equal(diagnostic.targetFields.location_text, true);
    assert.equal(diagnostic.targetFields.vehicle_transmission_type, true);
    assert.equal(diagnostic.targetFields.vehicle_odometer_data, true);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private|2013|12,000|70,000|102/);
    return true;
  });
  scenario.rejected["102"].errors[0].severity = "private-severity";
  scenario.rejected["102"].errors[0].is_transient = "private-flag";
  await assert.rejects(scenario.client.getListingDetail("102"), error => {
    assert.equal(error.facebookDetailDiagnostic.errors[0].severity, "[other]");
    assert.equal(error.facebookDetailDiagnostic.errors[0].flags.is_transient, "string");
    assert.doesNotMatch(JSON.stringify(error.facebookDetailDiagnostic), /private/);
    return true;
  });
});

test("collector transport that loses the listing error identity remains fatal", async t => {
  const scenario = setup(t);
  const transported = await executeCollectorJob(scenario.client, {
    operation: "getListingDetail", args: ["102", { fetchPhotos: false }]
  });
  assert.match(transported.error.message, /field_exception/);
  const remoteError = new Error(transported.error.message);
  remoteError.code = "FACEBOOK_LISTING_DETAIL_UNAVAILABLE";
  const direct = scenario.connector.fetchListingDetail.bind(scenario.connector);
  scenario.connector.fetchListingDetail = card => card.sourceItemId === "102" ? Promise.reject(remoteError) : direct(card);
  await assert.rejects(scenario.run(), error => error === remoteError);
  assert.deepEqual(scenario.requests.map(request => request.id), ["102", "101"]);
  assert.equal(scenario.finishes[0].status, "failed");
  assert.equal(scenario.finishes[0].detailPagesOpened, 1);
});
