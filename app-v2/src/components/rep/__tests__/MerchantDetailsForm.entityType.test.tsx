// @vitest-environment jsdom
//
// Entity type (`business.bizType`) now defaults to "" rather than "llc" — an
// unanswered field reads as unanswered instead of asserting a legal entity
// nobody stated (2026-10-13). This just covers MerchantDetailsForm's own
// rendering of that: a placeholder option when blank, and that picking a
// real option still reports it normally.
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

function Harness({ initialBusiness = BLANK_BUSINESS }: { initialBusiness?: BusinessInfo }) {
  const [business, setBusiness] = useState(initialBusiness);
  return (
    <MerchantDetailsForm
      business={business}
      ownerContact={BLANK_OWNER}
      processing={BLANK_PROCESSING}
      applied={NO_REVIEW_PREFILL_APPLIED}
      showProcessing={true}
      onBusinessChange={setBusiness}
      onOwnerChange={() => {}}
      onProcessingChange={() => {}}
    />
  );
}

const entityTypeSelect = () => screen.getByLabelText("Entity type") as HTMLSelectElement;

describe("MerchantDetailsForm — Entity type", () => {
  afterEach(cleanup);

  it("renders a blank placeholder option and selects it when bizType is \"\"", () => {
    render(<Harness />);
    const select = entityTypeSelect();
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "Select…" })).toBeTruthy();
  });

  it("still reports a picked entity type normally", () => {
    render(<Harness />);
    fireEvent.change(entityTypeSelect(), { target: { value: "llc" } });
    expect(entityTypeSelect().value).toBe("llc");
  });

  it("renders the stored value selected when bizType is already set", () => {
    render(<Harness initialBusiness={{ ...BLANK_BUSINESS, bizType: "corp" }} />);
    expect(entityTypeSelect().value).toBe("corp");
  });
});
