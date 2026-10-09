import { parseVehicleListing } from "./vehicleParser.js";

export function qualifyProfile(profile, raw, parsed = parseVehicleListing(raw)) {
  const filters = profile.filtersJson ?? {};
  const attrs = parsed.attributes;
  const failedFields = [];
  const missingFields = [];

  function check(field, known, matches) {
    if (!known) missingFields.push(field);
    else if (!matches) failedFields.push(field);
  }

  if (filters.generation) {
    const generation = filters.generation;
    const title = `${raw.titleRaw ?? ""}`.toLowerCase();
    const make = `${generation.make ?? ""}`.toLowerCase();
    const model = `${generation.model ?? ""}`.toLowerCase();
    const matchesModel = (value) => model === "3 series"
      ? /\b(?:3\s*series|3\d{2}[a-z]{0,3})\b/.test(value)
      : value.includes(model);
    const vehicleMake = attrs.make ?? (make && title.includes(make) ? make : null);
    const vehicleModel = attrs.model ?? (model && matchesModel(title) ? model : null);
    const makeKnown = Boolean(make && vehicleMake);
    const modelKnown = Boolean(model && vehicleModel);
    const yearKnown = Number.isFinite(attrs.year);
    const contradicts = (makeKnown && vehicleMake !== make) ||
      (modelKnown && !matchesModel(vehicleModel)) ||
      (yearKnown && (attrs.year < Number(generation.yearFrom) || attrs.year > Number(generation.yearTo)));
    check("generation", contradicts || (makeKnown && modelKnown && yearKnown), !contradicts);
  }

  if (filters.transmission) {
    const known = attrs.transmission === "manual" || attrs.transmission === "automatic";
    check("transmission", known, attrs.transmission === filters.transmission);
  }
  if (filters.yearMin) {
    check("yearMin", Number.isFinite(attrs.year), attrs.year >= Number(filters.yearMin));
  }
  if (filters.yearMax) {
    check("yearMax", Number.isFinite(attrs.year), attrs.year <= Number(filters.yearMax));
  }
  if (filters.maxMileage) {
    check("maxMileage", Number.isFinite(attrs.mileage), attrs.mileage <= Number(filters.maxMileage));
  }
  if (filters.cleanTitleOnly) {
    check("cleanTitleOnly", Boolean(attrs.titleStatus), attrs.titleStatus === "clean title");
  }
  if (filters.modifiedOnly) {
    const hasModifications = parsed.modifications.length > 0;
    const explicitlyUnmodified = /\b(?:stock|unmodified|no modifications)\b/i.test(
      `${raw.titleRaw ?? ""} ${raw.descriptionRaw ?? ""}`
    );
    check("modifiedOnly", hasModifications || explicitlyUnmodified, hasModifications);
  }

  return {
    state: failedFields.length ? "mismatch" : missingFields.length ? "unknown" : "match",
    failedFields,
    missingFields
  };
}
