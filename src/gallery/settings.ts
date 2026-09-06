// Token display helper for the gallery's settings panel. Kept as a standalone
// module so it can be unit-tested; page.ts inlines it into the served HTML via
// `${maskToken.toString()}` so the browser runs this exact function, not a copy.
// Pure JS only (no TS-only syntax that would survive into the inlined source).

/** Mask a token for on-screen display: keep 4 chars at each end, dot the rest.
 *  Tokens of 8 chars or fewer are fully masked — showing both ends would leak
 *  most (or all) of them. */
export function maskToken(token: string): string {
  if (token.length <= 8) return "•".repeat(token.length);
  return token.slice(0, 4) + "•".repeat(token.length - 8) + token.slice(-4);
}
