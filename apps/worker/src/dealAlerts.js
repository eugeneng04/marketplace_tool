export const DEFAULT_ALERT_RULES = {
  minScore: 70,
  minConfidence: 0.5,
  maxAgeHours: 72
};

export const LOW_CONFIDENCE_THRESHOLD = 0.5;
export const CONFIRMED_DEAL_CONFIDENCE = 0.6;

const EXCLUDED_ALERT_STATUSES = new Set(["hidden", "rejected", "sold", "possibly_gone"]);

function toFiniteNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeConfidence(value, fallback) {
  const parsed = toFiniteNumber(value);
  if (parsed === null) {
    return fallback;
  }
  // Accept 0-100 percentages as well as 0-1 fractions.
  const asFraction = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(asFraction)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, asFraction));
}

function normalizeScore(value, fallback) {
  const parsed = toFiniteNumber(value);
  if (parsed === null) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function normalizeMaxAgeHours(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = toFiniteNumber(value);
  if (parsed === null || parsed <= 0) {
    return parsed !== null && parsed <= 0 ? null : fallback;
  }
  return parsed;
}

export function normalizeAlertRules(profile = {}) {
  const filters = profile.filtersJson ?? profile.filters_json ?? {};
  const minScore =
    normalizeScore(
      profile.alertMinScore ?? profile.alert_min_score ?? filters.alertMinScore ?? filters.alert_min_score,
      DEFAULT_ALERT_RULES.minScore
    ) ?? DEFAULT_ALERT_RULES.minScore;

  const minConfidence = normalizeConfidence(
    profile.alertMinConfidence ??
      profile.alert_min_confidence ??
      filters.alertMinConfidence ??
      filters.alert_min_confidence,
    DEFAULT_ALERT_RULES.minConfidence
  );

  const maxAgeHours = normalizeMaxAgeHours(
    profile.alertMaxAgeHours ??
      profile.alert_max_age_hours ??
      filters.alertMaxAgeHours ??
      filters.alert_max_age_hours ??
      filters.maxListingAgeHours,
    DEFAULT_ALERT_RULES.maxAgeHours
  );

  return { minScore, minConfidence, maxAgeHours };
}

export function listingAgeHours(item = {}, nowMs = Date.now()) {
  const timestampRaw =
    item.posted_at ?? item.postedAt ?? item.first_seen_at ?? item.firstSeenAt ?? item.last_seen_at ?? null;
  if (!timestampRaw) {
    return 0;
  }
  const timestamp = new Date(timestampRaw).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  return Math.max(0, (nowMs - timestamp) / 3_600_000);
}

export function meetsAlertRules({ profile, deal, item }, nowMs = Date.now()) {
  const rules = normalizeAlertRules(profile);
  const score = toFiniteNumber(deal?.score ?? deal?.deal_score);
  const confidence = toFiniteNumber(deal?.confidence ?? deal?.deal_confidence);
  const status = item?.status ?? item?.item_status;

  if (status && EXCLUDED_ALERT_STATUSES.has(status)) {
    return { ok: false, reason: `status ${status} is excluded`, rules };
  }
  if (score === null) {
    return { ok: false, reason: "missing deal score", rules };
  }
  if (score < rules.minScore) {
    return { ok: false, reason: `score ${score} below minimum ${rules.minScore}`, rules };
  }
  if (confidence === null) {
    return { ok: false, reason: "missing deal confidence", rules };
  }
  if (confidence < rules.minConfidence) {
    return { ok: false, reason: `confidence ${confidence} below minimum ${rules.minConfidence}`, rules };
  }
  if (rules.maxAgeHours !== null && rules.maxAgeHours !== undefined) {
    const ageHours = listingAgeHours(item ?? {}, nowMs);
    if (ageHours > rules.maxAgeHours) {
      return { ok: false, reason: `age ${ageHours.toFixed(1)}h exceeds maximum ${rules.maxAgeHours}h`, rules };
    }
  }
  return { ok: true, reason: "meets alert rules", rules };
}

// Never present a low-confidence listing as a confirmed good deal.
// The underlying verdict (Strong candidate, Fair value, ...) is kept for
// transparency, but `confirmed` stays false until confidence is adequate.
export function getDealDisplay({ score, confidence, verdict } = {}) {
  const numericScore = toFiniteNumber(score);
  const numericConfidence = toFiniteNumber(confidence);

  if (numericScore === null || numericConfidence === null) {
    return { label: "Unscored", confirmed: false, tone: "muted" };
  }

  if (numericConfidence < LOW_CONFIDENCE_THRESHOLD) {
    return { label: "Needs review – low confidence", confirmed: false, tone: "caution" };
  }

  const label = verdict || (numericScore >= 80 ? "Strong candidate" : numericScore >= 65 ? "Fair value" : "Neutral");
  const isGoodDeal = numericScore >= 65 && ["Strong candidate", "Fair value"].includes(label);
  const confirmed = isGoodDeal && numericConfidence >= CONFIRMED_DEAL_CONFIDENCE;

  return {
    label,
    confirmed,
    tone: confirmed ? "good" : label === "Likely overpriced or risky" ? "bad" : "muted"
  };
}
