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

const DEFAULT_STALE_DETAIL_HOURS = 24;
const DETAIL_FETCH_CONCURRENCY = 5;

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

export function shouldFetchDetail(refreshState, staleDetailHours) {
  if (!refreshState) {
    return true;
  }

  if (["rejected", "hidden", "sold"].includes(refreshState.status)) {
    return false;
  }

  const hasDescription = typeof refreshState.description_raw === "string" && refreshState.description_raw.trim().length > 0;
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

export async function runProfileSync({ db, connector, profile, preferManualTransmission, dbOps = {} }) {
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

    const preparedItems = await mapWithConcurrency(captured.cards, DETAIL_FETCH_CONCURRENCY, async (card) => {
      const cardRaw = connector.normalizeCardToRawSourceItem(card, captured.capturedAt);
      const refreshState = await ops.getItemRefreshState(db, {
        normalizedUrl: cardRaw.normalizedUrl,
        sourceItemId: cardRaw.sourceItemId
      });

      // The GraphQL search response is enough to capture ordinary search
      // results. Detail requests are individually rate limited and were making
      // a 25-result run take several minutes. Fetch details during the run only
      // when filters depend on fields the search response may omit. Existing
      // incomplete/stale items remain eligible for the normal refresh policy.
      const filters = profile.filtersJson ?? {};
      const detailDependentFilters = Boolean(
        filters.transmission || filters.maxMileage || filters.cleanTitleOnly || filters.modifiedOnly
      );
      const needsDetail = shouldFetchDetail(refreshState, staleDetailHours) &&
        (detailDependentFilters || Boolean(refreshState && (
          hoursSince(refreshState.last_scraped_at) >= staleDetailHours ||
          !refreshState.description_raw?.trim() || !refreshState.image_urls?.length
        )));
      const raw = needsDetail ? await connector.fetchListingDetail(card) : cardRaw;
      if (needsDetail) {
        raw.sourceMetadata = { ...(raw.sourceMetadata ?? {}), detailFetched: true };
        summary.detailPagesOpened += 1;
      }
      return { card, raw };
    });
    const matchingItems = preparedItems.filter(({ raw }) => matchesProfileFilters(profile, raw));
    summary.resultsFound = matchingItems.length;
    matchingItems.sort((left, right) => {
      const leftDate = Date.parse(left.raw.sourceMetadata?.postedDate ?? "");
      const rightDate = Date.parse(right.raw.sourceMetadata?.postedDate ?? "");
      return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
    });

    const qualifyingAlertItemIds = [];

    for (const { card, raw } of matchingItems) {
      const parsedPrice = parsePrice(raw.priceRaw);
      const upsertResult = await ops.upsertRawItemSnapshot(db, {
        profile,
        runId: run.id,
        rank: card.rank,
        rawItem: raw,
        parsedPrice
      });

      if (upsertResult.isNew) {
        summary.newItems += 1;
      } else {
        summary.existingItems += 1;
      }

      const parsed = parseVehicleListing(raw);
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
      if (alertCheck.ok) {
        qualifyingAlertItemIds.push(upsertResult.itemId);
      }
    }

    summary.alertsCreated = await ops.finishSearchRun(db, run.id, summary, profile.id, qualifyingAlertItemIds);
    return { runId: run.id, ...summary };
  } catch (error) {
    summary.status = "failed";
    summary.errorMessage = error instanceof Error ? error.message : "Unknown error";
    await ops.finishSearchRun(db, run.id, summary);
    throw error;
  }
}
