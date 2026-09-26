import { createHash } from "node:crypto";
import { FacebookGraphqlClient } from "./facebookGraphqlClient.js";
import { normalizeUrl } from "./utils.js";

function hashText(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function extractSourceItemId(url) {
  const match = url.match(/\/marketplace\/item\/([A-Za-z0-9._-]+)/);
  return match?.[1] ?? undefined;
}

function createMockCard(profile, rank) {
  const makes = ["Honda", "Toyota", "Mazda", "Subaru", "BMW", "Nissan", "Ford"];
  const models = {
    Honda: ["Civic Si", "Accord Sport"],
    Toyota: ["Corolla XSE", "Tacoma TRD"],
    Mazda: ["Miata", "Mazda3"],
    Subaru: ["WRX", "BRZ"],
    BMW: ["328i", "M3"],
    Nissan: ["370Z", "Sentra SE-R"],
    Ford: ["Mustang GT", "Focus ST"]
  };

  const make = makes[rank % makes.length];
  const model = models[make][rank % models[make].length];
  const year = 2008 + ((rank * 3) % 15);
  const miles = 65_000 + rank * 7_300;
  const price = 5500 + rank * 1200;
  const profileHash = hashText(`${profile.query}-${profile.location}-${profile.id}`);
  const sourceItemId = `${profileHash}-${rank}`;

  const titleRaw = `${year} ${make} ${model}`;
  const descriptionRaw =
    rank % 2 === 0
      ? `Clean title. ${miles} miles. manual transmission. recent service. new tires.`
      : `salvage title. ${miles} mi. automatic. needs smog. aftermarket wheels.`;

  const listingUrl = `https://www.facebook.com/marketplace/item/${sourceItemId}`;
  return {
    rank,
    sourceItemId,
    listingUrl,
    titleRaw,
    descriptionRaw,
    priceRaw: `$${price.toLocaleString("en-US")}`,
    locationRaw: profile.location,
    thumbnailUrl: `https://picsum.photos/seed/${sourceItemId}/640/480`
  };
}

function createMockConnector(mode, maxCards) {
  return {
    async captureListingCards(profile) {
      const cards = Array.from({ length: Math.min(maxCards, 10) }).map((_, index) => createMockCard(profile, index + 1));
      return {
        cards,
        capturedAt: new Date(),
        sourceMetadata: {
          mode,
          query: profile.query,
          location: profile.location
        }
      };
    },

    async fetchListingDetail(card) {
      return {
        source: "facebook_marketplace",
        sourceItemId: card.sourceItemId,
        url: card.listingUrl,
        normalizedUrl: normalizeUrl(card.listingUrl),
        titleRaw: card.titleRaw,
        descriptionRaw: card.descriptionRaw,
        priceRaw: card.priceRaw,
        locationRaw: card.locationRaw,
        imageUrls: [card.thumbnailUrl].filter(Boolean),
        sellerRaw: "seller stub",
        capturedAt: new Date(),
        sourceMetadata: {
          captureMode: "mock"
        }
      };
    },

    normalizeCardToRawSourceItem(card, capturedAt = new Date()) {
      return {
        source: "facebook_marketplace",
        sourceItemId: card.sourceItemId,
        url: card.listingUrl,
        normalizedUrl: normalizeUrl(card.listingUrl),
        titleRaw: card.titleRaw,
        descriptionRaw: card.descriptionRaw,
        priceRaw: card.priceRaw,
        locationRaw: card.locationRaw,
        imageUrls: [card.thumbnailUrl].filter(Boolean),
        sellerRaw: "seller stub",
        capturedAt,
        sourceMetadata: {
          captureMode: "mock"
        }
      };
    }
  };
}

function radiusMilesToKm(radiusMiles) {
  return Math.max(1, Math.round((radiusMiles ?? 25) * 1.60934));
}

function readProfileCoordinates(profile) {
  const filters = profile.filtersJson ?? {};
  const latitude = Number.parseFloat(`${filters.latitude ?? filters.lat ?? ""}`);
  const longitude = Number.parseFloat(`${filters.longitude ?? filters.lng ?? filters.lon ?? ""}`);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(
      "facebook_graphql requires profile.filtersJson.latitude and profile.filtersJson.longitude. Use /facebook/locations to find coordinates."
    );
  }

  return { latitude, longitude };
}

function listingToCard(listing, rank) {
  return {
    rank,
    sourceItemId: listing.id,
    listingUrl: listing.url,
    titleRaw: listing.title,
    priceRaw: listing.price,
    locationRaw: listing.location,
    thumbnailUrl: listing.imageUrl,
    rawCardText: [listing.title, listing.price, listing.location, listing.sellerName].filter(Boolean).join(" "),
    sourceMetadata: {
      captureMode: "facebook_graphql",
      postedDate: listing.postedDate,
      isPending: listing.isPending,
      sellerName: listing.sellerName,
      raw: listing.raw
    }
  };
}

