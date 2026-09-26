import test from "node:test";
import assert from "node:assert/strict";
import {
  batSlugCandidates,
  extractEmbeddedJson,
  fetchBatCompsForListing,
  fetchCandbCompsForListing,
  normalizeCandbRecord,
  parseBatModelPage
} from "../src/auctionComps.js";

const FIXTURE_HTML = `
<html><body><script id='bat-theme-auctions-completed-initial-data'>
var auctionsCompletedInitialData = {"base_filter":{"keyword_pages":[1]},"items":[
{"active":false,"title":"Original-Owner, Supercharged 2014 Scion FR-S 6-Speed","url":"https://bringatrailer.com/listing/2014-scion-fr-s-4/","current_bid":12500,"sold_text":"Sold for USD $12,500 <span> on 5\\/26\\/2026 <\\/span>","sold_text_timestamp":1779826698,"thumbnail_url":"https://example.com/a.jpg","noreserve":true},
{"active":false,"title":"2013 Scion FR-S 6-Speed","url":"https://bringatrailer.com/listing/2013-scion-fr-s-9/","current_bid":9400,"sold_text":"Bid to USD $9,400 <span> on 8\\/11\\/2025 <\\/span>","sold_text_timestamp":1754851200,"thumbnail_url":"https://example.com/b.jpg","noreserve":false},
{"active":false,"title":"No reserve 2015 Scion FR-S; has }; tricky brace","url":"https://bringatrailer.com/listing/2015-scion-fr-s-1/","current_bid":9600,"sold_text":"Sold for USD $9,600 <span> on 4\\/5\\/2025 <\\/span>","sold_text_timestamp":1743811200,"thumbnail_url":"https://example.com/c.jpg","noreserve":false}
]};
</script></body></html>
`;

test("embedded JSON extractor survives braces inside strings", () => {
  const raw = extractEmbeddedJson(FIXTURE_HTML, "auctionsCompletedInitialData");
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.items.length, 3);
});

test("BaT parser keeps only completed sales", () => {
  const { comps, diagnostics } = parseBatModelPage(FIXTURE_HTML);
  assert.equal(diagnostics.totalItems, 3);
  assert.equal(diagnostics.skippedUnsold, 1);
  assert.equal(comps.length, 2);
  assert.equal(comps[0].source, "bat");
  assert.equal(comps[0].soldPrice, 12500);
  assert.equal(comps[0].url, "https://bringatrailer.com/listing/2014-scion-fr-s-4/");
  assert.equal(comps[0].soldAt, new Date(1779826698 * 1000).toISOString());
});

test("BaT parser reports pages without embedded data", () => {
  const { comps, diagnostics } = parseBatModelPage("<html><body>no data here</body></html>");
  assert.deepEqual(comps, []);
  assert.ok(diagnostics.reason);
});

test("slug candidates cover model pages and base-model fallback", () => {
  assert.deepEqual(batSlugCandidates({ make: "Scion", model: "FR-S" }), ["scion/fr-s", "scion/fr"]);
  assert.deepEqual(batSlugCandidates({ make: "honda", model: "civic" }), ["honda/civic"]);
  assert.ok(batSlugCandidates({ make: null, model: null, query: "civic si" }).includes("civic/si"));
});

test("listing fetch tries slugs and normalizes sold results", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === "https://bringatrailer.com/scion/fr-s/") {
      return { ok: true, status: 200, text: async () => FIXTURE_HTML };
    }
    return { ok: false, status: 404, text: async () => "" };
  };
  const { comps, diagnostics } = await fetchBatCompsForListing(
    { title_raw: "2014 Scion FR-S", parsed_attributes_json: { make: "scion", model: "fr-s" } },
    { fetchImpl }
  );
  assert.equal(comps.length, 2);
  assert.equal(diagnostics.slug, "scion/fr-s");
  assert.deepEqual(calls, [
    "https://bringatrailer.com/scion/fr-s/",
    "https://bringatrailer.com/scion/fr-s/?pagedl=2",
    "https://bringatrailer.com/subaru/brz/",
    "https://bringatrailer.com/toyota/86/"
  ]);
});

