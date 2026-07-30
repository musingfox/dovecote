# `setup-dovecote` Consumer Runbook

`setup-dovecote` is a composite GitHub Action that downloads a tagged dovecote CLI binary, verifies its `SHA256SUMS`, places it on `PATH`, and (optionally) exports `DOVECOTE_TOKEN` / `DOVECOTE_SERVER_URL` for downstream steps.

This runbook walks a fresh consumer through one end-to-end install against the real `cli-v0.1.0` tag.

## Minimum workflow snippet

```yaml
name: Notify on deploy
on:
  workflow_run:
    workflows: ["Deploy"]
    types: [completed]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: musingfox/dovecote/.github/actions/setup-dovecote@cli-v0.1.0
        with:
          version: "0.1.0"
          server-url: https://dovecote.your-subdomain.workers.dev
        env:
          DOVECOTE_TOKEN: ${{ secrets.DOVECOTE_TOKEN }}

      - run: dovecote notify ops --text "deploy ${{ github.event.workflow_run.conclusion }}"
```

Pin to the tag (`@cli-v0.1.0`) rather than a moving ref. Each CLI release ships its own tag; bump the pin when you intend to upgrade.

## Required secrets

| Secret | Where to set | Purpose |
|---|---|---|
| `DOVECOTE_TOKEN` | repo / org secret | Runtime token (`dvct_...`) used by `dovecote notify`, `dovecote ping`, etc. The action reads it from `inputs.token` first, then falls back to the caller's `env.DOVECOTE_TOKEN`. |
| `DOVECOTE_SERVER_URL` | repo / org secret OR action `with.server-url` | Base URL of the deployed worker. Inline `with.server-url` overrides the env var. |

`DOVECOTE_TOKEN` is sensitive — store it as a GitHub Actions secret, never inline it. The action exports it via `$GITHUB_ENV` so it stays scoped to the job.

## Token provisioning

CI tokens are issued by the same OAuth flow as interactive CLI users; you bootstrap a CI-only client once, then use `dovecote auth login --label` to label the resulting token for traceability.

1. **Bootstrap a CI client** (one-time, against your deployment):

   ```bash
   curl -X POST https://<your-deployment-url>/admin/bootstrap-client \
     -H "Authorization: Bearer <ADMIN_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"clientName":"ci-runner","redirectUris":["http://localhost:9999/cb"]}'
   ```

   Save the returned `client_id` as `DOVECOTE_CLIENT_ID`. See [client-bootstrap.md](./client-bootstrap.md) for the full flow.

2. **Mint a runtime token** from a workstation (interactive OAuth + label):

   ```bash
   export DOVECOTE_CLIENT_ID=<client_id from step 1>
   dovecote auth login \
     --server-url https://<your-deployment-url> \
     --label "ci-runner-$(date +%Y%m%d)"
   ```

   The CLI prints `Logged in. tokenId=... label='ci-runner-...'`. Copy the runtime token (`dvct_...`) from `$XDG_CONFIG_HOME/dovecote/config.json` and store it as the `DOVECOTE_TOKEN` secret.

3. **Rotate periodically.** Runtime tokens cap at 90d TTL. Schedule a refresh well before expiry; `dovecote tokens list --remote` shows what's outstanding.



## Supported target triples

The release workflow builds five archive flavours. `setup-dovecote` selects the right one from `RUNNER_OS` × `RUNNER_ARCH`:

| Runner | Archive |
|---|---|
| `ubuntu-latest` / `ubuntu-24.04` (X64) | `dovecote-bun-linux-x64.tar.gz` |
| Linux ARM64 (self-hosted) | `dovecote-bun-linux-arm64.tar.gz` |
| `macos-latest` / `macos-15` (ARM64) | `dovecote-bun-darwin-arm64.tar.gz` |
| `macos-13` (X64) | `dovecote-bun-darwin-x64.tar.gz` |
| `windows-latest` / `windows-2025` (X64) | `dovecote-bun-windows-x64.zip` |

