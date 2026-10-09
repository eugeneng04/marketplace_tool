import { mergeListingObservation, listingCollectionState } from "../../src/listingDetails.js";
import { qualifyProfile } from "../../src/profileQualification.js";
import { parseVehicleListing } from "../../src/vehicleParser.js";
import { parsePrice } from "../../src/utils.js";
import { scoreListing } from "../../src/dealScoring.js";

export function memoryObservationDbOps({ states = new Map(), failWrites = 0 } = {}) {
  const snapshots = [];
  const parsedItems = new Map();
  const finishes = [];
  const ops = {
    async startSearchRun() { return { id: "run-1" }; },
    async getItemRefreshState(_db, identity) { return states.get(identity.sourceItemId) ?? null; },
    async upsertRawItemSnapshot(_db, args) {
      if (failWrites > 0) { failWrites -= 1; throw new Error("Synthetic observation failure"); }
      const id = args.itemId ?? args.rawItem.sourceItemId;
      const prior = states.get(id);
      const raw = mergeListingObservation(prior, args.rawItem);
      const parsed = parseVehicleListing(raw);
      if (args.rawItem.sourceMetadata?.detailFetched) parsed.attributes.detailRefresh = { status: "complete", attemptedAt: args.observedAt };
      else if (prior?.parsed_attributes_json?.detailRefresh) parsed.attributes.detailRefresh = prior.parsed_attributes_json.detailRefresh;
      const qualification = args.profile ? qualifyProfile(args.profile, raw) : null;
      const item = {
        ...prior, id, source: "facebook_marketplace", source_item_id: id,
        url: raw.url, normalized_url: raw.normalizedUrl, category: "vehicle", status: prior?.status ?? "new",
        title_raw: raw.titleRaw, description_raw: raw.descriptionRaw ?? null,
        price_raw: raw.priceRaw, current_price: parsePrice(raw.priceRaw), location_raw: raw.locationRaw,
        image_urls: raw.imageUrls ?? [], seller_raw: raw.sellerRaw,
        first_seen_at: prior?.first_seen_at ?? args.observedAt,
        last_seen_at: args.observedAt, posted_at: raw.sourceMetadata?.postedDate,
        last_scraped_at: args.rawItem.sourceMetadata?.detailFetched ? args.observedAt : prior?.last_scraped_at,
        parsed_attributes_json: parsed.attributes
      };
      const score = scoreListing({ itemPrice: item.current_price, parsed,
        marketStats: { median_price: 20000, sample_size: 10, p25_price: 18000, p75_price: 22000 } });
      states.set(id, item);
      snapshots.push(raw);
      parsedItems.set(id, parsed);
      return { itemId: id, isNew: !prior, applied: true, item, rawItem: raw, parsed, score, qualification };
    },
    async getListingById(_db, id) {
      const item = states.get(id);
      if (!item) return null;
      const collection = listingCollectionState(item, []);
      return { item: { ...item, ...collection }, ...collection, priceHistory: [], parseEvidence: [], modifications: [] };
    },
    async markDetailRefreshIncomplete(_db, id, observedAt, error) {
      states.get(id).parsed_attributes_json.detailRefresh = {
        status: "incomplete", attemptedAt: observedAt,
        reason: error.name === "ListingDetailUnavailableError" ? "listing_rejected" : "refresh_failed"
      };
    },
    async finishSearchRun(_db, _runId, summary, _profileId, alertIds = []) {
      finishes.push({ ...summary, alertIds });
      return summary.status === "completed" ? alertIds.length : 0;
    }
  };
  return { ops, states, snapshots, parsedItems, finishes };
}
