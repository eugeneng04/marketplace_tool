export type Category = "vehicle" | "wheels_tires" | "office_chair" | "bike_part" | "generic";

export type SourceName = "facebook_marketplace";

export type ListingStatus =
  | "new"
  | "watching"
  | "saved"
  | "contacted"
  | "rejected"
  | "sold"
  | "possibly_gone"
  | "hidden";

export interface SearchProfile {
  id: string;
  name: string;
  category: Category;
  query: string;
  location: string;
  radiusMiles: number;
  minPrice?: number;
  maxPrice?: number;
  filtersJson: Record<string, unknown>;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SearchRun {
  id: string;
  searchProfileId: string;
  source: SourceName;
  startedAt: Date;
  finishedAt?: Date;
  status: "running" | "completed" | "failed";
  resultsFound: number;
  newItems: number;
  existingItems: number;
  detailPagesOpened: number;
  errorMessage?: string;
}

export interface Item {
  id: string;
  category: Category;
  source: SourceName;
  sourceItemId?: string;
  url: string;
  normalizedUrl: string;
  fingerprint?: string;
  titleRaw: string;
  descriptionRaw?: string;
  priceRaw?: string;
  locationRaw?: string;
  imageUrls: string[];
  sellerRaw?: string;
  currentPrice?: number;
  locationCity?: string;
  locationRegion?: string;
  latitude?: number;
  longitude?: number;
  status: ListingStatus;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastScrapedAt?: Date;
  possiblyGoneAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ItemSnapshot {
  id: string;
  itemId: string;
  capturedAt: Date;
  titleRaw?: string;
  priceRaw?: string;
  parsedPrice?: number;
  descriptionRaw?: string;
  locationRaw?: string;
  imageUrls: string[];
  availabilityStatus?: "active" | "possibly_gone" | "sold";
}

export interface SearchHit {
  id: string;
  searchRunId: string;
  itemId: string;
  rank: number;
  seenAt: Date;
}

export interface PriceHistory {
  id: string;
  itemId: string;
  price: number;
  priceRaw?: string;
  capturedAt: Date;
}

export interface RawSourceItem {
  source: SourceName;
  sourceItemId?: string;
  url: string;
  normalizedUrl: string;
  titleRaw: string;
  priceRaw?: string;
  descriptionRaw?: string;
  locationRaw?: string;
  imageUrls: string[];
  sellerRaw?: string;
  capturedAt: Date;
  sourceMetadata: Record<string, unknown>;
}

export interface Modification {
  modType:
    | "engine"
    | "turbo_supercharger"
    | "intake_exhaust"
    | "tune_ecu"
    | "suspension"
    | "wheels_tires"
    | "brakes"
    | "clutch_transmission"
    | "interior"
    | "exterior"
    | "audio"
    | "safety"
    | "emissions_risk"
    | "unknown";
  modName: string;
  brand?: string;
  confidence: number;
  evidenceText: string;
}

export interface VehicleAttributes {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  generation?: string;
  bodyStyle?: string;
  mileage?: number;
  transmission?: "manual" | "automatic" | "unknown";
  drivetrain?: string;
  engine?: string;
  fuelType?: string;
  titleStatus?: string;
  color?: string;
  vin?: string;
  smogStatus?: string;
  registrationStatus?: string;
  condition?: string;
}

export interface ParsedFieldEvidence {
  field: string;
  value: string | number | boolean | null;
  confidence: number;
  evidenceText: string;
  parserVersion: string;
}

export interface ParsedItem {
  itemId: string;
  category: Category;
  attributes: Record<string, unknown>;
  vehicleAttributes?: VehicleAttributes;
  modifications: Modification[];
  redFlags: string[];
  positiveSignals: string[];
  evidence: ParsedFieldEvidence[];
  parserVersion: string;
  parsedAt: Date;
}

export interface DealScore {
  itemId: string;
  score: number;
  priceScore: number;
  qualityScore: number;
  confidence: number;
  estimatedLow?: number;
  estimatedHigh?: number;
  verdict: string;
  explanation: string[];
  scoredAt: Date;
}
