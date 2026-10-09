import test from "node:test";
import assert from "node:assert/strict";
import { FacebookGraphqlClient, ListingDetailUnavailableError } from "../src/facebookGraphqlClient.js";
import { createFacebookGraphqlConnector } from "../src/facebookConnector.js";
import { createFacebookRequestLimiter } from "../src/facebookRequestLimiter.js";
import { runProfileSync, shouldFetchDetail } from "../src/syncEngine.js";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { executeCollectorJob } from "../src/collectorAgent.js";
import { createListingRefresh } from "../src/listingRefresh.js";
import { memoryObservationDbOps } from "./helpers/observationDbOps.js";

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
  const memory = memoryObservationDbOps({ states: refreshStates, failWrites: parserFailures });
  const refreshListing = createListingRefresh({ db: {}, connector, dbOps: memory.ops });
  const run = (runProfile = profile) => runProfileSync({ db: {}, connector, profile: runProfile, dbOps: memory.ops });
  return { client, connector, requests, ...memory, refreshStates, rejected,
    get tokenPages() { return tokenPages; }, run,
    async refresh(id = "102", options) {
      if (!refreshStates.has(id)) await run();
      return refreshListing(id, options);
    }
  };
}

test("search persists every rich card without requesting rejected detail pages", async t => {
  const scenario = setup(t);
  const run = await scenario.run();
  assert.equal(run.status, "completed");
  assert.equal(run.resultsFound, 3);
  assert.equal(run.detailPagesOpened, 0);
  assert.equal(scenario.snapshots.length, 3);
  assert.deepEqual(scenario.requests, []);
  assert.equal(scenario.finishes[0].alertsCreated, 0);
  assert.equal(scenario.refreshStates.get("102").last_scraped_at, undefined);
});

test("a rejected click preserves saved data and does not prevent another listing refresh", async t => {
  const scenario = setup(t);
  await scenario.run();
  await assert.rejects(scenario.refresh("102"), /field_exception/);
  const rejected = scenario.refreshStates.get("102");
  assert.equal(rejected.price_raw, "$12,000");
  assert.equal(rejected.parsed_attributes_json.detailRefresh.status, "incomplete");
  assert.equal(rejected.parsed_attributes_json.detailRefresh.reason, "listing_rejected");
  const next = await scenario.refresh("103");
  assert.equal(next.listing.item.description_raw, "70,000 miles, manual transmission, clean title");
  assert.equal(next.listing.detailRefresh.state, "fresh");
  assert.deepEqual(scenario.requests.map(request => request.id), ["102", "103"]);
  assert.equal(scenario.finishes[0].status, "completed");
});

