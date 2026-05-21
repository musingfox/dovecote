/**
 * CLI version. Kept in sync with cli/package.json by release tooling.
 */
export const CLI_VERSION = "0.1.0";

/**
 * Compare two semver-like strings (major.minor.patch). Returns:
 *   -1 if a < b, 0 if equal, 1 if a > b.
 * Missing parts default to 0.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}
