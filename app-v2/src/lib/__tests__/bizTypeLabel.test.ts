import { describe, it, expect } from "vitest";
import { bizTypeLabel, BIZ_TYPE_LABELS } from "@/types/merchant";

describe("bizTypeLabel", () => {
  it("shows LLC in capitals, never Llc", () => {
    expect(bizTypeLabel("llc")).toBe("LLC");
  });
  it("labels every entity type and tolerates blank", () => {
    for (const label of Object.values(BIZ_TYPE_LABELS)) expect(label).not.toBe("Llc");
    expect(bizTypeLabel("")).toBe("");
    expect(bizTypeLabel(undefined)).toBe("");
  });
});
