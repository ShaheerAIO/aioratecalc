"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createProspectAction, getHubspotCompanyForProspectAction } from "@/lib/actions/prospects";
import { searchTenantCompaniesAction } from "@/lib/actions/applications";
import ProductConfigurator, {
  type ConfiguredQuote,
  type ProductPick,
} from "@/components/quoting/ProductConfigurator";
import {
  isFromHubspot,
  mergeProspectPrefill,
  prefillCarryoverLabels,
  NO_PREFILL_APPLIED,
  type AppliedProspectPrefill,
} from "@/lib/prefillMerge";
import { ORDER_POINT_CHANNELS, isProcessingQuote } from "@/lib/quoting";
import { fmtPct2 } from "@/lib/utils";
import type { PricingModel, QuoteType, StatementAnalysis } from "@/types/merchant";
import type { ProspectPrefill } from "@/lib/hubspotPrefill";
import type { TenantCompany } from "@/lib/adapters/hubspot";
import styles from "./prospects-new.module.css";

const MODELS: PricingModel[] = ["flat-rate", "2-tier", "interchange-plus"];

function NewProspectFlow() {
  const searchParams = useSearchParams();
  const hubspotCompanyId = searchParams.get("hubspotCompanyId");

  const [merchantName, setMerchantName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [avgTicket, setAvgTicket]       = useState("");
  const [monthlyVolume, setMonthlyVolume] = useState("");
  const [targetMargin, setTargetMargin] = useState(0.008);
  const [pricingModel, setPricingModel] = useState<PricingModel>("2-tier");
  // Shoulder-surfing guard: the margin target is AIO-internal, so it stays shut
  // until the rep opens it. The default above still applies while collapsed.
  const [internalOpen, setInternalOpen] = useState(false);
  const [linkUrl, setLinkUrl]           = useState<string | null>(null);
  const [linkWarning, setLinkWarning]   = useState<string | null>(null);
  const [emailSent, setEmailSent]       = useState(false);
  const [smsSent, setSmsSent]           = useState(false);
  const [copied, setCopied]             = useState(false);
  const [saving, setSaving]             = useState(false);
  const [error, setError]               = useState<string | null>(null);

  // Product configurator. The quote type, picks and channels are owned here;
  // the lines, ordering-point count and derived platform/service lines they
  // imply come back derived. Declared above the HubSpot block because the
  // prefill seeds `channels`.
  const [quoteType, setQuoteType] = useState<QuoteType>("full_pos");
  const [picks, setPicks]       = useState<ProductPick[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [quote, setQuote]       = useState<ConfiguredQuote | null>(null);

  // A marketing-only quote has no processing behind it: no rate, no margin
  // target, no statement. The server drops those fields for this type too — this
  // is just not asking for them.
  const rated = isProcessingQuote(quoteType);

  // Phase F — deep link from the HubSpot Company record. Fetched server-side
  // via the server action; failure here must never block the form, only show
  // a non-blocking notice, so it's kept separate from `error` (which blocks
  // submit).
  const [hubspotCompany, setHubspotCompany]   = useState<TenantCompany | null>(null);
  const [hubspotNotice, setHubspotNotice]     = useState<string | null>(null);
  const [prefill, setPrefill]                 = useState<ProspectPrefill | null>(null);
  const [applied, setApplied]                 = useState<AppliedProspectPrefill>(NO_PREFILL_APPLIED);
  const [prefillLoading, setPrefillLoading]   = useState(false);

  // Latest form values, so applying a prefill from an async callback merges
  // against what's on screen now rather than whatever was there when the fetch
  // started. Same ref-mirror trick ProductConfigurator uses for its emit.
  const formRef    = useRef({ merchantName, contactEmail, channels });
  const appliedRef = useRef(applied);
  useEffect(() => {
    formRef.current = { merchantName, contactEmail, channels };
    appliedRef.current = applied;
  });

  // THE RULE (see prefillMerge.ts): HubSpot owns a field until the rep types in
  // it. Switching companies therefore REPLACES the previous company's values —
  // they were recorded as HubSpot's — while anything the rep typed survives.
  // Passing null (company cleared / unreadable) withdraws what HubSpot filled.
  const applyPrefill = useCallback((next: ProspectPrefill | null) => {
    const merged = mergeProspectPrefill(formRef.current, appliedRef.current, next);
    setMerchantName(merged.merchantName);
    setContactEmail(merged.contactEmail);
    setChannels(merged.channels);
    setApplied(merged.applied);
    setPrefill(next);
    // Kept in step immediately so two prefills in a row can't merge against a
    // pre-render snapshot.
    formRef.current = { merchantName: merged.merchantName, contactEmail: merged.contactEmail, channels: merged.channels };
    appliedRef.current = merged.applied;
  }, []);

  useEffect(() => {
    if (!hubspotCompanyId) return;
    let cancelled = false;
    getHubspotCompanyForProspectAction(hubspotCompanyId)
      .then(res => {
        if (cancelled) return;
        if (res.company) {
          setHubspotCompany(res.company);
          applyPrefill(res.prefill);
        }
        if (res.error) setHubspotNotice(res.error);
      })
      .catch(e => { if (!cancelled) setHubspotNotice(e instanceof Error ? e.message : "Could not reach HubSpot"); });
    return () => { cancelled = true; };
  }, [hubspotCompanyId, applyPrefill]);

  // HubSpot deprecated classic CRM cards, so there's no "start from HubSpot"
  // button anymore — the flow inverts: start here, find the company. This is
  // a second way to set the SAME `hubspotCompany` state the deep link sets;
  // everything downstream (prefill, badge, submit) is shared.
  const [hubspotQuery, setHubspotQuery]         = useState("");
  const [hubspotResults, setHubspotResults]     = useState<TenantCompany[]>([]);
  const [hubspotSearching, setHubspotSearching] = useState(false);
  const [hubspotSearchError, setHubspotSearchError] = useState<string | null>(null);

  useEffect(() => {
    const q = hubspotQuery.trim();
    if (q.length < 2) { setHubspotResults([]); setHubspotSearching(false); setHubspotSearchError(null); return; }
    setHubspotSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      searchTenantCompaniesAction(q)
        .then(r => { if (!cancelled) { setHubspotResults(r); setHubspotSearchError(null); } })
        .catch(e => { if (!cancelled) { setHubspotResults([]); setHubspotSearchError(e instanceof Error ? e.message : "Could not reach HubSpot"); } })
        .finally(() => { if (!cancelled) setHubspotSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [hubspotQuery]);

  // The search result is only a TenantCompany — the prefill needs the full
  // profile plus the owner contact, so the picker takes the same server round
  // trip the deep link does. The badge appears immediately from the search row;
  // the prefill lands when the read returns.
  // Two picks in quick succession: the loser's response must not land on top of
  // the winner's prefill.
  const prefillRequestRef = useRef<string | null>(null);

  const selectHubspotCompany = (company: TenantCompany) => {
    setHubspotCompany(company);
    setHubspotNotice(null);
    setHubspotQuery("");
    setHubspotResults([]);
    setPrefillLoading(true);
    prefillRequestRef.current = company.id;
    getHubspotCompanyForProspectAction(company.id)
      .then(res => {
        if (prefillRequestRef.current !== company.id) return;
        applyPrefill(res.prefill);
        if (res.error) setHubspotNotice(res.error);
      })
      .catch(e => {
        if (prefillRequestRef.current === company.id) {
          setHubspotNotice(e instanceof Error ? e.message : "Could not reach HubSpot");
        }
      })
      .finally(() => { if (prefillRequestRef.current === company.id) setPrefillLoading(false); });
  };

  const clearHubspotCompany = () => {
    setHubspotCompany(null);
    setHubspotNotice(null);
    prefillRequestRef.current = null;
    setPrefillLoading(false);
    applyPrefill(null);
  };

  // Optional statement upload — the rep path through the same /api/analyze
  // route the proposal wizard uses. When it succeeds the analysis rides along
  // on the application, so the customer opens the link to a prepared quote.
  const [file, setFile]             = useState<File | null>(null);
  const [analysis, setAnalysis]     = useState<StatementAnalysis | null>(null);
  const [analyzing, setAnalyzing]   = useState(false);
  const [dragOver, setDragOver]     = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // A required line — the platform tier, or one of the always-included services
  // — is owed but the catalog didn't yield it. Blocks the save rather than
  // quietly shipping a quote with a hole in it; the server refuses it too.
  const blockers = quote?.blockers ?? [];

  const handleFile = (f: File) => {
    setFile(f);
    setAnalysis(null);
    setError(null);
    setAnalyzing(true);
    const r = new FileReader();
    r.onload = async e => {
      try {
        const fileData = (e.target!.result as string).split(",")[1];
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileData, mediaType: f.type }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Analysis failed");
        setAnalysis(data.analysis as StatementAnalysis);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Analysis failed");
        setFile(null);
      }
      setAnalyzing(false);
    };
    r.readAsDataURL(f);
  };

  const submit = async () => {
    if (!merchantName || !contactEmail) {
      setError("Business name and contact email are required.");
      return;
    }
    const ticket = rated ? parseFloat(avgTicket) || 0 : 0;
    const volume = rated ? parseFloat(monthlyVolume) || 0 : 0;
    if ((ticket > 0) !== (volume > 0)) {
      setError("Enter both average ticket and monthly volume, or neither.");
      return;
    }
    if (blockers.length) {
      setError(blockers.join(" "));
      return;
    }
    if (!rated && !picks.length) {
      setError("A marketing-only quote needs at least one marketing product on it.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { linkUrl, warning, emailResult, smsResult } = await createProspectAction({
        merchantName, contactEmail, contactPhone: contactPhone || null, targetMargin, pricingModel, quoteType,
        quoteConfig: ticket > 0 && volume > 0 ? { avgTicket: ticket, monthlyVolume: volume } : null,
        analysis: rated ? analysis : null,
        // Only the picks cross the wire — prices and the tier are re-derived
        // server-side against the live catalog.
        picks,
        channels,
        hubspotCompanyId: hubspotCompany?.id ?? null,
      });
      setLinkUrl(linkUrl);
      setLinkWarning(warning);
      setEmailSent(emailResult.sent);
      setSmsSent(smsResult?.sent ?? false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create prospect");
    }
    setSaving(false);
  };

  const reset = () => {
    setMerchantName(""); setContactEmail(""); setContactPhone(""); setTargetMargin(0.008); setPricingModel("2-tier");
    setAvgTicket(""); setMonthlyVolume(""); setFile(null); setAnalysis(null);
    setQuoteType("full_pos"); setPicks([]); setChannels([]); setQuote(null);
    setLinkUrl(null); setLinkWarning(null); setEmailSent(false); setSmsSent(false); setCopied(false); setError(null);
    setHubspotCompany(null); setHubspotNotice(null);
    setPrefill(null); setApplied(NO_PREFILL_APPLIED); appliedRef.current = NO_PREFILL_APPLIED;
    setHubspotQuery(""); setHubspotResults([]); setHubspotSearchError(null);
  };

  // Matches the server's gate (hasQuoteBasis): a statement with no readable
  // volume is not a quote, so don't promise the customer one. On a
  // marketing-only quote the lines are the quote — there's no rate to have.
  const hasQuote = rated
    ? (analysis?.totalVolume ?? 0) > 0 || (parseFloat(avgTicket) > 0 && parseFloat(monthlyVolume) > 0)
    : picks.length > 0;

  // The prefill covers more than this form shows — createProspectAction stamps
  // the rest onto the application server-side — so name what's riding along
  // rather than letting the rep assume only the two visible fields carried.
  const carriedOver = prefillCarryoverLabels(prefill?.fromHubspot ?? []);
  const prefilledChannels = applied.channels.map(
    id => ORDER_POINT_CHANNELS.find(c => c.id === id)?.label ?? id
  );

  if (linkUrl) {
    return (
      <div className={styles.successWrap}>
        <div className={styles.successMark}>✓</div>
        <h1 className={styles.successTitle}>Prospect Created</h1>
        <p className={styles.successBody}>
          {hasQuote ? (
            <>
              Share this link with <strong>{merchantName}</strong> — their quote is already
              prepared, so they see it the moment they open it.
            </>
          ) : (
            <>
              Share this link with <strong>{merchantName}</strong> — they&apos;ll upload their own
              statement and get an instant quote, no account needed.
            </>
          )}
        </p>
        {linkWarning && <div className={styles.error}>{linkWarning}</div>}
        <div className={`${styles.panel} ${styles.linkRow}`}>
          <code className={styles.linkCode}>{linkUrl}</code>
          <button
            onClick={() => { navigator.clipboard.writeText(linkUrl); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
            className={styles.btnCopy}
            data-copied={copied}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className={styles.prefillNote}>
          {emailSent ? `Emailed to ${contactEmail}.` : "Email delivery isn't configured yet — send this link yourself."}
        </p>
        {contactPhone && (
          <p className={styles.prefillNote}>
            {smsSent ? `Texted to ${contactPhone}.` : "Text delivery isn't configured yet — send this link yourself."}
          </p>
        )}
        <button onClick={reset} className={styles.btnGhost}>
          Create Another
        </button>
      </div>
    );
  }

  return (
    <div className={styles.main}>
      <h1 className={styles.headerTitle}>Send Customer a Quote Link</h1>
      <p className={styles.headerSubtitle}>
        Set a margin target, then either prepare the quote yourself — with their ticket size and volume,
        or their statement — or send the link bare and let them upload it. Either way they see a quote at
        exactly this margin, with no cost breakdown and no account required.
      </p>

      {hubspotCompany && (
        <p className={styles.hubspotBadge}>
          Linked to HubSpot company: <strong>{hubspotCompany.name}</strong> ({hubspotCompany.id})
          <button type="button" className={styles.hubspotBadgeClear} onClick={clearHubspotCompany} aria-label="Remove HubSpot link">
            ×
          </button>
        </p>
      )}
      {hubspotNotice && (
        <div className={styles.error}>
          {hubspotCompany
            ? `Couldn't read this company's details from HubSpot (${hubspotNotice}) — the link is saved, but nothing was prefilled.`
            : `Couldn't load the linked HubSpot company (${hubspotNotice}) — continuing unlinked.`}
        </div>
      )}
      {prefillLoading && <p className={styles.prefillNote}>Loading details from HubSpot…</p>}
      {carriedOver.length > 0 && (
        <p className={styles.prefillNote}>
          Also carried onto their application from HubSpot: {carriedOver.join(", ")}. Anything you
          change here wins.
        </p>
      )}
      {prefilledChannels.length > 0 && (
        <p className={styles.prefillNote}>
          Ordering channels ticked below from HubSpot: {prefilledChannels.join(", ")}.
        </p>
      )}

      <div className={styles.panel}>
        <div className={styles.field}>
          <label className={styles.label}>
            Business Name
            {isFromHubspot(applied, "merchantName", merchantName) && (
              <span className={styles.fromHubspot}>from HubSpot</span>
            )}
          </label>
          <input value={merchantName} onChange={e => setMerchantName(e.target.value)} placeholder="Joe's Pizza" className={styles.input} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>
            Customer Contact Email
            {isFromHubspot(applied, "contactEmail", contactEmail) && (
              <span className={styles.fromHubspot}>from HubSpot</span>
            )}
          </label>
          <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} placeholder="owner@business.com" className={styles.input} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Customer Phone (optional — also texts the link)</label>
          <input type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="(555) 123-4567" className={styles.input} />
        </div>

        {!hubspotCompany && (
          <div className={styles.field}>
            <label className={styles.label}>Link HubSpot Company (optional)</label>
            <input
              type="search"
              value={hubspotQuery}
              onChange={e => setHubspotQuery(e.target.value)}
              placeholder="Search HubSpot companies…"
              className={styles.input}
            />
            {hubspotSearchError && (
              <div className={styles.error}>
                Couldn&apos;t search HubSpot ({hubspotSearchError}) — you can still send this quote unlinked.
              </div>
            )}
            {!hubspotSearchError && hubspotQuery.trim().length >= 2 && (
              <div className={styles.hubspotResults}>
                {hubspotSearching && <div className={styles.hubspotResultMeta}>Searching…</div>}
                {!hubspotSearching && hubspotResults.length === 0 && (
                  <div className={styles.hubspotResultMeta}>No matching companies.</div>
                )}
                {hubspotResults.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    className={styles.hubspotResultRow}
                    onClick={() => selectHubspotCompany(c)}
                  >
                    <span className={styles.hubspotResultName}>{c.name}</span>
                    <span className={styles.hubspotResultMeta}>{c.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rate half. A marketing-only quote has no processing behind it, so there
          is nothing to price against a statement — the products ARE the quote. */}
      {rated && (
      <div className={styles.panel}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Prepare the Quote (optional)</h2>
          <p className={styles.sectionNote}>
            Give us either the numbers or the statement and the customer opens the link straight to their
            quote. Leave both blank and they&apos;ll be asked to upload a statement first.
          </p>
        </div>

        <div className={styles.configRow}>
          <div className={styles.field}>
            <label className={styles.label}>Average Ticket</label>
            <input
              type="number" min="0" step="0.01" inputMode="decimal"
              value={avgTicket} onChange={e => setAvgTicket(e.target.value)}
              placeholder="35.00" className={styles.input}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Monthly Volume</label>
            <input
              type="number" min="0" step="100" inputMode="decimal"
              value={monthlyVolume} onChange={e => setMonthlyVolume(e.target.value)}
              placeholder="100000" className={styles.input}
            />
          </div>
        </div>

        <label className={styles.label}>Statement (optional — overrides the numbers above)</label>
        <div
          className={styles.dropzone}
          data-state={analyzing ? "busy" : analysis ? "done" : dragOver ? "dragging" : undefined}
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onClick={() => { if (!analyzing) fileRef.current?.click(); }}
        >
          <input
            ref={fileRef} type="file" accept=".pdf,image/*" className={styles.fileInput}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
          {analyzing ? (
            <p className={styles.dropzoneTitle}>Analyzing {file?.name}…</p>
          ) : analysis ? (
            <>
              <p className={styles.dropzoneTitle} data-state="done">✓ {file?.name}</p>
              <p className={styles.dropzoneSubtitle}>
                {analysis.merchantName || "Statement"} · read successfully · click to replace
              </p>
            </>
          ) : (
            <>
              <p className={styles.dropzoneTitle}>Drop their statement here or click to browse</p>
              <p className={styles.dropzoneSubtitle}>PDF or image · any processor format</p>
            </>
          )}
        </div>
      </div>
      )}

      <ProductConfigurator
        quoteType={quoteType}
        picks={picks}
        channels={channels}
        onQuoteTypeChange={setQuoteType}
        onPicksChange={setPicks}
        onChannelsChange={setChannels}
        onDerivedChange={setQuote}
      />

      {rated && (
      <div className={styles.panel}>
        <label className={styles.label}>Pricing Model</label>
        <div className={styles.modelRow}>
          {MODELS.map(m => (
            <button key={m} onClick={() => setPricingModel(m)} className={styles.modelPill} data-active={pricingModel === m}>
              {m.replace("-", " ")}
            </button>
          ))}
        </div>
        {/* Rep-only. Collapsed by default and showing no figure in the header:
            the rep often has the laptop turned toward the merchant. */}
        <button
          type="button"
          className={styles.disclosureBtn}
          aria-expanded={internalOpen}
          aria-controls="prospect-internal"
          onClick={() => setInternalOpen(o => !o)}
        >
          AIO Internal
          <span className={styles.disclosureChevron} aria-hidden="true">▾</span>
        </button>
        {internalOpen && (
          <div id="prospect-internal" className={styles.disclosureBody}>
            <div className={styles.marginRow}>
              <span className={styles.marginLabel}>Margin Target</span>
              <span className={styles.marginValue}>{fmtPct2(targetMargin)}</span>
            </div>
            <input
              type="range" min="0.001" max="0.04" step="0.0005"
              value={targetMargin}
              onChange={e => setTargetMargin(parseFloat(e.target.value))}
            />
          </div>
        )}
      </div>
      )}

      {error && (
        <div className={styles.error}>
          {error}
        </div>
      )}

      <button onClick={submit} disabled={saving || analyzing || blockers.length > 0} className={styles.btnPrimary}>
        {saving ? "Creating…" : hasQuote ? "Create Quote Link →" : "Create Link →"}
      </button>
    </div>
  );
}

export default function NewProspectPage() {
  return (
    <Suspense>
      <NewProspectFlow />
    </Suspense>
  );
}
