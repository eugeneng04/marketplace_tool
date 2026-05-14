export interface ListingCardProps {
  imageUrl?: string;
  title: string;
  priceLabel: string;
  location: string;
  mileageLabel?: string;
  transmissionLabel?: string;
  titleStatusLabel?: string;
  dealScore?: number;
  status: string;
  firstSeenLabel: string;
  lastSeenLabel: string;
}

export function ListingCard(_props: ListingCardProps): string {
  return "ListingCard wireframe component";
}
