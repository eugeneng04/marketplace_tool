import {
  finishSearchRun,
  getItemRefreshState,
  startSearchRun,
  upsertRawItemSnapshot
} from "./db.js";
import { meetsAlertRules } from "./dealAlerts.js";
import { qualifyProfile } from "./profileQualification.js";
import { detailRefreshFor, isPlaceholderTitle, mergeListingObservation } from "./listingDetails.js";

export function shouldFetchDetail(refreshState, staleDetailHours) {
  if (["rejected", "hidden", "sold"].includes(refreshState?.status)) return false;
  return detailRefreshFor(refreshState, [{ filtersJson: { staleDetailHours } }]).needsRefresh;
}

export function matchesProfileFilters(profile, raw) {
  return qualifyProfile(profile, raw).state === "match";
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
  const ops = { startSearchRun, finishSearchRun, getItemRefreshState, upsertRawItemSnapshot, ...dbOps };
  const run = await ops.startSearchRun(db, profile.id, "facebook_marketplace");
  const summary = {
    status: "completed", resultsFound: 0, matchCount: 0, unknownCount: 0,
    newItems: 0, existingItems: 0, detailPagesOpened: 0, alertsCreated: 0,
    errorMessage: null, diagnostics: null
  };
  try {
    const captured = await connector.captureListingCards(profile);
    const observedAt = new Date(captured.capturedAt).toISOString();
    summary.diagnostics = captured.sourceMetadata?.diagnostics ?? null;
    const prepared = [];
    for (const card of captured.cards) {
      const observation = connector.normalizeCardToRawSourceItem(card, captured.capturedAt);
      observation.sourceMetadata = { ...observation.sourceMetadata, detailFetched: false };
      if (!isPlaceholderTitle(observation.titleRaw) && qualifyProfile(profile, observation).state === "mismatch") continue;
      const cached = await ops.getItemRefreshState(db, {
        normalizedUrl: observation.normalizedUrl, sourceItemId: observation.sourceItemId
      });
      if (isPlaceholderTitle(observation.titleRaw) &&
          (!cached || isPlaceholderTitle(cached.title_raw) || ["rejected", "hidden", "sold"].includes(cached.status))) continue;
      const raw = mergeListingObservation(cached, observation);
      prepared.push({ card, observation, raw });
    }
    prepared.sort((left, right) => {
      const leftDate = Date.parse(left.raw.sourceMetadata?.postedDate ?? "");
      const rightDate = Date.parse(right.raw.sourceMetadata?.postedDate ?? "");
      return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0);
    });
    const qualifyingAlertItemIds = [];
    for (const { card, observation } of prepared) {
      const result = await ops.upsertRawItemSnapshot(db, {
        profile, runId: run.id, rank: card.rank, rawItem: observation, observedAt, preferManualTransmission
      });
      if (result.excluded) continue;
      summary.resultsFound += 1;
      summary[result.qualification.state === "match" ? "matchCount" : "unknownCount"] += 1;
      summary[result.isNew ? "newItems" : "existingItems"] += 1;
      if (result.applied && result.qualification.state === "match" &&
          detailRefreshFor(result.item, [profile]).state === "fresh" &&
          !["rejected", "hidden", "sold"].includes(result.item.status) &&
          meetsAlertRules({ profile, deal: result.score, item: result.item }, Date.now()).ok) {
        qualifyingAlertItemIds.push(result.itemId);
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
