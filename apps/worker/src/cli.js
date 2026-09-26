import { assertConfig, loadConfig } from "./config.js";
import { createDb, createProfile, getProfile, listEnabledProfiles, migrate } from "./db.js";
import { createFacebookConnector, createFacebookGraphqlClient } from "./facebookConnector.js";
import { runProfileSync } from "./syncEngine.js";

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : "true";
    result[key] = value;
  }

  return result;
}

function printUsage() {
  // eslint-disable-next-line no-console
  console.log(`Usage:
  node src/cli.js migrate
  node src/cli.js seed-demo
  node src/cli.js sync-all
  node src/cli.js run-profile --profileId <id>
  node src/cli.js facebook-locations --query "San Francisco"
  node src/cli.js facebook-search --query "civic si" --latitude 37.7749 --longitude -122.4194 [--radiusKm 80] [--minPrice 4000] [--maxPrice 20000] [--limit 20]
  node src/cli.js facebook-detail --listingId <facebookListingId>`);
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

function parseNumberArg(args, key, fallback = undefined) {
  if (args[key] === undefined || args[key] === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(`${args[key]}`);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requireNumberArg(args, key) {
  const value = parseNumberArg(args, key);
  if (!Number.isFinite(value)) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

async function withDb(task) {
  const config = loadConfig();
  assertConfig(config);
  const db = createDb(config.databaseUrl);
  try {
    await task({ db, config });
  } finally {
    await db.close();
  }
}

async function run() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  if (!command || command === "--help" || args.help) {
    printUsage();
    return;
  }

  if (command === "facebook-search") {
    if (!args.query) {
      throw new Error("Missing --query");
    }

    const config = loadConfig();
    const client = buildFacebookGraphqlClient(config);
    const result = await client.searchListings({
      query: args.query,
      latitude: requireNumberArg(args, "latitude"),
      longitude: requireNumberArg(args, "longitude"),
      radiusKm: parseNumberArg(args, "radiusKm", 50),
      minPrice: parseNumberArg(args, "minPrice"),
      maxPrice: parseNumberArg(args, "maxPrice"),
      category: args.category,
      limit: Number.parseInt(args.limit ?? "20", 10)
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "facebook-locations") {
    if (!args.query) {
      throw new Error("Missing --query");
    }

    const config = loadConfig();
    const client = buildFacebookGraphqlClient(config);
    const locations = await client.searchLocation(args.query);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ locations }, null, 2));
    return;
  }

  if (command === "facebook-detail") {
    if (!args.listingId) {
      throw new Error("Missing --listingId");
    }

    const config = loadConfig();
    const client = buildFacebookGraphqlClient(config);
    const listing = await client.getListingDetail(args.listingId);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(listing, null, 2));
    return;
  }

  if (command === "migrate") {
    await withDb(async ({ db }) => {
      await migrate(db);
      // eslint-disable-next-line no-console
      console.log("Database schema initialized.");
    });
    return;
  }

  if (command === "seed-demo") {
    await withDb(async ({ db }) => {
      await migrate(db);
      const profile = await createProfile(db, {
        name: "Bay Area Civic/Si",
        category: "vehicle",
        query: "civic si",
        location: "bay-area",
        radiusMiles: 50,
        minPrice: 4000,
        maxPrice: 20000,
        filtersJson: { transmission: "manual", latitude: 37.7793, longitude: -122.419 },
        enabled: true
      });

      // eslint-disable-next-line no-console
      console.log(`Seeded profile: ${profile.id}`);
    });
    return;
  }

  if (command === "sync-all") {
    await withDb(async ({ db, config }) => {
      await migrate(db);
      const connector = buildConnector(config);
      const profiles = await listEnabledProfiles(db);

      // eslint-disable-next-line no-console
      console.log(`Running ${profiles.length} profile(s) with mode=${config.connectorMode}...`);

      for (const profile of profiles) {
        const summary = await runProfileSync({
          db,
          connector,
          profile,
          preferManualTransmission: config.preferManualTransmission
        });
        // eslint-disable-next-line no-console
        console.log(profile.name, summary);
      }
    });
    return;
  }

  if (command === "run-profile") {
    const profileId = args.profileId;
    if (!profileId) {
      throw new Error("Missing --profileId");
    }

    await withDb(async ({ db, config }) => {
      await migrate(db);
      const profile = await getProfile(db, profileId);
      if (!profile) {
        throw new Error(`Profile ${profileId} not found.`);
      }

      if (!profile.enabled) {
        throw new Error(`Profile ${profileId} is disabled.`);
      }

      const connector = buildConnector(config);
      const summary = await runProfileSync({
        db,
        connector,
        profile,
        preferManualTransmission: config.preferManualTransmission
      });
      // eslint-disable-next-line no-console
      console.log(summary);
    });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
