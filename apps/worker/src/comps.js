export const COMP_SOURCES = ["bat", "cars_and_bids", "other"];

export function validateCompInput(body = {}) {
  const source = `${body.source ?? ""}`.trim().toLowerCase();
  if (!COMP_SOURCES.includes(source)) {
    throw new Error(`source must be one of: ${COMP_SOURCES.join(", ")}.`);
  }

  const soldPriceRaw = body.soldPrice ?? body.sold_price;
  const soldPrice = Number(soldPriceRaw);
  if (!Number.isFinite(soldPrice) || soldPrice <= 0) {
    throw new Error("soldPrice must be a positive number.");
  }

  const url = body.url ? `${body.url}`.trim() : "";
  if (url && !/^https?:\/\//i.test(url)) {
    throw new Error("url must start with http(s)://.");
  }

  let soldAt = null;
  const soldAtRaw = body.soldAt ?? body.sold_at;
  if (soldAtRaw) {
    const parsed = new Date(soldAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("soldAt must be a valid date.");
    }
    soldAt = parsed.toISOString();
  }

  let mileage = null;
  const mileageRaw = body.mileage;
  if (mileageRaw !== undefined && mileageRaw !== null && mileageRaw !== "") {
    const parsed = Number(mileageRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("mileage must be a positive number of miles.");
    }
    mileage = Math.round(parsed);
  }

  const transmissionRaw = `${body.transmission ?? "unknown"}`.trim().toLowerCase();
  const transmission = ["manual", "automatic", "unknown"].includes(transmissionRaw) ? transmissionRaw : "unknown";

  return {
    source,
    url: url || null,
    title: body.title ? `${body.title}`.trim().slice(0, 300) : null,
    soldPrice: Math.round(soldPrice),
    soldAt,
    mileage,
    transmission,
    note: body.note ? `${body.note}`.trim().slice(0, 1000) : null
  };
}

export function compMedian(comps = []) {
  const prices = comps
    .map((comp) => Number(comp.sold_price ?? comp.soldPrice))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) {
    return null;
  }
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[mid];
}

export function similarMileageComps(comps = [], listingMileage, { minimumMiles = 15_000, percent = 0.25 } = {}) {
  const miles = Number(listingMileage);
  if (!Number.isFinite(miles) || miles <= 0) return { comps: [], window: null };
  const delta = Math.max(minimumMiles, miles * percent);
  const window = { from: Math.max(0, Math.round(miles - delta)), to: Math.round(miles + delta) };
  return {
    window,
    comps: comps.filter((comp) => {
      const compMiles = Number(comp.mileage);
      return Number.isFinite(compMiles) && compMiles >= window.from && compMiles <= window.to;
    })
  };
}

// "28k-Mile", "60,500 Miles", "8,500 miles", "48000.miles", "12,300 km"
export function parseMileage(text) {
  if (!text) {
    return null;
  }
  const normalized = `${text}`.replace(/,/g, "");
  const kmMatch = normalized.match(/(\d+(?:\.\d+)?)\s*km\b/i);
  if (kmMatch) {
    const km = Number(kmMatch[1]);
    return Number.isFinite(km) && km > 0 ? Math.round(km * 0.621371) : null;
  }
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(k\b)?[\s.,-]*(miles?|mi)\b/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  const miles = match[2] ? value * 1000 : value;
  // Guard against matching engine sizes etc. that slipped through.
  if (miles < 100 || miles > 1_000_000) {
    return null;
  }
  return Math.round(miles);
}

export function parseTransmission(text) {
  const normalized = `${text ?? ""}`.toLowerCase();
  if (/(automatic|tiptronic|pdk|dsg|\bcvt\b|multitronic|automated manual|smg\b)/.test(normalized)) {
    return "automatic";
  }
  if (/\bmanual\b|stick shift|\bmt\b/.test(normalized)) {
    if (!/(manual windows|manual seats|manual locks|owner'?s manual)/.test(normalized)) {
      return "manual";
    }
  }
  return "unknown";
}

function linearRegression(points) {
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
    sumXY += point.x * point.y;
    sumXX += point.x * point.x;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) {
    return null;
  }
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

// Least-squares price trend over comps that carry mileage. Needs >=3 points;
// predicts the listing's price from ITS mileage when known.
export function priceTrend(comps = [], listing = {}) {
  const points = [];
  for (const comp of comps) {
    const mileage = Number(comp.mileage);
    const price = Number(comp.sold_price ?? comp.soldPrice);
    if (Number.isFinite(mileage) && mileage > 0 && Number.isFinite(price) && price > 0) {
      points.push({ x: mileage, y: price });
    }
  }
  if (points.length < 3) {
    return null;
  }
  const line = linearRegression(points);
  if (!line) {
    return null;
  }

  const listingMileage = Number(listing.mileage);
  const listingPrice = Number(listing.price);
  const trend = {
    n: points.length,
    slope: line.slope,
    intercept: line.intercept,
    minMileage: Math.min(...points.map((p) => p.x)),
    maxMileage: Math.max(...points.map((p) => p.x)),
    minPrice: Math.min(...points.map((p) => p.y)),
    maxPrice: Math.max(...points.map((p) => p.y)),
    predicted: null,
    actual: Number.isFinite(listingPrice) && listingPrice > 0 ? listingPrice : null,
    diff: null,
    diffPct: null
  };
  if (Number.isFinite(listingMileage) && listingMileage > 0) {
    trend.predicted = Math.round(line.slope * listingMileage + line.intercept);
    if (trend.actual !== null && trend.predicted > 0) {
      trend.diff = trend.actual - trend.predicted;
      trend.diffPct = trend.diff / trend.predicted;
    }
  }
  return trend;
}
