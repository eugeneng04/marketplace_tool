import { configureFacebookCooldown, scheduleFacebookRequest } from "./facebookRequestLimiter.js";
import { readFile } from "node:fs/promises";
import { createDueSearchRunner } from "./scheduler.js";
import { createServer } from "node:http";
import { URL } from "node:url";
import { assertConfig, loadConfig } from "./config.js";
import {
  createComp,
  computeMarketStats,
  createDb,
  createProfile,
  createSearchGroup,
  createVehicleGeneration,
  deleteComp,
  deleteProfile,
  getListingById,
  getProfile,
  getSearchDefaults,
  listCompsByItem,
  listDealAlerts,
  listDueSearchGroups,
  listDeals,
  listEnabledProfiles,
  listListings,
  listProfiles,
  listSearchGroups,
  listRuns,
  markDealAlertRead,
  saveParsedItem,
  updateListingDetail,
  upsertDealScore,
  advanceSearchGroup,
  migrate,
  recoverInterruptedSearchRuns,
  updateListingStatus,
  updateProfile,
  updateProfileGroup,
  updateSearchGroupSchedule,
  updateVehicleGeneration,
  deleteVehicleGeneration,
  listVehicleGenerations,
  saveSearchDefaults
} from "./db.js";
import { compMedian, priceTrend, similarMileageComps, validateCompInput } from "./comps.js";
import { compMatchesModel, fetchBatCompsForListing, fetchCandbCompsForListing, generationFor, inferMakeModel, listingYear, matchCompsToListing, yearWindowFor } from "./auctionComps.js";
import { createFacebookConnector, createFacebookGraphqlClient, detailToRawSourceItem } from "./facebookConnector.js";
import { runProfileSync } from "./syncEngine.js";
import { scoreListing } from "./dealScoring.js";
import { parseVehicleListing } from "./vehicleParser.js";
import { parseJsonBody, toInt } from "./utils.js";
import { findGeneration } from "./vehicleGenerations.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function requireAuth(req, config) {
  if (!config.apiToken) {
    return true;
  }

  const authHeader = req.headers.authorization ?? "";
  return authHeader === `Bearer ${config.apiToken}`;
}

function parseProfileInput(body) {
  const query = `${body.query ?? body.name ?? ""}`.trim();
  if (!query || !body.location) {
    throw new Error("query and location are required.");
  }

  return {
    name: query,
    category: `${body.category ?? "vehicle"}`,
    query: `${body.query}`,
    location: `${body.location}`,
    radiusMiles: toInt(body.radiusMiles ?? body.radius_miles, 25),
    minPrice: toInt(body.minPrice ?? body.min_price, null),
    maxPrice: toInt(body.maxPrice ?? body.max_price, null),
    filtersJson: body.filtersJson && typeof body.filtersJson === "object" ? body.filtersJson : {},
    enabled: body.enabled !== false,
    groupId: body.groupId || null,
    alertMinScore: toInt(body.alertMinScore ?? body.alert_min_score, 70),
    alertMinConfidence: parseConfidenceInput(body.alertMinConfidence ?? body.alert_min_confidence, 0.5),
    alertMaxAgeHours: toInt(body.alertMaxAgeHours ?? body.alert_max_age_hours, 72)
  };
}

function parseConfidenceInput(value, fallback = 0.5) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const asFraction = parsed > 1 ? parsed / 100 : parsed;
  return Math.min(1, Math.max(0, asFraction));
}

function shouldResolveProfileLocation(body, profileInput) {
  if (body.resolveLocation === false) {
    return false;
  }

  return (
    profileInput.location &&
    profileInput.connectorMode !== "mock" &&
    profileInput.filtersJson.latitude === undefined &&
    profileInput.filtersJson.lat === undefined &&
    profileInput.filtersJson.longitude === undefined &&
    profileInput.filtersJson.lng === undefined &&
    profileInput.filtersJson.lon === undefined
  );
}

