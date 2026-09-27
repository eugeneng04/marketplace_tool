import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 10000;
const WORKER_DIR = dirname(fileURLToPath(import.meta.url));

function parseEnvFile(contents) {
  const parsed = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

function findRepoEnvFile() {
  let current = WORKER_DIR;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

function loadEnv(env) {
  const envFile = findRepoEnvFile();
  if (!envFile) {
    return env;
  }

  return {
    ...parseEnvFile(readFileSync(envFile, "utf8")),
    ...env
  };
}

export function loadConfig(env = process.env) {
  const mergedEnv = loadEnv(env);

  return {
    nodeEnv: mergedEnv.NODE_ENV ?? "development",
    port: Number.parseInt(mergedEnv.PORT ?? `${DEFAULT_PORT}`, 10),
    databaseUrl: mergedEnv.DATABASE_URL ?? "",
    apiToken: mergedEnv.API_TOKEN ?? "",
    schedulerEnabled: mergedEnv.SCHEDULER_ENABLED !== "false",
    schedulerToken: mergedEnv.SCHEDULER_TOKEN ?? "",
    connectorMode: mergedEnv.CONNECTOR_MODE ?? "mock",
    facebookCookie: mergedEnv.FB_COOKIE ?? "",
    facebookMaxRequestsPerMinute: Number(mergedEnv.FB_MAX_REQUESTS_PER_MINUTE ?? 10),
    facebookUserAgent:
      mergedEnv.FB_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    chromeProfile: mergedEnv.CHROME_PROFILE ?? "Default",
    maxCardsPerRun: Number.parseInt(mergedEnv.MAX_CARDS_PER_RUN ?? "25", 10),
    defaultSource: "facebook_marketplace",
    defaultRegion: mergedEnv.DEFAULT_REGION ?? "us-ca",
    preferManualTransmission: mergedEnv.PREFER_MANUAL_TRANSMISSION === "true"
  };
}

export function assertConfig(config) {
  if (config.nodeEnv === "production" && !config.apiToken) {
    throw new Error("API_TOKEN is required in production.");
  }
  if (!config.schedulerEnabled && !config.schedulerToken) {
    throw new Error("SCHEDULER_TOKEN is required when the internal scheduler is disabled.");
  }
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required. Create .env from .env.example or export DATABASE_URL before starting the worker.");
  }

  if (!["mock", "facebook_graphql"].includes(config.connectorMode)) {
    throw new Error('CONNECTOR_MODE must be "mock" or "facebook_graphql".');
  }
}
