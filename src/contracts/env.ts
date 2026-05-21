import { z } from "zod";

export const profileNameSchema = z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/, "Profile must match /^[a-zA-Z0-9_-]+$/");
export type ProfileName = z.infer<typeof profileNameSchema>;

export const envReadResponseSchema = z.object({
  profile: z.string(),
  value: z.string(),
});
export type EnvReadResponse = z.infer<typeof envReadResponseSchema>;
