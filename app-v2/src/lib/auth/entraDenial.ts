// Edge- and client-safe half of the Entra sign-in flow: the provider id, the
// refusal vocabulary, and the copy shown for each refusal. Kept apart from
// entra.ts so middleware (edge) and /login (client) can import it without
// pulling in the Postgres driver.

export const ENTRA_PROVIDER_ID = "microsoft-entra-id";

/** Why an Entra identity was refused a session. See lib/auth/entra.ts. */
export type EntraDenial =
  | "no_identity"
  | "no_email"
  | "wrong_tenant"
  | "not_provisioned"
  | "not_staff"
  | "disabled"
  | "oid_conflict";

export const ENTRA_DENIAL_MESSAGES: Record<EntraDenial, string> = {
  no_identity: "Microsoft didn't return a usable account id. Try again, or contact your administrator.",
  no_email:
    "Your Microsoft account didn't include an email address. An administrator needs to add the " +
    "email claim to the sign-in app, or set a mail address on your directory account.",
  wrong_tenant: "That account isn't part of the AIO organization.",
  not_provisioned:
    "No AIO account exists for that address yet. An administrator has to add you under " +
    "Admin → Users before you can sign in.",
  not_staff: "That address is registered as a merchant account, not a staff account.",
  disabled: "Your AIO account has been disabled. Contact an administrator.",
  oid_conflict:
    "That AIO account is already linked to a different Microsoft account. An administrator has to " +
    "unlink it before you can sign in.",
};

const DENIALS = Object.keys(ENTRA_DENIAL_MESSAGES) as EntraDenial[];

export function parseEntraDenial(value: string | null | undefined): EntraDenial | null {
  return value && (DENIALS as string[]).includes(value) ? (value as EntraDenial) : null;
}
