import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { AuthError } from "next-auth";
import { signIn } from "@/lib/auth";
import { db } from "@/lib/db/client";
import { customerLoginTokens, users } from "@/lib/db/schema";

// Public — clicked as a plain GET navigation from an email client. Naturally
// outside middleware.ts's matcher (lives under /api/customer, not /customer).
// This does a read-only precheck to compute a clean error/redirect target;
// authorize() in auth.ts still does the atomic mark-used+find-or-create as
// the real source of truth.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const [row] = token
    ? await db.select().from(customerLoginTokens).where(eq(customerLoginTokens.token, token)).limit(1)
    : [];

  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    return NextResponse.redirect(new URL("/customer/login?error=expired", req.url));
  }

  const appDest = row.applicationId ? `/customer/applications/${row.applicationId}` : "/customer";
  // Customers who haven't set a password yet get routed through set-password
  // first, so they stop needing a fresh magic link on every subsequent visit.
  // Case-insensitive, matching authorize()'s lookup of the same token.
  const [existingUser] = await db.select({ passwordHash: users.passwordHash }).from(users)
    .where(sql`lower(${users.email}) = ${row.email.trim().toLowerCase()}`).limit(1);
  const dest = existingUser?.passwordHash ? appDest : `/customer/set-password?next=${encodeURIComponent(appDest)}`;
  try {
    await signIn("credentials", { magicToken: token, redirectTo: dest });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.redirect(new URL("/customer/login?error=invalid", req.url));
    }
    throw error; // the internal NEXT_REDIRECT "error" — rethrow so navigation happens
  }
}
