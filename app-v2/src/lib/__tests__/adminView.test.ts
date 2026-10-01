import { describe, it, expect } from "vitest";
import { parseAdminView } from "@/lib/adminView";

describe("parseAdminView", () => {
  it("maps the non-default views through", () => {
    expect(parseAdminView("accounts")).toBe("accounts");
    expect(parseAdminView("leads")).toBe("leads");
    expect(parseAdminView("revenue")).toBe("revenue");
  });

  it("defaults to the rep breakdown for absent or unknown values", () => {
    expect(parseAdminView(null)).toBe("reps");
    expect(parseAdminView(undefined)).toBe("reps");
    expect(parseAdminView("")).toBe("reps");
    expect(parseAdminView("reps")).toBe("reps");
    expect(parseAdminView("Accounts")).toBe("reps");
    expect(parseAdminView("nonsense")).toBe("reps");
  });
});
