const DEFAULT_PORT = 10000;

export function loadConfig(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV ?? "development",
    port: Number.parseInt(env.PORT ?? `${DEFAULT_PORT}`, 10),
    databaseUrl: env.DATABASE_URL ?? "",
    apiToken: env.API_TOKEN ?? "",
    connectorMode: env.CONNECTOR_MODE ?? "mock",
    defaultSource: "facebook_marketplace",
    defaultRegion: env.DEFAULT_REGION ?? "us-ca",
    preferManualTransmission: env.PREFER_MANUAL_TRANSMISSION === "true"
  };
}

export function assertConfig(config) {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
}
