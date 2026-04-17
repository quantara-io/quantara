export const USER_TYPES = ["retail", "institutional", "admin"] as const;
export type UserType = (typeof USER_TYPES)[number];

export interface UserProfile {
  userId: string;
  email: string;
  displayName: string;
  userType: UserType;
  tierId: string;
  bio?: string;
  professionalBackground?: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}
