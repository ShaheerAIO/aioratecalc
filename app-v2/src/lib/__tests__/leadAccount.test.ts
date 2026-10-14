import { describe, expect, it } from "vitest";
import { canClaimLeadAccount, decideLeadAccountClaim } from "@/lib/leadAccount";

const user = (over: Partial<Parameters<typeof decideLeadAccountClaim>[0]["existingUser"] & object> = {}) => ({
  id: "u1",
  email: "ana@tortapalace.com",
  role: "customer",
  passwordHash: null,
  disabledAt: null,
  ...over,
});

describe("decideLeadAccountClaim", () => {
  it("refuses before the quote is accepted", () => {
    expect(decideLeadAccountClaim({ accepted: false, linkedUser: null, existingUser: null }).kind).toBe("not_accepted");
  });

  it("creates an account when nobody owns the application or the email", () => {
    expect(decideLeadAccountClaim({ accepted: true, linkedUser: null, existingUser: null }).kind).toBe("create");
  });

  it("refuses an email someone else owns, even with no password on it", () => {
    expect(decideLeadAccountClaim({ accepted: true, linkedUser: null, existingUser: user() }).kind).toBe("email_taken");
  });

  it("sets a password on the linked account that never got one", () => {
    const linked = user();
    expect(decideLeadAccountClaim({ accepted: true, linkedUser: linked, existingUser: linked }))
      .toEqual({ kind: "set_password", userId: "u1", email: "ana@tortapalace.com" });
  });

  it("never resets a password that already exists", () => {
    const linked = user({ passwordHash: "hash" });
    expect(decideLeadAccountClaim({ accepted: true, linkedUser: linked, existingUser: linked }).kind).toBe("has_account");
  });

  it("refuses a typed email that belongs to a different account than the linked one", () => {
    expect(decideLeadAccountClaim({
      accepted: true,
      linkedUser: user(),
      existingUser: user({ id: "u2", email: "other@x.com" }),
    }).kind).toBe("email_taken");
  });

  it("does not touch a disabled or non-customer linked row", () => {
    expect(decideLeadAccountClaim({ accepted: true, linkedUser: user({ disabledAt: new Date() }), existingUser: null }).kind).toBe("has_account");
    expect(decideLeadAccountClaim({ accepted: true, linkedUser: user({ role: "rep" }), existingUser: null }).kind).toBe("has_account");
  });
});

describe("canClaimLeadAccount", () => {
  it("offers account creation only after acceptance and while no password exists", () => {
    expect(canClaimLeadAccount(false, null)).toBe(false);
    expect(canClaimLeadAccount(true, null)).toBe(true);
    expect(canClaimLeadAccount(true, { passwordHash: null })).toBe(true);
    expect(canClaimLeadAccount(true, { passwordHash: "hash" })).toBe(false);
  });
});
