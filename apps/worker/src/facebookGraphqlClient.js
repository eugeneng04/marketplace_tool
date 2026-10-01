import { scheduleFacebookRequest } from "./facebookRequestLimiter.js";
import { inspectSearchPayload, sanitizeFacebookEvidence } from "./facebookSearchInspection.js";
import crypto from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const GRAPHQL_URL = "https://www.facebook.com/api/graphql/";
const MARKETPLACE_URL = "https://www.facebook.com/marketplace/";
const MARKETPLACE_SEARCH_URL = "https://www.facebook.com/marketplace/search/";
const MARKETPLACE_SEARCH_DOC_ID = "7111939778879383";
const LOCATION_SEARCH_DOC_ID = "5585904654783609";
const LISTING_DETAIL_DOC_ID = "26924013917190310";
const LISTING_PHOTOS_DOC_ID = "10059604367394414";
const GRAPHQL_OPERATION_NAMES = new Map([
  [MARKETPLACE_SEARCH_DOC_ID, "Marketplace search"],
  [LOCATION_SEARCH_DOC_ID, "Marketplace location search"],
  [LISTING_DETAIL_DOC_ID, "Marketplace listing detail"],
  [LISTING_PHOTOS_DOC_ID, "Marketplace listing photos"]
]);
const DEFAULT_NEWEST_WITHIN_DAYS = 1;
const CHROME_SALT = "saltysalt";
const CHROME_ITERATIONS = 1003;
const CHROME_KEY_LENGTH = 16;
const CHROME_IV = Buffer.alloc(16, " ");

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const BROWSER_HEADERS = {
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="150", "Google Chrome";v="150", "Not?A_Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"'
};

function getChromePassword() {
  try {
    return execSync('security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"', {
      stdio: ["pipe", "pipe", "pipe"]
    })
      .toString()
      .trim();
  } catch {
    throw new Error("Could not read Chrome Safe Storage from macOS Keychain.");
  }
}

function deriveChromeKey(password) {
  return crypto.pbkdf2Sync(password, CHROME_SALT, CHROME_ITERATIONS, CHROME_KEY_LENGTH, "sha1");
}

function decryptCookieValue(encrypted, key) {
  if (!encrypted || encrypted.length === 0) {
    return "";
  }

  if (encrypted.slice(0, 3).toString("ascii") !== "v10") {
    return encrypted.toString("utf8");
  }

  const decipher = crypto.createDecipheriv("aes-128-cbc", key, CHROME_IV);
  decipher.setAutoPadding(false);

  let decoded = Buffer.concat([decipher.update(encrypted.slice(3)), decipher.final()]);
  const padding = decoded[decoded.length - 1];
  if (padding && padding > 0 && padding <= 16) {
    decoded = decoded.slice(0, decoded.length - padding);
  }

  if (decoded.length > 32) {
    decoded = decoded.slice(32);
  }

  return decoded.toString("utf8");
}

function getChromeCookieDbPath(profile) {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome", profile, "Cookies");
}

