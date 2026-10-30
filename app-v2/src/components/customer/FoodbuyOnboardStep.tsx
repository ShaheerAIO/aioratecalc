"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  defaultFoodbuyForm, emptyDirectAgreement, emptyLocation, foodbuyDate, validateFoodbuyForm,
  FOODBUY_MAX_DIRECT_AGREEMENTS, FOODBUY_MAX_LOCATIONS, FOODBUY_PROVIDER,
} from "@/lib/foodbuyForm";
import { FOODBUY_LOGO_JPEG_BASE64 } from "@/lib/foodbuyLogo";
import { FOODBUY_TERMS } from "@/lib/foodbuyTerms";
import type { FoodbuyFormData, MerchantApplication } from "@/types/merchant";
import SignaturePad from "./SignaturePad";
// Deliberately reuses CustomerOnboardStep's stylesheet for the page chrome —
// same customer-facing design as the Adyen/payroll opt-in steps.
import styles from "./CustomerOnboardStep.module.css";
import fb from "./FoodbuyOnboardStep.module.css";

type Props = { app: MerchantApplication };

// Foodbuy has no API to onboard through: enrollment is Foodbuy's signed
// participation agreement. The customer fills it in ON the agreement: the five
// pages drawn as paper, with every blank a place to type (2026-10-30, product
// feedback: type on the form itself, not into a separate form that gets
// copied onto it). Pre-filled from what AIO holds (lib/foodbuyForm.ts). Then
// they review the finished PDF the server renders from the same answers
// (lib/foodbuyPdf.ts) and send it to the Foodbuy rep set at /admin/users, all
// in this one flow. Sending is its own press after the review, never automatic.
const SEND_ERRORS: Record<string, string> = {
  not_configured: "Sending to Foodbuy isn't set up yet. Download the agreement and send it to your AIO representative instead.",
  too_large: "That agreement is too large to email. Download it and send it to your AIO representative instead.",
};
const GENERIC_ERROR = "We couldn't do that just now. Please try again in a minute.";
const LOGO = `data:image/jpeg;base64,${FOODBUY_LOGO_JPEG_BASE64}`;

// The tables show blank lines like the paper form; more can be added.
const LOCATION_LINES = 10;

type Row = Record<string, string>;
const isBlank = (row: Row) => Object.values(row).every(v => !v.trim());

/** Immutable set of a dotted path like "business.ein". */
function setIn<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const copy = (Array.isArray(obj) ? [...obj] : { ...obj }) as Record<string, unknown>;
  copy[head] = rest.length ? setIn(copy[head], rest.join("."), value) : value;
  return copy as T;
}

/**
 * The answers as sent: blank table lines left out. Errors come back indexed
 * by the sent rows, so `rowIndex` maps them to the line they're typed on.
 */
function compact(form: FoodbuyFormData) {
  const keep = <T extends Row>(rows: T[]) => rows.map((r, i) => [r, i] as const).filter(([r]) => !isBlank(r));
  const locations = keep(form.locations);
  const directAgreements = keep(form.directAgreements);
  return {
    data: { ...form, locations: locations.map(([r]) => r), directAgreements: directAgreements.map(([r]) => r) },
    rowIndex: { locations: locations.map(([, i]) => i), directAgreements: directAgreements.map(([, i]) => i) },
  };
}

function remapErrors(errors: Record<string, string>, rowIndex: ReturnType<typeof compact>["rowIndex"]) {
  return Object.fromEntries(Object.entries(errors).map(([path, msg]) => {
    const m = /^(locations|directAgreements)\.(\d+)\.(.+)$/.exec(path);
    return [m ? `${m[1]}.${rowIndex[m[1] as keyof typeof rowIndex][Number(m[2])]}.${m[3]}` : path, msg];
  }));
}

