import type { DealScore, Item, ParsedItem } from "@resale-intelligence/core";

export interface MarketTrendMetrics {
  sampleSize: number;
  medianPrice?: number;
  p25Price?: number;
  p75Price?: number;
  listingCount?: number;
  newCount?: number;
  disappearedCount?: number;
  priceDropFrequency?: number;
  confidence: number;
}

export interface ValuationInput {
  item: Item;
  parsed: ParsedItem;
  localTrend: MarketTrendMetrics;
  prefersManualTransmission?: boolean;
}

export interface ValuationService {
  scoreListing(input: ValuationInput): Promise<DealScore>;
}

export interface TrendService {
  getLocalTrendSnapshot(category: string, queryKey: string, locationRegion: string): Promise<MarketTrendMetrics>;
}
