---
description: Manage the dovecote roadmap (private GitHub Project, draft-based). Delegates to dv-pm agent.
allowed-tools: ["Agent"]
---

# /pm — Dovecote roadmap PM

Delegate to the `dv-pm` agent so `gh` CLI output and Project JSON stay out of the main context.

Invoke `Agent` with:
- `subagent_type`: `dv-pm`
- `description`: `Dovecote PM op`
- `prompt`: `args=$ARGUMENTS`

Relay the agent's summary verbatim. Do not embellish, re-format, or add commentary the agent did not produce.

## Usage

```
/pm                                 # standup / dashboard
/pm what's next                     # ready-to-pick task by priority + phase
/pm show p2-hono-root-refactor      # detail on one card
/pm p1-service-layer-extract in progress
/pm bump p2-bearer-middleware to high
/pm p2-v1-domain-endpoints depends on p2-bearer-middleware, p2-api-token-store
/pm p1-scope-guard-notify-tools done, archive
/pm add a draft for refresh-token rotation, P2, high
/pm convert spike-zod to a public issue   # sensitive — agent will confirm
```

The agent owns confirmation for sensitive operations (archive of in-progress items, delete, draft→issue conversion). It will use `AskUserQuestion` for those — answer in the same turn.
