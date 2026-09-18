import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  const { hash } = await import("bcryptjs");
  const { db } = await import("./db");
  const { users } = await import("../src/lib/db/schema");
  const { eq } = await import("drizzle-orm");

  // Staff sign in with Entra ID, so these rows are NOT how a real rep or admin
  // gets in — a real person needs a row whose email is their Microsoft work
  // account (add them at /admin/users), and their first sign-in links it.
  //
  // These three stay because local dev needs them: the debug role switcher
  // resolves <role>@aioapp.com (lib/auth/getEffectiveRole.ts), and the admin
  // row doubles as the breakglass account that bootstraps a fresh environment
  // — sign in at /login/breakglass, then add the real staff roster.
  //
  // rep@aioapp.com gets NO password: reps have no password path at all now, so
  // one would be inert. The admin's is the breakglass credential and must be
  // overridden (SEED_ADMIN_PASSWORD) anywhere that isn't a local machine.
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || "admin123";
  if (!process.env.SEED_ADMIN_PASSWORD) {
    console.warn("⚠  Using the default breakglass password for admin@aioapp.com.");
    console.warn("   Set SEED_ADMIN_PASSWORD outside local development.");
  }

  const seeds = [
    { email: "admin@aioapp.com", name: "AIO Admin", role: "admin" as const, password: adminPassword },
    { email: "rep@aioapp.com", name: "AIO Rep", role: "rep" as const, password: null },
    { email: "customer@aioapp.com", name: "AIO Customer", role: "customer" as const, password: "customer123" },
  ];

  for (const seed of seeds) {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, seed.email)).limit(1);
    const passwordHash = seed.password ? await hash(seed.password, 10) : null;
    if (existing) {
      await db.update(users).set({ passwordHash, name: seed.name, role: seed.role }).where(eq(users.id, existing.id));
      console.log(`updated ${seed.email}`);
    } else {
      await db.insert(users).values({ email: seed.email, name: seed.name, role: seed.role, passwordHash });
      console.log(`created ${seed.email}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
