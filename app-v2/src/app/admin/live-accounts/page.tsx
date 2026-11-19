import Link from "next/link";
import { hubspotCompanyUrl } from "@/lib/billingView";
import { BUCKETS, type AccountRow, type BucketId } from "@/lib/liveAccounts";
import { loadLiveAccounts } from "@/lib/liveAccountsData";
import styles from "./live-accounts.module.css";

// Hidden admin page (2026-11-19): reachable by URL only — deliberately in no
// nav or menu. admin/layout.tsx keeps non-admins out; the loader re-checks.
// Rendered on every request; nothing here may be cached. See
// docs/claude/live-accounts.md.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const HUBSPOT_PORTAL_ID = process.env.NEXT_PUBLIC_HUBSPOT_PORTAL_ID || "244508708";

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

// Everything worth a follow-up. "Live – not billed" counts as live (ordering
// is decided by transactions alone) but is still a billing follow-up, so it's
// listed too. "Other subscription only" (payroll, hardware, investor) is
// neither ordering nor marketing, so it isn't.
const ATTENTION: BucketId[] = ["transacting_not_paying", "paying_no_transactions", "paying_no_tenant", "marketing_no_discovery"];
const TITLE = Object.fromEntries(BUCKETS.map(b => [b.id, b.title])) as Record<BucketId, string>;

export default async function LiveAccountsPage() {
  const data = await loadLiveAccounts();
  const { buckets, fixes } = data.result;
  // Ordering is live on transactions alone: billed and not-billed both count.
  const notBilled = buckets.transacting_not_paying;
  const ordering = [...buckets.live_ordering, ...notBilled].sort((a, b) => b.volume - a.volume);
  const marketing = buckets.live_marketing;
  const attention = ATTENTION
    .flatMap(id => buckets[id].map(row => ({ row, reason: id })))
    .sort((a, b) => b.row.volume - a.row.volume || (a.row.companyName ?? "").localeCompare(b.row.companyName ?? ""));

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Live Accounts</h1>
          <p className={styles.meta}>
            Data as of {new Date(data.asOf).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT ·
            transactions {data.since} → {data.until}
            {data.adyenDataThrough && <> · Adyen reports through {data.adyenDataThrough}</>}
          </p>
        </div>

        {data.warnings.map(w => (
          <div key={w} className={styles.notice}>{w}</div>
        ))}

        <div className={styles.stats}>
          <div className={styles.stat}>
            <div className={styles.statNum}>{ordering.length}</div>
            <div className={styles.statLabel}>Live – ordering</div>
            <div className={styles.statSub}>
              {money(ordering.reduce((n, r) => n + r.volume, 0))} card volume, last 30 days ·{" "}
              {notBilled.length} not billed in HubSpot
            </div>
            <div className={styles.statSub}>Card transactions on Adyen in the last 30 days, billed or not.</div>
          </div>
          <div className={styles.stat}>
            <div className={styles.statNum}>{marketing.length}</div>
            <div className={styles.statLabel}>Live – marketing</div>
            <div className={styles.statSub}>Active AIO Marketing subscription and a completed marketing session (discovery, onboarding, brandbook, marketing meeting or catchup).</div>
          </div>
        </div>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Needs attention <span className={styles.sectionCount}>{attention.length}</span>
          </h2>
          <p className={styles.sectionDesc}>
            Follow-ups, largest card volume first. &ldquo;Live – not billed&rdquo; rows count as live; the rest don&apos;t.
          </p>
          {attention.length === 0 ? (
            <div className={styles.empty}>None.</div>
          ) : (
            <div className={styles.panel}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Reason</th>
                    <th>Tenant</th>
                    <th className={styles.num}>30d volume</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.map(({ row, reason }) => (
                    <tr key={row.key}>
                      <td><Company row={row} /></td>
                      <td className={styles.nowrap}>{TITLE[reason]}</td>
                      <td>{row.tenantIds.join(", ") || "—"}</td>
                      <td className={styles.num}>{row.volume ? money(row.volume) : "—"}</td>
                      <td className={styles.sub}>
                        {reason === "marketing_no_discovery" ? row.discovery : row.subscriptions}
                        {row.notes.map(n => <div key={n} className={styles.warn}>{n}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <details className={styles.details}>
          <summary>Live ordering accounts ({ordering.length})</summary>
          <div className={styles.panel}>
            <table className={styles.table}>
              <thead><tr><th>Company</th><th>Tenant</th><th className={styles.num}>30d volume</th><th>Last tx</th></tr></thead>
              <tbody>
                {ordering.map(r => (
                  <tr key={r.key}>
                    <td>
                      <Company row={r} />
                      {r.key.startsWith("transacting_not_paying:") && <div className={styles.warn}>Not billed</div>}
                    </td>
                    <td>{r.tenantIds.join(", ")}</td>
                    <td className={styles.num}>{money(r.volume)}</td>
                    <td className={styles.nowrap}>{r.lastTxDate ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <details className={styles.details}>
          <summary>Live marketing accounts ({marketing.length})</summary>
          <div className={styles.panel}>
            <table className={styles.table}>
              <thead><tr><th>Company</th><th>Marketing session</th></tr></thead>
              <tbody>
                {marketing.map(r => (
                  <tr key={r.key}>
                    <td><Company row={r} /></td>
                    <td className={styles.sub}>{r.discovery}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {fixes.length > 0 && (
          <details className={styles.details}>
            <summary>Suggested HubSpot Tenant Id fixes ({fixes.length})</summary>
            <div className={styles.panel}>
              <p className={styles.sectionDesc}>Name matches are guesses: check the restaurant address before changing anything.</p>
              <ul className={styles.fixes}>
                {fixes.map(f => (
                  <li key={`${f.companyId}:${f.tenantId}`}>
                    <CompanyLink id={f.companyId} name={f.companyName} />: {f.text}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function CompanyLink({ id, name }: { id: string; name: string }) {
  const url = hubspotCompanyUrl(id, HUBSPOT_PORTAL_ID);
  return url
    ? <a href={url} target="_blank" rel="noreferrer" className={styles.link}>{name}</a>
    : <span className={styles.name}>{name}</span>;
}

function Company({ row }: { row: AccountRow }) {
  if (row.companyId && row.companyName) return <CompanyLink id={row.companyId} name={row.companyName} />;
  return <span className={styles.sub}>{row.aioBusinessName ? `${row.aioBusinessName} (no HubSpot company)` : "No company"}</span>;
}