test("911 matching requires a model year, dropping parts listings", async () => {
  const { matchCompsToListing } = await import("../src/auctionComps.js");
  const listing = { title_raw: "2003 Porsche 911 Carrera 2 Coupe 2D" };
  const { matched, skippedOutOfWindow } = matchCompsToListing(listing, [
    { title: "2002 Porsche 911 Carrera", soldPrice: 30000 },
    { title: "Recaro Sport Seats for Porsche 911", soldPrice: 5200 },
    { title: "Porsche 997 Sport Bucket Seats", soldPrice: 17250 }
  ]);
  assert.deepEqual(matched.map((c) => c.soldPrice), [30000]);
  assert.equal(skippedOutOfWindow.length, 2);
});
test("C&B records keep only completed sales with a valid price", () => {
  const sold = normalizeCandbRecord({
    id: "3v2N4g1j",
    title: "2005 Honda Civic Si Hatchback",
    sale_amount: 12500,
    auction_end: "2026-09-21T17:12:00.000+00:00",
    status: "sold"
  });
  assert.equal(sold.source, "cars_and_bids");
  assert.equal(sold.soldPrice, 12500);
  assert.equal(sold.url, "https://carsandbids.com/auctions/3v2N4g1j/2005-honda-civic-si-hatchback");
  assert.equal(normalizeCandbRecord({ status: "reserve_not_met", sale_amount: 100 }), null);
  assert.equal(normalizeCandbRecord({ status: "sold", sale_amount: 0 }), null);
  assert.equal(
    normalizeCandbRecord({ id: "x", title: "2016 Scion FR-S", sale_amount: 10250, status: "sold_after" }).soldPrice,
    10250
  );
});

test("C&B signature matches the site's guest scheme", async () => {
  const { candbSignature } = await import("../src/auctionComps.js");
  const sig = candbSignature({ secret: "s", suffix: "x", timestamp: "123", endpoint: "autos/auctions" });
  assert.match(sig, /^[0-9a-f]{40}$/);
});

test("C&B fetch searches closed auctions and normalizes sold results", async () => {
  const calls = [];
  const signedGet = async (endpoint, params) => {
    calls.push({ endpoint, params });
    return {
      total: 2,
      auctions: [
        { id: "a1", title: "2016 Scion FR-S", sale_amount: 10250, auction_end: "2026-08-28T00:00:00.000+00:00", status: "sold" },
        { id: "b2", title: "2013 Subaru BRZ Limited", sale_amount: null, auction_end: "2026-07-31T00:00:00.000+00:00", status: "reserve_not_met" }
      ]
    };
  };
  const { comps, diagnostics } = await fetchCandbCompsForListing(
    { title_raw: "2014 Scion FR-S", parsed_attributes_json: {} },
    { signedGet }
  );
  assert.equal(comps.length, 1);
  assert.equal(comps[0].soldPrice, 10250);
  assert.equal(comps[0].url, "https://carsandbids.com/auctions/a1/2016-scion-fr-s");
  assert.equal(diagnostics.totalRecords, 6);
  assert.equal(calls[0].endpoint, "autos/auctions");
  assert.equal(calls[0].params.status, "closed");
  assert.match(calls[0].params.search, /scion/i);
});

test("FR-S auction lookup includes BRZ and Toyota 86 platform comps", async () => {
  const searches = [];
  const signedGet = async (_endpoint, params) => {
    searches.push(params.search);
    const id = params.search.includes("BRZ") ? "brz" : params.search.includes("Toyota") ? "toyota86" : "frs";
    const title = params.search.includes("BRZ") ? "2015 Subaru BRZ Limited" : params.search.includes("Toyota") ? "2016 Toyota 86" : "2014 Scion FR-S";
    return { total: 1, auctions: [{ id, title, sale_amount: 10000, status: "sold", mileage: "52,000 miles" }] };
  };
  const { comps } = await fetchCandbCompsForListing(
    { title_raw: "2014 Scion FR-S", parsed_attributes_json: {} },
    { signedGet }
  );
  assert.deepEqual(searches, ["Scion FR-S", "Subaru BRZ", "Toyota 86"]);
  assert.deepEqual(comps.map((comp) => comp.title), ["2014 Scion FR-S", "2015 Subaru BRZ Limited", "2016 Toyota 86"]);
});

