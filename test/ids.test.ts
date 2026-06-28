import { describe, it, expect } from "vitest";
import {
  makeId, epochMsFromId, fullKey, thumbKey, idFromFullKey,
  EXT_BY_TYPE, randSuffix, INV_BASE,
} from "../src/ids";

describe("ids", () => {
  it("makeId pads to 16 digits + suffix", () => {
    const id = makeId(0, "abc123");
    expect(id).toBe(`${String(INV_BASE).padStart(16, "0")}-abc123`);
  });

  it("newer time sorts before older (inverted)", () => {
    const older = makeId(1000, "aaaaaa");
    const newer = makeId(2000, "aaaaaa");
    expect(newer < older).toBe(true); // lexicographic: newer is smaller, sorts first
  });

  it("epochMsFromId is inverse of makeId", () => {
    const id = makeId(1719312000000, "zzzzzz");
    expect(epochMsFromId(id)).toBe(1719312000000);
  });

  it("key helpers", () => {
    expect(fullKey("ID", "png")).toBe("full/ID.png");
    expect(thumbKey("ID")).toBe("thumb/ID.jpg");
    expect(idFromFullKey("full/ID.png")).toBe("ID");
    expect(idFromFullKey("full/0007-xy.webp")).toBe("0007-xy");
  });

  it("EXT_BY_TYPE maps web-safe types", () => {
    expect(EXT_BY_TYPE["image/jpeg"]).toBe("jpg");
    expect(EXT_BY_TYPE["image/png"]).toBe("png");
    expect(EXT_BY_TYPE["image/webp"]).toBe("webp");
  });

  it("randSuffix is 6 base36 chars", () => {
    expect(randSuffix()).toMatch(/^[0-9a-z]{6}$/);
  });
});
