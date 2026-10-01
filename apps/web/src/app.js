const statusOptions = ["new", "watching", "saved", "contacted", "rejected", "sold", "hidden"];
const savedApiBase = localStorage.getItem("ri.apiBase");
const pageIsRemote = !["localhost", "127.0.0.1"].includes(window.location.hostname);

const state = {
  apiBase: pageIsRemote ? window.location.origin : (savedApiBase || `http://${window.location.hostname}:10000`),
  apiToken: localStorage.getItem("ri.apiToken") || "",
  view: "dashboard",
  profiles: [],
  searchDefaults: { location: "Milpitas", radiusMiles: 50 },
  groups: [],
  listings: [],
  runs: [],
  deals: [],
  alerts: [],
  generations: [],
  facebookResults: [],
  locationChoices: [],
  selectedListing: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compactDate(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function money(value, fallback = "n/a") {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return `${value}`;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(number);
}

function numberOrNull(value) {
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getImageUrls(listing) {
  const urls =
    listing?.image_urls ??
    listing?.imageUrls ??
    listing?.images ??
    listing?.item?.image_urls ??
    listing?.item?.imageUrls ??
    listing?.item?.images ??
    [];
  const normalized = Array.isArray(urls) ? urls : [];
  const primary = listing?.imageUrl ?? listing?.item?.imageUrl;
  return primary && !normalized.includes(primary) ? [primary, ...normalized] : normalized;
}

function getAttrs(listing) {
  return listing?.parsed_attributes_json ?? listing?.parsedAttributesJson ?? {};
}

function titleFor(listing) {
  return listing?.title_raw ?? listing?.titleRaw ?? listing?.marketplace_listing_title ?? listing?.title ?? "Untitled listing";
}

function priceFor(listing) {
  const rawPrice = `${listing?.price_raw ?? ""}`.trim();
  const match = rawPrice.match(/^(?:US\s*)?\$\s*([\d,]+(?:\.\d{1,2})?)$/i);
  if (match) {
    const capturedPrice = Number(match[1].replaceAll(",", ""));
    if (Number.isFinite(capturedPrice)) return capturedPrice;
  }
  return listing?.current_price ?? listing?.currentPrice ?? listing?.price ?? null;
}

function sourceIdFor(listing) {
  return listing?.source_item_id ?? listing?.sourceItemId ?? listing?.listingId ?? listing?.id;
}

function dealScoreFor(listing) {
  const score = listing?.deal_score ?? listing?.dealScore ?? listing?.score;
  const confidence = listing?.deal_confidence ?? listing?.dealConfidence ?? listing?.confidence;
  const verdict = listing?.verdict;
  return { score: score ?? null, confidence: confidence ?? null, verdict: verdict ?? null };
}

function dealDisplay(listing) {
  const { score, confidence, verdict } = dealScoreFor(listing);
  const numericScore = score === null || score === undefined ? null : Number(score);
  const numericConfidence = confidence === null || confidence === undefined ? null : Number(confidence);
  if (numericScore === null || !Number.isFinite(numericScore) || numericConfidence === null || !Number.isFinite(numericConfidence)) {
    return { label: "Unscored", confirmed: false, tone: "muted", score: numericScore, confidence: numericConfidence };
  }
  if (numericConfidence < 0.5) {
    return { label: "Needs review – low confidence", confirmed: false, tone: "caution", score: numericScore, confidence: numericConfidence };
  }
  const label = verdict || (numericScore >= 80 ? "Strong candidate" : numericScore >= 65 ? "Fair value" : "Neutral");
  const isGoodDeal = numericScore >= 65 && ["Strong candidate", "Fair value"].includes(label);
  const confirmed = isGoodDeal && numericConfidence >= 0.6;
  return { label, confirmed, tone: confirmed ? "good" : "muted", score: numericScore, confidence: numericConfidence };
}

function explanationFor(listing) {
  const raw = listing?.explanation_json ?? listing?.explanationJson ?? listing?.explanation ?? [];
  if (Array.isArray(raw)) return raw.filter(Boolean).slice(0, 4);
  if (typeof raw === "string" && raw) return [raw];
  return [];
}

let compTransFilter = "all";
let detailLoadSequence = 0;
let activeDetailItemId = null;
const attemptedAutomaticCompFetches = new Set();

function formatMiles(value) {
  if (value === null || value === undefined || value === "") return "n/a";
  const miles = Number(value);
  if (!Number.isFinite(miles) || miles <= 0) return "n/a";
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(miles)} mi`;
}

function compChartSVG(comps, trend, listing, similarCompIds = new Set()) {
  const points = (comps ?? [])
    .map((comp) => ({
      id: comp.id,
      mileage: Number(comp.mileage),
      price: Number(comp.sold_price ?? comp.soldPrice),
      transmission: comp.transmission ?? "unknown"
    }))
    .filter((point) => Number.isFinite(point.mileage) && point.mileage > 0 && Number.isFinite(point.price) && point.price > 0);
  if (!trend || points.length < 3) {
    return `<p class="muted small">Not enough mileage data to draw the trend yet (${points.length} of ${comps?.length ?? 0} comps carry mileage).</p>`;
  }

  const width = 340;
  const height = 190;
  const padLeft = 46;
  const padRight = 10;
  const padTop = 10;
  const padBottom = 22;
  const listingMiles = Number(listing?.mileage);
  const listingPrice = Number(listing?.price);
  const domainMiles = [...points.map((p) => p.mileage)];
  if (Number.isFinite(listingMiles) && listingMiles > 0) {
    domainMiles.push(listingMiles);
  }
  const minX = Math.min(trend.minMileage, ...domainMiles);
  const maxX = Math.max(trend.maxMileage, ...domainMiles);
  const minY = Math.min(trend.minPrice, ...points.map((p) => p.y ?? p.price));
  const maxY = Math.max(trend.maxPrice, ...points.map((p) => p.y ?? p.price));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scaleX = (miles) => padLeft + ((miles - minX) / spanX) * (width - padLeft - padRight);
  const scaleY = (price) => padTop + (1 - (price - minY) / spanY) * (height - padTop - padBottom);

  const lineY1 = scaleY(trend.slope * minX + trend.intercept);
  const lineY2 = scaleY(trend.slope * maxX + trend.intercept);
  const dots = points
    .map((point) => {
      const tone = point.transmission === "manual" ? "dot-manual" : point.transmission === "automatic" ? "dot-auto" : "dot-unknown";
      const closeMiles = similarCompIds.has(point.id) ? " dot-similar-mileage" : "";
      return `<circle class="chart-dot ${tone}${closeMiles}" data-trans="${point.transmission}" cx="${scaleX(point.mileage).toFixed(1)}" cy="${scaleY(point.price).toFixed(1)}" r="4"><title>${money(point.price)} · ${formatMiles(point.mileage)} · ${point.transmission}</title></circle>`;
    })
    .join("");

  const marker =
    Number.isFinite(listingMiles) && listingMiles > 0 && Number.isFinite(listingPrice) && listingPrice > 0
      ? `<g><circle cx="${scaleX(listingMiles).toFixed(1)}" cy="${scaleY(listingPrice).toFixed(1)}" r="7" class="chart-you-ring" /><circle cx="${scaleX(listingMiles).toFixed(1)}" cy="${scaleY(listingPrice).toFixed(1)}" r="3.5" class="chart-you"><title>This listing: ${money(listingPrice)} · ${formatMiles(listingMiles)}</title></circle></g>`
      : "";

  return `
    <svg class="comp-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Sold price versus mileage">
      <line x1="${scaleX(minX)}" y1="${lineY1.toFixed(1)}" x2="${scaleX(maxX)}" y2="${lineY2.toFixed(1)}" class="chart-trend" />
      ${dots}
      ${marker}
      <text x="2" y="${(scaleY(maxY) + 4).toFixed(1)}" class="chart-axis">${money(maxY)}</text>
      <text x="2" y="${(scaleY(minY) + 4).toFixed(1)}" class="chart-axis">${money(minY)}</text>
      <text x="${padLeft}" y="${height - 6}" class="chart-axis">${formatMiles(minX)}</text>
      <text x="${(width - padRight).toFixed(1)}" y="${height - 6}" class="chart-axis chart-axis-right">${formatMiles(maxX)}</text>
    </svg>
    <div class="chart-legend">
      <button class="status-button${compTransFilter === "all" ? " is-active" : ""}" data-comp-trans="all" type="button">All</button>
      <button class="status-button${compTransFilter === "manual" ? " is-active" : ""}" data-comp-trans="manual" type="button">Manual</button>
      <button class="status-button${compTransFilter === "automatic" ? " is-active" : ""}" data-comp-trans="automatic" type="button">Auto</button>
      <span class="listing-meta">outlined dots = similar mileage · black ring = this listing · line = mileage trend (n=${trend.n})</span>
    </div>
  `;
}

function trendVerdict(trend) {
  if (!trend || trend.predicted === null || trend.diff === null) {
    return "";
  }
  const direction = trend.diff <= 0 ? "under" : "over";
  const pct = Math.abs(trend.diffPct * 100).toFixed(0);
  return `This listing sits ≈${money(Math.abs(trend.diff))} ${direction} the mileage trend (${pct}%).`;
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("is-visible");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("is-visible"), 3000);
}

function apiHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.apiToken) headers.Authorization = `Bearer ${state.apiToken}`;
  return headers;
}

async function api(path, options = {}) {
  const response = await fetch(`${state.apiBase}${path}`, {
    ...options,
    headers: apiHeaders({
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {})
    })
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned an unexpected response (HTTP ${response.status}). Please try again shortly.`);
  }
  if (!response.ok) {
    throw new Error(response.status === 401
      ? "Connection expired or access token missing. Open App access and connect again."
      : data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setView(view) {
  state.view = view;
  $$(".nav-button").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
  $$(".view").forEach((node) => node.classList.remove("is-visible"));
  $(`#${view}View`)?.classList.add("is-visible");
  $("#viewTitle").textContent = {
    dashboard: "Deals",
    profiles: "My Searches",
    listings: "Listings",
    runs: "Runs",
    generations: "Car generations"
  }[view];
}

async function loadVehicleGenerations() {
  const data = await api("/vehicle-generations");
  state.generations = data.generations ?? [];
  $("#generationCount").textContent = state.generations.length;
  const selector = $("#profileGenerationInput");
  if (selector) {
    const selected = selector.value;
    selector.innerHTML = `<option value="">Any generation</option>${state.generations.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.make)} ${escapeHtml(item.model)} · ${escapeHtml(item.code)} (${item.yearFrom}–${item.yearTo})</option>`).join("")}`;
    if (state.generations.some((item) => item.id === selected)) selector.value = selected;
  }
  $("#vehicleGenerationsList").innerHTML = state.generations.map((item) => `
    <article class="profile-card"><div><div class="profile-name">${escapeHtml(item.make)} ${escapeHtml(item.model)} · ${escapeHtml(item.code)}</div><div class="profile-meta">${item.yearFrom}–${item.yearTo} · ${item.source === "suggested" ? "Suggested" : "Custom"}</div></div>
    <div class="profile-actions"><button class="status-button" data-edit-generation="${escapeHtml(item.id)}" type="button">Edit</button><button class="status-button" data-delete-generation="${escapeHtml(item.id)}" type="button">Delete</button></div></article>
  `).join("") || `<div class="empty-state">No generations yet. Add a make, model, code, and year range above.</div>`;
}

function resetGenerationForm() {
  $("#generationForm").reset();
  $("#generationIdInput").value = "";
  $("#generationSaveButton").textContent = "Add generation";
  $("#generationCancelButton").hidden = true;
}

async function loadProfiles() {
  const data = await api("/profiles");
  state.profiles = data.profiles ?? [];
  const members = $("#groupMembers");
  if (members) members.innerHTML = state.profiles.map((profile) => `<label class="checkbox-row"><input type="checkbox" name="groupProfile" value="${escapeHtml(profile.id)}"/><span>${escapeHtml(profile.query)}</span></label>`).join("") || `<span class="muted small">Save searches first; you can also add them to a group later.</span>`;
  renderProfiles();
}

async function loadSearchDefaults() {
  const data = await api("/search-defaults");
  state.searchDefaults = data.defaults ?? state.searchDefaults;
  $("#defaultLocationInput").value = state.searchDefaults.location;
  $("#defaultRadiusInput").value = state.searchDefaults.radiusMiles;
  if (!$("#profileIdInput").value) {
    $("#profileLocationInput").value = state.searchDefaults.location;
    $("#profileRadiusInput").value = state.searchDefaults.radiusMiles;
  }
}

async function saveSearchDefaults(event) {
  event.preventDefault();
  try {
    const data = await api("/search-defaults", { method: "PUT", body: JSON.stringify({ location: $("#defaultLocationInput").value, radiusMiles: numberOrNull($("#defaultRadiusInput").value) }) });
    state.searchDefaults = data.defaults;
    if (!$("#profileIdInput").value) {
      $("#profileLocationInput").value = data.defaults.location;
      $("#profileRadiusInput").value = data.defaults.radiusMiles;
    }
    toast("Default search area saved");
  } catch (error) { toast(error.message); }
}

async function loadGroups() {
  state.groups = (await api("/search-groups")).groups ?? [];
  const selector = $("#profileGroupInput");
  if (selector) {
    const selected = selector.value;
    selector.innerHTML = `<option value="">No group</option>` + state.groups.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("");
    selector.value = selected;
  }
  renderGroups();
  renderProfiles();
}

async function loadListings() {
  const params = new URLSearchParams();
  const filters = [
    ["q", $("#filterSearch")?.value.trim()],
    ["status", $("#filterStatus")?.value],
    ["sort", $("#filterSort")?.value],
    ["make", $("#filterMake")?.value],
    ["model", $("#filterModel")?.value],
    ["transmission", $("#filterTransmission")?.value],
    ["minPrice", $("#filterMinPrice")?.value],
    ["maxPrice", $("#filterMaxPrice")?.value],
    ["yearMin", $("#filterYearMin")?.value],
    ["yearMax", $("#filterYearMax")?.value],
    ["limit", "100"]
  ];
  for (const [key, value] of filters) {
    if (value) params.set(key, value);
  }
  const data = await api(`/listings?${params.toString()}`);
  state.listings = data.listings ?? [];
  renderListings();
  renderDashboard();
}

async function loadRuns() {
  const data = await api("/runs?limit=50");
  state.runs = data.runs ?? [];
  renderRuns();
  renderDashboard();
}

async function loadDeals() {
  const data = await api("/deals?limit=10");
  state.deals = data.deals ?? [];
  renderDeals();
}

async function loadAlerts() {
  const data = await api("/alerts?limit=20");
  state.alerts = data.alerts ?? [];
  renderAlerts();
}

async function markAlertRead(alertId) {
  await api(`/alerts/${alertId}/read`, { method: "PATCH" });
  toast("Alert marked read");
  await loadAlerts();
}

function showActionStatus(id, message) {
  const node = $(id);
  node.textContent = message;
  node.hidden = !message;
}

async function reloadSearchResults() {
  const results = await Promise.allSettled([loadListings(), loadRuns(), loadDeals(), loadAlerts()]);
  return results.filter((result) => result.status === "rejected").map((result) => result.reason.message);
}

async function refreshAll() {
  const button = $("#refreshButton");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Refreshing…";
  showActionStatus("#refreshStatus", "Refreshing saved data…");
  try {
    const results = await Promise.allSettled([loadProfiles(), loadGroups(), loadListings(), loadRuns(), loadDeals(), loadAlerts(), loadSearchDefaults(), loadVehicleGenerations()]);
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason.message);
    showActionStatus("#refreshStatus", errors.length
      ? `Refresh incomplete: ${[...new Set(errors)].join("; ")}`
      : "Saved data refreshed. Use Run all saved to search Facebook for new listings.");
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

async function runAllSaved() {
  const button = $("#syncAllButton");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Starting…";
  showActionStatus("#syncStatus", "Loading saved searches…");
  try {
    await loadProfiles();
    const profiles = state.profiles.filter((profile) => profile.enabled);
    if (!profiles.length) {
      showActionStatus("#syncStatus", "No enabled saved searches. Save or enable a search in My Searches first.");
      return;
    }
    let completed = 0;
    let newItems = 0;
    const failures = [];
    const refreshErrors = new Set();
    for (const [index, profile] of profiles.entries()) {
      const name = profile.name || profile.query;
      button.textContent = `Running ${index + 1}/${profiles.length}…`;
      showActionStatus("#syncStatus", `Searching ${index + 1} of ${profiles.length}: ${name}.`);
      try {
        const data = await api(`/profiles/${encodeURIComponent(profile.id)}/run`, { method: "POST" });
        if (data.run?.status === "failed") throw new Error(data.run.errorMessage || "Search failed");
        completed += 1;
        newItems += data.run?.newItems ?? 0;
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
      for (const message of await reloadSearchResults()) refreshErrors.add(message);
    }
    showActionStatus("#syncStatus", `${completed} of ${profiles.length} searches completed. ${newItems} new listings.`
      + (failures.length ? ` Failed searches: ${failures.join("; ")}` : "")
      + (refreshErrors.size ? ` Could not refresh all results: ${[...refreshErrors].join("; ")}` : ""));
  } catch (error) {
    showActionStatus("#syncStatus", `Could not run saved searches: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Run all saved";
  }
}

function thumbnail(listing, className = "thumb") {
  const [first] = getImageUrls(listing);
  if (!first) return `<div class="${className} thumb-placeholder">RI</div>`;
  // fbcdn hotlinks can 403 based on referrer; omit it. A delegated capture-phase
  // error listener swaps any still-broken image for a placeholder.
  return `<img class="${className}" src="${escapeHtml(first)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
}

function statusPill(status) {
  const safeStatus = escapeHtml(status ?? "new");
  return `<span class="status-pill ${safeStatus}">${safeStatus}</span>`;
}

function vehicleLabel(listing) {
  const attrs = getAttrs(listing);
  return [attrs.year, attrs.make, attrs.model, attrs.trim, attrs.transmission].filter(Boolean).join(" ") || "n/a";
}

function renderProfiles() {
  $("#profilesCount").textContent = state.profiles.length;
  $("#profilesList").innerHTML =
    state.profiles
      .map((profile) => {
        const groupName = state.groups.find((group) => group.id === profile.groupId)?.name;
        return `
          <article class="profile-card">
            <div>
              <div class="profile-name">${escapeHtml(profile.query)}</div>
              <div class="profile-meta">${escapeHtml(profile.location)} · ${profile.radiusMiles} mi${groupName ? ` · ${escapeHtml(groupName)}` : ""}</div>
            </div>
            <div class="profile-actions">
              <button class="status-button" data-edit-profile="${profile.id}" type="button">Edit</button>
              <button class="status-button" data-run-profile="${profile.id}" type="button">Run</button>
              <details class="profile-overflow"><summary>More</summary><div class="profile-actions"><button class="status-button" data-toggle-profile="${profile.id}" type="button">${profile.enabled ? "Pause" : "Enable"}</button><button class="status-button" data-delete-profile="${profile.id}" type="button">Delete</button></div></details>
            </div>
          </article>
        `;
      })
      .join("") || `<div class="empty-state">No profiles yet.</div>`;
}

function renderGroups() {
  const target = $("#groupsList");
  if (!target) return;
  target.innerHTML = state.groups.map((group) => `<article class="profile-card"><div><div class="profile-name">${escapeHtml(group.name)}</div><div class="profile-meta">${group.profiles.length} searches${group.nextRunAt ? ` · next ${compactDate(group.nextRunAt)}` : ""}</div><div class="profile-meta">${group.profiles.map((p) => escapeHtml(p.query)).join(" + ")}</div></div><div class="profile-actions"><label><span class="muted small">Schedule</span><select data-group-schedule="${escapeHtml(group.id)}"><option value="0" ${group.intervalMinutes === 0 ? "selected" : ""}>Manual</option><option value="60" ${group.intervalMinutes === 60 ? "selected" : ""}>Hourly</option><option value="180" ${group.intervalMinutes === 180 ? "selected" : ""}>Every 3 hours</option><option value="360" ${group.intervalMinutes === 360 ? "selected" : ""}>Every 6 hours</option><option value="720" ${group.intervalMinutes === 720 ? "selected" : ""}>Every 12 hours</option><option value="1440" ${group.intervalMinutes === 1440 ? "selected" : ""}>Daily</option></select></label><button class="status-button" data-save-group-schedule="${escapeHtml(group.id)}" type="button">Save schedule</button><button class="status-button" data-run-group="${escapeHtml(group.id)}" type="button">Run group</button></div></article>`).join("") || `<div class="empty-state">Create a group to combine related searches, such as BRZ + FR-S.</div>`;
}

function renderListings() {
  $("#listingsCount").textContent = state.listings.length;
  const body = $("#listingsTableBody");
  body.innerHTML =
    state.listings
      .map((listing) => {
        const attrs = getAttrs(listing);
        return `
          <tr>
            <td data-label="Listing">
              <div class="listing-title" data-open-detail="${listing.id}" role="button" tabindex="0" title="Open details">
                ${thumbnail(listing)}
                <div>
                  <div class="listing-name">${escapeHtml(titleFor(listing))}</div>
                  <div class="listing-meta">${escapeHtml(listing.location_raw ?? "n/a")} · ${escapeHtml(listing.seller_raw ?? "unknown seller")}</div>
                </div>
              </div>
            </td>
            <td data-label="Price"><strong>${money(priceFor(listing), listing.price_raw ?? "n/a")}</strong></td>
            <td data-label="Vehicle">
              <div>${escapeHtml(vehicleLabel(listing))}</div>
              ${listing.generation ? `<div class="listing-meta">${escapeHtml(listing.generation.code)} generation</div>` : ""}
              <div class="listing-meta">${escapeHtml(attrs.mileage ?? attrs.miles ?? "")}</div>
            </td>
            <td data-label="Status">${statusPill(listing.status)}</td>
            <td data-label="Posted">${listing.posted_at ? compactDate(listing.posted_at) : "Date unavailable"}</td>
            <td data-label="Actions">
              <div class="actions-cell">
                <button class="status-button" data-detail="${listing.id}" type="button">Details</button>
                <button class="status-button" data-set-status="${listing.id}" data-status="watching" type="button">Watch</button>
                <button class="status-button" data-set-status="${listing.id}" data-status="saved" type="button">Save</button>
                <button class="status-button" data-set-status="${listing.id}" data-status="rejected" type="button">Reject</button>
                <button class="status-button" data-delete-listing="${listing.id}" type="button">Delete</button>
              </div>
            </td>
          </tr>
        `;
      })
      .join("") || `<tr><td colspan="6" class="empty-state">No listings match these filters.</td></tr>`;
}

function renderRuns() {
  $("#runsTableBody").innerHTML =
    state.runs
      .map((run) => `
        <tr>
          <td data-label="Started">${compactDate(run.started_at)}</td>
          <td data-label="Status">${statusPill(run.status)}</td>
          <td data-label="Results">${run.results_found ?? 0}</td>
          <td data-label="New">${run.new_items ?? 0}</td>
          <td data-label="Existing">${run.existing_items ?? 0}</td>
          <td data-label="Details">${run.detail_pages_opened ?? 0}</td>
          <td data-label="Error" class="small">${escapeHtml(run.error_message ?? "")}</td>
        </tr>
      `)
      .join("") || `<tr><td colspan="7" class="empty-state">No runs yet.</td></tr>`;

}

function renderDashboard() {
  // Deals is the home feed; general listings and run history live in their own views.
}

function renderDeals() {
  const node = $("#topDeals");
  if (!node) return;
  $("#dealsCount").textContent = state.deals.length;
  node.innerHTML =
    state.deals
      .map((deal) => {
        const display = dealDisplay(deal);
        const reasons = explanationFor(deal).slice(0, 2);
        const scoreText = display.score !== null ? `Score ${display.score}` : "Unscored";
        const confText = display.confidence !== null ? `Conf ${Number(display.confidence).toFixed(2)}` : "Conf n/a";
        return `
          <article class="listing-card deal-card" data-open-detail="${deal.id}" role="button" tabindex="0" title="Open details">
            ${thumbnail(deal)}
            <div>
              <div class="listing-card-header">
                <strong>${escapeHtml(titleFor(deal))}</strong>
                <span>${money(priceFor(deal), deal.price_raw ?? "n/a")}</span>
              </div>
              <div class="listing-meta">${escapeHtml(deal.location_raw ?? "n/a")} · ${scoreText} · ${confText}${deal.generation ? ` · ${escapeHtml(deal.generation.code)} generation` : ""}</div>
              <div class="tag-list">
                <span class="tag ${display.tone === "good" ? "" : display.tone === "caution" ? "alert" : ""}">${escapeHtml(display.label)}${display.confirmed ? " · confirmed" : ""}</span>
              </div>
              ${reasons.length ? `<div class="listing-meta">${reasons.map((reason) => `• ${escapeHtml(reason)}`).join("<br />")}</div>` : ""}
              <div class="profile-actions">
                <button class="status-button" data-detail="${deal.id}" type="button">Details</button>
                ${deal.url ? `<a class="status-button" href="${escapeHtml(deal.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
              </div>
            </div>
          </article>
        `;
      })
      .join("") || `<div class="empty-state">No scored deals yet. Run a profile to generate deal scores.</div>`;
}

