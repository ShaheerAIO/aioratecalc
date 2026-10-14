// @vitest-environment jsdom
//
// Two 10/13 items, both owned by MerchantDetailsForm.tsx:
//  - item 3, "add email to owner contact" — the Owner section gets an Email
//    field (it had none before; only the page's header "Send to" box edited
//    ownerContact.email).
//  - items 4/5, "add billing contact" / "...dropdown for existing or make a
//    new one" / "overwrite the billing contact in hs" — a new Billing
//    section: a dropdown over the SAME contact list the page's own
//    "Quote for" dropdown uses (passed in as `contactOptions`, never a second
//    portal-wide search), a "Same as owner contact" checkbox, and four
//    free-text fields.
//
// The checkbox's fuller lifecycle (live mirroring while checked, disabling,
// unchecking retains values, initial checked/unchecked state) lives in
// MerchantDetailsForm.sameAsOwner.test.tsx — this file keeps only the smoke
// test that it copies on check, plus the dropdown/independent-edit behavior.
//
// A SEPARATE file from MerchantDetailsForm.test.tsx (which covers the
// "Same as operating address" address-sync behavior) rather than appended to
// it, so this doesn't collide with concurrent edits to that file for an
// unrelated 10/13 item.
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import MerchantDetailsForm, { type ContactOption } from "@/components/rep/MerchantDetailsForm";
import { NO_REVIEW_PREFILL_APPLIED } from "@/lib/prefillMerge";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";

const BLANK_BUSINESS: BusinessInfo = {
  legalName: "", dba: "", bizType: "llc", address: "", city: "", state: "", zip: "",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const BLANK_OWNER: OwnerContact = { firstName: "", lastName: "", title: "", email: "", phone: "" };
const BLANK_PROCESSING: ProcessingInfo = {
  monthlyVolume: "", avgTicket: "", cardPresentPct: "95", mcc: "", businessDescription: "",
  previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
};
const OPTIONS: ContactOption[] = [
  { id: "c1", label: "Priya Shah · Controller · priya@tortapalace.com" },
  { id: "c2", label: "Ana Reyes · Owner · ana@tortapalace.com" },
];

afterEach(cleanup);

describe("MerchantDetailsForm — Owner email (item 3)", () => {
  it("renders an editable email field in the Owner section, bound to ownerContact.email", () => {
    function Harness() {
      const [ownerContact, setOwnerContact] = useState({ ...BLANK_OWNER, email: "ana@tortapalace.com" });
      return (
        <MerchantDetailsForm
          business={BLANK_BUSINESS} ownerContact={ownerContact} processing={BLANK_PROCESSING}
          applied={NO_REVIEW_PREFILL_APPLIED} showProcessing={true}
          onBusinessChange={() => {}} onOwnerChange={setOwnerContact} onProcessingChange={() => {}}
        />
      );
    }
    render(<Harness />);
    // There are two "Email" fields once the Billing section exists (Owner +
    // Billing) — find the one actually holding the owner's address.
    const ownerEmail = screen.getByDisplayValue("ana@tortapalace.com") as HTMLInputElement;
    expect(ownerEmail.type).toBe("email");
    fireEvent.change(ownerEmail, { target: { value: "new@tortapalace.com" } });
    expect(screen.getByDisplayValue("new@tortapalace.com")).toBeTruthy();
  });
});

describe("MerchantDetailsForm — Billing contact (items 4/5)", () => {
  function Harness({ initialBilling = BLANK_OWNER }: { initialBilling?: OwnerContact }) {
    const [ownerContact] = useState({ ...BLANK_OWNER, firstName: "Ana", lastName: "Reyes", email: "ana@tortapalace.com", phone: "555-0101" });
    const [billingContactId, setBillingContactId] = useState<string | null>(null);
    const [billing, setBilling] = useState(initialBilling);
    return (
      <MerchantDetailsForm
        business={BLANK_BUSINESS} ownerContact={ownerContact} processing={BLANK_PROCESSING}
        applied={NO_REVIEW_PREFILL_APPLIED} showProcessing={true}
        onBusinessChange={() => {}} onOwnerChange={() => {}} onProcessingChange={() => {}}
        contactOptions={OPTIONS}
        billingContactId={billingContactId}
        billing={billing}
        // Deliberately minimal: MerchantDetailsForm doesn't itself decide what
        // picking a contact prefills — that mapping is the PAGE's job (see
        // rep/prospects/new/page.tsx's selectBillingContact), so this harness
        // only has to prove the component reports the id change faithfully.
        onBillingContactIdChange={setBillingContactId}
        onBillingChange={setBilling}
      />
    );
  }

  it("renders with nothing selected and blank fields by default", () => {
    render(<Harness />);
    const select = screen.getByLabelText("Use existing contact") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "New contact" })).toBeTruthy();
    expect(screen.getByRole("option", { name: OPTIONS[0].label })).toBeTruthy();
  });

  it("'Same as owner contact' checkbox copies the owner's fields into the billing fields, hidden behind a summary", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Same as owner contact" }));
    // The billing inputs are hidden once checked (product owner, 2026-10-13:
    // hide the duplicate rows for cleanliness), so "Ana"/"Reyes" still only
    // appear once each (the Owner section) — the copy lands in the summary
    // line instead. The fuller lifecycle (live mirroring, unchecking) is
    // covered in MerchantDetailsForm.sameAsOwner.test.tsx.
    expect(screen.getAllByDisplayValue("Ana")).toHaveLength(1);
    expect(screen.getAllByDisplayValue("Reyes")).toHaveLength(1);
    expect(screen.getByText("Ana Reyes · ana@tortapalace.com")).toBeTruthy();
  });

  it("selecting an existing contact reports the id, and editing a billing field changes only that field", () => {
    render(<Harness initialBilling={{ firstName: "Priya", lastName: "Shah", title: "Controller", email: "priya@tortapalace.com", phone: "555-0000" }} />);
    const select = screen.getByLabelText("Use existing contact") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "c1" } });
    expect(select.value).toBe("c1");

    const phone = screen.getByDisplayValue("555-0000") as HTMLInputElement;
    fireEvent.change(phone, { target: { value: "555-0199" } });
    expect(screen.getByDisplayValue("555-0199")).toBeTruthy();
    // The rest of the billing contact is untouched by that one edit.
    expect(screen.getByDisplayValue("Priya")).toBeTruthy();
    expect(screen.getByDisplayValue("priya@tortapalace.com")).toBeTruthy();
  });

  it("is entirely optional — omitting every billing prop still renders the Owner/Business/Processing sections fine", () => {
    render(
      <MerchantDetailsForm
        business={BLANK_BUSINESS} ownerContact={BLANK_OWNER} processing={BLANK_PROCESSING}
        applied={NO_REVIEW_PREFILL_APPLIED} showProcessing={true}
        onBusinessChange={() => {}} onOwnerChange={() => {}} onProcessingChange={() => {}}
      />
    );
    // No crash, and the Billing dropdown still renders with its default (no
    // contactOptions passed) rather than requiring every caller to supply one.
    expect(screen.getByLabelText("Use existing contact")).toBeTruthy();
  });
});