ARM Linux is built but currently exercised only against self-hosted runners. Other `RUNNER_OS` / `RUNNER_ARCH` combinations exit `Unsupported OS` / `Unsupported arch` at the `Resolve target triple` step.

Every archive ships with the same `SHA256SUMS` manifest; `setup-dovecote` greps the line for its target triple and aborts on mismatch.

## macOS workaround for self-hosted runners

The CLI binary ships **unsigned** in v0.1. On hosted `macos-latest` runners this is invisible (Gatekeeper does not quarantine binaries downloaded by `curl` outside Safari's UI), but **self-hosted macOS runners** that re-use a previously-downloaded archive can hit the `com.apple.quarantine` xattr.

If `dovecote --version` returns `killed: 9` or "cannot be opened because the developer cannot be verified", clear the xattr in the runner's post-install step:

```yaml
- name: Clear macOS quarantine (self-hosted only)
  if: runner.os == 'macOS' && runner.environment == 'self-hosted'
  run: xattr -d com.apple.quarantine "$(command -v dovecote)" || true
```

Code signing is tracked in [ADR 0004](./decisions/) (planned post-v0.1) — once shipped, the workaround becomes unnecessary.

## Troubleshooting

### `release not found: .../dovecote-bun-<triple>.<ext>` (404)
- The pinned tag does not yet have an attached archive for your platform. Check the release page: `https://github.com/musingfox/dovecote/releases/tag/cli-v<version>`.
- If you pinned `@cli-v0.1.0` but passed `with: version: "0.2.0"`, the action constructs the URL from `inputs.version`, not the action ref. Pin and version must agree.

### `Checksum verification failed (expected ..., got ...)`
- The downloaded archive does not match the line in `SHA256SUMS`. Most common cause: the release was re-cut after the tag moved (rare; mid-release-cycle).
- Recovery: re-run the workflow. The action does not cache the download, so a retry refetches.
- If it persists, the archive on the release page is corrupt — open an issue.

### `Checksum verification failed: no entry for dovecote-bun-<triple>.<ext>`
- `SHA256SUMS` exists but does not list your platform's archive. Happens when a partial release was published (one or more build jobs failed but the workflow still uploaded the `SHA256SUMS` it had).
- Recovery: tag-owner re-cuts the release; consumer pins to the new tag.

### `ENOENT: dovecote` or `dovecote: command not found` after install
- The action appended `$RUNNER_TEMP/dovecote` to `$GITHUB_PATH`. Subsequent steps in the same job see it; **steps in a different job do not** (jobs run on separate runners).
- If you need the CLI in a follow-up job, re-run `setup-dovecote` there. Don't share `$RUNNER_TEMP` across jobs.

### `shasum: command not found` (older Windows runners)
- Fixed in `cli-v0.1.0`: the action autoselects `sha256sum` (Linux / Windows Git Bash) over `shasum` (macOS).
- If you see it on an older action ref, bump your `setup-dovecote@<tag>` pin to `cli-v0.1.0` or later.

### `Unrecognized named-value: 'env'` at "Set up job"
- Composite-action input defaults cannot reference `${{ env.* }}` — GitHub validates input defaults at template-resolution time before env is populated.
- Fixed in `cli-v0.1.0`. If you see it on an older ref, bump the pin.

### `dovecote ping` returns 401 but `--version` works
- The CLI installed but `DOVECOTE_TOKEN` was not exported into the step's env. Verify the secret is set on the repo / org AND that the `with: token:` input OR step-level `env: DOVECOTE_TOKEN:` was passed. Setting it only in `env:` at workflow root may not propagate into composite-action steps depending on the runner version.

### `dovecote ping` 401 + token looks correct
- The token may have expired (90d cap). Inspect with `dovecote tokens list --remote` from a workstation; rotate per the Token provisioning section.

## See also

- [client-bootstrap.md](./client-bootstrap.md) — registering OAuth clients
- [deploy-runbook.md](./deploy-runbook.md) — server-side deployment + secret provisioning
- [ADR 0003](./decisions/0003-cli-binary-distribution.md) — CLI binary distribution architecture
- Release page: https://github.com/musingfox/dovecote/releases
