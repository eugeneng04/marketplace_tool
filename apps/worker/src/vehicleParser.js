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

  const mileageMatch =
    merged.match(/\b(\d{2,3})k\b/) ?? merged.match(/\b(\d{2,3})[,\s]?(\d{3})\s?(?:miles|mi)\b/);

  if (mileageMatch) {
    if (mileageMatch[2]) {
      attributes.mileage = Number.parseInt(`${mileageMatch[1]}${mileageMatch[2]}`, 10);
    } else {
      attributes.mileage = Number.parseInt(mileageMatch[1], 10) * 1000;
    }

    addEvidence(evidence, "mileage", attributes.mileage, 0.75, mileageMatch[0]);
  }

  if (/(manual|stick shift|\b5 speed\b|\b6 speed\b|\b6spd\b|standard transmission|\bmt\b)/.test(merged)) {
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
