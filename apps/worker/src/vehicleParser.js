import { parsePrice } from "./utils.js";

const VEHICLE_MAKES = [
  "acura",
  "audi",
  "bmw",
  "chevrolet",
  "dodge",
  "ford",
  "honda",
  "hyundai",
  "infiniti",
  "kia",
  "lexus",
  "mazda",
  "mercedes",
  "mini",
  "mitsubishi",
  "nissan",
  "subaru",
  "toyota",
  "volkswagen",
  "volvo"
];

const MODELS_BY_MAKE = {
  honda: ["civic", "accord", "fit", "cr-v", "s2000"],
  toyota: ["corolla", "camry", "tacoma", "4runner", "prius", "supra", "mr2"],
  mazda: ["miata", "mx-5", "mazdaspeed3", "mazda3"],
  subaru: ["wrx", "brz", "forester", "outback"],
  bmw: ["m3", "335i", "328i", "128i", "135i"],
  nissan: ["370z", "350z", "sentra", "altima", "gtr"],
  ford: ["mustang", "focus", "fiesta", "f150"],
  volkswagen: ["gti", "jetta", "golf"],
  chevrolet: ["corvette", "camaro", "silverado"]
};

const MOD_PATTERNS = [
  { pattern: /coilover|lowered/, modType: "suspension", modName: "coilovers" },
  { pattern: /catback|exhaust|header/, modType: "intake_exhaust", modName: "exhaust" },
  { pattern: /intake|k&n/, modType: "intake_exhaust", modName: "intake" },
  { pattern: /hondata|kpro|cobb|apr tune|tune\b/, modType: "tune_ecu", modName: "ecu tune" },
  { pattern: /aftermarket wheel|wheels/, modType: "wheels_tires", modName: "aftermarket wheels" },
  { pattern: /short shifter/, modType: "clutch_transmission", modName: "short shifter" },
  { pattern: /supercharger|turbo/, modType: "turbo_supercharger", modName: "forced induction" },
  { pattern: /engine swap/, modType: "engine", modName: "engine swap" }
];

const RED_FLAGS = [
  "salvage",
  "rebuilt",
  "no title",
  "missing title",
  "needs smog",
  "no smog",
  "check engine",
  "overheating",
  "transmission slipping",
  "does not run",
  "mechanic special",
  "back fees"
];

const POSITIVE_SIGNALS = [
  "clean title",
  "maintenance records",
  "one owner",
  "stock",
  "smogged",
  "new tires",
  "recent service"
];

function addEvidence(evidence, field, value, confidence, evidenceText) {
  evidence.push({ field, value, confidence, evidenceText, parserVersion: "vehicle-parser-v1" });
}