function renderAlerts() {
  const node = $("#dealAlerts");
  if (!node) return;
  const unread = state.alerts.filter((alert) => !alert.read_at).length;
  $("#alertsCount").textContent = unread ? `${unread} unread` : `${state.alerts.length}`;
  node.innerHTML =
    state.alerts
      .map((alert) => {
        const display = dealDisplay({ deal_score: alert.deal_score, deal_confidence: alert.deal_confidence, verdict: alert.verdict });
        const price = alert.current_price ?? alert.price_raw ?? "n/a";
        return `
          <article class="listing-card ${alert.read_at ? "is-read" : ""}" data-open-detail="${alert.item_id}" role="button" tabindex="0" title="Open details">
            ${thumbnail({ image_urls: alert.image_urls, imageUrls: alert.image_urls })}
            <div>
              <div class="listing-card-header">
                <strong>${escapeHtml(alert.title_raw ?? "Alert")}</strong>
                <span>${money(price, alert.price_raw ?? "n/a")}</span>
              </div>
              <div class="listing-meta">${escapeHtml(alert.profile_name ?? "")} · Score ${alert.deal_score ?? "n/a"} · Conf ${alert.deal_confidence ?? "n/a"} · ${escapeHtml(display.label)}</div>
              <div class="profile-actions">
                <button class="status-button" data-detail="${alert.item_id}" type="button">Details</button>
                ${alert.url ? `<a class="status-button" href="${escapeHtml(alert.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
                ${alert.read_at ? `<span class="listing-meta">Read</span>` : `<button class="status-button" data-mark-alert-read="${alert.id}" type="button">Mark read</button>`}
              </div>
            </div>
          </article>
        `;
      })
      .join("") || `<div class="empty-state">No alerts yet. Alerts appear here when a completed search meets a profile’s rules.</div>`;
}

function listingCard(listing, source) {
  const openAttr =
    source === "facebook"
      ? `data-open-fb-detail="${sourceIdFor(listing)}"`
      : `data-open-detail="${listing.id}"`;
  return `
    <article class="listing-card" ${openAttr} role="button" tabindex="0" title="Open details">
      ${thumbnail(listing)}
      <div>
        <div class="listing-card-header">
          <strong>${escapeHtml(titleFor(listing))}</strong>
          <span>${money(priceFor(listing), listing.price_raw ?? listing.formattedPrice ?? "n/a")}</span>
        </div>
        <div class="listing-meta">${escapeHtml(listing.location_raw ?? listing.locationText ?? "n/a")}</div>
        <div class="profile-actions">
          ${listing.status ? statusPill(listing.status) : ""}
          <button class="status-button" data-${source === "facebook" ? "facebook-detail" : "detail"}="${source === "facebook" ? sourceIdFor(listing) : listing.id}" type="button">Details</button>
          ${listing.url ? `<a class="status-button" href="${escapeHtml(listing.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderFacebookResults() {
  $("#facebookResultsCount").textContent = state.facebookResults.length;
  $("#facebookResults").innerHTML =
    state.facebookResults.map((listing) => listingCard(listing, "facebook")).join("") ||
    `<div class="empty-state">Search Marketplace directly to inspect live cards.</div>`;
}

function renderLocationChoices() {
  $("#locationChoices").innerHTML = state.locationChoices
    .slice(0, 5)
    .map((location) => `
      <button class="location-choice" data-location-lat="${location.latitude}" data-location-lng="${location.longitude}" type="button">
        <strong>${escapeHtml(location.name ?? "Location")}</strong>
        <div class="listing-meta">${escapeHtml(location.subtitle ?? "")} ${location.latitude}, ${location.longitude}</div>
      </button>
    `)
    .join("");
}

function detailSectionsFromItem(payload) {
  const item = payload.item ?? payload;
  return {
    item,
    priceHistory: payload.priceHistory ?? [],
    parseEvidence: payload.parseEvidence ?? [],
    modifications: payload.modifications ?? []
  };
}

function renderDetail(payload) {
  const { item, priceHistory, parseEvidence, modifications } = detailSectionsFromItem(payload);
  const comps = Array.isArray(payload.comps) ? payload.comps : [];
  const generation = payload.compGeneration ?? null;
  const yearWindow = payload.compYearWindow ?? null;
  const trend = payload.compTrend ?? null;
  const similarMileageComps = Array.isArray(payload.similarMileageComps) ? payload.similarMileageComps : [];
  const similarCompIds = new Set(similarMileageComps.map((comp) => comp.id));
  const matchLabel = generation
    ? `${generation.label} (${generation.from}–${generation.to}) · matched to this car`
    : yearWindow
      ? `Model years ${yearWindow.from}–${yearWindow.to} · matched to this car`
      : "";
  const listingMileage = getAttrs(item).mileage ?? null;
  const chartHtml = compChartSVG(comps, trend, { mileage: listingMileage, price: priceFor(item) }, similarCompIds);
  const verdict = trendVerdict(trend);
  const compPrices = comps.map((comp) => Number(comp.sold_price)).filter((price) => Number.isFinite(price) && price > 0);
  const compMedian = compPrices.length
    ? compPrices.sort((a, b) => a - b)[Math.floor(compPrices.length / 2)]
    : null;
  const attrs = getAttrs(item);
  const flags = item.red_flags_json ?? item.redFlagsJson ?? [];
  const signals = item.positive_signals_json ?? item.positiveSignalsJson ?? [];
  const urls = getImageUrls(item);
  $("#detailPanel").classList.add("has-listing");
  $("#detailPanel").setAttribute("aria-hidden", "false");
  $("#detailPanel").removeAttribute("inert");
  document.body.classList.add("detail-open");
  $("#detailPanel").innerHTML = `
    <div class="detail-panel-header">
      <span>Listing details</span>
      <button class="detail-close" type="button" aria-label="Close listing details" title="Close">×</button>
    </div>
    <div class="detail-hero">
      ${urls[0] ? `<img id="detailHeroImage" class="detail-image" src="${escapeHtml(urls[0])}" alt="" referrerpolicy="no-referrer" />` : `<div class="detail-image thumb-placeholder">No image</div>`}
      ${urls.length > 1 ? `<div class="detail-thumbs">${urls.slice(1, 7).map((url) => `<button class="detail-thumb" data-detail-thumb="${escapeHtml(url)}" type="button"><img src="${escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></button>`).join("")}${urls.length > 7 ? `<span class="listing-meta">+${urls.length - 7} more</span>` : ""}</div>` : ""}
      <div>
        <h2>${escapeHtml(titleFor(item))}</h2>
        <div class="price-line">${money(priceFor(item), item.price_raw ?? item.formattedPrice ?? "n/a")}</div>
        <p class="muted">${escapeHtml(item.location_raw ?? item.locationText ?? "n/a")} · ${escapeHtml(item.seller_raw ?? item.sellerName ?? "unknown seller")}</p>
      </div>
      <div class="detail-actions">
        ${item.status ? statusPill(item.status) : ""}
        ${item.id && item.status ? `<button class="status-button" data-delete-listing="${escapeHtml(item.id)}" type="button">Delete listing</button>` : ""}
        ${payload.generation ? `<span class="tag">${escapeHtml(payload.generation.code)} generation</span>` : ""}
        ${item.url ? `<a class="secondary-button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
      </div>
    </div>
    <section class="detail-section">
      <h3>Description</h3>
      <p>${escapeHtml(item.description_raw ?? item.description ?? "No description captured yet.")}</p>
    </section>
    <section class="detail-section">
      <h3>Parsed Attributes</h3>
      <div class="kv-grid">
        ${Object.entries(attrs).map(([key, value]) => `<div class="kv"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("") || `<p class="muted">No attributes parsed.</p>`}
      </div>
    </section>
    <section class="detail-section">
      <h3>Signals</h3>
      <div class="tag-list">
        ${flags.map((flag) => `<span class="tag alert">${escapeHtml(flag)}</span>`).join("")}
        ${signals.map((signal) => `<span class="tag">${escapeHtml(signal)}</span>`).join("") || `<span class="muted">No signals yet.</span>`}
      </div>
    </section>
    <section class="detail-section">
      <h3>Auction comps (BaT / Cars &amp; Bids)</h3>
      ${matchLabel ? `<div class="listing-meta">${escapeHtml(matchLabel)}</div>` : ""}
      ${payload.compLoading ? `<p class="muted small">Finding completed auctions for this model and year range…</p>` : ""}
      ${payload.compError ? `<p class="tag alert">${escapeHtml(payload.compError)}</p>` : ""}
      ${chartHtml}
      ${verdict ? `<div class="run-row"><strong>${escapeHtml(verdict)}</strong></div>` : ""}
      ${compMedian !== null ? `<div class="run-row"><strong>${money(payload.compMedianSoldPrice ?? compMedian)}</strong><span class="run-meta">same-model, similar-year median · ${comps.length} sales</span></div>` : !payload.compLoading ? `<p class="muted">No completed auction comps found yet. You can retry the fetch or add a sale below.</p>` : ""}
      ${similarMileageComps.length ? `<div class="run-row"><strong>${money(payload.similarMileageMedian)}</strong><span class="run-meta">similar mileage · ${similarMileageComps.length} sale${similarMileageComps.length === 1 ? "" : "s"}${payload.mileageWindow ? ` · ${formatMiles(payload.mileageWindow.from)}–${formatMiles(payload.mileageWindow.to)}` : ""}</span></div>` : listingMileage && comps.length ? `<p class="muted small">No saved auction sales fall near this listing’s ${formatMiles(Number(listingMileage))} mileage yet.</p>` : ""}
      <div class="run-stack">
        ${comps.map((comp) => `
          <div class="run-card">
            <div class="run-row">
              <strong>${money(comp.sold_price)}</strong>
              <span class="run-meta">${escapeHtml(comp.source === "bat" ? "BaT" : comp.source === "cars_and_bids" ? "C&B" : comp.source)}${comp.sold_at ? ` · ${compactDate(comp.sold_at)}` : ""}</span>
            </div>
            ${comp.title_raw ? `<div>${escapeHtml(comp.title_raw)}</div>` : ""}
            <div class="run-meta">${formatMiles(Number(comp.mileage))}${comp.transmission && comp.transmission !== "unknown" ? ` · ${escapeHtml(comp.transmission)}` : ""}${similarCompIds.has(comp.id) ? " · similar mileage" : ""}</div>
            <div class="profile-actions">
              ${comp.url ? `<a class="status-button" href="${escapeHtml(comp.url)}" target="_blank" rel="noreferrer">Open</a>` : ""}
              <button class="status-button" data-delete-comp="${comp.id}" data-comp-item="${item.id}" type="button">Remove</button>
            </div>
          </div>
        `).join("")}
      </div>
      <div class="comp-form">
        <div class="profile-actions">
          <strong>Pull past results automatically</strong>
          <button class="secondary-button" data-fetch-comps="${item.id}" type="button">Fetch BaT + C&amp;B</button>
        </div>
        <p class="muted small">Fetches sold results for this car's make/model from Bring a Trailer and Cars &amp; Bids. Anything missing can still be pasted manually below.</p>
        <label>
          <span>Source</span>
          <select id="compSource">
            <option value="bat">Bring a Trailer</option>
            <option value="cars_and_bids">Cars &amp; Bids</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label>
          <span>Result title</span>
          <input id="compTitle" placeholder="2013 Scion FR-S — sold" />
        </label>
        <label>
          <span>Result URL</span>
          <input id="compUrl" type="url" placeholder="https://bringatrailer.com/..." />
        </label>
        <div class="inline-fields comp-fields">
          <label>
            <span>Sold $</span>
            <input id="compPrice" type="number" min="1" required placeholder="12500" />
          </label>
          <label>
            <span>Sold date</span>
            <input id="compDate" type="date" />
          </label>
        </div>
        <div class="inline-fields comp-fields">
          <label>
            <span>Miles (optional)</span>
            <input id="compMileage" type="number" min="1" placeholder="65000" />
          </label>
          <label>
            <span>Gearbox</span>
            <select id="compTrans">
              <option value="unknown">Unknown</option>
              <option value="manual">Manual</option>
              <option value="automatic">Automatic</option>
            </select>
          </label>
        </div>
        <button class="secondary-button" data-save-comp="${item.id}" type="button">Add comp</button>
      </div>
    </section>
    <section class="detail-section">
      <h3>Price History</h3>
      <div class="run-stack">
        ${priceHistory.map((entry) => `<div class="run-row"><strong>${money(entry.price)}</strong><span class="run-meta">${compactDate(entry.captured_at)}</span></div>`).join("") || `<p class="muted">No price history yet.</p>`}
      </div>
    </section>
    <section class="detail-section">
      <h3>Modifications</h3>
      <div class="tag-list">
        ${modifications.map((mod) => `<span class="tag">${escapeHtml(mod.mod_name ?? mod.modName)}</span>`).join("") || `<span class="muted">No modifications detected.</span>`}
      </div>
    </section>
    <section class="detail-section">
      <h3>Parse Evidence</h3>
      <div class="run-stack">
        ${parseEvidence.slice(0, 12).map((row) => `<div class="run-card"><strong>${escapeHtml(row.field)}</strong><div class="run-meta">${escapeHtml(row.evidence_text)}</div></div>`).join("") || `<p class="muted">No parse evidence yet.</p>`}
      </div>
    </section>
    <footer class="detail-freshness">
      <span>Listed ${item.posted_at ? compactDate(item.posted_at) : "date unavailable"}</span>
      <span>Last refreshed ${compactDate(item.last_scraped_at ?? item.last_seen_at)}</span>
    </footer>
  `;
}

function closeListingDetail() {
  activeDetailItemId = null;
  detailLoadSequence += 1;
  const panel = $("#detailPanel");
  panel.classList.remove("has-listing");
  panel.setAttribute("aria-hidden", "true");
  panel.setAttribute("inert", "");
  document.body.classList.remove("detail-open");
}

async function saveProfile(event) {
  event.preventDefault();
  const profileId = $("#profileIdInput").value;
  const body = {
    name: $("#profileQueryInput").value.trim(),
    category: "vehicle",
    query: $("#profileQueryInput").value,
    location: $("#profileLocationInput").value,
    radiusMiles: numberOrNull($("#profileRadiusInput").value) ?? 50,
    minPrice: numberOrNull($("#profileMinPriceInput").value),
    maxPrice: numberOrNull($("#profileMaxPriceInput").value),
    enabled: $("#profileEnabledInput").checked,
    alertMinScore: numberOrNull($("#profileAlertScoreInput")?.value) ?? 70,
    alertMinConfidence: numberOrNull($("#profileAlertConfidenceInput")?.value) ?? 0.5,
    alertMaxAgeHours: numberOrNull($("#profileAlertAgeInput")?.value) ?? 72,
    groupId: $("#profileGroupInput")?.value || null,
    filtersJson: {
      generation: selectedGenerationForProfile(),
      transmission: $("#profileTransmissionInput").value || undefined,
      yearMin: numberOrNull($("#profileYearMinInput").value),
      yearMax: numberOrNull($("#profileYearMaxInput").value),
      maxMileage: numberOrNull($("#profileMaxMileageInput").value),
      cleanTitleOnly: $("#profileCleanTitleInput").checked,
      modifiedOnly: $("#profileModifiedInput").checked
    }
  };
  try {
    const result = await api(profileId ? `/profiles/${profileId}` : "/profiles", {
      method: profileId ? "PATCH" : "POST",
      body: JSON.stringify(body)
    });
    const savedId = result.profile.id;
    resetProfileForm();
    await Promise.all([loadProfiles(), loadGroups()]);
    if (event.submitter?.dataset.runNow) await runProfile(savedId);
    else toast("Search saved. Run it now or add it to a group for scheduled runs.");
  } catch (error) {
    toast(error.message);
  }
}

function selectedGenerationForProfile() {
  const id = $("#profileGenerationInput")?.value;
  const generation = state.generations.find((item) => item.id === id);
  return generation ? {
    id: generation.id,
    make: generation.make,
    model: generation.model,
    code: generation.code,
    yearFrom: generation.yearFrom,
    yearTo: generation.yearTo
  } : undefined;
}

function chooseProfileGeneration(generationId) {
  const generation = state.generations.find((item) => item.id === generationId);
  if (!generation) return;
  $("#profileQueryInput").value = `${generation.make} ${generation.model}`;
  $("#profileYearMinInput").value = generation.yearFrom;
  $("#profileYearMaxInput").value = generation.yearTo;
}

function resetProfileForm() {
  $("#profileIdInput").value = "";
  $("#searchEditor").open = false;
  $("#searchEditorSummary").textContent = "Add a search";
  $("#profileForm").reset();
  $("#profileLocationInput").value = state.searchDefaults.location;
  $("#profileRadiusInput").value = state.searchDefaults.radiusMiles;
  $("#profileEnabledInput").checked = true;
  $("#profileGenerationInput").value = "";
  $("#profileTransmissionInput").value = "";
  $("#profileYearMinInput").value = "";
  $("#profileYearMaxInput").value = "";
  $("#profileMaxMileageInput").value = "";
  $("#profileCleanTitleInput").checked = false;
  $("#profileModifiedInput").checked = false;
  const scoreInput = $("#profileAlertScoreInput");
  if (scoreInput) scoreInput.value = "70";
  const confInput = $("#profileAlertConfidenceInput");
  if (confInput) confInput.value = "0.5";
  const ageInput = $("#profileAlertAgeInput");
  if (ageInput) ageInput.value = "72";
  if ($("#profileGroupInput")) $("#profileGroupInput").value = "";
}

async function runProfile(profileId, button) {
  const originalLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Running...";
  }
  toast("Searching Facebook Marketplace...");
  try {
    const data = await api(`/profiles/${profileId}/run`, { method: "POST" });
    const found = data.run.resultsFound ?? 0;
    const diagnostic = data.run.diagnostics;
    toast(
      diagnostic?.cursorPlaceholderCount > 0
        ? `Facebook returned ${diagnostic.cursorPlaceholderCount} listing IDs without card fields; loaded ${data.run.detailPagesOpened ?? 0} details.`
        : found === 0 && diagnostic
        ? `No listings parsed (feed edges: ${diagnostic.edgeCount ?? 0}). Check the Facebook response format.`
        : `Run finished: ${found} results, ${data.run.newItems ?? 0} new, ${data.run.alertsCreated ?? 0} alerts`
    );
    await Promise.all([loadListings(), loadRuns(), loadDeals(), loadAlerts()]);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function removeListing(itemId, button) {
  if (!window.confirm("Delete this listing from Resale Intelligence? Its saved history, comps, and alerts will also be removed. This cannot be undone. The Facebook listing is unaffected, and a later search may import it again.")) return;
  button.disabled = true;
  try {
    await api(`/listings/${encodeURIComponent(itemId)}`, { method: "DELETE" });
    if (activeDetailItemId === itemId) closeListingDetail();
    attemptedAutomaticCompFetches.delete(itemId);
    toast("Listing deleted");
    await Promise.all([loadListings(), loadDeals(), loadAlerts()]);
  } finally {
    button.disabled = false;
  }
}

async function updateStatus(itemId, status) {
  await api(`/listings/${itemId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
  toast(`Marked ${status}`);
  await loadListings();
}

async function showListingDetail(itemId) {
  const sequence = ++detailLoadSequence;
  activeDetailItemId = itemId;
  const data = await api(`/listings/${itemId}`);
  if (sequence !== detailLoadSequence) return;
  let compsData = await api(`/listings/${itemId}/comps`).catch(() => ({ comps: [] }));
  if (sequence !== detailLoadSequence) return;
  const needsFirstFetch = !(compsData.comps ?? []).length && !attemptedAutomaticCompFetches.has(itemId);
  const render = (compLoading = false, compError = "") => renderDetail({
    ...data,
    ...compsData,
    comps: compsData.comps ?? [],
    compGeneration: compsData.generation ?? null,
    compYearWindow: compsData.yearWindow ?? null,
    compTrend: compsData.trend ?? null,
    compLoading,
    compError
  });
  render(needsFirstFetch);
  if (needsFirstFetch) {
    attemptedAutomaticCompFetches.add(itemId);
    try {
      const fetched = await api(`/listings/${itemId}/comps/fetch`, { method: "POST" });
      compsData = await api(`/listings/${itemId}/comps`).catch(() => ({ comps: fetched.comps ?? [] }));
      if (sequence === detailLoadSequence && activeDetailItemId === itemId) render(false);
    } catch (error) {
      if (sequence === detailLoadSequence && activeDetailItemId === itemId) render(false, `Automatic auction lookup failed: ${error.message}`);
    }
  }
}

async function saveComp(itemId) {
  const body = {
    source: $("#compSource")?.value ?? "bat",
    title: $("#compTitle")?.value ?? "",
    url: $("#compUrl")?.value ?? "",
    soldPrice: numberOrNull($("#compPrice")?.value ?? ""),
    soldAt: $("#compDate")?.value ?? "",
    mileage: numberOrNull($("#compMileage")?.value ?? ""),
    transmission: $("#compTrans")?.value ?? "unknown"
  };
  if (!Number.isFinite(body.soldPrice) || body.soldPrice <= 0) {
    toast("Enter a sold price first.");
    return;
  }
  await api(`/listings/${itemId}/comps`, { method: "POST", body: JSON.stringify(body) });
  toast("Comp added");
  await showListingDetail(itemId);
}

async function removeComp(compId, itemId) {
  await api(`/comps/${compId}`, { method: "DELETE" });
  toast("Comp removed");
  await showListingDetail(itemId);
}

async function fetchComps(itemId, button) {
  const originalLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "Fetching...";
  }
  try {
    const data = await api(`/listings/${itemId}/comps/fetch`, { method: "POST" });
    if (data.inserted > 0) {
      toast(`Added ${data.inserted} new comps`);
    } else if (data.fetched > 0) {
      toast("Comps already saved");
    } else {
      const reasons = [data.diagnostics?.bat?.reason, data.diagnostics?.carsAndBids?.reason].filter(Boolean);
      toast(reasons.length ? `No comps found: ${reasons.join("; ")}` : "No comps found for this car");
    }
    await showListingDetail(itemId);
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
  }
}

async function showFacebookDetail(listingId) {
  const data = await api(`/facebook/listings/${listingId}`);
  renderDetail(data);
}

async function resolveFacebookLocation() {
  const query = $("#facebookLocationInput").value;
  if (!query) return;
  const data = await api(`/facebook/locations?query=${encodeURIComponent(query)}`);
  state.locationChoices = data.locations ?? [];
  const [first] = state.locationChoices;
  if (first) {
    $("#facebookLatitudeInput").value = first.latitude;
    $("#facebookLongitudeInput").value = first.longitude;
  }
  renderLocationChoices();
}

async function searchFacebook(event) {
  event.preventDefault();
  const body = {
    query: $("#facebookQueryInput").value,
    latitude: numberOrNull($("#facebookLatitudeInput").value),
    longitude: numberOrNull($("#facebookLongitudeInput").value),
    radiusKm: numberOrNull($("#facebookRadiusInput").value) ?? 80,
    limit: numberOrNull($("#facebookLimitInput").value) ?? 20
  };
  const data = await api("/facebook/search", { method: "POST", body: JSON.stringify(body) });
  state.facebookResults = data.results ?? data.listings ?? [];
}

function bindEvents() {
  $("#apiBaseInput").value = state.apiBase;
  $("#apiBaseInput").closest("label").hidden = pageIsRemote;
  $("#connection-title").textContent = "App access";
  $("#healthButton").textContent = "Connect";
  $("#apiTokenInput").value = state.apiToken;

  $("#apiBaseInput").addEventListener("change", (event) => {
    state.apiBase = pageIsRemote ? window.location.origin : event.target.value.trim().replace(/\/$/, "");
    localStorage.setItem("ri.apiBase", state.apiBase);
  });
  $("#apiTokenInput").addEventListener("change", (event) => {
    state.apiToken = event.target.value.trim();
    localStorage.setItem("ri.apiToken", state.apiToken);
  });
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $$("[data-view-jump]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.viewJump)));
  $("#profileGenerationInput").addEventListener("change", (event) => chooseProfileGeneration(event.target.value));
  $("#refreshButton").addEventListener("click", refreshAll);
  $("#refreshRunsButton").addEventListener("click", loadRuns);
  const inspectHttpSearch = async (event) => {
    const button = event.currentTarget;
    const output = $('#searchInspectionResult');
    button.disabled = true;
    output.hidden = false;
    output.textContent = 'Inspecting one HTTP search; no detail requests or listing writes…';
    try {
      let report = await api('/facebook/search-inspection');
      const weekComparison = button.id !== 'searchInspectionButton';
      const mode = button.id === 'searchInspectionLoggedOutButton' ? 'logged_out' : 'configured';
      if (weekComparison || report.state !== 'finished') {
        report = await api('/facebook/search-inspection', {method:'POST',body:JSON.stringify(weekComparison ? {newestWithinDays:7,mode} : {})});
      }
      const deadline = Date.now()+120000;
      while (report.state === 'running' && Date.now() < deadline) {
        await new Promise(resolve=>setTimeout(resolve,3000));
        report = await api('/facebook/search-inspection');
      }
      output.textContent = JSON.stringify(report,null,2);
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  };
  $('#searchInspectionButton').addEventListener('click', inspectHttpSearch);
  $('#searchInspectionWeekButton').addEventListener('click', inspectHttpSearch);
  $('#searchInspectionLoggedOutButton').addEventListener('click', inspectHttpSearch);
  $("#browserTestButton").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const output = $("#browserTestResult");
    button.disabled = true;
    output.hidden = false;
    output.textContent = "Starting a bounded browser search on the server…";
    try {
      let diagnostic = await api('/facebook/browser-test', {method:'POST', body:JSON.stringify({mode:$('#browserTestMode').value, expectedSessionHash:$('#browserTestSessionHash').value.trim()})});
      const deadline = Date.now() + 180_000;
      while (diagnostic.state === 'running' && Date.now() < deadline) {
        output.textContent = JSON.stringify(diagnostic, null, 2);
        await new Promise(resolve => setTimeout(resolve, 3000));
        diagnostic = await api('/facebook/browser-test');
      }
      output.textContent = JSON.stringify(diagnostic, null, 2);
    } catch (error) {
      output.textContent = error.message;
    } finally { button.disabled = false; }
  });
  $("#healthButton").addEventListener("click", async () => {
    try {
      $("#healthStatus").textContent = "Connecting… The free server may take a minute to wake up.";
      state.apiToken = $("#apiTokenInput").value.trim();
      localStorage.setItem("ri.apiToken", state.apiToken);
      await loadProfiles();
      $("#healthStatus").textContent = "Connected.";
      toast("Connected.");
      await refreshAll();
    } catch (error) {
      $("#healthStatus").textContent = error.message;
    }
  });
  $("#syncAllButton").addEventListener("click", runAllSaved);
  $("#profileForm").addEventListener("submit", saveProfile);
  $("#searchDefaultsForm").addEventListener("submit", saveSearchDefaults);
  $("#generationForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("#generationIdInput").value;
    const body = { make: $("#generationMakeInput").value, model: $("#generationModelInput").value, code: $("#generationCodeInput").value, yearFrom: Number($("#generationFromInput").value), yearTo: Number($("#generationToInput").value) };
    try {
      await api(id ? `/vehicle-generations/${encodeURIComponent(id)}` : "/vehicle-generations", { method: id ? "PUT" : "POST", body: JSON.stringify(body) });
      resetGenerationForm();
      await loadVehicleGenerations();
      toast(id ? "Generation updated" : "Generation added");
    } catch (error) { toast(error.message); }
  });
  $("#generationCancelButton").addEventListener("click", resetGenerationForm);
  $("#groupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const selectedProfiles = $$("input[name='groupProfile']:checked").map((input) => input.value);
      const { group } = await api("/search-groups", { method: "POST", body: JSON.stringify({ name: $("#groupNameInput").value, intervalMinutes: Number($("#groupIntervalInput").value) }) });
      for (const profileId of selectedProfiles) await api(`/profiles/${profileId}`, { method: "PATCH", body: JSON.stringify({ groupId: group.id }) });
      $("#groupForm").reset();
      await Promise.all([loadGroups(), loadProfiles()]);
      toast(`Group created with ${selectedProfiles.length} search${selectedProfiles.length === 1 ? "" : "es"}`);
    } catch (error) { toast(error.message); }
  });
  $("#listingFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    loadListings();
  });
  $("#detailCloseButton").addEventListener("click", closeListingDetail);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeListingDetail();
    if ((event.key === "Enter" || event.key === " ") && event.target?.matches?.("[data-open-detail], [data-open-fb-detail]")) {
      event.preventDefault();
      if (event.target.dataset.openDetail) {
        showListingDetail(event.target.dataset.openDetail).catch((error) => toast(error.message));
      } else if (event.target.dataset.openFbDetail) {
        showFacebookDetail(event.target.dataset.openFbDetail).catch((error) => toast(error.message));
      }
    }
  });
  // Marketplace CDN images can expire or refuse hotlinking. Swap any broken
  // image for a placeholder instead of leaving a broken icon.
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && !img.dataset.fallbackApplied) {
        img.dataset.fallbackApplied = "true";
        const placeholder = document.createElement("div");
        placeholder.className = `${img.className} thumb-placeholder`;
        placeholder.textContent = img.classList.contains("detail-image") ? "No image" : "RI";
        img.replaceWith(placeholder);
      }
    },
    true
  );

  document.addEventListener("click", async (event) => {
    // Clicking a listing card or title opens its details. Buttons and links
    // inside keep their own actions.
    if (!event.target.closest("button, a")) {
      const fbOpener = event.target.closest("[data-open-fb-detail]");
      if (fbOpener) {
        try {
          await showFacebookDetail(fbOpener.dataset.openFbDetail);
        } catch (error) {
          toast(error.message);
        }
        return;
      }
      const opener = event.target.closest("[data-open-detail]");
      if (opener) {
        try {
          await showListingDetail(opener.dataset.openDetail);
        } catch (error) {
          toast(error.message);
        }
        return;
      }
    }
    const target = event.target.closest("button");
    if (!target) return;
    if (target.classList.contains("detail-close")) {
      closeListingDetail();
      return;
    }
    try {
      if (target.dataset.editGeneration) {
        const item = state.generations.find((entry) => entry.id === target.dataset.editGeneration);
        if (!item) return;
        $("#generationIdInput").value = item.id;
        $("#generationMakeInput").value = item.make;
        $("#generationModelInput").value = item.model;
        $("#generationCodeInput").value = item.code;
        $("#generationFromInput").value = item.yearFrom;
        $("#generationToInput").value = item.yearTo;
        $("#generationSaveButton").textContent = "Save changes";
        $("#generationCancelButton").hidden = false;
        $("#generationMakeInput").focus();
      }
      if (target.dataset.deleteGeneration) {
        await api(`/vehicle-generations/${encodeURIComponent(target.dataset.deleteGeneration)}`, { method: "DELETE" });
        await loadVehicleGenerations();
        toast("Generation deleted");
      }
      if (target.dataset.editProfile) {
        const profile = state.profiles.find((item) => item.id === target.dataset.editProfile);
        if (!profile) return;
        $("#searchEditor").open = true;
        $("#searchEditorSummary").textContent = "Edit search";
        $("#profileIdInput").value = profile.id;
        $("#profileQueryInput").value = profile.query;
        $("#profileLocationInput").value = profile.location;
        $("#profileRadiusInput").value = profile.radiusMiles;
        $("#profileMinPriceInput").value = profile.minPrice ?? "";
        $("#profileMaxPriceInput").value = profile.maxPrice ?? "";
        $("#profileEnabledInput").checked = profile.enabled;
        if ($("#profileAlertScoreInput")) $("#profileAlertScoreInput").value = profile.alertMinScore ?? 70;
        if ($("#profileAlertConfidenceInput")) $("#profileAlertConfidenceInput").value = profile.alertMinConfidence ?? 0.5;
        if ($("#profileAlertAgeInput")) $("#profileAlertAgeInput").value = profile.alertMaxAgeHours ?? 72;
        if ($("#profileGroupInput")) $("#profileGroupInput").value = profile.groupId ?? "";
        $("#profileTransmissionInput").value = profile.filtersJson?.transmission ?? "";
        $("#profileYearMinInput").value = profile.filtersJson?.yearMin ?? "";
        $("#profileYearMaxInput").value = profile.filtersJson?.yearMax ?? "";
        $("#profileMaxMileageInput").value = profile.filtersJson?.maxMileage ?? "";
        $("#profileCleanTitleInput").checked = Boolean(profile.filtersJson?.cleanTitleOnly);
        $("#profileModifiedInput").checked = Boolean(profile.filtersJson?.modifiedOnly);
        $("#profileGenerationInput").value = profile.filtersJson?.generation?.id ?? "";
        }
      if (target.dataset.runProfile) await runProfile(target.dataset.runProfile, target);
      if (target.dataset.runGroup) {
        target.disabled = true;
        try {
          const out = await api(`/search-groups/${target.dataset.runGroup}/run`, { method: "POST" });
          toast(`Group completed: ${out.count} searches`);
          await Promise.all([loadListings(), loadRuns(), loadDeals(), loadAlerts(), loadGroups()]);
        } finally { target.disabled = false; }
      }
      if (target.dataset.saveGroupSchedule) {
        const selector = $(`[data-group-schedule="${target.dataset.saveGroupSchedule}"]`);
        await api(`/search-groups/${target.dataset.saveGroupSchedule}`, { method: "PATCH", body: JSON.stringify({ intervalMinutes: Number(selector.value) }) });
        await loadGroups();
        toast("Group schedule updated");
      }
      if (target.dataset.toggleProfile) {
        const profile = state.profiles.find((item) => item.id === target.dataset.toggleProfile);
        await api(`/profiles/${profile.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !profile.enabled }) });
        await loadProfiles();
      }
      if (target.dataset.deleteProfile) {
        await api(`/profiles/${target.dataset.deleteProfile}`, { method: "DELETE" });
        await loadProfiles();
        toast("Profile deleted");
      }
      if (target.dataset.detail) await showListingDetail(target.dataset.detail);
      if (target.dataset.saveComp) await saveComp(target.dataset.saveComp);
      if (target.dataset.compTrans) {
        compTransFilter = target.dataset.compTrans;
        $$(".chart-legend .status-button").forEach((button) =>
          button.classList.toggle("is-active", button.dataset.compTrans === compTransFilter)
        );
        $$(".comp-chart .chart-dot").forEach((dot) => {
          dot.style.display =
            compTransFilter === "all" || dot.dataset.trans === compTransFilter ? "" : "none";
        });
        return;
      }
      if (target.dataset.fetchComps) await fetchComps(target.dataset.fetchComps, target);
      if (target.dataset.deleteComp) await removeComp(target.dataset.deleteComp, target.dataset.compItem);
      if (target.dataset.detailThumb) {
        const hero = $("#detailHeroImage");
        if (hero) hero.src = target.dataset.detailThumb;
        return;
      }
      if (target.dataset.facebookDetail) await showFacebookDetail(target.dataset.facebookDetail);
      if (target.dataset.setStatus) await updateStatus(target.dataset.setStatus, target.dataset.status);
      if (target.dataset.deleteListing) await removeListing(target.dataset.deleteListing, target);
      if (target.dataset.markAlertRead) await markAlertRead(target.dataset.markAlertRead);
      if (target.dataset.locationLat) {
        $("#facebookLatitudeInput").value = target.dataset.locationLat;
        $("#facebookLongitudeInput").value = target.dataset.locationLng;
      }
    } catch (error) {
      toast(error.message);
    }
  });
}

bindEvents();
setView("dashboard");
refreshAll();
