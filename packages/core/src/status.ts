import type { ListingStatus } from "./types";

export const ACTIVE_LISTING_STATUSES: ListingStatus[] = [
  "new",
  "watching",
  "saved",
  "contacted"
];

export const INACTIVE_LISTING_STATUSES: ListingStatus[] = [
  "rejected",
  "sold",
  "possibly_gone",
  "hidden"
];

export function isRefreshEligible(status: ListingStatus): boolean {
  return status === "new" || status === "watching" || status === "saved" || status === "contacted";
}
