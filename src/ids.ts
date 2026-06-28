export const INV_BASE = 8_000_000_000_000_000;

export const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/plain": "txt",
};

// Candidate extensions a `full/<id>.<ext>` object may carry. Used when probing
// for an object whose ext is unknown (image serve / delete). Shared so the
// serve and delete paths can never drift out of sync.
export const FULL_EXTS = ["png", "jpg", "webp", "txt"];

export function makeId(epochMs: number, rand: string): string {
  const inv = (INV_BASE - epochMs).toString().padStart(16, "0");
  return `${inv}-${rand}`;
}

export function epochMsFromId(id: string): number {
  const inv = Number(id.slice(0, 16));
  return INV_BASE - inv;
}

export function fullKey(id: string, ext: string): string {
  return `full/${id}.${ext}`;
}

export function thumbKey(id: string): string {
  return `thumb/${id}.jpg`;
}

export function idFromFullKey(key: string): string {
  const name = key.slice("full/".length);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

export function randSuffix(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz"; // 36 symbols
  const out: string[] = [];
  const bytes = new Uint8Array(6);
  while (out.length < 6) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (out.length >= 6) break;
      if (b < 252) out.push(chars[b % 36]); // reject 252-255 to keep distribution uniform
    }
  }
  return out.join("");
}
