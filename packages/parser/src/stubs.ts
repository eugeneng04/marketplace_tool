import type { ParsedItem, RawSourceItem } from "@resale-intelligence/core";
import type {
  BikePartParser,
  GenericParser,
  OfficeChairParser,
  VehicleParser,
  WheelsTiresParser
} from "./contracts";

function createEmptyParsedItem(category: ParsedItem["category"], item: RawSourceItem, parserVersion: string): ParsedItem {
  return {
    itemId: item.sourceItemId ?? item.normalizedUrl,
    category,
    attributes: {},
    modifications: [],
    redFlags: [],
    positiveSignals: [],
    evidence: [],
    parserVersion,
    parsedAt: new Date()
  };
}

export class VehicleParserStub implements VehicleParser {
  readonly category = "vehicle" as const;
  readonly parserVersion = "vehicle-stub-v0";

  async parse(item: RawSourceItem): Promise<ParsedItem> {
    return createEmptyParsedItem(this.category, item, this.parserVersion);
  }
}

export class WheelsTiresParserStub implements WheelsTiresParser {
  readonly category = "wheels_tires" as const;
  readonly parserVersion = "wheels-tires-stub-v0";

  async parse(item: RawSourceItem): Promise<ParsedItem> {
    return createEmptyParsedItem(this.category, item, this.parserVersion);
  }
}

export class OfficeChairParserStub implements OfficeChairParser {
  readonly category = "office_chair" as const;
  readonly parserVersion = "office-chair-stub-v0";

  async parse(item: RawSourceItem): Promise<ParsedItem> {
    return createEmptyParsedItem(this.category, item, this.parserVersion);
  }
}

export class BikePartParserStub implements BikePartParser {
  readonly category = "bike_part" as const;
  readonly parserVersion = "bike-part-stub-v0";

  async parse(item: RawSourceItem): Promise<ParsedItem> {
    return createEmptyParsedItem(this.category, item, this.parserVersion);
  }
}

export class GenericParserStub implements GenericParser {
  readonly category = "generic" as const;
  readonly parserVersion = "generic-stub-v0";

  async parse(item: RawSourceItem): Promise<ParsedItem> {
    return createEmptyParsedItem(this.category, item, this.parserVersion);
  }
}
