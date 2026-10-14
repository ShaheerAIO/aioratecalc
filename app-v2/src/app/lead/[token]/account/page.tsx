import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { users } from "@/lib/db/schema";
import { getLeadApplicationByToken } from "@/lib/leadToken";
import { canClaimLeadAccount } from "@/lib/leadAccount";
import CreateAccountForm from "./CreateAccountForm";
import styles from "../lead.module.css";

// Public, token-gated like the rest of /lead/[token]. See
// lib/actions/leadAccount.ts for why the lead token may create an account.
export default async function LeadAccountPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lookup = await getLeadApplicationByToken(token);

  if (!lookup.ok) {
    return (
      <div className={styles.centered}>
        <div className={styles.centeredInner}>
          <h1 className={styles.title}>{lookup.reason === "expired" ? "Link Expired" : "Invalid Link"}</h1>
          <p className={styles.subtitle}>Ask your AIO representative for a new link.</p>
        </div>
      </div>
    );
  }

  const row = lookup.row;
  const [linked] = row.customerUserId
    ? await db.select({ email: users.email, passwordHash: users.passwordHash })
        .from(users).where(eq(users.id, row.customerUserId)).limit(1)
    : [];

  const accepted = Boolean(row.quoteAcceptedAt);
  if (accepted && !canClaimLeadAccount(accepted, linked ?? null)) redirect("/customer/login");

  if (!accepted) {
    return (
      <div className={styles.centered}>
        <div className={styles.centeredInner}>
          <h1 className={styles.title}>Not Quite Yet</h1>
          <p className={styles.subtitle}>
            You can create your account once you&apos;ve signed and paid for your quote.{" "}
            <Link href={`/lead/${token}`}>Back to your checklist</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <CreateAccountForm
      token={token}
      defaultEmail={linked?.email ?? row.ownerContact?.email ?? ""}
      emailLocked={Boolean(linked)}
    />
  );
}
