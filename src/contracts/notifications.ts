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

// Base64-encoded attachment bytes. Bound to ~10MB of base64 (~7.5MB decoded),
// comfortably under Discord's default ~8MB webhook attachment cap.
const ATTACHMENT_DATA_MAX = 10 * 1024 * 1024;

export const attachmentSchema = z.object({
  filename: z.string(),
  data: z.string().max(ATTACHMENT_DATA_MAX),
  contentType: z.string().optional(),
});

export const messageContentSchema = z.object({
  text: z.string().optional(),
  embed: discordEmbedSchema.optional(),
  attachment: attachmentSchema.optional(),
}).refine(
  (data) => data.text !== undefined || data.embed !== undefined || data.attachment !== undefined,
  { message: "At least one of text, embed, or attachment is required" }
);

export type Attachment = z.infer<typeof attachmentSchema>;

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
