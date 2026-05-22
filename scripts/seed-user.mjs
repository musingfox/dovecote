#!/usr/bin/env node
/**
 * Seed a dovecote user into OAUTH_KV.
 *
 * Hashes the password with PBKDF2-SHA256 (100k iterations, 16-byte random
 * salt, 32-byte derived key) using node:crypto so the output is byte-identical
 * to the server's crypto.subtle.deriveBits verify path.
 *
 * Usage:
 *   node scripts/seed-user.mjs \
 *     --username alice \
 *     --password $PASS \
 *     --scopes dovecote:notify,dovecote:admin \
 *     --pepper $HMAC_PEPPER \
 *     [--namespace-id KV_NS_ID]
 *
 * Output: a single-line wrangler kv key put command, ready to copy-paste.
 */
import { pbkdf2Sync, randomBytes } from "node:crypto";

const SCOPES_SUPPORTED = [
  "dovecote:notify",
  "dovecote:env:read",
  "dovecote:admin",
];

const ITERATIONS = 100_000;
const KEY_LENGTH_BYTES = 32;
const SALT_LENGTH_BYTES = 16;
const USERNAME_REGEX = /^[a-z0-9._-]{1,64}$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function die(msg) {
  process.stderr.write(`seed-user: ${msg}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));

const username = args.username;
const password = args.password;
const scopesRaw = args.scopes;
const pepper = args.pepper;
const namespaceId = args["namespace-id"];

if (!username || typeof username !== "string") {
  die("missing required --username");
}
if (!USERNAME_REGEX.test(username)) {
  die(`invalid username "${username}": must match [a-z0-9._-]{1,64}`);
}
if (!password || typeof password !== "string") {
  die("missing required --password");
}
if (!scopesRaw || typeof scopesRaw !== "string") {
  die("missing required --scopes (comma-separated)");
}
if (!pepper || typeof pepper !== "string") {
  die("missing required --pepper");
}

const scopes = scopesRaw.split(",").map((s) => s.trim()).filter(Boolean);
if (scopes.length === 0) {
  die("--scopes must list at least one scope");
}
for (const s of scopes) {
  if (!SCOPES_SUPPORTED.includes(s)) {
    die(`unsupported scope "${s}"; must be one of: ${SCOPES_SUPPORTED.join(", ")}`);
  }
}

// PBKDF2: input material is password + pepper concatenated (matches server)
const salt = randomBytes(SALT_LENGTH_BYTES);
const derived = pbkdf2Sync(password + pepper, salt, ITERATIONS, KEY_LENGTH_BYTES, "sha256");

const record = {
  username,
  algo: "pbkdf2-sha256",
  iterations: ITERATIONS,
  salt: salt.toString("base64"),
  hash: derived.toString("base64"),
  scopes,
  createdAt: new Date().toISOString(),
};

const json = JSON.stringify(record);
const namespaceFlag = namespaceId ? ` --namespace-id "${namespaceId}"` : "";
const cmd = `wrangler kv key put --binding OAUTH_KV "user:${username}" '${json}'${namespaceFlag}`;

process.stdout.write(cmd + "\n");
