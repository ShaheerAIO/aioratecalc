import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { compare } from "bcryptjs";
import { and, eq, isNull } from "drizzle-orm";
import { authConfig } from "./auth.config";
import { db } from "@/lib/db/client";
import { users, customerLoginTokens, merchantApplications } from "@/lib/db/schema";
import { resolveEntraStaffUser } from "@/lib/auth/entra";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    // Staff sign-in. AIO runs Microsoft 365, so this is the only visible way
    // into /rep and /admin. See lib/auth/entra.ts for the account-merge rules.
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: process.env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
      // Narrower than the provider's default, which adds Graph's User.Read
      // purely to fetch a profile photo and base64 it into the session JWT.
      // We don't render one, and the cookie is better off without ~3KB of JPEG.
      authorization: { params: { scope: "openid profile email" } },
      // This runs in the /api/auth route handler (Node), so the DB is reachable.
      //
      // The lookup has to happen HERE rather than in the signIn callback:
      // @auth/core seeds the session token's `sub` from whatever this returns as
      // `id` (lib/actions/callback/index.js), and `sub` becomes session.user.id
      // — which is written to merchant_applications.owner_user_id, a strict FK.
      // So the AIO user id must be the id this returns.
      //
      // A refusal can't throw from here without surfacing as an opaque OAuth
      // error, so it's carried out on the user object and turned into a real
      // message by the signIn callback in auth.config.ts. `role` is left unset
      // on a refused identity, so even a session that somehow escaped the gate
      // fails every role check in `authorized`.
      async profile(claims) {
        const resolved = await resolveEntraStaffUser(claims);
        if (!resolved.ok) {
          return { id: `entra:denied:${resolved.denied}`, denied: resolved.denied, email: null, name: null };
        }
        return {
          id: resolved.userId,
          email: resolved.email,
          name: resolved.name,
          role: resolved.role,
        };
      },
    }),
    Credentials({
      // `scope` says which login surface the attempt came from, and the branch
      // below refuses a role that doesn't belong to it. Both surfaces post the
      // same email+password shape, so without it the unlisted admin breakglass
      // and the customer password form would be interchangeable — a customer
      // password would open a staff session and vice versa.
      credentials: { email: {}, password: {}, magicToken: {}, scope: {} },
      async authorize(credentials) {
        const magicToken = credentials?.magicToken as string | undefined;
        if (magicToken) {
          const [tokenRow] = await db
            .select()
            .from(customerLoginTokens)
            .where(eq(customerLoginTokens.token, magicToken))
            .limit(1);
          if (!tokenRow || tokenRow.usedAt || tokenRow.expiresAt.getTime() < Date.now()) return null;

          await db
            .update(customerLoginTokens)
            .set({ usedAt: new Date() })
            .where(eq(customerLoginTokens.id, tokenRow.id));

          let [user] = await db.select().from(users).where(eq(users.email, tokenRow.email)).limit(1);
          if (!user) {
            [user] = await db
              .insert(users)
              .values({ email: tokenRow.email, name: tokenRow.email.split("@")[0], role: "customer" })
              .returning();
          }
          if (user.disabledAt) return null;

          if (tokenRow.applicationId) {
            await db
              .update(merchantApplications)
              .set({ customerUserId: user.id })
              .where(
                and(
                  eq(merchantApplications.id, tokenRow.applicationId),
                  isNull(merchantApplications.customerUserId)
                )
              );
          }

          return { id: user.id, email: user.email, name: user.name, role: user.role };
        }

        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        const scope = credentials?.scope as string | undefined;
        if (!email || !password) return null;
        if (scope !== "customer" && scope !== "breakglass") return null;

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user || !user.passwordHash || user.disabledAt) return null;

        // Reps have no password path at all — they go through Entra. The
        // breakglass exists only so a lost or misconfigured Entra tenant can't
        // lock everyone out of /admin, so it admits admins and nobody else.
        if (scope === "breakglass" && user.role !== "admin") return null;
        if (scope === "customer" && user.role !== "customer") return null;

        const valid = await compare(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
});
