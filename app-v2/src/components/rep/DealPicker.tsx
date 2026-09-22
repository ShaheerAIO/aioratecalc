"use client";

import { useEffect, useState } from "react";
import {
  listCompanyDealsAction, searchDealsAction, lookupDealAction,
} from "@/lib/actions/applications";
import { resolveDealChoiceAction } from "@/lib/actions/prospects";
import type { DealChoice, DealResolution } from "@/lib/hubspotDeal";
import type { HubspotDeal } from "@/lib/adapters/hubspot";
import styles from "./DealPicker.module.css";

export type ResolvedDeal = { choice: DealChoice; deal: HubspotDeal };

type Props = {
  companyId: string;
  companyName: string;
  /** Seeds the "create a new deal" name field — the merchant's own name. */
  defaultDealName: string;
  resolved: ResolvedDeal | null;
  onResolved: (resolved: ResolvedDeal | null) => void;
  /**
   * Hides the "create a new deal" affordance. Minting a deal for a company
   * that has none at all is `retryBillingQuoteAction`'s job (mode: "create"),
   * which already does its own ambiguity check before creating — a second
   * "create" entry point here (the account-detail host, where this component
   * exists specifically to ADOPT an existing deal) would just be a second way
   * to mint a duplicate. Defaults to true for the prospect-creation host,
   * where there is no company yet and creating is the common case.
   */
  allowCreate?: boolean;
};

function dealMeta(d: HubspotDeal): string {
  const parts = [d.stageLabel ?? "no stage"];
  if (d.createdAt) parts.push(new Date(d.createdAt).toLocaleDateString());
  if (d.closed) parts.push(d.won ? "closed won" : "closed");
  return parts.join(" · ");
}

/**
 * The company's HubSpot deals to pick from (or create a new one), resolved
 * through the same `resolveDealForCompany` createProspectAction calls at
 * submit — this is a preview so a refusal (including `ambiguous`'s
 * candidates) shows up before the rep has finished the rest of the form, not
 * after. See resolveDealChoiceAction's own doc comment.
 *
 * `listCompanyDealsAction` is index-backed and can lag a just-created deal by
 * seconds to minutes — the paste-a-link/id field and the name search are both
 * DIRECT reads that never lag, and are the honest answer to that, not a
 * silently-incomplete list.
 */
