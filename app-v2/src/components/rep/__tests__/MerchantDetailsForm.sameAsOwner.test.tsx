// @vitest-environment jsdom
//
// The Billing section's "Same as owner contact" control, reversed from a
// one-time copy BUTTON to a CHECKBOX (2026-10-13, product owner — see the
// comment on `sameAsOwner` in MerchantDetailsForm.tsx, mirroring the earlier
// "Same as operating address" reversal covered by MerchantDetailsForm.test.tsx).
// Pinned down with real renders: the initial state is computed from whatever
// the form was handed (never defaults a blank form to checked), checking
// copies and disables, further owner edits keep mirroring while checked, and
// unchecking stops the sync without clearing anything.
//
// Also covers the "will overwrite this HubSpot contact" note (item 3): it
// must appear only once an existing contact is picked AND a field has
// actually changed from what loaded, and never for a brand-new contact.
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import MerchantDetailsForm from "@/components/rep/MerchantDetailsForm";
import { NO_REVIEW_PREFILL_APPLIED } from "@/lib/prefillMerge";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";

const BLANK_BUSINESS: BusinessInfo = {
  legalName: "", dba: "", bizType: "", address: "", city: "", state: "", zip: "",
  phone: "", website: "", yearsInBusiness: "", annualRevenue: "",
};
const BLANK_OWNER: OwnerContact = { firstName: "", lastName: "", title: "", email: "", phone: "" };
const BLANK_PROCESSING: ProcessingInfo = {
  monthlyVolume: "", avgTicket: "", cardPresentPct: "95", mcc: "", businessDescription: "",
  previouslyTerminated: "no", bankruptcy: "no", currentProcessor: "",
};

// A real controlled wrapper — the sync behavior only exists across
// re-renders, same reasoning as the address-checkbox harness.
function Harness({
  initialOwner = BLANK_OWNER,
  initialBilling = BLANK_OWNER,
  billingContactLoaded = null,
  initialBillingContactId = null,
}: {
  initialOwner?: OwnerContact;
  initialBilling?: OwnerContact;
  billingContactLoaded?: OwnerContact | null;
  initialBillingContactId?: string | null;
}) {
  const [ownerContact, setOwnerContact] = useState(initialOwner);
  const [billingContactId, setBillingContactId] = useState<string | null>(initialBillingContactId);
  const [billing, setBilling] = useState(initialBilling);
  return (
    <MerchantDetailsForm
      business={BLANK_BUSINESS}
      ownerContact={ownerContact}
      processing={BLANK_PROCESSING}
      applied={NO_REVIEW_PREFILL_APPLIED}
      showProcessing={true}
      onBusinessChange={() => {}}
      onOwnerChange={setOwnerContact}
      onProcessingChange={() => {}}
      billingContactId={billingContactId}
      billing={billing}
      billingContactLoaded={billingContactLoaded}
      onBillingContactIdChange={setBillingContactId}
      onBillingChange={setBilling}
    />
  );
}

const checkbox = () => screen.getByRole("checkbox", { name: "Same as owner contact" }) as HTMLInputElement;
const ownerFirstName = () => screen.getAllByLabelText("First name")[0] as HTMLInputElement;
const billingFirstName = () => screen.getAllByLabelText("First name")[1] as HTMLInputElement;

describe("MerchantDetailsForm — Same as owner contact", () => {
  afterEach(cleanup);

  it("starts UNCHECKED on a blank form — a blank billing contact is never asserted as matching", () => {
    render(<Harness />);
    expect(checkbox().checked).toBe(false);
  });

  it("starts UNCHECKED when the owner and billing contacts differ", () => {
    render(<Harness
      initialOwner={{ firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@biz.com", phone: "555-0101" }}
      initialBilling={{ firstName: "Priya", lastName: "Shah", title: "Controller", email: "priya@biz.com", phone: "555-0000" }}
    />);
    expect(checkbox().checked).toBe(false);
  });

  it("starts UNCHECKED when only the owner contact is filled in (billing blank)", () => {
    render(<Harness
      initialOwner={{ firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@biz.com", phone: "555-0101" }}
    />);
    expect(checkbox().checked).toBe(false);
  });

  it("starts CHECKED when both contacts are already filled in and identical", () => {
    const contact: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@biz.com", phone: "555-0101" };
    render(<Harness initialOwner={contact} initialBilling={{ ...contact }} />);
    expect(checkbox().checked).toBe(true);
  });

  it("checking it copies the owner contact into the billing fields and disables them", () => {
    render(<Harness initialOwner={{ firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@biz.com", phone: "555-0101" }} />);
    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(true);
    const billing = billingFirstName();
    expect(billing.value).toBe("Ana");
    expect(billing.disabled).toBe(true);
  });

  it("stays in sync: editing the owner contact while checked updates the billing contact too", () => {
    const contact: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@biz.com", phone: "555-0101" };
    render(<Harness initialOwner={contact} initialBilling={{ ...contact }} />);
    expect(checkbox().checked).toBe(true); // already in sync on mount

    fireEvent.change(ownerFirstName(), { target: { value: "Diego" } });

    expect(billingFirstName().value).toBe("Diego");
  });

  it("unchecking stops the sync and leaves the billing fields independently editable, holding their last value", () => {
    const contact: OwnerContact = { firstName: "Ana", lastName: "Reyes", title: "Owner", email: "ana@biz.com", phone: "555-0101" };
    render(<Harness initialOwner={contact} initialBilling={{ ...contact }} />);
    fireEvent.click(checkbox()); // uncheck
    expect(checkbox().checked).toBe(false);

    const billing = billingFirstName();
    expect(billing.disabled).toBe(false);
    expect(billing.value).toBe("Ana"); // held, not cleared

    // Editing the owner contact must NOT reach the billing field any more.
    fireEvent.change(ownerFirstName(), { target: { value: "Diego" } });
    expect(billingFirstName().value).toBe("Ana");

    // And the billing field is independently editable again.
    fireEvent.change(billingFirstName(), { target: { value: "Marco" } });
    expect(billingFirstName().value).toBe("Marco");
  });
});

describe("MerchantDetailsForm — billing contact overwrite warning", () => {
  afterEach(cleanup);

  const LOADED: OwnerContact = { firstName: "Priya", lastName: "Shah", title: "", email: "priya@biz.com", phone: "555-0000" };

  it("does not appear for a brand-new contact (no billingContactId)", () => {
    render(<Harness initialBilling={{ ...LOADED, firstName: "Changed" }} billingContactLoaded={null} />);
    expect(screen.queryByText(/update this contact/i)).toBeNull();
  });

  it("does not appear when an existing contact is picked but nothing has changed", () => {
    render(<Harness
      initialBillingContactId="c1"
      initialBilling={{ ...LOADED }}
      billingContactLoaded={LOADED}
    />);
    expect(screen.queryByText(/update this contact/i)).toBeNull();
  });

  it("appears once an existing contact's field is edited away from what loaded", () => {
    render(<Harness
      initialBillingContactId="c1"
      initialBilling={{ ...LOADED, phone: "555-9999" }}
      billingContactLoaded={LOADED}
    />);
    expect(screen.getByText(/update this contact/i)).toBeTruthy();
  });
});
