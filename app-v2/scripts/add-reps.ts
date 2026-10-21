import { config } from "dotenv";
config({ path: ".env.local" });

// Adds the AIO sales roster as rep rows. Same thing an admin does by hand at
// /admin/users — a row whose email is the person's Microsoft work account, no
// password, linked to their Entra identity on their own first sign-in.
//
// Idempotent: an existing row is left alone except for a missing name, and a
// row that is already an admin is never demoted (reported instead).
const ROSTER = [
  "Bilal Abbas",
  "Brian Bennett",
  "Jason Wanigatunga",
  "Jean Lavarello",
  "Omar Razawi",
  "Sean Giffen",
  "Shomik Majumdar",
  "Joe Mendonca",
  "Justin deSevrenJaquet",
  "Loni Chowdhury",
  "Stephanie Bach",
  "Syed Faizan",
  "Tom Levee",
  "Andy Johnson",
  "Bill Adams",
  "Amir White",
  "Fazian Husnain",
  "Max Smith",
  "Luke Shaw",
];

const emailFor = (name: string) => `${name.split(" ")[0].toLowerCase()}@aioapp.com`;

async function main() {
  const { db } = await import("./db");
  const { users } = await import("../src/lib/db/schema");
  const { eq } = await import("drizzle-orm");

  const seen = new Map<string, string>();
  for (const name of ROSTER) {
    const email = emailFor(name);
    const clash = seen.get(email);
    if (clash) throw new Error(`${name} and ${clash} both map to ${email} — pick distinct addresses by hand.`);
    seen.set(email, name);
  }

  for (const name of ROSTER) {
    const email = emailFor(name);
    const [existing] = await db
      .select({ id: users.id, role: users.role, name: users.name, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!existing) {
      await db.insert(users).values({ email, name, role: "rep", passwordHash: null });
      console.log(`created  ${email}  (${name})`);
      continue;
    }
    if (existing.role !== "rep") {
      console.log(`SKIPPED  ${email}  — already a ${existing.role} (${existing.name}); not changing their role`);
      continue;
    }
    if (existing.disabledAt) {
      console.log(`exists   ${email}  — rep, but DISABLED; re-enable at /admin/users if intended`);
      continue;
    }
    console.log(`exists   ${email}  (${existing.name})`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
