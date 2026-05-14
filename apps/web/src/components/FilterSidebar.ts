export interface FilterDefinition {
  key: string;
  label: string;
  type: "select" | "range" | "text" | "date";
}

export interface FilterSidebarProps {
  filters: FilterDefinition[];
}

export function FilterSidebar(_props: FilterSidebarProps): string {
  return "FilterSidebar wireframe component";
}
