export interface ListingTableColumn {
  key: string;
  label: string;
}

export interface ListingTableProps {
  columns: ListingTableColumn[];
  rowCount: number;
}

export function ListingTable(_props: ListingTableProps): string {
  return "ListingTable wireframe component";
}
