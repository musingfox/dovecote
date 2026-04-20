export function splitChannelId(composite: string): { service: string; instance: string } | null {
  const firstDashIndex = composite.indexOf("-");
  if (firstDashIndex === -1) {
    return null;
  }

  const service = composite.slice(0, firstDashIndex);
  const instance = composite.slice(firstDashIndex + 1);

  if (service === "" || instance === "") {
    return null;
  }

  return { service, instance };
}

export const INSTANCE_ID_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function isValidInstanceId(id: string): boolean {
  if (!INSTANCE_ID_REGEX.test(id)) {
    return false;
  }
  // No trailing dash
  if (id.endsWith("-")) {
    return false;
  }
  // No consecutive dashes
  if (id.includes("--")) {
    return false;
  }
  return true;
}

const ALLOWED_DISCORD_HOSTNAMES = new Set(["discord.com", "discordapp.com"]);

export function isValidDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") {
      return false;
    }

    if (!ALLOWED_DISCORD_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      return false;
    }

    if (parsed.port !== "") {
      return false;
    }

    if (!parsed.pathname.startsWith("/api/webhooks/")) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
