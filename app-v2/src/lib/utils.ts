import type { BillingFrequency } from "@/types/merchant";

export const fmt$ = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n || 0);

export const fmt$0 = (n: number | null | undefined) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);

export const fmtPct  = (n: number | null | undefined) => `${((n || 0) * 100).toFixed(4)}%`;
export const fmtPct2 = (n: number | null | undefined) => `${((n || 0) * 100).toFixed(2)}%`;
export const fmtBps  = (n: number | null | undefined) => `${Math.round((n || 0) * 10000)} bps`;

// How many times a billing frequency charges per month. Weekly is 52/12, NOT 4 —
// this is the factor that turns a catalog price into a comparable monthly figure.
// AIO's platform fees bill weekly, so treating a $99 catalog price as $99/month
// understates it by 4.33x. "one_time" is 0: it never recurs, so it must be
// totalled separately rather than folded into a monthly number.
const MONTHLY_CHARGES: Record<BillingFrequency, number> = {
  one_time: 0,
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  per_six_months: 1 / 6,
  annually: 1 / 12,
  per_two_years: 1 / 24,
  per_three_years: 1 / 36,
  per_four_years: 1 / 48,
  per_five_years: 1 / 60,
};

export const monthlyEquivalent = (amount: number, frequency: BillingFrequency) =>
  amount * MONTHLY_CHARGES[frequency];

// Per-cycle label for a quote line, e.g. "$99.00/week". One-time lines have no
// cycle, so callers should render those as a plain amount instead.
const FREQUENCY_LABELS: Record<BillingFrequency, string> = {
  one_time: "one-time",
  weekly: "week",
  biweekly: "2 weeks",
  monthly: "month",
  quarterly: "quarter",
  per_six_months: "6 months",
  annually: "year",
  per_two_years: "2 years",
  per_three_years: "3 years",
  per_four_years: "4 years",
  per_five_years: "5 years",
};

export const fmtFrequency = (frequency: BillingFrequency) => FREQUENCY_LABELS[frequency];

// Adyen requires the 2-letter USPS code for US stateOrProvince and 422s on the
// full name — merchants routinely type "California", and HubSpot Company
// records hold free text too ("Ca", "CA "), so normalize best-effort. Lives
// here rather than in adapters/adyen.ts so the HubSpot prefill mapper can share
// the one normalizer instead of growing a second copy.
const US_STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR",
};

export function usStateCode(state: string | undefined): string | undefined {
  if (!state) return undefined;
  const s = state.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return US_STATE_CODES[s.toLowerCase().replace(/\s+/g, " ")] ?? s;
}

// usStateCode passes an UNRECOGNIZED two-letter value straight through ("XX"
// stays "XX"), so "it normalized" is not the same as "Adyen will accept it".
// Anything that has to survive the Adyen boundary checks membership here.
const US_STATE_CODE_SET = new Set(Object.values(US_STATE_CODES));

export function isUsStateCode(state: string | undefined): boolean {
  const code = usStateCode(state);
  return code !== undefined && US_STATE_CODE_SET.has(code);
}

export function parseJSON(text: string): Record<string, unknown> | null {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const s = clean.indexOf("{");
    const e = clean.lastIndexOf("}");
    if (s !== -1 && e !== -1) return JSON.parse(clean.slice(s, e + 1));
  } catch {}
  return null;
}

// E.164 phone numbers (e.g. "+15106680242"). Reps hand-type free text
// ("555-000-0000", "(714) 833-5760") and the HubSpot prefill deliberately
// renders phones in that same display format. This is the counterpart to
// hubspotPrefill.ts's normalizePhone(), which formats for DISPLAY in the
// opposite direction — the two target different formats and must not be
// conflated.
// Anything that can't be confidently mapped to a 10-digit US number (or is
// already E.164) is returned trimmed but otherwise UNCHANGED — a wrong number
// silently sent to a payments platform is worse than leaving the value alone.
// Lived in adapters/adyen.ts while that adapter was its only consumer; moved
// here when tenant provisioning moved to the AIO dashboard API, which needs
// the same normalization for contactNo/phoneNo.
export function toE164Phone(phone: string | undefined): string | undefined {
  const raw = (phone ?? "").trim();
  if (!raw) return undefined;
  if (raw.startsWith("+")) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}
