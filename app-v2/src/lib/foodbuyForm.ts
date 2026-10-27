// Builds a pre-filled copy of Foodbuy's own "Foodbuy Foodservice Enrollment"
// participation agreement (AIO_Foodbuy_Enrollment_Form_V1) as a printable HTML
// document, using the same client-side html2pdf pattern ProposalStep.tsx uses
// for proposal PDFs — no new dependency.
//
// The opened document is EDITABLE before it is exported: every value on it is
// contenteditable and the checkboxes toggle, so the customer types the fields
// AIO doesn't hold (and corrects any it has wrong) in place, and exports a
// finished form rather than a part-filled one to complete by hand. Nothing is
// sent back to AIO — the edits live in that browser tab and end up in the PDF
// the customer downloads, which is the only artifact Foodbuy ever sees.
//
// Only fields AIO already holds are PRE-filled: business identity/address and
// the main contact. Everything else starts as a blank line, on purpose:
//   - Federal ID # (EIN) — EasyOB DOES hold one since 2026-10-15
//     (`business.ein`, collected on the merchant's confirmation step), and it
//     is still deliberately NOT printed here. This line sits above a legal
//     attestation the merchant signs; pre-filling a tax id onto a document
//     they are about to swear to is a different act from recording it, and the
//     merchant is the one who should write it. A test asserts it stays blank.
//   - GPO Affiliation, Acknowledgement & signature — legal attestations only
//     the merchant can make; AIO must not answer or sign on their behalf.
//   - Distributor/location table, direct manufacturer agreements, Program
//     Effective Date/Account Number, Office Use Only — the form itself says
//     these are provided to/assigned by the Foodbuy account executive, not
//     known to AIO at all.
import type { BusinessInfo, OwnerContact } from "@/types/merchant";

