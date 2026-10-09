import test from "node:test";
import assert from "node:assert/strict";
import { qualifyProfile } from "../src/profileQualification.js";

const civicGeneration = { make: "Honda", model: "Civic", yearFrom: 2012, yearTo: 2015 };

test("structured card facts and title text can satisfy all configured filters", () => {
  assert.deepEqual(qualifyProfile({ filtersJson: {
    generation: civicGeneration,
    transmission: "manual",
    yearMin: 2012,
    yearMax: 2015,
    maxMileage: 100000,
    cleanTitleOnly: true,
    modifiedOnly: true
  } }, {
    titleRaw: "2013 Honda Civic clean title coilovers",
    mileage: 87000,
    vehicleAttributes: { transmission: "Manual" }
  }), { state: "match", failedFields: [], missingFields: [] });
});

test("every configured criterion reports missing card facts", () => {
  assert.deepEqual(qualifyProfile({ filtersJson: {
    generation: civicGeneration,
    transmission: "manual",
    yearMin: 2012,
    yearMax: 2015,
    maxMileage: 100000,
    cleanTitleOnly: true,
    modifiedOnly: true
  } }, { titleRaw: "Marketplace listing", mileage: null }), {
    state: "unknown",
    failedFields: [],
    missingFields: ["generation", "transmission", "yearMin", "yearMax", "maxMileage", "cleanTitleOnly", "modifiedOnly"]
  });
});

test("all contradictions and missing criteria are retained with mismatch precedence", () => {
  assert.deepEqual(qualifyProfile({ filtersJson: {
    generation: civicGeneration,
    transmission: "manual",
    yearMin: 2012,
    yearMax: 2015,
    maxMileage: 100000,
    cleanTitleOnly: true,
    modifiedOnly: true
  } }, {
    titleRaw: "2018 Honda Civic rebuilt title",
    mileage: 120000,
    vehicleAttributes: { transmission: "Automatic" }
  }), {
    state: "mismatch",
    failedFields: ["generation", "transmission", "yearMax", "maxMileage", "cleanTitleOnly"],
    missingFields: ["modifiedOnly"]
  });
});

test("explicit automatic and manual transmissions contradict the opposite filter", () => {
  assert.deepEqual(qualifyProfile({ filtersJson: { transmission: "manual" } }, {
    titleRaw: "2013 Honda Civic automatic"
  }), { state: "mismatch", failedFields: ["transmission"], missingFields: [] });
  assert.deepEqual(qualifyProfile({ filtersJson: { transmission: "automatic" } }, {
    titleRaw: "2013 Honda Civic manual"
  }), { state: "mismatch", failedFields: ["transmission"], missingFields: [] });
  assert.deepEqual(qualifyProfile({ filtersJson: { transmission: "manual" } }, {
    titleRaw: "2013 Honda Civic manual",
    vehicleAttributes: { transmission: "Automatic" }
  }), { state: "mismatch", failedFields: ["transmission"], missingFields: [] });
});

test("null mileage remains unknown while actual odometer evidence qualifies", () => {
  const profile = { filtersJson: { maxMileage: 100000 } };
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", mileage: null,
    vehicleAttributes: { mileage: null }
  }), { state: "unknown", failedFields: [], missingFields: ["maxMileage"] });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", mileage: null,
    descriptionRaw: "85,433 miles"
  }), { state: "match", failedFields: [], missingFields: [] });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", vehicleAttributes: { mileage: 110000 }
  }), { state: "mismatch", failedFields: ["maxMileage"], missingFields: [] });
});

test("one listing has distinct qualifications for different saved profiles", () => {
  const raw = { titleRaw: "2013 Honda Civic", mileage: 90000, vehicleAttributes: { transmission: "Manual" } };
  const before = structuredClone(raw);
  assert.deepEqual(qualifyProfile({ id: "manual", filtersJson: { transmission: "manual", maxMileage: 100000 } }, raw), {
    state: "match", failedFields: [], missingFields: []
  });
  assert.deepEqual(qualifyProfile({ id: "automatic", filtersJson: { transmission: "automatic", cleanTitleOnly: true } }, raw), {
    state: "mismatch", failedFields: ["transmission"], missingFields: ["cleanTitleOnly"]
  });
  assert.deepEqual(qualifyProfile({ id: "modified", filtersJson: { modifiedOnly: true } }, raw), {
    state: "unknown", failedFields: [], missingFields: ["modifiedOnly"]
  });
  assert.deepEqual(raw, before);
});

