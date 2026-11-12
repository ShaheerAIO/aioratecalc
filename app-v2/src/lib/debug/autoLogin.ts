// DEBUG-AUTO-LOGIN: debug-only, for the team preview deployment (branch
// debug/team-preview). NEVER MERGE — see MERGE_NOTES.md at the repo root.
//
// DEBUG_AUTO_LOGIN=true (and ENABLE_DEBUG_ROLE_SWITCH=true — it rides on the
// existing switcher and does nothing without it) means a staff visitor with no
// session and no debug_role cookie is treated as if the cookie said "rep". The
// existing switcher then does the rest, unchanged: middleware lets /rep and
// /admin through on the debug role, and getEffectiveRole resolves it to the
// dedicated debug-<role>@aioapp.com row (`debugUserEmail`). The floating
// switch sets the cookie to flip.
//
// Customer surfaces are untouched: the debug role is only ever consulted for
// /rep and /admin (auth.config.ts) and by getEffectiveRole, which customer
// routes don't use. Pure/isomorphic, like debugRole.ts, so middleware can use it.

import { isDebugRoleSwitchEnabled, parseDebugRole, type DebugRole } from "@/lib/auth/debugRole";

export function isDebugAutoLoginEnabled(): boolean {
  return process.env.DEBUG_AUTO_LOGIN === "true" && isDebugRoleSwitchEnabled();
}

/**
 * The debug role in effect for a request: the cookie's, else "rep" when
 * auto-login is on, else null (the real session decides). Null whenever the
 * switcher itself is off, whatever the cookie says.
 */
export function effectiveDebugRole(cookieValue: string | undefined | null): DebugRole | null {
  if (!isDebugRoleSwitchEnabled()) return null;
  return parseDebugRole(cookieValue) ?? (isDebugAutoLoginEnabled() ? "rep" : null);
}

/**
 * The users row a debug role acts as. Under auto-login, the dedicated
 * debug-rep@ / debug-admin@aioapp.com rows (product owner, 2026-11-11: prod
 * has no seeded rows, and edits must be attributable to a debug user, never a
 * real one). Otherwise the local seeded <role>@aioapp.com rows, as before.
 */
export function debugUserEmail(role: DebugRole): string {
  return isDebugAutoLoginEnabled() ? `debug-${role}@aioapp.com` : `${role}@aioapp.com`;
}
