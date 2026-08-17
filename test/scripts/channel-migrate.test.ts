/**
 * ChannelMigrateWritesKvRecords contract tests.
 *
 * `planMigration` is the pure core; `runChannelMigrate` is driven in-process
 * with a recording runner so every wrangler argv the command would emit is
 * asserted without spawning anything.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  planMigration,
  runChannelMigrate,
  type MigrateIo,
} from "../../scripts/channel-migrate.js";
import type { WranglerRunner } from "../../scripts/lib/wrangler-kv.js";

function recordingRunner(): { runner: WranglerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    return { code: 0 };
  };
  return { runner, calls };
}

function io(input: unknown): {
  io: MigrateIo;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
      readInput: async () => JSON.stringify(input),
    },
  };
}

const TELEGRAM_DEFAULT = '{"service":"telegram","id":"default","botToken":"t","chatId":"c"}';

test("ChannelMigrateWritesKvRecords T1: a telegram entry plans one canonical channel: key", () => {
  const plan = planMigration({
    telegram: [{ id: "default", botToken: "t", chatId: "c" }],
  });
  expect(plan).toEqual({
    writes: [{ key: "channel:telegram-default", value: TELEGRAM_DEFAULT }],
  });
});

test("ChannelMigrateWritesKvRecords T2: the raw env-var string body plans identically to a real array", () => {
  const fromString = planMigration({
    telegram: '[{"id":"default","botToken":"t","chatId":"c"}]',
  });
  const fromArray = planMigration({
    telegram: [{ id: "default", botToken: "t", chatId: "c" }],
  });
  expect(fromString).toEqual(fromArray);
  expect(fromString).toEqual({
    writes: [{ key: "channel:telegram-default", value: TELEGRAM_DEFAULT }],
  });
});

test("ChannelMigrateWritesKvRecords T3: an uppercase id is lowercased by the writer, in the key and in the record", () => {
  const plan = planMigration({
    telegram: [{ id: "Ops", botToken: "t", chatId: "c" }],
  });
  expect(plan).toEqual({
    writes: [
      {
        key: "channel:telegram-ops",
        value: '{"service":"telegram","id":"ops","botToken":"t","chatId":"c"}',
      },
    ],
  });
});

test("ChannelMigrateWritesKvRecords T4: one bad entry blocks the whole run — errors name the key and nothing is written", async () => {
  const input = {
    telegram: [{ id: "a", botToken: "t", chatId: "c" }],
    discord: [{ id: "b" }],
  };
  const plan = planMigration(input);
  expect("errors" in plan).toBe(true);
  const errors = (plan as { errors: string[] }).errors;
  expect(errors.some((e) => e.includes("channel:discord-b"))).toBe(true);

  const { runner, calls } = recordingRunner();
  const h = io(input);
  const code = await runChannelMigrate(["--env", "staging"], runner, h.io);
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
});

test("ChannelMigrateWritesKvRecords T5: an empty document plans nothing and the command still exits 0", async () => {
  expect(planMigration({})).toEqual({ writes: [] });

  const { runner, calls } = recordingRunner();
  const h = io({});
  const code = await runChannelMigrate(["--env", "staging"], runner, h.io);
  expect(code).toBe(0);
  expect(calls).toHaveLength(0);
  expect(h.out.join("\n")).toContain("nothing to write");
});

test("ChannelMigrateWritesKvRecords T6: re-running the same input emits the identical wrangler argv sequence", async () => {
  const input = {
    telegram: [{ id: "default", botToken: "t", chatId: "c" }],
    discord: [{ id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/t" }],
  };

  const first = recordingRunner();
  expect(await runChannelMigrate(["--env", "staging"], first.runner, io(input).io)).toBe(0);

  const second = recordingRunner();
  expect(await runChannelMigrate(["--env", "staging"], second.runner, io(input).io)).toBe(0);

  expect(second.calls).toEqual(first.calls);
  expect(first.calls).toHaveLength(2);
});

test("ChannelMigrateWritesKvRecords T7: --dry-run issues no put at all", async () => {
  const { runner, calls } = recordingRunner();
  const h = io({ telegram: [{ id: "default", botToken: "t", chatId: "c" }] });
  const code = await runChannelMigrate(["--env", "staging", "--dry-run"], runner, h.io);
  expect(code).toBe(0);
  expect(calls.filter((argv) => argv.includes("put"))).toHaveLength(0);
  expect(calls).toHaveLength(0);
  expect(h.out.join("\n")).toContain("channel:telegram-default");
});

test("ChannelMigrateWritesKvRecords T8: a missing --env refuses to run and writes nothing", async () => {
  const { runner, calls } = recordingRunner();
  const h = io({ telegram: [{ id: "default", botToken: "t", chatId: "c" }] });
  const code = await runChannelMigrate([], runner, h.io);
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(h.err.join("\n")).toContain("--env");
});

test("ChannelMigrateWritesKvRecords T8b: an --env that is not staging/production refuses to run", async () => {
  const { runner, calls } = recordingRunner();
  const h = io({ telegram: [{ id: "default", botToken: "t", chatId: "c" }] });
  const code = await runChannelMigrate(["--env", "dev"], runner, h.io);
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
});

test("ChannelMigrateWritesKvRecords T9: every put targets the deployed namespace of the chosen env", async () => {
  const { runner, calls } = recordingRunner();
  const h = io({
    telegram: [{ id: "default", botToken: "t", chatId: "c" }],
    discord: [{ id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/t" }],
  });
  const code = await runChannelMigrate(["--env", "production"], runner, h.io);
  expect(code).toBe(0);
  const puts = calls.filter((argv) => argv.includes("put"));
  expect(puts).toHaveLength(2);
  for (const argv of puts) {
    expect(argv).toContain("--remote");
    expect(argv.join(" ")).toContain("--env production");
  }
  expect(puts.map((argv) => argv[6])).toEqual([
    "channel:telegram-default",
    "channel:discord-ops",
  ]);
});

test("ChannelMigrateWritesKvRecords: a non-object document is rejected with no writes", () => {
  expect(planMigration([])).toEqual({
    errors: ["input must be a JSON object with 'telegram' and/or 'discord' keys"],
  });
  expect(planMigration(null)).toHaveProperty("errors");
});

test("ChannelMigrateWritesKvRecords: an unknown service key is an error, not a silent drop", () => {
  const plan = planMigration({
    slack: [{ id: "a" }],
    telegram: [{ id: "a", botToken: "t", chatId: "c" }],
  });
  expect("errors" in plan).toBe(true);
  expect((plan as { errors: string[] }).errors.join("\n")).toContain("slack");
});

test("ChannelMigrateWritesKvRecords: a discord webhook on the wrong host is rejected before any write", () => {
  const plan = planMigration({
    discord: [{ id: "ops", webhookUrl: "https://evil.example/api/webhooks/1/t" }],
  });
  expect((plan as { errors: string[] }).errors).toEqual([
    "channel:discord-ops: invalid webhookUrl",
  ]);
});

test("ChannelMigrateWritesKvRecords: unparseable input JSON exits 1 with no writes", async () => {
  const { runner, calls } = recordingRunner();
  const err: string[] = [];
  const code = await runChannelMigrate(["--env", "staging"], runner, {
    out: () => {},
    err: (m) => err.push(m),
    readInput: async () => "{not json",
  });
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(err.join("\n")).toContain("not valid JSON");
});

test("ChannelMigrateWritesKvRecords: a wrangler failure names the key it died on and exits 1", async () => {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    return { code: 1, stderr: "boom" };
  };
  const h = io({ telegram: [{ id: "default", botToken: "t", chatId: "c" }] });
  const code = await runChannelMigrate(["--env", "staging"], runner, h.io);
  expect(code).toBe(1);
  expect(h.err.join("\n")).toContain("channel:telegram-default");
});

test("ChannelMigrateWritesKvRecords: --file reads the document off disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dovecote-migrate-"));
  const file = join(dir, "backup.json");
  writeFileSync(
    file,
    JSON.stringify({ telegram: [{ id: "default", botToken: "t", chatId: "c" }] }),
  );
  try {
    const { runner, calls } = recordingRunner();
    const out: string[] = [];
    const code = await runChannelMigrate(["--env", "staging", "--file", file], runner, {
      out: (m) => out.push(m),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]![6]).toBe("channel:telegram-default");
    expect(calls[0]![7]).toBe(TELEGRAM_DEFAULT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChannelMigrateWritesKvRecords: an unreadable --file exits 1 with no writes", async () => {
  const { runner, calls } = recordingRunner();
  const err: string[] = [];
  const code = await runChannelMigrate(
    ["--env", "staging", "--file", join(tmpdir(), "definitely-absent-dovecote.json")],
    runner,
    { out: () => {}, err: (m) => err.push(m) },
  );
  expect(code).toBe(1);
  expect(calls).toHaveLength(0);
  expect(err.join("\n")).toContain("could not read input");
});