test("911 listings resolve to their generation", async () => {
  const { generationFor, matchCompsToListing } = await import("../src/auctionComps.js");
  assert.deepEqual(generationFor({ title_raw: "2003 Porsche 911 Carrera" }), { code: "996", from: 1999, to: 2004, label: "996 generation" });
  assert.deepEqual(generationFor({ title_raw: "2008 Porsche 911 Carrera" }).code, "997");
  assert.deepEqual(generationFor({ title_raw: "2015 Porsche 911 Carrera" }).code, "991");
  assert.deepEqual(generationFor({ title_raw: "2022 Porsche 911 Carrera" }).code, "992");
  assert.equal(generationFor({ title_raw: "2014 Scion FR-S" }), null);

  const listing = { title_raw: "2003 Porsche 911 Carrera 2 Coupe 2D" };
  const comps = [
    { title: "2001 Porsche 911 Carrera", soldPrice: 30000 },
    { title: "2004 Porsche 911 Carrera 4S", soldPrice: 44000 },
    { title: "2006 Porsche 911 Carrera S", soldPrice: 45000 },
    { title: "2022 Porsche 911 Carrera", soldPrice: 130000 },
    { title: "Porsche 911 Carrera", soldPrice: 50000 }
  ];
  const { generation, matched, skippedOutOfWindow } = matchCompsToListing(listing, comps);
  assert.equal(generation.code, "996");
  assert.deepEqual(matched.map((c) => c.soldPrice), [30000, 44000]);
  assert.deepEqual(skippedOutOfWindow.map((c) => c.soldPrice), [45000, 130000, 50000]);
});

test("comp years are found anywhere in the title", async () => {
  const { compTitleYear } = await import("../src/auctionComps.js");
  assert.equal(compTitleYear("34-Year-Owned 2002 Porsche 911 Carrera"), 2002);
  assert.equal(compTitleYear("16k-Mile 2002 Porsche 911 Carrera 4S"), 2002);
  assert.equal(compTitleYear("2003 Porsche 911 Carrera"), 2003);
  assert.equal(compTitleYear("Porsche 911 Carrera"), null);
});

test("model-token filter drops wrong-model results but keeps platform spellings", async () => {
  const { compMatchesModel } = await import("../src/auctionComps.js");
  assert.equal(compMatchesModel({ title: "2002 Porsche 911 Carrera" }, "911"), true);
  assert.equal(compMatchesModel({ title: "1961 Lotus Elite Series II" }, "911"), false);
  assert.equal(compMatchesModel({ title: "2016 Scion FR-S" }, "FR-S"), true);
  assert.equal(compMatchesModel({ title: "2016 Scion FRS" }, "FR-S"), true);
  assert.equal(compMatchesModel({ title: "1998 Honda Civic Type R" }, "civic"), true);
  assert.equal(compMatchesModel({ title: "2006 Honda Civic Si Coupe" }, null), true);
  assert.equal(compMatchesModel({ title: "2007 Mazda MX-5 Miata" }, "miata"), true);
  assert.equal(compMatchesModel({ title: "2016 Subaru BRZ Limited" }, "FR-S"), true);
  assert.equal(compMatchesModel({ title: "2022 Toyota GR86 Premium" }, "BRZ"), true);
  assert.equal(compMatchesModel({ title: "2022 Toyota GR86 Premium" }, "FR-S"), true);
  assert.equal(compMatchesModel({ title: "1986 Toyota Supra" }, "86"), false);
});

test("non-911 comps stay within five model years of the listing", async () => {
  const { matchCompsToListing, yearWindowFor } = await import("../src/auctionComps.js");
  const listing = { title_raw: "2013 Scion FR-S Coupe 2D" };
  assert.deepEqual(yearWindowFor(listing), { from: 2008, to: 2018 });
  const { generation, matched, skippedOutOfWindow } = matchCompsToListing(listing, [
    { title: "2014 Scion FR-S", soldPrice: 12500 },
    { title: "2016 Scion FR-S Release Series 2.0", soldPrice: 11200 },
    { title: "2023 Subaru BRZ Limited", soldPrice: 34250 },
    { title: "Recaro Sport Seats", soldPrice: 5000 }
  ]);
  assert.equal(generation, null);
  assert.deepEqual(matched.map((c) => c.soldPrice), [12500, 11200]);
  assert.equal(skippedOutOfWindow.length, 2);
});

test("listings without a year keep all comps", async () => {
  const { matchCompsToListing } = await import("../src/auctionComps.js");
  const { matched } = matchCompsToListing({ title_raw: "Scion FR-S Coupe" }, [
    { title: "2014 Scion FR-S", soldPrice: 1 }
  ]);
  assert.equal(matched.length, 1);
});

test("C&B transmission codes map to gearbox labels", async () => {
  const { normalizeCandbTransmission } = await import("../src/auctionComps.js");
  assert.equal(normalizeCandbTransmission({ transmission: 2 }, "2023 Subaru BRZ Premium"), "manual");
  assert.equal(normalizeCandbTransmission({ transmission: 1 }, "2023 Tesla Model 3 RWD"), "automatic");
  assert.equal(normalizeCandbTransmission({}, "6-Speed Manual"), "manual");
  assert.equal(normalizeCandbTransmission({}, "8-Speed Automatic"), "automatic");
});