export function parseVehicleListing(rawItem) {
  const merged = `${rawItem.titleRaw ?? ""} ${rawItem.descriptionRaw ?? ""}`.toLowerCase();
  const evidence = [];
  const attributes = {};
  const metadata = rawItem.sourceMetadata ?? {};
  const marketplaceMetadata = {};
  for (const key of ["sellerId", "customTitle", "subtitles", "previousPrice", "categoryId", "deliveryTypes", "videoIds", "isPending", "isSold", "isLive", "isHidden", "isViewerSeller", "currency"]) {
    if (metadata[key] !== undefined) marketplaceMetadata[key] = metadata[key];
  }
  if (Object.keys(marketplaceMetadata).length) attributes.marketplaceMetadata = marketplaceMetadata;
  if (rawItem.vehicleAttributes && typeof rawItem.vehicleAttributes === "object" && Object.keys(rawItem.vehicleAttributes).length) {
    attributes.marketplaceAttributes = rawItem.vehicleAttributes;
  }

  const yearMatch = merged.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    attributes.year = Number.parseInt(yearMatch[1], 10);
    addEvidence(evidence, "year", attributes.year, 0.9, yearMatch[0]);
  }

  for (const make of VEHICLE_MAKES) {
    if (merged.includes(make)) {
      attributes.make = make;
      addEvidence(evidence, "make", make, 0.85, make);
      break;
    }
  }

  if (attributes.make && MODELS_BY_MAKE[attributes.make]) {
    for (const model of MODELS_BY_MAKE[attributes.make]) {
      if (merged.includes(model)) {
        attributes.model = model;
        addEvidence(evidence, "model", model, 0.8, model);
        break;
      }
    }
  }

  // Prefer explicit Facebook vehicle fields to guesses from seller text.
  for (const field of ["make", "model", "year", "trim", "condition"]) {
    const value = rawItem.vehicleAttributes?.[field];
    if (value === undefined || value === null || `${value}`.trim() === "") continue;
    const normalized = field === "year" ? Number(value) : `${value}`.trim().toLowerCase();
    if (field === "year" && (!Number.isInteger(normalized) || normalized < 1900 || normalized > 2100)) continue;
    attributes[field] = normalized;
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      if (evidence[index].field === field) evidence.splice(index, 1);
    }
    addEvidence(evidence, field, normalized, 0.95, `Marketplace vehicle ${field} field`);
  }

  const mileageMatch =
    merged.match(/\b(\d{2,3})[,\s]?(\d{3})[\s.,-]*(?:miles|mi)\b/) ??
    merged.match(/\b(\d{4,6})[\s.,-]*(?:miles|mi)\b/) ??
    merged.match(/\b(\d{1,3})k[\s.,-]*(?:miles|mi)\b/) ??
    merged.match(/(?:mileage|odometer|\bodo\b|o\.d\.|on the clock|chassis)[^.\n]{0,30}?\b(\d[\d,]{3,6}\s*k?|\d{1,3}\s*k)\b/);

  const structuredMileage = Number(rawItem.mileage ?? rawItem.vehicleMileage ?? rawItem.vehicleAttributes?.mileage ?? rawItem.vehicleAttributes?.vehicle_mileage);
  if (Number.isFinite(structuredMileage) && structuredMileage >= 100 && structuredMileage <= 1_000_000) {
    attributes.mileage = Math.round(structuredMileage);
    addEvidence(evidence, "mileage", attributes.mileage, 0.95, "Marketplace vehicle mileage field");
  } else if (mileageMatch) {
    const lastGroup = mileageMatch[mileageMatch.length - 1];
    let mileage;
    if (mileageMatch[2] && /^\d{3}$/.test(mileageMatch[2])) {
      // Precise "85,433 miles" form: first alternative matched.
      mileage = Number.parseInt(`${mileageMatch[1]}${mileageMatch[2]}`, 10);
    } else if (/k/i.test(mileageMatch[0]) && !/,/.test(lastGroup) && lastGroup.length <= 3) {
      // Shorthand "81k miles" / "odo reads 80k".
      mileage = Number.parseInt(lastGroup, 10) * 1000;
    } else {
      mileage = Number.parseInt(`${lastGroup}`.replace(/,/g, ""), 10);
    }

    // Sanity range: real odometers live here; anything else is usually a
    // price ("close to 30k"), year, or part number that slipped through.
    if (Number.isFinite(mileage) && mileage >= 100 && mileage <= 1_000_000) {
      attributes.mileage = mileage;
      addEvidence(evidence, "mileage", attributes.mileage, 0.75, mileageMatch[0]);
    }
  }

  const structuredTransmission = `${rawItem.vehicleAttributes?.transmission ?? ""}`.toLowerCase();
  if (/manual|stick|standard/.test(structuredTransmission)) {
    attributes.transmission = "manual";
    addEvidence(evidence, "transmission", "manual", 0.95, "Marketplace transmission field");
  } else if (/automatic|\bauto\b|cvt|dsg|pdk/.test(structuredTransmission)) {
    attributes.transmission = "automatic";
    addEvidence(evidence, "transmission", "automatic", 0.95, "Marketplace transmission field");
  } else if (/(manual|stick shift|\b5 speed\b|\b6 speed\b|\b6spd\b|standard transmission|\bmt\b)/.test(merged)) {
    if (!/(manual windows|manual seats|manual locks|owner'?s manual)/.test(merged)) {
      attributes.transmission = "manual";
      addEvidence(evidence, "transmission", "manual", 0.8, "manual keyword");
    }
  } else if (/(automatic|\bauto\b|\bcvt\b|\bdsg\b|\bpdk\b)/.test(merged)) {
    attributes.transmission = "automatic";
    addEvidence(evidence, "transmission", "automatic", 0.75, "automatic keyword");
  } else {
    attributes.transmission = "unknown";
  }

  const titleSignals = ["clean title", "salvage title", "rebuilt title", "no title", "missing title", "bill of sale"];
  for (const signal of titleSignals) {
    if (merged.includes(signal)) {
      attributes.titleStatus = signal;
      addEvidence(evidence, "titleStatus", signal, 0.75, signal);
      break;
    }
  }

  const rawPriceValue = parsePrice(rawItem.priceRaw);
  if (rawPriceValue !== null) {
    attributes.price = rawPriceValue;
    addEvidence(evidence, "price", rawPriceValue, 0.95, rawItem.priceRaw ?? `${rawPriceValue}`);
  }

  const redFlags = RED_FLAGS.filter((flag) => merged.includes(flag));
  const positiveSignals = POSITIVE_SIGNALS.filter((signal) => merged.includes(signal));

  const modifications = MOD_PATTERNS.filter((entry) => entry.pattern.test(merged)).map((entry) => ({
    modType: entry.modType,
    modName: entry.modName,
    confidence: 0.7,
    evidenceText: entry.modName
  }));

  return {
    category: "vehicle",
    parserVersion: "vehicle-parser-v1",
    attributes,
    redFlags,
    positiveSignals,
    evidence,
    modifications
  };
}
