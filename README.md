# Dovecote

Agent notification infrastructure — an MCP server deployed on Cloudflare Workers that receives messages from agents and forwards them to configured notification channels.

## Features

- **MCP over Streamable HTTP** — compatible with Claude Code, Claude web connector, and any MCP client
- **Multi-channel notifications** — Telegram Bot API, Discord Webhook, Slack Webhook
- **Bearer token auth** — only authorized agents can send notifications
- **Encrypted channel config** — webhook credentials stored in Cloudflare KV with AES-256-GCM encryption

## Architecture

```
Agent (Claude Code / claude.ai / any MCP client)
  │
  ▼  MCP over SSE (Bearer token)
Dovecote (Cloudflare Worker)
  │
  ├──▶ Telegram Bot API
  ├──▶ Discord Webhook
  └──▶ Slack Webhook
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `send_notification` | Send a message to a specified notification channel |
| `list_channels` | List all available notification channels |

## Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript)
- **Transport**: Streamable HTTP (SSE)
- **Storage**: Cloudflare KV (encrypted)
- **Auth**: Bearer token via Worker Secrets

## Setup

TODO

## License

MIT