async function extractChromeCookies(domain, profile) {
  const cookiePath = getChromeCookieDbPath(profile);
  const tmpPath = path.join(os.tmpdir(), `resale_intelligence_chrome_cookies_${process.pid}_${Date.now()}`);

  try {
    execSync(`cp "${cookiePath}" "${tmpPath}"`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    throw new Error(`Could not copy Chrome cookies from ${cookiePath}. Check CHROME_PROFILE and Chrome login state.`);
  }

  const key = deriveChromeKey(getChromePassword());

  try {
    const rows = JSON.parse(
      execFileSync(
        "sqlite3",
        [
          "-json",
          tmpPath,
          `SELECT host_key, name, value, hex(encrypted_value) AS encrypted_value_hex, path, expires_utc, is_secure, is_httponly
           FROM cookies
          WHERE host_key LIKE '%${domain.replace(/'/g, "''")}'
            AND (expires_utc = 0 OR expires_utc > (strftime('%s','now') + 11644473600) * 1000000);`
        ],
        { encoding: "utf8" }
      )
    );

    return rows.map((row) => {
      let value = row.value;
      const encryptedValue = row.encrypted_value_hex ? Buffer.from(row.encrypted_value_hex, "hex") : null;
      if (!value && encryptedValue?.length > 0) {
        value = decryptCookieValue(encryptedValue, key);
      }

      return {
        host: row.host_key,
        name: row.name,
        value,
        path: row.path,
        expires: row.expires_utc,
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly)
      };
    });
  } finally {
    try {
      execSync(`rm -f "${tmpPath}"`, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      // Non-fatal cleanup failure.
    }
  }
}

function cookiesToHeader(cookies) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value.replace(/[^\x00-\xFF]/g, "")}`).join("; ");
}

function getCookieValue(cookies, name) {
  return cookies.find((cookie) => cookie.name === name)?.value;
}

function parseCookieHeader(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return {
        name: separator >= 0 ? part.slice(0, separator) : part,
        value: separator >= 0 ? part.slice(separator + 1) : ""
      };
    });
}

export function buildSearchVariables(params) {
  const variables = {
    count: params.limit,
    params: {
      bqf: {
        callsite: "COMMERCE_MKTPLACE_WWW",
        query: params.query
      },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: true,
        commerce_search_and_rp_available: true,
        commerce_search_and_rp_condition: null,
        commerce_search_and_rp_ctime_days: params.newestWithinDays ?? DEFAULT_NEWEST_WITHIN_DAYS,
        filter_location_latitude: params.latitude,
        filter_location_longitude: params.longitude,
        filter_price_lower_bound: params.minPrice ? params.minPrice * 100 : 0,
        filter_price_upper_bound: params.maxPrice ? params.maxPrice * 100 : 214748364700,
        filter_radius_km: params.radiusKm,
        sort_by: "creation_time_descend"
      },
      custom_request_params: {
        surface: "SEARCH"
      }
    }
  };

  if (params.cursor) {
    variables.cursor = params.cursor;
  }

  if (params.category) {
    variables.params.browse_request_params.commerce_search_and_rp_category_id = params.category;
  }

  return variables;
}

function buildLocationSearchVariables(query) {
  return {
    params: {
      caller: "MARKETPLACE",
      page_category: ["CITY", "SUBCITY", "NEIGHBORHOOD"],
      query
    }
  };
}

export function parseSearchResponse(data, limit = 25) {
  const feedUnits = data?.data?.marketplace_search?.feed_units;
  const edges = feedUnits?.edges ?? [];
  const pageInfo = feedUnits?.page_info ?? {};
  const seen = new Set();
  const listingObjects = [];
  let richListingCount = 0;
  let cursorPlaceholderCount = 0;

  function visit(value) {
    if (!value || typeof value !== "object") {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const id = value.id ?? value.listing_id ?? value.marketplace_listing_id;
    const title = value.marketplace_listing_title ?? value.title;
    if (id && typeof title === "string" && title.trim() && !seen.has(`${id}`)) {
      seen.add(`${id}`);
      listingObjects.push(value);
      richListingCount += 1;
    }

    for (const child of Object.values(value)) visit(child);
  }

  for (const edge of edges) visit(edge?.node);

  // Recent Marketplace responses can expose listing IDs in the pagination cursor
  // while returning only feed-unit wrapper nodes in the edge list.
  if (pageInfo.end_cursor) {
    try {
      const cursor = JSON.parse(pageInfo.end_cursor);
      const cursorListingIds = cursor?.c2c?.sspi ?? cursor?.sspi ?? [];
      for (const id of cursorListingIds) {
        if (!id || seen.has(`${id}`)) continue;
        seen.add(`${id}`);
        cursorPlaceholderCount += 1;
        // Cursor-only IDs are useful to detect an incomplete response, but
        // they are not listing cards. Keep them only when there are no real
        // edge cards so the HTML fallback can recover those results.
        if (richListingCount === 0) {
          listingObjects.push({ id: `${id}`, marketplace_listing_title: "Marketplace listing" });
        }
      }
    } catch {
      // Facebook may change the cursor encoding; parsed feed nodes remain usable.
    }
  }

  const listings = listingObjects.slice(0, Math.max(0, limit)).map((listing) => {
    const id = `${listing.id ?? listing.listing_id ?? listing.marketplace_listing_id}`;
    return {
      id,
      title: listing.marketplace_listing_title ?? listing.title ?? "",
      price: listing.listing_price?.formatted_amount ?? listing.listing_price?.amount ?? listing.price?.formatted_amount ?? listing.price?.amount ?? "",
      location:
        listing.location?.reverse_geocode?.city_page?.display_name ??
        listing.location?.reverse_geocode?.city ??
        listing.location?.name ??
        "",
      imageUrl: listing.primary_listing_photo?.image?.uri ?? listing.image?.uri ?? "",
      sellerName: listing.marketplace_listing_seller?.name ?? "",
      sellerId: listing.marketplace_listing_seller?.id ?? "",
      customTitle: listing.custom_title ?? "",
      subtitles: (listing.custom_sub_titles_with_rendering_flags ?? []).map(entry => entry.subtitle).filter(Boolean),
      mileage: extractMarketplaceMileage(listing),
      vehicleAttributes: extractMarketplaceVehicleAttributes(listing),
      previousPrice: listing.strikethrough_price?.formatted_amount ?? "",
      categoryId: listing.marketplace_listing_category_id ?? "",
      deliveryTypes: listing.delivery_types ?? [],
      videoIds: (listing.pre_recorded_videos ?? []).map(video => video.id).filter(Boolean),
      isSold: listing.is_sold,
      isLive: listing.is_live,
      isHidden: listing.is_hidden,
      isViewerSeller: listing.is_viewer_seller,
      postedDate: listing.creation_time ? new Date(listing.creation_time * 1000).toISOString() : "",
      url: `https://www.facebook.com/marketplace/item/${id}/`,
      isPending: listing.is_pending ?? false,
      raw: listing
    };
  });

  const firstNode = edges[0]?.node;
  // Keep the diagnostic structural: Facebook payloads can contain private
  // listing and seller data, so never attach raw values to run summaries.
  function collectFieldPaths(value, prefix = "node", depth = 0, paths = []) {
    if (!value || typeof value !== "object" || depth >= 4 || paths.length >= 40) return paths;
    for (const [key, child] of Object.entries(value)) {
      const path = `${prefix}.${key}`;
      paths.push(`${path}:${Array.isArray(child) ? "array" : child === null ? "null" : typeof child}`);
      if (paths.length >= 40) break;
      if (child && typeof child === "object") collectFieldPaths(child, path, depth + 1, paths);
    }
    return paths;
  }

  const diagnostics = cursorPlaceholderCount > 0 || listings.length === 0
    ? {
        graphqlDataKeys: Object.keys(data?.data ?? {}),
        feedUnitKeys: Object.keys(feedUnits ?? {}),
        edgeCount: edges.length,
        richListingCount,
        cursorPlaceholderCount,
        firstNodeKeys: Object.keys(firstNode ?? {}),
        firstNodeFieldPaths: collectFieldPaths(firstNode),
        hasNextPage: pageInfo.has_next_page ?? false
      }
    : undefined;

  return {
    listings,
    hasNextPage: pageInfo.has_next_page ?? false,
    endCursor: pageInfo.end_cursor ?? null,
    ...(diagnostics ? { diagnostics } : {})
  };
}