export default function DealPicker({ companyId, companyName, defaultDealName, resolved, onResolved, allowCreate = true }: Props) {
  const [deals, setDeals] = useState<HubspotDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [pasteInput, setPasteInput] = useState("");
  const [pasteLoading, setPasteLoading] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const [nameQuery, setNameQuery] = useState("");
  const [nameResults, setNameResults] = useState<HubspotDeal[]>([]);
  const [nameSearching, setNameSearching] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newDealName, setNewDealName] = useState(defaultDealName);

  const [resolving, setResolving] = useState(false);
  const [refusal, setRefusal] = useState<Extract<DealResolution, { ok: false }> | null>(null);

  useEffect(() => {
    setDeals([]);
    setListError(null);
    setNewDealName(defaultDealName);
    setLoading(true);
    let cancelled = false;
    listCompanyDealsAction(companyId)
      .then(r => { if (!cancelled) { setDeals(r.deals); setListError(r.error); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // defaultDealName only seeds the create-name field on a fresh company —
    // it must not re-run the fetch or clobber a rep-edited name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  useEffect(() => {
    const q = nameQuery.trim();
    if (q.length < 2) { setNameResults([]); setNameSearching(false); return; }
    setNameSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      searchDealsAction(q)
        .then(r => { if (!cancelled) setNameResults(r.deals); })
        .finally(() => { if (!cancelled) setNameSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [nameQuery]);

  async function commit(choice: DealChoice) {
    setResolving(true);
    setRefusal(null);
    try {
      const resolution = await resolveDealChoiceAction({ companyId, choice });
      if (resolution.ok) onResolved({ choice, deal: resolution.deal });
      else setRefusal(resolution);
    } catch (e) {
      setRefusal({ ok: false, code: "hubspot_error", message: e instanceof Error ? e.message : "Could not reach HubSpot" });
    } finally {
      setResolving(false);
    }
  }

  async function pasteAndLookup() {
    setPasteError(null);
    setPasteLoading(true);
    try {
      const { deal, error } = await lookupDealAction(pasteInput);
      if (error) { setPasteError(error); return; }
      if (!deal) { setPasteError("No HubSpot deal found for that link or id."); return; }
      await commit({ mode: "existing", dealId: deal.id });
    } finally {
      setPasteLoading(false);
    }
  }

  if (resolved) {
    return (
      <div className={styles.confirmed}>
        <div className={styles.confirmedInfo}>
          <span className={styles.confirmedName}>{resolved.deal.name}</span>
          <span className={styles.confirmedMeta}>{dealMeta(resolved.deal)}</span>
        </div>
        <button type="button" className={styles.changeBtn} onClick={() => onResolved(null)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <p className={styles.lagNote}>
        This list can lag a fresh HubSpot deal by a few minutes — just created it? Paste the link
        instead.
      </p>

      {loading && <p className={styles.meta}>Loading {companyName}&apos;s deals…</p>}
      {listError && (
        <div className={styles.error}>Couldn&apos;t load deals from HubSpot ({listError}).</div>
      )}
      {!loading && !listError && deals.length === 0 && (
        <p className={styles.meta}>
          {allowCreate
            ? "No deals found on this company yet — paste a link or create one below."
            : "No deals found on this company yet — paste a link to the one you mean."}
        </p>
      )}
      {!loading && deals.length > 0 && (
        <div className={styles.list}>
          {deals.map(d => (
            <button
              key={d.id}
              type="button"
              className={styles.row}
              data-closed={d.closed}
              disabled={d.closed || resolving}
              onClick={() => commit({ mode: "existing", dealId: d.id })}
            >
              <span className={styles.rowName}>{d.name}</span>
              <span className={styles.rowMeta}>{dealMeta(d)}</span>
            </button>
          ))}
        </div>
      )}

      <div className={styles.field}>
        <label className={styles.label}>Paste a HubSpot deal link or id</label>
        <div className={styles.inlineRow}>
          <input
            value={pasteInput}
            onChange={e => setPasteInput(e.target.value)}
            placeholder="https://app.hubspot.com/…/record/0-3/12345 or 12345"
            className={styles.input}
          />
          <button
            type="button"
            className={styles.smallBtn}
            disabled={!pasteInput.trim() || pasteLoading || resolving}
            onClick={pasteAndLookup}
          >
            {pasteLoading ? "Looking up…" : "Use this deal"}
          </button>
        </div>
        {pasteError && <div className={styles.error}>{pasteError}</div>}
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Or search by deal name</label>
        <input
          value={nameQuery}
          onChange={e => setNameQuery(e.target.value)}
          placeholder="Search HubSpot deals…"
          className={styles.input}
        />
        {nameQuery.trim().length >= 2 && (
          <div className={styles.list}>
            {nameSearching && <p className={styles.meta}>Searching…</p>}
            {!nameSearching && nameResults.length === 0 && <p className={styles.meta}>No matching deals.</p>}
            {nameResults.map(d => (
              <button
                key={d.id}
                type="button"
                className={styles.row}
                disabled={resolving}
                onClick={() => commit({ mode: "existing", dealId: d.id })}
              >
                <span className={styles.rowName}>{d.name}</span>
                <span className={styles.rowMeta}>{dealMeta(d)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {allowCreate && !creating && (
        <button type="button" className={styles.ghostBtn} onClick={() => setCreating(true)}>
          + Create a new deal
        </button>
      )}
      {allowCreate && creating && (
        <div className={styles.field}>
          <label className={styles.label}>New deal name</label>
          <div className={styles.inlineRow}>
            <input value={newDealName} onChange={e => setNewDealName(e.target.value)} className={styles.input} />
            <button
              type="button"
              className={styles.smallBtn}
              disabled={!newDealName.trim() || resolving}
              onClick={() => commit({ mode: "create", dealName: newDealName.trim() })}
            >
              {resolving ? "Creating…" : "Create deal"}
            </button>
          </div>
        </div>
      )}

      {refusal && (
        <div className={styles.error}>
          {refusal.message}
          {refusal.candidates && refusal.candidates.length > 0 && (
            <div className={styles.list} data-nested="true">
              {refusal.candidates.map(d => (
                <button
                  key={d.id}
                  type="button"
                  className={styles.row}
                  disabled={resolving}
                  onClick={() => commit({ mode: "existing", dealId: d.id })}
                >
                  <span className={styles.rowName}>{d.name}</span>
                  <span className={styles.rowMeta}>{dealMeta(d)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
