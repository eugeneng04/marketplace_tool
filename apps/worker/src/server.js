import { createServer } from "node:http";
import { URL } from "node:url";
import { assertConfig, loadConfig } from "./config.js";
import {
  createDb,
  createProfile,
  getListingById,
  getProfile,
  listEnabledProfiles,
  listListings,
  listProfiles,
  listRuns,
  migrate
} from "./db.js";
import { createFacebookConnector } from "./facebookConnector.js";
import { runProfileSync } from "./syncEngine.js";
import { parseJsonBody, toInt } from "./utils.js";

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
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
  if (!body.name || !body.query || !body.location) {
    throw new Error("name, query, and location are required.");
  }

  return {
    name: `${body.name}`,
    category: `${body.category ?? "vehicle"}`,
    query: `${body.query}`,
    location: `${body.location}`,
    radiusMiles: toInt(body.radiusMiles, 25),
    minPrice: toInt(body.minPrice, null),
    maxPrice: toInt(body.maxPrice, null),
    filtersJson: body.filtersJson && typeof body.filtersJson === "object" ? body.filtersJson : {},
    enabled: body.enabled !== false
  };
}

export async function createApp() {
  const config = loadConfig();
  assertConfig(config);

  const db = createDb(config.databaseUrl);
  await migrate(db);

  const connector = createFacebookConnector({ mode: config.connectorMode });

  const server = createServer(async (req, res) => {
    if (!req.url || !req.method) {
      return sendJson(res, 400, { error: "Bad request" });
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = parsedUrl.pathname;

    if (pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "resale-intelligence-api" });
    }

    if (!requireAuth(req, config)) {
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    try {
      if (pathname === "/profiles" && req.method === "GET") {
        const profiles = await listProfiles(db);
        return sendJson(res, 200, { profiles });
      }

      if (pathname === "/profiles" && req.method === "POST") {
        const body = parseJsonBody(await readBody(req));
        const created = await createProfile(db, parseProfileInput(body));
        return sendJson(res, 201, { profile: created });
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
          limit: toInt(parsedUrl.searchParams.get("limit"), 50),
          offset: toInt(parsedUrl.searchParams.get("offset"), 0)
        };

        const listings = await listListings(db, filters);
        return sendJson(res, 200, { listings });
      }

      if (pathname.startsWith("/listings/") && req.method === "GET") {
        const itemId = pathname.replace("/listings/", "");
        const listing = await getListingById(db, itemId);
        if (!listing) {
          return sendJson(res, 404, { error: "Listing not found" });
        }

        return sendJson(res, 200, listing);
      }

      return sendJson(res, 404, { error: "Route not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return sendJson(res, 500, { error: message });
    }
  });

  return {
    config,
    db,
    server,
    close: async () => {
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
