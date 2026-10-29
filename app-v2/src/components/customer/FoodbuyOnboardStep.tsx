"use client";

import { useEffect, useMemo, useState } from "react";
import {
  defaultFoodbuyForm, emptyDirectAgreement, emptyLocation, foodbuyDate, usesSysco, validateFoodbuyForm,
  FOODBUY_MAX_DIRECT_AGREEMENTS, FOODBUY_MAX_LOCATIONS,
} from "@/lib/foodbuyForm";
import type { FoodbuyFormData, MerchantApplication } from "@/types/merchant";
import SignaturePad from "./SignaturePad";
// Deliberately reuses CustomerOnboardStep's stylesheet — same customer-facing
// form design as the Adyen/payroll opt-in steps.
import styles from "./CustomerOnboardStep.module.css";
import fb from "./FoodbuyOnboardStep.module.css";

type Props = { app: MerchantApplication };

// Foodbuy has no API to onboard through: enrollment is Foodbuy's signed
// participation agreement. The customer fills it in here (pre-filled from what
// AIO holds, see lib/foodbuyForm.ts), signs it, reviews the finished PDF the
// server renders (lib/foodbuyPdf.ts), and sends it to the Foodbuy rep set at
// /admin/users, all in this one flow. Sending is its own press after the
// review, never automatic.
const SEND_ERRORS: Record<string, string> = {
  not_configured: "Sending to Foodbuy isn't set up yet. Download the agreement and send it to your AIO representative instead.",
  too_large: "That agreement is too large to email. Download it and send it to your AIO representative instead.",
};
const GENERIC_ERROR = "We couldn't do that just now. Please try again in a minute.";

/** Immutable set of a dotted path like "locations.2.acct". */
function setIn<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const copy = (Array.isArray(obj) ? [...obj] : { ...obj }) as Record<string, unknown>;
  copy[head] = rest.length ? setIn(copy[head], rest.join("."), value) : value;
  return copy as T;
}

