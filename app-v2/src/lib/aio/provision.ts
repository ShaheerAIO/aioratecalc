// Provision one merchant into the AIO platform: tenant → location → Adyen KYC
// link, persisting after every step so a broken chain resumes instead of
// starting over.
//
// This is the riskiest code in the feature. Nothing AIO creates can be
// deleted: a business alias is globally unique, delete is soft and never frees
// it, and the database is shared with other AIO teams. A duplicate tenant is
// permanent debris with a real merchant's name on it. So there are three
// independent guards, and they are not redundant:
//
//   1. LEASE      — a conditional UPDATE, so two concurrent cron runs can't
//                   both start. This is the only real defence against
//                   simultaneity.
//   2. RESUME     — skip any step whose id is already persisted. Defends
//                   against a chain that died halfway.
//   3. RECONCILE  — ask AIO whether the alias already exists before creating.
//                   Defends against the case the other two can't: our write
//                   was lost after AIO had already committed.
//
// Runs as the system (a cron), not as a customer, so it writes through `db`
// directly rather than the customer-scoped storage adapter — a customer must
// never be able to write their own tenant ids.

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { merchantApplications } from "@/lib/db/schema";
import type { AioTenantIds, MerchantApplication } from "@/types/merchant";
import {
  aioBusinessAlias,
  aioEnvironment,
  createAioAdyenOnboardingLink,
  createAioBusiness,
  createAioLocation,
  findAioBusinessByAlias,
  adyenEnvironmentFromOnboardingUrl,
  isTenantSchemaNotReady,
} from "@/lib/adapters/aioDashboard";
import { shouldAdvance } from "@/lib/stages";
import { CLAIM_STALE_MS } from "@/lib/aio/provisioningGate";

export type ProvisionOutcome =
  | { status: "provisioned"; businessId: number; locationId: number }
  | { status: "not_claimed" }
  | { status: "needs_attention"; error: string }
  /** Waiting on AIO's tenant schema. NOT a failure — see `defer` below. */
  | { status: "waiting"; until: string }
  | { status: "failed"; error: string };

/**
 * How long after `business/create` the tenant's Postgres schema takes to
 * appear, before which `restaurant/post/create` 500s AND leaves an
 * undeletable half-created row (see AioTenantSchemaNotReadyError).
 *
 * Observed once, live, at ~100 seconds (2026-10-14, tenant 2047). FIVE
 * minutes is deliberately generous against a single measurement: the cost of
 * waiting too long is a few more minutes before the merchant sees their KYC
 * link, and the cost of waiting too little is a permanent junk row in AIO's
 * shared database. Those are not symmetrical.
 */
const SCHEMA_WARMUP_MS = 5 * 60 * 1000;

/**
 * How long to wait after a schema-not-ready 500 before trying again. Longer
 * than the warm-up, because reaching here means five minutes was not enough
 * for this tenant and another junk row has just been created.
 */
const SCHEMA_RETRY_MS = 15 * 60 * 1000;

/** Take the lease. Conditional on the row still being unprovisioned and not
 *  freshly claimed, so a second concurrent run gets rowCount 0 and backs off.
 *  Bumps attempts in the same statement — a claim that never reports back
 *  still counts as a try, which is what makes the backoff real.
 *
 *  `defer` below gives that bump back when the run turns out to have been a
 *  wait rather than a try. */
async function claim(id: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();

  const result = await db
    .update(merchantApplications)
    .set({
      aioTenant: sql`
        COALESCE(${merchantApplications.aioTenant}, '{}'::jsonb)
        || jsonb_build_object(
             'claimedAt', ${nowIso}::text,
             'lastAttemptAt', ${nowIso}::text,
             'attempts', COALESCE((${merchantApplications.aioTenant}->>'attempts')::int, 0) + 1
           )`,
      updatedAt: now,
    })
    .where(
      sql`${merchantApplications.id} = ${id}
          AND (${merchantApplications.aioTenant}->>'provisionedAt') IS NULL
          AND (
            (${merchantApplications.aioTenant}->>'claimedAt') IS NULL
            OR (${merchantApplications.aioTenant}->>'claimedAt') < ${staleBefore}
          )`
    );

  return (result.rowCount ?? 0) > 0;
}

