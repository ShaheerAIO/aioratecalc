import { redirect } from "next/navigation";
import { getEffectiveRole } from "@/lib/auth/getEffectiveRole";
import { AppNav } from "@/components/nav/AppNav";
import styles from "@/components/nav/shell.module.css";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const effective = await getEffectiveRole();

  // See the note in ../rep/layout.tsx. The extra role check is the demotion
  // case: middleware trusts the token's role, so an admin demoted at
  // /admin/users still reaches this URL until their JWT expires.
  if (!effective) redirect("/login?error=session_stale");
  if (effective.role !== "admin") redirect("/rep");

  return (
    <div className={styles.shell}>
      <AppNav role={effective.role} userName={effective.name} />
      <main className={styles.main}>{children}</main>
    </div>
  );
}
