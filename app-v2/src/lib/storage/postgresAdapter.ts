import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications, appSettings, customerSubmissions } from "@/lib/db/schema";
import type { IStorage, StorageScope, CustomerApplicationPatch } from "./storageInterface";
import { rowToApp, appToRow } from "./applicationRow";
import type { MerchantApplication, CustomerSubmission, AppSettings } from "@/types/merchant";
import { DEFAULT_PROCESSOR } from "@/lib/defaults";

export class PostgresAdapter implements IStorage {
  async listApplications(scope: StorageScope): Promise<MerchantApplication[]> {
    const rows = scope.role === "admin"
      ? await db.select().from(merchantApplications)
      : await db.select().from(merchantApplications).where(eq(merchantApplications.ownerUserId, scope.userId));
    return rows.map(rowToApp);
  }

  async getApplication(scope: StorageScope, id: string): Promise<MerchantApplication | null> {
    const [row] = await db.select().from(merchantApplications).where(eq(merchantApplications.id, id)).limit(1);
    if (!row) return null;
    if (scope.role !== "admin" && row.ownerUserId !== scope.userId) return null;
    return rowToApp(row);
  }

  async saveApplication(scope: StorageScope, app: MerchantApplication): Promise<void> {
    if (scope.role !== "admin" && app.ownerUserId !== scope.userId) return;
    const values = appToRow(app);
    await db
      .insert(merchantApplications)
      .values(values)
      .onConflictDoUpdate({ target: merchantApplications.id, set: values });
  }

  async deleteApplication(scope: StorageScope, id: string): Promise<void> {
    const [row] = await db.select().from(merchantApplications).where(eq(merchantApplications.id, id)).limit(1);
    if (!row) return;
    if (scope.role !== "admin" && row.ownerUserId !== scope.userId) return;
    await db.delete(merchantApplications).where(eq(merchantApplications.id, id));
  }

  async getSettings(): Promise<AppSettings> {
    const [row] = await db.select().from(appSettings).limit(1);
    if (!row) return { processors: [DEFAULT_PROCESSOR], demoBookingUrl: null };
    return { processors: row.processors, adyenConfig: row.adyenConfig ?? undefined, demoBookingUrl: row.demoBookingUrl ?? null };
  }

  async saveSettings(_scope: StorageScope, s: AppSettings): Promise<void> {
    // AppSettings (processors/adyenConfig) stays rep-editable — the admin-only
    // padding/margin policy lives in a separate table (margin_policy). The
    // admin-only demoBookingUrl also lives in this row, but the write gate for
    // IT is enforced one level up, in actions/applications.ts's
    // saveSettingsAction/updateDemoBookingUrlAction — this method just persists
    // whatever AppSettings it's handed.
    const [existing] = await db.select({ id: appSettings.id }).from(appSettings).limit(1);
    const values = {
      processors: s.processors,
      adyenConfig: s.adyenConfig ?? null,
      demoBookingUrl: s.demoBookingUrl ?? null,
      updatedAt: new Date(),
    };
    if (existing) {
      await db.update(appSettings).set(values).where(eq(appSettings.id, existing.id));
    } else {
      await db.insert(appSettings).values(values);
    }
  }

  async listSubmissions(_scope: StorageScope): Promise<CustomerSubmission[]> {
    const rows = await db.select().from(customerSubmissions);
    return rows.map(r => ({
      id: r.id,
      submittedAt: r.submittedAt.toISOString(),
      contactInfo: r.contactInfo,
      analysis: r.analysis as CustomerSubmission["analysis"],
      quote: r.quote as CustomerSubmission["quote"],
    }));
  }

  async saveSubmission(s: CustomerSubmission): Promise<void> {
    await db.insert(customerSubmissions).values({
      submittedAt: new Date(s.submittedAt),
      contactInfo: s.contactInfo,
      analysis: s.analysis,
      quote: s.quote,
    });
  }

  async listApplicationsForCustomer(customerUserId: string): Promise<MerchantApplication[]> {
    const rows = await db
      .select()
      .from(merchantApplications)
      .where(eq(merchantApplications.customerUserId, customerUserId));
    return rows.map(rowToApp);
  }

  async getApplicationForCustomer(customerUserId: string, id: string): Promise<MerchantApplication | null> {
    const [row] = await db
      .select()
      .from(merchantApplications)
      .where(and(eq(merchantApplications.id, id), eq(merchantApplications.customerUserId, customerUserId)))
      .limit(1);
    return row ? rowToApp(row) : null;
  }

  async updateApplicationAsCustomer(
    customerUserId: string,
    id: string,
    patch: CustomerApplicationPatch
  ): Promise<MerchantApplication> {
    const [updated] = await db
      .update(merchantApplications)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(merchantApplications.id, id), eq(merchantApplications.customerUserId, customerUserId)))
      .returning();
    if (!updated) throw new Error("Application not found or not owned by this customer");
    return rowToApp(updated);
  }
}

export const postgresStorage = new PostgresAdapter();
