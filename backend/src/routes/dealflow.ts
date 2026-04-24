import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import { requireAuth } from "../middleware/require-auth.js";
import { DealsListResponse, CreateDealRequest, DealDetailResponse, DealProfileResponse, UpdateProfileRequest } from "../lib/schemas/dealflow.js";
import { SuccessResponse } from "../lib/schemas/auth.js";

const dealflow = new OpenAPIHono();
dealflow.use("*", requireAuth);

const listDealsRoute = createRoute({
  method: "get", path: "/deals", tags: ["Dealflow"], summary: "List deals",
  security: [{ Bearer: [] }],
  request: { query: z.object({ page: z.coerce.number().optional().default(1), pageSize: z.coerce.number().optional().default(20) }) },
  responses: { 200: { content: { "application/json": { schema: DealsListResponse } }, description: "Deals" } },
});
dealflow.openapi(listDealsRoute, (c) => {
  const { page, pageSize } = c.req.valid("query");
  return c.json({ success: true as const, data: { deals: [], meta: { page, pageSize, total: 0, hasMore: false } } });
});

const createDealRoute = createRoute({
  method: "post", path: "/deals", tags: ["Dealflow"], summary: "Create a deal",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: CreateDealRequest } } } },
  responses: { 201: { content: { "application/json": { schema: DealDetailResponse } }, description: "Created" } },
});
dealflow.openapi(createDealRoute, (c) => c.json({ success: true as const, data: { deal: null } }));

const getDealRoute = createRoute({
  method: "get", path: "/deals/:id", tags: ["Dealflow"], summary: "Get deal details",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { content: { "application/json": { schema: DealDetailResponse } }, description: "Deal" } },
});
dealflow.openapi(getDealRoute, (c) => c.json({ success: true as const, data: { deal: null } }));

const interestRoute = createRoute({
  method: "post", path: "/deals/:id/interest", tags: ["Dealflow"], summary: "Express interest in a deal",
  security: [{ Bearer: [] }],
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { content: { "application/json": { schema: SuccessResponse } }, description: "Interest registered" } },
});
dealflow.openapi(interestRoute, (c) => c.json({ success: true as const, data: { message: "Interest registered" } }));

const getProfileRoute = createRoute({
  method: "get", path: "/profile", tags: ["Dealflow"], summary: "Get dealflow profile",
  security: [{ Bearer: [] }],
  responses: { 200: { content: { "application/json": { schema: DealProfileResponse } }, description: "Profile" } },
});
dealflow.openapi(getProfileRoute, (c) => c.json({ success: true as const, data: { profile: null } }));

const updateProfileRoute = createRoute({
  method: "put", path: "/profile", tags: ["Dealflow"], summary: "Update dealflow profile",
  security: [{ Bearer: [] }],
  request: { body: { content: { "application/json": { schema: UpdateProfileRequest } } } },
  responses: { 200: { content: { "application/json": { schema: SuccessResponse } }, description: "Updated" } },
});
dealflow.openapi(updateProfileRoute, (c) => c.json({ success: true as const, data: { message: "Profile updated" } }));

export { dealflow };
