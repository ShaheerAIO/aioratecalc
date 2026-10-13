"use client";

import { useState, type ReactNode } from "react";
import { isFromHubspotField, UNKNOWABLE_REVIEW_FIELDS, type AppliedReviewFields } from "@/lib/prefillMerge";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";
import styles from "./MerchantDetailsForm.module.css";

/** One entry in the "use an existing contact" dropdown — see the Billing section below. */
export type ContactOption = { id: string; label: string };

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
  /**
   * The Billing contact section (2026-10-13, "add billing contact" / "add
   * email to owner contact - dropdown for existing or make a new one").
   * Every prop here is optional — a caller that doesn't pass them gets no
   * Billing section at all (and the pre-existing Owner section renders
   * exactly as it always has), which is what keeps every caller that predates
   * this change compiling and passing unmodified.
   *
   * `contactOptions` is the SAME deal+company contact list the page's own
   * "Quote for" dropdown already shows — passed down as plain {id, label}
   * pairs rather than this component importing HubspotContact/
   * contactOptionLabel from the hubspot adapter, so this stays a pure,
   * HubSpot-unaware presentational component. Reused on purpose — see
   * CLAUDE.md on not standing up a second portal-wide contact search.
   */
  contactOptions?: ContactOption[];
  billingContactId?: string | null;
  billing?: OwnerContact;
  onBillingContactIdChange?: (id: string | null) => void;
  onBillingChange?: (next: OwnerContact) => void;
  onCopyBillingFromOwner?: () => void;
};

const BIZ_TYPES: Array<[BusinessInfo["bizType"], string]> = [
  ["llc", "LLC"], ["corp", "Corporation"], ["s-corp", "S-Corp"],
  ["sole-prop", "Sole prop"], ["partnership", "Partnership"], ["non-profit", "Non-profit"],
];