async function patch(id: string, tenant: AioTenantIds): Promise<void> {
  await db
    .update(merchantApplications)
    .set({ aioTenant: tenant, updatedAt: new Date() })
    .where(eq(merchantApplications.id, id));
}

/**
 * Provision `app`. Assumes the caller has already run isReadyForAioProvisioning.
 * Never throws — every outcome is a value, because the caller is a cron
 * iterating rows and one bad merchant must not abort the batch.
 */
export async function provisionAioTenant(app: MerchantApplication): Promise<ProvisionOutcome> {
  const now = new Date();
  if (!(await claim(app.id, now))) return { status: "not_claimed" };

  const alias = app.aioTenant?.alias ?? aioBusinessAlias(app);

  // Start from what the claim just wrote so attempts/lastAttemptAt survive.
  let tenant: AioTenantIds = {
    businessId: app.aioTenant?.businessId ?? 0,
    locationId: app.aioTenant?.locationId ?? null,
    companyId: app.aioTenant?.companyId ?? null,
    workplaceId: app.aioTenant?.workplaceId ?? null,
    alias,
    businessName: app.aioTenant?.businessName ?? "",
    environment: aioEnvironment(),
    createdAt: app.aioTenant?.createdAt ?? now.toISOString(),
    provisionedAt: null,
    claimedAt: now.toISOString(),
    attempts: (app.aioTenant?.attempts ?? 0) + 1,
    lastAttemptAt: now.toISOString(),
    locationNotBefore: app.aioTenant?.locationNotBefore ?? null,
    lastError: null,
    lastErrorAt: null,
  };

  const fail = async (error: string, status: "failed" | "needs_attention") => {
    tenant = { ...tenant, claimedAt: null, lastError: error, lastErrorAt: new Date().toISOString() };
    await patch(app.id, tenant);
    return { status, error } as ProvisionOutcome;
  };

  /**
   * Stop for now, and charge the merchant nothing for it.
   *
   * Waiting on AIO's tenant schema is not a failure, and the difference is
   * load-bearing in three places at once. `attempts` and `lastAttemptAt` are
   * restored to what they were BEFORE this run's claim, so a deferral: does
   * not consume one of the five attempts (`too_many_attempts` can't be
   * reached by waiting); does not start an exponential backoff (the gate's
   * `backing_off` check reads `lastAttemptAt`, and on a first provision that
   * is still null, so the very next tick is free to continue); and leaves
   * `lastError` alone, so the admin sync tripwire doesn't light up for an
   * account that is simply mid-flight.
   *
   * That last point is why this exists at all rather than reusing `fail`.
   * On 2026-10-14 a first attempt cost one attempt and a one-hour backoff,
   * and the merchant's tenant sat unfinished for the rest of it.
   */
  const defer = async (until: Date) => {
    tenant = {
      ...tenant,
      claimedAt: null,
      locationNotBefore: until.toISOString(),
      attempts: app.aioTenant?.attempts ?? 0,
      lastAttemptAt: app.aioTenant?.lastAttemptAt ?? null,
    };
    await patch(app.id, tenant);
    return { status: "waiting", until: until.toISOString() } as ProvisionOutcome;
  };

  try {
    // ── Step 1: the tenant ────────────────────────────────────────────────
    if (!tenant.businessId) {
      // Reconcile first. If the alias is taken we must NOT create — but note
      // that AIO's alias lookup does not return the business id (verified
      // 2026-09-23), so an alias that exists without a persisted id is a dead
      // end we surface for a human rather than guessing.
      const existing = await findAioBusinessByAlias(alias);
      if (existing) {
        if (!existing.businessId) {
          return await fail(
            `AIO already has a tenant with alias "${alias}" ("${existing.businessName ?? "?"}") but its ` +
              `business id cannot be read back from the alias lookup. Recover the id from the AIO ` +
              `dashboard and set aioTenant.businessId by hand — creating again would burn a second alias.`,
            "needs_attention"
          );
        }
        tenant = {
          ...tenant,
          businessId: existing.businessId,
          businessName: existing.businessName ?? tenant.businessName,
          locationId: existing.restaurants[0]?.id ?? tenant.locationId,
        };
      } else {
        const created = await createAioBusiness(app, { alias });
        tenant = {
          ...tenant,
          businessId: created.businessId,
          companyId: created.companyId,
          businessName: created.businessName,
        };
        // The tenant's schema is built asynchronously from here, so the
        // location step CANNOT run in this same pass — see SCHEMA_WARMUP_MS.
        // Setting the clock only on the create branch is deliberate: a
        // reconciled business is one AIO made minutes or days ago, and making
        // it wait five more would be waiting for something that has already
        // happened.
        tenant = {
          ...tenant,
          locationNotBefore: new Date(Date.now() + SCHEMA_WARMUP_MS).toISOString(),
        };
      }
      await patch(app.id, tenant);
    }

    // ── Step 2: the location ──────────────────────────────────────────────
    //
    // ONE location per tenant is the whole requirement here (product owner,
    // 2026-10-14), and the only way to honour it is to not call this before
    // AIO can serve it: a premature call still creates a row, it just creates
    // a broken one. So the step is time-gated, and the wait is taken across
    // cron ticks rather than inside this function — sleeping here would hold
    // the lease, burn function time, and risk the 15-minute claim going stale
    // underneath us.
    if (!tenant.locationId) {
      const notBefore = tenant.locationNotBefore ? Date.parse(tenant.locationNotBefore) : 0;
      if (Number.isFinite(notBefore) && Date.now() < notBefore) {
        return await defer(new Date(notBefore));
      }

      try {
        const loc = await createAioLocation(app, {
          businessId: tenant.businessId,
          companyId: tenant.companyId,
        });
        tenant = { ...tenant, locationId: loc.locationId, workplaceId: loc.workplaceId };
        await patch(app.id, tenant);
      } catch (err) {
        // "Too early", not "broken". A junk restaurant now exists and nothing
        // can remove it, so the answer is to wait LONGER, not to try harder —
        // and not to spend one of the merchant's five attempts on AIO being
        // slow.
        if (isTenantSchemaNotReady(err)) {
          console.warn(
            `[aio] tenant ${tenant.businessId} schema not ready; a half-created restaurant now ` +
              `exists under it and cannot be deleted. Waiting ${SCHEMA_RETRY_MS / 60000}m.`,
            app.id
          );
          return await defer(new Date(Date.now() + SCHEMA_RETRY_MS));
        }
        throw err;
      }
    }

    // ── Step 3: the Adyen KYC link ────────────────────────────────────────
    const locationId = tenant.locationId;
    if (locationId === null) {
      return await fail("AIO location id missing after location create", "failed");
    }
    const link = await createAioAdyenOnboardingLink({ businessId: tenant.businessId, locationId });

    tenant = { ...tenant, provisionedAt: new Date().toISOString(), claimedAt: null };

    // The AIO business id IS the AIO tenant number, and the tenant number is
    // what the settlement ingest builds `prod-{n}` from
    // (src/lib/adyen/paymentsAccountingParser.ts). Writing it here is what
    // replaced the admin's manual "Save tenant number" step.
    await db
      .update(merchantApplications)
      .set({
        aioTenant: tenant,
        adyenOnboardingUrl: link.url,
        adyenIds: {
          ...(app.adyenIds ?? {}),
          legalEntityId: link.legalEntityId,
          tenantNumber: String(tenant.businessId),
          environment: adyenEnvironmentFromOnboardingUrl(link.url),
        } as MerchantApplication["adyenIds"],
        ...(shouldAdvance(app.stage, "adyen_kyc_pending") ? { stage: "adyen_kyc_pending" } : {}),
        updatedAt: new Date(),
      })
      .where(eq(merchantApplications.id, app.id));

    return { status: "provisioned", businessId: tenant.businessId, locationId };
  } catch (err) {
    return await fail(err instanceof Error ? err.message : String(err), "failed");
  }
}