test("validated delivery omission completes a click refresh and persists bounded provenance", async t => {
  const payload = detailPayload("102");
  Object.assign(payload.data.viewer.marketplace_product_details_page.target, {
    listing_price: { formatted_amount: "$12,000", currency: "USD" },
    location_text: { text: "Oakland, California" },
    marketplace_listing_seller: { id: "seller-1", name: "Test seller" },
    creation_time: 1_757_000_000, is_pending: false, is_sold: false, delivery_data: null
  });
  payload.errors = [{ message: fieldException,
    path: ["viewer", "marketplace_product_details_page", "target", "delivery_data"],
    severity: "ERROR", mids: ["private-mid"], debug_link: null }];
  const scenario = setup(t, { ids: ["102"], rejected: { "102": payload } });
  const result = await scenario.refresh();
  assert.equal(result.cached, false);
  assert.equal(result.listing.detailRefresh.state, "fresh");
  const persisted = scenario.refreshStates.get("102").parsed_attributes_json;
  assert.equal(persisted.detailRefresh.status, "complete");
  assert.deepEqual(persisted.marketplaceMetadata.optionalOmission, { field: "delivery_data", signatureVersion: 1 });
  assert.equal(JSON.stringify(persisted).includes("private-mid"), false);
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
  test(`${name} rejects the click and preserves the completed search`, async t => {
    const scenario = setup(t, { rejected: { "102": response } });
    await assert.rejects(scenario.refresh(), pattern);
    assert.deepEqual(scenario.requests.map(request => request.id), ["102"]);
    assert.equal(scenario.finishes[0].status, "completed");
    assert.equal(scenario.finishes[0].detailPagesOpened, 0);
    assert.equal(scenario.refreshStates.get("102").current_price, 12000);
    assert.equal(scenario.refreshStates.get("102").parsed_attributes_json.detailRefresh.status, "incomplete");
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

function cachedState(overrides = {}) {
  return {
    id: "102", status: "saved", title_raw: "2013 Honda Civic Si",
    description_raw: "70,000 miles, manual transmission, clean title",
    image_urls: ["https://images.example/cached.jpg"], price_raw: "$13,000", current_price: 13000,
    last_scraped_at: new Date().toISOString(), parsed_attributes_json: {}, ...overrides
  };
}

test("card writes retain an incomplete marker until a real successful click refresh", async t => {
  const scenario = setup(t, { ids: ["102"], refreshStates: new Map([["102", cachedState({
    parsed_attributes_json: { detailRefresh: { status: "incomplete", reason: "listing_rejected" } }
  })]]) });
  const run = await scenario.run();
  const incomplete = scenario.refreshStates.get("102");
  assert.equal(run.resultsFound, 1);
  assert.equal(run.alertsCreated, 0);
  assert.equal(incomplete.current_price, 12000);
  assert.equal(incomplete.parsed_attributes_json.detailRefresh.status, "incomplete");
  assert.equal(shouldFetchDetail(incomplete, 24), true);
  assert.deepEqual(scenario.requests, []);
  delete scenario.rejected["102"];
  const result = await scenario.refresh();
  assert.equal(result.listing.detailRefresh.state, "fresh");
  assert.equal(result.listing.item.parsed_attributes_json.detailRefresh.status, "complete");
  assert.deepEqual(scenario.requests.map(request => request.id), ["102"]);
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
  assert.equal(JSON.stringify(response.body.detailDiagnostic.errors[0].unknownFields), '[]');
  assert.equal(response.body.detailDiagnostic.errors[0].extensionsPresent, true);
  assert.equal(JSON.stringify(response.body.detailDiagnostic.errors[0].path), '["viewer","target","[other]","[other]"]');
  assert.doesNotMatch(JSON.stringify(response.body.detailDiagnostic), /private|page-secret|secret\.example|token|cookie/);
  assert.equal(scenario.client.session, null);
});

test("detail diagnostics retain bounded schema names and preserve path positions", async t => {
  const names = Array.from({ length: 20 }, (_, index) => `field_${String.fromCharCode(97 + index)}`);
  const response = { errors: [{ message: fieldException,
    ...Object.fromEntries(names.map(field => [field, "private-value"])),
    path: ["viewer", "marketplace_product_details_page", "target", "optional_schema_field", 123456789,
      "invalid-field", ...names]
  }] };
  const scenario = setup(t, { rejected: { "102": response } });
  await assert.rejects(scenario.client.getListingDetail("102"), error => {
    assert.equal(error instanceof ListingDetailUnavailableError, false);
    const metadata = error.facebookDetailDiagnostic.errors[0];
    assert.deepEqual(metadata.unknownFields, ["field_a", "field_b", "field_c", "field_d", "field_e",
      "field_f", "field_g", "field_h", "field_i", "field_j"]);
    assert.deepEqual(metadata.path, ["viewer", "marketplace_product_details_page", "target", "optional_schema_field",
      "[index]", "[other]", "field_a", "field_b", "field_c", "field_d", "field_e", "field_f",
      "field_g", "field_h", "field_i", "field_j"]);
    assert.doesNotMatch(JSON.stringify(error.facebookDetailDiagnostic), /private-value|123456789|invalid-field/);
    return true;
  });
  assert.equal(scenario.client.session, null);
});

test("detail schema names reject credential fields, malicious strings, and configured session secrets", async t => {
  const credentialFields = ["fb_dtsg", "lsd", "c_user", "xs", "access_token", "cookie", "authorization",
    "password", "jazoest", "csrf", "session_secret", "api_key", "credentials"];
  const rejectedNames = [...credentialFields, "field_pinetree", "riverbend", "forestshade", "plainuser",
    "https://private.example/?data=hidden", "authorization: hidden", "line\nbreak", "listing_12345",
    "MixedCase", "a".repeat(65), ""];
  const acceptedNames = ["optional_schema_field", "a".repeat(64), "_schema_field"];
  const response = { errors: [{ message: fieldException,
    ...Object.fromEntries([...rejectedNames, ...acceptedNames].map(field => [field, "private-value"])),
    path: [...rejectedNames, -1, null, { private: "value" }, ...acceptedNames]
  }] };
  const scenario = setup(t, { rejected: { "102": response } });
  const session = await scenario.client.ensureSession();
  Object.assign(session, { fbDtsg: "pinetree", lsd: "riverbend", cookieHeader: "c_user=plainuser; xs=forestshade" });
  await assert.rejects(scenario.client.getListingDetail("102"), error => {
    const metadata = error.facebookDetailDiagnostic.errors[0];
    assert.deepEqual(metadata.unknownFields, acceptedNames);
    assert.deepEqual(metadata.path, Array(16).fill("[other]"));
    assert.doesNotMatch(JSON.stringify(error.facebookDetailDiagnostic),
      /pinetree|riverbend|forestshade|plainuser|private-value|private\.example|hidden|listing_12345|MixedCase|cookie|authorization|fb_dtsg|access_token|credentials|api_key/);
    return true;
  });
});

test("detail diagnostics report fixed metadata and target presence without private values", async t => {
  const response = detailPayload("102");
  Object.assign(response.data.viewer.marketplace_product_details_page.target, {
    location: null, location_text: { text: "private-location" },
    vehicle_transmission_type: "private-transmission", vehicle_odometer_data: { value: "private-mileage" }
  });
  response.errors = [{ message: fieldException, severity: "CRITICAL", is_transient: false,
    requires_reauth: null, allow_user_retry: true, api_error_code: "private-api-code",
    summary: "private-summary", description: "private-description", locations: [{ line: "private-line" }], mids: ["private-mid"],
    path: ["viewer", "marketplace_product_details_page", "target", "vehicle_transmission_type", "private-leaf"] }];
  const scenario = setup(t, { rejected: { "102": response } });
  await assert.rejects(scenario.client.getListingDetail("102"), error => {
    assert.equal(error instanceof ListingDetailUnavailableError, false);
    const diagnostic = error.facebookDetailDiagnostic;
    const metadata = diagnostic.errors[0];
    assert.equal(metadata.severity, "CRITICAL");
    assert.deepEqual(metadata.flags, { is_transient: false, allow_user_retry: true, requires_reauth: null });
    assert.equal(metadata.unknownFieldCount, 0);
    assert.deepEqual(metadata.arrays, { locations: { shape: "array", count: 1 }, mids: { shape: "array", count: 1 } });
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

test("collector transport retains bounded listing rejection identity and diagnostics", async t => {
  const scenario = setup(t);
  const transported = await executeCollectorJob(scenario.client, {
    operation: "getListingDetail", args: ["102", { fetchPhotos: false }]
  });
  assert.match(transported.error.message, /field_exception/);
  assert.equal(transported.error.name, "ListingDetailUnavailableError");
  assert.equal(transported.error.detailDiagnostic.targetPresent, false);
  assert.doesNotMatch(JSON.stringify(transported.error), /page-secret/);
});
