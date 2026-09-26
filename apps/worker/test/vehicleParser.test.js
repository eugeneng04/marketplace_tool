import test from "node:test";
import assert from "node:assert/strict";
import { parseVehicleListing } from "../src/vehicleParser.js";

function mileageOf(title, description) {
  const parsed = parseVehicleListing({
    titleRaw: title,
    descriptionRaw: description,
    priceRaw: null
  });
  return parsed.attributes.mileage ?? null;
}

test("mileage reads precise odometer text from descriptions", () => {
  assert.equal(mileageOf("2008 Porsche 911 Turbo", "2008 Porsche 911 Convertible 48000.miles"), 48000);
  assert.equal(
    mileageOf("2007 Porsche Cayman S", "Selling my 2007 Porsche Cayman S with approximately 85,433 miles."),
    85433
  );
  assert.equal(mileageOf("2013 Scion FR-S", "A little over 171,000 miles, runs great."), 171000);
  assert.equal(mileageOf("Car", "Mileage: 95400, clean title."), 95400);
  assert.equal(mileageOf("Car", "Odometer reads 80k, garage kept."), 80000);
  assert.equal(mileageOf("1985 Porsche 928", "1985 porsche 928\n163k Miles\nV8 engine"), 163000);
});

test("mileage ignores prices and part numbers", () => {
  assert.equal(
    mileageOf("1976 Porsche 911s targa", "I am asking close to 30k. Adoption is going to cost close to 65k."),
    null
  );
  assert.equal(mileageOf("2013 Scion FR-S", "Clean title, no accidents."), null);
});

test("structured Marketplace vehicle mileage takes precedence over missing description mileage", () => {
  const parsed = parseVehicleListing({
    titleRaw: "1997 BMW M3",
    descriptionRaw: "Clean title; mechanically sound.",
    mileage: 123456
  });
  assert.equal(parsed.attributes.mileage, 123456);
  assert.equal(parsed.evidence.find((entry) => entry.field === "mileage")?.confidence, 0.95);
});

test("structured Marketplace transmission is parsed and arbitrary metadata is retained", () => {
  const parsed = parseVehicleListing({
    titleRaw: "2017 Subaru BRZ",
    descriptionRaw: "Clean title.",
    vehicleAttributes: { mileage: 92000, transmission: "manual", exterior_color: "Blue" }
  });
  assert.equal(parsed.attributes.mileage, 92000);
  assert.equal(parsed.attributes.transmission, "manual");
  assert.deepEqual(parsed.attributes.marketplaceAttributes, { mileage: 92000, transmission: "manual", exterior_color: "Blue" });
  assert.equal(parsed.evidence.find((entry) => entry.field === "transmission")?.confidence, 0.95);
});