export function detailToRawSourceItem(detail, card) {
  const sourceItemId = detail.id || card?.sourceItemId || extractSourceItemId(detail.url ?? card?.listingUrl ?? "");
  const url = detail.url || card?.listingUrl || `https://www.facebook.com/marketplace/item/${sourceItemId}/`;
  const cardTitle = card?.titleRaw && !/^Marketplace listing(?:\s|$)/i.test(card.titleRaw) ? card.titleRaw : "";

  return {
    source: "facebook_marketplace",
    sourceItemId,
    url,
    normalizedUrl: normalizeUrl(url),
    titleRaw: detail.title || cardTitle || `Marketplace listing ${sourceItemId ?? "unknown"}`,
    descriptionRaw: detail.description || card?.rawCardText || undefined,
    priceRaw: detail.price || card?.priceRaw || undefined,
    locationRaw: detail.location || card?.locationRaw || undefined,
    imageUrls: detail.images?.length ? detail.images : [detail.imageUrl || card?.thumbnailUrl].filter(Boolean),
    sellerRaw: detail.seller?.name || detail.sellerName || card?.sourceMetadata?.sellerName || undefined,
    mileage: detail.mileage ?? undefined,
    vehicleAttributes: detail.vehicleAttributes ?? {},
    capturedAt: new Date(),
    sourceMetadata: {
      captureMode: "facebook_graphql",
      condition: detail.condition || undefined,
      isPending: detail.isPending ?? card?.sourceMetadata?.isPending,
      isSold: detail.isSold ?? undefined,
      postedDate: detail.postedDate || card?.sourceMetadata?.postedDate || undefined
    }
  };
}

export function createFacebookGraphqlClient(options = {}) {
  return new FacebookGraphqlClient({
    facebookCookie: options.facebookCookie,
    facebookMaxRequestsPerMinute: options.facebookMaxRequestsPerMinute,
    facebookUserAgent: options.facebookUserAgent,
    chromeProfile: options.chromeProfile || "Default"
  });
}

export function createFacebookGraphqlConnector({
  facebookCookie,
  facebookMaxRequestsPerMinute,
  facebookUserAgent,
  maxCardsPerRun,
  chromeProfile
}) {
  const client = createFacebookGraphqlClient({
    facebookCookie,
    facebookMaxRequestsPerMinute,
    facebookUserAgent,
    chromeProfile
  });

  return {
    client,

    async captureListingCards(profile) {
      const { latitude, longitude } = readProfileCoordinates(profile);
      const radiusKm = Number.parseInt(`${profile.filtersJson?.radiusKm ?? radiusMilesToKm(profile.radiusMiles)}`, 10);
      const result = await client.searchListings({
        query: profile.query,
        latitude,
        longitude,
        radiusKm,
        newestWithinDays: profile.filtersJson?.newestWithinDays ?? 1,
        minPrice: profile.minPrice ?? undefined,
        maxPrice: profile.maxPrice ?? undefined,
        category: profile.filtersJson?.facebookCategoryId,
        limit: maxCardsPerRun
      });

      return {
        cards: result.listings.map((listing, index) => listingToCard(listing, index + 1)),
        capturedAt: new Date(),
        sourceMetadata: {
          mode: "facebook_graphql",
          query: profile.query,
          latitude,
          longitude,
          radiusKm,
          hasNextPage: result.hasNextPage,
          endCursor: result.endCursor,
          diagnostics: result.diagnostics
        }
      };
    },

    async fetchListingDetail(card) {
      const listingId = card.sourceItemId ?? extractSourceItemId(card.listingUrl);
      if (!listingId) {
        return this.normalizeCardToRawSourceItem(card);
      }
      const detail = await client.getListingDetail(listingId);
      return detailToRawSourceItem(detail, card);
    },

    normalizeCardToRawSourceItem(card, capturedAt = new Date()) {
      return {
        source: "facebook_marketplace",
        sourceItemId: card.sourceItemId,
        url: card.listingUrl,
        normalizedUrl: normalizeUrl(card.listingUrl),
        titleRaw: card.titleRaw,
        descriptionRaw: card.rawCardText,
        priceRaw: card.priceRaw,
        locationRaw: card.locationRaw,
        imageUrls: [card.thumbnailUrl].filter(Boolean),
        sellerRaw: card.sourceMetadata?.sellerName,
        capturedAt,
        sourceMetadata: {
          ...(card.sourceMetadata ?? {}),
          captureMode: "facebook_graphql"
        }
      };
    }
  };
}

export function createFacebookConnector(options = {}) {
  const {
    mode = "mock",
    facebookCookie = "",
    facebookMaxRequestsPerMinute,
    facebookUserAgent,
    maxCardsPerRun = 25,
    chromeProfile = "Default"
  } = options;

  if (mode === "mock") {
    return createMockConnector(mode, maxCardsPerRun);
  }

  if (mode === "facebook_graphql") {
    return createFacebookGraphqlConnector({
      facebookCookie,
      facebookMaxRequestsPerMinute,
      facebookUserAgent,
      maxCardsPerRun,
      chromeProfile
    });
  }

  throw new Error(`Unsupported CONNECTOR_MODE: ${mode}. Supported: "mock", "facebook_graphql".`);
}
