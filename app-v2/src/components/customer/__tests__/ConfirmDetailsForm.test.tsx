// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/lib/actions/leadConfirm", () => ({ confirmLeadDetailsAction: vi.fn() }));

import ConfirmDetailsForm from "@/components/customer/ConfirmDetailsForm";

afterEach(cleanup);

describe("ConfirmDetailsForm section order", () => {
  it("renders the Billing Contact section first (product owner, 2026-10-29)", () => {
    const { container } = render(
      <ConfirmDetailsForm
        token="t"
        initial={{ business: {}, ownerContact: {}, billingContact: null, processing: {} }}
        businessName="Acme"
        monthlyVolume={null}
        avgTicket={null}
      />,
    );
    const titles = Array.from(container.querySelectorAll("h2")).map(h => h.textContent);
    expect(titles[0]).toBe("Billing Contact");
    expect(titles.indexOf("Your Business")).toBeGreaterThan(0);
    expect(titles.indexOf("Owner & Signer")).toBeGreaterThan(0);
  });
});
