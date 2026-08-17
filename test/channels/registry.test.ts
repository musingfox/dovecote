import { describe, it, expect, mock, beforeEach, spyOn } from "bun:test";
import {
  readChannelRecord,
  getChannelConfigs,
  sendToChannel,
} from "../../src/channels/registry";
import { MockKV } from "../helpers/mock-kv";
import type { Env } from "../../src/types";

/** MockKV that records every `get` / `list` so call counts can be asserted. */
class CountingKV extends MockKV {
  gets: string[] = [];
  lists: Array<string | undefined> = [];

  override async get(key: string, options?: any): Promise<any> {
    this.gets.push(key);
    return super.get(key, options);
  }

  override async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
    this.lists.push(options?.prefix);
    return super.list(options);
  }
}

async function buildEnv(
  seed: Record<string, string> = {}
): Promise<{ env: Env; kv: CountingKV }> {
  const kv = new CountingKV();
  for (const [key, value] of Object.entries(seed)) {
    await kv.put(key, value);
  }
  kv.gets = [];
  kv.lists = [];
  return { env: { OAUTH_KV: kv, HMAC_PEPPER: "test-pepper" } as unknown as Env, kv };
}

const TELEGRAM_DEFAULT = JSON.stringify({
  service: "telegram",
  id: "default",
  botToken: "t",
  chatId: "c",
});

const DISCORD_OPS = JSON.stringify({
  service: "discord",
  id: "ops",
  webhookUrl: "https://discord.com/api/webhooks/1/t",
});

describe("readChannelRecord (ChannelRecordRead)", () => {
  it("stored telegram record → validated config", async () => {
    const { env } = await buildEnv({ "channel:telegram-default": TELEGRAM_DEFAULT });
    expect(await readChannelRecord("telegram-default", env)).toEqual({
      service: "telegram",
      config: { id: "default", botToken: "t", chatId: "c" },
    });
  });

  it("stored discord record → validated config", async () => {
    const { env } = await buildEnv({ "channel:discord-ops": DISCORD_OPS });
    expect(await readChannelRecord("discord-ops", env)).toEqual({
      service: "discord",
      config: { id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/t" },
    });
  });

  it("empty KV → null", async () => {
    const { env, kv } = await buildEnv();
    expect(await readChannelRecord("telegram-default", env)).toBeNull();
    expect(kv.gets).toEqual(["channel:telegram-default"]);
  });

  it("malformed channel id → null with zero KV gets", async () => {
    const { env, kv } = await buildEnv({ "channel:telegram-default": TELEGRAM_DEFAULT });
    expect(await readChannelRecord("../user:admin", env)).toBeNull();
    expect(kv.gets).toEqual([]);
  });

  it("unknown service segment → null with zero KV gets", async () => {
    const { env, kv } = await buildEnv();
    expect(await readChannelRecord("nosuchservice-x", env)).toBeNull();
    expect(kv.gets).toEqual([]);
  });

  it("id with no dash → null with zero KV gets", async () => {
    const { env, kv } = await buildEnv();
    expect(await readChannelRecord("telegram", env)).toBeNull();
    expect(kv.gets).toEqual([]);
  });

  it("unparseable JSON → null and one warning naming the key", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv({ "channel:telegram-ops": "not json" });

    expect(await readChannelRecord("telegram-ops", env)).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("channel:telegram-ops");

    warnSpy.mockRestore();
  });

  it("record id contradicting the key → null (D-M3)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv({
      "channel:telegram-ops": JSON.stringify({
        service: "telegram",
        id: "other",
        botToken: "t",
        chatId: "c",
      }),
    });

    expect(await readChannelRecord("telegram-ops", env)).toBeNull();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("channel:telegram-ops");

    warnSpy.mockRestore();
  });

  it("record service contradicting the key → null (D-M3)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv({ "channel:telegram-ops": DISCORD_OPS });

    expect(await readChannelRecord("telegram-ops", env)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("channel:telegram-ops: service mismatch");

    warnSpy.mockRestore();
  });

  it("invalid record → warning is the KV key plus the bare adapter message (D-M6)", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv({
      "channel:telegram-ops": JSON.stringify({ service: "telegram", id: "ops" }),
    });

    expect(await readChannelRecord("telegram-ops", env)).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("channel:telegram-ops: missing 'botToken'");
    expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain("INSTANCES");

    warnSpy.mockRestore();
  });

  it("plain miss warns nothing", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv();

    expect(await readChannelRecord("telegram-default", env)).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe("sendToChannel (ChannelSendRoutesViaKv)", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("valid stored telegram channel → provider result", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 7, text: "hi", chat: { id: "c" } } }),
          { status: 200 }
        )
      )
    );
    globalThis.fetch = mockFetch as any;

    const { env } = await buildEnv({ "channel:telegram-default": TELEGRAM_DEFAULT });
    const result = await sendToChannel("telegram-default", { text: "hi" }, env);

    expect(result.success).toBe(true);
    expect(result.channel).toBe("telegram-default");
    expect(result.messageId).toBe("7");
  });

  it("resolves with exactly one KV get of that channel's key and no list", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 })
      )
    );
    globalThis.fetch = mockFetch as any;

    const { env, kv } = await buildEnv({ "channel:telegram-default": TELEGRAM_DEFAULT });
    await sendToChannel("telegram-default", { text: "hi" }, env);

    expect(kv.gets).toEqual(["channel:telegram-default"]);
    expect(kv.lists).toEqual([]);
  });

  it("empty KV → Unknown channel", async () => {
    const { env } = await buildEnv();
    expect(await sendToChannel("telegram-default", { text: "hi" }, env)).toEqual({
      success: false,
      channel: "telegram-default",
      error: "Unknown channel",
    });
  });

  it("stored record without credentials → Unknown channel", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv({
      "channel:telegram-ops": JSON.stringify({ service: "telegram", id: "ops" }),
    });

    expect(await sendToChannel("telegram-ops", { text: "hi" }, env)).toEqual({
      success: false,
      channel: "telegram-ops",
      error: "Unknown channel",
    });

    warnSpy.mockRestore();
  });

  it("channel id without a service segment → Unknown channel", async () => {
    const { env } = await buildEnv({ "channel:telegram-default": TELEGRAM_DEFAULT });
    expect(await sendToChannel("telegram", { text: "hi" }, env)).toEqual({
      success: false,
      channel: "telegram",
      error: "Unknown channel",
    });
  });

  it("routes a stored discord channel to the Discord provider", async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ id: "discord-123", embeds: [{ title: "Test" }], channel_id: "ch-1" }),
          { status: 200 }
        )
      )
    );
    globalThis.fetch = mockFetch as any;

    const { env } = await buildEnv({ "channel:discord-ops": DISCORD_OPS });
    const result = await sendToChannel("discord-ops", { embed: { title: "Test" } }, env);

    expect(result.success).toBe(true);
    expect(result.channel).toBe("discord-ops");
    expect(result.messageId).toBe("discord-123");
  });
});

