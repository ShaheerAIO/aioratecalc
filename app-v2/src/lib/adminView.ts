// /admin is a single surface with four mutually-exclusive views selected by
// ?view=. The mapping lives here (rather than in either component) so the nav's
// active state and the dashboard's rendered view can never disagree.
//
// "commissions" (2026-10-13) follows "revenue"'s own precedent from the
// comment this replaced: a tab on this one surface, never a new nav item —
// CLAUDE.md caps the top-level admin nav at 4 items, and this tab row isn't it.
//
// "leads" was removed (2026-10-13) along with the customer self-serve leads
// table it drove — see AccountsDashboard.tsx.
export type AdminView = "reps" | "accounts" | "revenue" | "commissions";

const NON_DEFAULT: AdminView[] = ["accounts", "revenue", "commissions"];

// Anything unrecognised (absent, empty, "reps", junk) falls back to the default
// "By Rep" view, so /admin with no query string is always the dashboard.
export function parseAdminView(raw: string | null | undefined): AdminView {
  return NON_DEFAULT.includes(raw as AdminView) ? (raw as AdminView) : "reps";
}
