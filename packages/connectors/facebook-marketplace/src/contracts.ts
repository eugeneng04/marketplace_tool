import type { RawSourceItem, SearchProfile } from "@resale-intelligence/core";

export interface MarketplaceListingCard {
  rank: number;
  listingUrl: string;
  possibleListingId?: string;
  titleRaw?: string;
  priceRaw?: string;
  locationRaw?: string;
  thumbnailUrl?: string;
  rawCardText: string;
}

export interface FacebookConnectorSearchResult {
  cards: MarketplaceListingCard[];
  capturedAt: Date;
  sourceMetadata: Record<string, unknown>;
}

export interface FacebookMarketplaceConnector {
  captureListingCards(profile: SearchProfile): Promise<FacebookConnectorSearchResult>;
  fetchListingDetail(card: MarketplaceListingCard): Promise<RawSourceItem>;
  normalizeCardToRawSourceItem(card: MarketplaceListingCard, capturedAt: Date): RawSourceItem;
}
