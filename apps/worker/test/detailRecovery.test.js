import test from "node:test";
import assert from "node:assert/strict";
import { FacebookGraphqlClient, ListingDetailUnavailableError } from "../src/facebookGraphqlClient.js";
import { createFacebookRequestLimiter } from "../src/facebookRequestLimiter.js";
import { detailToRawSourceItem } from "../src/facebookConnector.js";
import { parseVehicleListing } from "../src/vehicleParser.js";

function responsePayload() {
  return {
    data: { viewer: { marketplace_product_details_page: { target: {
      id: "102", marketplace_listing_title: "2013 Honda Civic Si",
      redacted_description: { text: "70,000 miles, manual transmission, clean title" },
      listing_price: { formatted_amount: "$12,000", amount: "12000", currency: "USD" },
      location_text: { text: "Oakland, California" },
      marketplace_listing_seller: { id: "seller-1", name: "Test seller" },
      creation_time: 1_757_000_000, is_pending: false, is_sold: false,
      primary_listing_photo: { image: { uri: "https://images.example/car.jpg" } },
      listing_photos: [], attribute_data: [{ attribute_name: "Transmission", label: "Manual" }],
      vehicle_odometer_data: { unit: "MILES", value: 70000 }, delivery_data: null
    } } } },
    errors: [{
      message: "A server error field_exception occured. Check server logs for details.",
      path: ["viewer", "marketplace_product_details_page", "target", "delivery_data"],
      severity: "ERROR", mids: ["private-mid"], debug_link: "https://debug.example/private-debug"
    }]
  };
}

function setup(t, payload, status = 200) {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(payload), { status }));
  const client = new FacebookGraphqlClient({
    useChromeCookies: false,
    scheduleRequest: createFacebookRequestLimiter({ now: () => 0, sleep: async () => {} })
  });
  client.session = { cookieHeader: "", fbDtsg: "page-token", lsd: "page-lsd", clientRevision: "1" };
  return client;
}

test("detail recovery retains complete domain data and bounded persisted omission metadata", async t => {
  const payload = responsePayload();
  const detail = await setup(t, payload).getListingDetail("102", { fetchPhotos: false });
  assert.equal(detail.title, "2013 Honda Civic Si");
  assert.equal(detail.price, "$12,000");
  assert.equal(detail.location, "Oakland, California");
  assert.equal(detail.mileage, 70000);
  assert.equal(detail.postedDate, "2025-09-04T06:13:20.000Z");
  assert.deepEqual(detail.responseEvidence, { optionalOmission: { field: "delivery_data", signatureVersion: 1 } });
  assert.equal(Object.hasOwn(detail.raw, "delivery_data"), false);
  assert.equal(payload.data.viewer.marketplace_product_details_page.target.delivery_data, null);
  const raw = detailToRawSourceItem(detail);
  const parsed = parseVehicleListing(raw);
  assert.deepEqual(parsed.attributes.marketplaceMetadata.optionalOmission, { field: "delivery_data", signatureVersion: 1 });
  assert.equal(parsed.attributes.mileage, 70000);
  for (const value of ["private-mid", "private-debug", "debug_link", "page-token", "page-lsd"]) {
    assert.equal(JSON.stringify({ detail, raw, parsed }).includes(value), false, value);
  }
});

test("recovery accepts an absent delivery field, empty description, and null debug metadata", async t => {
  const payload = responsePayload();
  delete payload.data.viewer.marketplace_product_details_page.target.delivery_data;
  payload.data.viewer.marketplace_product_details_page.target.redacted_description.text = "";
  payload.errors[0].debug_link = null;
  const detail = await setup(t, payload).getListingDetail("102", { fetchPhotos: false });
  assert.equal(detail.description, "");
  assert.equal(detail.id, "102");
  assert.deepEqual(detail.responseEvidence.optionalOmission, { field: "delivery_data", signatureVersion: 1 });
});

