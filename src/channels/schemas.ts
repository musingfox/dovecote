import { z } from "zod";

export const discordEmbedSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  color: z.number().int().min(0).max(0xffffff).optional(),
  footer: z.object({
    text: z.string(),
    icon_url: z.string().optional(),
  }).optional(),
  image: z.object({
    url: z.string(),
  }).optional(),
  thumbnail: z.object({
    url: z.string(),
  }).optional(),
  author: z.object({
    name: z.string(),
    url: z.string().optional(),
    icon_url: z.string().optional(),
  }).optional(),
  fields: z.array(z.object({
    name: z.string(),
    value: z.string(),
    inline: z.boolean().optional(),
  })).optional(),
});

export const messageContentSchema = z.object({
  text: z.string().optional(),
  embed: discordEmbedSchema.optional(),
}).refine(
  (data) => data.text !== undefined || data.embed !== undefined,
  { message: "At least one of text or embed is required" }
);
