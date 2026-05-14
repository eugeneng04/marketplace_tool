import type { Category, ParsedItem, RawSourceItem } from "@resale-intelligence/core";

export interface BaseCategoryParser {
  readonly category: Category;
  readonly parserVersion: string;
  parse(item: RawSourceItem): Promise<ParsedItem>;
}

export interface VehicleParser extends BaseCategoryParser {
  readonly category: "vehicle";
}

export interface WheelsTiresParser extends BaseCategoryParser {
  readonly category: "wheels_tires";
}

export interface OfficeChairParser extends BaseCategoryParser {
  readonly category: "office_chair";
}

export interface BikePartParser extends BaseCategoryParser {
  readonly category: "bike_part";
}

export interface GenericParser extends BaseCategoryParser {
  readonly category: "generic";
}
