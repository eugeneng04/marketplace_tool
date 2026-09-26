import test from "node:test";
import assert from "node:assert/strict";
import { compMedian, validateCompInput } from "../src/comps.js";

test("comp input requires a known source and positive sold price", () => {
  assert.throws(() => validateCompInput({ source: "ebay", soldPrice: 100 }), /source must be one of/);
  assert.throws(() => validateCompInput({ source: "bat" }), /soldPrice must be a positive number/);
  assert.throws(() => validateCompInput({ source: "bat", soldPrice: -5 }), /soldPrice must be a positive number/);
  assert.throws(() => validateCompInput({ source: "bat", soldPrice: 100, url: "not-a-url" }), /url must start with/);
  assert.throws(() => validateCompInput({ source: "bat", soldPrice: 100, soldAt: "yesterday-ish" }), /soldAt must be a valid date/);
});

test("comp input normalizes bat and cars_and_bids results", () => {
  const comp = validateCompInput({
    source: "BaT",
    title: " 2013 Scion FR-S — sold ",
    url: "https://bringatrailer.com/listing/xyz/",
    soldPrice: "12500.4",
    soldAt: "2026-08-01"
  });
  assert.equal(comp.source, "bat");
  assert.equal(comp.title, "2013 Scion FR-S — sold");
  assert.equal(comp.soldPrice, 12500);
  assert.equal(comp.soldAt, new Date("2026-08-01").toISOString());
});

test("comp median ignores invalid prices", () => {
  assert.equal(compMedian([]), null);
  assert.equal(compMedian([{ sold_price: 10000 }, { sold_price: 20000 }]), 15000);
  assert.equal(compMedian([{ sold_price: 9000 }, { soldPrice: 11000 }, { sold_price: null }]), 10000);
});

test("mileage parses BaT and Cars & Bids formats", async () => {
  const { parseMileage, parseTransmission } = await import("../src/comps.js");
  assert.equal(parseMileage("Turbocharged, 28k-Mile 2013 Scion FR-S 6-Speed"), 28000);
  assert.equal(parseMileage("60,500 Miles"), 60500);
  assert.equal(parseMileage("8,500 miles"), 8500);
  assert.equal(parseMileage("12,300 km"), 7643);
  assert.equal(parseMileage("2.0-liter flat-four"), null);
  assert.equal(parseMileage(""), null);
  assert.equal(parseTransmission("6-Speed Manual"), "manual");
  assert.equal(parseTransmission("8-Speed Automatic"), "automatic");
  assert.equal(parseTransmission("6-Speed"), "unknown");
});

test("price trend fits a line and positions the listing", async () => {
  const { priceTrend } = await import("../src/comps.js");
  assert.equal(priceTrend([], {}), null);
  assert.equal(priceTrend([{ mileage: 10000, sold_price: 20000 }], {}), null);
  const comps = [
    { mileage: 20000, sold_price: 18000 },
    { mileage: 40000, sold_price: 16000 },
    { mileage: 60000, sold_price: 14000 },
    { mileage: 80000, sold_price: 12000 }
  ];
  const trend = priceTrend(comps, { mileage: 50000, price: 14500 });
  assert.equal(trend.n, 4);
  assert.ok(trend.slope < 0);
  assert.equal(trend.predicted, 15000);
  assert.equal(trend.diff, -500);
  assert.ok(Math.abs(trend.diffPct + 1 / 30) < 0.001);
  const noListing = priceTrend(comps, {});
  assert.equal(noListing.predicted, null);
  assert.equal(noListing.diff, null);
});

test("similar mileage comps use a readable absolute-or-relative band", async () => {
  const { similarMileageComps } = await import("../src/comps.js");
  const comps = [{ mileage: 40000 }, { mileage: 60000 }, { mileage: 90000 }, { mileage: null }];
  const result = similarMileageComps(comps, 50000);
  assert.deepEqual(result.window, { from: 35000, to: 65000 });
  assert.deepEqual(result.comps, comps.slice(0, 2));
  assert.deepEqual(similarMileageComps(comps, null), { comps: [], window: null });
});

test("mileage tolerates punctuation and rejects owner-manual traps", async () => {
  const { parseMileage, parseTransmission } = await import("../src/comps.js");
  assert.equal(parseMileage("2008 Porsche 911 Convertible 48000.miles"), 48000);
  assert.equal(parseTransmission("Offered with the owner's manual and tools"), "unknown");
  assert.equal(parseTransmission("Shifting is through a six-speed manual transmission"), "manual");
});
