import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";
import { DEBUG_ROLE_COOKIE, isDebugRoleSwitchEnabled, parseDebugRole } from "@/lib/auth/debugRole";
import { ENTRA_PROVIDER_ID } from "@/lib/auth/entraDenial";

// Edge-safe: no DB/bcrypt imports here (those live in auth.ts, providers only
// run in the Node route-handler context). Middleware imports this file
// directly so route protection never pulls in the Postgres driver.
export const authConfig: NextAuthConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    // The gate for Entra sign-ins. The account lookup already happened in the
    // provider's profile() (it has to — see auth.ts); this turns a refusal
    // into a real message instead of a bare "AccessDenied", and is the last
    // thing standing between an unprovisioned tenant member and a session.
    //
    // Edge-safe on purpose: middleware imports this file, so no DB reads here.
    // It only reads the marker profile() already put on the user.
    signIn({ user, account }) {
      if (account?.provider !== ENTRA_PROVIDER_ID) return true;
      if (user.denied) return `/login?error=${user.denied}`;
      if (!user.role) return "/login?error=not_provisioned";
      return true;
    },
    authorized({ auth, request }) {
      let role = auth?.user?.role;
      const { pathname } = request.nextUrl;
      // DEBUG-ROLE-SWITCHER: overrides the real session's role for route
      // protection only when explicitly enabled — see lib/auth/debugRole.ts.
      // Scoped to /rep and /admin only: DebugRole can't represent "customer",
      // so a leftover rep/admin debug cookie must never hijack /customer auth
      // (it would permanently block real customer sessions from that route).
      if (isDebugRoleSwitchEnabled() && (pathname.startsWith("/admin") || pathname.startsWith("/rep"))) {
        const debugRole = parseDebugRole(request.cookies.get(DEBUG_ROLE_COOKIE)?.value);
        if (debugRole) role = debugRole;
      }
      if (pathname.startsWith("/admin")) return role === "admin";
      if (pathname.startsWith("/rep")) return role === "rep" || role === "admin";
      if (pathname === "/customer/login") return true;
      if (pathname.startsWith("/customer")) {
        // Customer-scoped actions (src/lib/actions/customer.ts) require role
        // "customer" specifically — no admin-impersonation support exists
        // there, so don't let admin through here either (it would 500).
        if (role === "customer") return true;
        // Customers have no password login — send them to /customer/login
        // (email magic-link) instead of the rep/admin /login page.
        return NextResponse.redirect(new URL("/customer/login", request.nextUrl));
      }
      return true;
    },
    jwt({ token, user }) {
      if (user) token.role = user.role;
      return token;
    },
    session({ session, token }) {
      if (session.user && token.role) session.user.role = token.role;
      if (session.user && token.sub) session.user.id = token.sub;
      return session;
    },
  },
};
