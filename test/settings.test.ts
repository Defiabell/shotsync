import { describe, it, expect } from "vitest";
import { maskToken } from "../src/gallery/settings";

describe("maskToken", () => {
  it("keeps the first 4 and last 4 characters and hides the middle", () => {
    expect(maskToken("abcd0123456789wxyz")).toBe("abcd••••••••••wxyz");
  });

  it("hides everything when the token is too short to safely show its ends", () => {
    expect(maskToken("abcdefgh")).toBe("••••••••");
    expect(maskToken("abc")).toBe("•••");
  });

  it("returns an empty string for an empty token", () => {
    expect(maskToken("")).toBe("");
  });
});
