"use client";

import { useState, type ReactNode } from "react";
import { isFromHubspotField, UNKNOWABLE_REVIEW_FIELDS, type AppliedReviewFields } from "@/lib/prefillMerge";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";
import styles from "./MerchantDetailsForm.module.css";

type Props = {
  business: BusinessInfo;
  ownerContact: OwnerContact;
  processing: ProcessingInfo;
  applied: AppliedReviewFields;
  /** False on a marketing-only quote, which has no processing behind it. */
  showProcessing: boolean;
  onBusinessChange: (next: BusinessInfo) => void;
  onOwnerChange: (next: OwnerContact) => void;
  onProcessingChange: (next: ProcessingInfo) => void;
};

const BIZ_TYPES: Array<[BusinessInfo["bizType"], string]> = [
  ["llc", "LLC"], ["corp", "Corporation"], ["s-corp", "S-Corp"],
  ["sole-prop", "Sole prop"], ["partnership", "Partnership"], ["non-profit", "Non-profit"],
];

/**
 * The onboarding details behind a quote link, as one dense form: a row per
 * topic on a 12-column grid. The same records ReviewSection edits, minus what
 * the prospects page already asks for in its header and rate block (contact,
 * email, volume, ticket).
 *
 * Provenance is a dot beside the label rather than a "from HubSpot" badge on
 * every field, and a field HubSpot can never fill says so in its placeholder —
 * the same two facts ReviewSection states, at a fraction of the height.
 */
