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
export const tokenIssueRequestSchema = z.object({
  userId: z.string().min(1),
  scopes: z.array(z.string()).min(1),
  label: z.string().max(64).optional(),
});
export type TokenIssueRequest = z.infer<typeof tokenIssueRequestSchema>;

export const tokenIssueResponseSchema = z.object({
  token: z.string(),
  tokenId: z.string(),
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
