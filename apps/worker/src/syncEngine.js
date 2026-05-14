import {
  computeMarketStats,
  finishSearchRun,
  saveParsedItem,
  startSearchRun,
  upsertDealScore,
  upsertRawItemSnapshot
} from "./db.js";
import { scoreListing } from "./dealScoring.js";
import { parsePrice } from "./utils.js";
import { parseVehicleListing } from "./vehicleParser.js";

export async function runProfileSync({ db, connector, profile, preferManualTransmission }) {
  const run = await startSearchRun(db, profile.id, "facebook_marketplace");

  const summary = {
    status: "completed",
    resultsFound: 0,
    newItems: 0,
    existingItems: 0,
    detailPagesOpened: 0,
    errorMessage: null
  };

  try {
    const captured = await connector.captureListingCards(profile);
    summary.resultsFound = captured.cards.length;

    for (const card of captured.cards) {
      const raw = await connector.fetchListingDetail(card);
      summary.detailPagesOpened += 1;

      const parsedPrice = parsePrice(raw.priceRaw);
      const upsertResult = await upsertRawItemSnapshot(db, {
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
      await saveParsedItem(db, upsertResult.itemId, parsed);

      const marketStats = await computeMarketStats(db, {
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

      await upsertDealScore(db, upsertResult.itemId, score);
    }

    await finishSearchRun(db, run.id, summary);
    return { runId: run.id, ...summary };
  } catch (error) {
    summary.status = "failed";
    summary.errorMessage = error instanceof Error ? error.message : "Unknown error";
    await finishSearchRun(db, run.id, summary);
    throw error;
  }
}
