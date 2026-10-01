// /admin is a single surface with four mutually-exclusive views selected by
// ?view=. The mapping lives here (rather than in either component) so the nav's
// active state and the dashboard's rendered view can never disagree.
export type AdminView = "reps" | "accounts" | "leads" | "revenue";

const NON_DEFAULT: AdminView[] = ["accounts", "leads", "revenue"];

// Anything unrecognised (absent, empty, "reps", junk) falls back to the default
// "By Rep" view, so /admin with no query string is always the dashboard.
export function parseAdminView(raw: string | null | undefined): AdminView {
  return NON_DEFAULT.includes(raw as AdminView) ? (raw as AdminView) : "reps";
}
