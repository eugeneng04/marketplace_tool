export interface SidebarNavItem {
  label: string;
  href: string;
}

export const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
  { label: "Dashboard", href: "/" },
  { label: "Search Profiles", href: "/search-profiles" },
  { label: "Listings", href: "/listings" },
  { label: "Saved", href: "/saved" },
  { label: "Market Trends", href: "/market-trends" },
  { label: "Settings", href: "/settings" }
];
