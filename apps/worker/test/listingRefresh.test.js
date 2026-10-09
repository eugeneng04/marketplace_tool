import test from "node:test";
import assert from "node:assert/strict";
import { createListingRefresh } from "../src/listingRefresh.js";
import { memoryObservationDbOps } from "./helpers/observationDbOps.js";

function scenario({ fresh = false, description = "Saved description", images = ["https://images.test/thumb.jpg"] } = {}) {
  const item = {
    id: "listing-1", source: "facebook_marketplace", source_item_id: "listing-1",
    url: "https://www.facebook.com/marketplace/item/listing-1/",
    normalized_url: "https://www.facebook.com/marketplace/item/listing-1/",
    title_raw: "2013 Honda Civic Si", description_raw: description, price_raw: "$12,000", current_price: 12000,
    image_urls: images, status: "saved", last_scraped_at: fresh ? new Date().toISOString() : null,
    parsed_attributes_json: { mileage: 70000, marketplaceAttributes: { transmission: "Manual" } }
  };
  const memory = memoryObservationDbOps({ states: new Map([["listing-1", item]]) });
  const calls = [];
  const connector = { async fetchListingDetail(card, options) {
    calls.push({ card, options });
    return {
      source: "facebook_marketplace", sourceItemId: card.sourceItemId, url: card.listingUrl,
      normalizedUrl: card.listingUrl, titleRaw: "2013 Honda Civic Si", priceRaw: "$11,000",
      descriptionRaw: "Manual transmission, clean title", imageUrls: [], sourceMetadata: {}
    };
  } };
  return { memory, connector, calls, refresh: createListingRefresh({ db: {}, connector, dbOps: memory.ops }) };
}

test("fresh clicks return saved data without fetching, even for empty descriptions and photos", async () => {
  const subject = scenario({ fresh: true, description: "", images: [] });
  const result = await subject.refresh("listing-1");
  assert.equal(result.cached, true);
  assert.equal(result.listing.item.current_price, 12000);
  assert.equal(result.listing.detailRefresh.state, "fresh");
  assert.deepEqual(subject.calls, []);
  const forced = await subject.refresh("listing-1", { force: true });
  assert.equal(forced.cached, false);
  assert.equal(forced.listing.item.current_price, 11000);
  assert.deepEqual(subject.calls[0].options, { fetchPhotos: false });
});

test("simultaneous missing-detail clicks share one request and preserve the thumbnail", async () => {
  const subject = scenario();
  const direct = subject.connector.fetchListingDetail.bind(subject.connector);
  let release;
  subject.connector.fetchListingDetail = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return direct(...args);
  };
  const first = subject.refresh("listing-1");
  const second = subject.refresh("listing-1");
  await new Promise(resolve => setImmediate(resolve));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results[0], results[1]);
  assert.equal(subject.calls.length, 1);
  assert.equal(results[0].listing.item.description_raw, "Manual transmission, clean title");
  assert.deepEqual(results[0].listing.item.image_urls, ["https://images.test/thumb.jpg"]);
  const later = await subject.refresh("listing-1");
  assert.equal(later.cached, true);
  assert.equal(later.listing.item.current_price, 11000);
  assert.equal(subject.calls.length, 1);
});

test("explicit photo loading can enrich a fresh item and passes fetchPhotos true", async () => {
  const subject = scenario({ fresh: true });
  const result = await subject.refresh("listing-1", { fetchPhotos: true });
  assert.equal(result.cached, false);
  assert.equal(result.listing.item.current_price, 11000);
  assert.deepEqual(subject.calls[0].options, { fetchPhotos: true });
});

test("refresh failure retains all saved facts and permits a successful retry", async () => {
  const subject = scenario();
  const direct = subject.connector.fetchListingDetail.bind(subject.connector);
  const error = new Error("Configured Facebook session rejected");
  subject.connector.fetchListingDetail = async () => { throw error; };
  await assert.rejects(subject.refresh("listing-1"), error);
  const item = subject.memory.states.get("listing-1");
  assert.equal(item.description_raw, "Saved description");
  assert.equal(item.current_price, 12000);
  assert.equal(item.last_scraped_at, null);
  assert.equal(item.parsed_attributes_json.detailRefresh.status, "incomplete");
  assert.deepEqual(item.image_urls, ["https://images.test/thumb.jpg"]);
  subject.connector.fetchListingDetail = direct;
  const retry = await subject.refresh("listing-1");
  assert.equal(retry.listing.detailRefresh.state, "fresh");
  assert.equal(retry.listing.item.current_price, 11000);
});

test("a photo request during a text-only refresh chains one gallery fetch instead of being dropped", async () => {
  const subject = scenario();
  const direct = subject.connector.fetchListingDetail.bind(subject.connector);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  subject.connector.fetchListingDetail = async (card, options) => {
    if (options.fetchPhotos !== true) await gate;
    return direct(card, options);
  };
  const text = subject.refresh("listing-1");
  await new Promise(resolve => setImmediate(resolve));
  const photo = subject.refresh("listing-1", { fetchPhotos: true });
  const photoAgain = subject.refresh("listing-1", { fetchPhotos: true });
  assert.equal(photo, photoAgain);
  assert.notEqual(text, photo);
  release();
  const [textResult, photoResult] = await Promise.all([text, photo]);
  assert.equal(subject.calls.length, 2);
  assert.deepEqual(subject.calls[0].options, { fetchPhotos: false });
  assert.deepEqual(subject.calls[1].options, { fetchPhotos: true });
  assert.equal(textResult.listing.item.description_raw, "Manual transmission, clean title");
  assert.equal(photoResult.listing.item.description_raw, "Manual transmission, clean title");
  const later = await subject.refresh("listing-1");
  assert.equal(later.cached, true);
  assert.equal(subject.calls.length, 2);
});
