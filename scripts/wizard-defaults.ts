/**
 * Default scopes offered to the operator during setup-wizard / seed-user flows.
 * Must remain a strict subset of SCOPES_SUPPORTED in src/auth/scopes.ts.
 * Extracted here because setup-wizard.ts self-runs main() and cannot be safely imported.
 */
export const DEFAULT_SCOPES: string[] = ["dovecote:notify", "dovecote:admin"];