export default function FoodbuyOnboardStep({ app }: Props) {
  // Dated on mount, in the customer's own timezone, so the server render and
  // the browser's first render agree.
  const [form, setForm] = useState<FoodbuyFormData>(() => ({ ...defaultFoodbuyForm(app), signedDate: "" }));
  useEffect(() => setForm(f => ({ ...f, signedDate: foodbuyDate() })), []);
  const [locationLines, setLocationLines] = useState(() => Math.max(LOCATION_LINES, form.locations.length));
  // Errors show only once the customer has tried to review, then live-update.
  const [showErrors, setShowErrors] = useState(false);
  const sent = useMemo(() => compact(form), [form]);
  const errors = useMemo(() => remapErrors(validateFoodbuyForm(sent.data), sent.rowIndex), [sent]);
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

  /** Type on table line `i`, which may be past the rows typed so far. */
  const setCell = (list: "locations" | "directAgreements", i: number, key: string, value: string) => {
    setForm(f => {
      const rows: Row[] = [...f[list]];
      while (rows.length <= i) rows.push(list === "locations" ? emptyLocation() : emptyDirectAgreement());
      rows[i] = { ...rows[i], [key]: value };
      return { ...f, [list]: rows };
    });
    setServerErrors({});
  };

  const valueAt = (path: string) =>
    (path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], form) as string | undefined) ?? "";

  /** A write-on blank: the input is the underline. */
  const blank = (path: string, ariaLabel: string, opts: { type?: string; placeholder?: string } = {}) => {
    const e = err(path);
    return (
      <input
        className={`${fb.blank} ${e ? fb.blankError : ""}`}
        aria-label={ariaLabel}
        aria-invalid={!!e}
        title={e}
        type={opts.type ?? "text"}
        placeholder={opts.placeholder}
        value={valueAt(path)}
        onChange={ev => set(path, ev.target.value)}
      />
    );
  };

  /** "Label: ________" as the form prints it, with the error under it. */
  const line = (label: string, path: string, ariaLabel: string, opts: { type?: string; placeholder?: string } = {}) => (
    <div className={fb.line}>
      <label className={fb.lineInner}>
        <span className={fb.lineLabel}>{label}</span>
        {blank(path, ariaLabel, opts)}
      </label>
      {err(path) && <p className={fb.lineError}>{err(path)}</p>}
    </div>
  );

  /** Row errors listed under a table: the cells themselves are too small to hold them. */
  const tableErrors = (list: "locations" | "directAgreements") => {
    if (!showErrors) return null;
    const rows = Object.entries({ ...serverErrors, ...errors })
      .map(([path, msg]) => [new RegExp(`^${list}\\.(\\d+)\\.`).exec(path), msg] as const)
      .filter(([m]) => m)
      .map(([m, msg]) => `Line ${Number(m![1]) + 1}: ${msg}`);
    const whole = err(list);
    if (!whole && !rows.length) return null;
    return (
      <ul className={fb.tableErrors} data-invalid="true">
        {whole && <li>{whole}</li>}
        {rows.map(r => <li key={r}>{r}</li>)}
      </ul>
    );
  };

  const review = async () => {
    setShowErrors(true);
    setBanner(null);
    if (Object.keys(errors).length) {
      setBanner("Some blanks are missing or need fixing. They're marked in red on the agreement.");
      requestAnimationFrame(() => document.querySelector("[aria-invalid='true'], [data-invalid='true']")?.scrollIntoView({ block: "center", behavior: "smooth" }));
      return;
    }
    setBusy("review");
    try {
      const json = JSON.stringify(sent.data);
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
        setServerErrors(remapErrors(data.errors, sent.rowIndex));
        setBanner("Some blanks are missing or need fixing. They're marked in red on the agreement.");
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
            ← Edit Agreement
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

  // ── Fill in, on the agreement itself ──────────────────────────────────────
  const b = form.business;
  const c1 = form.contacts[0];
  const accountNumber = app.aioTenant?.businessId != null ? String(app.aioTenant.businessId) : "";
  const header = (title: string) => (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- inline data URL, nothing to optimise */}
      <img className={fb.logo} src={LOGO} alt="AIO AI for Restaurants" />
      <h2 className={fb.docTitle}>{title}</h2>
    </>
  );
  const heading = (s: string) => <h3 className={fb.sectionHeading}>{s}</h3>;
  const sysBox = (label: string, content: ReactNode, wide = false) => (
    <div className={`${fb.boxField} ${wide ? fb.boxWide : ""}`}>
      <span className={fb.boxLabel}>{label}</span>
      <span className={fb.box}>{content}</span>
    </div>
  );

  return (
    <div className={`${styles.page} ${fb.pageWide}`}>
      <h1 className={styles.pageTitle}>Set Up Foodbuy</h1>
      <p className={styles.pageSubtitle}>
        This is Foodbuy&apos;s participation agreement. Type straight onto it: we&apos;ve filled in what we
        already know, so check those lines, fill in the blanks, list your distributors and account numbers,
        sign, then review the finished agreement and send it to Foodbuy.
      </p>
      {sentAt && (
        <p className={styles.prefillNote}>
          You sent your agreement on {new Date(sentAt).toLocaleDateString()}. To send a corrected copy, update
          it, sign again and send.
        </p>
      )}

      {/* ── Page 1: Participation Agreement ── */}
      <section className={fb.sheet} aria-label="Page 1: Participation Agreement">
        {header("Participation Agreement")}
        <p className={fb.docSubtitle}>Foodbuy Foodservice Enrollment</p>
        <hr className={fb.titleRule} />
        <div className={fb.metaRow}>
          <span><b>Program Effective Date:</b> <span className={fb.fixed}>{form.signedDate}</span></span>
          <span><b>Account Number:</b> <span className={fb.fixed}>{accountNumber}</span></span>
        </div>

        {heading("Business Information")}
        <div className={fb.lines2}>
          {line("Legal Entity Name:", "business.legalName", "Legal entity name")}
          {line("Federal ID #:", "business.ein", "Federal ID # (EIN)", { placeholder: "12-3456789" })}
          {line("DBA (if applicable):", "business.dba", "DBA")}
          {line("Type of Business:", "business.bizType", "Type of business", { placeholder: "e.g. LLC" })}
          {line("Corporate Address:", "business.address", "Corporate address")}
          {line("Suite #:", "business.suite", "Suite #")}
          {line("City:", "business.city", "City")}
          {line("State:", "business.state", "State")}
          {line("Zip Code:", "business.zip", "Zip code")}
        </div>

        {heading("Contact Information")}
        {[0, 1].map(i => (
          <div key={i} className={`${fb.lines2} ${i ? fb.contactGap : ""}`}>
            {line("Contact Name:", `contacts.${i}.name`, "Contact name")}
            {line("Phone:", `contacts.${i}.phone`, "Phone", { type: "tel" })}
            {line("Title:", `contacts.${i}.title`, "Title")}
            {line("Fax:", `contacts.${i}.fax`, "Fax", { type: "tel" })}
            {line("Email:", `contacts.${i}.email`, "Email", { type: "email" })}
          </div>
        ))}

        {heading("GPO Affiliation")}
        <div data-invalid={!!err("gpo.participates")}>
          <label className={fb.option}>
            <input type="checkbox" className={fb.check} checked={form.gpo.participates === false}
              onChange={e => set("gpo.participates", e.target.checked ? false : null)} />
            <span>
              <b>NO, WE DO NOT CURRENTLY PARTICIPATE IN GPO OR DIRECT CONTRACT RELATIONSHIPS</b>
              <span className={fb.note}>
                I am not aware of any other GPO food and beverage contracting relationships that are currently
                in effect. If any other affiliation is in place, those relationships are hereby terminated.
              </span>
            </span>
          </label>
          <label className={fb.option}>
            <input type="checkbox" className={fb.check} checked={form.gpo.participates === true}
              onChange={e => set("gpo.participates", e.target.checked ? true : null)} />
            <span>
              <b>YES, WE CURRENTLY PARTICIPATE IN A GPO OR PROCUREMENT SERVICES ORGANIZATION</b>
              <span className={fb.note}>
                List current affiliation below. Participation in more than one Group Purchasing Organization or
                Procurement Service Organization is strictly prohibited and will disqualify application if other
                Affiliation is not terminated prior to engaging Foodbuy Foodservice.
              </span>
            </span>
          </label>
          {err("gpo.participates") && <p className={fb.lineError}>{err("gpo.participates")}</p>}
        </div>
        {line("Please list your current GPO/PSO/Buying Group:", "gpo.name", "Current GPO/PSO/Buying Group")}
        <p className={fb.note}>
          If you intend to have your food and beverage purchases qualify for the Foodbuy Foodservice program,
          please provide Foodbuy Foodservice with a copy of the termination letter addressed to your existing
          GPO/PSO/Buying Group.
        </p>
      </section>

      {/* ── Page 2: Acknowledgement & Authorization ── */}
      <section className={fb.sheet} aria-label="Page 2: Acknowledgement and Authorization">
        {header("Acknowledgement & Authorization")}
        <hr className={fb.titleRule} />
        {FOODBUY_TERMS.map((para, i) => i === 0 ? (
          <label key={i} className={`${fb.terms} ${fb.acceptRow}`} data-invalid={!!err("accept")}>
            <input type="checkbox" className={fb.check} aria-label="Accept the terms" checked={form.accept}
              onChange={e => set("accept", e.target.checked)} />
            <span><b className={fb.accept}>ACCEPT</b> {para.join(" ")}</span>
          </label>
        ) : (
          <p key={i} className={fb.terms}>{para.join(" ")}</p>
        ))}
        {err("accept") && <p className={fb.lineError}>{err("accept")}</p>}

        <div className={fb.signRow}>
          <div className={fb.signCell} data-invalid={!!err("signature")}>
            <SignaturePad value={form.signature} onChange={png => set("signature", png)} invalid={!!err("signature")} />
            <span className={fb.caption}>Authorized Signature</span>
            {err("signature") && <p className={fb.lineError}>{err("signature")}</p>}
          </div>
          <div className={fb.signCell}>
            <div className={fb.printLine}>
              {blank("printName", "Print name")}
              {blank("printTitle", "Print title")}
            </div>
            <span className={fb.caption}>Print Name and Title</span>
            {(err("printName") || err("printTitle")) && <p className={fb.lineError}>{err("printName") ?? err("printTitle")}</p>}
          </div>
        </div>
        <p className={fb.onBehalf}><b>ON BEHALF OF:</b> <span className={fb.fixed}>{b.dba || b.legalName}</span></p>
        <div className={fb.signRow}>
          <div className={fb.signCell}>
            <span className={fb.fixedLine}>{b.legalName}</span>
            <span className={fb.caption}>[Business Name]</span>
          </div>
          <div className={fb.signCell}>
            <span className={fb.fixedLine}>{form.signedDate}</span>
            <span className={fb.caption}>Date</span>
          </div>
        </div>
      </section>

      {/* ── Page 3: Direct Manufacturer Agreements ── */}
      <section className={fb.sheet} aria-label="Page 3: Distributor Account Number Information">
        {header("Distributor Account Number Information")}
        <hr className={fb.titleRule} />
        <p className={fb.note}>Please provide all location details to your Foodbuy Foodservice Account executive.</p>
        {heading("Direct Manufacturer Agreements")}
        <p className={fb.terms}>
          If you or your distributor(s) have direct contracts with manufacturers and you wish to keep those contracts
          and program associations in place, please list them in the table below. Failure to disclose this
          information will acknowledge that you agree to participate in the Foodbuy Foodservice programs with all
          manufacturers not disclosed. Please update Foodbuy Foodservice of any additions or deletions on a regular basis.
        </p>
        <p className={fb.tableTitle}>Please List All Direct Agreements with Start and End Dates</p>
        <div className={fb.tableWrap}>
          <table className={fb.table}>
            <thead>
              <tr><th>Manufacturer</th><th>Category</th><th>Start Date</th><th>End Date</th></tr>
            </thead>
            <tbody>
              {Array.from({ length: FOODBUY_MAX_DIRECT_AGREEMENTS }, (_, i) => {
                const a = form.directAgreements[i] ?? emptyDirectAgreement();
                return (
                  <tr key={i}>
                    {([["manufacturer", "Manufacturer"], ["category", "Category"], ["start", "Start date"], ["end", "End date"]] as const).map(([key, label]) => {
                      const e = err(`directAgreements.${i}.${key}`);
                      return (
                        <td key={key}>
                          <input className={`${fb.cell} ${e ? fb.blankError : ""}`} aria-label={label} aria-invalid={!!e} title={e}
                            placeholder={key === "start" || key === "end" ? "MM/DD/YYYY" : undefined}
                            value={a[key]} onChange={ev => setCell("directAgreements", i, key, ev.target.value)} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tableErrors("directAgreements")}
        <div className={fb.office} aria-label="Office use only">
          <div className={fb.officeHead}>Office Use Only</div>
          <div className={fb.officeGrid}>
            {["Foodbuy Foodservice", "Healthcare", "Resorts & Gaming", "Golf Course", "Education", "Clubs", "Other: ______________"].map(s => (
              <span key={s}><input type="checkbox" className={fb.check} disabled tabIndex={-1} aria-hidden /> {s}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Page 4: Locations & distributor accounts ── */}
      <section className={fb.sheet} aria-label="Page 4: Restaurant Locations and Distributor Account Details">
        <div className={fb.headerRow}>
          {/* eslint-disable-next-line @next/next/no-img-element -- inline data URL, nothing to optimise */}
          <img className={fb.logo} src={LOGO} alt="AIO AI for Restaurants" />
          <h2 className={fb.docTitleSmall}>Restaurant Location(s) &amp; Distributor Account Details</h2>
        </div>
        <hr className={fb.titleRule} />
        <p className={fb.note}>
          One line for each distributor at each location. Your account # is on that distributor&apos;s invoices.
        </p>
        <div className={fb.tableWrap}>
          <table className={`${fb.table} ${fb.tableLocations}`}>
            <thead>
              <tr>
                <th>Restaurant Location Name</th><th>Location Address</th><th>Location City</th><th>Location State</th>
                <th>Location Zip Code</th><th>Distributor Name/Location</th><th>Acct. #</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: locationLines }, (_, i) => {
                const l = form.locations[i] ?? emptyLocation();
                return (
                  <tr key={i}>
                    {([
                      ["name", "Restaurant location name"], ["address", "Location address"], ["city", "Location city"],
                      ["state", "Location state"], ["zip", "Location zip code"], ["distributor", "Distributor name/location"],
                      ["acct", "Account #"],
                    ] as const).map(([key, label]) => {
                      const e = err(`locations.${i}.${key}`);
                      return (
                        <td key={key}>
                          <input className={`${fb.cell} ${e ? fb.blankError : ""}`} aria-label={label} aria-invalid={!!e} title={e}
                            value={l[key]} onChange={ev => setCell("locations", i, key, ev.target.value)} />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {tableErrors("locations")}
        {locationLines < FOODBUY_MAX_LOCATIONS && (
          <button type="button" className={fb.moreLines}
            onClick={() => setLocationLines(n => Math.min(FOODBUY_MAX_LOCATIONS, n + LOCATION_LINES))}>
            + More lines
          </button>
        )}
      </section>

      {/* ── Page 5: Sysco letter of participation ── */}
      <section className={`${fb.sheet} ${fb.sysco}`} aria-label="Page 5: Sysco Letter of Participation">
        <div className={fb.syscoBar} />
        <h2 className={fb.syscoTitle}>Limited Liability Controls - SYSCO Corporation</h2>
        <p className={fb.syscoSub}>Third Party Data Tracking</p>
        <hr className={fb.syscoRule} />
        <p className={fb.syscoLop}>Letter of Participation (LoP) Content Requirements</p>
        <p className={fb.syscoText}>
          [Operator or GPO Name] noted as “<b>Customer</b>”, authorizes [Consultant or GPO Service Provider] noted as
          “<b>Provider</b>”, to collect transactional purchase data from their distributor partners. It is understood
          that such data will be utilized for reporting, analysis, and related activities in accordance with the
          performance of value added services provided to <b>Customer</b> by <b>Provider.</b>
        </p>
        <p className={fb.syscoText}>
          <b>Customer</b> represents that the relationship between it and its members or unit locations, including
          franchisees if appropriate, entitles them to collect this data for Provider.
        </p>
        <p className={fb.syscoText}>
          <b>Provider</b> agrees to maintain the confidentiality and integrity of the information released into its
          possession using such information only for the value added services agreed to with the Customer.
        </p>

        <div className={fb.syscoSection}>
          <div className={fb.syscoHead}>Date References</div>
          <div className={fb.syscoBody}>
            {sysBox("LoP Agreement Date:", form.signedDate)}
            {sysBox("Effective Date for Data Exchange:", form.signedDate)}
            {sysBox("Termination Date of Data Exchange:", "OPEN")}
          </div>
        </div>

        <div className={fb.syscoSection}>
          <div className={fb.syscoHead}>Primary Sysco Contact</div>
          <div className={fb.syscoBody}>
            {(["name", "phone", "email"] as const).map(key => {
              const path = `sysco.${key}`;
              const e = err(path);
              const [label, aria, type] = key === "name" ? ["Contact Name:", "Contact name", "text"]
                : key === "phone" ? ["Phone:", "Phone", "tel"] : ["Email Address:", "Email", "email"];
              return (
                <div key={key} className={`${fb.boxField} ${key === "name" ? fb.boxWide : ""}`}>
                  <span className={fb.boxLabel}>{label}</span>
                  <input className={`${fb.box} ${fb.boxInput} ${e ? fb.blankError : ""}`} aria-label={aria}
                    aria-invalid={!!e} title={e} type={type} value={form.sysco[key]}
                    onChange={ev => set(path, ev.target.value)} />
                  {e && <p className={fb.lineError}>{e}</p>}
                </div>
              );
            })}
          </div>
        </div>

        <div className={fb.syscoSection}>
          <div className={fb.syscoHead}>“Customer” Authorization Signature and Contact Information</div>
          <p className={fb.syscoFromP1}>Filled in from page 1 and your signature on page 2.</p>
          <div className={fb.syscoBody}>
            {sysBox("Contact Name:", c1.name)}
            {sysBox("Title:", c1.title)}
            {sysBox("Signature:", form.signature
              // eslint-disable-next-line @next/next/no-img-element -- the drawn signature, a data URL
              ? <img className={fb.sigImg} src={form.signature} alt="Your signature" />
              : null)}
            {sysBox("Company Name:", b.legalName, true)}
            {sysBox("Address:", [b.address, b.suite].filter(Boolean).join(", "), true)}
            {sysBox("City/State/Zip:", [b.city, b.state, b.zip].filter(Boolean).join("  "))}
            {sysBox("Phone:", c1.phone)}
            {sysBox("email Address:", c1.email)}
            {sysBox("Fax:", c1.fax)}
          </div>
        </div>

        <div className={fb.syscoSection}>
          <div className={fb.syscoHead}>“Provider” Contact Information</div>
          <div className={fb.syscoBody}>
            {sysBox("Contact Name:", FOODBUY_PROVIDER.name)}
            {sysBox("Title:", FOODBUY_PROVIDER.title)}
            {sysBox("Company Name:", FOODBUY_PROVIDER.company, true)}
            {sysBox("Address:", FOODBUY_PROVIDER.address, true)}
            {sysBox("City/State/Zip:", FOODBUY_PROVIDER.cityStateZip)}
            {sysBox("Phone:", FOODBUY_PROVIDER.phone)}
            {sysBox("email Address:", FOODBUY_PROVIDER.email)}
            {sysBox("Fax:", "")}
          </div>
        </div>
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