const BLANK_CONTACT: OwnerContact = { firstName: "", lastName: "", title: "", email: "", phone: "" };

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
  contactOptions = [],
  billingContactId = null,
  billing = BLANK_CONTACT,
  onBillingContactIdChange = () => {},
  onBillingChange = () => {},
  onCopyBillingFromOwner = () => {},
}: Props) {
  const field = (
    path: string,
    label: string,
    span: number,
    value: string,
    onChange: (v: string) => void,
    opts: { placeholder?: string; type?: string; inputMode?: "numeric" | "decimal" | "tel"; disabled?: boolean } = {},
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
          disabled={opts.disabled}
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

  // CHECKBOX, not a one-time copy button (reversed 10/13, product owner's
  // second confirmation — the 10/12 button and its "silently keeps the two in
  // step" objection are superseded, not re-litigated here). Checked means the
  // legal address IS the operating address and tracks every edit to it; the
  // legal fields go read-only below so it's visible they're derived rather
  // than independently typed. Unchecked, the legal fields are free text again
  // and keep whatever they already held. The risk the 10/12 comment named is
  // real and is the one being accepted: Adyen and Check verify the legal
  // address against the state independently, so a synced-but-wrong value now
  // reaches them silently instead of requiring a rep to click a button first.
  // Initial state is computed once, from whatever the form was handed on
  // mount: checked only if both addresses are already filled in and equal,
  // never for a blank form asserting a legal address nobody supplied.
  const [sameAsOperating, setSameAsOperating] = useState(() => {
    const opStreet = (business.dbaAddress ?? "").trim();
    const opCity = (business.dbaCity ?? "").trim();
    const opState = (business.dbaState ?? "").trim();
    const opZip = (business.dbaZip ?? "").trim();
    const legStreet = business.address.trim();
    const legCity = business.city.trim();
    const legState = business.state.trim();
    const legZip = business.zip.trim();
    const bothNonEmpty = Boolean(opStreet) && Boolean(legStreet);
    return bothNonEmpty && opStreet === legStreet && opCity === legCity && opState === legState && opZip === legZip;
  });

  // Routes an edit to an OPERATING address field through to the legal fields
  // too, but only while the checkbox is checked — this is what "stays in
  // sync" means in practice, since the two groups are just four fields each
  // on the same `business` object, not a derived view of one another.
  const setOperatingAddress = (patch: Partial<Pick<BusinessInfo, "dbaAddress" | "dbaCity" | "dbaState" | "dbaZip">>) => {
    const next = { ...business, ...patch };
    if (sameAsOperating) {
      onBusinessChange({
        ...next,
        address: next.dbaAddress ?? "",
        city: next.dbaCity ?? "",
        state: next.dbaState ?? "",
        zip: next.dbaZip ?? "",
      });
    } else {
      onBusinessChange(next);
    }
  };

  const toggleSameAsOperating = (checked: boolean) => {
    setSameAsOperating(checked);
    if (checked) {
      b({
        address: business.dbaAddress ?? "",
        city: business.dbaCity ?? "",
        state: business.dbaState ?? "",
        zip: business.dbaZip ?? "",
      });
    }
  };
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
          {field("business.dbaAddress", "Operating street address", 4, business.dbaAddress ?? "", v => setOperatingAddress({ dbaAddress: v }))}
          {field("business.dbaCity", "City", 3, business.dbaCity ?? "", v => setOperatingAddress({ dbaCity: v }))}
          {field("business.dbaState", "State", 2, business.dbaState ?? "", v => setOperatingAddress({ dbaState: v }), { placeholder: "CA" })}
          {field("business.dbaZip", "ZIP", 3, business.dbaZip ?? "", v => setOperatingAddress({ dbaZip: v }), { inputMode: "numeric", placeholder: "90210" })}
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
          {field("business.address", "Legal street address", 4, business.address, v => b({ address: v }), { placeholder: "The customer fills this in", disabled: sameAsOperating })}
          {field("business.city", "City", 3, business.city, v => b({ city: v }), { placeholder: "—", disabled: sameAsOperating })}
          {field("business.state", "State", 2, business.state, v => b({ state: v }), { placeholder: "CA", disabled: sameAsOperating })}
          {field("business.zip", "ZIP", 3, business.zip, v => b({ zip: v }), { inputMode: "numeric", placeholder: "90210", disabled: sameAsOperating })}
        </div>
        <div className={styles.checkRow}>
          {/* A CHECKBOX again (reversed 10/13, product owner — see the note on
              `sameAsOperating` above for what this undoes and what it keeps:
              the 10/12 risk, that Adyen/Check verify the legal address against
              the state independently of whatever we hand them, is accepted
              rather than designed around). Checked, the legal fields below go
              read-only and mirror the operating address live, which is the
              visible tell that they're derived rather than typed. Unchecked,
              they're ordinary free text again and hold whatever was last in
              them — nothing is cleared on uncheck. */}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={sameAsOperating}
              onChange={e => toggleSameAsOperating(e.target.checked)}
            />
            Same as operating address
          </label>
          <span className={styles.tip}>
            <button type="button" className={styles.tipButton} aria-describedby="operating-address-tip" aria-label="What's the difference?">
              i
            </button>
            <span id="operating-address-tip" role="tooltip" className={styles.tipText}>
              The operating address is where the business actually trades — the restaurant
              itself, and what HubSpot holds. The legal address is where it is registered
              with the state. They often differ when the owner registered at home or
              through an accountant — check this box only when you know they&apos;re the
              same, since Adyen and Check verify the legal address against the state
              independently of what&apos;s entered here.
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
          {/* 2026-10-13, "add email to owner contact". The page's own "Send
              to" box (the header above the quote) edits this exact same
              ownerContact.email — this is a second place to see/edit it,
              alongside the rest of the owner's record, not a second value. */}
          {field("ownerContact.email", "Email", 6, ownerContact.email, v => o({ email: v }), { type: "email", placeholder: "owner@business.com" })}
        </div>
      </section>

      {/* 2026-10-13, "add billing contact" / "...dropdown for existing or
          make a new one add to hs". Optional and separate from the owner
          contact above: who AIO bills doesn't have to be who signs. Picking
          an existing contact here (the same deal+company list the page's
          "Quote for" dropdown already shows) and then editing a field pushes
          that edit back onto the matched HubSpot contact at save
          (`syncBillingContact`, actions/prospects.ts) — narrowly, only the
          fields actually changed. Typing a brand-new email instead creates
          one in HubSpot the same way the owner contact already does
          (`ensureQuoteContact`). The quote's SIGNER stays `ownerContact.email`
          only — this section never feeds that path. */}
      <section className={styles.group} aria-label="Billing">
        <h3 className={styles.groupLabel} aria-hidden="true">Billing</h3>
        <div className={styles.grid}>
          <label className={styles.field} data-span={6}>
            <span className={styles.label}>Use existing contact</span>
            <select
              value={billingContactId ?? ""}
              onChange={e => onBillingContactIdChange(e.target.value || null)}
              className={styles.input}
            >
              <option value="">New contact</option>
              {contactOptions.map(opt => <option key={opt.id} value={opt.id}>{opt.label}</option>)}
            </select>
          </label>
          <div className={styles.field} data-span={6}>
            <span className={styles.label}>&nbsp;</span>
            <button type="button" className={styles.copyButton} onClick={onCopyBillingFromOwner}>
              Same as owner contact
            </button>
          </div>
          {field("billing.firstName", "First name", 3, billing.firstName, v => onBillingChange({ ...billing, firstName: v }))}
          {field("billing.lastName", "Last name", 3, billing.lastName, v => onBillingChange({ ...billing, lastName: v }))}
          {field("billing.email", "Email", 3, billing.email, v => onBillingChange({ ...billing, email: v }), { type: "email", placeholder: "billing@business.com" })}
          {field("billing.phone", "Phone", 3, billing.phone, v => onBillingChange({ ...billing, phone: v }), { type: "tel", placeholder: "555-000-0000" })}
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
