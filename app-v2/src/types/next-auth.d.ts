import type { DefaultSession } from "next-auth";
import type { EntraDenial } from "@/lib/auth/entraDenial";

declare module "next-auth" {
  interface User {
    // Optional because the Entra provider's profile() returns a refused
    // identity with no role at all — see lib/auth.ts. A session always has
    // one (Session below keeps it required); a candidate user may not.
    role?: "rep" | "admin" | "customer";
    /** Set instead of `role` when an Entra identity was refused. */
    denied?: EntraDenial;
  }
  interface Session {
    user: {
      id: string;
      role: "rep" | "admin" | "customer";
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    role?: "rep" | "admin" | "customer";
  }
}
