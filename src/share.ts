// Signed share links: an item can be exposed via a public, tokenless URL that
// carries an HMAC signature over "<id>.<exp>". The signing key is the same
// shared secret (AUTH_TOKEN). The rest of the pool stays token-gated; only the
// signed id is reachable, and only until `exp`.

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function signShare(id: string, exp: number, secret: string): Promise<string> {
  return hmacHex(secret, `${id}.${exp}`);
}

export async function verifyShare(
  id: string,
  exp: number,
  sig: string,
  secret: string
): Promise<boolean> {
  const expected = await hmacHex(secret, `${id}.${exp}`);
  // Constant-time compare: always iterate max length, fold the length diff in
  // (same pattern as auth.ts), so no early-return reveals more than necessary.
  const maxLen = Math.max(expected.length, sig.length);
  let diff = expected.length ^ sig.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (expected.charCodeAt(i) || 0) ^ (sig.charCodeAt(i) || 0);
  }
  return diff === 0;
}
