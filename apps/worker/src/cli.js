import { assertConfig, loadConfig } from "./config.js";
import { createDb, createProfile, listEnabledProfiles, migrate } from "./db.js";
import { createFacebookConnector } from "./facebookConnector.js";
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

  if (!command) {
    throw new Error("Usage: node src/cli.js <migrate|seed-demo|sync-all|run-profile>");
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
        filtersJson: { transmission: "manual" },
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
      const connector = createFacebookConnector({ mode: config.connectorMode });
      const profiles = await listEnabledProfiles(db);

      // eslint-disable-next-line no-console
      console.log(`Running ${profiles.length} profile(s)...`);

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
      const profiles = await listEnabledProfiles(db);
      const profile = profiles.find((row) => row.id === profileId);
      if (!profile) {
        throw new Error(`Profile ${profileId} not found or disabled.`);
      }

      const connector = createFacebookConnector({ mode: config.connectorMode });
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
