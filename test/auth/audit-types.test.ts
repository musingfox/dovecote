// Type-level test for AuditEvent union
// This file exists purely for type-checking; no runtime tests

import type { AuditEvent } from "../../src/auth/audit";

// Test: token.issue with all required fields
const _e1: AuditEvent = {
  event: "token.issue",
  userId: "u",
  tokenId: "t_1",
  scopes: ["dovecote:notify"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// Test: token.revoke with tokenId (required for this variant)
const _e2: AuditEvent = {
  event: "token.revoke",
  tokenId: "t_1",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// Test: token.use with route
const _e3: AuditEvent = {
  event: "token.use",
  tokenId: "t_1",
  route: "/mcp",
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// Test: authorize (pre-token, no tokenId)
const _e4: AuditEvent = {
  event: "authorize",
  userId: "u",
  authMethod: "none",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// Test: env.read
const _e5: AuditEvent = {
  event: "env.read",
  userId: "u",
  profile: "prod",
  authMethod: "oauth",
  ip: "1.2.3.4",
  scope: "dovecote:env:read",
  ok: true,
};

// Test: admin.revoke
const _e6: AuditEvent = {
  event: "admin.revoke",
  grantId: "grant_123",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// Test: admin.bootstrap
const _e7: AuditEvent = {
  event: "admin.bootstrap",
  clientName: "my-client",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// Test: notify.send
const _e8: AuditEvent = {
  event: "notify.send",
  userId: "u",
  channel: "channel-1",
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// Test: With optional reason field
const _e9: AuditEvent = {
  event: "authorize",
  userId: "u",
  authMethod: "none",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: false,
  reason: "invalid password",
};

// Test: With optional tokenId on admin events
const _e10: AuditEvent = {
  event: "admin.revoke",
  grantId: "grant_123",
  tokenId: "t_1",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required tokenId on token.revoke
const _bad1: AuditEvent = {
  event: "token.revoke",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required tokenId on token.issue
const _bad2: AuditEvent = {
  event: "token.issue",
  userId: "u",
  scopes: ["dovecote:notify"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required userId on token.issue
const _bad3: AuditEvent = {
  event: "token.issue",
  tokenId: "t_1",
  scopes: ["dovecote:notify"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required scopes on token.issue
const _bad4: AuditEvent = {
  event: "token.issue",
  userId: "u",
  tokenId: "t_1",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required channel on notify.send
const _bad5: AuditEvent = {
  event: "notify.send",
  userId: "u",
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// @ts-expect-error - Missing required profile on env.read
const _bad6: AuditEvent = {
  event: "env.read",
  userId: "u",
  authMethod: "oauth",
  ip: "1.2.3.4",
  scope: "dovecote:env:read",
  ok: true,
};

// @ts-expect-error - Missing required grantId on admin.revoke
const _bad7: AuditEvent = {
  event: "admin.revoke",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required clientName on admin.bootstrap
const _bad8: AuditEvent = {
  event: "admin.bootstrap",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: true,
};

// @ts-expect-error - Missing required route on token.use
const _bad9: AuditEvent = {
  event: "token.use",
  tokenId: "t_1",
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// @ts-expect-error - Missing required ip on all events
const _bad10: AuditEvent = {
  event: "authorize",
  userId: "u",
  authMethod: "none",
  scope: "dovecote:notify",
  ok: true,
};

// @ts-expect-error - Missing required authMethod on all events
const _bad11: AuditEvent = {
  event: "authorize",
  userId: "u",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// @ts-expect-error - Missing required scope on all events
const _bad12: AuditEvent = {
  event: "authorize",
  userId: "u",
  ip: "1.2.3.4",
  authMethod: "none",
  ok: true,
};

// @ts-expect-error - Missing required ok on all events
const _bad13: AuditEvent = {
  event: "authorize",
  userId: "u",
  ip: "1.2.3.4",
  authMethod: "none",
  scope: "dovecote:notify",
};
