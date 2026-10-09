import { qualifyProfile } from "./profileQualification.js";
import { parseVehicleListing } from "./vehicleParser.js";
import { parsePrice } from "./utils.js";

export const DEFAULT_STALE_DETAIL_HOURS = 24;

export function isPlaceholderTitle(title) {
  return !title?.trim() || /^Marketplace listing(?:\s|$)/i.test(title.trim());
}

export function rawItemFromListing(item) {
  const attributes = item.parsed_attributes_json ?? {};
  return {
    source: item.source,
    sourceItemId: item.source_item_id,
    url: item.url,
    normalizedUrl: item.normalized_url,
    fingerprint: item.fingerprint,
    titleRaw: item.title_raw,
    descriptionRaw: item.description_raw,
    priceRaw: item.price_raw,
    locationRaw: item.location_raw,
    locationCity: item.location_city,
    locationRegion: item.location_region,
    imageUrls: item.image_urls ?? [],
    sellerRaw: item.seller_raw,
    mileage: attributes.mileage,
    vehicleAttributes: attributes.marketplaceAttributes ?? {},
    sourceMetadata: { ...(attributes.marketplaceMetadata ?? {}), postedDate: item.posted_at }
  };
}

function suppliedValues(values) {
  return Object.fromEntries(Object.entries(values ?? {}).filter(([, value]) =>
    value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0)
  ));
}

export function mergeListingObservation(item, observation) {
  if (!item) return observation;
  const cached = rawItemFromListing(item);
  const detailFetched = observation.sourceMetadata?.detailFetched === true;
  const incomingPrice = parsePrice(observation.priceRaw);
  return {
    ...cached,
    ...suppliedValues(observation),
    titleRaw: isPlaceholderTitle(observation.titleRaw) ? cached.titleRaw : observation.titleRaw,
    descriptionRaw: detailFetched ? observation.descriptionRaw || cached.descriptionRaw : cached.descriptionRaw || observation.descriptionRaw,
    priceRaw: incomingPrice === null ? cached.priceRaw : observation.priceRaw,
    imageUrls: [...new Set([...(cached.imageUrls ?? []), ...(observation.imageUrls ?? [])])],
    vehicleAttributes: { ...cached.vehicleAttributes, ...suppliedValues(observation.vehicleAttributes) },
    sourceMetadata: { ...cached.sourceMetadata, ...suppliedValues(observation.sourceMetadata), detailFetched }
  };
}

export function parseListingObservation(item, observation, { evidence = [], modifications = [] } = {}) {
  const parsed = parseVehicleListing(mergeListingObservation(item, observation));
  const incoming = parseVehicleListing(observation);
  const incomingAttributes = Object.fromEntries(Object.entries(incoming.attributes).filter(([field, value]) =>
    field !== "marketplaceAttributes" && field !== "marketplaceMetadata" && !(field === "transmission" && value === "unknown")
  ));
  const marketplaceAttributes = Object.fromEntries(Object.entries(parsed.attributes).filter(([field]) =>
    field === "marketplaceAttributes" || field === "marketplaceMetadata"
  ));
  parsed.attributes = { ...parsed.attributes, ...item?.parsed_attributes_json, ...incomingAttributes, ...marketplaceAttributes };
  const evidenceByField = new Map();
  for (const entry of [...parsed.evidence, ...incoming.evidence, ...evidence]) {
    if (`${parsed.attributes[entry.field]}` === `${entry.value}`) evidenceByField.set(entry.field, entry);
  }
  parsed.evidence = [...evidenceByField.values()];
  const explicitlyUnmodified = /\b(?:stock|unmodified|no modifications)\b/i.test(
    `${observation.titleRaw ?? ""} ${observation.descriptionRaw ?? ""}`
  );
  parsed.modifications = explicitlyUnmodified && !incoming.modifications.length ? [] : [...new Map(
    [...modifications, ...incoming.modifications].map(mod => [`${mod.modType}/${mod.modName}`, mod])
  ).values()];
  const detailReplacesText = observation?.sourceMetadata?.detailFetched === true &&
    Boolean((observation.descriptionRaw ?? "").trim() || !isPlaceholderTitle(observation.titleRaw));
  if (detailReplacesText) {
    parsed.redFlags = [...new Set([...parsed.redFlags, ...incoming.redFlags])];
    parsed.positiveSignals = [...new Set([...parsed.positiveSignals, ...incoming.positiveSignals])];
  } else {
    parsed.redFlags = [...new Set([...(item?.red_flags_json ?? []), ...parsed.redFlags, ...incoming.redFlags])];
    parsed.positiveSignals = [...new Set([...(item?.positive_signals_json ?? []), ...parsed.positiveSignals, ...incoming.positiveSignals])];
  }
  return parsed;
}

export function detailRefreshFor(item, profiles = [], now = Date.now()) {
  const lastFetchedAt = item?.last_scraped_at ?? null;
  let state;
  if (item?.parsed_attributes_json?.detailRefresh?.status === "incomplete") state = "incomplete";
  else if (!lastFetchedAt || !Number.isFinite(new Date(lastFetchedAt).getTime())) state = "missing";
  else {
    const intervals = profiles.map(profile => {
      const configured = Number.parseInt(`${profile.filtersJson?.staleDetailHours ?? DEFAULT_STALE_DETAIL_HOURS}`, 10);
      return Number.isFinite(configured) ? configured : DEFAULT_STALE_DETAIL_HOURS;
    });
    const interval = intervals.length ? Math.min(...intervals) : DEFAULT_STALE_DETAIL_HOURS;
    const staleHours = ["saved", "contacted"].includes(item.status) ? Math.min(interval, 12) : interval;
    const price = parsePrice(item.price_raw);
    const inconsistentPrice = price !== null && item.current_price !== null && item.current_price !== undefined && price !== item.current_price;
    state = inconsistentPrice || now - new Date(lastFetchedAt).getTime() >= staleHours * 3_600_000 ? "stale" : "fresh";
  }
  return { state, needsRefresh: state !== "fresh", lastFetchedAt };
}

export function listingCollectionState(item, profiles, now = Date.now(), modifications) {
  const raw = rawItemFromListing(item);
  const parsed = parseVehicleListing(raw);
  parsed.attributes = { ...parsed.attributes, ...item.parsed_attributes_json };
  if (modifications) parsed.modifications = modifications;
  return {
    qualifications: profiles.map(profile => ({
      profileId: profile.id,
      profileName: profile.name,
      ...qualifyProfile(profile, raw, parsed)
    })),
    detailRefresh: detailRefreshFor(item, profiles, now)
  };
}
