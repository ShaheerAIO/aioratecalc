// Provision ONE named application into the AIO platform, right now, without a
// dev server and without waiting for the 15-minute cron.
//
//   npx tsx scripts/provision-aio-tenant.ts <applicationId>
//   npx tsx scripts/provision-aio-tenant.ts <applicationId> --unpaid
//
// WHY THIS EXISTS. The cron (/api/cron/aio-provisioning) only acts on rows that
// have actually been PAID — `hasBillingCompleted`, i.e. a HubSpot subscription
// exists. That is correct and must stay correct. But it means the provisioning
// chain cannot be exercised end-to-end without a real ACH payment, which
// PAYMENT-TEST-PLAN.md §2.1 recommends against. The debug billing bypass does
// not help either: it deliberately refuses to fabricate a subscription, for
// exactly this reason (see lib/actions/debugBilling.ts).
//
// So this script is the operator's seam. It calls the SHIPPING
// `provisionAioTenant`, so the lease, the resume-from-persisted-ids and the
// reconcile-by-alias guards all still apply — the only thing it can skip is the
// `billing_not_paid` gate, and only when asked with --unpaid.
//
// ⚠️  EVERYTHING THIS CREATES IS PERMANENT. A business alias is globally unique,
// AIO's delete is soft and never frees it, and the database is shared with other
// AIO teams. There is no undo. The script prints exactly what it is about to
// create and waits for you to type the application id back before it writes.

import { loadEnvConfig } from "@next/env";
import { createRequire, Module } from "node:module";
import { createInterface } from "node:readline/promises";

loadEnvConfig(process.cwd());

// `lib/aio/provision.ts` imports `lib/db/client.ts`, which opens with
// `import "server-only"` — a package whose whole job is to THROW when it is
// loaded outside a React Server Component, so a server module can't be pulled
// into the browser bundle. Under tsx there is no bundler and no `react-server`
// export condition, so it resolves to the throwing entry point and this script
// died on its first import ("This module cannot be imported from a Client
// Component module") before printing anything.
//
// Seeding require.cache with an empty module neutralises the guard FOR THIS
// PROCESS ONLY. It is not a loosening of the rule: the point of `server-only`
// is to fail a client BUNDLE, and a CLI run by a human on their own machine is
// the one caller that legitimately wants the server module. The alternative —
// having provision.ts take a db handle as an argument — would change shipping
// code to suit a script, and the whole value of this script is that it calls
// the shipping path unaltered.
//
// `scripts/db.ts` exists for the same reason and does NOT solve this: it gives
// the SCRIPT a non-guarded client, but provision.ts imports the guarded one
// itself.
const req = createRequire(`${process.cwd()}/`);
const serverOnlyId = req.resolve("server-only");
const serverOnlyStub = new Module(serverOnlyId);
serverOnlyStub.filename = serverOnlyId;
serverOnlyStub.loaded = true;
serverOnlyStub.exports = {};
req.cache[serverOnlyId] = serverOnlyStub;

// The gate reasons this script may override. Everything else is a real refusal:
// a missing name or address would create a tenant nobody can fix, an already
// provisioned row would burn a second alias, and a live claim means something
// else is mid-chain.
const OVERRIDABLE = new Set(["billing_not_paid", "quote_not_accepted", "backing_off"]);

async function main() {
  const [applicationId, ...flags] = process.argv.slice(2);
  const unpaid = flags.includes("--unpaid");

  if (!applicationId) {
    console.error("usage: npx tsx scripts/provision-aio-tenant.ts <applicationId> [--unpaid]");
    process.exit(1);
  }

  // Imported AFTER loadEnvConfig — the adapter reads credentials from process.env.
  const { db } = await import("./db");
  const { merchantApplications } = await import("../src/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const { rowToApp } = await import("../src/lib/storage/applicationRow");
  const { isReadyForAioProvisioning } = await import("../src/lib/aio/provisioningGate");
  const { provisionAioTenant } = await import("../src/lib/aio/provision");
  const { aioBusinessAlias, aioDashboardEnabled, aioEnvironment } = await import(
    "../src/lib/adapters/aioDashboard"
  );
  const { locationAddress } = await import("../src/types/merchant");

  if (!aioDashboardEnabled()) {
    console.error(
      "AIO dashboard is not configured. All four are required in .env.local:\n" +
        "  AIO_DASHBOARD_ENABLED=true\n" +
        "  AIO_DASHBOARD_BASE_URL=https://backend.prod.aioapp.com\n" +
        "  AIO_DASHBOARD_USERNAME=...\n" +
        "  AIO_DASHBOARD_PASSWORD=...   (\\$-escape any $ — see CLAUDE.md)"
    );
    process.exit(1);
  }

  const [row] = await db
    .select()
    .from(merchantApplications)
    .where(eq(merchantApplications.id, applicationId));
  if (!row) {
    console.error(`No application ${applicationId}`);
    process.exit(1);
  }

  const app = rowToApp(row);
  const gate = isReadyForAioProvisioning(app);

  if (!gate.ready) {
    if (!OVERRIDABLE.has(gate.reason)) {
      console.error(`Refused: ${gate.reason}. This one is not overridable.`);
      process.exit(1);
    }
    if (!unpaid) {
      console.error(
        `Refused: ${gate.reason}.\n` +
          `Pass --unpaid to provision anyway (this merchant has NOT paid; the tenant is still permanent).`
      );
      process.exit(1);
    }
  }

  const biz = app.business;
  const loc = biz ? locationAddress(biz) : null;
  const alias = app.aioTenant?.alias ?? aioBusinessAlias(app);

  console.log("\n  ABOUT TO CREATE A PERMANENT AIO TENANT");
  console.log("  ─────────────────────────────────────────────────────────");
  console.log(`  environment   ${aioEnvironment()}  (${process.env.AIO_DASHBOARD_BASE_URL})`);
  console.log(`  application   ${app.id}`);
  console.log(`  business name ${biz?.dba || biz?.legalName || "(none)"}`);
  console.log(`  alias         ${alias}      ← globally unique, NEVER freed`);
  console.log(`  address       ${loc ? `${loc.address}, ${loc.city}, ${loc.state} ${loc.zip}` : "(none)"}`);
  console.log(`  owner         ${app.ownerContact?.firstName ?? ""} ${app.ownerContact?.lastName ?? ""} <${app.ownerContact?.email ?? "?"}>`);
  console.log(`  gate          ${gate.ready ? "ready" : `OVERRIDDEN (${gate.reason})`}`);
  console.log(`  existing ids  ${app.aioTenant ? JSON.stringify({ businessId: app.aioTenant.businessId, locationId: app.aioTenant.locationId }) : "none — a full create"}`);
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  This cannot be undone. AIO's delete is soft and does not free the alias.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(`  Type the application id to confirm: `);
  rl.close();
  if (typed.trim() !== applicationId) {
    console.log("\n  Aborted — nothing was created.");
    process.exit(1);
  }

  console.log("\n  provisioning…");
  const outcome = await provisionAioTenant(app);
  console.log("  outcome:", JSON.stringify(outcome, null, 2));

  const [after] = await db
    .select()
    .from(merchantApplications)
    .where(eq(merchantApplications.id, applicationId));
  const t = rowToApp(after).aioTenant;
  console.log("\n  aioTenant:", JSON.stringify(t, null, 2));
  console.log("  adyenIds :", JSON.stringify(rowToApp(after).adyenIds, null, 2));
  console.log("  KYC link :", rowToApp(after).adyenOnboardingUrl ?? "(none)");
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  }
);
