import { z } from "@hono/zod-openapi";

export const DealPost = z
  .object({
    dealId: z.string(),
    authorId: z.string(),
    title: z.string(),
    description: z.string(),
    dealType: z.enum(["real_estate", "business_financing", "partnership", "other"]),
    investmentMin: z.number().nullable(),
    investmentMax: z.number().nullable(),
    location: z.string().nullable(),
    interestCount: z.number(),
    status: z.enum(["active", "moderation", "closed", "removed"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("DealPost");

export const DealsListResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      deals: z.array(DealPost),
      meta: z.object({
        page: z.number(),
        pageSize: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
      }),
    }),
  })
  .openapi("DealsListResponse");

export const CreateDealRequest = z
  .object({
    title: z.string(),
    description: z.string(),
    dealType: z.enum(["real_estate", "business_financing", "partnership", "other"]),
    investmentMin: z.number().optional(),
    investmentMax: z.number().optional(),
    location: z.string().optional(),
  })
  .openapi("CreateDealRequest");

export const DealDetailResponse = z
  .object({
    success: z.literal(true),
    data: z.object({ deal: DealPost.nullable() }),
  })
  .openapi("DealDetailResponse");

export const DealProfileResponse = z
  .object({
    success: z.literal(true),
    data: z.object({ profile: z.object({}).passthrough().nullable() }),
  })
  .openapi("DealProfileResponse");

export const UpdateProfileRequest = z
  .object({
    bio: z.string().optional(),
    company: z.string().optional(),
    website: z.string().optional(),
  })
  .openapi("UpdateDealProfileRequest");
