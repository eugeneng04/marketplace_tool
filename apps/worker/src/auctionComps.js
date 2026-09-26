import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { parseMileage, parseTransmission } from "./comps.js";

const BAT_BASE = "https://bringatrailer.com";
const BAT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

function slugify(value) {
  return `${value ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Balanced-brace JSON extractor: BaT embeds `var auctionsCompletedInitialData = {...};`
// and values contain escaped HTML, so a naive `.*?}` regex can cut early.
export function extractEmbeddedJson(html, varName) {
  const marker = `var ${varName} =`;
  const start = html.indexOf(marker);
  if (start === -1) {
    return null;
  }
  const open = html.indexOf("{", start + marker.length);
  if (open === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(open, i + 1);
      }
    }
  }
  return null;
}

function stripTags(value) {
  return `${value ?? ""}`.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function parseUnixTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return new Date(numeric * 1000).toISOString();
}

export function parseBatModelPage(html) {
  const raw = extractEmbeddedJson(html, "auctionsCompletedInitialData");
  if (!raw) {
    return { comps: [], diagnostics: { reason: "no embedded results data found" } };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { comps: [], diagnostics: { reason: `embedded results JSON unparseable: ${error.message}` } };
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const comps = [];
  let skippedUnsold = 0;
  for (const item of items) {
    const soldText = stripTags(item.sold_text);
    // Only completed sales count as comps. "Bid to $X" means reserve not met.
    if (!/^sold for\b/i.test(soldText)) {
      skippedUnsold += 1;
      continue;
    }
    const soldPrice = Number(item.current_bid);
    if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
      continue;
    }
    comps.push({
      source: "bat",
      title: item.title ? `${item.title}`.slice(0, 300) : null,
      url: item.url ?? null,
      soldPrice: Math.round(soldPrice),
      soldAt: parseUnixTimestamp(item.sold_text_timestamp ?? item.timestamp_end),
      mileage: parseMileage(`${item.title ?? ""} ${item.excerpt ?? ""}`),
      transmission: parseTransmission(`${item.title ?? ""} ${item.excerpt ?? ""}`),
      imageUrl: item.thumbnail_url ?? null,
      noReserve: item.noreserve === true
    });
  }

  return { comps, diagnostics: { totalItems: items.length, sold: comps.length, skippedUnsold } };
}

// Candidate BaT model pages, most specific first. BaT groups trims under the
// base model page (e.g. /honda/civic/ covers the Si), so fall back to it.
export function batSlugCandidates({ make, model, query }) {
  const slugs = [];
  const push = (makeSlug, modelSlug) => {
    if (makeSlug && modelSlug) {
      const slug = `${makeSlug}/${modelSlug}`;
      if (!slugs.includes(slug)) {
        slugs.push(slug);
      }
    }
  };

  const cleanMake = slugify(make);
  const cleanModel = slugify(model);
  push(cleanMake, cleanModel);
  if (cleanModel) {
    const firstToken = cleanModel.split("-")[0];
    push(cleanMake, firstToken);
  }

  // Fall back to tokens from a free-text query like "civic si".
  const tokens = `${query ?? ""}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length >= 2) {
    push(slugify(tokens[0]), slugify(tokens.slice(1).join("-")));
    push(slugify(tokens[0]), slugify(tokens[1]));
  } else if (tokens.length === 1) {
    push(cleanMake || slugify(tokens[0]), cleanModel);
  }

  return slugs;
}

export function inferMakeModel(listing) {
  const attrs = listing?.parsed_attributes_json ?? {};
  let make = attrs.make ?? null;
  let model = attrs.model ?? null;

  if (!make || !model) {
    const title = `${listing?.title_raw ?? listing?.title ?? ""}`;
    const match = title.match(/^\s*(\d{4})?\s*([A-Za-z]+)\s+([A-Za-z0-9][A-Za-z0-9-]*)/);
    if (match) {
      make = make ?? match[2];
      model = model ?? match[3];
    }
  }

  return { make, model };
}

