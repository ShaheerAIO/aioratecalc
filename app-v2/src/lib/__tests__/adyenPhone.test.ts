import { describe, it, expect } from "vitest";
import { toE164Phone } from "@/lib/utils";

describe("toE164Phone", () => {
  it("converts a plain 10-digit number to E.164", () => {
    expect(toE164Phone("5106680242")).toBe("+15106680242");
  });

  it("converts an 11-digit number starting with 1 to E.164", () => {
    expect(toE164Phone("15106680242")).toBe("+15106680242");
  });

  it("passes through an already-E.164 number unchanged", () => {
    expect(toE164Phone("+15106680242")).toBe("+15106680242");
  });

  it("strips punctuation from a 10-digit number", () => {
    expect(toE164Phone("(714) 833-5760")).toBe("+17148335760");
    expect(toE164Phone("714-833-5760")).toBe("+17148335760");
  });

  it("passes through a number with an extension unchanged (can't confidently normalize)", () => {
    expect(toE164Phone("555-000-0000 ext 123")).toBe("555-000-0000 ext 123");
  });

  it("returns undefined for an empty string", () => {
    expect(toE164Phone("")).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(toE164Phone(undefined)).toBeUndefined();
  });

  it("passes through a clearly-foreign or malformed number unchanged", () => {
    // 11 digits but doesn't start with 1 — not a NANP number, don't guess.
    expect(toE164Phone("442079460958")).toBe("442079460958");
    // Too short to be a real number.
    expect(toE164Phone("555-0000")).toBe("555-0000");
  });
});