function decodeHtml(value) {
  return `${value ?? ""}`
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(value) {
  return decodeHtml(`${value ?? ""}`
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))))
    .replace(/\s+/g, " ").trim();
}

export function parseMarketplaceSearchHtml(html, limit = 25) {
  const listings = [];
  const seen = new Set();
  const anchorPattern = /<a\b([^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let match;
  while (listings.length < limit && (match = anchorPattern.exec(html))) {
    const href = decodeHtml(match[2] ?? match[3] ?? "");
    const id = href.match(/\/marketplace\/item\/(\d+)/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const markup = match[4];
    const text = stripHtml(markup);
    const priceMatch = text.match(/\$\s?[\d,]+(?:\.\d{2})?/);
    const price = priceMatch?.[0].replace(/\s+/g, "") ?? "";
    const beforePrice = priceMatch ? text.slice(0, priceMatch.index).trim() : text;
    const title = beforePrice || `Marketplace listing ${id}`;
    const afterPrice = priceMatch ? text.slice(priceMatch.index + priceMatch[0].length).trim() : "";
    const location = afterPrice.match(/(?:reduced from\s+\$[\d,.]+\s*)?(.+?,\s*[A-Z]{2})\s*$/i)?.[1]?.trim() ?? "";
    const imageMatch = markup.match(/<(?:img|image)\b[^>]*\b(?:src|data-src)\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const imageUrl = decodeHtml(imageMatch?.[1] ?? imageMatch?.[2] ?? "");
    const listingUrl = `https://www.facebook.com/marketplace/item/${id}/`;
    listings.push({
      id,
      title,
      price,
      location,
      imageUrl,
      sellerName: "",
      postedDate: "",
      url: listingUrl,
      isPending: false,
      raw: { captureMode: "marketplace_search_page", cardText: text }
    });
  }
  return listings;
}

function decodeHtmlEntities(value) {
  return `${value ?? ""}`
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function decodeJsonString(value) {
  if (!value) {
    return "";
  }

  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value.replace(/\\\//g, "/").replace(/\\"/g, '"');
  }
}

function firstJsonStringMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeJsonString(match[1]);
    }
  }

  return "";
}

export function parseListingDetailFromPage(html, listingId) {
  const title =
    firstJsonStringMatch(html, [/"marketplace_listing_title"\s*:\s*"((?:\\"|[^"])*)"/]) ||
    decodeHtmlEntities(html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)?.[1] ?? "");

  const description =
    firstJsonStringMatch(html, [
      /"redacted_description"\s*:\s*\{\s*"text"\s*:\s*"((?:\\"|[^"])*)"/,
      /"listing_description"\s*:\s*\{\s*"text"\s*:\s*"((?:\\"|[^"])*)"/,
      /"description"\s*:\s*\{\s*"text"\s*:\s*"((?:\\"|[^"])*)"/
    ]) || decodeHtmlEntities(html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/)?.[1] ?? "");

  const imageUrl =
    firstJsonStringMatch(html, [
      /"primary_listing_photo"[\s\S]{0,600}?"image"\s*:\s*\{[\s\S]{0,200}?"uri"\s*:\s*"((?:\\"|[^"])*)"/,
      /"primary_listing_photo"[\s\S]{0,600}?"uri"\s*:\s*"((?:\\"|[^"])*)"/
    ]) || decodeHtmlEntities(html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/)?.[1] ?? "");

  // Do not scan the entire HTML document for image URIs: Facebook includes
  // seller avatars and recommendations alongside the listing's own photos.
  const images = imageUrl ? [imageUrl] : [];

  const price =
    firstJsonStringMatch(html, [
      /"formatted_price"\s*:\s*\{\s*"text"\s*:\s*"((?:\\"|[^"])*)"/,
      /"formatted_amount"\s*:\s*"((?:\\"|[^"])*)"/,
      /"price"\s*:\s*"((?:\\"|[^"])*)"/,
      /\\"amount\\"\s*:\s*\\"([^"]+)\\"/
    ]) ||
    "";

  const sellerName = firstJsonStringMatch(html, [/"marketplace_listing_seller"[\s\S]{0,900}?"name"\s*:\s*"((?:\\"|[^"])*)"/]);
  const condition = firstJsonStringMatch(html, [/"condition_text"\s*:\s*"((?:\\"|[^"])*)"/, /"condition"\s*:\s*"((?:\\"|[^"])*)"/]);
  const location =
    firstJsonStringMatch(html, [
      /"location_text"\s*:\s*\{[^}]*"text"\s*:\s*"((?:\\"|[^"])*)"/,
      /"reverse_geocode_city"\s*:\s*"((?:\\"|[^"])*)"/
    ]) ||
    "";

  return {
    id: listingId,
    title,
    description,
    price,
    location,
    imageUrl,
    images,
    sellerName,
    postedDate: "",
    url: `https://www.facebook.com/marketplace/item/${listingId}/`,
    isPending: false,
    condition,
    seller: {
      name: sellerName,
      profileUrl: ""
    }
  };
}

const LISTING_DETAIL_VARIABLE_DEFAULTS = {
  enableJobEmployerActionBar: false,
  enableJobSeekerActionBar: false,
  feedbackSource: 56,
  feedLocation: "MARKETPLACE_MEGAMALL",
  referralCode: "null",
  referralSurfaceString: "search",
  scale: 1,
  useDefaultActor: false,
  __relay_internal__pv__ShouldUpdateMarketplaceBoostListingBoostedStatusrelayprovider: false,
  __relay_internal__pv__CometUFISingleLineUFIrelayprovider: false,
  __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
  __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
  __relay_internal__pv__CometUFICommentAutoTranslationTyperelayprovider: "ORIGINAL",
  __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
  __relay_internal__pv__CometUFICommentActionLinksRewriteEnabledrelayprovider: false,
  __relay_internal__pv__IsWorkUserrelayprovider: false,
  __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: false,
  __relay_internal__pv__GHLShouldChangeAdIdFieldNamerelayprovider: false,
  __relay_internal__pv__CometUFI_dedicated_comment_routable_dialog_gkrelayprovider: true
};

export function buildListingDetailVariables(listingId) {
  return { ...LISTING_DETAIL_VARIABLE_DEFAULTS, targetId: `${listingId}` };
}

export function parseListingDetailResponse(data, listingId) {
  const target = data?.data?.viewer?.marketplace_product_details_page?.target;
  if (!target) throw new Error(`Facebook GraphQL returned no detail data for listing ${listingId}.`);

  const primaryImage = target.primary_listing_photo?.image?.uri ?? "";
  const images = [...new Set([primaryImage, ...(target.listing_photos ?? []).map((photo) => photo?.image?.uri)].filter(Boolean))];
  const createdAt = Number(target.creation_time);
  const sellerName = target.marketplace_listing_seller?.name ?? "";
  const vehicleAttributes = extractMarketplaceVehicleAttributes(target);
  const mileage = vehicleAttributes.mileage ?? extractMarketplaceMileage(target);

  return {
    id: `${target.id ?? listingId}`,
    title: target.marketplace_listing_title ?? "",
    description: target.redacted_description?.text ?? "",
    price: target.listing_price?.formatted_amount ?? target.listing_price?.amount ?? "",
    location: target.location_text?.text ?? target.location?.reverse_geocode?.city_page?.display_name ?? "",
    imageUrl: primaryImage || images[0] || "",
    images,
    sellerName,
    postedDate: Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt * 1000).toISOString() : "",
    url: target.share_uri ?? `https://www.facebook.com/marketplace/item/${listingId}/`,
    isPending: target.is_pending ?? false,
    isSold: target.is_sold ?? false,
    condition: target.condition ?? (target.attribute_data ?? []).find((attribute) => /condition/i.test(attribute?.attribute_name ?? ""))?.label ?? "",
    currency: target.listing_price?.currency ?? "",
    mileage,
    vehicleAttributes,
    seller: { name: sellerName, profileUrl: "" },
    sellerId: target.marketplace_listing_seller?.id ?? "",
    raw: target
  };
}

function attributeText(value) {
  if (typeof value === "string" || typeof value === "number") return `${value}`.trim();
  if (!value || typeof value !== "object") return "";
  for (const key of ["formatted_value", "display_value", "value", "label", "text", "attribute_value"]) {
    const text = attributeText(value[key]);
    if (text) return text;
  }
  return "";
}

function extractMarketplaceVehicleAttributes(target) {
  const result = {};
  const put = (name, value) => {
    const key = `${name ?? ""}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const text = attributeText(value);
    if (key && text) result[key] = text;
  };
  for (const entry of target?.attribute_data ?? []) {
    put(entry?.attribute_name ?? entry?.name ?? entry?.key, entry?.attribute_value ?? entry?.value ?? entry?.label ?? entry?.formatted_value);
  }
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    for (const [key, value] of Object.entries(node)) {
      if (/^(vehicle_)?(mileage|odometer|transmission|condition|make|model|year)$/i.test(key)) put(key, value);
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(target);
  // These keys were verified in a live Marketplace detail response.
  for (const [field, key] of Object.entries({
    make: "vehicle_make_display_name", model: "vehicle_model_display_name",
    trim: "vehicle_trim_display_name", transmission: "vehicle_transmission_type",
    exterior_color: "vehicle_exterior_color", interior_color: "vehicle_interior_color",
    fuel_type: "vehicle_fuel_type", number_of_owners: "vehicle_number_of_owners",
    paid_off: "vehicle_is_paid_off", seller_type: "vehicle_seller_type"
  })) put(field, target?.[key]);
  if (target?.vehicle_odometer_data?.unit === "MILES") put("mileage", target.vehicle_odometer_data.value);
  if (result.mileage) result.mileage = numericMileage(result.mileage) ?? result.mileage;
  if (result.vehicle_mileage) result.mileage = numericMileage(result.vehicle_mileage) ?? result.mileage;
  if (result.transmission) result.transmission = normalizeTransmission(result.transmission);
  return result;
}

function normalizeTransmission(value) {
  const text = `${value ?? ""}`.toLowerCase();
  if (/manual|stick|standard|\b5\s*speed\b|\b6\s*speed\b/.test(text)) return "manual";
  if (/automatic|\bauto\b|cvt|dsg|pdk/.test(text)) return "automatic";
  return `${value}`.trim();
}

function numericMileage(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value >= 100 && value <= 1_000_000 ? Math.round(value) : null;
  if (typeof value === "string") {
    const match = value.match(/\b([\d,]+(?:\.\d+)?)\s*(k)?\s*(?:miles?|mi)?\b/i);
    if (!match) return null;
    const parsed = Number(match[1].replaceAll(",", "")) * (match[2] ? 1000 : 1);
    return Number.isFinite(parsed) && parsed >= 100 && parsed <= 1_000_000 ? Math.round(parsed) : null;
  }
  if (value && typeof value === "object") {
    for (const key of ["value", "text", "label", "formatted_value", "display_value"]) {
      if (value[key] !== undefined) {
        const parsed = numericMileage(value[key]);
        if (parsed !== null) return parsed;
      }
    }
  }
  return null;
}

function extractMarketplaceMileage(target) {
  if (target?.vehicle_odometer_data?.unit === "MILES") {
    const mileage = numericMileage(target.vehicle_odometer_data.value);
    if (mileage !== null) return mileage;
  }
  for (const entry of target?.custom_sub_titles_with_rendering_flags ?? []) {
    const subtitle = `${entry?.subtitle ?? ""}`.trim();
    if (!/^[\d,.]+\s*k?\s*(?:miles?|mi)$/i.test(subtitle)) continue;
    const mileage = numericMileage(subtitle);
    if (mileage !== null) return mileage;
  }
  const seen = new Set();
  const visit = (value, hinted = false) => {
    if (!value || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        const named = /mileage|odometer|\bodo\b/i.test(`${entry?.attribute_name ?? ""} ${entry?.name ?? ""} ${entry?.key ?? ""}`);
        const parsed = visit(entry, named);
        if (parsed !== null) return parsed;
      }
      return null;
    }
    if (hinted) {
      for (const key of ["value", "text", "label", "formatted_value", "display_value", "attribute_value"]) {
        const parsed = numericMileage(value[key]);
        if (parsed !== null) return parsed;
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (/mileage|odometer|odometer_reading|vehicle_miles/i.test(key)) {
        const direct = numericMileage(child);
        if (direct !== null) return direct;
        const nested = visit(child, true);
        if (nested !== null) return nested;
      } else if (child && typeof child === "object") {
        const nested = visit(child);
        if (nested !== null) return nested;
      }
    }
    return null;
  };
  return visit(target);
}

export function parseListingImagesResponse(data) {
  const photos = data?.data?.viewer?.marketplace_product_details_page?.target?.listing_photos ?? [];
  return [...new Set(photos.map((photo) => photo?.image?.uri).filter(Boolean))];
}

export function formatFacebookError(data, session = {}) {
  const errors = Array.isArray(data.errors) ? data.errors : [typeof data.error === "object" ? data.error : { code: data.error, message: data.errorDescription || data.errorSummary }];
  const secrets = [session.cookieHeader, session.fbDtsg, session.lsd,
    ...(session.cookieHeader || "").split(";").map(part => part.slice(part.indexOf("=") + 1).trim())]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  const details = errors.slice(0, 3).map(error => {
    const code = error?.code ?? error?.extensions?.code;
    let message = typeof error?.message === "string" ? error.message : "";
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    message = message.replace(/https?:\/\/[^\s<>]+/gi, "[link removed]")
      .replace(/(?:fb_dtsg|lsd|access_token|xs|c_user)\s*[=:]\s*[^\s;,]+/gi, "[credential redacted]")
      .replace(/<[^>]*>/g, "").replace(/[\r\n\t]+/g, " ").slice(0, 300);
    const safeCode = /^(?:[0-9]+|[A-Z_]{2,60})$/.test(String(code)) ? `code ${code}` : "";
    return [safeCode, message].filter(Boolean).join(": ");
  }).filter(Boolean).join("; ");
  return `Facebook rejected the Marketplace request${details ? ` (${details})` : ""}.`;
}

export class FacebookGraphqlClient {
  constructor(options = {}) {
    this.cookieHeader = options.facebookCookie ?? "";
    this.chromeProfile = options.chromeProfile ?? "Default";
    this.useChromeCookies = options.useChromeCookies ?? process.env.FB_USE_CHROME_COOKIES === "true";
    this.userAgent = options.facebookUserAgent ?? DEFAULT_USER_AGENT;
    this.searchBaseUrl = options.facebookSearchBaseUrl ?? MARKETPLACE_SEARCH_URL;
    this.session = null;
    this.reqCounter = 0;
    this.requestsPerMinute = Number(options.facebookMaxRequestsPerMinute ?? process.env.FB_MAX_REQUESTS_PER_MINUTE ?? 3);
    if (!Number.isFinite(this.requestsPerMinute) || this.requestsPerMinute <= 0) {
      throw new Error("FB_MAX_REQUESTS_PER_MINUTE must be a positive number.");
    }
    this.scheduleRequest = options.scheduleRequest ?? scheduleFacebookRequest;
  }

  request(url, options) {
    return this.scheduleRequest(() => fetch(url, { ...options, signal: AbortSignal.timeout(30000) }), this.requestsPerMinute);
  }

  async ensureSession() {
    if (this.session) return this.session;
    if (!this.sessionPromise) {
      this.sessionPromise = this.loadSession().finally(() => { this.sessionPromise = null; });
    }
    return this.sessionPromise;
  }

  async loadSession() {
    if (this.session) {
      return this.session;
    }

    let cookies = [];
    let cookieHeader = this.cookieHeader;
    if (cookieHeader) {
      cookies = parseCookieHeader(cookieHeader);
    } else if (this.useChromeCookies) {
      cookies = await extractChromeCookies("facebook.com", this.chromeProfile);
      cookieHeader = cookiesToHeader(cookies);
    }

    const userId = getCookieValue(cookies, "c_user");
    const sessionCookie = getCookieValue(cookies, "xs");
    if ((this.cookieHeader || this.useChromeCookies) && (!userId || !sessionCookie)) {
      const source = this.useChromeCookies && !this.cookieHeader
        ? `Chrome profile "${this.chromeProfile}" is not signed into Facebook. Sign in to Facebook in that Chrome profile, then rerun the local search.`
        : "FB_COOKIE must include an active Facebook session (c_user and xs cookies).";
      throw new Error(source);
    }
    // Logged-out Marketplace requests use page tokens without account cookies.

    if (this.lastSearchInspection?.state === 'running') {
      Object.assign(this.lastSearchInspection.session, {hasUserCookie: Boolean(userId), hasSessionCookie: Boolean(sessionCookie)});
    }
    const tokens = await this.extractTokens(cookieHeader);
    if (this.lastSearchInspection?.state === 'running') this.lastSearchInspection.session.pageTokensAvailable = true;
    this.session = {
      cookies,
      cookieHeader,
      userId: userId ?? "0",
      ...tokens
    };
    return this.session;
  }

  async extractTokens(cookieHeader) {
    const response = await this.request(MARKETPLACE_URL, {
      headers: {
        ...BROWSER_HEADERS,
        "user-agent": this.userAgent,
        cookie: cookieHeader,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "cache-control": "max-age=0",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1"
      },
      redirect: "follow"
    });

    if (this.lastSearchInspection?.state === 'running') {
      this.lastSearchInspection.session.tokenPageHttpStatus = response.status;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch Marketplace token page: HTTP ${response.status}`);
    }

    const html = await response.text();
    const finalPath = (() => {
      try { return new URL(response.url).pathname; } catch { return ""; }
    })();
    if (/\/(?:login|checkpoint)(?:\/|$)/i.test(finalPath) || /id=["']login_form["']/i.test(html)) {
      throw new Error("Facebook redirected the Marketplace session to login. Sign in to Facebook and retry the search.");
    }
    const fbDtsg =
      html.match(/"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/)?.[1] ??
      html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/)?.[1] ??
      html.match(/"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/)?.[1];

    if (!fbDtsg) {
      throw new Error("Could not extract Marketplace page tokens. Facebook may be restricting access from this server.");
    }

    return {
      fbDtsg,
      lsd:
        html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/)?.[1] ??
        html.match(/name="lsd"\s+value="([^"]+)"/)?.[1] ??
        "",
      jazoest: html.match(/jazoest=(\d+)/)?.[1] ?? "",
      clientRevision: html.match(/"client_revision"\s*:\s*(\d+)/)?.[1] ?? html.match(/__spin_r:\s*(\d+)/)?.[1] ?? "1"
    };
  }

  async graphqlRequest(docId, variables) {
    const session = await this.ensureSession();
    const operation = GRAPHQL_OPERATION_NAMES.get(docId) ?? "Marketplace GraphQL";
    this.reqCounter += 1;

    const body = new URLSearchParams({
      fb_dtsg: session.fbDtsg,
      lsd: session.lsd,
      jazoest: session.jazoest,
      doc_id: docId,
      variables: JSON.stringify(variables),
      __a: "1",
      // Marketplace search currently returns cursor-only placeholder IDs when
      // the browser's Comet request context is omitted, even with HTTP 200.
      __comet_req: "15",
      __req: this.reqCounter.toString(36),
      __rev: session.clientRevision
    });

    let response;
    try {
      response = await this.request(GRAPHQL_URL, {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "user-agent": this.userAgent,
          cookie: session.cookieHeader,
          "content-type": "application/x-www-form-urlencoded",
          accept: "*/*",
          origin: "https://www.facebook.com",
          referer: MARKETPLACE_URL,
          "x-fb-lsd": session.lsd,
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin"
        },
        body: body.toString()
      });
    } catch (error) {
      if (error.facebookResponse && docId === MARKETPLACE_SEARCH_DOC_ID && this.lastSearchInspection?.state === 'running') {
        const rejected = error.facebookResponse;
        const raw = await rejected.clone().text();
        this.lastSearchInspection.transport = {
          operation, docId, httpStatus: rejected.status,
          contentType: rejected.headers.get('content-type'), bodyLength: raw.length
        };
        try {
          const start = raw.indexOf('{');
          this.lastSearchInspection.response = sanitizeFacebookEvidence(JSON.parse(start > 0 ? raw.slice(start) : raw), session);
        } catch {
          this.lastSearchInspection.responseParseFailed = true;
        }
      }
      // The shared limiter recognizes HTTP-200 GraphQL throttles before this
      // client parses the response. Preserve that behavior while recording
      // which operation Facebook rejected in the run's error message.
      error.message = `${error.message} Rejected operation: ${operation}.`;
      error.facebookOperation = operation;
      throw error;
    }

    if (docId === MARKETPLACE_SEARCH_DOC_ID && this.lastSearchInspection?.state === 'running') {
      this.lastSearchInspection.transport = {
        operation, docId, httpStatus: response.status,
        contentType: response.headers.get('content-type')
      };
    }
    if (response.status === 401 || response.status === 403) {
      this.session = null;
      throw new Error("Facebook session expired or was rejected.");
    }

    if (!response.ok) {
      throw new Error(`Facebook GraphQL request failed: HTTP ${response.status}`);
    }

    let text = await response.text();
    const jsonStart = text.indexOf("{");
    if (jsonStart > 0) {
      text = text.slice(jsonStart);
    }

    try {
      const data = JSON.parse(text);
      if (docId === MARKETPLACE_SEARCH_DOC_ID && this.lastSearchInspection?.state === 'running') {
        this.lastSearchInspection.response = sanitizeFacebookEvidence(data, session);
        this.lastSearchInspection.transport.bodyLength = text.length;
      }
      if (data.errors?.length || data.error) {
        this.session = null;
        throw new Error(`${formatFacebookError(data, session)} Rejected operation: ${operation}.`);
      }
      return data;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Could not parse Facebook GraphQL response.");
      throw error;
    }
  }

  async searchListings(params) {
    this.lastSearchInspection = {
      state: 'running', query: params.query, startedAt: new Date().toISOString(), detailRequests: 0,
      requestContext: {userAgent: this.userAgent, clientHints: BROWSER_HEADERS['sec-ch-ua']},
      session: { configuredCookie: Boolean(this.cookieHeader), chromeCookiesEnabled: this.useChromeCookies },
      requestVariables: buildSearchVariables(params),
      fallback: { attempted: false, reason: 'search_response_unavailable' }
    };
    try {
      const result = await this.performSearchListings(params);
      this.lastSearchInspection.state = 'finished';
      this.lastSearchInspection.finishedAt = new Date().toISOString();
      return result;
    } catch (error) {
      const inspection = this.lastSearchInspection;
      inspection.state = 'failed';
      inspection.finishedAt = new Date().toISOString();
      inspection.error = sanitizeFacebookEvidence(`${error?.message ?? 'Search failed'}`, this.session ?? {cookieHeader: this.cookieHeader});
      error.searchInspection = inspection;
      throw error;
    }
  }

  async performSearchListings(params) {
    const data = await this.graphqlRequest(MARKETPLACE_SEARCH_DOC_ID, buildSearchVariables(params));
    const result = parseSearchResponse(data, params.limit);
    const safeData = sanitizeFacebookEvidence(data, this.session ?? {cookieHeader: this.cookieHeader});
    const initialGraphqlFields = inspectSearchPayload(safeData);
    const inspection = {
      ...this.lastSearchInspection,
      state: 'running', query: params.query,
      detailRequests: 0, cardSource: 'graphql', listingCount: result.listings.length,
      initialGraphqlFields,
      response: safeData, diagnostics: result.diagnostics,
      hasNextPage: result.hasNextPage,
      fallback: { attempted: false, reason: result.diagnostics?.cursorPlaceholderCount > 0 && result.diagnostics.richListingCount === 0
        ? 'cursor_placeholders' : result.listings.length === 0 && result.hasNextPage
          ? 'empty_feed_without_cursor_placeholders' : 'not_needed' },
      listingFields: inspectSearchPayload({listings: result.listings.map(listing => listing.raw)}),
      basicListings: result.listings.map(({raw, ...listing}) => listing)
    };
    this.lastSearchInspection = inspection;
    // Persist the structural inventory with normal runs, without example values.
    result.diagnostics = {...result.diagnostics,
      initialSearchFields: initialGraphqlFields.map(({example, ...field}) => field)};
    // Facebook can return complete edge cards and also repeat their IDs in the
    // pagination cursor. Only fall back when there are placeholders but no
    // rich cards to use; otherwise the extra cursor IDs needlessly trigger a
    // slow page fetch and replace correctly parsed GraphQL results.
    if (result.diagnostics?.cursorPlaceholderCount > 0 && result.diagnostics.richListingCount === 0) {
      inspection.fallback.attempted = true;
      const session = await this.ensureSession();
      const searchUrl = new URL(params.searchUrl || this.searchBaseUrl);
      if (searchUrl.protocol !== "https:" || !/(^|\.)facebook\.com$/i.test(searchUrl.hostname) || !searchUrl.pathname.startsWith("/marketplace/")) {
        throw new Error("FB_SEARCH_BASE_URL and profile search URLs must point to a Facebook Marketplace page.");
      }
      searchUrl.searchParams.set("query", params.query);
      if (params.minPrice !== undefined) searchUrl.searchParams.set("minPrice", `${params.minPrice}`);
      if (params.maxPrice !== undefined) searchUrl.searchParams.set("maxPrice", `${params.maxPrice}`);
      if (params.radiusKm !== undefined) searchUrl.searchParams.set("radius", `${Math.round(params.radiusKm / 1.60934)}`);
      if (params.location) searchUrl.searchParams.set("location", params.location);
      if (params.latitude !== undefined) searchUrl.searchParams.set("latitude", `${params.latitude}`);
      if (params.longitude !== undefined) searchUrl.searchParams.set("longitude", `${params.longitude}`);

      const response = await this.request(searchUrl, {
        headers: {
          ...BROWSER_HEADERS,
          "user-agent": this.userAgent,
          cookie: session.cookieHeader,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin"
        },
        redirect: "follow"
      });
      inspection.fallback.httpStatus = response.status;
      if (!response.ok) throw new Error(`Marketplace search page returned HTTP ${response.status}.`);
      const html = await response.text();
      const finalUrl = response.url ? new URL(response.url) : searchUrl;
      if (!/(^|\.)facebook\.com$/i.test(finalUrl.hostname)) throw new Error("Marketplace search redirected away from Facebook.");
      const finalPath = finalUrl.pathname;
      if (/\/(?:login|checkpoint)(?:\/|$)/i.test(finalPath) || /id=["']login_form["']/i.test(html)) {
        this.session = null;
        throw new Error("Facebook redirected the Marketplace search to login. Sign in and retry the search.");
      }
      const pageListings = parseMarketplaceSearchHtml(html, params.limit);
      inspection.fallback.pageCardCount = pageListings.length;
      if (pageListings.length) {
        inspection.cardSource = 'marketplace_search_page';
        inspection.listingCount = pageListings.length;
        inspection.listingFields = inspectSearchPayload({listings: pageListings.map(listing => listing.raw)});
        inspection.basicListings = pageListings.map(({raw, ...listing}) => listing);
        this.lastSearchInspection = inspection;
        return {
          listings: pageListings,
          hasNextPage: result.hasNextPage,
          endCursor: result.endCursor,
          diagnostics: { ...result.diagnostics, cardSource: "marketplace_search_page", pageCardCount: pageListings.length }
        };
      }
      throw new Error("Facebook GraphQL returned placeholder listing IDs and the Marketplace search page contained no listing cards.");
    }
    if (result.listings.length === 0 && result.hasNextPage) {
      throw new Error("Facebook returned an empty Marketplace feed while reporting more pages. The search response is incomplete; verify the Facebook session and Marketplace GraphQL response before treating this run as successful.");
    }
    this.lastSearchInspection = inspection;
    return result;
  }

  async getListingDetail(listingId, { fetchPhotos = true } = {}) {
    const data = await this.graphqlRequest(LISTING_DETAIL_DOC_ID, buildListingDetailVariables(listingId));
    const detail = parseListingDetailResponse(data, listingId);
    // Search cards usually include a thumbnail. Cursor-only search results do
    // not, so fetch the listing-scoped gallery only when detail also omitted it.
    if (fetchPhotos && !detail.images.length) {
      const photoData = await this.graphqlRequest(LISTING_PHOTOS_DOC_ID, buildListingDetailVariables(listingId));
      detail.images = parseListingImagesResponse(photoData);
    }
    detail.imageUrl ||= detail.images[0] ?? "";
    return detail;
  }

  async searchLocation(query) {
    const data = await this.graphqlRequest(LOCATION_SEARCH_DOC_ID, buildLocationSearchVariables(query));
    const edges = data?.data?.city_street_search?.street_results?.edges ?? [];
    return edges.map((edge) => ({
      name: edge.node?.single_line_address ?? edge.node?.subtitle ?? "Unknown",
      latitude: edge.node?.location?.latitude ?? 0,
      longitude: edge.node?.location?.longitude ?? 0
    }));
  }
}
