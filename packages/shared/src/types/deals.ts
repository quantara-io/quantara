export const DEAL_TYPES = ["real_estate", "business_financing", "partnership", "other"] as const;
export type DealType = (typeof DEAL_TYPES)[number];

export const DEAL_SORT_OPTIONS = ["newest", "popular", "closing_soon"] as const;
export type DealSortOption = (typeof DEAL_SORT_OPTIONS)[number];

export interface DealPost {
  dealId: string;
  authorId: string;
  title: string;
  description: string;
  dealType: DealType;
  investmentMin: number;
  investmentMax: number;
  location: string;
  attachmentUrls: string[];
  interestCount: number;
  status: "active" | "moderation" | "closed" | "removed";
  createdAt: string;
  updatedAt: string;
}

export interface DealInterest {
  dealId: string;
  userId: string;
  createdAt: string;
}