async function resolveProfileCoordinatesIfNeeded(profileInput, body, facebookGraphqlClient) {
  if (!shouldResolveProfileLocation(body, profileInput)) {
    return profileInput;
  }

  const locations = await facebookGraphqlClient.searchLocation(profileInput.location);
  const [firstLocation] = locations;
  if (!firstLocation) {
    throw new Error(`Could not resolve Marketplace location: ${profileInput.location}`);
  }

  return {
    ...profileInput,
    filtersJson: {
      ...profileInput.filtersJson,
      latitude: firstLocation.latitude,
      longitude: firstLocation.longitude,
      resolvedLocationName: firstLocation.name
    }
  };
}

function buildConnector(config) {
  return createFacebookConnector({
    mode: config.connectorMode,
    facebookCookie: config.facebookCookie,
    facebookMaxRequestsPerMinute: config.facebookMaxRequestsPerMinute,
    facebookUserAgent: config.facebookUserAgent,
    maxCardsPerRun: config.maxCardsPerRun,
    chromeProfile: config.chromeProfile
  });
}

function buildFacebookGraphqlClient(config) {
  return createFacebookGraphqlClient({
    facebookCookie: config.facebookCookie,
    facebookMaxRequestsPerMinute: config.facebookMaxRequestsPerMinute,
    facebookUserAgent: config.facebookUserAgent,
    chromeProfile: config.chromeProfile
  });
}

