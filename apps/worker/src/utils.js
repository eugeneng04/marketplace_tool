import { randomUUID } from "node:crypto";

export function createId() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseJsonBody(text) {
  if (!text || text.trim().length === 0) {
    return {};
  }

  return JSON.parse(text);
}

export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

export function parsePrice(raw) {
  if (!raw) {
    return null;
  }

  const cleaned = raw.replace(/[^\d.]/g, "");
  if (!cleaned) {
    return null;
  }

  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

export function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function toInt(value, fallback = null) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(`${value}`, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function median(values) {
  if (!values || values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}
