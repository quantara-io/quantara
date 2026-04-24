import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { requireAuth } from "../middleware/require-auth.js";
import { CampaignsListResponse, CreatePhoneCampaignRequest, CreateEmailCampaignRequest, CampaignDetailResponse, AnalyticsResponse } from "../lib/schemas/marketing.js";
import { SuccessResponse } from "../lib/schemas/auth.js";

const marketing = new OpenAPIHono();
marketing.use("*", requireAuth);

const listCampaignsRoute = createRoute({
  method: "get", path: "/campaigns", tags: ["Marketing"], summary: "List campaigns",
  security: [{ Bearer: [] }],
  responses: { 200: { content: { "application/json": { schema: CampaignsListResponse } }, description: "Campaigns" } },
});
marketing.openapi(listCampaignsRoute, (c) => c.json({ success: true as const, data: { campaigns: [] } }));

const createPhoneRoute = createRoute({
  method: "post", path: "/campaigns/phone", tags: ["Marketing"], summary: "Create phone campaign",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: CreatePhoneCampaignRequest } } } },
  responses: { 201: { content: { "application/json": { schema: CampaignDetailResponse } }, description: "Created" } },
});
marketing.openapi(createPhoneRoute, (c) => c.json({ success: true as const, data: { campaign: null } }));

const createEmailRoute = createRoute({
  method: "post", path: "/campaigns/email", tags: ["Marketing"], summary: "Create email campaign",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: CreateEmailCampaignRequest } } } },
  responses: { 201: { content: { "application/json": { schema: CampaignDetailResponse } }, description: "Created" } },
});
marketing.openapi(createEmailRoute, (c) => c.json({ success: true as const, data: { campaign: null } }));

const getCampaignRoute = createRoute({
  method: "get", path: "/campaigns/:id", tags: ["Marketing"], summary: "Get campaign details",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { content: { "application/json": { schema: CampaignDetailResponse } }, description: "Campaign" } },
});
marketing.openapi(getCampaignRoute, (c) => c.json({ success: true as const, data: { campaign: null } }));

const pauseRoute = createRoute({
  method: "post", path: "/campaigns/:id/pause", tags: ["Marketing"], summary: "Pause a campaign",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { content: { "application/json": { schema: SuccessResponse } }, description: "Paused" } },
});
marketing.openapi(pauseRoute, (c) => c.json({ success: true as const, data: { message: "Campaign paused" } }));

const analyticsRoute = createRoute({
  method: "get", path: "/analytics", tags: ["Marketing"], summary: "Get marketing analytics",
  security: [{ Bearer: [] }],
  responses: { 200: { content: { "application/json": { schema: AnalyticsResponse } }, description: "Analytics" } },
});
marketing.openapi(analyticsRoute, (c) => c.json({ success: true as const, data: { analytics: null } }));

export { marketing };
