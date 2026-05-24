export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }

  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.max(0, Math.round((parsed - now) / 1000));
}
