import { describe, it, expect } from "vitest";
import { fitDimensions } from "../src/gallery/imageproc";

describe("fitDimensions", () => {
  it("scales landscape so long edge = max", () => {
    expect(fitDimensions(1000, 500, 480)).toEqual({ w: 480, h: 240 });
  });
  it("scales portrait so long edge = max", () => {
    expect(fitDimensions(500, 1000, 480)).toEqual({ w: 240, h: 480 });
  });
  it("does not upscale smaller images", () => {
    expect(fitDimensions(300, 200, 480)).toEqual({ w: 300, h: 200 });
  });
  it("rounds to integers with correct values", () => {
    const r = fitDimensions(1001, 333, 480);
    expect(r).toEqual({ w: 480, h: 160 });
    expect(Number.isInteger(r.w) && Number.isInteger(r.h)).toBe(true);
  });
});
