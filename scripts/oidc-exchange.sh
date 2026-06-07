#!/usr/bin/env bash
# oidc-exchange.sh — Exchange a GitHub Actions OIDC token for a dovecote token.
#
# Usage (called by .github/actions/setup-dovecote/action.yml):
#
#   OIDC mode (default when MODE != legacy and INPUT_TOKEN is empty):
#     Required env:
#       ACTIONS_ID_TOKEN_REQUEST_URL   — GitHub-provided OIDC token endpoint
#       ACTIONS_ID_TOKEN_REQUEST_TOKEN — Bearer token for that endpoint
#       DOVECOTE_SERVER_URL            — base URL of the dovecote Worker
#       OIDC_AUDIENCE                  — audience claim expected by the Worker
#     Optional env:
#       GITHUB_ENV                     — path to file to append DOVECOTE_TOKEN= to
#
#   Legacy mode (activated when MODE=legacy OR INPUT_TOKEN is non-empty):
#     Required env:
#       INPUT_TOKEN  — the pre-issued dovecote token (dvct_...)
#     No HTTP requests are made.
#
# Constraint-4 note (doc): run this step ONLY when the token is about to be
# used, not at the start of the job, to minimise the window a token is live.
#
set -euo pipefail

# ---------- mode detection --------------------------------------------------
MODE="${MODE:-}"
INPUT_TOKEN="${INPUT_TOKEN:-}"

if [[ "$MODE" == "legacy" || -n "$INPUT_TOKEN" ]]; then
  # ---- legacy path: write INPUT_TOKEN directly, zero HTTP ----
  echo "::add-mask::${INPUT_TOKEN}"
  echo "DOVECOTE_TOKEN=${INPUT_TOKEN}" >> "${GITHUB_ENV}"
  exit 0
fi

# ---- OIDC path (default) ----

# Validate required variables before any network I/O
if [[ -z "${DOVECOTE_SERVER_URL:-}" ]]; then
  echo "oidc-exchange: DOVECOTE_SERVER_URL is required in OIDC mode (set server-url input or DOVECOTE_SERVER_URL env)" >&2
  exit 1
fi

if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]]; then
  echo "oidc-exchange: ACTIONS_ID_TOKEN_REQUEST_URL is not set — ensure the job has id-token: write permission" >&2
  exit 1
fi

if [[ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]; then
  echo "oidc-exchange: ACTIONS_ID_TOKEN_REQUEST_TOKEN is not set" >&2
  exit 1
fi

OIDC_AUDIENCE="${OIDC_AUDIENCE:-}"
if [[ -z "$OIDC_AUDIENCE" ]]; then
  echo "oidc-exchange: OIDC_AUDIENCE is not set" >&2
  exit 1
fi

# ---------- 1. Fetch GitHub OIDC id_token -----------------------------------
OIDC_TMPFILE="$(mktemp)"
trap 'rm -f "$OIDC_TMPFILE"' EXIT

# Build URL: append audience param (existing query string handled with &)
if [[ "$ACTIONS_ID_TOKEN_REQUEST_URL" == *"?"* ]]; then
  TOKEN_URL="${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${OIDC_AUDIENCE}"
else
  TOKEN_URL="${ACTIONS_ID_TOKEN_REQUEST_URL}?audience=${OIDC_AUDIENCE}"
fi

OIDC_HTTP_CODE="$(
  curl -sSL \
    -H "Authorization: Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    -H "Accept: application/json" \
    -w "%{http_code}" \
    -o "$OIDC_TMPFILE" \
    "$TOKEN_URL"
)"

if [[ "$OIDC_HTTP_CODE" != 2* ]]; then
  echo "oidc-exchange: GitHub OIDC token fetch failed (HTTP ${OIDC_HTTP_CODE})" >&2
  exit 1
fi

# Parse {"value":"<jwt>"} without jq — extract value of "value" key
ID_TOKEN="$(grep -o '"value":"[^"]*"' "$OIDC_TMPFILE" | grep -o '"[^"]*"$' | tr -d '"')"
if [[ -z "$ID_TOKEN" ]]; then
  echo "oidc-exchange: could not parse id_token from OIDC response" >&2
  exit 1
fi

# ---------- 2. Exchange id_token for dovecote token -------------------------
DVCT_TMPFILE="$(mktemp)"
trap 'rm -f "$OIDC_TMPFILE" "$DVCT_TMPFILE"' EXIT

DVCT_HTTP_CODE="$(
  curl -sSL \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "{\"id_token\":\"${ID_TOKEN}\"}" \
    -w "%{http_code}" \
    -o "$DVCT_TMPFILE" \
    "${DOVECOTE_SERVER_URL}/v1/auth/github-oidc"
)"

if [[ "$DVCT_HTTP_CODE" != 2* ]]; then
  echo "oidc-exchange: dovecote token exchange failed (HTTP ${DVCT_HTTP_CODE})" >&2
  exit 1
fi

# Parse {"token":"dvct_...",...} without jq
DVCT_TOKEN="$(grep -o '"token":"[^"]*"' "$DVCT_TMPFILE" | grep -o '"[^"]*"$' | tr -d '"')"
if [[ -z "$DVCT_TOKEN" ]]; then
  echo "oidc-exchange: could not parse token from dovecote response" >&2
  exit 1
fi

# ---------- 3. Mask BEFORE writing to GITHUB_ENV ----------------------------
echo "::add-mask::${DVCT_TOKEN}"
echo "DOVECOTE_TOKEN=${DVCT_TOKEN}" >> "${GITHUB_ENV}"
