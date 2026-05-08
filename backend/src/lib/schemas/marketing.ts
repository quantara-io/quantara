import { z } from "@hono/zod-openapi";

export const Campaign = z
  .object({
    campaignId: z.string(),
    userId: z.string(),
    type: z.enum(["phone", "email"]),
    name: z.string(),
    status: z.enum(["draft", "active", "paused", "completed"]),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Campaign");

export const CampaignsListResponse = z
  .object({
    success: z.literal(true),
    data: z.object({ campaigns: z.array(Campaign) }),
  })
  .openapi("CampaignsListResponse");

export const CreatePhoneCampaignRequest = z
  .object({
    name: z.string(),
    targetNumbers: z.array(z.string()).optional(),
    script: z.string().optional(),
  })
  .openapi("CreatePhoneCampaignRequest");

export const CreateEmailCampaignRequest = z
  .object({
    name: z.string(),
    subject: z.string(),
    body: z.string(),
    recipients: z.array(z.string().email()).optional(),
  })
  .openapi("CreateEmailCampaignRequest");

export const CampaignDetailResponse = z
  .object({
    success: z.literal(true),
    data: z.object({ campaign: Campaign.nullable() }),
  })
  .openapi("CampaignDetailResponse");

export const AnalyticsResponse = z
  .object({
    success: z.literal(true),
    data: z.object({ analytics: z.object({}).passthrough().nullable() }),
  })
  .openapi("AnalyticsResponse");
