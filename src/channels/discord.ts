import type { SendResult } from "../types.js";
import type {
  ChannelProvider,
  MessageContent,
  ParseRecordResult,
  ServiceAdapter,
  DiscordInstanceConfig,
} from "./types.js";
import { isValidInstanceId, isValidDiscordWebhookUrl } from "./utils.js";

const MAX_ERROR_DETAIL = 100;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class DiscordProvider implements ChannelProvider {
  constructor(
    private channelId: string,
    private webhookUrl: string
  ) {}

  async send(content: MessageContent): Promise<SendResult> {
    try {
      const url = new URL(this.webhookUrl);
      url.searchParams.set("wait", "true");

      const payload: Record<string, unknown> = {
        username: "Dovecote",
      };

      if (content.text !== undefined) {
        payload.content = content.text;
      }

      if (content.embed !== undefined) {
        payload.embeds = [content.embed];
      }

      let init: RequestInit;
      if (content.attachment !== undefined) {
        // Discord file upload: multipart/form-data with a payload_json part and
        // a files[0] part. The embed may reference the file inline via
        // image.url = "attachment://<filename>". Do not set Content-Type so that
        // fetch supplies the correct multipart boundary.
        const bytes = base64ToBytes(content.attachment.data);
        const form = new FormData();
        form.append("payload_json", JSON.stringify(payload));
        form.append(
          "files[0]",
          new Blob([bytes], {
            type: content.attachment.contentType ?? "application/octet-stream",
          }),
          content.attachment.filename
        );
        init = { method: "POST", body: form, redirect: "manual" };
      } else {
        init = {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          redirect: "manual",
        };
      }

      const response = await fetch(url.toString(), init);

      if (response.status >= 300 && response.status < 400) {
        return {
          success: false,
          channel: this.channelId,
          error: `HTTP ${response.status}: unexpected redirect from Discord webhook`,
        };
      }

      if (response.ok) {
        const data = (await response.json()) as any;
        return {
          success: true,
          channel: this.channelId,
          messageId: data.id,
          detail: {
            text: data.content,
            chatId: data.channel_id,
          },
        };
      }

      const text = await response.text();
      let detail = text;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed === "object" && parsed !== null && typeof parsed.message === "string") {
          detail = parsed.message;
        }
      } catch {
      }
      if (detail.length > MAX_ERROR_DETAIL) {
        detail = detail.slice(0, MAX_ERROR_DETAIL) + "...";
      }
      return {
        success: false,
        channel: this.channelId,
        error: `HTTP ${response.status}: ${detail}`,
      };
    } catch {
      return {
        success: false,
        channel: this.channelId,
        error: "Network error reaching Discord",
      };
    }
  }
}

export const discordAdapter: ServiceAdapter<DiscordInstanceConfig> = {
  service: "discord",

  /**
   * Validate one stored `channel:discord-<id>` record body. Errors are bare
   * (D-M6) — the reader prefixes the KV key that produced them.
   */
  parseRecord(raw: unknown): ParseRecordResult<DiscordInstanceConfig> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, error: "record must be an object" };
    }

    const { service, id, webhookUrl } = raw as Record<string, unknown>;

    if (service !== "discord") {
      return { ok: false, error: "service mismatch" };
    }

    if (typeof id !== "string") {
      return { ok: false, error: "missing or invalid 'id'" };
    }

    // Uppercase is rejected, not lowercased — writers normalise (D-M7).
    if (!isValidInstanceId(id)) {
      return { ok: false, error: `invalid id '${id}'` };
    }

    if (typeof webhookUrl !== "string") {
      return { ok: false, error: "missing 'webhookUrl'" };
    }

    if (!isValidDiscordWebhookUrl(webhookUrl)) {
      return { ok: false, error: "invalid webhookUrl" };
    }

    return { ok: true, config: { id, webhookUrl } };
  },

  createProvider(channelId: string, config: DiscordInstanceConfig): ChannelProvider {
    return new DiscordProvider(channelId, config.webhookUrl);
  },

  displayName(instanceId: string): string {
    return `Discord (${instanceId})`;
  },
};
