import test from "node:test";
import assert from "node:assert/strict";
import { matchesProfileFilters } from "../src/syncEngine.js";

const listing = {
  titleRaw: "2013 Honda Civic Si",
  descriptionRaw: "Clean title. 70,000 miles. Manual transmission. Aftermarket exhaust and coilovers.",
  priceRaw: "$12,000"
};

test("saved search filters match listing details and reject missing claims", () => {
  assert.equal(matchesProfileFilters({ filtersJson: { cleanTitleOnly: true, modifiedOnly: true, transmission: "manual", yearMin: 2010, yearMax: 2015, maxMileage: 80000 } }, listing), true);
  assert.equal(matchesProfileFilters({ filtersJson: { cleanTitleOnly: true } }, { ...listing, descriptionRaw: "70,000 miles. Manual transmission." }), false);
  assert.equal(matchesProfileFilters({ filtersJson: { modifiedOnly: true } }, { ...listing, descriptionRaw: "Clean title. 70,000 miles." }), false);
});

test("generation search requires the chosen model and its model-year range", () => {
  const profile = { filtersJson: { generation: { make: "BMW", model: "M3", yearFrom: 2008, yearTo: 2013 } } };
  assert.equal(matchesProfileFilters(profile, { titleRaw: "2011 BMW M3 Coupe", descriptionRaw: "Manual" }), true);
  assert.equal(matchesProfileFilters(profile, { titleRaw: "2011 BMW 335i", descriptionRaw: "" }), false);
  assert.equal(matchesProfileFilters(profile, { titleRaw: "2017 BMW M3", descriptionRaw: "" }), false);
});
