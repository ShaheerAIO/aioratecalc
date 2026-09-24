import { redirect } from "next/navigation";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { AppNav } from "@/components/nav/AppNav";
import styles from "@/components/nav/shell.module.css";

export default async function RepLayout({ children }: { children: React.ReactNode }) {
  const effective = await getEffectiveRole();

  // Middleware already turned away anyone without a rep/admin token, and it
  // can't do more than that — it runs on the edge with no database. So a null
  // here means specifically that the row behind the session is gone, disabled
  // or no longer staff. Without this the page renders with userId="" and an
  // empty dashboard, and the first write fails on the owner_user_id FK.
  if (!effective) redirect("/login?error=session_stale");

  return (
    <div className={styles.shell}>
      <AppNav role={effective.role} userName={effective.name} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
