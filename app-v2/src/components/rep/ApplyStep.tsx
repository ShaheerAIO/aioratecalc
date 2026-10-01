"use client";

import { useState } from "react";
import type { MerchantApplication, BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";
import styles from "./ApplyStep.module.css";

// OPTIONAL step. The customer fills this same form for themselves on
// /customer/applications/[id] (CustomerOnboardStep), which prefills from
// app.business / ownerContact / processing — so everything the rep types here
// is work the customer no longer has to do. Nothing here is required to send
// the quote link; the rep can skip straight past it.
//
// There is deliberately NO agreement section: consent is an act only the
// merchant can perform, so this step cannot capture it and never writes it.
// See lib/consent.ts.
type Props = {
  app: MerchantApplication;
  onSaved: (app: MerchantApplication) => void | Promise<void>;
  onBack: () => void;
  onSkip: () => void;
};

export default function ApplyStep({ app, onSaved, onBack, onSkip }: Props) {
  const initial = app.analysis;
  const [biz, setBiz] = useState<Partial<BusinessInfo>>(app.business || {
    legalName: initial?.merchantName || "", dba: initial?.merchantName || "",
    bizType: "llc", address: "", city: "", state: "", zip: "",
    phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
  });
  const [owner, setOwner] = useState<Partial<OwnerContact>>(app.ownerContact || { firstName: "", lastName: "", title: "Owner", email: "", phone: "" });
  const [proc, setProc]   = useState<Partial<ProcessingInfo>>(app.processing || {
    monthlyVolume: String(Math.round(initial?.totalVolume || 0)),
    avgTicket: String(Math.round(initial?.averageTicket || 0)),
    cardPresentPct: String(Math.round((initial?.cardPresentPct || 0) * 100)),
    mcc: "", businessDescription: "", previouslyTerminated: "no", bankruptcy: "no",
    currentProcessor: initial?.currentProcessorName || "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState<string | null>(null);

  const b = <T extends Record<string, unknown>>(setter: (fn: (prev: T) => T) => void) =>
    (k: keyof T) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setter((prev: T) => ({ ...prev, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value } as T));

  const setBizF  = b<Partial<BusinessInfo>>(setBiz as Parameters<typeof b>[0]);
  const setOwnerF = b<Partial<OwnerContact>>(setOwner as Parameters<typeof b>[0]);
  const setProcF = b<Partial<ProcessingInfo>>(setProc as Parameters<typeof b>[0]);

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      // `agreement` is absent on purpose — the spread carries whatever is
      // already on the record (normally nothing, or the merchant's own consent
      // if they've since given it) straight back out. This step can neither
      // create consent nor destroy it.
      const updated: MerchantApplication = {
        ...app,
        stage: "proposal_sent",
        updatedAt: new Date().toISOString(),
        business: biz as BusinessInfo,
        ownerContact: owner as OwnerContact,
        processing: proc as ProcessingInfo,
      };
      await onSaved(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  };

  const input = (label: string, val: string, onChange: (e: React.ChangeEvent<HTMLInputElement>) => void, placeholder = "", type = "text") => (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input type={type} value={val} onChange={onChange} placeholder={placeholder} className={styles.input} />
    </div>
  );

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Business Details (Optional)</h1>
      <p className={styles.pageSubtitle}>
        Anything you fill in here is pre-filled on the merchant&apos;s own onboarding form, so all they
        have to do is confirm it. Skip it and they&apos;ll simply fill it in themselves. SSN, bank account,
        and EIN are collected by Adyen directly — AIO never touches that data. Accepting the terms is
        the merchant&apos;s to do on their own form, so it isn&apos;t here.
      </p>

      {/* Two tracks: the long Business Information panel on the left, the two
          short ones stacked beside it. One column below 64rem — see .columns. */}
      <div className={styles.columns}>
        <div className={styles.column}>

          {/* Business Info */}
          <div className={styles.panel}>
            <h2 className={styles.sectionTitle}>Business Information</h2>
            <div className={styles.grid2}>
              {input("Legal Business Name", biz.legalName || "", setBizF("legalName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("DBA (Doing Business As)", biz.dba || "", setBizF("dba") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={styles.row}>
              <label className={styles.label}>Business Type</label>
              <select value={biz.bizType || "llc"} onChange={setBizF("bizType") as (e: React.ChangeEvent<HTMLSelectElement>) => void} className={styles.input}>
                {(["llc", "corp", "s-corp", "sole-prop", "partnership", "non-profit"] as const).map(t => (
                  <option key={t} value={t}>{t.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase())}</option>
                ))}
              </select>
            </div>
            <div className={styles.row}>
              {input("Street Address", biz.address || "", setBizF("address") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("City", biz.city || "", setBizF("city") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("State", biz.state || "", setBizF("state") as (e: React.ChangeEvent<HTMLInputElement>) => void, "CA")}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("ZIP", biz.zip || "", setBizF("zip") as (e: React.ChangeEvent<HTMLInputElement>) => void, "90210")}
              {input("Business Phone", biz.phone || "", setBizF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("Website", biz.website || "", setBizF("website") as (e: React.ChangeEvent<HTMLInputElement>) => void, "https://")}
              {input("Years in Business", biz.yearsInBusiness || "", setBizF("yearsInBusiness") as (e: React.ChangeEvent<HTMLInputElement>) => void, "5")}
            </div>
          </div>

        </div>

        <div className={styles.column}>

          {/* Owner Contact */}
          <div className={styles.panel}>
            <h2 className={styles.sectionTitle}>Owner Contact</h2>
            <p className={styles.hint}>Contact info only — no SSN, DOB, or ID numbers.</p>
            <div className={styles.grid2}>
              {input("First Name", owner.firstName || "", setOwnerF("firstName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("Last Name", owner.lastName || "", setOwnerF("lastName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("Title", owner.title || "", setOwnerF("title") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Owner")}
              {input("Email", owner.email || "", setOwnerF("email") as (e: React.ChangeEvent<HTMLInputElement>) => void, "owner@business.com", "email")}
            </div>
            <div className={styles.row}>
              {input("Phone", owner.phone || "", setOwnerF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
            </div>
          </div>

          {/* Processing Details */}
          <div className={styles.panel}>
            <h2 className={styles.sectionTitle}>Processing Details</h2>
            <div className={styles.grid2}>
              {input("Monthly Volume ($)", proc.monthlyVolume || "", setProcF("monthlyVolume") as (e: React.ChangeEvent<HTMLInputElement>) => void, "100000", "number")}
              {input("Average Ticket ($)", proc.avgTicket || "", setProcF("avgTicket") as (e: React.ChangeEvent<HTMLInputElement>) => void, "45", "number")}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("Card Present % (0-100)", proc.cardPresentPct || "", setProcF("cardPresentPct") as (e: React.ChangeEvent<HTMLInputElement>) => void, "80", "number")}
              {input("MCC Code", proc.mcc || "", setProcF("mcc") as (e: React.ChangeEvent<HTMLInputElement>) => void, "5812")}
            </div>
            <div className={styles.row}>
              {input("Current Processor", proc.currentProcessor || "", setProcF("currentProcessor") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Stripe")}
            </div>
            <div className={styles.row}>
              <label className={styles.label}>Business Description</label>
              <textarea value={proc.businessDescription || ""} onChange={setProcF("businessDescription") as (e: React.ChangeEvent<HTMLTextAreaElement>) => void} placeholder="Briefly describe the nature of the business..." className={`${styles.input} ${styles.textarea}`} />
            </div>
            <div className={`${styles.inlineRow} ${styles.row}`}>
              <div className={styles.field}>
                <label className={styles.label}>Previously Terminated?</label>
                <select value={proc.previouslyTerminated || "no"} onChange={setProcF("previouslyTerminated") as (e: React.ChangeEvent<HTMLSelectElement>) => void} className={`${styles.input} ${styles.selectInline}`}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Bankruptcy (Past 5yr)?</label>
                <select value={proc.bankruptcy || "no"} onChange={setProcF("bankruptcy") as (e: React.ChangeEvent<HTMLSelectElement>) => void} className={`${styles.input} ${styles.selectInline}`}>
                  <option value="no">No</option>
                  <option value="yes">Yes</option>
                </select>
              </div>
            </div>
          </div>

        </div>
      </div>

      {err && (
        <div className={styles.errorBanner}>
          {err}
        </div>
      )}

      <div className={styles.actions}>
        <button className={styles.btnSecondary} onClick={onBack}>← Back to Proposal</button>
        <button className={styles.btnSecondary} disabled={saving} onClick={onSkip}>
          Skip — Send Link Now
        </button>
        <button
          className={styles.btnPrimary}
          disabled={saving}
          onClick={handleSave}
        >
          {saving ? "Saving…" : "Save & Send Customer Link →"}
        </button>
      </div>
    </div>
  );
}
