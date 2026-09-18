"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/lib/auth";
import { ENTRA_PROVIDER_ID } from "@/lib/auth/entraDenial";

// Staff sign-in. Redirects to Microsoft, comes back through
// /api/auth/callback/microsoft-entra-id, and the provider's profile() +
// the signIn callback decide whether a session is issued at all
// (lib/auth/entra.ts). Role routing isn't needed here the way it was for
// password login: only rep/admin rows can complete an Entra sign-in.
export async function entraSignInAction(): Promise<void> {
  await signIn(ENTRA_PROVIDER_ID, { redirectTo: "/rep" });
}

// Admin breakglass — the way back into /admin when Entra is unreachable or
// the app registration is misconfigured. Deliberately unlinked from anywhere
// in the UI; reachable only at /login/breakglass. The `scope` credential is
// what restricts it to admin rows (see lib/auth.ts).
export async function breakglassLoginAction(formData: FormData): Promise<string | undefined> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      scope: "breakglass",
      redirect: false,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return "Invalid credentials, or that account isn't an admin";
    }
    throw error; // rethrow the internal redirect "error" so navigation still happens
  }
  redirect("/admin");
}

export async function logoutAction() {
  await signOut({ redirectTo: "/login" });
}
