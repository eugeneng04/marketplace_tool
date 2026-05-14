import type {
  DealScore,
  Item,
  ItemSnapshot,
  ParsedItem,
  PriceHistory,
  SearchProfile,
  SearchRun
} from "@resale-intelligence/core";

export interface SearchProfileRepository {
  create(input: SearchProfile): Promise<SearchProfile>;
  update(input: SearchProfile): Promise<SearchProfile>;
  listEnabled(): Promise<SearchProfile[]>;
}

export interface SearchRunRepository {
  create(input: SearchRun): Promise<SearchRun>;
  finish(input: SearchRun): Promise<SearchRun>;
}

export interface ItemRepository {
  upsert(input: Item): Promise<Item>;
  findBySourceIdentity(sourceItemId: string, normalizedUrl: string): Promise<Item | null>;
}

export interface SnapshotRepository {
  create(input: ItemSnapshot): Promise<ItemSnapshot>;
}

export interface PriceHistoryRepository {
  append(input: PriceHistory): Promise<PriceHistory>;
}

export interface ParsedItemRepository {
  save(input: ParsedItem): Promise<ParsedItem>;
}

export interface DealScoreRepository {
  save(input: DealScore): Promise<DealScore>;
}
