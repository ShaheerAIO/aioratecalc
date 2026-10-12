"use client";

import type { ReactNode } from "react";
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

      {/* The restaurant itself — the address HubSpot actually carries, because
          the HubSpot Company IS the restaurant. Shown FIRST, and the legal
          address below it is the one that comes back blank, which is the
          right way round (product owner, 2026-10-12). */}
      <section className={styles.group} aria-label="Operating">
        <h3 className={styles.groupLabel} aria-hidden="true">Operating</h3>
        <div className={styles.grid}>
          {field("business.dbaAddress", "Operating street address", 4, business.dbaAddress ?? "", v => b({ dbaAddress: v }))}
          {field("business.dbaCity", "City", 3, business.dbaCity ?? "", v => b({ dbaCity: v }))}
          {field("business.dbaState", "State", 2, business.dbaState ?? "", v => b({ dbaState: v }), { placeholder: "CA" })}
          {field("business.dbaZip", "ZIP", 3, business.dbaZip ?? "", v => b({ dbaZip: v }), { inputMode: "numeric", placeholder: "90210" })}
        </div>
      </section>

      {/* Everything that's on the registration, together: the name, the entity
          type and the address the state has on file. The legal name is
          written back to the HubSpot company when the link is created; the
          legal address is written back when the customer submits their
          onboarding form, which is where it is actually asked for. */}
      <section className={styles.group} aria-label="Legal">
        <h3 className={styles.groupLabel} aria-hidden="true">Legal</h3>
        <div className={styles.grid}>
          {field("business.legalName", "Legal name, as registered", 8, business.legalName, v => b({ legalName: v }), { placeholder: "Not in HubSpot · saved back to the company" })}
          {select("Entity type", 4, business.bizType, v => b({ bizType: v as BusinessInfo["bizType"] }),
            BIZ_TYPES.map(([t, label]) => <option key={t} value={t}>{label}</option>))}
          {field("business.address", "Legal street address", 4, business.address, v => b({ address: v }), { placeholder: "The customer fills this in" })}
          {field("business.city", "City", 3, business.city, v => b({ city: v }), { placeholder: "—" })}
          {field("business.state", "State", 2, business.state, v => b({ state: v }), { placeholder: "CA" })}
          {field("business.zip", "ZIP", 3, business.zip, v => b({ zip: v }), { inputMode: "numeric", placeholder: "90210" })}
        </div>
        <div className={styles.checkRow}>
          {/* A COPY, triggered by the rep, not a checkbox that silently keeps
              the two in step. HubSpot has no legal address — restating the
              restaurant's own address as the registered one is a guess, and
              Adyen and Check both verify this against the state. A rep who
              knows they're the same says so; otherwise it stays blank and the
              merchant answers it. */}
          <button
            type="button"
            className={styles.copyButton}
            onClick={() => b({
              address: business.dbaAddress ?? "", city: business.dbaCity ?? "",
              state: business.dbaState ?? "", zip: business.dbaZip ?? "",
            })}
            disabled={!(business.dbaAddress ?? "").trim()}
          >
            Same as operating address
          </button>
          <span className={styles.tip}>
            <button type="button" className={styles.tipButton} aria-describedby="operating-address-tip" aria-label="What's the difference?">
              i
            </button>
            <span id="operating-address-tip" role="tooltip" className={styles.tipText}>
              The operating address is where the business actually trades — the restaurant
              itself, and what HubSpot holds. The legal address is where it is registered
              with the state. They often differ when the owner registered at home or
              through an accountant, so the customer confirms it on their onboarding form.
            </span>
          </span>
        </div>
      </section>

      <section className={styles.group} aria-label="Business">
        <h3 className={styles.groupLabel} aria-hidden="true">Business</h3>
        <div className={styles.grid}>
          {field("business.dba", "DBA (trading name)", 4, business.dba, v => b({ dba: v }))}
          {field("business.website", "Website", 3, business.website, v => b({ website: v }), { placeholder: "https://" })}
          {field("business.phone", "Business phone", 3, business.phone, v => b({ phone: v }), { type: "tel", placeholder: "555-000-0000" })}
          {field("business.yearsInBusiness", "Years open", 2, business.yearsInBusiness, v => b({ yearsInBusiness: v }), { inputMode: "numeric", placeholder: "—" })}
        </div>
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
            {field("processing.currentProcessor", "Previous processor", 4, processing.currentProcessor, v => p({ currentProcessor: v }), { placeholder: "Stripe · saved to HubSpot" })}
            {field("processing.mcc", "MCC", 2, processing.mcc, v => p({ mcc: v }), { inputMode: "numeric", placeholder: "5812" })}
            {field("processing.cardPresentPct", "Card present %", 2, processing.cardPresentPct, v => p({ cardPresentPct: v }), { inputMode: "decimal", placeholder: "95" })}
            {select("Terminated before?", 2, processing.previouslyTerminated, v => p({ previouslyTerminated: v as ProcessingInfo["previouslyTerminated"] }), yesNo)}
            {select("Bankruptcy, 5 yr?", 2, processing.bankruptcy, v => p({ bankruptcy: v as ProcessingInfo["bankruptcy"] }), yesNo)}
          </div>
        </section>
      )}
    </div>
  );
}