function parseNumber(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(`${value}`);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFacebookSearchInput(body) {
  if (!body.query) {
    throw new Error("query is required.");
  }

  const latitude = parseNumber(body.latitude ?? body.lat);
  const longitude = parseNumber(body.longitude ?? body.lng ?? body.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("latitude and longitude are required.");
  }

  return {
    query: `${body.query}`,
    latitude,
    longitude,
    radiusKm: parseNumber(body.radiusKm ?? body.radius_km, 50),
    minPrice: parseNumber(body.minPrice ?? body.min_price),
    maxPrice: parseNumber(body.maxPrice ?? body.max_price),
    category: body.category ? `${body.category}` : undefined,
    limit: toInt(body.limit, 20),
    cursor: body.cursor ? `${body.cursor}` : undefined
  };
}

export async function createApp() {
  const config = loadConfig();
  assertConfig(config);

  const db = createDb(config.databaseUrl);
  await migrate(db);
  await recoverInterruptedSearchRuns(db);
  await configureFacebookCooldown(db);

  const connector = buildConnector(config);
  const facebookGraphqlClient = buildFacebookGraphqlClient(config);

  const runDueSearches = createDueSearchRunner({
    db, listDueSearchGroups, listSearchGroups, getProfile, advanceSearchGroup,
    runProfile: (profile) => runProfileSync({ db, connector, profile, preferManualTransmission: config.preferManualTransmission })
  });

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      return sendJson(res, 400, { error: "Bad request" });
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("access-control-allow-headers", "content-type,authorization");
      res.end();
      return;
    }

    if (pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "resale-intelligence-api" });
    }

    // Static assets contain no secrets; API routes still require authentication.
    const assets = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"],
      "/app.js": ["app.js", "text/javascript"], "/styles.css": ["styles.css", "text/css"] };
    if (req.method === "GET" && Object.hasOwn(assets, pathname)) {
      try {
        const [file, type] = assets[pathname];
        const body = await readFile(new URL(`../../web/src/${file}`, import.meta.url));
        res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
        return res.end(body);
      } catch { return sendJson(res, 500, { error: "Web assets unavailable" }); }
    }

    if (pathname === "/sync/due" && req.method === "POST") {
      if (!config.schedulerToken || req.headers.authorization !== `Bearer ${config.schedulerToken}`) {
        return sendJson(res, 401, { error: "Unauthorized" });
      }
      try {
        const result = await runDueSearches();
        return sendJson(res, result.errors.length ? 502 : 200, result);
      } catch (error) {
        console.error("scheduled search failed:", error);
        return sendJson(res, 500, { error: "Scheduled search failed; see server logs" });
      }
    }

    if (!requireAuth(req, config)) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    try {
      if (pathname === "/vehicle-generations" && req.method === "GET") {
        return sendJson(res, 200, { generations: await listVehicleGenerations(db) });
      }
      if (pathname === "/vehicle-generations" && req.method === "POST") {
        const body = parseJsonBody(await readBody(req));
        try { return sendJson(res, 201, { generation: await createVehicleGeneration(db, body) }); }
        catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      if (pathname.startsWith("/vehicle-generations/") && req.method === "PUT") {
        const id = decodeURIComponent(pathname.slice("/vehicle-generations/".length));
        const body = parseJsonBody(await readBody(req));
        try {
          const generation = await updateVehicleGeneration(db, id, body);
          if (!generation) return sendJson(res, 404, { error: "Vehicle generation not found." });
          return sendJson(res, 200, { generation });
        } catch (error) { return sendJson(res, 400, { error: error.message }); }
      }
      if (pathname.startsWith("/vehicle-generations/") && req.method === "DELETE") {
        const id = decodeURIComponent(pathname.slice("/vehicle-generations/".length));
        const deleted = await deleteVehicleGeneration(db, id);
        if (!deleted) return sendJson(res, 404, { error: "Vehicle generation not found." });
        return sendJson(res, 200, { deleted: true });
      }
      if (pathname === "/facebook/status" && req.method === "GET") {
        return sendJson(res, 200, await scheduleFacebookRequest.status());
      }

      if (pathname === "/search-defaults" && req.method === "GET") {
        return sendJson(res, 200, { defaults: await getSearchDefaults(db) });
      }
      if (pathname === "/search-defaults" && ["PUT", "POST"].includes(req.method)) {
        const body = parseJsonBody(await readBody(req));
        return sendJson(res, 200, { defaults: await saveSearchDefaults(db, body) });
      }
      if (pathname === "/search-groups" && req.method === "GET") {
        return sendJson(res, 200, { groups: await listSearchGroups(db) });
      }
      if (pathname === "/search-groups" && req.method === "POST") {
        const body = parseJsonBody(await readBody(req));
        if (!body.name?.trim()) return sendJson(res, 400, { error: "Group name is required." });
        return sendJson(res, 201, { group: await createSearchGroup(db, body) });
      }
      if (pathname.startsWith("/search-groups/") && req.method === "PATCH") {
        const groupId = pathname.slice("/search-groups/".length);
        const body = parseJsonBody(await readBody(req));
        const group = await updateSearchGroupSchedule(db, groupId, body.intervalMinutes);
        if (!group) return sendJson(res, 404, { error: "Search group not found." });
        return sendJson(res, 200, { group });
      }
      if (pathname.startsWith("/search-groups/") && pathname.endsWith("/run") && req.method === "POST") {
        const groupId = pathname.slice("/search-groups/".length, -"/run".length);
        const group = (await listSearchGroups(db)).find((entry) => entry.id === groupId);
        if (!group) return sendJson(res, 404, { error: "Search group not found." });
        const runs = [];
        for (const profile of group.profiles.filter((entry) => entry.enabled)) {
          const fullProfile = await getProfile(db, profile.id);
          runs.push({ profileId: profile.id, ...(await runProfileSync({ db, connector, profile: fullProfile, preferManualTransmission: config.preferManualTransmission })) });
        }
        return sendJson(res, 200, { count: runs.length, runs });
      }
      if (pathname === "/facebook/search" && req.method === "POST") {
        const body = parseJsonBody(await readBody(req));
        const result = await facebookGraphqlClient.searchListings(parseFacebookSearchInput(body));
        return sendJson(res, 200, result);
      }

      if (pathname === "/facebook/locations" && req.method === "GET") {
        const query = parsedUrl.searchParams.get("query");
        if (!query) {
          return sendJson(res, 400, { error: "query is required." });
        }

        const locations = await facebookGraphqlClient.searchLocation(query);
        return sendJson(res, 200, { locations });
      }

      if (pathname.startsWith("/facebook/listings/") && req.method === "GET") {
        const listingId = pathname.replace("/facebook/listings/", "");
        if (!listingId) {
          return sendJson(res, 400, { error: "listing id is required." });
        }

        const listing = await facebookGraphqlClient.getListingDetail(listingId);
        return sendJson(res, 200, listing);
      }

      if (pathname === "/profiles" && req.method === "GET") {
        const profiles = await listProfiles(db);
        return sendJson(res, 200, { profiles });
      }

      if (pathname === "/profiles" && req.method === "POST") {
        const body = parseJsonBody(await readBody(req));
        const profileInput = await resolveProfileCoordinatesIfNeeded(
          { ...parseProfileInput(body), connectorMode: config.connectorMode },
          body,
          facebookGraphqlClient
        );
        const created = await createProfile(db, profileInput);
        return sendJson(res, 201, { profile: created });
      }

      if (pathname.startsWith("/profiles/") && ["GET", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        const profileId = pathname.replace("/profiles/", "");

        if (req.method === "GET") {
          const profile = await getProfile(db, profileId);
          if (!profile) {
            return sendJson(res, 404, { error: "Profile not found" });
          }
          return sendJson(res, 200, { profile });
        }

        if (req.method === "DELETE") {
          const deleted = await deleteProfile(db, profileId);
          if (!deleted) {
            return sendJson(res, 404, { error: "Profile not found" });
          }
          return sendJson(res, 200, { deleted: true, profileId });
        }

        const body = parseJsonBody(await readBody(req));
        const existingProfile = await getProfile(db, profileId);
        if (!existingProfile) {
          return sendJson(res, 404, { error: "Profile not found" });
        }

        const submittedFilters = body.filtersJson && typeof body.filtersJson === "object"
          ? { ...(existingProfile.filtersJson ?? {}), ...body.filtersJson }
          : existingProfile.filtersJson ?? {};
        if (body.location && body.location !== existingProfile.location && body.filtersJson?.latitude === undefined) {
          for (const key of ["latitude", "longitude", "lat", "lng", "lon", "resolvedLocationName"]) delete submittedFilters[key];
        }
        const parsedInput = parseProfileInput({
          ...existingProfile,
          ...body,
          radiusMiles: body.radiusMiles ?? body.radius_miles ?? existingProfile.radiusMiles,
          minPrice: body.minPrice ?? body.min_price ?? existingProfile.minPrice,
          maxPrice: body.maxPrice ?? body.max_price ?? existingProfile.maxPrice,
          alertMinScore:
            body.alertMinScore ?? body.alert_min_score ?? existingProfile.alertMinScore,
          alertMinConfidence:
            body.alertMinConfidence ?? body.alert_min_confidence ?? existingProfile.alertMinConfidence,
          alertMaxAgeHours:
            body.alertMaxAgeHours ?? body.alert_max_age_hours ?? existingProfile.alertMaxAgeHours,
          filtersJson: submittedFilters
        });
        const profileInput = await resolveProfileCoordinatesIfNeeded(
          { ...parsedInput, connectorMode: config.connectorMode },
          body,
          facebookGraphqlClient
        );
        const updated = await updateProfile(db, profileId, profileInput);
        if (body.groupId !== undefined && body.groupId !== existingProfile.groupId) await updateProfileGroup(db, profileId, body.groupId);
        if (!updated) {
          return sendJson(res, 404, { error: "Profile not found" });
        }
        return sendJson(res, 200, { profile: updated });
      }

      if (pathname.startsWith("/profiles/") && pathname.endsWith("/run") && req.method === "POST") {
        const profileId = pathname.replace("/profiles/", "").replace("/run", "");
        const profile = await getProfile(db, profileId);
        if (!profile) {
          return sendJson(res, 404, { error: "Profile not found" });
        }

        const summary = await runProfileSync({
          db,
          connector,
          profile,
          preferManualTransmission: config.preferManualTransmission
        });

        return sendJson(res, 200, { run: summary });
      }

      if (pathname === "/sync/all" && req.method === "POST") {
        const enabledProfiles = await listEnabledProfiles(db);
        const runs = [];
        for (const profile of enabledProfiles) {
          // Sequential by design for MVP safety.
          // Scale this with queue workers later.
          const run = await runProfileSync({
            db,
            connector,
            profile,
            preferManualTransmission: config.preferManualTransmission
          });
          runs.push({ profileId: profile.id, ...run });
        }

        return sendJson(res, 200, { count: runs.length, runs });
      }

      if (pathname === "/runs" && req.method === "GET") {
        const profileId = parsedUrl.searchParams.get("profileId");
        const limit = toInt(parsedUrl.searchParams.get("limit"), 50);
        const runs = await listRuns(db, profileId, limit);
        return sendJson(res, 200, { runs });
      }

      if (pathname === "/listings" && req.method === "GET") {
        const filters = {
          status: parsedUrl.searchParams.get("status") ?? undefined,
          make: parsedUrl.searchParams.get("make") ?? undefined,
          model: parsedUrl.searchParams.get("model") ?? undefined,
          transmission: parsedUrl.searchParams.get("transmission") ?? undefined,
          minPrice: toInt(parsedUrl.searchParams.get("minPrice"), null),
          maxPrice: toInt(parsedUrl.searchParams.get("maxPrice"), null),
          q: parsedUrl.searchParams.get("q") ?? undefined,
          sort: parsedUrl.searchParams.get("sort") ?? undefined,
          yearMin: toInt(parsedUrl.searchParams.get("yearMin"), null),
          yearMax: toInt(parsedUrl.searchParams.get("yearMax"), null),
          limit: toInt(parsedUrl.searchParams.get("limit"), 50),
          offset: toInt(parsedUrl.searchParams.get("offset"), 0)
        };

        const listings = await listListings(db, filters);
        const generations = await listVehicleGenerations(db);
        const enriched = listings.map((listing) => {
          const vehicle = { ...inferMakeModel(listing), year: listing.item?.parsed_attributes_json?.year ?? listing.parsed_attributes_json?.year };
          return { ...listing, generation: findGeneration(generations, vehicle) };
        });
        return sendJson(res, 200, { listings: enriched });
      }

      if (pathname.startsWith("/listings/") && pathname.endsWith("/refresh") && req.method === "POST") {
        const itemId = pathname.slice("/listings/".length, -"/refresh".length);
        const current = await getListingById(db, itemId);
        if (!current) return sendJson(res, 404, { error: "Listing not found" });
        if (!current.item.source_item_id) return sendJson(res, 400, { error: "This listing has no Marketplace source id." });
        const detail = await facebookGraphqlClient.getListingDetail(current.item.source_item_id);
        const rawItem = detailToRawSourceItem(detail, {
          sourceItemId: current.item.source_item_id,
          listingUrl: current.item.url,
          titleRaw: current.item.title_raw,
          priceRaw: current.item.price_raw,
          locationRaw: current.item.location_raw,
          rawCardText: current.item.description_raw
        });
        await updateListingDetail(db, itemId, rawItem);
        const parsed = parseVehicleListing(rawItem);
        await saveParsedItem(db, itemId, parsed);
        const marketStats = await computeMarketStats(db, {
          category: current.item.category,
          excludeItemId: itemId,
          make: parsed.attributes.make ?? null,
          model: parsed.attributes.model ?? null,
          locationRegion: rawItem.locationRaw ?? current.item.location_region
        });
        await upsertDealScore(db, itemId, scoreListing({ itemPrice: current.item.current_price, parsed, marketStats, preferManualTransmission: config.preferManualTransmission }));
        return sendJson(res, 200, { listing: await getListingById(db, itemId) });
      }

      if (pathname === "/deals" && req.method === "GET") {
        const limit = toInt(parsedUrl.searchParams.get("limit"), 30);
        const deals = await listDeals(db, limit);
        const generations = await listVehicleGenerations(db);
        const enriched = deals.map((deal) => ({ ...deal, generation: findGeneration(generations, { ...inferMakeModel(deal), year: deal.parsed_attributes_json?.year }) }));
        return sendJson(res, 200, { deals: enriched });
      }

      if (pathname === "/alerts" && req.method === "GET") {
        const unreadOnlyParam = parsedUrl.searchParams.get("unreadOnly") ?? parsedUrl.searchParams.get("unread");
        const alerts = await listDealAlerts(db, {
          limit: toInt(parsedUrl.searchParams.get("limit"), 30),
          unreadOnly: unreadOnlyParam === "true" || unreadOnlyParam === "1",
          profileId: parsedUrl.searchParams.get("profileId") ?? undefined
        });
        return sendJson(res, 200, { alerts });
      }

      if (pathname.startsWith("/alerts/") && pathname.endsWith("/read") && ["PATCH", "POST"].includes(req.method)) {
        const alertId = pathname.replace("/alerts/", "").replace("/read", "");
        if (!alertId) {
          return sendJson(res, 400, { error: "alert id is required." });
        }
        const updated = await markDealAlertRead(db, alertId);
        if (!updated) {
          return sendJson(res, 404, { error: "Alert not found" });
        }
        return sendJson(res, 200, { alertId, read: true });
      }

      if (pathname.startsWith("/listings/") && pathname.endsWith("/comps/fetch") && req.method === "POST") {
        const itemId = pathname.replace("/listings/", "").replace("/comps/fetch", "");
        const listing = await getListingById(db, itemId);
        if (!listing) {
          return sendJson(res, 404, { error: "Listing not found" });
        }
        // Best-effort auction scraping: one polite request per source to public pages.
        // Repeat fetches are deduplicated by UNIQUE (item_id, url). 911 comps are
        // narrowed to the listing's generation (996/997/991/992) before saving.
        const [bat, candb] = await Promise.all([
          fetchBatCompsForListing(listing.item, { limit: 40 }),
          fetchCandbCompsForListing(listing.item, { limit: 40 })
        ]);
        // Search APIs are loose (wrong-model and parts rows slip in), so enforce
        // the model token first, then narrow 911s to the listing's generation.
        const { model: listingModel } = inferMakeModel(listing.item);
        const modelFiltered = [...bat.comps, ...candb.comps].filter((comp) => compMatchesModel(comp, listingModel));
        const { generation, yearWindow, matched, skippedOutOfWindow } = matchCompsToListing(listing.item, modelFiltered);
        const diagnostics = {
          bat: bat.diagnostics,
          carsAndBids: candb.diagnostics,
          generation,
          yearWindow,
          skippedOutOfWindow: skippedOutOfWindow.length + (bat.comps.length + candb.comps.length - modelFiltered.length)
        };
        let inserted = 0;
        for (const comp of matched) {
          const row = await createComp(db, itemId, {
            source: comp.source,
            url: comp.url,
            title: comp.title,
            soldPrice: comp.soldPrice,
            soldAt: comp.soldAt,
            mileage: comp.mileage ?? null,
            transmission: comp.transmission ?? "unknown",
            note: null
          });
          if (row) {
            inserted += 1;
          }
        }
        const all = await listCompsByItem(db, itemId);
        return sendJson(res, 200, { fetched: matched.length, inserted, comps: all, medianSoldPrice: compMedian(all), diagnostics });
      }

      if (pathname.startsWith("/listings/") && pathname.endsWith("/comps") && req.method === "GET") {
        const itemId = pathname.replace("/listings/", "").replace("/comps", "");
        const listing = await getListingById(db, itemId);
        if (!listing) {
          return sendJson(res, 404, { error: "Listing not found" });
        }
        const comps = await listCompsByItem(db, itemId);
        const attrs = listing.item.parsed_attributes_json ?? {};
        const trend = priceTrend(comps, {
          mileage: attrs.mileage ?? null,
          price: listing.item.current_price ?? null
        });
        const mileageMatches = similarMileageComps(comps, attrs.mileage);
        const catalogGeneration = findGeneration(await listVehicleGenerations(db), { ...inferMakeModel(listing.item), year: listingYear(listing.item) });
        const generation = catalogGeneration
          ? { name: catalogGeneration.code, from: catalogGeneration.yearFrom, to: catalogGeneration.yearTo }
          : generationFor(listing.item);
        const yearWindow = generation
          ? { from: generation.from, to: generation.to }
          : yearWindowFor(listing.item);
        return sendJson(res, 200, {
          comps,
          medianSoldPrice: compMedian(comps),
          similarMileageComps: mileageMatches.comps,
          similarMileageMedian: compMedian(mileageMatches.comps),
          mileageWindow: mileageMatches.window,
          generation,
          yearWindow,
          trend
        });
      }

      if (pathname.startsWith("/listings/") && pathname.endsWith("/comps") && req.method === "POST") {
        const itemId = pathname.replace("/listings/", "").replace("/comps", "");
        const listing = await getListingById(db, itemId);
        if (!listing) {
          return sendJson(res, 404, { error: "Listing not found" });
        }
        const body = parseJsonBody(await readBody(req));
        let comp;
        try {
          comp = validateCompInput(body);
        } catch (error) {
          return sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid comp" });
        }
        const created = await createComp(db, itemId, comp);
        return sendJson(res, 201, { comp: created });
      }

      if (pathname.startsWith("/comps/") && req.method === "DELETE") {
        const compId = pathname.replace("/comps/", "");
        const deleted = await deleteComp(db, compId);
        if (!deleted) {
          return sendJson(res, 404, { error: "Comp not found" });
        }
        return sendJson(res, 200, { deleted: true, compId });
      }

      if (pathname.startsWith("/listings/") && req.method === "GET") {
        const itemId = pathname.replace("/listings/", "");
        const listing = await getListingById(db, itemId);
        if (!listing) {
          return sendJson(res, 404, { error: "Listing not found" });
        }
        const generations = await listVehicleGenerations(db);
        const vehicle = { ...inferMakeModel(listing.item), year: listing.item?.parsed_attributes_json?.year };
        return sendJson(res, 200, { ...listing, generation: findGeneration(generations, vehicle) });
      }

      if (pathname.startsWith("/listings/") && pathname.endsWith("/status") && req.method === "PATCH") {
        const itemId = pathname.replace("/listings/", "").replace("/status", "");
        const body = parseJsonBody(await readBody(req));
        if (!body.status) {
          return sendJson(res, 400, { error: "status is required." });
        }

        const listing = await updateListingStatus(db, itemId, `${body.status}`);
        if (!listing) {
          return sendJson(res, 404, { error: "Listing not found" });
        }

        return sendJson(res, 200, { listing });
      }

      return sendJson(res, 404, { error: "Route not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      if (error?.code === "FACEBOOK_COOLDOWN") {
        res.setHeader("Retry-After", Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000)));
        return sendJson(res, 429, { error: message, retryAt: new Date(error.retryAt).toISOString() });
      }
      return sendJson(res, 500, { error: message });
    }
  });

  const scheduleTick = config.schedulerEnabled ? setInterval(() => {
    runDueSearches().then((result) => {
      if (result.errors.length) console.error("search group scheduler errors:", result.errors);
    }).catch((error) => console.error("search group scheduler error:", error));
  }, 30_000) : null;
  scheduleTick?.unref();

  return {
    config,
    db,
    server,
    close: async () => {
      clearInterval(scheduleTick);
      server.close();
      await db.close();
    }
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  app.server.listen(app.config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`resale-intelligence-api listening on :${app.config.port}`);
  });
}
