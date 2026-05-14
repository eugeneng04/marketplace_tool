import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { normalizeUrl } from "./utils.js";

const FACEBOOK_ORIGIN = "https://www.facebook.com";

function hashText(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function extractSourceItemId(url) {
  const match = url.match(/\/marketplace\/item\/([A-Za-z0-9._-]+)/);
  return match?.[1] ?? undefined;
}

function normalizeText(value) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function extractPriceFromText(text) {
  const match = text.match(/\$\s?\d[\d,]*/);
  return match ? match[0].replace(/\s+/g, "") : undefined;
}

function inferTitleFromText(text, fallbackId) {
  const compact = normalizeText(text);
  if (!compact) {
    return `Marketplace listing ${fallbackId ?? "unknown"}`;
  }

  const withoutPrice = compact.replace(/\$\s?\d[\d,]*/g, "").trim();
  if (!withoutPrice) {
    return `Marketplace listing ${fallbackId ?? "unknown"}`;
  }

  const words = withoutPrice.split(" ").filter(Boolean);
  return words.slice(0, 18).join(" ");
}

function buildSearchUrl(profile, searchBaseUrl) {
  const profileSearchUrl = profile?.filtersJson?.searchUrl;
  if (typeof profileSearchUrl === "string" && profileSearchUrl.startsWith("http")) {
    return profileSearchUrl;
  }

  const url = new URL(searchBaseUrl);
  url.searchParams.set("query", profile.query);

  if (profile.minPrice !== null && profile.minPrice !== undefined) {
    url.searchParams.set("minPrice", `${profile.minPrice}`);
  }

  if (profile.maxPrice !== null && profile.maxPrice !== undefined) {
    url.searchParams.set("maxPrice", `${profile.maxPrice}`);
  }

  if (profile.radiusMiles !== null && profile.radiusMiles !== undefined) {
    url.searchParams.set("radius", `${profile.radiusMiles}`);
  }

  if (profile.location && !url.searchParams.has("location")) {
    url.searchParams.set("location", profile.location);
  }

  return url.toString();
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

async function fetchHtml(url, headers) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const compactBody = normalizeText(body).slice(0, 180);
      const bodyHint = compactBody ? ` :: ${compactBody}` : "";
      throw new Error(`HTTP ${response.status} while fetching ${url}${bodyHint}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseCardsFromSearchHtml(html, maxCards = 25) {
  const $ = cheerio.load(html);
  const cards = [];
  const seen = new Set();

  $("a[href*='/marketplace/item/']").each((_, element) => {
    if (cards.length >= maxCards) {
      return;
    }

    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const absoluteUrl = href.startsWith("http") ? href : new URL(href, FACEBOOK_ORIGIN).toString();
    const normalized = normalizeUrl(absoluteUrl);
    if (seen.has(normalized)) {
      return;
    }

    seen.add(normalized);

    const sourceItemId = extractSourceItemId(absoluteUrl);

    const cardContainer =
      $(element).closest("article").first().length > 0
        ? $(element).closest("article").first()
        : $(element).closest("li, div").first();

    const blockText = normalizeText(cardContainer.text() || $(element).text());

    cards.push({
      rank: cards.length + 1,
      sourceItemId,
      listingUrl: absoluteUrl,
      titleRaw: inferTitleFromText(blockText, sourceItemId),
      priceRaw: extractPriceFromText(blockText),
      locationRaw: undefined,
      thumbnailUrl: undefined,
      rawCardText: blockText
    });
  });

  return cards;
}

function extractDetailFromHtml(url, html) {
  if (/log into facebook|you must log in/i.test(html)) {
    throw new Error("Facebook session appears invalid or logged out. Refresh FB_COOKIE.");
  }

  const $ = cheerio.load(html);

  const ogTitle = normalizeText($("meta[property='og:title']").attr("content"));
  const ogDescription = normalizeText($("meta[property='og:description']").attr("content"));

  const ogImages = [];
  $("meta[property='og:image']").each((_, node) => {
    const value = normalizeText($(node).attr("content"));
    if (value) {
      ogImages.push(value);
    }
  });

  const pageText = normalizeText($("body").text());

  const titleRaw = ogTitle || inferTitleFromText(pageText, extractSourceItemId(url));
  const descriptionRaw = ogDescription || pageText.slice(0, 1_500);
  const priceRaw = extractPriceFromText(pageText);

  return {
    source: "facebook_marketplace",
    sourceItemId: extractSourceItemId(url),
    url,
    normalizedUrl: normalizeUrl(url),
    titleRaw,
    priceRaw,
    descriptionRaw,
    locationRaw: undefined,
    imageUrls: ogImages,
    sellerRaw: undefined,
    capturedAt: new Date(),
    sourceMetadata: {
      captureMode: "facebook_html",
      rawLength: html.length
    }
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

function createFacebookHtmlConnector({ facebookCookie, facebookUserAgent, facebookSearchBaseUrl, maxCardsPerRun }) {
  const baseHeaders = {
    "user-agent": facebookUserAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "max-age=0",
    cookie: facebookCookie
  };

  return {
    async captureListingCards(profile) {
      const searchUrl = buildSearchUrl(profile, facebookSearchBaseUrl);
      const html = await fetchHtml(searchUrl, {
        ...baseHeaders,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1"
      });
      if (/log into facebook|you must log in/i.test(html)) {
        throw new Error("Facebook session appears invalid or logged out. Refresh FB_COOKIE.");
      }
      const cards = parseCardsFromSearchHtml(html, maxCardsPerRun);
      if (cards.length === 0) {
        throw new Error("No listing cards found in search HTML. Update profile URL or parser selectors.");
      }

      return {
        cards,
        capturedAt: new Date(),
        sourceMetadata: {
          mode: "facebook_html",
          searchUrl,
          cardCount: cards.length
        }
      };
    },

    async fetchListingDetail(card) {
      const html = await fetchHtml(card.listingUrl, {
        ...baseHeaders,
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "upgrade-insecure-requests": "1",
        referer: "https://www.facebook.com/marketplace/"
      });
      const detail = extractDetailFromHtml(card.listingUrl, html);

      // Keep better card-level values when detail parsing is weak.
      if (!detail.priceRaw && card.priceRaw) {
        detail.priceRaw = card.priceRaw;
      }
      if ((!detail.titleRaw || detail.titleRaw.startsWith("Marketplace listing")) && card.titleRaw) {
        detail.titleRaw = card.titleRaw;
      }
      if (!detail.locationRaw && card.locationRaw) {
        detail.locationRaw = card.locationRaw;
      }

      return detail;
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
        sellerRaw: undefined,
        capturedAt,
        sourceMetadata: {
          captureMode: "facebook_html"
        }
      };
    }
  };
}

export function createFacebookConnector(options = {}) {
  const {
    mode = "mock",
    facebookCookie = "",
    facebookUserAgent,
    facebookSearchBaseUrl,
    maxCardsPerRun = 25
  } = options;

  if (mode === "mock") {
    return createMockConnector(mode, maxCardsPerRun);
  }

  if (mode === "facebook_html") {
    return createFacebookHtmlConnector({
      facebookCookie,
      facebookUserAgent,
      facebookSearchBaseUrl,
      maxCardsPerRun
    });
  }

  throw new Error(`Unsupported CONNECTOR_MODE: ${mode}. Supported: \"mock\", \"facebook_html\".`);
}
