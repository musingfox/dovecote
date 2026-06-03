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

// PR-E widened token.issue/token.revoke: userId/tokenId/scopes optional on failure
// paths (forbidden before body read, rate_limited before issue). These were previously
// `@ts-expect-error` for missing-field; now they are valid audit shapes.
const _ok_revoke_partial: AuditEvent = {
  event: "token.revoke",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: false,
  reason: "forbidden",
};

const _ok_issue_no_tokenid: AuditEvent = {
  event: "token.issue",
  userId: "u",
  scopes: ["dovecote:notify"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: false,
  reason: "rate_limited",
};

const _ok_issue_no_userid: AuditEvent = {
  event: "token.issue",
  tokenId: "t_1",
  scopes: ["dovecote:notify"],
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: false,
  reason: "forbidden",
};

const _ok_issue_no_scopes: AuditEvent = {
  event: "token.issue",
  userId: "u",
  tokenId: "t_1",
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
  ok: false,
  reason: "internal_error",
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

const _bad9: AuditEvent = {
  event: "token.use",
  tokenId: "t_1",
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// Phase 4.3 / C-Schema-Audit-List: token.list (success with count + truncated)
const _list_ok: AuditEvent = {
  event: "token.list",
  count: 3,
  truncated: false,
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: true,
};

// token.list forbidden path — userIdFilter, no count
const _list_forbidden: AuditEvent = {
  event: "token.list",
  userIdFilter: "bob",
  authMethod: "api_token",
  ip: "1.2.3.4",
  scope: "dovecote:notify",
  ok: false,
  reason: "forbidden",
};

// token.list admin filter
const _list_admin_filter: AuditEvent = {
  event: "token.list",
  userIdFilter: "alice",
  count: 5,
  truncated: false,
  authMethod: "admin_token",
  ip: "1.2.3.4",
  scope: "dovecote:admin",
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
