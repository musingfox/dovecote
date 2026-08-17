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
