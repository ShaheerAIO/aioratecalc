"use client";

import { useMemo, useState } from "react";
import { confirmLeadDetailsAction } from "@/lib/actions/leadConfirm";
import { confirmationErrors } from "@/lib/leadConfirm";
import { fmt$0 } from "@/lib/utils";
import type { OnboardingFieldErrors } from "@/lib/onboardingValidation";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";
import styles from "./CustomerOnboardStep.module.css";
import confirmStyles from "./ConfirmDetailsForm.module.css";

export type ConfirmDetailsInitial = {
  business: Partial<BusinessInfo>;
  ownerContact: Partial<OwnerContact>;
  billingContact: Partial<OwnerContact> | null;
  processing: Partial<ProcessingInfo>;
};

type Props = {
  token: string;
  initial: ConfirmDetailsInitial;
  businessName: string | null;
  /** Shown locked beside the editable fields — see the pricing note below. */
  monthlyVolume: number | null;
  avgTicket: number | null;
};

// The merchant's confirmation of their own details — the step that builds the
// HubSpot quote.
//
// Deliberately reuses CustomerOnboardStep.module.css rather than growing a
// third form idiom: this is the same merchant filling in the same kinds of
// boxes, and the only thing genuinely new here is the locked pricing readout
// and the confirm panel, which is what ConfirmDetailsForm.module.css holds.
//
// WHAT IS LOCKED AND WHY. Monthly volume and average ticket are shown but not
// editable. They are the pricing basis — the rep's own form derives
// `quoteConfig` straight out of them, and they drive the rate matrix, the
// margin floor and the $10/month revenue floor. Letting the merchant change
// them here would re-price a quote the rep has already cleared both floors on,
// seconds before it is published irreversibly. Showing them anyway is the
// point: the merchant can see what their quote was priced on, and the rep can
// still change it, because nothing is published until this form is submitted.
export default function ConfirmDetailsForm({ token, initial, businessName, monthlyVolume, avgTicket }: Props) {
  const [biz, setBiz] = useState<Partial<BusinessInfo>>(initial.business);
  const [owner, setOwner] = useState<Partial<OwnerContact>>(initial.ownerContact);
  const [proc, setProc] = useState<Partial<ProcessingInfo>>(initial.processing);
  // "They bill the owner" is the common case and the default, so the billing
  // grid starts collapsed unless the rep already entered someone different.
  const [sameAsOwner, setSameAsOwner] = useState(() => !initial.billingContact?.email?.trim());
  const [billing, setBilling] = useState<Partial<OwnerContact>>(initial.billingContact ?? {});
  // A separate operating address is the exception; blank means "same as the
  // legal address" and every consumer falls back (see `locationAddress`).
  const [separateOperating, setSeparateOperating] = useState(() => Boolean(initial.business.dbaAddress?.trim()));

  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<OnboardingFieldErrors>({});
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Same validator the Server Action gates on, so the merchant sees exactly
  // what would be rejected before any round trip. Live only after the first
  // submit attempt: flagging empty boxes before they've tried is scolding.
  const liveErrors = useMemo(
    () => confirmationErrors({ business: biz, ownerContact: owner }),
    [biz, owner]
  );
  const fieldErrors: OnboardingFieldErrors = attempted ? { ...serverErrors, ...liveErrors } : {};

  const b = <T extends Record<string, unknown>>(setter: (fn: (prev: T) => T) => void) =>
    (k: keyof T) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setter((prev: T) => ({ ...prev, [k]: e.target.value } as T));

  const setBizF = b<Partial<BusinessInfo>>(setBiz as Parameters<typeof b>[0]);
  const setOwnerF = b<Partial<OwnerContact>>(setOwner as Parameters<typeof b>[0]);
  const setProcF = b<Partial<ProcessingInfo>>(setProc as Parameters<typeof b>[0]);
  const setBillingF = b<Partial<OwnerContact>>(setBilling as Parameters<typeof b>[0]);

  const input = (
    label: string,
    path: string,
    val: string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void,
    placeholder = "",
  ) => {
    const fieldErr = fieldErrors[path];
    return (
      <div className={styles.field}>
        <label className={styles.label}>{label}</label>
        <input
          type="text"
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

  const locked = (label: string, value: string) => (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <div className={confirmStyles.lockedValue}>{value}</div>
    </div>
  );

  // Everything the allow-list accepts, flattened to the dotted paths
  // `applyLeadConfirmation` keys on. An unticked "separate operating address"
  // sends blanks for all four parts, which is how a merchant REMOVES one the
  // rep entered by mistake — the whole DBA address stays optional, and a blank
  // street means "same as the legal address".
  const buildValues = (): Record<string, string> => {
    const dba = separateOperating
      ? {
          "business.dbaAddress": biz.dbaAddress ?? "",
          "business.dbaCity": biz.dbaCity ?? "",
          "business.dbaState": biz.dbaState ?? "",
          "business.dbaZip": biz.dbaZip ?? "",
        }
      : {
          "business.dbaAddress": "",
          "business.dbaCity": "",
          "business.dbaState": "",
          "business.dbaZip": "",
        };

    // "Same as owner" posts blanks rather than a copy of the owner: the action
    // reads an all-blank billing contact as null, which is how the rest of the
    // codebase says "bill the owner". Copying would create a second contact
    // record in HubSpot for the same person.
    const billingValues = sameAsOwner
      ? {
          "billingContact.firstName": "",
          "billingContact.lastName": "",
          "billingContact.email": "",
          "billingContact.phone": "",
        }
      : {
          "billingContact.firstName": billing.firstName ?? "",
          "billingContact.lastName": billing.lastName ?? "",
          "billingContact.email": billing.email ?? "",
          "billingContact.phone": billing.phone ?? "",
        };

    return {
      "business.legalName": biz.legalName ?? "",
      "business.bizType": biz.bizType ?? "",
      "business.address": biz.address ?? "",
      "business.city": biz.city ?? "",
      "business.state": biz.state ?? "",
      "business.zip": biz.zip ?? "",
      ...dba,
      "business.dba": biz.dba ?? "",
      "business.phone": biz.phone ?? "",
      "business.website": biz.website ?? "",
      "business.yearsInBusiness": biz.yearsInBusiness ?? "",
      "business.ein": biz.ein ?? "",
      "ownerContact.firstName": owner.firstName ?? "",
      "ownerContact.lastName": owner.lastName ?? "",
      "ownerContact.title": owner.title ?? "",
      "ownerContact.email": owner.email ?? "",
      "ownerContact.phone": owner.phone ?? "",
      ...billingValues,
      "processing.mcc": proc.mcc ?? "",
      "processing.currentProcessor": proc.currentProcessor ?? "",
      "processing.previouslyTerminated": proc.previouslyTerminated ?? "no",
      "processing.bankruptcy": proc.bankruptcy ?? "no",
    };
  };

  // Two steps, each idempotent, and deliberately not merged. The action saves
  // the details and stamps the confirmation; the checkout route is the single
  // build-and-publish door every other entry point already shares, with its own
  // build claim, its own idempotency and its own merchant-safe error
  // vocabulary. Reimplementing any of that here would be a second door.
  const handleConfirm = async () => {
    setAttempted(true);
    setErr(null);
    if (Object.keys(liveErrors).length) {
      setServerErrors({});
      setConfirming(false);
      setErr("Please correct the highlighted fields above, then confirm.");
      return;
    }
    setSaving(true);
    setServerErrors({});
    try {
      const result = await confirmLeadDetailsAction(token, buildValues());
      if (!result.ok) {
        setConfirming(false);
        if ("errors" in result) {
          setServerErrors(result.errors);
          setErr("Please correct the highlighted fields above, then confirm.");
        } else {
          setErr(result.formError);
        }
        setSaving(false);
        return;
      }

      const res = await fetch(`/api/lead/${token}/checkout`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        // Deliberately leaves `saving` set — the page is navigating away, and
        // re-enabling the button would invite a second click mid-redirect.
        window.location.href = data.url;
        return;
      }

      // A rate-only quote builds no HubSpot document at all, so there is
      // nothing to redirect to and the confirmation is the whole of what the
      // merchant had to do here. Their accept button lives on the quote page.
      if (data.error === "rate_only") {
        window.location.href = `/lead/${token}/quote`;
        return;
      }

      setConfirming(false);
      setSaving(false);
      setErr(
        "Your details are saved, but we couldn't open your quote just now. Please try again in a moment — your AIO representative has been notified."
      );
    } catch {
      setConfirming(false);
      setSaving(false);
      setErr("Something went wrong saving your details. Please try again.");
    }
  };

  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>
        {businessName ? `${businessName}, please check your details` : "Please check your details"}
      </h1>
      <p className={styles.pageSubtitle}>
        This is what we have on file. Correct anything that&apos;s wrong — it goes on your quote and
        your account exactly as it reads here. SSN and bank details are never collected on this page;
        your payment processor asks for those separately on their own secure site.
      </p>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Your Business</h2>
        <div className={styles.grid2}>
          {input("Legal business name, as registered", "business.legalName", biz.legalName || "", setBizF("legalName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("Trading name (DBA)", "business.dba", biz.dba || "", setBizF("dba") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          <div className={styles.field}>
            <label className={styles.label}>Entity type</label>
            <select
              value={biz.bizType || ""}
              onChange={setBizF("bizType") as (e: React.ChangeEvent<HTMLSelectElement>) => void}
              className={styles.input}
            >
              <option value="">Select…</option>
              {(["llc", "corp", "s-corp", "sole-prop", "partnership", "non-profit"] as const).map(t => (
                <option key={t} value={t}>{t.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase())}</option>
              ))}
            </select>
          </div>
          {input("Federal EIN", "business.ein", biz.ein || "", setBizF("ein") as (e: React.ChangeEvent<HTMLInputElement>) => void, "12-3456789")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("Business phone", "business.phone", biz.phone || "", setBizF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
          {input("Website", "business.website", biz.website || "", setBizF("website") as (e: React.ChangeEvent<HTMLInputElement>) => void, "yourrestaurant.com")}
        </div>
        <div className={styles.row}>
          {input("Years open", "business.yearsInBusiness", biz.yearsInBusiness || "", setBizF("yearsInBusiness") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Registered Address</h2>
        <p className={styles.hint}>The address your business is registered under with the government.</p>
        <div className={styles.row}>
          {input("Street address", "business.address", biz.address || "", setBizF("address") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("City", "business.city", biz.city || "", setBizF("city") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("State", "business.state", biz.state || "", setBizF("state") as (e: React.ChangeEvent<HTMLInputElement>) => void, "CA")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("ZIP", "business.zip", biz.zip || "", setBizF("zip") as (e: React.ChangeEvent<HTMLInputElement>) => void, "90210")}
        </div>

        <label className={`${styles.checkboxRow} ${styles.row}`}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={separateOperating}
            onChange={e => setSeparateOperating(e.target.checked)}
          />
          <span className={styles.checkboxText}>We operate from a different address</span>
        </label>

        {separateOperating && (
          <>
            <div className={styles.row}>
              {input("Operating street address", "business.dbaAddress", biz.dbaAddress || "", setBizF("dbaAddress") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("City", "business.dbaCity", biz.dbaCity || "", setBizF("dbaCity") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("State", "business.dbaState", biz.dbaState || "", setBizF("dbaState") as (e: React.ChangeEvent<HTMLInputElement>) => void, "CA")}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("ZIP", "business.dbaZip", biz.dbaZip || "", setBizF("dbaZip") as (e: React.ChangeEvent<HTMLInputElement>) => void, "90210")}
            </div>
          </>
        )}
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Owner &amp; Signer</h2>
        <p className={styles.hint}>
          Whoever is authorised to sign for the business — your quote is sent to this address for
          signature.
        </p>
        <div className={styles.grid2}>
          {input("First name", "ownerContact.firstName", owner.firstName || "", setOwnerF("firstName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("Last name", "ownerContact.lastName", owner.lastName || "", setOwnerF("lastName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("Title", "ownerContact.title", owner.title || "", setOwnerF("title") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Owner")}
          {input("Mobile", "ownerContact.phone", owner.phone || "", setOwnerF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
        </div>
        <div className={styles.row}>
          {input("Email", "ownerContact.email", owner.email || "", setOwnerF("email") as (e: React.ChangeEvent<HTMLInputElement>) => void, "owner@business.com")}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Billing Contact</h2>
        <p className={styles.hint}>Where your invoices are emailed.</p>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={sameAsOwner}
            onChange={e => setSameAsOwner(e.target.checked)}
          />
          <span className={styles.checkboxText}>Same as the owner above</span>
        </label>
        {!sameAsOwner && (
          <>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("First name", "billingContact.firstName", billing.firstName || "", setBillingF("firstName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("Last name", "billingContact.lastName", billing.lastName || "", setBillingF("lastName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("Email", "billingContact.email", billing.email || "", setBillingF("email") as (e: React.ChangeEvent<HTMLInputElement>) => void, "billing@business.com")}
              {input("Phone", "billingContact.phone", billing.phone || "", setBillingF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
            </div>
          </>
        )}
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Card Processing</h2>
        {(monthlyVolume !== null || avgTicket !== null) && (
          <>
            <div className={styles.grid2}>
              {monthlyVolume !== null && locked("Monthly card volume", fmt$0(monthlyVolume))}
              {avgTicket !== null && locked("Average ticket", fmt$0(avgTicket))}
            </div>
            <p className={`${styles.hint} ${styles.row}`}>
              Your rates were worked out from these figures, so they can&apos;t be changed here. If
              they don&apos;t look right, contact your AIO representative before confirming — they can
              still update your quote.
            </p>
          </>
        )}
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("Current processor", "processing.currentProcessor", proc.currentProcessor || "", setProcF("currentProcessor") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("Merchant category code", "processing.mcc", proc.mcc || "", setProcF("mcc") as (e: React.ChangeEvent<HTMLInputElement>) => void, "5812")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          <div className={styles.field}>
            <label className={styles.label}>Previously terminated by a processor?</label>
            <select
              value={proc.previouslyTerminated || "no"}
              onChange={setProcF("previouslyTerminated") as (e: React.ChangeEvent<HTMLSelectElement>) => void}
              className={styles.input}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Filed for bankruptcy?</label>
            <select
              value={proc.bankruptcy || "no"}
              onChange={setProcF("bankruptcy") as (e: React.ChangeEvent<HTMLSelectElement>) => void}
              className={styles.input}
            >
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>
        </div>
      </div>

      {err && <p className={styles.errorBanner}>{err}</p>}

      {/* The lock, stated before it happens. Phrased around what the MERCHANT
          loses — the chance to have any of this changed — rather than around
          our inability to call an endpoint, which is not their problem. */}
      {confirming ? (
        <div className={confirmStyles.confirmPanel}>
          <h2 className={confirmStyles.confirmTitle}>Ready to lock this in?</h2>
          <p className={confirmStyles.confirmBody}>
            Confirming creates your final quote from the details above. After this, your details and
            your pricing can&apos;t be changed on this quote — we&apos;d have to start a new one.
          </p>
          <p className={confirmStyles.confirmBody}>
            Need something different? Contact your AIO representative first — until you confirm, they
            can still change anything on your quote.
          </p>
          <div className={styles.actions}>
            <button onClick={handleConfirm} disabled={saving} className={styles.btnPrimary}>
              {saving ? "Creating your quote…" : "Yes, confirm and continue"}
            </button>
            <button onClick={() => setConfirming(false)} disabled={saving} className={styles.btnSecondary}>
              Go back
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <button onClick={() => setConfirming(true)} disabled={saving} className={styles.btnPrimary}>
            Confirm &amp; Continue →
          </button>
        </div>
      )}
    </div>
  );
}