for (const [name, mutate] of [
  ["unknown error key", p => { p.errors[0].unexpected = null; }],
  ["null code", p => { p.errors[0].code = null; }],
  ["null type", p => { p.errors[0].type = null; }],
  ["null extensions", p => { p.errors[0].extensions = null; }],
  ["top-level error", p => { p.error = null; }],
  ["wrong message", p => { p.errors[0].message = "Login required"; }],
  ["wrong path", p => { p.errors[0].path[3] = "listing_price"; }],
  ["wrong severity", p => { p.errors[0].severity = "WARNING"; }],
  ["mixed errors", p => { p.errors.push({ message: "Login required" }); }],
  ["missing mids", p => { delete p.errors[0].mids; }],
  ["multiple mids", p => { p.errors[0].mids.push("second-mid"); }],
  ["malformed mids", p => { p.errors[0].mids = [17]; }],
  ["oversized mids", p => { p.errors[0].mids = ["m".repeat(513)]; }],
  ["malformed debug link", p => { p.errors[0].debug_link = {}; }],
  ["oversized debug link", p => { p.errors[0].debug_link = "d".repeat(2049); }],
  ["non-null delivery field", p => { p.data.viewer.marketplace_product_details_page.target.delivery_data = { mileage: 999000 }; }],
  ["missing target", p => { p.data.viewer.marketplace_product_details_page.target = null; }],
  ["missing ID", p => { delete p.data.viewer.marketplace_product_details_page.target.id; }],
  ["wrong ID", p => { p.data.viewer.marketplace_product_details_page.target.id = "103"; }],
  ["empty title", p => { p.data.viewer.marketplace_product_details_page.target.marketplace_listing_title = " "; }],
  ["missing description", p => { delete p.data.viewer.marketplace_product_details_page.target.redacted_description; }],
  ["malformed description", p => { p.data.viewer.marketplace_product_details_page.target.redacted_description.text = {}; }],
  ["unusable price", p => { p.data.viewer.marketplace_product_details_page.target.listing_price.formatted_amount = "Call seller"; }],
  ["missing currency", p => { delete p.data.viewer.marketplace_product_details_page.target.listing_price.currency; }],
  ["missing location", p => { delete p.data.viewer.marketplace_product_details_page.target.location_text; }],
  ["missing seller ID", p => { delete p.data.viewer.marketplace_product_details_page.target.marketplace_listing_seller.id; }],
  ["missing seller name", p => { delete p.data.viewer.marketplace_product_details_page.target.marketplace_listing_seller.name; }],
  ["missing time", p => { delete p.data.viewer.marketplace_product_details_page.target.creation_time; }],
  ["invalid time", p => { p.data.viewer.marketplace_product_details_page.target.creation_time = "now"; }],
  ["malformed status", p => { p.data.viewer.marketplace_product_details_page.target.is_sold = "false"; }],
  ["malformed photos", p => { p.data.viewer.marketplace_product_details_page.target.listing_photos = {}; }],
  ["malformed photo URI", p => { p.data.viewer.marketplace_product_details_page.target.listing_photos = [{ image: { uri: {} } }]; }],
  ["malformed attributes", p => { p.data.viewer.marketplace_product_details_page.target.attribute_data = {}; }],
  ["malformed attribute value", p => { p.data.viewer.marketplace_product_details_page.target.attribute_data[0].label = []; }],
  ["malformed vehicle value", p => { p.data.viewer.marketplace_product_details_page.target.vehicle_odometer_data.value = []; }],
  ["malformed subtitles", p => { p.data.viewer.marketplace_product_details_page.target.custom_sub_titles_with_rendering_flags = {}; }]
]) {
  test(`detail recovery rejects ${name} before parser defaults or card fallback`, async t => {
    const payload = responsePayload();
    mutate(payload);
    await assert.rejects(setup(t, payload).getListingDetail("102", { fetchPhotos: false }), error => {
      assert.equal(error instanceof ListingDetailUnavailableError, false);
      assert.match(error.message, /Facebook rejected/);
      assert.equal(JSON.stringify(error).includes("private-debug"), false);
      assert.equal(JSON.stringify(error).includes("private-mid"), false);
      return true;
    });
  });
}

for (const status of [401, 403, 429]) {
  test(`detail recovery preserves HTTP ${status} rejection`, async t => {
    await assert.rejects(setup(t, responsePayload(), status).getListingDetail("102"), status === 429
      ? { code: "FACEBOOK_COOLDOWN" } : /session/);
  });
}

test("detail recovery preserves GraphQL throttling rejection", async t => {
  const payload = responsePayload();
  payload.errors[0].code = 1675004;
  await assert.rejects(setup(t, payload).getListingDetail("102"), { code: "FACEBOOK_COOLDOWN" });
});

for (const [name, run] of [
  ["search", client => client.searchListings({ query: "Civic", limit: 1 })],
  ["location", client => client.searchLocation("Oakland")],
  ["generic detail request", client => client.graphqlRequest("26924013917190310", { targetId: "102" })],
  ["photos", client => client.graphqlRequest("10059604367394414", { targetId: "102" })]
]) {
  test(`optional delivery recovery does not apply to ${name}`, async t => {
    await assert.rejects(run(setup(t, responsePayload())), /Facebook rejected/);
  });
}

test("clean detail responses retain existing sparse parser behavior", async t => {
  const payload = { data: { viewer: { marketplace_product_details_page: { target: { id: "102" } } } } };
  const detail = await setup(t, payload).getListingDetail("102", { fetchPhotos: false });
  assert.equal(detail.id, "102");
  assert.equal(detail.title, "");
  assert.equal(detail.description, "");
  assert.equal(detail.responseEvidence, undefined);
});
