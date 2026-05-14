const DEFAULT_PORT = 10000;

export function loadConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: Number.parseInt(env.PORT ?? `${DEFAULT_PORT}`, 10),
    databaseUrl: env.DATABASE_URL ?? "",
    apiToken: env.API_TOKEN ?? "",
    connectorMode: env.CONNECTOR_MODE ?? "mock",
    facebookCookie: env.FB_COOKIE ?? "",
    facebookUserAgent:
      env.FB_USER_AGENT ??
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    facebookSearchBaseUrl: env.FB_SEARCH_BASE_URL ?? "https://www.facebook.com/marketplace/search/",
    maxCardsPerRun: Number.parseInt(env.MAX_CARDS_PER_RUN ?? "25", 10),
    defaultSource: "facebook_marketplace",
    defaultRegion: env.DEFAULT_REGION ?? "us-ca",
    preferManualTransmission: env.PREFER_MANUAL_TRANSMISSION === "true"
  };
}

export function assertConfig(config) {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }

  if (config.connectorMode === "facebook_html" && !config.facebookCookie) {
    throw new Error("FB_COOKIE is required when CONNECTOR_MODE=facebook_html.");
  }
}
