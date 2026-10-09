import {
  computeMarketStats,
  finishSearchRun,
  getItemRefreshState,
  saveParsedItem,
  startSearchRun,
  upsertDealScore,
  upsertRawItemSnapshot
} from "./db.js";
import { meetsAlertRules } from "./dealAlerts.js";
import { scoreListing } from "./dealScoring.js";
import { parsePrice } from "./utils.js";
import { parseVehicleListing } from "./vehicleParser.js";
import { ListingDetailUnavailableError } from "./facebookGraphqlClient.js";

const DEFAULT_STALE_DETAIL_HOURS = 24;
// Process the detail queue in order; the shared Facebook limiter spaces
// requests and stops them during its persistent cooldown.
const DETAIL_FETCH_CONCURRENCY = 1;

function cardNeedsDetail(card) {
  return !card.titleRaw || /^Marketplace listing(?:\s|$)/i.test(card.titleRaw.trim());
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
  return results;
}

function hoursSince(value) {
  if (!value) {
    return Infinity;
  }

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return Infinity;
  }

  return (Date.now() - timestamp) / 3_600_000;
}

export function shouldFetchDetail(refreshState, staleDetailHours, { descriptionIsCardSummary = false } = {}) {
  if (!refreshState) {
    return true;
  }

  if (["rejected", "hidden", "sold"].includes(refreshState.status)) {
    return false;
  }

  if (refreshState.parsed_attributes_json?.detailRefresh?.status === "incomplete") return true;

  const hasDescription = typeof refreshState.description_raw === "string" && refreshState.description_raw.trim().length > 0 && !descriptionIsCardSummary;
  const hasImages = Array.isArray(refreshState.image_urls) && refreshState.image_urls.length > 0;
  const priceFromText = parsePrice(refreshState.price_raw);
  const priceMismatch = priceFromText !== null && refreshState.current_price !== null && priceFromText !== refreshState.current_price;
  if (!hasDescription || !hasImages || priceMismatch) {
    return true;
  }

  const refreshInterval = ["saved", "contacted"].includes(refreshState.status)
    ? Math.min(staleDetailHours, 12)
    : staleDetailHours;
  return hoursSince(refreshState.last_scraped_at) >= refreshInterval;
}

export function matchesProfileFilters(profile, raw) {
  const filters = profile.filtersJson ?? {};
  const parsed = parseVehicleListing(raw);
  const attrs = parsed.attributes ?? {};
  const year = Number(attrs.year);
  const generation = filters.generation;
  if (generation) {
    const title = `${raw.titleRaw ?? ""}`.toLowerCase();
    const make = `${generation.make ?? ""}`.toLowerCase();
    const model = `${generation.model ?? ""}`.toLowerCase();
    const modelMatches = model === "3 series"
      ? /\b(?:3\s*series|3\d{2}[a-z]{0,3})\b/.test(title)
      : title.includes(model);
    if (!make || !model || !title.includes(make) || !modelMatches || !Number.isFinite(year) ||
      year < Number(generation.yearFrom) || year > Number(generation.yearTo)) return false;
  }
  const mileage = Number(attrs.mileage);
  if (filters.transmission && attrs.transmission !== filters.transmission) return false;
  if (filters.yearMin && (!Number.isFinite(year) || year < Number(filters.yearMin))) return false;
  if (filters.yearMax && (!Number.isFinite(year) || year > Number(filters.yearMax))) return false;
  if (filters.maxMileage && (!Number.isFinite(mileage) || mileage > Number(filters.maxMileage))) return false;
  if (filters.cleanTitleOnly && attrs.titleStatus !== "clean title") return false;
  if (filters.modifiedOnly && (parsed.modifications?.length ?? 0) === 0) return false;
  return true;
}

export async function runProfileSync(args) {
  // The same database lock covers scheduled, manual and CLI collection runs,
  // including workers in separate processes. Use a dedicated session.
  if (!args.db.pool?.connect) return runProfileSyncUnlocked(args);
  const client = await args.db.pool.connect();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(72819463) AS locked");
    if (!result.rows[0].locked) {
      const error = new Error("A collection run is already active. Wait for it to finish before starting another.");
      error.code = "COLLECTION_BUSY";
      throw error;
    }
    return await runProfileSyncUnlocked(args);
  } finally {
    // Destroying the connection releases the lock even after an error.
    client.release(true);
  }
}

