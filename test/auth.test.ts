import { describe, it, expect } from "vitest";
import { isAuthed } from "../src/auth";

const env = { AUTH_TOKEN: "secret123" } as any;

function req(authz?: string): Request {
  return new Request("https://x/api/list", authz ? { headers: { authorization: authz } } : {});
}

describe("isAuthed", () => {
  it("accepts correct bearer", () => {
    expect(isAuthed(req("Bearer secret123"), env)).toBe(true);
  });
  it("rejects wrong token", () => {
    expect(isAuthed(req("Bearer nope"), env)).toBe(false);
  });
  it("rejects missing header", () => {
    expect(isAuthed(req(), env)).toBe(false);
  });
  it("rejects non-bearer scheme", () => {
    expect(isAuthed(req("Basic secret123"), env)).toBe(false);
  });
  it("rejects length mismatch without throwing", () => {
    expect(isAuthed(req("Bearer secret123extra"), env)).toBe(false);
  });
  it("returns false (does not throw) when AUTH_TOKEN is unset", () => {
    expect(isAuthed(req("Bearer anything"), {} as any)).toBe(false);
    expect(isAuthed(req("Bearer anything"), { AUTH_TOKEN: "" } as any)).toBe(false);
  });
});
