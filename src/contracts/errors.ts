import { z } from "zod";

export const errorEnvelopeSchema = z.object({
  error: z.string(),
  error_description: z.string(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
