// @vitest-environment jsdom
//
// RateFields — three changes, all 2026-10-13:
//   1. "lock cnp rates": card-not-present renders disabled and a rep's edit
//      attempt (a fireEvent.change against a disabled input, which jsdom
//      still lets a test dispatch even though a real browser blocks the
//      keystroke) must not reach onChange.
//   2. "get rid of the dual rate (amex)": there is no AMEX row at all any
//      more, and editing card-present never touches the AMEX fields —
//      nothing should WRITE a divergent AMEX value.
//   3. Same-day follow-up fix: locking CNP turned the flat 2.49% starting
//      value into an unfixable wrong number on any fresh quote where a rep
//      hadn't yet entered both a volume AND a ticket (RateSuggestion's
//      fuller lookup needs both). `freshQuote` closes that — see the describe
//      block below — by confirming AIO's flat CNP policy directly, and
//      leaving the box EDITABLE (not locked) until that's confirmed.
import { describe, it, expect, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { DEFAULT_QUOTE_RATES, type QuoteRates } from "@/types/merchant";

const getCnpPolicyRateAction = vi.fn<() => Promise<number>>();
vi.mock("@/lib/actions/rateMatrix", () => ({
  getCnpPolicyRateAction: () => getCnpPolicyRateAction(),
}));

// Imported AFTER the mock so RateFields gets the mocked action.
import RateFields from "@/components/rep/RateFields";

const STORED: QuoteRates = {
  cardPresentRate: 0.0217,
  cardNotPresentRate: 0.033,
  amexCardPresentRate: 0.0217,
  amexCardNotPresentRate: 0.033,
  perTransactionFee: 0.15,
};

function Harness({ initial }: { initial: QuoteRates }) {
  const [value, setValue] = useState(initial);
  return <RateFields value={value} onChange={setValue} />;
}

describe("RateFields", () => {
  afterEach(() => { cleanup(); getCnpPolicyRateAction.mockReset(); });

  it("never calls the CNP policy fetch for a saved quote (no freshQuote)", () => {
    render(<Harness initial={STORED} />);
    expect(getCnpPolicyRateAction).not.toHaveBeenCalled();
  });

  it("shows no AMEX row — two rate boxes, not four", () => {
    render(<Harness initial={STORED} />);
    expect(screen.queryByLabelText(/amex/i)).toBeNull();
    expect(screen.getByLabelText("Card present rate, percent")).toBeTruthy();
    expect(screen.getByLabelText(/Card not present rate, percent/)).toBeTruthy();
  });

  it("renders the card-not-present rate disabled", () => {
    render(<Harness initial={STORED} />);
    const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
    expect(cnp.disabled).toBe(true);
  });

  it("displays a SAVED quote's own CNP value rather than substituting a different one", () => {
    // A quote saved at 3.30% must still show 3.30%, even though that isn't
    // DEFAULT_QUOTE_RATES' 2.49% — RateFields never rewrites it.
    render(<Harness initial={STORED} />);
    const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
    expect(cnp.value).toBe("3.30");
  });

  it("never fires onChange from the locked CNP box", () => {
    let changes = 0;
    function Spy() {
      const [value, setValue] = useState(STORED);
      return <RateFields value={value} onChange={next => { changes++; setValue(next); }} />;
    }
    render(<Spy />);
    const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
    fireEvent.change(cnp, { target: { value: "9.99" } });
    expect(changes).toBe(0);
  });

  it("leaves the card-present rate editable and never touches the AMEX fields when it changes", () => {
    let last: QuoteRates = STORED;
    function Spy() {
      const [value, setValue] = useState(STORED);
      return <RateFields value={value} onChange={next => { last = next; setValue(next); }} />;
    }
    render(<Spy />);
    const cp = screen.getByLabelText("Card present rate, percent") as HTMLInputElement;
    fireEvent.change(cp, { target: { value: "2.75" } });
    fireEvent.blur(cp);
    expect(last.cardPresentRate).toBeCloseTo(0.0275, 6);
    // AMEX fields are untouched by the edit — still whatever they were before,
    // not re-derived from the new card-present rate.
    expect(last.amexCardPresentRate).toBe(STORED.amexCardPresentRate);
    expect(last.amexCardNotPresentRate).toBe(STORED.amexCardNotPresentRate);
    // And the locked CNP rate is untouched too.
    expect(last.cardNotPresentRate).toBe(STORED.cardNotPresentRate);
  });

  it("shows the flat default note mentioning the lock, unless hideNote is set", () => {
    render(<Harness initial={DEFAULT_QUOTE_RATES} />);
    expect(screen.getByText(/isn.t rep-editable/)).toBeTruthy();
  });
});

// freshQuote — the no-basis bug: a brand-new quote starts at
// DEFAULT_QUOTE_RATES' flat 2.49% CNP, which is NOT AIO's policy (3.30% by
// default here). Before the lock a rep could type over a wrong starting
// number; locked, they couldn't, so a quote where RateSuggestion's fuller
// lookup never got a volume+ticket basis sat on a silently-wrong number
// nobody could fix. These tests render with NO volume/ticket at all —
// RateSuggestion is irrelevant here — and exercise RateFields' own
// independent confirmation of the flat CNP rate.
describe("RateFields — freshQuote (closing the no-basis CNP gap)", () => {
  afterEach(() => { cleanup(); getCnpPolicyRateAction.mockReset(); });

  function FreshHarness({ initial = DEFAULT_QUOTE_RATES }: { initial?: QuoteRates }) {
    const [value, setValue] = useState(initial);
    return <RateFields value={value} onChange={setValue} freshQuote />;
  }

  it("starts EDITABLE, not locked on the flat 2.49% default, while policy hasn't confirmed yet", () => {
    getCnpPolicyRateAction.mockReturnValue(new Promise(() => {})); // never resolves
    render(<FreshHarness />);
    const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
    expect(cnp.disabled).toBe(false);
    expect(cnp.value).toBe("2.49");
  });

  it("confirms and LOCKS at the live policy figure (3.30%), not the 2.49% placeholder", async () => {
    getCnpPolicyRateAction.mockResolvedValue(0.033);
    render(<FreshHarness />);
    await waitFor(() => {
      const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
      expect(cnp.disabled).toBe(true);
      expect(cnp.value).toBe("3.30");
    });
  });

  it("mirrors the confirmed CNP onto the AMEX field too, never leaving it on the old placeholder", async () => {
    getCnpPolicyRateAction.mockResolvedValue(0.033);
    let last: QuoteRates = DEFAULT_QUOTE_RATES;
    function Spy() {
      const [value, setValue] = useState(DEFAULT_QUOTE_RATES);
      return <RateFields value={value} onChange={next => { last = next; setValue(next); }} freshQuote />;
    }
    render(<Spy />);
    await waitFor(() => expect(last.cardNotPresentRate).toBeCloseTo(0.033, 6));
    expect(last.amexCardNotPresentRate).toBeCloseTo(0.033, 6);
  });

  it("never calls onChange with the fetched rate if the rep already typed something else", async () => {
    let resolvePolicy: (n: number) => void = () => {};
    getCnpPolicyRateAction.mockReturnValue(new Promise(r => { resolvePolicy = r; }));
    let last: QuoteRates = DEFAULT_QUOTE_RATES;
    function Spy() {
      const [value, setValue] = useState(DEFAULT_QUOTE_RATES);
      return <RateFields value={value} onChange={next => { last = next; setValue(next); }} freshQuote />;
    }
    render(<Spy />);
    const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
    expect(cnp.disabled).toBe(false);
    fireEvent.change(cnp, { target: { value: "2.90" } });
    fireEvent.blur(cnp);
    expect(last.cardNotPresentRate).toBeCloseTo(0.029, 6);
    resolvePolicy(0.033);
    // Give the already-resolved promise a tick to settle, then assert the
    // rep's own typed value survived rather than being clobbered.
    await new Promise(r => setTimeout(r, 0));
    expect(last.cardNotPresentRate).toBeCloseTo(0.029, 6);
  });

  it("STAYS EDITABLE and never locks an unverified number when the policy fetch fails", async () => {
    getCnpPolicyRateAction.mockRejectedValue(new Error("network down"));
    render(<FreshHarness />);
    await waitFor(() => expect(screen.getByText(/Could not confirm/)).toBeTruthy());
    const cnp = screen.getByLabelText(/Card not present rate, percent/) as HTMLInputElement;
    expect(cnp.disabled).toBe(false);
    // Still showing the placeholder — but editable, so a rep can fix it,
    // which is the whole point: a locked wrong number is the failure mode
    // being avoided, not an unlocked placeholder.
    expect(cnp.value).toBe("2.49");
  });
});
