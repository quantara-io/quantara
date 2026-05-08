import { z } from "@hono/zod-openapi";

// --- User ---

export const UserProfile = z
  .object({
    userId: z.string(),
    email: z.string().email(),
    emailVerified: z.boolean(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable().optional(),
    role: z.string(),
    authMethods: z.array(z.string()).optional(),
    createdAt: z.string().optional(),
    lastLoginAt: z.string().nullable().optional(),
  })
  .openapi("UserProfile");

// --- Auth Config (public) ---

export const AuthConfigResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      authMethods: z
        .array(z.string())
        .describe(
          "Enabled auth methods: email_password, oauth_google, oauth_apple, magic_link, passkey",
        ),
      mfaPolicy: z.enum(["optional", "required", "disabled"]),
      mfaMethods: z.array(z.enum(["totp", "email"])),
      passkeyEnabled: z.boolean(),
      oauthProviders: z.array(z.string()),
    }),
  })
  .openapi("AuthConfigResponse");

// --- Signup ---

export const SignupRequest = z
  .object({
    email: z.string().email().describe("User email address"),
    password: z.string().min(8).describe("Password (min 8 characters)"),
    displayName: z.string().optional().describe("Display name"),
  })
  .openapi("SignupRequest");

// --- Login ---

export const LoginRequest = z
  .object({
    email: z.string().email(),
    password: z.string(),
  })
  .openapi("LoginRequest");

export const AuthSuccessResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
      user: UserProfile,
      mfaRequired: z.boolean().optional().describe("True if MFA challenge is needed"),
      mfaToken: z.string().optional().describe("Token to use for MFA verification"),
    }),
  })
  .openapi("AuthSuccessResponse");

// --- Token Refresh ---

export const RefreshRequest = z
  .object({
    refreshToken: z.string(),
  })
  .openapi("RefreshRequest");

export const RefreshResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      accessToken: z.string(),
      refreshToken: z.string().optional(),
    }),
  })
  .openapi("RefreshResponse");

// --- OAuth ---

export const OAuthProviderParam = z
  .object({
    provider: z.enum(["google", "apple"]).describe("OAuth provider"),
  })
  .openapi("OAuthProviderParam");

export const OAuthCallbackQuery = z
  .object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional(),
    // CSRF state we round-trip through redirect_uri to bind the callback
    // to the browser that initiated the flow.
    cs: z.string().optional(),
  })
  .openapi("OAuthCallbackQuery");

export const NativeTokenRequest = z
  .object({
    idToken: z.string().describe("ID token from native Google/Apple SDK"),
    displayName: z.string().optional(),
  })
  .openapi("NativeTokenRequest");

// --- Magic Link ---

export const MagicLinkRequest = z
  .object({
    email: z.string().email(),
    redirectUri: z.string().optional(),
  })
  .openapi("MagicLinkRequest");

export const MagicLinkVerifyRequest = z
  .object({
    token: z.string(),
  })
  .openapi("MagicLinkVerifyRequest");

// --- Password Reset ---

export const PasswordResetRequest = z
  .object({
    email: z.string().email(),
  })
  .openapi("PasswordResetRequest");

export const PasswordResetConfirm = z
  .object({
    token: z.string(),
    newPassword: z.string().min(8),
  })
  .openapi("PasswordResetConfirm");

// --- Email Verify ---

export const EmailVerifySendRequest = z
  .object({
    email: z.string().email().optional(),
  })
  .openapi("EmailVerifySendRequest");

export const EmailVerifyConfirmRequest = z
  .object({
    code: z.string().describe("6-digit verification code"),
  })
  .openapi("EmailVerifyConfirmRequest");

// --- MFA ---

export const MfaMethodsResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      available: z
        .array(z.enum(["totp", "email"]))
        .describe("MFA methods available for enrollment"),
      enrolled: z
        .array(
          z.object({
            id: z.string(),
            type: z.string(),
            enrolledAt: z.string(),
          }),
        )
        .describe("Currently enrolled MFA methods"),
    }),
  })
  .openapi("MfaMethodsResponse");

export const MfaTotpSetupResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      secret: z.string(),
      qrCodeUrl: z.string().describe("otpauth:// URI for QR code"),
    }),
  })
  .openapi("MfaTotpSetupResponse");

export const MfaConfirmRequest = z
  .object({
    code: z.string().length(6).describe("6-digit TOTP code from authenticator app"),
  })
  .openapi("MfaConfirmRequest");

export const MfaConfirmResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      recoveryCodes: z.array(z.string()).describe("One-time recovery codes — save these!"),
    }),
  })
  .openapi("MfaConfirmResponse");

export const MfaVerifyRequest = z
  .object({
    mfaToken: z.string().describe("MFA token from login response"),
    code: z.string().describe("Verification code"),
    method: z.enum(["totp", "email", "recovery_code"]).describe("MFA method"),
    trustDevice: z.boolean().optional().describe("Trust this device for 30 days"),
  })
  .openapi("MfaVerifyRequest");

// --- Passkey ---

export const PasskeyOptionsResponse = z
  .object({
    success: z.literal(true),
    data: z.object({}).passthrough().describe("WebAuthn options (challenge, rpId, etc.)"),
  })
  .openapi("PasskeyOptionsResponse");

export const PasskeyVerifyRequest = z
  .object({})
  .passthrough()
  .describe("WebAuthn credential response from browser")
  .openapi("PasskeyVerifyRequest");

export const PasskeyListResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      passkeys: z.array(
        z.object({
          credentialId: z.string(),
          name: z.string(),
          deviceType: z.string(),
          backedUp: z.boolean(),
          enrolledAt: z.string(),
          lastUsedAt: z.string().nullable(),
        }),
      ),
    }),
  })
  .openapi("PasskeyListResponse");

// --- Profile Update ---

export const UpdateProfileRequest = z
  .object({
    displayName: z.string().optional(),
    avatarUrl: z.string().optional(),
  })
  .openapi("UpdateProfileRequest");

// --- Simple success ---

export const SuccessResponse = z
  .object({
    success: z.literal(true),
    data: z.object({
      message: z.string(),
    }),
  })
  .openapi("SuccessResponse");
