import { getListingById, markDetailRefreshIncomplete, upsertRawItemSnapshot } from "./db.js";
import { rawItemFromListing } from "./listingDetails.js";

export function createListingRefresh({ db, connector, preferManualTransmission, dbOps = {} }) {
  const ops = { getListingById, markDetailRefreshIncomplete, upsertRawItemSnapshot, ...dbOps };
  const inFlight = new Map();

  async function refresh(itemId, { force = false, fetchPhotos = false } = {}) {
    const current = await ops.getListingById(db, itemId);
    if (!current) return null;
    if (!force && !fetchPhotos && !current.detailRefresh.needsRefresh) return { listing: current, cached: true };
    const item = current.item;
    if (!item.source_item_id) {
      const error = new Error("This listing has no Marketplace source id.");
      error.status = 400;
      throw error;
    }
    const raw = rawItemFromListing(item);
    const observedAt = new Date().toISOString();
    try {
      const observation = await connector.fetchListingDetail({
        sourceItemId: raw.sourceItemId, listingUrl: raw.url, titleRaw: raw.titleRaw,
        priceRaw: raw.priceRaw, locationRaw: raw.locationRaw, thumbnailUrl: raw.imageUrls[0]
      }, { fetchPhotos });
      observation.sourceMetadata = { ...observation.sourceMetadata, detailFetched: true };
      const result = await ops.upsertRawItemSnapshot(db, { itemId, rawItem: observation, observedAt, preferManualTransmission });
      return { listing: await ops.getListingById(db, itemId), cached: !result.applied };
    } catch (error) {
      await ops.markDetailRefreshIncomplete(db, itemId, observedAt, error);
      throw error;
    }
  }

  function startEntry(itemId, options) {
    const entry = { fetchPhotos: Boolean(options?.fetchPhotos), photoPromise: null, promise: null };
    entry.promise = refresh(itemId, options).finally(() => {
      if (inFlight.get(itemId) === entry && !entry.photoPromise) inFlight.delete(itemId);
    });
    inFlight.set(itemId, entry);
    return entry;
  }

  return function refreshListing(itemId, options = {}) {
    const fetchPhotos = Boolean(options.fetchPhotos);
    const existing = inFlight.get(itemId);
    if (!existing) return startEntry(itemId, options).promise;
    // A running photo fetch covers text-only waiters; identical intents share one request.
    if (existing.fetchPhotos || !fetchPhotos) return existing.promise;
    // A text-only refresh is running but the caller explicitly requested
    // gallery photos. Preserve that intent by chaining one photo fetch after
    // the running request instead of dropping it. Compatible photo waiters
    // share the chained request.
    if (existing.photoPromise) return existing.photoPromise;
    existing.photoPromise = existing.promise.catch(() => {}).then(() =>
      refresh(itemId, { ...options, fetchPhotos: true })
    ).finally(() => {
      if (inFlight.get(itemId) === existing) inFlight.delete(itemId);
    });
    return existing.photoPromise;
  };
}
