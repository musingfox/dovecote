/**
 * SetupWizardWritesChannelToKv contract tests — the wizard's channel step
 * provisions `channel:<id>` KV records instead of pushing a JSON array into a
 * worker secret.
 */
import { test, expect } from "bun:test";
import {
  CHANNEL_SKIP_WARNING,
  collectChannelRecords,
  provisionChannels,
} from "../../scripts/setup-wizard.js";
import { makeWranglerKv, type WranglerRunner } from "../../scripts/lib/wrangler-kv.js";

function recordingRunner(): { runner: WranglerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: WranglerRunner = (args) => {
    calls.push(args);
    return { code: 0 };
  };
  return { runner, calls };
}

test("SetupWizardWritesChannelToKv T1: one telegram answer becomes one canonical channel record", () => {
  expect(collectChannelRecords({ telegram: { id: "ops", botToken: "t", chatId: "c" } })).toEqual([
    {
      key: "channel:telegram-ops",
      value: '{"service":"telegram","id":"ops","botToken":"t","chatId":"c"}',
    },
  ]);
});

test("SetupWizardWritesChannelToKv T2: configuring both services yields both keys", () => {
  const writes = collectChannelRecords({
    telegram: { id: "ops", botToken: "t", chatId: "c" },
    discord: { id: "ops", webhookUrl: "https://discord.com/api/webhooks/1/t" },
  });
  expect(writes.map((w) => w.key)).toEqual(["channel:telegram-ops", "channel:discord-ops"]);
});

test("SetupWizardWritesChannelToKv T3: skipping the step provisions nothing", () => {
  expect(collectChannelRecords({})).toEqual([]);
});

test("SetupWizardWritesChannelToKv T4: provisioning writes one --remote KV put and never touches a secret", async () => {
  const { runner, calls } = recordingRunner();
  const writes = collectChannelRecords({ telegram: { id: "ops", botToken: "t", chatId: "c" } });
  const ids = await provisionChannels(writes, makeWranglerKv("staging", runner));

  expect(ids).toEqual(["telegram-ops"]);
  expect(calls.filter((argv) => argv.join(" ").includes("secret"))).toHaveLength(0);
  const puts = calls.filter((argv) => argv.includes("put"));
  expect(puts).toHaveLength(1);
  expect(puts[0]).toContain("--remote");
  expect(puts[0]![6]).toBe("channel:telegram-ops");
});

test("SetupWizardWritesChannelToKv T5: the skip warning points at channel:add and names no env var", () => {
  expect(CHANNEL_SKIP_WARNING).toContain("channel:add");
  expect(CHANNEL_SKIP_WARNING).not.toContain("INSTANCES");
});

test("SetupWizardWritesChannelToKv: an uppercase instance id is lowercased by the wizard", () => {
  expect(collectChannelRecords({ telegram: { id: "Ops", botToken: "t", chatId: "c" } })).toEqual([
    {
      key: "channel:telegram-ops",
      value: '{"service":"telegram","id":"ops","botToken":"t","chatId":"c"}',
    },
  ]);
});

test("SetupWizardWritesChannelToKv: a bad webhook host warns with the bare reason and skips that service only", () => {
  const warnings: string[] = [];
  const writes = collectChannelRecords(
    {
      telegram: { id: "ops", botToken: "t", chatId: "c" },
      discord: { id: "ops", webhookUrl: "https://evil.example/api/webhooks/1/t" },
    },
    (m) => warnings.push(m)
  );
  expect(writes.map((w) => w.key)).toEqual(["channel:telegram-ops"]);
  expect(warnings.join("\n")).toContain("invalid webhookUrl");
});

test("SetupWizardWritesChannelToKv: an id the reader would reject warns instead of writing an unreachable record", () => {
  const warnings: string[] = [];
  const writes = collectChannelRecords(
    { telegram: { id: "bad id", botToken: "t", chatId: "c" } },
    (m) => warnings.push(m)
  );
  expect(writes).toEqual([]);
  expect(warnings.join("\n")).toContain("invalid id");
});

test("SetupWizardWritesChannelToKv: a failing wrangler put surfaces as a rejection, not a silent success", async () => {
  const runner: WranglerRunner = () => ({ code: 1, stderr: "boom" });
  const writes = collectChannelRecords({ telegram: { id: "ops", botToken: "t", chatId: "c" } });
  await expect(provisionChannels(writes, makeWranglerKv("staging", runner))).rejects.toThrow(
    /channel:telegram-ops/
  );
});
