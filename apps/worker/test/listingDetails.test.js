import test from "node:test";
import assert from "node:assert/strict";
import { detailRefreshFor, listingCollectionState, mergeListingObservation, parseListingObservation } from "../src/listingDetails.js";

const now = Date.parse("2026-10-09T12:00:00Z");
const item = {
  id: "item-1", status: "new", title_raw: "2013 Honda Civic Si",
  description_raw: "Manual transmission. Clean title. 70,000 miles. Coilovers.",
  price_raw: "$12,000", current_price: 12000, seller_raw: "Saved seller",
  image_urls: ["https://images.test/thumb.jpg", "https://images.test/gallery.jpg"],
  posted_at: "2026-10-08T12:00:00Z", last_scraped_at: "2026-10-09T11:00:00Z",
  parsed_attributes_json: {
    mileage: 70000,
    marketplaceAttributes: { transmission: "Manual", trim: "Si" },
    marketplaceMetadata: { customTitle: "Sport coupe", subtitles: ["70,000 miles"], sellerId: "seller-1", isSold: false }
  }
};

test("fresh successful empty descriptions and absent photos do not require another click fetch", () => {
  const state = detailRefreshFor({ ...item, description_raw: "", image_urls: [] }, [], now);
  assert.deepEqual(state, { state: "fresh", needsRefresh: false, lastFetchedAt: "2026-10-09T11:00:00Z" });
  assert.deepEqual(detailRefreshFor({ ...item, last_scraped_at: null }, [], now),
    { state: "missing", needsRefresh: true, lastFetchedAt: null });
});

test("freshness uses linked profile intervals and the shorter saved-item interval", () => {
  const older = { ...item, last_scraped_at: "2026-10-08T23:00:00Z" };
  assert.equal(detailRefreshFor(older, [], now).state, "fresh");
  assert.equal(detailRefreshFor({ ...older, status: "saved" }, [], now).state, "stale");
  assert.equal(detailRefreshFor(older, [{ filtersJson: { staleDetailHours: 8 } }], now).state, "stale");
  assert.equal(detailRefreshFor({ ...item, parsed_attributes_json: { detailRefresh: { status: "incomplete" } } }, [], now).state, "incomplete");
});

test("card observations retain detail evidence, gallery, seller and all supplied marketplace fields", () => {
  const raw = mergeListingObservation(item, {
    titleRaw: "2013 Honda Civic Si", priceRaw: "$11,000", imageUrls: ["https://images.test/new-thumb.jpg"],
    vehicleAttributes: { transmission: "", condition: "Used" },
    sourceMetadata: { sellerId: undefined, customTitle: "", subtitles: [], isPending: true, detailFetched: false }
  });
  assert.equal(raw.descriptionRaw, "Manual transmission. Clean title. 70,000 miles. Coilovers.");
  assert.equal(raw.priceRaw, "$11,000");
  assert.equal(raw.mileage, 70000);
  assert.equal(raw.sellerRaw, "Saved seller");
  assert.deepEqual(raw.imageUrls, ["https://images.test/thumb.jpg", "https://images.test/gallery.jpg", "https://images.test/new-thumb.jpg"]);
  assert.deepEqual(raw.vehicleAttributes, { transmission: "Manual", trim: "Si", condition: "Used" });
  assert.deepEqual(raw.sourceMetadata, { customTitle: "Sport coupe", subtitles: ["70,000 miles"], sellerId: "seller-1", isSold: false,
    postedDate: "2026-10-08T12:00:00Z", isPending: true, detailFetched: false });
});

test("qualification stays separate for every current linked profile", () => {
  const state = listingCollectionState(item, [
    { id: "manual", name: "Manual Civic", filtersJson: { transmission: "manual", cleanTitleOnly: true } },
    { id: "automatic", name: "Automatic Civic", filtersJson: { transmission: "automatic" } },
    { id: "newer", name: "Newer Civic", filtersJson: { yearMin: 2018 } }
  ], now);
  assert.deepEqual(state.qualifications, [
    { profileId: "manual", profileName: "Manual Civic", state: "match", failedFields: [], missingFields: [] },
    { profileId: "automatic", profileName: "Automatic Civic", state: "mismatch", failedFields: ["transmission"], missingFields: [] },
    { profileId: "newer", profileName: "Newer Civic", state: "mismatch", failedFields: ["yearMin"], missingFields: [] }
  ]);
  assert.equal(state.detailRefresh.state, "fresh");
});

test("a replacing detail description drops superseded text signals while card-only runs retain them", () => {
  const stale = {
    ...item,
    description_raw: "Salvage title. Transmission slipping. 70,000 miles.",
    red_flags_json: ["salvage", "transmission slipping"],
    positive_signals_json: []
  };
  const replaced = parseListingObservation(stale, {
    titleRaw: "2013 Honda Civic Si",
    descriptionRaw: "Clean title. Recent service. 70,000 miles.",
    sourceMetadata: { detailFetched: true }
  });
  assert.ok(!replaced.redFlags.includes("salvage"));
  assert.ok(!replaced.redFlags.includes("transmission slipping"));
  assert.ok(replaced.positiveSignals.includes("clean title"));
  assert.ok(replaced.positiveSignals.includes("recent service"));
  const retained = parseListingObservation(stale, {
    titleRaw: "Honda Civic Si",
    sourceMetadata: { detailFetched: false }
  });
  assert.ok(retained.redFlags.includes("salvage"));
});
