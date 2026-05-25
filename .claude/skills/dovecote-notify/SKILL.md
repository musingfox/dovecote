---
name: dovecote-notify
description: Send a notification through the dovecote CLI to a configured channel (Telegram / Discord) on the user's deployed worker. Use this skill whenever the user asks to "notify", "send to Telegram/Discord/ops", "ping a channel", "alert me when X finishes", or proactively when a long-running task you're driving completes and the user has previously asked to be informed. Skill works by shelling out to the `dovecote` CLI binary, which reads its token + server URL from `~/.config/dovecote/config.json` written by `bun run setup`.
---

# dovecote-notify

Send a notification to one of the user's configured channels (Telegram / Discord) via the local `dovecote` CLI binary.

## When to invoke

Use the skill when:

- User says **"notify me"** / **"send to X"** / **"通知"** / **"ping ops"** / **"alert"** / **"提醒我"** / **"傳到 telegram"** with or without naming a specific channel.
- A long-running task you're driving finishes and the user previously asked to be notified.
- Reporting CI / deploy / build outcome to a chat channel the user set up.

Do **NOT** use this skill when:

- You're answering inline — just reply in the conversation.
- You'd be spamming progress updates — only notify at meaningful milestones.
- The user hasn't completed dovecote setup (the CLI / config will be missing).

## Prerequisites

Before sending, confirm these are in place. If any check fails, abort and tell the user to run `bun run setup` inside the dovecote repo (https://github.com/musingfox/dovecote).

```bash
# 1. CLI binary on PATH
command -v dovecote   # must print a path

# 2. Local config exists (mode 0600, contains serverUrl + token)
test -f ~/.config/dovecote/config.json   # must succeed

# 3. (optional but fast) The server is reachable + token valid
dovecote ping         # exits 0 with "OK: <url> (server v<n>, client v<n>)"
```

If `dovecote ping` returns 401 / `invalid_token`, the token expired — tell the user to re-mint via `bun run setup -- --resume`.

## Step 1 — Discover channels

Channel ids follow the pattern `<service>-<instance>`, e.g. `telegram-ops`, `discord-alerts`. Run:

```bash
dovecote channels list
```

Output format (two-column, space-separated):

```
Telegram (ops) | telegram-ops
Discord (alerts) | discord-alerts
```

Pick the right channel id from the right column:

- User named one explicitly (e.g. "ops", "telegram-ops") → use it.
- User said "Telegram" or "Discord" with no instance → use the first matching `telegram-*` / `discord-*`. If multiple, ask the user which.
- User just said "notify me" without naming → default to the first `telegram-*` listed (Telegram is the common ops default) and mention which one you chose.

## Step 2 — Send

### Plain text (single line)

```bash
dovecote notify <channel-id> --text "<message>"
```

### Multi-line / piped from another command

```bash
echo -e "line 1\nline 2\nline 3" | dovecote notify <channel-id> --stdin
# or
your-command | dovecote notify <channel-id> --stdin
```

### Embed (rich formatting)

```bash
dovecote notify <channel-id> --embed-json '{
  "title": "Deploy complete",
  "color": "#36a64f",
  "fields": [
    { "name": "Version", "value": "cli-v0.1.0" },
    { "name": "Targets", "value": "5/5 green" }
  ]
}'
```

Successful exit prints `Sent: messageId=<id> channel=<channel-id>` and exits 0.

## Step 3 — Handle errors

| Symptom (stderr / output) | Cause | Recovery |
|---|---|---|
| `unknown_channel` | Channel id wrong | Re-run `channels list`, pick a valid id |
| HTTP 429 / `rate_limited` | Hit the per-IP rate limit (default 60/min) | The CLI honors `Retry-After` automatically; if you still see this, the channel was hit > 60×/min — wait ~60s then retry **once**, no more |
| 401 / `invalid_token` | Token expired (90d cap) or HMAC_PEPPER rotated | Tell user to run `bun run setup -- --resume` in the dovecote repo |
| `provider_error: chat not found` (Telegram) | Bot kicked from chat, chatId wrong | Tell user to verify Telegram bot is still in the chat |
| `provider_error: Unknown Webhook` (Discord) | Webhook deleted on Discord side | Tell user to regenerate the webhook + re-run setup channel step |
| Connection refused / DNS error | Worker down or URL wrong | Tell user to run `dovecote ping` and check `wrangler tail --env <env>` |

Do not loop-retry indefinitely. One retry for clearly-transient failures (rate_limited only) is the max.

## Concrete examples

### "Notify me when the test suite finishes."

You run the tests, then on completion:

```bash
dovecote notify telegram-ops --text "Test suite: 615 pass / 0 fail (15s)"
```

### "Send the deploy summary to Telegram."

```bash
cat <<'EOF' | dovecote notify telegram-ops --stdin
✅ Deployed cli-v0.1.0 to staging
  • 5 build targets green
  • Release notes published
  • Smoke verified on ubuntu / macos / windows
EOF
```

### "Alert ops about the prod incident."

Use embed for visual urgency:

```bash
dovecote notify telegram-ops --embed-json '{
  "title": "⚠️  Prod incident",
  "color": "#d73a4a",
  "fields": [
    {"name": "Service", "value": "api-v1"},
    {"name": "Started",  "value": "15:23 UTC"},
    {"name": "Owner",    "value": "musingfox"}
  ]
}'
```

### "Background task is done."

When you've finished a `run_in_background` job, fetched a result, etc.:

```bash
dovecote notify telegram-ops --text "🎉 Done: extracted 1,247 entities from the corpus. Output at ~/scratch/entities.jsonl"
```

## Out of scope

- **Do NOT** send notifications **without explicit user intent** — only when they've asked for one, are clearly expecting one, or you're proactively closing out a task they asked you to monitor.
- **Do NOT** echo the token / config file contents to the user or to any notification — `~/.config/dovecote/config.json` is mode 0600 sensitive.
- **Do NOT** call the `/v1/notify` HTTP endpoint directly via `curl` — the CLI handles retry / backoff / `Retry-After` honoring. Use the binary.
- **Do NOT** notify on every intermediate step of a long task — only at logical end-of-job moments.
- **Do NOT** use this skill for self-prompting or inter-agent communication — it's a human notification channel.

## Server-side reference

If the user asks "what is dovecote / where do channels go": dovecote is the user's self-hosted Cloudflare Worker that fronts notification channels behind an OAuth/runtime-token API. Repo at https://github.com/musingfox/dovecote. The user provisioned it via `bun run setup` in that repo; channels (Telegram bots / Discord webhooks) are configured via `wrangler secret put TELEGRAM_INSTANCES / DISCORD_INSTANCES`.