function findYear(value) {
  const match = `${value ?? ""}`.match(/\b(19\d{2}|20\d{2})\b/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  return year >= 1900 && year <= 2100 ? year : null;
}

export function listingYear(listing) {
  const attrs = listing?.parsed_attributes_json ?? {};
  const fromAttrs = Number(attrs.year);
  if (Number.isFinite(fromAttrs) && fromAttrs >= 1900 && fromAttrs <= 2100) {
    return Math.round(fromAttrs);
  }
  const title = `${listing?.title_raw ?? listing?.title ?? ""}`;
  const leading = title.match(/^\s*(\d{4})\b/);
  if (leading) {
    const year = Number(leading[1]);
    if (year >= 1900 && year <= 2100) {
      return year;
    }
  }
  return findYear(title);
}

export function compTitleYear(title) {
  return findYear(title);
}

function normalizeToken(value) {
  return `${value ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const MODEL_ALIASES = {
  miata: ["mx5"],
  mx5: ["miata"],
  frs: ["brz", "86", "gr86"],
  brz: ["frs", "86", "gr86"],
  "86": ["frs", "brz", "gr86"],
  gr86: ["frs", "brz", "86"]
};

// Auction search is loose (C&B tokenizes OR-style), so require the model token
// in the comp title. Normalization makes "FR-S" match "FRS".
export function compMatchesModel(comp, model) {
  const cleanModel = normalizeToken(model);
  if (!cleanModel) {
    return true;
  }
  const title = `${comp.title ?? ""}`.toLowerCase();
  const haystack = normalizeToken(title);
  const tokens = new Set(title.split(/[^a-z0-9]+/).filter(Boolean));
  const matchesToken = (token) => token.length <= 2 ? tokens.has(token) : haystack.includes(token);
  if (matchesToken(cleanModel)) {
    return true;
  }
  return (MODEL_ALIASES[cleanModel] ?? []).some(matchesToken);
}

function relatedBatSlugs(model) {
  const normalized = normalizeToken(model);
  const family = {
    frs: [["subaru", "brz"], ["toyota", "86"]],
    brz: [["scion", "fr-s"], ["toyota", "86"]],
    "86": [["scion", "fr-s"], ["subaru", "brz"]],
    gr86: [["scion", "fr-s"], ["subaru", "brz"]]
  };
  return (family[normalized] ?? []).map(([make, relatedModel]) => `${make}/${slugify(relatedModel)}`);
}

// 911 generations barely overlap at the boundaries, so compare within a
// generation — a 996 and a 992 are different cars at different prices.
const PORSCHE_911_GENERATIONS = [
  { code: "996", from: 1999, to: 2004 },
  { code: "997", from: 2005, to: 2011 },
  { code: "991", from: 2012, to: 2018 },
  { code: "992", from: 2019, to: 2100 }
];

export function generationFor(listing) {
  const { make, model } = inferMakeModel(listing);
  const year = listingYear(listing);
  if (`${make ?? ""}`.toLowerCase() !== "porsche" || `${model ?? ""}`.toLowerCase() !== "911" || year === null) {
    return null;
  }
  const gen = PORSCHE_911_GENERATIONS.find((entry) => year >= entry.from && year <= entry.to);
  return gen ? { ...gen, label: `${gen.code} generation` } : null;
}

// Keep comps like-for-like.
// - 911s must share the listing's generation (996/997/991/992), since model
//   pages span generations at very different prices — and sweep up parts
//   listings (seats, engines), which carry no model year.
// - Other cars keep comps within YEAR_WINDOW years of the listing's year, for
//   the same reason (a 2023 BRZ is not a comp for a 2013 FR-S).
// - When the listing's own year is unknown, everything is kept.
const YEAR_WINDOW = 5;

export function yearWindowFor(listing) {
  const year = listingYear(listing);
  return year === null ? null : { from: year - YEAR_WINDOW, to: year + YEAR_WINDOW };
}

export function matchCompsToListing(listing, comps = []) {
  const generation = generationFor(listing);
  if (generation) {
    const matched = [];
    const skippedOutOfWindow = [];
    for (const comp of comps) {
      const year = compTitleYear(comp.title);
      if (year !== null && year >= generation.from && year <= generation.to) {
        matched.push(comp);
      } else {
        skippedOutOfWindow.push(comp);
      }
    }
    return { generation, yearWindow: { from: generation.from, to: generation.to }, matched, skippedOutOfWindow };
  }

  const window = yearWindowFor(listing);
  if (!window) {
    return { generation: null, yearWindow: null, matched: [...comps], skippedOutOfWindow: [] };
  }
  const matched = [];
  const skippedOutOfWindow = [];
  for (const comp of comps) {
    const year = compTitleYear(comp.title);
    if (year !== null && year >= window.from && year <= window.to) {
      matched.push(comp);
    } else {
      skippedOutOfWindow.push(comp);
    }
  }
  return { generation: null, yearWindow: window, matched, skippedOutOfWindow };
}

export async function fetchBatCompsForListing(listing, { limit = 12, fetchImpl = fetch } = {}) {
  const { make, model } = inferMakeModel(listing);
  const candidates = batSlugCandidates({ make, model, query: listing?.title_raw ?? "" });
  if (candidates.length === 0) {
    return { comps: [], diagnostics: { reason: "could not infer make/model for BaT lookup" } };
  }

  let lastError = null;
  // BaT model pages rotate; walk result pages per slug for coverage.
  for (const slug of candidates) {
    const seen = new Set();
    const merged = [];
    for (let page = 1; page <= 8; page += 1) {
      const url = page === 1 ? `${BAT_BASE}/${slug}/` : `${BAT_BASE}/${slug}/?pagedl=${page}`;
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            "user-agent": BAT_USER_AGENT,
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9"
          }
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : `${error}`;
        break;
      }
      if (response.status === 404) {
        lastError = `BaT page not found: ${slug}`;
        break;
      }
      if (!response.ok) {
        lastError = `BaT HTTP ${response.status} for ${slug}`;
        break;
      }
      const html = await response.text();
      const parsed = parseBatModelPage(html);
      if (parsed.comps.length === 0) {
        if (page === 1 && parsed.diagnostics?.reason) {
          lastError = parsed.diagnostics.reason;
        }
        break;
      }
      let fresh = 0;
      for (const comp of parsed.comps) {
        if (comp.url && !seen.has(comp.url)) {
          seen.add(comp.url);
          merged.push(comp);
          fresh += 1;
        }
      }
      lastError = null;
      if (fresh === 0 || merged.length >= 40) {
        break;
      }
    }
    if (merged.length === 0) {
      continue;
    }
    const relatedSlugs = relatedBatSlugs(model).filter((relatedSlug) => relatedSlug !== slug);
    const aliasFailures = [];
    for (const relatedSlug of relatedSlugs) {
      try {
        const response = await fetchImpl(`${BAT_BASE}/${relatedSlug}/`, {
          headers: {
            "user-agent": BAT_USER_AGENT,
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9"
          }
        });
        if (!response.ok) continue;
        const related = parseBatModelPage(await response.text());
        for (const comp of related.comps) {
          if (comp.url && !seen.has(comp.url)) {
            seen.add(comp.url);
            merged.push(comp);
          }
        }
      } catch (error) {
        aliasFailures.push(error instanceof Error ? error.message : `${error}`);
      }
    }
    return {
      comps: merged.slice(0, Math.max(1, Math.min(limit, 40))),
      diagnostics: { slug, pagesMerged: true, relatedSlugs, aliasFailures }
    };
  }

  return { comps: [], diagnostics: { reason: lastError ?? "no BaT model page matched", tried: candidates } };
}

const CAND_B_API = "https://sbffr.carsandbids.com/api/auctions";

// --- Cars & Bids full archive (signed v2 API) ---
// C&B pages are empty shells; past results come from a signed JSON API:
//   1. GET /v1/auth/ti_ni (guest bootstrap) -> {__farsce, _gi_ase} + session cookie
//   2. signature = sha1hex(`${secret}_${timestamp}_/v2/${endpoint}${suffix}`)
//   3. GET /v2/<endpoint>?<params>&timestamp=&signature= with session cookies
// Node's fetch is Cloudflare-challenged from servers, while curl passes, so
// requests go through curl (same precedent as the Facebook cookie helpers).
const CAND_B_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const CAND_B_TINI_URL = "https://carsandbids.com/v1/auth/ti_ni";
const CAND_B_API_BASE = "https://carsandbids.com/v2";

function curlJson(url, { jar, saveJar } = {}) {
  const args = [
    "-s", "-m", "30",
    "-A", CAND_B_UA,
    "-H", "Accept: application/json",
    "-H", "Accept-Language: en-US,en;q=0.9",
    "-H", "Cache-Control: no-cache"
  ];
  if (saveJar) {
    args.push("-c", saveJar);
  }
  if (jar) {
    args.push("-b", jar);
  } else {
    args.push(
      "-H", "Content-Type: application/json",
      "-H", "Origin: https://carsandbids.com",
      "-H", "Referer: https://carsandbids.com/past-auctions/"
    );
  }
  args.push(url);
  const raw = execFileSync("curl", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(raw);
}

function candbJarPath() {
  return join(tmpdir(), `candb_cookies_${process.pid}_${randomUUID()}.txt`);
}

export function candbSignature({ secret, suffix, timestamp, endpoint }) {
  return crypto
    .createHash("sha1")
    .update(`${secret}_${timestamp}_/v2/${endpoint}${suffix}`)
    .digest("hex");
}

export async function candbSignedGet(endpoint, params = {}, { curlImpl = curlJson } = {}) {
  const jar = candbJarPath();
  try {
    const tini = await curlImpl(CAND_B_TINI_URL, { saveJar: jar });
    if (!tini?.__farsce || !tini?._gi_ase) {
      throw new Error("Cars & Bids guest bootstrap failed.");
    }
    const timestamp = Date.now().toString();
    const signature = candbSignature({ secret: tini.__farsce, suffix: tini._gi_ase, timestamp, endpoint });
    const query = new URLSearchParams({ ...params, timestamp, signature });
    return await curlImpl(`${CAND_B_API_BASE}/${endpoint}?${query.toString()}`, { jar });
  } finally {
    try {
      unlinkSync(jar);
    } catch {
      // Non-fatal cleanup failure.
    }
  }
}

export function candbAuctionUrl(record) {
  if (!record?.id) {
    return null;
  }
  const slug = slugify(record.title);
  return slug
    ? `https://carsandbids.com/auctions/${record.id}/${slug}`
    : `https://carsandbids.com/auctions/${record.id}`;
}

const CAND_B_SOLD_STATUSES = new Set(["sold", "sold_after"]);

// C&B transmission codes: 1 = automatic/single-speed, 2 = manual.
export function normalizeCandbTransmission(record, text) {
  const code = Number(record?.transmission);
  if (code === 2) {
    return "manual";
  }
  if (code === 1) {
    return "automatic";
  }
  return parseTransmission(text);
}

export function normalizeCandbRecord(record) {
  if (!record || !CAND_B_SOLD_STATUSES.has(record.status)) {
    return null;
  }
  const soldPrice = Number(record.sale_amount ?? record.high_bid);
  if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
    return null;
  }
  const end = record.auction_end ? new Date(record.auction_end) : null;
  const title = record.title ? `${record.title}`.slice(0, 300) : null;
  return {
    source: "cars_and_bids",
    title,
    url: record.auction_url ?? candbAuctionUrl(record),
    soldPrice: Math.round(soldPrice),
    soldAt: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
    mileage: parseMileage(record.mileage) ?? parseMileage(title),
    transmission: normalizeCandbTransmission(record, `${record.title ?? ""} ${record.subtitle ?? ""}`),
    imageUrl: null,
    noReserve: null
  };
}

