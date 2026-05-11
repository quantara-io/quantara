import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { defaultBlendProfiles } from "@quantara/shared";

import { PatchSettingsRequest, UserProfileResponse } from "../lib/schemas/users.js";
import { getOrCreateUserRecord, putUserUnchecked } from "../lib/user-store.js";
import { requireAuth } from "../middleware/require-auth.js";

const users = new OpenAPIHono();

// All /users routes require auth.
users.use("*", requireAuth);

// ---------------------------------------------------------------------------
// PATCH /me/settings
// ---------------------------------------------------------------------------

const patchSettingsRoute = createRoute({
  method: "patch",
  path: "/me/settings",
  tags: ["Users"],
  summary: "Update per-pair risk and blend profile settings",
  description:
    "Partially updates the authenticated user's per-pair riskProfiles and/or blendProfiles. " +
    "Only the pairs provided in the request body are changed; all other pairs are preserved.",
  security: [{ Bearer: [] }],
  request: {
    body: {
      content: { "application/json": { schema: PatchSettingsRequest } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: UserProfileResponse } },
      description: "Updated UserProfile",
    },
  },
});

users.openapi(patchSettingsRoute, async (c) => {
  const authCtx = c.get("auth");
  const body = c.req.valid("json");

  // Fetch (or lazily create) the user's profile.
  const existing = await getOrCreateUserRecord(authCtx.userId, authCtx.email);

  // Partial merge: spread existing map, then overlay only the pairs in the patch.
  const updatedRiskProfiles = body.riskProfiles
    ? { ...existing.riskProfiles, ...body.riskProfiles }
    : existing.riskProfiles;

  // When blendProfiles patch is provided and user has no existing map (pre-302 record),
  // seed from tier defaults so all 5 pairs are present before overlaying the patch.
  const baseBlendProfiles = existing.blendProfiles ?? defaultBlendProfiles(existing.tier ?? "free");
  const updatedBlendProfiles = body.blendProfiles
    ? { ...baseBlendProfiles, ...body.blendProfiles }
    : existing.blendProfiles;

  const updated = {
    ...existing,
    riskProfiles: updatedRiskProfiles,
    blendProfiles: updatedBlendProfiles,
    updatedAt: new Date().toISOString(),
  };

  await putUserUnchecked(updated);

  return c.json({ success: true as const, data: updated });
});

export { users };
