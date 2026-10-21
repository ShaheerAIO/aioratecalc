// @vitest-environment jsdom
//
// The "Same as DBA address" control, reversed back from a one-time copy
// BUTTON to a CHECKBOX (2026-10-13, product owner — see the comment on
// `sameAsOperating` in MerchantDetailsForm.tsx). Three things worth pinning
// down with a real render rather than just reading the source: the initial
// state is computed from whatever the form was handed (never defaults a blank
// form to checked), the sync actually follows further edits to the operating
// address while checked, and unchecking stops that sync without clearing
// anything.
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import MerchantDetailsForm from "@/components/rep/MerchantDetailsForm";
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

// A real controlled wrapper, not a prop-reading shallow render — the sync
// behavior only exists across re-renders, so the test needs the same
// state-lives-in-the-parent shape the real page uses.
function Harness({ initialBusiness }: { initialBusiness: BusinessInfo }) {
  const [business, setBusiness] = useState(initialBusiness);
  const [ownerContact, setOwnerContact] = useState(BLANK_OWNER);
  const [processing, setProcessing] = useState(BLANK_PROCESSING);
  return (
    <MerchantDetailsForm
      business={business}
      ownerContact={ownerContact}
      processing={processing}
      applied={NO_REVIEW_PREFILL_APPLIED}
      showProcessing={true}
      onBusinessChange={setBusiness}
      onOwnerChange={setOwnerContact}
      onProcessingChange={setProcessing}
    />
  );
}

const checkbox = () => screen.getByRole("checkbox", { name: "Same as DBA address" }) as HTMLInputElement;

describe("MerchantDetailsForm — Same as DBA address", () => {
  afterEach(cleanup);

  it("starts UNCHECKED on a blank form — a blank legal address is never asserted as matching", () => {
    render(<Harness initialBusiness={BLANK_BUSINESS} />);
    expect(checkbox().checked).toBe(false);
  });

  it("starts UNCHECKED when the two addresses differ", () => {
    render(<Harness initialBusiness={{
      ...BLANK_BUSINESS,
      dbaAddress: "1 Main St", dbaCity: "Springfield", dbaState: "CA", dbaZip: "90210",
      address: "99 Oak Ave", city: "Springfield", state: "CA", zip: "90210",
    }} />);
    expect(checkbox().checked).toBe(false);
  });

  it("starts UNCHECKED when only the operating address is filled in (legal blank)", () => {
    render(<Harness initialBusiness={{
      ...BLANK_BUSINESS,
      dbaAddress: "1 Main St", dbaCity: "Springfield", dbaState: "CA", dbaZip: "90210",
    }} />);
    expect(checkbox().checked).toBe(false);
  });

  it("starts CHECKED when both addresses are already filled in and identical", () => {
    render(<Harness initialBusiness={{
      ...BLANK_BUSINESS,
      dbaAddress: "1 Main St", dbaCity: "Springfield", dbaState: "CA", dbaZip: "90210",
      address: "1 Main St", city: "Springfield", state: "CA", zip: "90210",
    }} />);
    expect(checkbox().checked).toBe(true);
  });

  it("checking it copies the operating address into the legal fields, hides the legal inputs, and shows a summary", () => {
    render(<Harness initialBusiness={{
      ...BLANK_BUSINESS,
      dbaAddress: "1 Main St", dbaCity: "Springfield", dbaState: "CA", dbaZip: "90210",
    }} />);
    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(true);
    expect(screen.queryByPlaceholderText("The customer fills this in")).toBeNull();
    expect(screen.getByText("1 Main St, Springfield, CA 90210")).toBeTruthy();
  });

  it("stays in sync: editing the operating street address while checked updates the summary too", () => {
    render(<Harness initialBusiness={{
      ...BLANK_BUSINESS,
      dbaAddress: "1 Main St", dbaCity: "Springfield", dbaState: "CA", dbaZip: "90210",
      address: "1 Main St", city: "Springfield", state: "CA", zip: "90210",
    }} />);
    expect(checkbox().checked).toBe(true); // already in sync on mount

    const operatingStreet = screen.getByLabelText("DBA street address") as HTMLInputElement;
    fireEvent.change(operatingStreet, { target: { value: "2 Elm St" } });

    expect(screen.getByText("2 Elm St, Springfield, CA 90210")).toBeTruthy();
  });

  it("unchecking stops the sync, brings the legal fields back, and holds their last value", () => {
    render(<Harness initialBusiness={{
      ...BLANK_BUSINESS,
      dbaAddress: "1 Main St", dbaCity: "Springfield", dbaState: "CA", dbaZip: "90210",
      address: "1 Main St", city: "Springfield", state: "CA", zip: "90210",
    }} />);
    fireEvent.click(checkbox()); // uncheck
    expect(checkbox().checked).toBe(false);

    // The summary line is gone, replaced by the editable field again.
    expect(screen.queryByText("1 Main St, Springfield, CA 90210")).toBeNull();
    const legalStreetInput = screen.getByPlaceholderText("The customer fills this in") as HTMLInputElement;
    expect(legalStreetInput.disabled).toBe(false);
    expect(legalStreetInput.value).toBe("1 Main St"); // held, not cleared

    // Now editing the operating address must NOT reach the legal field.
    const operatingStreet = screen.getByLabelText("DBA street address") as HTMLInputElement;
    fireEvent.change(operatingStreet, { target: { value: "9 Pine Rd" } });
    expect((screen.getByPlaceholderText("The customer fills this in") as HTMLInputElement).value).toBe("1 Main St");

    // And the legal field is independently editable again.
    fireEvent.change(legalStreetInput, { target: { value: "42 Birch Ln" } });
    expect((screen.getByPlaceholderText("The customer fills this in") as HTMLInputElement).value).toBe("42 Birch Ln");
  });

  it("renders no summary line when the mirrored address is still blank", () => {
    // Both addresses empty but "equal" (both blank) never starts checked (see
    // the UNCHECKED-on-a-blank-form test above) — check it by hand instead,
    // so the component is in the checked-but-blank state the guard protects.
    render(<Harness initialBusiness={BLANK_BUSINESS} />);
    fireEvent.click(checkbox());
    expect(checkbox().checked).toBe(true);
    expect(screen.queryByPlaceholderText("The customer fills this in")).toBeNull();
    // No summary paragraph rendered — nothing to echo.
    expect(document.querySelectorAll("section[aria-label='Legal'] p").length).toBe(0);
  });
});
