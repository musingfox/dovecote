/**
 * ChannelAddWritesKvRecord contract tests.
 *
 * `buildChannelWrite` is the pure core; `runChannelAdd` is driven in-process
 * with scripted answers and a recording runner, so every wrangler argv the
 * command would emit is asserted without spawning anything.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { buildChannelWrite, runChannelAdd, type AddIo } from "../../scripts/channel-add.js";
import type { WranglerRunner, WranglerRunResult } from "../../scripts/lib/wrangler-kv.js";

const TELEGRAM_RELEASE = '{"service":"telegram","id":"release","botToken":"t","chatId":"c"}';

/** wrangler's shape for "this key does not exist" (see isKvKeyNotFound). */
const KEY_ABSENT: WranglerRunResult = {
  code: 1,
  stderr: "Failed to fetch https://api.cloudflare.com/... - 404: Not Found);",
};

function recordingRunner(
  getResult: WranglerRunResult = KEY_ABSENT,
): { runner: WranglerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    if (args.includes("get")) return getResult;
    return { code: 0 };
  };
  return { runner, calls };
}

function scriptedIo(answers: string[]): {
  io: AddIo;
  out: string[];
  err: string[];
  asked: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    out,
    err,
    asked,
    io: {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
      ask: async (prompt) => {
        asked.push(prompt);
        const next = queue.shift();
        if (next === undefined) throw new Error(`unexpected prompt: ${prompt}`);
        return next;
      },
    },
  };
}

/** The happy-path telegram answers, in prompt order. */
const TELEGRAM_ANSWERS = ["telegram", "release", "t", "c"];

test("ChannelAddWritesKvRecord T1: telegram answers build the one canonical key and record", () => {
  expect(buildChannelWrite("telegram", { id: "release", botToken: "t", chatId: "c" })).toEqual({
    key: "channel:telegram-release",
    value: TELEGRAM_RELEASE,
  });
});

test("ChannelAddWritesKvRecord T2: a discord webhook on the wrong host is refused with the bare reason", () => {
  expect(
    buildChannelWrite("discord", {
      id: "ops",
      webhookUrl: "https://evil.example/api/webhooks/1/t",
    }),
  ).toEqual({ error: "invalid webhookUrl" });
});

test("ChannelAddWritesKvRecord T3: an uppercase id is lowercased by the writer, in key and record", () => {
  expect(buildChannelWrite("telegram", { id: "Release", botToken: "t", chatId: "c" })).toEqual({
    key: "channel:telegram-release",
    value: TELEGRAM_RELEASE,
  });
});

test("ChannelAddWritesKvRecord T4: an existing channel is not overwritten without --force", async () => {
  const { runner, calls } = recordingRunner({ code: 0, stdout: TELEGRAM_RELEASE });
  const h = scriptedIo(TELEGRAM_ANSWERS);
  const code = await runChannelAdd(["--env", "staging"], runner, h.io);
  expect(code).toBe(1);
  expect(calls.filter((argv) => argv.includes("put"))).toHaveLength(0);
  expect(h.err.join("\n")).toContain("channel:telegram-release");
  expect(h.err.join("\n")).toContain("--force");
});

test("ChannelAddWritesKvRecord T5: --force overwrites the existing channel with exactly one put", async () => {
  const { runner, calls } = recordingRunner({ code: 0, stdout: TELEGRAM_RELEASE });
  const h = scriptedIo(TELEGRAM_ANSWERS);
  const code = await runChannelAdd(["--env", "staging", "--force"], runner, h.io);
  expect(code).toBe(0);
  const puts = calls.filter((argv) => argv.includes("put"));
  expect(puts).toHaveLength(1);
  expect(puts[0]![6]).toBe("channel:telegram-release");
  expect(puts[0]![7]).toBe(TELEGRAM_RELEASE);
});

test("ChannelAddWritesKvRecord T6: a successful run issues one --remote put and touches no secret", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(TELEGRAM_ANSWERS);
  const code = await runChannelAdd(["--env", "production", "--force"], runner, {
    ...h.io,
    ask: async (prompt) => (prompt.includes("PRODUCTION") ? "production" : h.io.ask(prompt)),
  });
  expect(code).toBe(0);

  const puts = calls.filter((argv) => argv.includes("put"));
  expect(puts).toHaveLength(1);
  expect(puts[0]).toContain("--remote");
  expect(puts[0]!.join(" ")).toContain("--env production");
  expect(calls.filter((argv) => argv.some((a) => a.includes("secret")))).toHaveLength(0);
});

