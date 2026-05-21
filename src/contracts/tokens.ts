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