export default function FoodbuyOnboardStep({ app }: Props) {
  // Dated on mount, in the customer's own timezone, so the server render and
  // the browser's first render agree.
  const [form, setForm] = useState<FoodbuyFormData>(() => ({ ...defaultFoodbuyForm(app), signedDate: "" }));
  useEffect(() => setForm(f => ({ ...f, signedDate: foodbuyDate() })), []);
  // Errors show only once the customer has tried to review, then live-update.
  const [showErrors, setShowErrors] = useState(false);
  const errors = useMemo(() => validateFoodbuyForm(form), [form]);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const err = (path: string) => (showErrors ? errors[path] ?? serverErrors[path] : undefined);

  const [preview, setPreview] = useState<{ url: string; json: string } | null>(null);
  const [busy, setBusy] = useState<"review" | "send" | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(app.foodbuyIds?.sentAt ?? null);
  const [sentThis, setSentThis] = useState(false);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview.url); }, [preview]);

  const set = (path: string, value: unknown) => {
    setForm(f => setIn(f, path, value));
    setServerErrors({});
  };

  const field = (label: string, path: string, opts: { placeholder?: string; type?: string; optional?: boolean } = {}) => {
    const value = path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], form) as string;
    const e = err(path);
    const id = `fb-${path}`;
    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id}>
          {label}
          {opts.optional && <span className={styles.prefilled}>optional</span>}
        </label>
        <input
          id={id}
          className={`${styles.input} ${e ? styles.inputError : ""}`}
          type={opts.type ?? "text"}
          value={value}
          placeholder={opts.placeholder}
          aria-invalid={!!e}
          onChange={ev => set(path, ev.target.value)}
        />
        {e && <p className={styles.fieldError}>{e}</p>}
      </div>
    );
  };

  const review = async () => {
    setShowErrors(true);
    setBanner(null);
    if (Object.keys(errors).length) {
      setBanner("Some answers are missing or need fixing. They're marked below.");
      requestAnimationFrame(() => document.querySelector("[aria-invalid='true'], [data-invalid='true']")?.scrollIntoView({ block: "center", behavior: "smooth" }));
      return;
    }
    setBusy("review");
    try {
      const json = JSON.stringify(form);
      const res = await fetch(`/api/customer/applications/${encodeURIComponent(app.id)}/foodbuy/preview`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: json,
      });
      if (res.ok) {
        setPreview({ url: URL.createObjectURL(await res.blob()), json });
        setSentThis(false);
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      const data = (await res.json().catch(() => null)) as { errors?: Record<string, string> } | null;
      if (data?.errors) {
        setServerErrors(data.errors);
        setBanner("Some answers are missing or need fixing. They're marked below.");
      } else {
        setBanner(GENERIC_ERROR);
      }
    } catch {
      setBanner(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!preview) return;
    setBusy("send");
    setBanner(null);
    try {
      // Exactly the answers that were previewed; the server renders the same PDF from them.
      const res = await fetch(`/api/customer/applications/${encodeURIComponent(app.id)}/foodbuy/send`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: preview.json,
      });
      const data = (await res.json().catch(() => null)) as { sent?: boolean; sentAt?: string; reason?: string } | null;
      if (data?.sent) {
        setSentAt(data.sentAt ?? new Date().toISOString());
        setSentThis(true);
      } else {
        setBanner(SEND_ERRORS[data?.reason ?? ""] ?? GENERIC_ERROR);
      }
    } catch {
      setBanner(GENERIC_ERROR);
    } finally {
      setBusy(null);
    }
  };

  const fileName = `AIO-Foodbuy-Enrollment-${(form.business.dba || form.business.legalName || "Business").replace(/[^a-zA-Z0-9]/g, "-")}.pdf`;

  // ── Review & send ─────────────────────────────────────────────────────────
  if (preview) {
    return (
      <div className={styles.page}>
        <h1 className={styles.pageTitle}>Review &amp; Send</h1>
        <p className={styles.pageSubtitle}>
          This is your finished Foodbuy participation agreement. Check every page, then send it to Foodbuy.
          Their account executive will contact you directly.
        </p>
        {banner && <div className={styles.errorBanner}>{banner}</div>}
        <iframe className={fb.preview} src={preview.url} title="Foodbuy participation agreement" />
        {sentThis ? (
          <p className={styles.hint}>
            Sent to Foodbuy on {new Date(sentAt!).toLocaleDateString()}. Their account executive will contact you directly.
          </p>
        ) : sentAt ? (
          <p className={styles.hint}>
            You last sent an agreement on {new Date(sentAt).toLocaleDateString()}. Sending this one replaces it.
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="button" className={styles.btnSecondary} onClick={() => setPreview(null)} disabled={busy !== null}>
            ← Edit Answers
          </button>
          <a className={styles.btnSecondary} href={preview.url} download={fileName}>Download PDF</a>
          {!sentThis && (
            <button type="button" className={styles.btnPrimary} onClick={send} disabled={busy !== null}>
              {busy === "send" ? "Sending…" : "Send to Foodbuy →"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── Fill in ───────────────────────────────────────────────────────────────
  const sysco = usesSysco(form);
  return (
    <div className={styles.page}>
      <h1 className={styles.pageTitle}>Set Up Foodbuy</h1>
      <p className={styles.pageSubtitle}>
        Foodbuy enrollment is a participation agreement you complete and sign. We&apos;ve filled in what we
        already know about your business. Check it, add your distributors and account numbers, sign, then
        review the finished agreement and send it to Foodbuy.
      </p>
      {sentAt && (
        <p className={styles.prefillNote}>
          You sent your agreement on {new Date(sentAt).toLocaleDateString()}. To send a corrected copy, update
          your answers, sign again and send.
        </p>
      )}

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Business Information</h2>
        <div className={styles.grid2}>
          {field("Legal entity name", "business.legalName")}
          {field("Federal ID # (EIN)", "business.ein", { placeholder: "12-3456789" })}
          {field("DBA", "business.dba", { optional: true })}
          {field("Type of business", "business.bizType", { placeholder: "e.g. LLC, S-Corp" })}
          {field("Corporate address", "business.address")}
          {field("Suite #", "business.suite", { optional: true })}
        </div>
        <div className={`${fb.grid3} ${styles.row}`}>
          {field("City", "business.city")}
          {field("State", "business.state")}
          {field("Zip code", "business.zip")}
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Contact Information</h2>
        {[0, 1].map(i => (
          <div key={i}>
            {i === 1 && <h3 className={fb.subhead}>Second contact <span className={styles.prefilled}>optional</span></h3>}
            <div className={styles.grid2}>
              {field("Contact name", `contacts.${i}.name`)}
              {field("Title", `contacts.${i}.title`)}
              {field("Phone", `contacts.${i}.phone`, { type: "tel" })}
              {field("Fax", `contacts.${i}.fax`, { type: "tel", optional: true })}
              {field("Email", `contacts.${i}.email`, { type: "email" })}
            </div>
          </div>
        ))}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>GPO Affiliation</h2>
        <p className={styles.hint}>
          Participation in more than one Group Purchasing Organization or Procurement Service Organization is
          prohibited. If you&apos;re in one now, you&apos;ll need to send Foodbuy a copy of your termination letter.
        </p>
        <div className={fb.radioGroup} data-invalid={!!err("gpo.participates")}>
          <label className={styles.checkboxRow}>
            <input type="radio" className={styles.checkbox} name="gpo" checked={form.gpo.participates === false}
              onChange={() => set("gpo.participates", false)} />
            <span className={styles.checkboxText}>No, we don&apos;t currently participate in a GPO or direct contract relationship</span>
          </label>
          <label className={styles.checkboxRow}>
            <input type="radio" className={styles.checkbox} name="gpo" checked={form.gpo.participates === true}
              onChange={() => set("gpo.participates", true)} />
            <span className={styles.checkboxText}>Yes, we currently participate in a GPO or procurement services organization</span>
          </label>
        </div>
        {err("gpo.participates") && <p className={styles.fieldError}>{err("gpo.participates")}</p>}
        {form.gpo.participates && <div className={styles.row}>{field("Current GPO/PSO/Buying Group", "gpo.name")}</div>}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Locations &amp; Distributors</h2>
        <p className={styles.hint}>
          Add one row for each distributor at each location, with your account number at that distributor
          (it&apos;s on your distributor invoices).
        </p>
        {err("locations") && <p className={styles.fieldError} data-invalid="true">{err("locations")}</p>}
        {form.locations.map((_, i) => (
          <div key={i} className={fb.rowCard}>
            <div className={fb.rowCardHead}>
              <span>Row {i + 1}</span>
              {form.locations.length > 1 && (
                <button type="button" className={fb.linkBtnPlain}
                  onClick={() => set("locations", form.locations.filter((__, j) => j !== i))}>Remove</button>
              )}
            </div>
            <div className={styles.grid2}>
              {field("Distributor name/location", `locations.${i}.distributor`, { placeholder: "e.g. Sysco San Francisco" })}
              {field("Account #", `locations.${i}.acct`)}
            </div>
            <div className={`${styles.grid2} ${styles.row}`}>
              {field("Restaurant location name", `locations.${i}.name`)}
              {field("Location address", `locations.${i}.address`)}
            </div>
            <div className={`${fb.grid3} ${styles.row}`}>
              {field("City", `locations.${i}.city`)}
              {field("State", `locations.${i}.state`)}
              {field("Zip code", `locations.${i}.zip`)}
            </div>
          </div>
        ))}
        {form.locations.length < FOODBUY_MAX_LOCATIONS && (
          <button type="button" className={`${styles.btnSecondary} ${fb.addRow}`}
            onClick={() => {
              // A new row usually adds another distributor at the same location.
              const last = form.locations[form.locations.length - 1];
              set("locations", [...form.locations, { ...emptyLocation(), ...(last && {
                name: last.name, address: last.address, city: last.city, state: last.state, zip: last.zip,
              }) }]);
            }}>
            + Add Distributor or Location
          </button>
        )}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>
          Direct Manufacturer Agreements <span className={styles.prefilled}>optional</span>
        </h2>
        <p className={styles.hint}>
          List any direct contracts with manufacturers you want to keep. Manufacturers you don&apos;t list
          will be part of the Foodbuy programs.
        </p>
        {form.directAgreements.map((_, i) => (
          <div key={i} className={fb.rowCard}>
            <div className={fb.rowCardHead}>
              <span>Agreement {i + 1}</span>
              <button type="button" className={fb.linkBtnPlain}
                onClick={() => set("directAgreements", form.directAgreements.filter((__, j) => j !== i))}>Remove</button>
            </div>
            <div className={styles.grid2}>
              {field("Manufacturer", `directAgreements.${i}.manufacturer`)}
              {field("Category", `directAgreements.${i}.category`)}
              {field("Start date", `directAgreements.${i}.start`, { placeholder: "MM/DD/YYYY" })}
              {field("End date", `directAgreements.${i}.end`, { placeholder: "MM/DD/YYYY" })}
            </div>
          </div>
        ))}
        {form.directAgreements.length < FOODBUY_MAX_DIRECT_AGREEMENTS && (
          <button type="button" className={`${styles.btnSecondary} ${fb.addRow}`}
            onClick={() => set("directAgreements", [...form.directAgreements, emptyDirectAgreement()])}>
            + Add Agreement
          </button>
        )}
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>
          Your Sysco Contact {!sysco && <span className={styles.prefilled}>optional</span>}
        </h2>
        <p className={styles.hint}>
          Sysco&apos;s data-sharing letter is part of the agreement. {sysco
            ? "Since you buy from Sysco, add your Sysco sales rep's details."
            : "If you have a Sysco rep, add their details."}
        </p>
        <div className={styles.grid2}>
          {field("Contact name", "sysco.name")}
          {field("Phone", "sysco.phone", { type: "tel" })}
          {field("Email", "sysco.email", { type: "email" })}
        </div>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.sectionTitle}>Acknowledge &amp; Sign</h2>
        <label className={styles.checkboxRow} data-invalid={!!err("accept")}>
          <input type="checkbox" className={styles.checkbox} checked={form.accept}
            onChange={e => set("accept", e.target.checked)} />
          <span className={styles.checkboxText}>
            I am an authorized agent, owner, or employee of the business above. I authorize AIO and Foodbuy, LLC
            to enroll the business in the Foodbuy Foodservice purchasing program, authorize our distributors to
            release our purchase history to AIO and Foodbuy, and accept the terms of the participation
            agreement (shown in full when you review it).
          </span>
        </label>
        {err("accept") && <p className={styles.fieldError}>{err("accept")}</p>}
        <div className={`${styles.grid2} ${styles.row}`}>
          {field("Print name", "printName")}
          {field("Title", "printTitle")}
        </div>
        <div className={styles.row} data-invalid={!!err("signature")}>
          <span className={styles.label}>Signature</span>
          <SignaturePad value={form.signature} onChange={png => set("signature", png)} invalid={!!err("signature")} />
          {err("signature") && <p className={styles.fieldError}>{err("signature")}</p>}
        </div>
        {form.signedDate && <p className={`${styles.hint} ${styles.row}`}>Dated {form.signedDate}</p>}
      </section>

      {banner && <div className={styles.errorBanner}>{banner}</div>}
      <div className={styles.actions}>
        <button type="button" className={styles.btnPrimary} onClick={review} disabled={busy !== null}>
          {busy === "review" ? "Preparing…" : "Review Agreement →"}
        </button>
      </div>
    </div>
  );
}
