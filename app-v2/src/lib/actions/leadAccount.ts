"use server";

// Creating a customer account from the public lead link, after they've paid.
//
// Acceptance emails a one-shot magic link (lib/billing/acceptance.ts), and that
// link is what creates the `users` row. Miss it — wrong inbox, expired, never
// delivered — and the merchant was stranded: every post-payment row on the lead
// checklist says "Sign in to continue", and /customer/login's "email me a link"
// deliberately refuses an address with no account. This is the way out.
//
// The lead token is the credential here, the same one that already lets its
// holder see the quote and publish it. Two limits keep it from becoming more
// than that:
//   - only once the quote is accepted (there is nothing to sign in TO before),
//   - only where no password exists yet. Once one is set, this path refuses and
//     the merchant signs in normally — the lead link can never reset it.

import { hash } from "bcryptjs";
import { and, eq, isNull, or } from "drizzle-orm";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { merchantApplications, users } from "@/lib/db/schema";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { decideLeadAccountClaim } from "@/lib/leadAccount";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function createAccountFromLeadAction(
  token: string,
  input: { email: string; password: string },
): Promise<string | undefined> {
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  if (!EMAIL_RE.test(email)) return "Enter a valid email address.";
  if (password.length < 8) return "Password must be at least 8 characters.";

  const lookup = await getLeadApplicationByToken(token);
  if (!lookup.ok) return "This link is no longer valid. Ask your AIO representative for a new one.";
  const row = lookup.row;

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const [linked] = row.customerUserId
    ? await db.select().from(users).where(eq(users.id, row.customerUserId)).limit(1)
    : [];

  const decision = decideLeadAccountClaim({
    accepted: Boolean(row.quoteAcceptedAt),
    linkedUser: linked ?? null,
    existingUser: existing ?? null,
  });

  let signInEmail = email;
  switch (decision.kind) {
    case "not_accepted":
      return "Finish signing and paying for your quote first.";
    case "has_account":
      return "You already have an account. Sign in instead.";
    case "email_taken":
      return "That email is already in use. Sign in, or use a different email.";
    case "set_password": {
      const passwordHash = await hash(password, 10);
      // Conditional on the hash still being null, so two tabs can't both win.
      const updated = await db.update(users)
        .set({ passwordHash })
        .where(and(eq(users.id, decision.userId), isNull(users.passwordHash)))
        .returning({ id: users.id });
      if (updated.length === 0) return "You already have an account. Sign in instead.";
      await linkApplication(row.id, decision.userId);
      signInEmail = decision.email;
      break;
    }
    case "create": {
      const passwordHash = await hash(password, 10);
      let created;
      try {
        [created] = await db.insert(users)
          .values({ email, passwordHash, name: email.split("@")[0], role: "customer" })
          .returning({ id: users.id });
      } catch {
        // The unique index on email: someone created this address in between.
        return "That email is already in use. Sign in, or use a different email.";
      }
      const ok = await linkApplication(row.id, created.id);
      if (!ok) {
        // Another account claimed this application in between. No transactions
        // on neon-http, so undo the row we just made rather than orphan it.
        await db.delete(users).where(eq(users.id, created.id));
        return "You already have an account. Sign in instead.";
      }
      break;
    }
  }

  try {
    await signIn("credentials", {
      email: signInEmail,
      password,
      scope: "customer",
      redirectTo: `/customer/applications/${row.id}`,
    });
  } catch (error) {
    if (error instanceof AuthError) return "Your account was created, but signing in failed. Sign in from the login page.";
    throw error; // the internal NEXT_REDIRECT — rethrow so navigation happens
  }
}

async function linkApplication(applicationId: string, userId: string): Promise<boolean> {
  const updated = await db.update(merchantApplications)
    .set({ customerUserId: userId })
    .where(and(
      eq(merchantApplications.id, applicationId),
      or(isNull(merchantApplications.customerUserId), eq(merchantApplications.customerUserId, userId)),
    ))
    .returning({ id: merchantApplications.id });
  return updated.length > 0;
}
