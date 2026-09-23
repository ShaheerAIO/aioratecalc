"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { saveMyApplicationOnboardingAction, updateMyApplicationDetailsAction } from "@/lib/actions/customer";
import { agreementToSubmit, customerOnboardInitial, flattenSections, recordedConsent } from "@/lib/prefillMerge";
import { validateOnboardingSubmission, type OnboardingFieldErrors } from "@/lib/onboardingValidation";
import type { MerchantApplication, BusinessInfo, OwnerContact, ProcessingInfo, AgreementInfo } from "@/types/merchant";
import styles from "./CustomerOnboardStep.module.css";

type Props = { app: MerchantApplication };

// Mirrors src/components/rep/ApplyStep.tsx's field groups/layout, but
// customer-facing: saves via saveMyApplicationOnboardingAction (session +
// ownership scoped) instead of the rep/admin-only saveApplicationAction, and
// records the merchant's details. It no longer chains into Adyen: EasyOB does
// not create Adyen accounts any more (that produced accounts misnamed and
// unlinked from the AIO tenant graph). AIO's platform provisions the tenant
// and mints the KYC link, and only once billing has been paid — so submitting
// details and starting verification are now separate moments.
export default function CustomerOnboardStep({ app }: Props) {
  const router = useRouter();
  // "Have they submitted before", which is all this ever meant. Keyed off the
  // submitted details rather than an Adyen URL, since that URL now arrives
  // much later in the flow (after billing) or not at all.
  const isEditing = Boolean(app.business && app.agreement);
  // Whatever the rep entered, HubSpot supplied at prospect creation, or the
  // statement revealed — so the customer confirms instead of retyping. The
  // merge rules (blank ≠ prefilled, form defaults aren't prefills) live in
  // prefillMerge.ts where they're testable.
  const [initial] = useState(() => customerOnboardInitial(app));
  const prefilled = useMemo(() => new Set(initial.prefilled), [initial]);
  const initialValues = useMemo(() => flattenSections(initial), [initial]);

  const [biz, setBiz]     = useState<Partial<BusinessInfo>>(initial.business);
  const [owner, setOwner] = useState<Partial<OwnerContact>>(initial.ownerContact);
  const [proc, setProc]   = useState<Partial<ProcessingInfo>>(initial.processing);
  // Consent is never PREFILLED — with nothing on record the boxes start empty,
  // because a pre-ticked box is not consent. Consent already RECORDED is a
  // different thing: it's shown back as the fact it is, so a customer editing
  // their phone number isn't made to re-consent. See prefillMerge.ts.
  const [recorded] = useState(() => recordedConsent(app.agreement));
  const [reviewingConsent, setReviewingConsent] = useState(false);
  // Any edit inside the consent panel makes this consent given now rather than
  // a replay of the record — which is what stamps a fresh sigDate on submit.
  const [consentTouched, setConsentTouched] = useState(false);
  const [agree, setAgree] = useState<Partial<AgreementInfo>>(
    recorded?.agreement ?? { sigName: "", sigDate: "", termsAccepted: false, electronicConsentAccepted: false }
  );
  const [saving, setSaving] = useState(false);
  // Adyen wouldn't hand back an onboarding link. Its own rejection of the data
  // is a different thing (fieldErrors) — this is only ever "our side broke".
  const [submitted, setSubmitted] = useState(false);
  const [savedEdit, setSavedEdit] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Same validator the Server Action gates on, so the customer sees exactly
  // what would have been rejected — before any round trip. Live after the first
  // submit attempt: flagging empty boxes before they've tried is scolding, and
  // a message that outlives its fix is a lie.
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<OnboardingFieldErrors>({});
  // Exactly what gets submitted, so the consent the validator sees is the
  // consent the server will see — a replay of recorded consent included.
  const submittedAgreement = useMemo(
    () => agreementToSubmit(recorded, agree as AgreementInfo, consentTouched),
    [recorded, agree, consentTouched]
  );
  const liveErrors = useMemo(
    () => validateOnboardingSubmission({ business: biz, ownerContact: owner, agreement: submittedAgreement }),
    [biz, owner, submittedAgreement]
  );
  const fieldErrors: OnboardingFieldErrors = attempted ? { ...serverErrors, ...liveErrors } : {};

  const b = <T extends Record<string, unknown>>(setter: (fn: (prev: T) => T) => void) =>
    (k: keyof T) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setter((prev: T) => ({ ...prev, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value } as T));

  const setBizF  = b<Partial<BusinessInfo>>(setBiz as Parameters<typeof b>[0]);
  const setOwnerF = b<Partial<OwnerContact>>(setOwner as Parameters<typeof b>[0]);
  const setProcF = b<Partial<ProcessingInfo>>(setProc as Parameters<typeof b>[0]);
  const setAgreeBase = b<Partial<AgreementInfo>>(setAgree as Parameters<typeof b>[0]);
  const setAgreeF = (k: keyof AgreementInfo) => {
    const base = setAgreeBase(k);
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setConsentTouched(true);
      base(e);
    };
  };

  const handleSubmit = async () => {
    setAttempted(true);
    // Cleared first so a retry from the failed screen always lands back on the
    // form, where any message it produces is actually visible.
    setSubmitted(false);
    // Adyen rejects the legal entity without a complete, well-formed registered
    // address, and AIO won't hand a merchant over without their own consent, so
    // block here rather than sending it and swallowing the 422. The Server
    // Action re-runs the same rules — this copy is only for the customer's
    // benefit, it is not the gate.
    if (Object.keys(liveErrors).length) {
      setServerErrors({});
      setErr("Please correct the highlighted fields above before submitting.");
      return;
    }
    setSaving(true);
    setErr(null);
    setServerErrors({});
    try {
      const fields = {
        business: biz as BusinessInfo,
        ownerContact: owner as OwnerContact,
        processing: proc as ProcessingInfo,
        // Untouched recorded consent goes back verbatim — its date is a fact
        // about when consent was given, not something an edit gets to rewrite.
        agreement: submittedAgreement,
      };

      if (isEditing) {
        const edited = await updateMyApplicationDetailsAction(app.id, fields);
        setSaving(false);
        if (edited.fieldErrors) {
          setServerErrors(edited.fieldErrors);
          setErr("Please correct the highlighted fields above before submitting.");
          return;
        }
        setSavedEdit(true);
        return;
      }

      const result = await saveMyApplicationOnboardingAction(app.id, fields);
      // Saved either way, and there is nothing to redirect to: verification
      // starts after billing, not here. A field error is the customer's to
      // fix; everything else lands on the "details received" screen.
      if (result.fieldErrors) {
        setServerErrors(result.fieldErrors);
        setErr("Please correct the highlighted fields above before submitting.");
      } else {
        setSubmitted(true);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
    setSaving(false);
  };

  // The hint marks a value the customer didn't type, and disappears the moment
  // they change it — a stale "pre-filled" on their own edit would be a lie.
  const isPrefilled = (path: string, val: string) =>
    prefilled.has(path) && val.trim() === (initialValues[path] ?? "").trim();

  const fieldLabel = (label: string, path: string, val: string) => (
    <label className={styles.label}>
      {label}
      {isPrefilled(path, val) && <span className={styles.prefilled}>pre-filled</span>}
    </label>
  );

  const input = (label: string, path: string, val: string, onChange: (e: React.ChangeEvent<HTMLInputElement>) => void, placeholder = "", type = "text") => {
    const fieldErr = fieldErrors[path];
    return (
      <div className={styles.field}>
        {fieldLabel(label, path, val)}
        <input
          type={type}
          value={val}
          onChange={onChange}
          placeholder={placeholder}
          className={fieldErr ? `${styles.input} ${styles.inputError}` : styles.input}
          aria-invalid={fieldErr ? true : undefined}
          aria-describedby={fieldErr ? `${path}-error` : undefined}
        />
        {fieldErr && <p id={`${path}-error`} className={styles.fieldError}>{fieldErr}</p>}
      </div>
    );
  };

  if (savedEdit) {
    return (
      <div className={styles.successWrap}>
        <div className={styles.successIcon}>✓</div>
        <h1 className={styles.successTitle}>Changes Saved</h1>
        <p className={styles.successBody}>
          Your updated information has been saved.
        </p>
        <button
          onClick={() => router.push(`/customer/applications/${app.id}`)}
          className={styles.btnPrimary}
        >
          Back to Overview
        </button>
      </div>
    );
  }

  // First submission. There is deliberately nothing to click through to:
  // identity verification can't start until billing is paid, because the Adyen
  // account is created by AIO's platform at that point. Saying so plainly beats
  // a success screen that implies the next step is available now.
  if (submitted) {
    return (
      <div className={styles.successWrap}>
        <div className={styles.successIcon}>✓</div>
        <h1 className={styles.successTitle}>Details Received</h1>
        <p className={styles.successBody}>
          <strong>Thanks — we have everything we need for now.</strong> Once your billing is set up,
          we&apos;ll create your payment processing account and send you on to identity verification.
          There&apos;s nothing else for you to do right now.
        </p>
        <div className={styles.actionsCentered}>
          <button
            onClick={() => router.push(`/customer/applications/${app.id}`)}
            className={styles.btnPrimary}
          >
            Back to My Application
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>
        {isEditing ? "Edit Your Application" : "Complete Your Application"}
      </h1>
      <p className={styles.pageSubtitle}>
        Fill in the details below to continue onboarding. SSN, bank account, and EIN are collected securely by Adyen directly — AIO never touches that data.
      </p>
      {prefilled.size > 0 && (
        <p className={styles.prefillNote}>
          Some fields are already filled in from what we have on file for you — they&apos;re marked
          &ldquo;pre-filled&rdquo;. Please check each one and correct anything that&apos;s wrong; this
          is the information we submit on your behalf.
        </p>
      )}

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Business Information</h2>
        <div className={styles.grid2}>
          {input("Legal Business Name", "business.legalName", biz.legalName || "", setBizF("legalName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("DBA (Doing Business As)", "business.dba", biz.dba || "", setBizF("dba") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={styles.row}>
          {fieldLabel("Business Type", "business.bizType", biz.bizType || "llc")}
          <select value={biz.bizType || "llc"} onChange={setBizF("bizType") as (e: React.ChangeEvent<HTMLSelectElement>) => void} className={styles.input}>
            {(["llc", "corp", "s-corp", "sole-prop", "partnership", "non-profit"] as const).map(t => (
              <option key={t} value={t}>{t.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase())}</option>
            ))}
          </select>
        </div>
        <div className={styles.row}>
          {input("Street Address", "business.address", biz.address || "", setBizF("address") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("City", "business.city", biz.city || "", setBizF("city") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("State", "business.state", biz.state || "", setBizF("state") as (e: React.ChangeEvent<HTMLInputElement>) => void, "CA")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("ZIP", "business.zip", biz.zip || "", setBizF("zip") as (e: React.ChangeEvent<HTMLInputElement>) => void, "90210")}
          {input("Business Phone", "business.phone", biz.phone || "", setBizF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("Website", "business.website", biz.website || "", setBizF("website") as (e: React.ChangeEvent<HTMLInputElement>) => void, "https://")}
          {input("Years in Business", "business.yearsInBusiness", biz.yearsInBusiness || "", setBizF("yearsInBusiness") as (e: React.ChangeEvent<HTMLInputElement>) => void, "5")}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Owner Contact</h2>
        <p className={styles.hint}>Contact info only — no SSN, DOB, or ID numbers.</p>
        <div className={styles.grid2}>
          {input("First Name", "ownerContact.firstName", owner.firstName || "", setOwnerF("firstName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("Last Name", "ownerContact.lastName", owner.lastName || "", setOwnerF("lastName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("Title", "ownerContact.title", owner.title || "", setOwnerF("title") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Owner")}
          {input("Email", "ownerContact.email", owner.email || "", setOwnerF("email") as (e: React.ChangeEvent<HTMLInputElement>) => void, "owner@business.com", "email")}
        </div>
        <div className={styles.row}>
          {input("Phone", "ownerContact.phone", owner.phone || "", setOwnerF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Processing Details</h2>
        <div className={styles.grid2}>
          {input("Monthly Volume ($)", "processing.monthlyVolume", proc.monthlyVolume || "", setProcF("monthlyVolume") as (e: React.ChangeEvent<HTMLInputElement>) => void, "100000", "number")}
          {input("Average Ticket ($)", "processing.avgTicket", proc.avgTicket || "", setProcF("avgTicket") as (e: React.ChangeEvent<HTMLInputElement>) => void, "45", "number")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("Card Present % (0-100)", "processing.cardPresentPct", proc.cardPresentPct || "", setProcF("cardPresentPct") as (e: React.ChangeEvent<HTMLInputElement>) => void, "80", "number")}
          {input("MCC Code", "processing.mcc", proc.mcc || "", setProcF("mcc") as (e: React.ChangeEvent<HTMLInputElement>) => void, "5812")}
        </div>
        <div className={styles.row}>
          {input("Current Processor", "processing.currentProcessor", proc.currentProcessor || "", setProcF("currentProcessor") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Stripe")}
        </div>
        <div className={styles.row}>
          {fieldLabel("Business Description", "processing.businessDescription", proc.businessDescription || "")}
          <textarea value={proc.businessDescription || ""} onChange={setProcF("businessDescription") as (e: React.ChangeEvent<HTMLTextAreaElement>) => void} placeholder="Briefly describe the nature of the business..." className={`${styles.input} ${styles.textarea}`} />
        </div>
        <div className={`${styles.inlineRow} ${styles.row}`}>
          <div className={styles.field}>
            {fieldLabel("Previously Terminated?", "processing.previouslyTerminated", proc.previouslyTerminated || "no")}
            <select value={proc.previouslyTerminated || "no"} onChange={setProcF("previouslyTerminated") as (e: React.ChangeEvent<HTMLSelectElement>) => void} className={`${styles.input} ${styles.selectInline}`}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div className={styles.field}>
            {fieldLabel("Bankruptcy (Past 5yr)?", "processing.bankruptcy", proc.bankruptcy || "no")}
            <select value={proc.bankruptcy || "no"} onChange={setProcF("bankruptcy") as (e: React.ChangeEvent<HTMLSelectElement>) => void} className={`${styles.input} ${styles.selectInline}`}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Authorization &amp; Agreement</h2>
        {recorded && !reviewingConsent ? (
          // Consent on record: stated as fact, not re-demanded. The affordance
          // below keeps it amendable — consent must never be a one-way door.
          <div className={styles.consentRecord}>
            <p className={styles.consentRecordText}>
              <span className={styles.consentRecordMark} aria-hidden="true">✓</span>
              {recorded.dateLabel
                ? `You accepted the terms and consented to electronic records on ${recorded.dateLabel}.`
                : "You have already accepted the terms and consented to electronic records."}
              {recorded.agreement.sigName.trim() && ` Signed by ${recorded.agreement.sigName.trim()}.`}
            </p>
            <button type="button" className={styles.linkBtn} onClick={() => setReviewingConsent(true)}>
              Review or change this
            </button>
          </div>
        ) : (
          <>
            {recorded && (
              <p className={styles.hint}>
                This is the consent already on file. Change anything here and it&apos;s re-recorded,
                dated today; untick a box to withdraw it.
              </p>
            )}
            {/* Not pre-filled — with no consent on record, the signatory and both consents are given here, on this visit. */}
            {input("Authorized Signatory Name", "agreement.sigName", agree.sigName || "", setAgreeF("sigName") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Jane Doe")}
            <div className={styles.checkboxGroup}>
              <label className={styles.checkboxRow}>
                <input type="checkbox" checked={agree.termsAccepted || false} onChange={setAgreeF("termsAccepted") as (e: React.ChangeEvent<HTMLInputElement>) => void} className={styles.checkbox} />
                <span className={styles.checkboxText}>
                  I certify that the information provided is accurate and authorize AIO to process payments for this business and to initiate onboarding with our processing partner.
                </span>
              </label>
              <label className={styles.checkboxRow}>
                <input type="checkbox" checked={agree.electronicConsentAccepted || false} onChange={setAgreeF("electronicConsentAccepted") as (e: React.ChangeEvent<HTMLInputElement>) => void} className={styles.checkbox} />
                <span className={styles.checkboxText}>
                  I consent to electronic communications and agree that electronic records are legally binding. I understand that identity verification will be completed by me directly via secure Adyen-hosted forms.
                </span>
              </label>
            </div>
          </>
        )}
        {/* Consent is the one requirement with no input of its own to sit under,
            so it gets its message here — a rejection the customer can't see is
            the same dead end as no rejection at all. */}
        {fieldErrors["agreement.consent"] && (
          <p className={styles.fieldError}>{fieldErrors["agreement.consent"]}</p>
        )}
      </div>

      {err && (
        <div className={styles.errorBanner}>
          {err}
        </div>
      )}

      <button
        className={styles.btnPrimary}
        disabled={saving}
        onClick={handleSubmit}
      >
        {saving ? "Saving…" : isEditing ? "Save Changes" : "Submit →"}
      </button>
    </div>
  );
}
