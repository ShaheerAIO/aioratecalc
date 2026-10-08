import Link from "next/link";
import type { MerchantApplication } from "@/types/merchant";
import { fmt$0 } from "@/lib/utils";
import styles from "./MyDataSection.module.css";

type Row = { label: string; value: string };
type Group = { title: string; rows: Row[] };

type Props = { app: MerchantApplication | null };

// Picks the most recently updated application that has any saved profile
// data — the customer only ever has one real business in practice, but
// nothing enforces that, so we surface the freshest record rather than
// merging fields across applications.
export function pickProfileApp(apps: MerchantApplication[]): MerchantApplication | null {
  const withData = apps.filter(a => a.business || a.ownerContact || a.processing);
  if (withData.length === 0) return null;
  return [...withData].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function titleCase(s: string) {
  return s.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// Exported so other views (e.g. the per-application "My Data" tab) can
// render the same fields without duplicating the field list.
export function buildGroups(app: MerchantApplication): Group[] {
  const b = app.business;
  const o = app.ownerContact;
  const p = app.processing;

  return [
    {
      title: "Business",
      rows: [
        b?.legalName && { label: "Legal Name", value: b.legalName },
        b?.dba && { label: "DBA", value: b.dba },
        b?.bizType && { label: "Business Type", value: titleCase(b.bizType) },
        b?.address && { label: "Legal Address", value: [b.address, b.city, b.state, b.zip].filter(Boolean).join(", ") },
        b?.dbaAddress && { label: "DBA Address", value: [b.dbaAddress, b.dbaCity, b.dbaState, b.dbaZip].filter(Boolean).join(", ") },
        b?.phone && { label: "Phone", value: b.phone },
        b?.website && { label: "Website", value: b.website },
        b?.yearsInBusiness && { label: "Years in Business", value: b.yearsInBusiness },
      ].filter(Boolean) as Row[],
    },
    {
      title: "Owner Contact",
      rows: [
        o?.firstName && { label: "Name", value: `${o.firstName} ${o.lastName || ""}`.trim() },
        o?.title && { label: "Title", value: o.title },
        o?.email && { label: "Email", value: o.email },
        o?.phone && { label: "Phone", value: o.phone },
      ].filter(Boolean) as Row[],
    },
    {
      title: "Processing",
      rows: [
        p?.mcc && { label: "MCC Code", value: p.mcc },
        p?.currentProcessor && { label: "Current Processor", value: p.currentProcessor },
        p?.monthlyVolume && { label: "Monthly Volume", value: fmt$0(Number(p.monthlyVolume)) },
        p?.avgTicket && { label: "Average Ticket", value: fmt$0(Number(p.avgTicket)) },
      ].filter(Boolean) as Row[],
    },
  ];
}

// Presentational-only groups/grid, shared by the dashboard summary below and
// the per-application "My Data" tab (src/components/customer/ApplicationTabs.tsx).
export function DataGroups({ app }: { app: MerchantApplication }) {
  const groups = buildGroups(app).filter(g => g.rows.length > 0);

  if (groups.length === 0) {
    return (
      <div className={styles.emptyState}>
        Your business details will appear here once you complete onboarding for an application.
      </div>
    );
  }

  return (
    <>
      {groups.map(g => (
        <div key={g.title} className={styles.group}>
          <div className={styles.groupTitle}>{g.title}</div>
          <div className={styles.grid}>
            {g.rows.map(r => (
              <div key={r.label} className={styles.row}>
                <span className={styles.label}>{r.label}</span>
                <span className={styles.value}>{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// Read-only summary of everything the customer has already told us —
// reused so future modules (payroll, Foodbuy, etc.) can autofill instead of
// re-asking. Editing happens on the existing per-application edit page,
// which is the single place these fields are actually saved.
export default function MyDataSection({ app }: Props) {
  return (
    <div className={styles.section}>
      <h2 className={styles.heading}>My Data</h2>
      <p className={styles.subtitle}>
        Saved from your application — reused to autofill other AIO services like payroll and Foodbuy.
      </p>
      <div className={styles.panel}>
        {app ? <DataGroups app={app} /> : (
          <div className={styles.emptyState}>
            Your business details will appear here once you complete onboarding for an application.
          </div>
        )}
        {app && (
          <Link href={`/customer/applications/${app.id}/edit`} className={styles.editLink}>
            Edit My Data →
          </Link>
        )}
      </div>
    </div>
  );
}
