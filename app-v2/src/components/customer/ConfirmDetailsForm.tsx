"use client";

import { useMemo, useState } from "react";
import { confirmLeadDetailsAction } from "@/lib/actions/leadConfirm";
import { confirmationErrors, missingConfirmationFields, FIELD_LABELS } from "@/lib/leadConfirm";
import { fmt$0 } from "@/lib/utils";
import type { OnboardingFieldErrors } from "@/lib/onboardingValidation";
import { bizTypeLabel } from "@/types/merchant";
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

  // Which boxes the merchant has actually left. A field goes red when they
  // leave it wrong, never on first paint: the form opens mostly pre-filled and
  // painting every empty box red before they have touched anything is
  // scolding. The "still needed" summary under the button is what explains the
  // disabled state in the meantime.
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [serverErrors, setServerErrors] = useState<OnboardingFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // EXACTLY what will be posted, so the browser's verdict and the server's
  // cannot differ. Both of these mirror `buildValues` below: an un-ticked
  // "different operating address" means those four are blank whatever stale
  // values the inputs still hold, and "same as the owner" means there is no
  // separate billing contact — which is an answer, not an omission.
  const pending = useMemo(() => ({
    business: separateOperating
      ? biz
      : { ...biz, dbaAddress: "", dbaCity: "", dbaState: "", dbaZip: "" },
    ownerContact: owner,
    billingContact: sameAsOwner ? null : billing,
    processing: proc,
  }), [biz, owner, billing, proc, separateOperating, sameAsOwner]);

  // Same validator the Server Action gates on, so the merchant sees exactly
  // what would be rejected before any round trip.
  const liveErrors = useMemo(() => confirmationErrors(pending), [pending]);
  const stillNeeded = useMemo(() => missingConfirmationFields(pending), [pending]);
  const complete = stillNeeded.length === 0;

  const fieldErrors: OnboardingFieldErrors = Object.fromEntries(
    Object.entries({ ...serverErrors, ...liveErrors }).filter(([path]) => touched[path] || serverErrors[path])
  );

  // Whether a path has a box on screen that can show its error right now. The
  // operating address and billing contact are hidden behind their checkboxes,
  // and the entity-type select renders no error line. Anything else the server
  // refuses — a path with no box at all — is named in the banner instead, so
  // "the highlighted fields" is never a sentence pointing at nothing.
  const hasVisibleBox = (path: string) => {
    if (path.startsWith("business.dba") && path !== "business.dba") return separateOperating;
    if (path.startsWith("billingContact.")) return !sameAsOwner;
    return path in FIELD_LABELS;
  };
  const unseenServerErrors = Object.entries(serverErrors).filter(
    ([path]) => path === "business.bizType" || !hasVisibleBox(path)
  );
  const bannerText = unseenServerErrors.length > 0 && unseenServerErrors.length === Object.keys(serverErrors).length
    ? "Please fix the following, then continue:"
    : err;

  const b = <T extends Record<string, unknown>>(setter: (fn: (prev: T) => T) => void) =>
    (k: keyof T) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setter((prev: T) => ({ ...prev, [k]: e.target.value } as T));

  const setBizF = b<Partial<BusinessInfo>>(setBiz as Parameters<typeof b>[0]);
  const setOwnerF = b<Partial<OwnerContact>>(setOwner as Parameters<typeof b>[0]);
  const setProcF = b<Partial<ProcessingInfo>>(setProc as Parameters<typeof b>[0]);
  const setBillingF = b<Partial<OwnerContact>>(setBilling as Parameters<typeof b>[0]);

  const markTouched = (path: string) => () => setTouched(t => (t[path] ? t : { ...t, [path]: true }));

  // The label comes from FIELD_LABELS, not from the call site, so the box a
  // merchant is looking at and the name the "still needed" list gives it are
  // the same string by construction.
  const input = (
    path: string,
    val: string,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void,
    placeholder = "",
  ) => {
    const fieldErr = fieldErrors[path];
    return (
      <div className={styles.field}>
        <label className={styles.label}>{FIELD_LABELS[path] ?? path}</label>
        <input
          type="text"
          value={val}
          onChange={onChange}
          onBlur={markTouched(path)}
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
    setErr(null);
    // Unreachable through the UI — the button that opens the confirmation
    // panel is disabled while anything is outstanding. Kept because the
    // server re-validates regardless and a silent no-op here would be worse
    // than a sentence; every field is marked touched so the boxes turn red
    // rather than the merchant hunting for what moved.
    if (Object.keys(liveErrors).length) {
      setTouched(Object.fromEntries(Object.keys(liveErrors).map(k => [k, true])));
      setServerErrors({});
      setErr("Please correct the highlighted fields above, then continue.");
      return;
    }
    setSaving(true);
    setServerErrors({});
    try {
      const result = await confirmLeadDetailsAction(token, buildValues());
      if (!result.ok) {
          if ("errors" in result) {
          setServerErrors(result.errors);
          setErr("Please correct the highlighted fields above, then continue.");
        } else {
          setErr(result.formError);
        }
        setSaving(false);
        return;
      }

      const res = await fetch(`/api/lead/${token}/checkout`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        // Back to the quote, straight to its two documents — the subscription
        // to sign and pay, and the invoice beside it (product owner,
        // 2026-10-23: one place, not a surprise second tab). Deliberately
        // leaves `saving` set — the page is navigating away, and re-enabling
        // the button would invite a second click mid-redirect.
        window.location.href = `/lead/${token}/quote#documents`;
        return;
      }

      // A rate-only quote builds no HubSpot document at all, so there is
      // nothing to redirect to and the confirmation is the whole of what the
      // merchant had to do here. Their accept button lives on the quote page.
      if (data.error === "rate_only") {
        window.location.href = `/lead/${token}/quote`;
        return;
      }

      setSaving(false);
      setErr(
        "Your details are saved, but we couldn't open your quote just now. Please try again in a moment — your AIO representative has been notified."
      );
    } catch {
      setSaving(false);
      setErr("Something went wrong saving your details. Please try again.");
    }
  };

  return (
    <div className={styles.page}>
      {/* Building the quote is several HubSpot round trips — contact, line
          items, the quote, its associations, the publish — and takes long
          enough that a button label alone reads as a hang. Kept up through the
          redirect, since `saving` deliberately stays set while navigating. */}
      {saving && (
        <div className={confirmStyles.overlay} role="status" aria-live="polite">
          <div className={confirmStyles.overlayCard}>
            <span className={confirmStyles.overlaySpinner} aria-hidden="true" />
            <strong className={confirmStyles.overlayTitle}>Creating your quote…</strong>
            <p className={confirmStyles.overlayBody}>
              This usually takes under a minute. Please keep this page open — you&apos;ll be taken to
              your quote automatically.
            </p>
          </div>
        </div>
      )}
      <h1 className={styles.pageTitle}>
        {businessName ? `${businessName}, please check your details` : "Please check your details"}
      </h1>
      <p className={styles.pageSubtitle}>
        This is what we have on file. Please correct anything that&apos;s wrong. SSN and bank details are never collected on this page;
        your payment processor asks for those separately on their own secure site.
      </p>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Your Business</h2>
        <div className={styles.grid2}>
          {input("business.dba", biz.dba || "", setBizF("dba") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("business.legalName", biz.legalName || "", setBizF("legalName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
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
                <option key={t} value={t}>{bizTypeLabel(t)}</option>
              ))}
            </select>
          </div>
          {input("business.ein", biz.ein || "", setBizF("ein") as (e: React.ChangeEvent<HTMLInputElement>) => void, "12-3456789")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("business.phone", biz.phone || "", setBizF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
          {input("business.website", biz.website || "", setBizF("website") as (e: React.ChangeEvent<HTMLInputElement>) => void, "yourrestaurant.com")}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Legal Address</h2>
        <p className={styles.hint}>The address your business is registered under with the government.</p>
        <div className={styles.row}>
          {input("business.address", biz.address || "", setBizF("address") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("business.city", biz.city || "", setBizF("city") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("business.state", biz.state || "", setBizF("state") as (e: React.ChangeEvent<HTMLInputElement>) => void, "CA")}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("business.zip", biz.zip || "", setBizF("zip") as (e: React.ChangeEvent<HTMLInputElement>) => void, "90210")}
        </div>

        <label className={`${styles.checkboxRow} ${styles.row}`}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={separateOperating}
            onChange={e => setSeparateOperating(e.target.checked)}
          />
          <span className={styles.checkboxText}>Our DBA address (where we operate) is different from the legal address</span>
        </label>

        {separateOperating && (
          <>
            <div className={styles.row}>
              {input("business.dbaAddress", biz.dbaAddress || "", setBizF("dbaAddress") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("business.dbaCity", biz.dbaCity || "", setBizF("dbaCity") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("business.dbaState", biz.dbaState || "", setBizF("dbaState") as (e: React.ChangeEvent<HTMLInputElement>) => void, "CA")}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("business.dbaZip", biz.dbaZip || "", setBizF("dbaZip") as (e: React.ChangeEvent<HTMLInputElement>) => void, "90210")}
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
          {input("ownerContact.firstName", owner.firstName || "", setOwnerF("firstName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("ownerContact.lastName", owner.lastName || "", setOwnerF("lastName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("ownerContact.title", owner.title || "", setOwnerF("title") as (e: React.ChangeEvent<HTMLInputElement>) => void, "Owner")}
          {input("ownerContact.phone", owner.phone || "", setOwnerF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
        </div>
        <div className={styles.row}>
          {input("ownerContact.email", owner.email || "", setOwnerF("email") as (e: React.ChangeEvent<HTMLInputElement>) => void, "owner@business.com")}
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
              {input("billingContact.firstName", billing.firstName || "", setBillingF("firstName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
              {input("billingContact.lastName", billing.lastName || "", setBillingF("lastName") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {input("billingContact.email", billing.email || "", setBillingF("email") as (e: React.ChangeEvent<HTMLInputElement>) => void, "billing@business.com")}
              {input("billingContact.phone", billing.phone || "", setBillingF("phone") as (e: React.ChangeEvent<HTMLInputElement>) => void, "555-000-0000")}
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
              they don&apos;t look right, let your AIO representative know before you continue.
            </p>
          </>
        )}
        <div className={`${styles.grid2} ${styles.row}`}>
          {input("processing.currentProcessor", proc.currentProcessor || "", setProcF("currentProcessor") as (e: React.ChangeEvent<HTMLInputElement>) => void)}
          {input("processing.mcc", proc.mcc || "", setProcF("mcc") as (e: React.ChangeEvent<HTMLInputElement>) => void, "5812")}
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

      {err && (
        <div className={styles.errorBanner} role="alert">
          {bannerText}
          {unseenServerErrors.length > 0 && (
            <ul className={confirmStyles.bannerList}>
              {unseenServerErrors.map(([path, message]) => <li key={path}>{message}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* A plain Continue. The details are saved and the quote is built in
          one go; the overlay above carries the "this takes a while" notice. */}
      {(
        <>
          {/* EVERYTHING ON THIS FORM IS REQUIRED (2026-10-15, product owner),
              so the button is dead until it is. A dead button with no reason
              is the standing failure of forms that validate only on submit,
              and this one cannot even be submitted to find out — hence the
              list. It names what is outstanding in the order the form asks
              for it, qualified by panel, because this page asks for a city
              twice and a first name twice. */}
          {!complete && (
            <div className={confirmStyles.stillNeeded}>
              <strong className={confirmStyles.stillNeededTitle}>
                {stillNeeded.length} {stillNeeded.length === 1 ? "thing" : "things"} still needed
              </strong>
              <ul className={confirmStyles.stillNeededList}>
                {stillNeeded.map(label => <li key={label}>{label}</li>)}
              </ul>
            </div>
          )}
          <div className={styles.actions}>
            <button
              onClick={handleConfirm}
              disabled={saving || !complete}
              className={styles.btnPrimary}
            >
              {saving ? "Creating your quote…" : "Continue"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