export default function MerchantDetailsForm({
  business, ownerContact, processing, applied, showProcessing,
  onBusinessChange, onOwnerChange, onProcessingChange,
}: Props) {
  // Blank DBA address means "operates at the legal address", so the four
  // fields stay folded until the rep says otherwise — or HubSpot already did.
  // HubSpot often restates the legal address here; that's not "elsewhere".
  const [elsewhere, setElsewhere] = useState(() => {
    const same = (a: string | undefined, b: string) => !a?.trim() || a.trim().toLowerCase() === b.trim().toLowerCase();
    return !(
      same(business.dbaAddress, business.address) && same(business.dbaCity, business.city) &&
      same(business.dbaState, business.state) && same(business.dbaZip, business.zip)
    );
  });

  const field = (
    path: string,
    label: string,
    span: number,
    value: string,
    onChange: (v: string) => void,
    opts: { placeholder?: string; type?: string; inputMode?: "numeric" | "decimal" | "tel" } = {},
  ) => {
    const unknowable = UNKNOWABLE_REVIEW_FIELDS.includes(path);
    const fromHubspot = !unknowable && isFromHubspotField(applied, path, value);
    return (
      <label className={styles.field} data-span={span} key={path}>
        <span className={styles.label}>
          {label}
          {fromHubspot && <span className={styles.dot} title="From HubSpot" aria-label="from HubSpot" />}
        </span>
        <input
          type={opts.type ?? "text"}
          inputMode={opts.inputMode}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={unknowable && !opts.placeholder ? "Not in HubSpot" : opts.placeholder}
          className={styles.input}
        />
      </label>
    );
  };

  const select = (label: string, span: number, value: string, onChange: (v: string) => void, options: ReactNode) => (
    <label className={styles.field} data-span={span}>
      <span className={styles.label}>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)} className={styles.input}>
        {options}
      </select>
    </label>
  );

  const b = (patch: Partial<BusinessInfo>) => onBusinessChange({ ...business, ...patch });
  const o = (patch: Partial<OwnerContact>) => onOwnerChange({ ...ownerContact, ...patch });
  const p = (patch: Partial<ProcessingInfo>) => onProcessingChange({ ...processing, ...patch });
  const yesNo = (
    <>
      <option value="no">No</option>
      <option value="yes">Yes</option>
    </>
  );

  return (
    <div className={styles.form}>
      <p className={styles.legend}>
        <span className={styles.dot} aria-hidden="true" /> from HubSpot · everything is editable, and what you type wins
      </p>

      <section className={styles.group} aria-label="Business">
        <h3 className={styles.groupLabel} aria-hidden="true">Business</h3>
        <div className={styles.grid}>
          {field("business.legalName", "Legal name", 3, business.legalName, v => b({ legalName: v }))}
          {field("business.dba", "DBA", 3, business.dba, v => b({ dba: v }))}
          {select("Type", 2, business.bizType, v => b({ bizType: v as BusinessInfo["bizType"] }),
            BIZ_TYPES.map(([t, label]) => <option key={t} value={t}>{label}</option>))}
          {field("business.yearsInBusiness", "Years open", 1, business.yearsInBusiness, v => b({ yearsInBusiness: v }), { inputMode: "numeric", placeholder: "—" })}
          {field("business.website", "Website", 3, business.website, v => b({ website: v }), { placeholder: "https://" })}
        </div>
      </section>

      <section className={styles.group} aria-label="Legal address">
        <h3 className={styles.groupLabel} aria-hidden="true">Legal address</h3>
        <div className={styles.grid}>
          {field("business.address", "Street", 4, business.address, v => b({ address: v }))}
          {field("business.city", "City", 3, business.city, v => b({ city: v }))}
          {field("business.state", "State", 1, business.state, v => b({ state: v }), { placeholder: "CA" })}
          {field("business.zip", "ZIP", 2, business.zip, v => b({ zip: v }), { inputMode: "numeric", placeholder: "90210" })}
          {field("business.phone", "Business phone", 2, business.phone, v => b({ phone: v }), { type: "tel", placeholder: "555-000-0000" })}
        </div>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={elsewhere}
            onChange={e => {
              setElsewhere(e.target.checked);
              if (!e.target.checked) b({ dbaAddress: "", dbaCity: "", dbaState: "", dbaZip: "" });
            }}
          />
          Operates at a different address
        </label>
        {elsewhere && (
          <div className={styles.grid}>
            {field("business.dbaAddress", "Street", 4, business.dbaAddress ?? "", v => b({ dbaAddress: v }))}
            {field("business.dbaCity", "City", 3, business.dbaCity ?? "", v => b({ dbaCity: v }))}
            {field("business.dbaState", "State", 1, business.dbaState ?? "", v => b({ dbaState: v }), { placeholder: "CA" })}
            {field("business.dbaZip", "ZIP", 2, business.dbaZip ?? "", v => b({ dbaZip: v }), { inputMode: "numeric", placeholder: "90210" })}
          </div>
        )}
      </section>

      <section className={styles.group} aria-label="Owner">
        <h3 className={styles.groupLabel} aria-hidden="true">Owner</h3>
        <div className={styles.grid}>
          {field("ownerContact.firstName", "First name", 3, ownerContact.firstName, v => o({ firstName: v }))}
          {field("ownerContact.lastName", "Last name", 3, ownerContact.lastName, v => o({ lastName: v }))}
          {field("ownerContact.title", "Title", 3, ownerContact.title, v => o({ title: v }), { placeholder: "Owner" })}
          {field("ownerContact.phone", "Mobile", 3, ownerContact.phone, v => o({ phone: v }), { type: "tel", placeholder: "Texts the link" })}
        </div>
      </section>

      {showProcessing && (
        <section className={styles.group} aria-label="Processing">
          <h3 className={styles.groupLabel} aria-hidden="true">Processing</h3>
          <div className={styles.grid}>
            {field("processing.currentProcessor", "Current processor", 4, processing.currentProcessor, v => p({ currentProcessor: v }), { placeholder: "Stripe" })}
            {field("processing.mcc", "MCC", 2, processing.mcc, v => p({ mcc: v }), { inputMode: "numeric", placeholder: "5812" })}
            {field("processing.cardPresentPct", "Card present %", 2, processing.cardPresentPct, v => p({ cardPresentPct: v }), { inputMode: "decimal", placeholder: "95" })}
            {select("Terminated before?", 2, processing.previouslyTerminated, v => p({ previouslyTerminated: v as ProcessingInfo["previouslyTerminated"] }), yesNo)}
            {select("Bankruptcy, 5 yr?", 2, processing.bankruptcy, v => p({ bankruptcy: v as ProcessingInfo["bankruptcy"] }), yesNo)}
            <label className={styles.field} data-span={12}>
              <span className={styles.label}>
                What they do
                {isFromHubspotField(applied, "processing.businessDescription", processing.businessDescription) && (
                  <span className={styles.dot} title="From HubSpot" aria-label="from HubSpot" />
                )}
              </span>
              <textarea
                rows={2}
                value={processing.businessDescription}
                onChange={e => p({ businessDescription: e.target.value })}
                placeholder="Briefly describe the business…"
                className={`${styles.input} ${styles.textarea}`}
              />
            </label>
          </div>
        </section>
      )}
    </div>
  );
}
