import { z } from "zod";

export const tokenMetadataSchema = z.object({
  tokenId: z.string().min(1),
  hash: z.string().min(1),
  scopes: z.array(z.string()),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  label: z.string().optional(),
});
export type TokenMetadata = z.infer<typeof tokenMetadataSchema>;

// PR-E: POST /v1/tokens request body (C2.5.a)
// Phase 3.x: extended with optional expiresIn enum (C-Server-3).
export const expiresInSchema = z.enum(["7d", "30d", "60d", "90d"]);
export type ExpiresIn = z.infer<typeof expiresInSchema>;

export const tokenIssueRequestSchema = z.object({
  userId: z.string().min(1),
  scopes: z.array(z.string()).min(1),
  label: z.string().max(64).optional(),
  expiresIn: expiresInSchema.optional(),
});
export type TokenIssueRequest = z.infer<typeof tokenIssueRequestSchema>;

// POST /v1/auth/exchange request body — both fields optional.
export const tokenExchangeRequestSchema = z.object({
  expiresIn: expiresInSchema.optional(),
  label: z.string().max(64).optional(),
});
export type TokenExchangeRequest = z.infer<typeof tokenExchangeRequestSchema>;

// POST /v1/auth/exchange-oidc request body — `id_token` is mandatory.
export const tokenExchangeOidcRequestSchema = z.object({
  id_token: z.string().min(1),
  expiresIn: expiresInSchema.optional(),
  label: z.string().max(64).optional(),
});
export type TokenExchangeOidcRequest = z.infer<typeof tokenExchangeOidcRequestSchema>;

// POST /v1/tokens/:id/renew request body.
export const tokenRenewRequestSchema = z.object({
  expiresIn: expiresInSchema.optional(),
});
export type TokenRenewRequest = z.infer<typeof tokenRenewRequestSchema>;

/**
 * Map an expiresIn enum value to TTL seconds.
 */
export function expiresInToSeconds(value: ExpiresIn): number {
  switch (value) {
    case "7d":
      return 604_800;
    case "30d":
      return 2_592_000;
    case "60d":
      return 5_184_000;
    case "90d":
      return 7_776_000;
  }
}

export const tokenIssueResponseSchema = z.object({
  token: z.string(),
  tokenId: z.string(),
  userId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  label: z.string().optional(),
});
export type TokenIssueResponse = z.infer<typeof tokenIssueResponseSchema>;

export const tokenRevokeResponseSchema = z.object({
  revoked: z.boolean(),
  tokenId: z.string(),
  notice: z.string(),
});
export type TokenRevokeResponse = z.infer<typeof tokenRevokeResponseSchema>;

// GET /v1/tokens — list response (Phase 4.3 / C-Schema-ListResponse).
// The per-entry object is `.strict()` to guarantee `hash` and `token` never
// leak via response shape drift.
export const tokenListResponseSchema = z.object({
  tokens: z.array(
    z
      .object({
        tokenId: z.string(),
        userId: z.string(),
        scopes: z.array(z.string()),
        createdAt: z.number().int(),
        expiresAt: z.number().int(),
        label: z.string().optional(),
      })
      .strict()
  ),
  truncated: z.boolean(),
});
export type TokenListResponse = z.infer<typeof tokenListResponseSchema>;

export const whoamiResponseSchema = z.object({
  userId: z.string().min(1),
  tokenId: z.string().min(1),
  scopes: z.array(z.string()),
  expiresAt: z.number().int(),
});
export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;