test("clean title needs affirmative title or description evidence", () => {
  const profile = { filtersJson: { cleanTitleOnly: true } };
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", vehicleAttributes: { title_status: "clean" },
    sourceMetadata: { customTitle: "Clean title", subtitles: ["Clean title"] }
  }), { state: "unknown", failedFields: [], missingFields: ["cleanTitleOnly"] });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", descriptionRaw: "Clean title."
  }), { state: "match", failedFields: [], missingFields: [] });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", descriptionRaw: "Bill of sale only."
  }), { state: "mismatch", failedFields: ["cleanTitleOnly"], missingFields: [] });
});

test("modification absence remains unknown until explicit evidence says stock", () => {
  const profile = { filtersJson: { modifiedOnly: true } };
  assert.deepEqual(qualifyProfile(profile, { titleRaw: "2013 Honda Civic" }), {
    state: "unknown", failedFields: [], missingFields: ["modifiedOnly"]
  });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", descriptionRaw: "Runs great.", sourceMetadata: { detailFetched: true }
  }), { state: "unknown", failedFields: [], missingFields: ["modifiedOnly"] });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", descriptionRaw: "Coilovers and short shifter."
  }), { state: "match", failedFields: [], missingFields: [] });
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2013 Honda Civic", descriptionRaw: "Completely unmodified."
  }), { state: "mismatch", failedFields: ["modifiedOnly"], missingFields: [] });
});

test("missing generation identity and year stay unknown", () => {
  const profile = { filtersJson: { generation: civicGeneration } };
  for (const titleRaw of ["Honda Civic", "2013 Honda", "2013 sedan", "Marketplace listing"]) {
    assert.deepEqual(qualifyProfile(profile, { titleRaw }), {
      state: "unknown", failedFields: [], missingFields: ["generation"]
    });
  }
  assert.deepEqual(qualifyProfile(profile, { titleRaw: "2013 Honda Civic" }), {
    state: "match", failedFields: [], missingFields: []
  });
});

test("known wrong generation make, model, or year is a mismatch even with missing facts", () => {
  const profile = { filtersJson: { generation: civicGeneration } };
  for (const titleRaw of ["2013 Toyota Corolla", "2013 Honda Accord", "2018 Honda Civic", "2018 sedan"]) {
    assert.deepEqual(qualifyProfile(profile, { titleRaw }), {
      state: "mismatch", failedFields: ["generation"], missingFields: []
    });
  }
});

test("BMW 3 Series keeps numbered model and year boundary matching", () => {
  const profile = { filtersJson: {
    generation: { make: "BMW", model: "3 Series", yearFrom: 1999, yearTo: 2006 }
  } };
  for (const titleRaw of ["1999 BMW 328i", "2006 BMW 330xi", "2004 BMW 3 Series"]) {
    assert.deepEqual(qualifyProfile(profile, { titleRaw }), {
      state: "match", failedFields: [], missingFields: []
    });
  }
  assert.deepEqual(qualifyProfile(profile, { titleRaw: "2004 BMW M3" }), {
    state: "mismatch", failedFields: ["generation"], missingFields: []
  });
  assert.deepEqual(qualifyProfile(profile, { titleRaw: "2007 BMW 328i" }), {
    state: "mismatch", failedFields: ["generation"], missingFields: []
  });
});

test("structured generation facts qualify without a descriptive card title", () => {
  assert.deepEqual(qualifyProfile({ filtersJson: { generation: civicGeneration } }, {
    titleRaw: "Marketplace listing",
    vehicleAttributes: { make: "Honda", model: "Civic", year: 2013 }
  }), { state: "match", failedFields: [], missingFields: [] });
});

test("unconfigured filters impose no qualification requirements", () => {
  assert.deepEqual(qualifyProfile({}, { titleRaw: "Marketplace listing", mileage: null }), {
    state: "match", failedFields: [], missingFields: []
  });
});

test("manual windows and missing transmission stay unverified instead of mismatching", () => {
  const profile = { filtersJson: { transmission: "manual" } };
  assert.deepEqual(qualifyProfile(profile, {
    titleRaw: "2019 Honda Civic with manual windows",
    descriptionRaw: "Power locks, crank windows, owner's manual included."
  }), { state: "unknown", failedFields: [], missingFields: ["transmission"] });
  assert.deepEqual(qualifyProfile(profile, { titleRaw: "2019 Honda Civic" }), {
    state: "unknown", failedFields: [], missingFields: ["transmission"]
  });
});
