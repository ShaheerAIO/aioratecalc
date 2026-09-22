import type { MerchantApplication, CustomerSubmission, AppSettings } from "@/types/merchant";

// Caller identity for ownership-scoped access: a rep's application methods
// mean "mine"; an admin's mean "all". Settings/submissions are global tables,
// not owner-scoped, but role is still checked for write access (admin-only).
export type StorageScope = { userId: string; role: "rep" | "admin" };

// Fields a customer is allowed to self-serve edit. Narrower than
// Partial<MerchantApplication> on purpose — MerchantApplication types dates/
// numerics as strings (API shape) while several DB columns store them
// natively (Date, numeric-as-string with different formatting), so a bare
// Partial<MerchantApplication> doesn't line up with the update column types.
export type CustomerApplicationPatch = Partial<
  Pick<
    MerchantApplication,
    // hubspotIds: the on-view billing refresh runs AS THE CUSTOMER and writes
    // the quote/subscription snapshot back, exactly as the Check refresh does
    // for checkIds. Only the snapshot fields are ever touched there — the
    // quote/line-item ids themselves are written by the rep's build action.
    // demo: same posture — the on-view demo-status refresh also runs as the
    // customer. dealLink is deliberately NOT here — a customer must never be
    // able to write which deal an application is backed by.
    "business" | "ownerContact" | "processing" | "agreement" | "stage" | "adyenIds" | "adyenOnboardingUrl" | "checkIds" | "foodbuyIds" | "hubspotDealId" | "hubspotIds" | "demo"
  >
>;

// Server-only contract — implementations must never be imported into a
// client component (a Postgres-backed implementation needs DB credentials
// and a server-only driver). Client code calls Server Actions/API routes,
// which instantiate an implementation using the session-derived scope.
export interface IStorage {
  listApplications(scope: StorageScope): Promise<MerchantApplication[]>;
  getApplication(scope: StorageScope, id: string): Promise<MerchantApplication | null>;
  saveApplication(scope: StorageScope, app: MerchantApplication): Promise<void>;
  deleteApplication(scope: StorageScope, id: string): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(scope: StorageScope, s: AppSettings): Promise<void>;
  listSubmissions(scope: StorageScope): Promise<CustomerSubmission[]>;
  saveSubmission(s: CustomerSubmission): Promise<void>;
  // Customer-scoped access — a separate scoping dimension from StorageScope's
  // rep/admin ownerUserId model, so these are kept as their own methods
  // rather than widening StorageScope.role (see src/lib/actions/customer.ts).
  listApplicationsForCustomer(customerUserId: string): Promise<MerchantApplication[]>;
  getApplicationForCustomer(customerUserId: string, id: string): Promise<MerchantApplication | null>;
  updateApplicationAsCustomer(
    customerUserId: string,
    id: string,
    patch: CustomerApplicationPatch
  ): Promise<MerchantApplication>;
}
