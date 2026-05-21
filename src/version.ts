export const MIN_CLIENT_VERSION = "0.1.0" as const;

export function getHealthResponse(status: "ok" = "ok"): { status: string; timestamp: string; minClientVersion: string } {
  return {
    status,
    timestamp: new Date().toISOString(),
    minClientVersion: MIN_CLIENT_VERSION,
  };
}
