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

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const count = (n: number) => n.toLocaleString("en-US");

const MARKETING_BUCKETS = new Set<BucketId>(["live_marketing", "marketing_sales_type_discovery", "marketing_no_discovery"]);

export default async function LiveAccountsPage() {
  const data = await loadLiveAccounts();
  const { buckets, fixes } = data.result;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <Link href="/admin" className={styles.back}>← Back to Admin</Link>

        <div className={styles.header}>
          <h1 className={styles.headerTitle}>Live Accounts</h1>
          <p className={styles.headerSubtitle}>
            Ordering is live with an active platform subscription in HubSpot and Adyen card transactions on its
            AIO tenant in the last 30 days. Marketing is live with an active AIO Marketing Platform subscription
            and a completed &ldquo;Marketing Discovery&rdquo; meeting. Read-only: nothing here writes anywhere.
          </p>
          <p className={styles.meta}>
            Data as of {new Date(data.asOf).toLocaleString("en-US", { timeZone: "America/Chicago" })} CT ·
            transactions {data.since} → {data.until}
            {data.adyenDataThrough && <> · Adyen reports through {data.adyenDataThrough}</>}
          </p>
        </div>

        {data.warnings.map(w => (
          <div key={w} className={styles.notice}>{w}</div>
        ))}

        <nav className={styles.summary} aria-label="Sections">
          {BUCKETS.map(b => (
            <a key={b.id} href={`#${b.id}`} className={styles.chip}>
              {b.title} <strong>{buckets[b.id].length}</strong>
            </a>
          ))}
          <a href="#fixes" className={styles.chip}>Suggested HubSpot fixes <strong>{fixes.length}</strong></a>
        </nav>

        {BUCKETS.map(b => {
          const rows = buckets[b.id];
          const volume = rows.reduce((n, r) => n + r.volume, 0);
          return (
            <section key={b.id} id={b.id} className={styles.section}>
              <h2 className={styles.sectionTitle}>
                {b.title} <span className={styles.sectionCount}>{rows.length} · {money(volume)} 30-day volume</span>
              </h2>
              <p className={styles.sectionDesc}>{b.description}</p>
              {rows.length === 0 ? (
                <div className={styles.empty}>None.</div>
              ) : (
                <div className={styles.panel}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th>Company</th>
                        <th>Tenant</th>
                        <th>AIO business</th>
                        <th className={styles.num}>30d tx</th>
                        <th className={styles.num}>30d volume</th>
                        <th>Last tx</th>
                        <th>Matched by</th>
                        <th>Subscriptions</th>
                        {MARKETING_BUCKETS.has(b.id) && <th>Discovery</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => <Row key={r.key} row={r} showDiscovery={MARKETING_BUCKETS.has(b.id)} />)}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })}

        <section id="fixes" className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Suggested HubSpot fixes <span className={styles.sectionCount}>{fixes.length}</span>
          </h2>
          <p className={styles.sectionDesc}>
            Companies whose Tenant Id doesn&apos;t match the tenant they were matched to. Name matches are guesses —
            check the restaurant address before changing anything.
          </p>
          {fixes.length === 0 ? (
            <div className={styles.empty}>None.</div>
          ) : (
            <div className={styles.panel}>
              <ul className={styles.fixes}>
                {fixes.map(f => (
                  <li key={`${f.companyId}:${f.tenantId}`}>
                    <CompanyLink id={f.companyId} name={f.companyName} />: {f.text}{" "}
                    <span className={styles.sub}>({f.source === "name" ? "name match" : f.source})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
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

function Row({ row, showDiscovery }: { row: AccountRow; showDiscovery: boolean }) {
  return (
    <tr>
      <td>
        {row.companyId && row.companyName
          ? <CompanyLink id={row.companyId} name={row.companyName} />
          : <span className={styles.sub}>No company</span>}
        {row.candidates.length > 0 && (
          <div className={styles.sub}>
            {row.match === "ambiguous" ? "Candidates: " : "Also: "}
            {row.candidates.map((c, i) => (
              <span key={c.id}>{i > 0 && ", "}<CompanyLink id={c.id} name={c.name} /></span>
            ))}
          </div>
        )}
        {row.notes.map(n => <div key={n} className={styles.warn}>{n}</div>)}
      </td>
      <td>{row.tenantIds.join(", ") || "—"}</td>
      <td>{row.aioBusinessName ?? "—"}</td>
      <td className={styles.num}>{row.txCount ? count(row.txCount) : "—"}</td>
      <td className={styles.num}>{row.volume ? money(row.volume) : "—"}</td>
      <td className={styles.nowrap}>{row.lastTxDate ?? "—"}</td>
      <td className={row.match === "name match — suggested" || row.match === "ambiguous" ? styles.warn : undefined}>{row.match}</td>
      <td className={styles.sub}>{row.subscriptions}</td>
      {showDiscovery && <td className={styles.sub}>{row.discovery ?? "—"}</td>}
    </tr>
  );
}
