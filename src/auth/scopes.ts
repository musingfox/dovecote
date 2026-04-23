/**
 * Supported OAuth scopes for dovecote
 * Single source of truth referenced by index.ts
 */
export const SCOPES_SUPPORTED = ["dovecote:notify", "dovecote:env:read"] as const;

export type ScopeSupported = (typeof SCOPES_SUPPORTED)[number];

export const SCOPE_DESCRIPTIONS: Record<ScopeSupported, { description: string; warning?: string }> = {
  "dovecote:notify": {
    description: "傳送通知訊息至已連結的頻道",
  },
  "dovecote:env:read": {
    description: "讀取環境變數設定檔",
    warning: "此授權允許讀取完整環境變數",
  },
};