test("ChannelAddWritesKvRecord T7: no dovecote subprocess is spawned — the deployed worker is never consulted", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(TELEGRAM_ANSWERS);
  expect(await runChannelAdd(["--env", "staging"], runner, h.io)).toBe(0);

  // Every external interaction went through the injected runner: one get, one put.
  expect(calls).toHaveLength(2);
  expect(calls[0]).toContain("get");
  expect(calls[1]).toContain("put");

  // And the script has no `dovecote` shell-out left in it at all (D-M4).
  const source = readFileSync(
    new URL("../../scripts/channel-add.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toMatch(/spawnSync\(\s*"dovecote"/);
  expect(source).not.toContain("channels list");
});

test("ChannelAddWritesKvRecord T8: a missing --env refuses to run before asking anything", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(TELEGRAM_ANSWERS);
  const code = await runChannelAdd([], runner, h.io);
  expect(code).toBe(1);
  expect(h.asked).toHaveLength(0);
  expect(calls).toHaveLength(0);
  expect(h.err.join("\n")).toContain("--env");
});

test("ChannelAddWritesKvRecord T8b: an --env that is not staging/production refuses to run", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(TELEGRAM_ANSWERS);
  expect(await runChannelAdd(["--env", "dev"], runner, h.io)).toBe(1);
  expect(h.asked).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test("ChannelAddWritesKvRecord: production without typing 'production' writes nothing", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(["yes"]);
  const code = await runChannelAdd(["--env", "production"], runner, h.io);
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(h.asked).toHaveLength(1);
  expect(h.err.join("\n")).toContain("production");
});

test("ChannelAddWritesKvRecord: a discord run writes the discord record and prints the notify hint", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(["Discord", "ops", "https://discord.com/api/webhooks/1/t"]);
  const code = await runChannelAdd(["--env", "staging"], runner, h.io);
  expect(code).toBe(0);
  const puts = calls.filter((argv) => argv.includes("put"));
  expect(puts).toHaveLength(1);
  expect(puts[0]![6]).toBe("channel:discord-ops");
  expect(puts[0]![7]).toBe('{"service":"discord","id":"ops","webhookUrl":"https://discord.com/api/webhooks/1/t"}');
  expect(h.out.join("\n")).toContain("dovecote notify discord-ops");
});

test("ChannelAddWritesKvRecord: an unsupported service exits 1 with nothing written", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(["slack"]);
  expect(await runChannelAdd(["--env", "staging"], runner, h.io)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(h.err.join("\n")).toContain("slack");
});

test("ChannelAddWritesKvRecord: an invalid instance id is re-prompted, not fatal", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(["telegram", "bad--id", "release", "t", "c"]);
  expect(await runChannelAdd(["--env", "staging"], runner, h.io)).toBe(0);
  expect(h.out.join("\n")).toContain("invalid id 'bad--id'");
  expect(calls.filter((argv) => argv.includes("put"))[0]![6]).toBe("channel:telegram-release");
});

test("ChannelAddWritesKvRecord: an empty credential is refused with the bare reason and no write", async () => {
  const { runner, calls } = recordingRunner();
  const h = scriptedIo(["telegram", "release", "", "c"]);
  expect(await runChannelAdd(["--env", "staging"], runner, h.io)).toBe(1);
  expect(calls).toHaveLength(0);
  expect(h.err.join("\n")).toContain("missing 'botToken'");
});

test("ChannelAddWritesKvRecord: a failing existence check aborts before writing", async () => {
  const { runner, calls } = recordingRunner({ code: 1, stderr: "Authentication error" });
  const h = scriptedIo(TELEGRAM_ANSWERS);
  expect(await runChannelAdd(["--env", "staging"], runner, h.io)).toBe(1);
  expect(calls.filter((argv) => argv.includes("put"))).toHaveLength(0);
  expect(h.err.join("\n")).toContain("channel:telegram-release");
});

test("ChannelAddWritesKvRecord: a failing put surfaces the wrangler error and exits 1", async () => {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    if (args.includes("get")) return KEY_ABSENT;
    return { code: 1, stderr: "boom" };
  };
  const h = scriptedIo(TELEGRAM_ANSWERS);
  expect(await runChannelAdd(["--env", "staging"], runner, h.io)).toBe(1);
  expect(h.err.join("\n")).toContain("boom");
});
