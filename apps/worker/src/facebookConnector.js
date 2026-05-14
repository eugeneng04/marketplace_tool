import { createHash } from "node:crypto";
import { normalizeUrl } from "./utils.js";

function hashText(input) {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
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

export function createFacebookConnector({ mode = "mock" }) {
  if (mode !== "mock") {
    throw new Error(`Unsupported CONNECTOR_MODE: ${mode}. Use \"mock\" for MVP.`);
  }

  return {
    async captureListingCards(profile) {
      const cards = Array.from({ length: 10 }).map((_, index) => createMockCard(profile, index + 1));
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