describe("getChannelConfigs (ChannelRegistryListing)", () => {
  it("valid telegram + discord records → ascending channel-id order", async () => {
    const { env } = await buildEnv({
      "channel:telegram-default": TELEGRAM_DEFAULT,
      "channel:discord-ops": DISCORD_OPS,
    });

    expect(await getChannelConfigs(env)).toEqual([
      { id: "discord-ops", name: "Discord (ops)", enabled: true, service: "discord" },
      { id: "telegram-default", name: "Telegram (default)", enabled: true, service: "telegram" },
    ]);
  });

  it("empty KV → []", async () => {
    const { env } = await buildEnv();
    expect(await getChannelConfigs(env)).toEqual([]);
  });

  it("a corrupt record does not hide its healthy sibling", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const { env } = await buildEnv({
      "channel:telegram-good": JSON.stringify({
        service: "telegram",
        id: "good",
        botToken: "t",
        chatId: "c",
      }),
      "channel:telegram-bad": "{",
    });

    const configs = await getChannelConfigs(env);
    expect(configs).toHaveLength(1);
    expect(configs[0]?.id).toBe("telegram-good");

    warnSpy.mockRestore();
  });

  it("two records of the same service both appear", async () => {
    const { env } = await buildEnv({
      "channel:telegram-a": JSON.stringify({
        service: "telegram",
        id: "a",
        botToken: "t",
        chatId: "c",
      }),
      "channel:telegram-b": JSON.stringify({
        service: "telegram",
        id: "b",
        botToken: "t",
        chatId: "c",
      }),
    });

    expect((await getChannelConfigs(env)).map((c) => c.id)).toEqual([
      "telegram-a",
      "telegram-b",
    ]);
  });

  it("unrelated KV keys are ignored", async () => {
    const { env } = await buildEnv({ "user:alice": JSON.stringify({ username: "alice" }) });
    expect(await getChannelConfigs(env)).toEqual([]);
  });

  it("performs exactly one list call, scoped to the channel prefix", async () => {
    const { env, kv } = await buildEnv({
      "channel:telegram-good": JSON.stringify({
        service: "telegram",
        id: "good",
        botToken: "t",
        chatId: "c",
      }),
    });

    await getChannelConfigs(env);

    expect(kv.lists).toEqual(["channel:"]);
  });

  it("a KV list failure rejects rather than reporting no channels", async () => {
    const env = {
      OAUTH_KV: {
        list: () => Promise.reject(new Error("kv down")),
        get: () => Promise.resolve(null),
      },
      HMAC_PEPPER: "test-pepper",
    } as unknown as Env;

    await expect(getChannelConfigs(env)).rejects.toThrow("kv down");
  });
});
