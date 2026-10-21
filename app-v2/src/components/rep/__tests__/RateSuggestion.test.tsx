// @vitest-environment jsdom
//
// RateSuggestion — 2026-10-13, "get rid of the 'use it' and make it always
// override". Both gates that used to exist are gone: the `autoApply` prop
// (previously true only on the two quote-STARTING surfaces) and the
// "untouched at the flat default" check that protected a rep's own typed
// rate. These tests simulate exactly the case EditQuotePanel used to opt out
// of — a rate that's already something OTHER than the flat default — and
// confirm the suggestion overwrites it anyway, with no button to click first.
import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { DEFAULT_QUOTE_RATES, type QuoteRates } from "@/types/merchant";

const SUGGESTED: QuoteRates = {
  cardPresentRate: 0.0217,
  cardNotPresentRate: 0.033,
  amexCardPresentRate: 0.0217,
  amexCardNotPresentRate: 0.033,
  perTransactionFee: 0.15,
};

vi.mock("@/lib/actions/rateMatrix", () => ({
  getSuggestedRatesAction: vi.fn(async () => ({
    rates: SUGGESTED,
    volumeBand: "$100K – $125K",
    ticketColumn: 20,
  })),
}));

// Imported AFTER the mock so the mocked module is what RateSuggestion gets.
import RateSuggestion from "@/components/rep/RateSuggestion";

// A STORED, already-chosen rate — the shape EditQuotePanel reopens with.
// Deliberately NOT the flat default and NOT equal to SUGGESTED, so the old
// "untouched" gate would have refused to touch it.
const ALREADY_CHOSEN: QuoteRates = {
  cardPresentRate: 0.0299,
  cardNotPresentRate: 0.0299,
  amexCardPresentRate: 0.0299,
  amexCardNotPresentRate: 0.0299,
  perTransactionFee: 0.2,
};

function Harness({ initial }: { initial: QuoteRates }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RateSuggestion monthlyVolume={110_000} avgTicket={22} value={value} onChange={setValue} />
      <output data-testid="cp">{value.cardPresentRate}</output>
    </>
  );
}

describe("RateSuggestion", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); });

  it("applies the suggestion even over a rate someone already chose and saved", async () => {
    render(<Harness initial={ALREADY_CHOSEN} />);
    await waitFor(() => {
      expect(screen.getByTestId("cp").textContent).toBe(String(SUGGESTED.cardPresentRate));
    });
  });

  it("applies the suggestion over the flat default too (the old autoApply=true case still works)", async () => {
    render(<Harness initial={DEFAULT_QUOTE_RATES} />);
    await waitFor(() => {
      expect(screen.getByTestId("cp").textContent).toBe(String(SUGGESTED.cardPresentRate));
    });
  });

  it("renders NOTHING at all — it is a headless applier (2026-10-14)", async () => {
    // It used to print "Rate card: 2.17% ... for $100K – $125K a month at a
    // $20+ ticket". The product owner asked for the grey volume/ticket bucket
    // to go, and without it the rest of the line duplicated the rate boxes
    // directly above it — the card always overrides, so those boxes ARE the
    // rate card. What's asserted here is that it still APPLIES while showing
    // nothing, which is the whole of its job now.
    const { container } = render(<Harness initial={ALREADY_CHOSEN} />);
    await waitFor(() => {
      expect(screen.getByTestId("cp").textContent).toBe(String(SUGGESTED.cardPresentRate));
    });
    expect(screen.queryByText(/rate card/i)).toBeNull();
    expect(screen.queryByText(/\$100K/)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // The harness's own <output> is all that's left in the tree.
    expect(container.querySelectorAll("p")).toHaveLength(0);
  });

  it("takes no autoApply prop any more — TypeScript aside, passing one does nothing extra", async () => {
    const onChange = vi.fn();
    // @ts-expect-error — autoApply was removed from RateSuggestionProps.
    render(<RateSuggestion monthlyVolume={110_000} avgTicket={22} value={ALREADY_CHOSEN} onChange={onChange} autoApply />);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(SUGGESTED));
  });

  it("renders nothing with no volume/ticket basis, and never calls onChange", async () => {
    const onChange = vi.fn();
    render(<RateSuggestion monthlyVolume={0} avgTicket={0} value={ALREADY_CHOSEN} onChange={onChange} />);
    await new Promise(r => setTimeout(r, 300));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("stacks a ± bps adjustment on the card's card-present rate", async () => {
    const onChange = vi.fn();
    render(<RateSuggestion monthlyVolume={110_000} avgTicket={22} value={ALREADY_CHOSEN} onChange={onChange} adjustmentBps={-12} />);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0].cardPresentRate).toBeCloseTo(0.0205, 10);
    expect(onChange.mock.calls[0][0].cardNotPresentRate).toBe(SUGGESTED.cardNotPresentRate);
  });

  it("adoptSaved keeps a reopened quote's saved rate and reports the gap as the adjustment", async () => {
    const onChange = vi.fn();
    const onAdj = vi.fn();
    // Saved at 2.29% where the card says 2.17% -> +12 bps.
    const saved = { ...SUGGESTED, cardPresentRate: 0.0229, amexCardPresentRate: 0.0229 };
    render(<RateSuggestion monthlyVolume={110_000} avgTicket={22} value={saved} onChange={onChange} onAdjustmentChange={onAdj} adoptSaved />);
    await waitFor(() => expect(onAdj).toHaveBeenCalledWith(12));
    expect(onChange).not.toHaveBeenCalled();
  });
});
