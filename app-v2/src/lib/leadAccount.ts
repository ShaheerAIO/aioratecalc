// Pure rules for creating a customer account from the public lead link. The
// DB work lives in lib/actions/leadAccount.ts; this is split out so the rules
// are testable without a database.

type UserLike = {
  id: string;
  email: string;
  role: string;
  passwordHash: string | null;
  disabledAt: Date | null;
};

export type LeadAccountClaim =
  | { kind: "not_accepted" }
  | { kind: "has_account" }
  | { kind: "email_taken" }
  | { kind: "set_password"; userId: string; email: string }
  | { kind: "create" };

/**
 * `linkedUser` is the account already on the application (`customer_user_id`),
 * if any. `existingUser` is whoever owns the email that was typed.
 *
 * A typed email that belongs to someone OTHER than the linked account is
 * refused even when that row has no password: it may be another merchant's
 * account, and a lead link must not be able to set a password on it.
 */
export function decideLeadAccountClaim(input: {
  accepted: boolean;
  linkedUser: UserLike | null;
  existingUser: UserLike | null;
}): LeadAccountClaim {
  const { accepted, linkedUser, existingUser } = input;
  if (!accepted) return { kind: "not_accepted" };

  if (linkedUser) {
    if (linkedUser.passwordHash || linkedUser.disabledAt || linkedUser.role !== "customer") {
      return { kind: "has_account" };
    }
    if (existingUser && existingUser.id !== linkedUser.id) return { kind: "email_taken" };
    return { kind: "set_password", userId: linkedUser.id, email: linkedUser.email };
  }

  if (existingUser) return { kind: "email_taken" };
  return { kind: "create" };
}

/** Should the lead page offer account creation instead of a plain sign-in? */
export function canClaimLeadAccount(accepted: boolean, linkedUser: Pick<UserLike, "passwordHash"> | null): boolean {
  return accepted && !linkedUser?.passwordHash;
}