const BIZ_TYPE_LABEL: Record<BusinessInfo["bizType"], string> = {
  // Unspecified: falls through to field()'s blank write-on line, same as
  // every other value AIO doesn't hold — never assert a legal entity nobody stated.
  "": "",
  llc: "LLC",
  corp: "Corporation",
  "s-corp": "S-Corporation",
  "sole-prop": "Sole Proprietorship",
  partnership: "Partnership",
  "non-profit": "Non-Profit",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A filled-in value renders as bold text; an unknown one renders as a blank
// line, same visual language as the paper form. Both are editable: a blank is
// where the customer types what AIO doesn't hold, and a pre-filled value is
// theirs to correct — AIO's copy of a legal name or address can be out of
// date, and this form is the one place it has to match what the state has on
// file.
function field(value: string | undefined | null): string {
  const v = (value || "").trim();
  return v
    ? `<span class="filled" contenteditable="true">${esc(v)}</span>`
    : `<span class="blank" contenteditable="true"></span>`;
}

// A write-on blank that sits inline in a sentence (the GPO and signature
// boxes) rather than in a labelled row, so it carries its own rule and an
// explicit width — there's no field-val container under it to draw one.
function inlineBlank(width: number): string {
  return `<span class="blank inline" contenteditable="true" style="min-width:${width}px"></span>`;
}

// Toggles between ☐ and ☑ on click (see `tog` in the export script). The
// answers these record are legal attestations AIO must never pre-answer, so
// they ship unticked — the customer ticks their own.
function checkbox(): string {
  return `<span class="cb" onclick="tog(this)">☐</span>`;
}

export function buildFoodbuyFormFileName(business: BusinessInfo): string {
  const safeName = (business.dba || business.legalName || "Business").replace(/[^a-zA-Z0-9]/g, "-");
  const dateStr = new Date().toISOString().slice(0, 10);
  return `AIO-Foodbuy-Enrollment-${safeName}-${dateStr}.pdf`;
}

export function buildFoodbuyFormHtml(business: BusinessInfo, ownerContact: OwnerContact): string {
  const fileName = buildFoodbuyFormFileName(business);
  const contactName = [ownerContact.firstName, ownerContact.lastName].filter(Boolean).join(" ");
  const bizTypeLabel = BIZ_TYPE_LABEL[business.bizType] || business.bizType;

  const exportScript = "<scr" + "ipt src=\"https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js\"><\/" + "scr" + "ipt>"
    + "<scr" + "ipt>"
    + "function tog(el){el.textContent=el.textContent.trim()==='☐'?'☑':'☐';}"
    + "function exportPDF(){"
    // Leave the field being edited before rendering: html2canvas paints the
    // live DOM, so a focused field's selection highlight would otherwise end
    // up as a blue block on the exported page.
    + "if(document.activeElement&&document.activeElement.blur)document.activeElement.blur();"
    + "var sel=window.getSelection&&window.getSelection();if(sel&&sel.removeAllRanges)sel.removeAllRanges();"
    + "var wrap=document.getElementById('pdf-btn-wrap');wrap.style.visibility='hidden';"
    + "html2pdf().set({margin:[10,10,10,10],filename:'" + fileName + "',"
    + "image:{type:'jpeg',quality:0.98},"
    + "html2canvas:{scale:2,useCORS:true,logging:false,backgroundColor:'#ffffff'},"
    + "jsPDF:{unit:'mm',format:'letter',orientation:'portrait'}})"
    + ".from(document.body).toPdf().get('pdf').then(function(pdf){"
    + "pdf.save('" + fileName + "');"
    // Hand the same PDF back to the tab that opened this one, which files it on
    // the customer's HubSpot Company. Same-origin only (a blob: page shares its
    // opener's origin) and best-effort: the download above already happened.
    + "try{if(window.opener)window.opener.postMessage({type:'aio-foodbuy-pdf',blob:pdf.output('blob')},window.location.origin);}catch(e){}"
    + "wrap.style.visibility='visible';});}"
    + "<\/" + "scr" + "ipt>";

  const row = (label: string, value: string) =>
    `<div class="field"><div class="field-lbl">${esc(label)}</div><div class="field-val">${value}</div></div>`;

  return "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"/>"
    + "<title>Foodbuy Enrollment — " + esc(business.dba || business.legalName) + "</title>"
    + "<style>*{box-sizing:border-box;margin:0;padding:0}"
    + "body{font-family:Helvetica Neue,Arial,sans-serif;color:#1a1a1a;background:#fff;padding:48px;font-size:13px;line-height:1.5}"
    + ".header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:2px solid #e8614a}"
    + ".logo-text{font-size:20px;font-weight:800;letter-spacing:2px}"
    + ".logo-sub{font-size:10px;color:#888;letter-spacing:3px;text-transform:uppercase}"
    + ".doc-title{font-size:22px;font-weight:800;margin-bottom:4px}"
    + ".doc-sub{font-size:12px;color:#888;margin-bottom:28px}"
    + ".section{margin-bottom:28px}"
    + "h2{font-size:11px;font-weight:700;color:#888;letter-spacing:2px;text-transform:uppercase;margin:0 0 12px;border-bottom:1px solid #eee;padding-bottom:6px}"
    + ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px 24px}"
    + ".field-lbl{font-size:10px;color:#888;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px}"
    + ".field-val{font-size:14px;min-height:18px;border-bottom:1px solid #ccc;padding-bottom:3px}"
    // Both are blocks so the whole row is a click target, and both are bold
    // so a value the customer types reads exactly like one AIO pre-filled.
    + ".filled{font-weight:700;display:block;min-height:17px}"
    + ".blank{font-weight:700;display:block;min-height:17px}"
    + ".filled,.blank{cursor:text;border-radius:3px}"
    + ".filled:hover,.blank:hover{background:#f3f3f3}"
    + ".filled:focus,.blank:focus{background:#fff4f1;outline:none}"
    + ".blank.inline{display:inline-block;border-bottom:1px solid #999;vertical-align:bottom}"
    + ".cb{cursor:pointer;user-select:none;font-size:15px}"
    + ".cb:hover{color:#e8614a}"
    + ".edit-hint{background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 12px;font-size:12px;color:#666;margin-bottom:8px;box-shadow:0 2px 8px rgba(0,0,0,.08)}"
    + ".note{font-size:11px;color:#888;line-height:1.6;margin-top:6px}"
    + ".todo{background:#fff8e6;border:1px solid #f2d68a;border-radius:8px;padding:14px 16px;font-size:12px;color:#7a5c00;margin-top:8px}"
    + ".legal{font-size:10.5px;color:#666;line-height:1.6;margin-bottom:10px}"
    + ".footer{margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#aaa;display:flex;justify-content:space-between}"
    + "</style></head><body>"
    + "<div class=\"header\"><div><div class=\"logo-text\">AIO</div><div class=\"logo-sub\">Foodbuy Enrollment</div></div>"
    + "<div class=\"doc-sub\">Prepared " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) + "</div></div>"
    + "<div class=\"doc-title\">Foodbuy Foodservice Enrollment — Participation Agreement</div>"
    + "<div class=\"doc-sub\">Pre-filled from your AIO account. Click any field to edit it, complete the remaining ones including your signature, then export it as a PDF. Back on the AIO page you can send it to Foodbuy.</div>"

    + "<div class=\"section\"><h2>Customer Information</h2><div class=\"grid2\">"
    + row("Customer Name", field(business.legalName))
    + row("Federal ID # (EIN)", field(null))
    + row("DBA (if applicable)", field(business.dba))
    + row("Type of Business", field(bizTypeLabel))
    + row("Corporate Address", field(business.address))
    + row("Suite #", field(null))
    + row("City", field(business.city))
    + row("State", field(business.state))
    + row("Zip Code", field(business.zip))
    + "</div></div>"

    + "<div class=\"section\"><h2>Main Contact</h2><div class=\"grid2\">"
    + row("Contact Name", field(contactName))
    + row("Phone", field(ownerContact.phone))
    + row("Title", field(ownerContact.title))
    + row("Email", field(ownerContact.email))
    + "</div></div>"

    + "<div class=\"section\"><h2>GPO Affiliation</h2>"
    + "<div class=\"note\">Are you currently participating in another Group Purchasing Organization or Procurement Service Organization? Participation in more than one is prohibited. Check one and, if applicable, list the current affiliation and provide a termination letter to Foodbuy Foodservice.</div>"
    + "<div class=\"todo\">" + checkbox() + " No, we do not currently participate in a GPO/PSO &nbsp;&nbsp;&nbsp; " + checkbox() + " Yes — current GPO/PSO: " + inlineBlank(200) + "</div></div>"

    + "<div class=\"section\"><h2>Acknowledgement &amp; Authorization</h2>"
    + "<div class=\"legal\">I am an authorized agent, owner, or employee of the above Business and authorize AIO AI For Restaurants and Foodbuy, LLC to enroll the Business in the Foodbuy Foodservice purchasing program, and authorize distributors to release purchase history to AIO and Foodbuy for allowance tracking. Full terms are in the original Foodbuy Foodservice Enrollment agreement.</div>"
    + "<div class=\"todo\">" + checkbox() + " Accept &nbsp;&nbsp;&nbsp; Authorized Signature: " + inlineBlank(170) + " &nbsp;&nbsp;&nbsp; Print Name &amp; Title: " + inlineBlank(170) + " &nbsp;&nbsp;&nbsp; Date: " + inlineBlank(100) + "</div></div>"

    + "<div class=\"section\"><h2>Distributor Accounts &amp; Locations</h2>"
    + "<div class=\"note\">Provide all location, distributor, and direct manufacturer agreement details directly to your Foodbuy Foodservice account executive — AIO does not hold this information.</div></div>"

    + "<div class=\"footer\"><span>AIO — AI for Restaurants</span><span>aioapp.com</span></div>"
    + "<div id=\"pdf-btn-wrap\" style=\"position:fixed;top:20px;right:20px;z-index:9999;text-align:right;\">"
    // Both the hint and the button live in the wrap exportPDF() hides, so
    // neither appears in the exported document.
    + "<div class=\"edit-hint\">Click any field to edit it, then export.</div>"
    + "<button onclick=\"exportPDF()\" style=\"background:#e8614a;color:#fff;border:none;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;\">⬇ Export as PDF</button></div>"
    + exportScript
    + "</body></html>";
}
