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
  /**
   * The billing contact exactly as it was loaded from HubSpot at pick time
   * (see `selectBillingContact`, page.tsx) — never touched after that. Used
   * only to decide whether to show the "this will update HubSpot" note
   * below; null whenever no existing contact is selected.
   */
  billingContactLoaded?: OwnerContact | null;
  onBillingContactIdChange?: (id: string | null) => void;
  onBillingChange?: (next: OwnerContact) => void;
};

const BIZ_TYPES: Array<[BusinessInfo["bizType"], string]> = [
  ["", "Select…"],
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
  billingContactLoaded = null,
  onBillingContactIdChange = () => {},
  onBillingChange = () => {},
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
  const o = (patch: Partial<OwnerContact>) => {
    const next = { ...ownerContact, ...patch };
    onOwnerChange(next);
    // Live mirror, same shape as setOperatingAddress below: while "Same as
    // owner contact" is checked, every owner edit routes through to Billing
    // too, not just the moment the box is ticked.
    if (sameAsOwner) mirrorBillingFromOwner(next);
  };
  const p = (patch: Partial<ProcessingInfo>) => onProcessingChange({ ...processing, ...patch });

  // CHECKBOX, not a one-time copy button (reversed 10/13, product owner's
  // second confirmation — the 10/12 button and its "silently keeps the two in
  // step" objection are superseded, not re-litigated here). Checked means the
  // legal address IS the operating address and tracks every edit to it; the
  // legal fields are HIDDEN below (not merely disabled — product owner,
  // 2026-10-13: "hide the duplicate rows for cleanliness") and replaced by a
  // one-line summary of what they currently hold, since hiding the inputs
  // would otherwise remove the only on-screen statement of what gets saved.
  // Unchecked, the legal fields are free text again and keep whatever they
  // already held. The risk the 10/12 comment named is
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

  // The one-line stand-in for the legal address fields while they're hidden
  // (sameAsOperating checked) — the only remaining on-screen statement of
  // what will actually be saved. Null, not an empty string, when there's
  // nothing to echo yet, so the caller renders nothing rather than a blank line.
  const legalAddressSummary = (() => {
    const street = business.address.trim();
    if (!street) return null;
    const cityState = [business.city.trim(), business.state.trim()].filter(Boolean).join(", ");
    const tail = [cityState, business.zip.trim()].filter(Boolean).join(" ");
    return tail ? `${street}, ${tail}` : street;
  })();

  // Same CHECKBOX pattern as "Same as operating address" above (reversed
  // 10/13, product owner's second confirmation, from the one-time copy
  // button this superseded). Checked means Billing IS the Owner contact and
  // tracks every edit to it (see `o` above); the four billing fields AND the
  // contact picker are HIDDEN below, same treatment as the legal address
  // fields above. Picking an existing HubSpot contact while this is checked
  // would let "same as owner" silently PATCH that contact's record, so
  // checking it always clears `billingContactId` first — a synced billing
  // contact can never be a picked one, which is also why the picker itself
  // goes rather than merely being reset (it was still usable until
  // 2026-10-14). Unchecking leaves the copied values in place; nothing is
  // cleared. Initial state, like the address checkbox, is computed once from
  // whatever the form was handed on mount: checked only when both contacts
  // are already filled in and identical, never asserted for a blank form.
  const [sameAsOwner, setSameAsOwner] = useState(() => {
    const ownerKey = ownerContact.firstName.trim();
    const billingKey = billing.firstName.trim();
    const bothNonEmpty = Boolean(ownerKey) && Boolean(billingKey);
    return bothNonEmpty
      && ownerContact.firstName === billing.firstName
      && ownerContact.lastName === billing.lastName
      && ownerContact.title === billing.title
      && ownerContact.email === billing.email
      && ownerContact.phone === billing.phone;
  });

  // Copies the owner contact's fields into Billing — title included (feeds
  // HubSpot's jobtitle; there's no Billing input for it, so this is
  // intentionally invisible here). Always clears billingContactId: a synced
  // billing contact is never also a picked HubSpot one.
  const mirrorBillingFromOwner = (owner: OwnerContact) => {
    onBillingContactIdChange(null);
    onBillingChange({
      firstName: owner.firstName, lastName: owner.lastName, title: owner.title,
      email: owner.email, phone: owner.phone,
    });
  };

  const toggleSameAsOwner = (checked: boolean) => {
    setSameAsOwner(checked);
    if (checked) mirrorBillingFromOwner(ownerContact);
  };

  // The one-line stand-in for the billing contact fields while they're
  // hidden (sameAsOwner checked) — name and email, the two things a rep most
  // needs to confirm. Null when there's nothing to echo yet.
  const billingContactSummary = (() => {
    const name = [billing.firstName.trim(), billing.lastName.trim()].filter(Boolean).join(" ");
    const email = billing.email.trim();
    if (!name && !email) return null;
    return [name, email].filter(Boolean).join(" · ");
  })();

  // The note below the Billing fields: only when an existing HubSpot contact
  // is picked AND the rep has actually changed something from what loaded —
  // see `syncBillingContact` (actions/prospects.ts) for what this warns
  // about. Email is included in the comparison (any edit is worth a nudge)
  // even though it's the one field that's never written back.
  const billingContactChanged = Boolean(billingContactId) && billingContactLoaded !== null && (
    billing.firstName !== billingContactLoaded.firstName
    || billing.lastName !== billingContactLoaded.lastName
    || billing.email !== billingContactLoaded.email
    || billing.phone !== billingContactLoaded.phone
  );

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

      {/* DBA, first field on the form (product owner, 2026-10-15: "move dba
          to the top"). */}
      <section className={styles.group} aria-label="DBA">
        <h3 className={styles.groupLabel} aria-hidden="true">DBA</h3>
        <div className={styles.grid}>
          {field("business.dba", "DBA (trading name)", 4, business.dba, v => b({ dba: v }))}
        </div>
      </section>

      {/* The restaurant itself — the address HubSpot actually carries, because
          the HubSpot Company IS the restaurant. Shown FIRST, and the legal
          address below it is the one that comes back blank, which is the
          right way round (product owner, 2026-10-12). */}
      <section className={styles.group} aria-label="DBA address">
        <h3 className={styles.groupLabel} aria-hidden="true">DBA address</h3>
        <div className={styles.grid}>
          {field("business.dbaAddress", "DBA street address", 4, business.dbaAddress ?? "", v => setOperatingAddress({ dbaAddress: v }))}
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
          {!sameAsOperating && field("business.address", "Legal street address", 4, business.address, v => b({ address: v }), { placeholder: "The customer fills this in" })}
          {!sameAsOperating && field("business.city", "City", 3, business.city, v => b({ city: v }), { placeholder: "—" })}
          {!sameAsOperating && field("business.state", "State", 2, business.state, v => b({ state: v }), { placeholder: "CA" })}
          {!sameAsOperating && field("business.zip", "ZIP", 3, business.zip, v => b({ zip: v }), { inputMode: "numeric", placeholder: "90210" })}
        </div>
        {sameAsOperating && legalAddressSummary && (
          <p className={styles.billingWarning}>{legalAddressSummary}</p>
        )}
        <div className={styles.checkRow}>
          {/* A CHECKBOX again (reversed 10/13, product owner — see the note on
              `sameAsOperating` above for what this undoes and what it keeps:
              the 10/12 risk, that Adyen/Check verify the legal address against
              the state independently of whatever we hand them, is accepted
              rather than designed around). Checked, the legal fields below are
              hidden and replaced by a one-line summary that mirrors the
              operating address live. Unchecked, they're ordinary free text
              again and hold whatever was last in them — nothing is cleared on
              uncheck. The tooltip stays reachable either way — it matters
              more, not less, once the fields themselves are out of view. */}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={sameAsOperating}
              onChange={e => toggleSameAsOperating(e.target.checked)}
            />
            Same as DBA address
          </label>
          <span className={styles.tip}>
            <button type="button" className={styles.tipButton} aria-describedby="operating-address-tip" aria-label="What's the difference?">
              i
            </button>
            <span id="operating-address-tip" role="tooltip" className={styles.tipText}>
              The DBA address (also called the operating address) is where the business actually trades — the restaurant
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
          {field("business.website", "Website", 3, business.website, v => b({ website: v }), { placeholder: "https://" })}
          {field("business.phone", "Business phone", 3, business.phone, v => b({ phone: v }), { type: "tel", placeholder: "555-000-0000" })}
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
      <section className={styles.group} aria-label="Billing contact">
        <h3 className={styles.groupLabel} aria-hidden="true">Billing Contact</h3>
        {/* In the CONTENT column, not under the label: at >=64rem `.group` is an
            8.5rem | 1fr grid and `.groupLabel` spans the left one, which would
            wrap this sentence to five lines. `.billingWarning` below already
            sits in the same column. */}
        <p className={styles.groupNote}>This is where your invoices will be emailed to</p>
        {/* The WHOLE grid goes when "same as owner" is checked — the picker
            with it, not just the four fields (2026-10-14). `sameAsOwner`
            means billing IS the owner contact, so there is nothing left to
            pick, and `mirrorBillingFromOwner` clears `billingContactId` on
            every sync precisely so a synced billing contact is never also a
            picked one. Leaving the picker up let a rep re-pick one while
            checked and put the form straight back into the state that
            invariant exists to prevent: "same as owner" silently PATCHing
            that HubSpot contact's record. The summary line below stands in
            for all of it. */}
        {!sameAsOwner && (
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
            {field("billing.firstName", "First name", 3, billing.firstName, v => onBillingChange({ ...billing, firstName: v }))}
            {field("billing.lastName", "Last name", 3, billing.lastName, v => onBillingChange({ ...billing, lastName: v }))}
            {field("billing.email", "Email", 3, billing.email, v => onBillingChange({ ...billing, email: v }), { type: "email", placeholder: "billing@business.com" })}
            {field("billing.phone", "Phone", 3, billing.phone, v => onBillingChange({ ...billing, phone: v }), { type: "tel", placeholder: "555-000-0000" })}
          </div>
        )}
        {sameAsOwner && billingContactSummary && (
          <p className={styles.billingWarning}>{billingContactSummary}</p>
        )}
        <div className={styles.checkRow}>
          {/* A CHECKBOX, not a one-time copy button (reversed 10/13 — see
              `sameAsOwner`'s comment above for what this undoes). Checked,
              Billing mirrors the Owner contact live and the four fields above
              are hidden, replaced by a one-line name-and-email summary.
              Unchecked, they're ordinary free text again and hold whatever
              was last in them. */}
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={sameAsOwner}
              onChange={e => toggleSameAsOwner(e.target.checked)}
            />
            Same as owner contact
          </label>
        </div>
        {billingContactChanged && (
          <p className={styles.billingWarning}>
            Saving will update this contact&apos;s name and phone in HubSpot — the email above can&apos;t be changed here.
          </p>
        )}
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