async function runProfileSyncUnlocked({ db, connector, profile, preferManualTransmission, dbOps = {} }) {
  const ops = {
    startSearchRun,
    finishSearchRun,
    getItemRefreshState,
    saveParsedItem,
    upsertRawItemSnapshot,
    computeMarketStats,
    upsertDealScore,
    ...dbOps
  };
  const run = await ops.startSearchRun(db, profile.id, "facebook_marketplace");
  const configuredStaleHours = Number.parseInt(
    `${profile.filtersJson?.staleDetailHours ?? DEFAULT_STALE_DETAIL_HOURS}`,
    10
  );
  const staleDetailHours = Number.isFinite(configuredStaleHours) ? configuredStaleHours : DEFAULT_STALE_DETAIL_HOURS;

  const summary = {
    status: "completed",
    resultsFound: 0,
    newItems: 0,
    existingItems: 0,
    detailPagesOpened: 0,
    alertsCreated: 0,
    errorMessage: null,
    diagnostics: null
  };

  try {
    const captured = await connector.captureListingCards(profile);
    summary.diagnostics = captured.sourceMetadata?.diagnostics ?? null;
    let interruption = null;
    const detailFailures = [];

    const preparedItems = await mapWithConcurrency(captured.cards, DETAIL_FETCH_CONCURRENCY, async (card) => {
      const cardRaw = connector.normalizeCardToRawSourceItem(card, captured.capturedAt);
      const needsCardEnrichment = cardNeedsDetail(card);
      // Apply title/year filters before spending a rate-limited GraphQL request
      // on the full listing. These fields are already present on search cards.
      const cardFilters = {
        ...profile,
        filtersJson: {
          ...(profile.filtersJson ?? {}),
          transmission: undefined,
          maxMileage: undefined,
          cleanTitleOnly: false,
          modifiedOnly: false
        }
      };
      if (!needsCardEnrichment && !matchesProfileFilters(cardFilters, cardRaw)) return { card, raw: cardRaw, skipped: true };

      const refreshState = await ops.getItemRefreshState(db, {
        normalizedUrl: cardRaw.normalizedUrl,
        sourceItemId: cardRaw.sourceItemId
      });
      const hasCachedListing = needsCardEnrichment && refreshState &&
        typeof refreshState.title_raw === "string" && refreshState.title_raw.trim() &&
        !/^Marketplace listing(?:\s|$)/i.test(refreshState.title_raw.trim());
      if (needsCardEnrichment && refreshState && ["rejected", "hidden", "sold"].includes(refreshState.status)) {
        return { card, raw: cardRaw, skipped: true };
      }

      // Every eligible new/incomplete card enters the paced detail queue.
      // Cached details remain available for filtering and parsing repeat runs.
      const descriptionIsCardSummary = Boolean(
        refreshState?.description_raw?.trim() && card.rawCardText?.trim() &&
        refreshState.description_raw.trim() === card.rawCardText.trim()
      );
      const needsDetail = shouldFetchDetail(refreshState, staleDetailHours, { descriptionIsCardSummary });
      const cachedAttributes = refreshState?.parsed_attributes_json ?? {};
      let raw = refreshState
          ? {
              ...cardRaw,
              titleRaw: hasCachedListing ? refreshState.title_raw : cardRaw.titleRaw,
              descriptionRaw: descriptionIsCardSummary ? cardRaw.descriptionRaw : refreshState.description_raw ?? cardRaw.descriptionRaw,
              priceRaw: cardRaw.priceRaw || refreshState.price_raw,
              locationRaw: cardRaw.locationRaw || refreshState.location_raw,
              imageUrls: cardRaw.imageUrls?.length ? cardRaw.imageUrls : refreshState.image_urls ?? [],
              sellerRaw: cardRaw.sellerRaw || refreshState.seller_raw,
              mileage: cardRaw.mileage ?? cachedAttributes.mileage,
              vehicleAttributes: { ...(cachedAttributes.marketplaceAttributes ?? {}), ...(cardRaw.vehicleAttributes ?? {}) },
              sourceMetadata: {
                ...(cachedAttributes.marketplaceMetadata ?? {}),
                ...(cardRaw.sourceMetadata ?? {}),
                postedDate: cardRaw.sourceMetadata?.postedDate || refreshState.posted_at,
                cachedDetail: true
              }
            }
          : cardRaw;
      raw.sourceMetadata = { ...(raw.sourceMetadata ?? {}), detailFetched: false };
      let detailRefresh = cachedAttributes.detailRefresh;
      if (needsDetail && !interruption) {
        const attemptedAt = new Date().toISOString();
        try {
          raw = await connector.fetchListingDetail(card);
          raw.sourceMetadata = { ...(raw.sourceMetadata ?? {}), detailFetched: true };
          detailRefresh = { status: "complete", attemptedAt, runId: run.id };
          summary.detailPagesOpened += 1;
        } catch (error) {
          const isolated = error instanceof ListingDetailUnavailableError;
          detailRefresh = {
            status: "incomplete", reason: isolated ? "listing_rejected" : "collection_interrupted",
            attemptedAt, runId: run.id
          };
          if (isolated) detailFailures.push(error.sourceItemId);
          else interruption = error;
        }
      } else if (needsDetail) {
        detailRefresh = { status: "incomplete", reason: "collection_interrupted", runId: run.id };
      }
      return { card, raw, detailRefresh };
    });
    const matchingItems = preparedItems.filter(({ raw, skipped }) => !skipped && matchesProfileFilters(profile, raw));
    summary.resultsFound = matchingItems.length;
    matchingItems.sort((left, right) => {
      const leftDate = Date.parse(left.raw.sourceMetadata?.postedDate ?? "");
      const rightDate = Date.parse(right.raw.sourceMetadata?.postedDate ?? "");
      return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
    });

    const qualifyingAlertItemIds = [];

    for (const { card, raw, detailRefresh } of matchingItems) {
      const parsedPrice = parsePrice(raw.priceRaw);
      const upsertResult = await ops.upsertRawItemSnapshot(db, {
        profile,
        runId: run.id,
        rank: card.rank,
        rawItem: raw,
        parsedPrice,
        detailRefresh
      });

      if (upsertResult.isNew) {
        summary.newItems += 1;
      } else {
        summary.existingItems += 1;
      }

      const parsed = parseVehicleListing(raw);
      if (detailRefresh) parsed.attributes.detailRefresh = detailRefresh;
      await ops.saveParsedItem(db, upsertResult.itemId, parsed);

      const marketStats = await ops.computeMarketStats(db, {
        category: profile.category,
        excludeItemId: upsertResult.itemId,
        make: parsed.attributes.make ?? null,
        model: parsed.attributes.model ?? null,
        locationRegion: raw.locationRaw ?? profile.location
      });

      const score = scoreListing({
        itemPrice: parsedPrice,
        parsed,
        marketStats,
        preferManualTransmission
      });

      await ops.upsertDealScore(db, upsertResult.itemId, score);

      const alertCheck = meetsAlertRules(
        {
          profile,
          deal: score,
          item: {
            posted_at: raw.sourceMetadata?.postedDate ?? null,
            first_seen_at: new Date().toISOString()
          }
        },
        Date.now()
      );

      // Deduplicated by UNIQUE (profile_id, item_id): repeat runs do not
      // create duplicate in-app alerts for the same profile/listing pair.
      // meetsAlertRules already enforces min score, min confidence, and max age,
      // so low-confidence listings never produce alerts.
      if (alertCheck.ok && detailRefresh?.status !== "incomplete") {
        qualifyingAlertItemIds.push(upsertResult.itemId);
      }
    }

    if (detailFailures.length) {
      const listingIds = detailFailures.slice(0, 10).join(", ");
      const remainder = detailFailures.length > 10 ? `, and ${detailFailures.length - 10} more` : "";
      const message = `Listing details incomplete. ${summary.detailPagesOpened} succeeded; ${detailFailures.length} rejected listings: ${listingIds}${remainder}.`;
      if (interruption) interruption.message = `${interruption.message} ${message}`;
      else interruption = new Error(message);
    }
    if (interruption) throw interruption;
    summary.alertsCreated = await ops.finishSearchRun(db, run.id, summary, profile.id, qualifyingAlertItemIds);
    return { runId: run.id, ...summary };
  } catch (error) {
    summary.status = "failed";
    summary.errorMessage = error instanceof Error ? error.message : "Unknown error";
    await ops.finishSearchRun(db, run.id, summary);
    throw error;
  }
}