// Full past-results archive via the signed API (status=closed), newest first.
// Falls back to title tokens when make/model can't be inferred.
export async function fetchCandbCompsForListing(listing, { limit = 12, signedGet = candbSignedGet } = {}) {
  const { make, model } = inferMakeModel(listing);
  const title = `${listing?.title_raw ?? listing?.title ?? ""}`;
  let search = [make, model].filter(Boolean).join(" ").trim();
  if (!search) {
    search = title
      .replace(/^\s*\d{4}\s*/, "")
      .split(/\s+/)
      .slice(0, 2)
      .join(" ")
      .trim();
  }
  if (!search) {
    return { comps: [], diagnostics: { reason: "could not infer make/model for Cars & Bids lookup" } };
  }

  const cleanModel = normalizeToken(model);
  const searches = [search];
  const sportsCarFamily = ["frs", "brz", "86", "gr86"];
  if (sportsCarFamily.includes(cleanModel)) {
    for (const relatedSearch of ["Scion FR-S", "Subaru BRZ", "Toyota 86"]) {
      if (!searches.some((entry) => entry.toLowerCase() === relatedSearch.toLowerCase())) searches.push(relatedSearch);
    }
  }

  const all = new Map();
  const failures = [];
  let totalRecords = 0;
  for (const query of searches) {
    let payload;
    try {
      payload = await signedGet("autos/auctions", {
        status: "closed",
        search: query,
        limit: `${Math.max(1, Math.min(limit, 50))}`
      });
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    if (!payload || !Array.isArray(payload.auctions)) {
      failures.push("Cars & Bids response unparseable");
      continue;
    }
    totalRecords += Number(payload.total ?? payload.auctions.length) || 0;
    for (const comp of payload.auctions.map(normalizeCandbRecord).filter(Boolean)) {
      if (comp.url) all.set(comp.url, comp);
    }
  }
  const comps = [...all.values()].slice(0, Math.max(1, Math.min(limit * searches.length, 50)));
  if (totalRecords === 0) {
    return { comps, diagnostics: { totalRecords: 0, sold: 0, search: searches, reason: failures[0] ?? "no Cars & Bids archive matches" } };
  }
  return { comps, diagnostics: { totalRecords, sold: comps.length, search: searches, failures } };
}
