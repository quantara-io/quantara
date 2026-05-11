import { z } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Shared constants (mirrored from @quantara/shared for zod enum use)
// ---------------------------------------------------------------------------

const RISK_PROFILE_VALUES = ["conservative", "moderate", "aggressive"] as const;
const BLEND_PROFILE_VALUES = ["strict", "balanced", "aggressive"] as const;

// ---------------------------------------------------------------------------
// Per-pair partial patch helpers
//
// Using z.object().partial().strict() instead of z.record(z.enum([...]))
// because z.record(z.enum) requires ALL keys to be present.
// We want optional per-pair overrides while still rejecting unknown pairs.
// ---------------------------------------------------------------------------

function riskPartialObject() {
  return z
    .object({
      "BTC/USDT": z.enum(RISK_PROFILE_VALUES).optional(),
      "ETH/USDT": z.enum(RISK_PROFILE_VALUES).optional(),
      "SOL/USDT": z.enum(RISK_PROFILE_VALUES).optional(),
      "XRP/USDT": z.enum(RISK_PROFILE_VALUES).optional(),
      "DOGE/USDT": z.enum(RISK_PROFILE_VALUES).optional(),
    })
    .strict();
}

function blendPartialObject() {
  return z
    .object({
      "BTC/USDT": z.enum(BLEND_PROFILE_VALUES).optional(),
      "ETH/USDT": z.enum(BLEND_PROFILE_VALUES).optional(),
      "SOL/USDT": z.enum(BLEND_PROFILE_VALUES).optional(),
      "XRP/USDT": z.enum(BLEND_PROFILE_VALUES).optional(),
      "DOGE/USDT": z.enum(BLEND_PROFILE_VALUES).optional(),
    })
    .strict();
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

export const PatchSettingsRequest = z
  .object({
    riskProfiles: riskPartialObject()
      .optional()
      .openapi({
        description:
          "Per-pair risk profile overrides. Only the provided pairs are updated; others are preserved.",
        example: { "BTC/USDT": "aggressive", "ETH/USDT": "conservative" },
      }),
    blendProfiles: blendPartialObject()
      .optional()
      .openapi({
        description:
          "Per-pair blend profile overrides. Only the provided pairs are updated; others are preserved.",
        example: { "BTC/USDT": "balanced" },
      }),
  })
  .openapi("PatchSettingsRequest");

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const RiskProfileMapSchema = z
  .object({
    "BTC/USDT": z.enum(RISK_PROFILE_VALUES),
    "ETH/USDT": z.enum(RISK_PROFILE_VALUES),
    "SOL/USDT": z.enum(RISK_PROFILE_VALUES),
    "XRP/USDT": z.enum(RISK_PROFILE_VALUES),
    "DOGE/USDT": z.enum(RISK_PROFILE_VALUES),
  })
  .openapi("RiskProfileMap");

const BlendProfileMapSchema = z
  .object({
    "BTC/USDT": z.enum(BLEND_PROFILE_VALUES),
    "ETH/USDT": z.enum(BLEND_PROFILE_VALUES),
    "SOL/USDT": z.enum(BLEND_PROFILE_VALUES),
    "XRP/USDT": z.enum(BLEND_PROFILE_VALUES),
    "DOGE/USDT": z.enum(BLEND_PROFILE_VALUES),
  })
  .openapi("BlendProfileMap");

export const UserProfileResponse = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        userId: z.string(),
        email: z.string(),
        displayName: z.string(),
        userType: z.enum(["retail", "institutional", "admin"]),
        tier: z.enum(["free", "paid"]).optional(),
        bio: z.string().optional(),
        professionalBackground: z.string().optional(),
        avatarUrl: z.string().optional(),
        createdAt: z.string(),
        updatedAt: z.string(),
        riskProfiles: RiskProfileMapSchema,
        blendProfiles: BlendProfileMapSchema.optional(),
      })
      .openapi("UserProfile"),
  })
  .openapi("UserProfileResponse");
