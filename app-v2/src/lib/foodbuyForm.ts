// Builds a pre-filled copy of Foodbuy's own "Foodbuy Foodservice Enrollment"
// participation agreement (AIO_Foodbuy_Enrollment_Form_V1) as a printable HTML
// document, using the same client-side html2pdf pattern ProposalStep.tsx uses
// for proposal PDFs — no new dependency.
//
// Only fields AIO already holds are filled in: business identity/address and
// the main contact. Everything else stays a blank line for the customer to
// complete by hand, on purpose:
//   - Federal ID # (EIN) — AIO never collects this, same rule as Adyen/Check.
//   - GPO Affiliation, Acknowledgement & signature — legal attestations only
//     the merchant can make; AIO must not answer or sign on their behalf.
//   - Distributor/location table, direct manufacturer agreements, Program
//     Effective Date/Account Number, Office Use Only — the form itself says
//     these are provided to/assigned by the Foodbuy account executive, not
//     known to AIO at all.
import type { BusinessInfo, OwnerContact } from "@/types/merchant";

const BIZ_TYPE_LABEL: Record<BusinessInfo["bizType"], string> = {
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
// line for the customer to write on, same visual language as the paper form.
function field(value: string | undefined | null): string {
  const v = (value || "").trim();
  return v ? `<span class="filled">${esc(v)}</span>` : `<span class="blank">&nbsp;</span>`;
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
    + "function exportPDF(){"
    + "var wrap=document.getElementById('pdf-btn-wrap');wrap.style.visibility='hidden';"
    + "html2pdf().set({margin:[10,10,10,10],filename:'" + fileName + "',"
    + "image:{type:'jpeg',quality:0.98},"
    + "html2canvas:{scale:2,useCORS:true,logging:false,backgroundColor:'#ffffff'},"
    + "jsPDF:{unit:'mm',format:'letter',orientation:'portrait'}})"
    + ".from(document.body).save().then(function(){wrap.style.visibility='visible';});}"
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
    + ".filled{font-weight:700}"
    + ".blank{color:#ccc}"
    + ".note{font-size:11px;color:#888;line-height:1.6;margin-top:6px}"
    + ".todo{background:#fff8e6;border:1px solid #f2d68a;border-radius:8px;padding:14px 16px;font-size:12px;color:#7a5c00;margin-top:8px}"
    + ".legal{font-size:10.5px;color:#666;line-height:1.6;margin-bottom:10px}"
    + ".footer{margin-top:40px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#aaa;display:flex;justify-content:space-between}"
    + "</style></head><body>"
    + "<div class=\"header\"><div><div class=\"logo-text\">AIO</div><div class=\"logo-sub\">Foodbuy Enrollment</div></div>"
    + "<div class=\"doc-sub\">Prepared " + new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) + "</div></div>"
    + "<div class=\"doc-title\">Foodbuy Foodservice Enrollment — Participation Agreement</div>"
    + "<div class=\"doc-sub\">Pre-filled from your AIO account. Review, complete the remaining fields, sign, and send this to your AIO representative or Foodbuy account executive.</div>"

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
    + "<div class=\"todo\">☐ No, we do not currently participate in a GPO/PSO &nbsp;&nbsp;&nbsp; ☐ Yes — current GPO/PSO: " + field(null) + "</div></div>"

    + "<div class=\"section\"><h2>Acknowledgement &amp; Authorization</h2>"
    + "<div class=\"legal\">I am an authorized agent, owner, or employee of the above Business and authorize AIO AI For Restaurants and Foodbuy, LLC to enroll the Business in the Foodbuy Foodservice purchasing program, and authorize distributors to release purchase history to AIO and Foodbuy for allowance tracking. Full terms are in the original Foodbuy Foodservice Enrollment agreement.</div>"
    + "<div class=\"todo\">☐ Accept &nbsp;&nbsp;&nbsp; Authorized Signature: " + field(null) + " &nbsp;&nbsp;&nbsp; Print Name &amp; Title: " + field(null) + " &nbsp;&nbsp;&nbsp; Date: " + field(null) + "</div></div>"

    + "<div class=\"section\"><h2>Distributor Accounts &amp; Locations</h2>"
    + "<div class=\"note\">Provide all location, distributor, and direct manufacturer agreement details directly to your Foodbuy Foodservice account executive — AIO does not hold this information.</div></div>"

    + "<div class=\"footer\"><span>AIO — AI for Restaurants</span><span>aioapp.com</span></div>"
    + "<div id=\"pdf-btn-wrap\" style=\"position:fixed;top:20px;right:20px;z-index:9999;\">"
    + "<button onclick=\"exportPDF()\" style=\"background:#e8614a;color:#fff;border:none;border-radius:8px;padding:11px 22px;font-size:14px;font-weight:700;cursor:pointer;\">⬇ Export as PDF</button></div>"
    + exportScript
    + "</body></html>";
}
