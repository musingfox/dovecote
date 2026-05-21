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

export type DiscordEmbed = z.infer<typeof discordEmbedSchema>;
export type MessageContent = z.infer<typeof messageContentSchema>;

export const notifyRequestSchema = z.object({
  channel: z.string(),
  content: messageContentSchema,
});
export type NotifyRequest = z.infer<typeof notifyRequestSchema>;

export const sendResultSchema = z.object({
  success: z.boolean(),
  channel: z.string(),
  messageId: z.string().optional(),
  detail: z.object({
    text: z.string().optional(),
    chatId: z.string().optional(),
  }).optional(),
  error: z.string().optional(),
});
export type SendResultContract = z.infer<typeof sendResultSchema>;

export const channelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  service: z.string(),
});
export const channelsListResponseSchema = z.object({
  channels: z.array(channelConfigSchema),
});
export type ChannelsListResponse = z.infer<typeof channelsListResponseSchema>;
