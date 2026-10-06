"use client";

import { fmt$, fmtPct2 } from "@/lib/utils";
import type { StatementAnalysis, ProposalOutput } from "@/types/merchant";
import styles from "./ProposalStep.module.css";

type Props = {
  analysis: StatementAnalysis;
  proposal: ProposalOutput;
  onBack: () => void;
  onApply: () => void;
  onSendLink: () => void;
  sendingLink?: boolean;
  onNewProposal: () => void;
};

export default function ProposalStep({ analysis, proposal, onBack, onApply, onSendLink, sendingLink, onNewProposal }: Props) {
  const pVol = analysis.totalVolume || 1;
  // A statement-less deal (analysisFromQuoteConfig) has totalFees 0, so there
  // is no current cost to compare against and every "savings" figure below
  // would be a fabricated negative. The proposal shows the AIO rate instead.
  const hasCurrentCost  = (analysis.totalFees || 0) > 0;
  const currentEffRate  = (analysis.totalFees || 0) / pVol;
  const proposedEffRate = (proposal.projectedFees?.monthly || 0) / pVol;
  const savingsMonthly  = (analysis.totalFees || 0) - (proposal.projectedFees?.monthly || 0);
  const savingsAnnual   = savingsMonthly * 12;
  const savingsPct      = (analysis.totalFees || 0) > 0 ? savingsMonthly / (analysis.totalFees || 1) : 0;

  const printProposal = () => {
    const fmtP2 = (n: number) => `${((n || 0) * 100).toFixed(2)}%`;
    const fmtD  = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);
    const rates = proposal.proposedRates;
    const prepDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const safeName = (analysis.merchantName || "Merchant").replace(/[^a-zA-Z0-9]/g, "-");
    const dateStr  = new Date().toISOString().slice(0, 10);
    const fileName = "AIO-Proposal-" + safeName + "-" + dateStr + ".pdf";

    let ratesHtml = "";
    if (proposal.pricingModel === "flat-rate" && rates.pricingModel === "flat-rate") {
      ratesHtml = `<div class="rate-card"><div class="rate-lbl">All Cards</div><div class="rate-val">${fmtP2(rates.flatRate)}</div><div class="rate-sub">single flat rate</div></div>`
        + `<div class="rate-card"><div class="rate-lbl">Per Transaction</div><div class="rate-val">$${(rates.perTransaction || 0).toFixed(2)}</div><div class="rate-sub">auth fee</div></div>`;
    } else if (proposal.pricingModel === "2-tier" && rates.pricingModel === "2-tier") {
      // Four cards, except on a proposal generated before AMEX was priced
      // separately (2026-10-06) — those carry two rates and must still render
      // the two they have rather than two blanks.
      ratesHtml = `<div class="rate-card"><div class="rate-lbl">V/MC/Disc Card Present</div><div class="rate-val">${fmtP2(rates.cardPresentRate)}</div><div class="rate-sub">+ $${(rates.cardPresentPerTxn || 0).toFixed(2)}/txn</div></div>`
        + `<div class="rate-card"><div class="rate-lbl">V/MC/Disc Not Present</div><div class="rate-val">${fmtP2(rates.cardNotPresentRate)}</div><div class="rate-sub">+ $${(rates.cardNotPresentPerTxn || 0).toFixed(2)}/txn</div></div>`
        + (rates.amexCardPresentRate != null
            ? `<div class="rate-card"><div class="rate-lbl">AMEX Card Present</div><div class="rate-val">${fmtP2(rates.amexCardPresentRate)}</div><div class="rate-sub">+ $${(rates.cardPresentPerTxn || 0).toFixed(2)}/txn</div></div>`
            : "")
        + (rates.amexCardNotPresentRate != null
            ? `<div class="rate-card"><div class="rate-lbl">AMEX Not Present</div><div class="rate-val">${fmtP2(rates.amexCardNotPresentRate)}</div><div class="rate-sub">+ $${(rates.cardNotPresentPerTxn || 0).toFixed(2)}/txn</div></div>`
            : "");
    } else if (rates.pricingModel === "interchange-plus") {
      ratesHtml = `<div class="rate-card"><div class="rate-lbl">Markup</div><div class="rate-val">${rates.basisPoints} BPS</div><div class="rate-sub">above interchange</div></div>`
        + `<div class="rate-card"><div class="rate-lbl">Per Transaction</div><div class="rate-val">$${(rates.perTransaction || 0).toFixed(2)}</div><div class="rate-sub">auth fee</div></div>`;
    }
    if ((rates as { monthlyFee?: number }).monthlyFee) {
      ratesHtml += `<div class="rate-card"><div class="rate-lbl">Monthly Fee</div><div class="rate-val">${fmtD((rates as { monthlyFee?: number }).monthlyFee || 0)}</div><div class="rate-sub">service fee</div></div>`;
    }

    const vpItems = [
      "One platform for payments, POS, and operations—no more disconnected systems",
      hasCurrentCost
        ? "Clear, predictable pricing with immediate annual savings of " + fmtD(savingsAnnual)
        : "Clear, predictable pricing at an effective rate of " + fmtP2(proposedEffRate),
      "Real-time visibility into sales, costs, and performance across your business",
      "Less manual work for your team through automation and AI-powered workflows",
    ];
    const kvHtml = vpItems.map((t, i) =>
      `<div class="vp"><span class="vp-num">${String(i + 1).padStart(2, "0")}</span><span>${t}</span></div>`
    ).join("");

    // Without a statement there is no "current" column and no savings, so the
    // hero and the comparison table are built from the AIO side alone rather
    // than printing $0 current cost and a negative saving.
    const heroHtml = hasCurrentCost
      ? `<div class="savings-box"><div>`
        + `<div class="savings-lbl">Annual Savings</div>`
        + `<div class="savings-big">${fmtD(savingsAnnual)}</div>`
        + `</div><div style="display:flex;gap:28px;align-items:center">`
        + `<div class="stat"><div class="stat-val">${fmtD(savingsMonthly)}</div><div class="stat-lbl">Monthly Savings</div></div>`
        + `<div class="stat"><div class="stat-val">${fmtP2(proposedEffRate)}</div><div class="stat-lbl">New Effective Rate</div></div>`
        + `<div class="stat"><div class="stat-val">${fmtP2(currentEffRate)}</div><div class="stat-lbl">Current Rate</div></div>`
        + `</div></div>`
      : `<div class="savings-box"><div>`
        + `<div class="savings-lbl">Your AIO Effective Rate</div>`
        + `<div class="savings-big">${fmtP2(proposedEffRate)}</div>`
        + `</div><div style="display:flex;gap:28px;align-items:center">`
        + `<div class="stat"><div class="stat-val">${fmtD(proposal.projectedFees?.monthly || 0)}</div><div class="stat-lbl">Estimated Monthly Cost</div></div>`
        + `<div class="stat"><div class="stat-val">${fmtD(analysis.totalVolume)}</div><div class="stat-lbl">Monthly Volume</div></div>`
        + `</div></div>`;

    const comparisonHtml = hasCurrentCost
      ? `<div class="section"><h2>Fee Comparison</h2><table><thead><tr><th>Category</th><th>Current</th><th>Proposed</th><th>Savings</th></tr></thead><tbody>`
        + `<tr><td>Monthly Fees</td><td class="red">${fmtD(analysis.totalFees)}</td><td class="blue">${fmtD(proposal.projectedFees?.monthly)}</td><td class="green">${fmtD(savingsMonthly)}</td></tr>`
        + `<tr><td>Annual Fees</td><td class="red">${fmtD((analysis.totalFees || 0) * 12)}</td><td class="blue">${fmtD((proposal.projectedFees?.monthly || 0) * 12)}</td><td class="green">${fmtD(savingsAnnual)}</td></tr>`
        + `<tr><td>Effective Rate</td><td class="red">${fmtP2(currentEffRate)}</td><td class="blue">${fmtP2(proposedEffRate)}</td><td class="green">${fmtP2(currentEffRate - proposedEffRate)}</td></tr>`
        + `</tbody></table></div>`
      : `<div class="section"><h2>Your AIO Costs</h2><table><thead><tr><th>Category</th><th>Proposed</th></tr></thead><tbody>`
        + `<tr><td>Monthly Fees</td><td class="blue">${fmtD(proposal.projectedFees?.monthly)}</td></tr>`
        + `<tr><td>Annual Fees</td><td class="blue">${fmtD((proposal.projectedFees?.monthly || 0) * 12)}</td></tr>`
        + `<tr><td>Effective Rate</td><td class="blue">${fmtP2(proposedEffRate)}</td></tr>`
        + `</tbody></table>`
        + `<p style="font-size:12px;color:#888;margin-top:10px">Based on the volume and average ticket provided. Share a recent processing statement and we&rsquo;ll show the exact saving against it.</p></div>`;

    const exportScript = "<scr" + "ipt src=\"https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js\"><\/" + "scr" + "ipt>"
      + "<scr" + "ipt>"
      + "function exportPDF(){"
      + "var wrap=document.getElementById('pdf-btn-wrap');wrap.style.visibility='hidden';"
      + "html2pdf().set({margin:[10,10,10,10],filename:'" + fileName + "',"
      + "image:{type:'jpeg',quality:0.98},"
      + "html2canvas:{scale:2,useCORS:true,logging:false,backgroundColor:'#ffffff'},"
      + "jsPDF:{unit:'mm',format:'letter',orientation:'portrait'}})"
      + ".from(document.body).save().then(function(){wrap.style.visibility='visible';});}"
      + "<\/" + "scr" + "ipt>";

    const html = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"/>"
      + "<title>AIO Proposal — " + analysis.merchantName + "</title>"
      + "<style>*{box-sizing:border-box;margin:0;padding:0}"
      + "body{font-family:Helvetica Neue,Arial,sans-serif;color:#1a1a1a;background:#fff;padding:48px;font-size:14px;line-height:1.5}"
      + ".header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px;padding-bottom:24px;border-bottom:2px solid #e8614a}"
      + ".logo-text{font-size:22px;font-weight:800;letter-spacing:2px;color:#1a1a1a}"
      + ".logo-sub{font-size:11px;color:#888;letter-spacing:3px;text-transform:uppercase}"
      + ".date{font-size:12px;color:#888}"
      + ".proposal-badge{display:inline-block;background:#e8614a;color:#fff;font-size:10px;letter-spacing:3px;padding:4px 14px;border-radius:20px;margin-bottom:12px}"
      + ".merchant-name{font-size:36px;font-weight:800;margin-bottom:6px}"
      + ".summary{font-size:15px;color:#555;margin-bottom:40px;max-width:600px;line-height:1.7}"
      + ".savings-box{background:#f0faf4;border:1.5px solid #22c55e;border-radius:12px;padding:28px 32px;display:flex;gap:40px;align-items:center;margin-bottom:36px}"
      + ".savings-big{font-size:48px;font-weight:900;color:#16a34a;line-height:1}"
      + ".savings-lbl{font-size:11px;color:#16a34a;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}"
      + ".stat-val{font-size:20px;font-weight:700}"
      + ".stat-lbl{font-size:11px;color:#888;margin-top:3px}"
      + ".section{margin-bottom:36px}"
      + "h2{font-size:11px;font-weight:700;color:#888;letter-spacing:2px;text-transform:uppercase;margin:0 0 14px}"
      + ".rates-grid{display:flex;gap:14px;flex-wrap:wrap}"
      + ".rate-card{background:#f7f7f7;border-radius:8px;padding:18px 20px;min-width:140px;text-align:center}"
      + ".rate-lbl{font-size:10px;color:#888;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px}"
      + ".rate-val{font-size:26px;font-weight:800;color:#e8614a}"
      + ".rate-sub{font-size:11px;color:#888;margin-top:5px}"
      + "table{width:100%;border-collapse:collapse}"
      + "th{text-align:left;font-size:11px;color:#888;letter-spacing:1px;text-transform:uppercase;padding:10px 16px;background:#f7f7f7}"
      + "td{padding:12px 16px;border-bottom:1px solid #eee}"
      + ".red{color:#dc2626;font-weight:600}.blue{color:#2563eb;font-weight:600}.green{color:#16a34a;font-weight:700}"
      + ".vp-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}"
      + ".vp{background:#f7f7f7;border-radius:8px;padding:14px 16px;display:flex;gap:12px}"
      + ".vp-num{font-size:18px;font-weight:800;color:#e8614a;opacity:0.5;flex-shrink:0}"
      + ".footer{margin-top:48px;padding-top:20px;border-top:1px solid #eee;font-size:11px;color:#aaa;display:flex;justify-content:space-between}"
      + "</style></head><body>"
      + "<div class=\"header\"><div><div class=\"logo-text\">AIO</div><div class=\"logo-sub\">Proposal Engine</div></div><div class=\"date\">Prepared " + prepDate + "</div></div>"
      + "<div class=\"proposal-badge\">MERCHANT PROPOSAL</div>"
      + "<div class=\"merchant-name\">" + analysis.merchantName + "</div>"
      + "<div class=\"summary\">" + (proposal.proposalSummary || "") + "</div>"
      + heroHtml
      + "<div class=\"section\"><h2>Proposed Pricing</h2><div class=\"rates-grid\">" + ratesHtml + "</div></div>"
      + comparisonHtml
      + "<div class=\"section\"><h2>Key Value Points</h2><div class=\"vp-grid\">" + kvHtml + "</div></div>"
      + "<div class=\"footer\"><span>AIO — AI for Restaurants</span><span>aioapp.com</span></div>"
      + "<div id=\"pdf-btn-wrap\" style=\"position:fixed;top:20px;right:20px;z-index:9999;\">"
      + "<button onclick=\"exportPDF()\" style=\"background:#e8614a;color:#fff;border:none;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;\">⬇ Export as PDF</button></div>"
      + exportScript
      + "</body></html>";

    const blob = new Blob([html], { type: "text/html" });
    const url  = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  const rates = proposal.proposedRates;

  return (
    <div className={styles.panel}>
      {/* Hero */}
      <div className={styles.hero}>
        <div className={styles.badge}>MERCHANT PROPOSAL</div>
        <h1 className={styles.merchantName}>{analysis.merchantName || "Merchant"}</h1>
        <p className={styles.summary}>{proposal.proposalSummary}</p>
      </div>

      {/* Savings hero (Stat-Led, no card shape) */}
      <div className={styles.savingsBlock}>
        <div>
          <div className={styles.savingsLabel}>
            {hasCurrentCost ? "Annual Savings for Merchant" : "Merchant’s AIO Effective Rate"}
          </div>
          <div className={styles.savingsHero}>
            {hasCurrentCost ? fmt$(savingsAnnual) : fmtPct2(proposedEffRate)}
          </div>
          <div className={styles.savingsSub}>
            {hasCurrentCost
              ? `${fmtPct2(Math.abs(savingsPct))} reduction in costs`
              : "No statement on file — savings can’t be computed"}
          </div>
        </div>
        <div className={styles.statTicker}>
          {(hasCurrentCost
            ? [
                { val: fmt$(savingsMonthly), lbl: "Monthly Savings" },
                { val: fmtPct2(proposedEffRate), lbl: "New Effective Rate" },
                { val: fmtPct2(currentEffRate), lbl: "Current Rate" },
              ]
            : [
                { val: fmt$(proposal.projectedFees?.monthly || 0), lbl: "Monthly Cost" },
                { val: fmt$(analysis.totalVolume), lbl: "Monthly Volume" },
              ]
          ).map((s, i) => (
            <div key={i} className={styles.statItem}>
              {i > 0 && <div className={styles.statDivider} />}
              <div>
                <div className={styles.statVal}>{s.val}</div>
                <div className={styles.statLbl}>{s.lbl}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Rate and comparison side by side — see .sectionPair. */}
      <div className={styles.sectionPair}>
        {/* Proposed rates */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Proposed Rates</h2>
          <div className={styles.rateGrid}>
            {rates.pricingModel === "2-tier" && (
              <>
                <div className={styles.rateCard}><div className={styles.rateLbl}>V/MC/Disc Card Present</div><div className={styles.rateVal}>{fmtPct2(rates.cardPresentRate)}</div><div className={styles.rateSub}>+${(rates.cardPresentPerTxn || 0).toFixed(2)}/txn</div></div>
                <div className={styles.rateCard}><div className={styles.rateLbl}>V/MC/Disc Not Present</div><div className={`${styles.rateVal} ${styles["rateVal--alt"]}`}>{fmtPct2(rates.cardNotPresentRate)}</div><div className={styles.rateSub}>+${(rates.cardNotPresentPerTxn || 0).toFixed(2)}/txn</div></div>
                {/* Absent on proposals generated before AMEX was priced on its
                    own — those render the two rates they actually carry. */}
                {rates.amexCardPresentRate != null && (
                  <div className={styles.rateCard}><div className={styles.rateLbl}>AMEX Card Present</div><div className={styles.rateVal}>{fmtPct2(rates.amexCardPresentRate)}</div><div className={styles.rateSub}>+${(rates.cardPresentPerTxn || 0).toFixed(2)}/txn</div></div>
                )}
                {rates.amexCardNotPresentRate != null && (
                  <div className={styles.rateCard}><div className={styles.rateLbl}>AMEX Not Present</div><div className={`${styles.rateVal} ${styles["rateVal--alt"]}`}>{fmtPct2(rates.amexCardNotPresentRate)}</div><div className={styles.rateSub}>+${(rates.cardNotPresentPerTxn || 0).toFixed(2)}/txn</div></div>
                )}
              </>
            )}
            {rates.pricingModel === "interchange-plus" && (
              <>
                <div className={styles.rateCard}><div className={styles.rateLbl}>Markup</div><div className={styles.rateVal}>{rates.basisPoints} BPS</div><div className={styles.rateSub}>above interchange</div></div>
                <div className={styles.rateCard}><div className={styles.rateLbl}>Per Transaction</div><div className={`${styles.rateVal} ${styles["rateVal--alt"]}`}>${(rates.perTransaction || 0).toFixed(2)}</div><div className={styles.rateSub}>auth fee</div></div>
              </>
            )}
            {rates.pricingModel === "flat-rate" && (
              <>
                <div className={styles.rateCard}><div className={styles.rateLbl}>All Cards</div><div className={styles.rateVal}>{fmtPct2(rates.flatRate)}</div><div className={styles.rateSub}>single flat rate</div></div>
                <div className={styles.rateCard}><div className={styles.rateLbl}>Per Transaction</div><div className={`${styles.rateVal} ${styles["rateVal--alt"]}`}>${(rates.perTransaction || 0).toFixed(2)}</div><div className={styles.rateSub}>auth fee</div></div>
              </>
            )}
            {((rates as { monthlyFee?: number }).monthlyFee ?? 0) > 0 && (
              <div className={styles.rateCard}><div className={styles.rateLbl}>Monthly</div><div className={`${styles.rateVal} ${styles["rateVal--muted"]}`}>{fmt$((rates as { monthlyFee: number }).monthlyFee)}</div><div className={styles.rateSub}>platform fee</div></div>
            )}
          </div>
        </div>

        {/* Fee comparison — only a real comparison when a statement supplied the
            "current" column; otherwise the AIO side stands on its own. */}
        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>{hasCurrentCost ? "Fee Comparison" : "AIO Costs"}</h2>
          <div className={styles.panelSurface}>
            <div className={styles.tableHeader} data-cols={hasCurrentCost ? "4" : "2"}>
              {(hasCurrentCost ? ["Category", "Current", "Proposed", "Savings"] : ["Category", "Proposed"]).map(h => (
                <div key={h} className={styles.tableHeaderCell}>{h}</div>
              ))}
            </div>
            {[
              { cat: "Monthly Processing Fees", current: analysis.totalFees, proposed: proposal.projectedFees?.monthly, savings: savingsMonthly },
              { cat: "Annual Processing Fees", current: (analysis.totalFees || 0) * 12, proposed: (proposal.projectedFees?.monthly || 0) * 12, savings: savingsAnnual },
            ].map((r, i) => (
              <div key={i} className={styles.tableRow} data-cols={hasCurrentCost ? "4" : "2"}>
                <div className={styles.tableCell}>{r.cat}</div>
                {hasCurrentCost && <div className={`${styles.tableCell} ${styles["tableCell--danger"]}`}>{fmt$(r.current)}</div>}
                <div className={`${styles.tableCell} ${styles["tableCell--info"]}`}>{fmt$(r.proposed)}</div>
                {hasCurrentCost && <div className={`${styles.tableCell} ${styles["tableCell--success"]}`}>{fmt$(r.savings)}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Terminus CTA — the same place Flow B ends: a customer link. Filling in
          the business details first is optional; whatever the rep enters there
          becomes prefill on the customer's own onboarding form. */}
      <div className={styles.ctaPanel}>
        <div>
          <div className={styles.ctaTitle}>Ready to send this to the merchant?</div>
          <div className={styles.ctaSub}>
            {analysis.merchantName || "The merchant"} opens the link to this quote, accepts, and onboards
            themselves. Add their business details first and they&rsquo;ll only have to confirm them.
          </div>
        </div>
        <div className={styles.ctaActions}>
          <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onApply}>
            Add Business Details
          </button>
          <button className={`${styles.btn} ${styles.btnSecondary}`} disabled={sendingLink} onClick={onSendLink}>
            {sendingLink ? "Creating link…" : "Send Customer Link →"}
          </button>
        </div>
      </div>

      <div className={styles.actions}>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onBack}>← Adjust Pricing</button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={printProposal}>Generate Customer Proposal</button>
        <button className={`${styles.btn} ${styles.btnGhost}`} onClick={onNewProposal}>New Proposal</button>
      </div>
    </div>
  );
}
