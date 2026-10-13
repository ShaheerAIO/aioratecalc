// @vitest-environment jsdom
//
// DecimalMoneyField — added 2026-10-13 ("make avg ticket writeable like
// volume... no arrows"). Average Ticket used to be a DecimalField
// (type="number", native spinner arrows, force-reformats to "0.00" on blur),
// which meant the box could never actually be emptied: blurring an emptied
// box snapped it straight back to "0.00" before a rep could retype it. These
// tests pin down the three things the product owner asked for directly:
// free-typed, no arrows (type="text", not "number"), and a value you can
// actually clear.
import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DecimalField, DecimalMoneyField } from "@/components/rep/NumberField";

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <DecimalMoneyField value={value} onChange={setValue} aria-label="Average ticket, dollars" />;
}

describe("DecimalMoneyField", () => {
  afterEach(cleanup);

  it("is a text input, not a native number spinner", () => {
    render(<Harness initial="" />);
    const input = screen.getByLabelText("Average ticket, dollars") as HTMLInputElement;
    expect(input.type).toBe("text");
  });

  it("can be cleared and stays empty — the bug DecimalField had", () => {
    render(<Harness initial="22.50" />);
    const input = screen.getByLabelText("Average ticket, dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.blur(input);
    // DecimalField would have snapped this back to "0.00" on blur.
    expect(input.value).toBe("");
  });

  it("keeps a half-typed decimal point while focused, unlike a reformat-on-blur field", () => {
    render(<Harness initial="" />);
    const input = screen.getByLabelText("Average ticket, dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "22." } });
    expect(input.value).toBe("22.");
  });

  it("strips a pasted dollar sign but keeps the decimal", () => {
    render(<Harness initial="" />);
    const input = screen.getByLabelText("Average ticket, dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "$22.50" } });
    expect(input.value).toBe("22.50");
  });

  it("drops a second decimal point rather than moving the cursor somewhere confusing", () => {
    render(<Harness initial="" />);
    const input = screen.getByLabelText("Average ticket, dollars") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2.2.5" } });
    expect(input.value).toBe("2.25");
  });

  it("reports the raw string back to the host unchanged — no number round-trip", () => {
    let seen: string | null = null;
    function Spy() {
      const [value, setValue] = useState("");
      return (
        <DecimalMoneyField
          value={value}
          onChange={v => { setValue(v); seen = v; }}
          aria-label="ticket"
        />
      );
    }
    render(<Spy />);
    fireEvent.change(screen.getByLabelText("ticket"), { target: { value: "7.5" } });
    expect(seen).toBe("7.5");
  });
});

// DecimalField itself is unchanged for every RATE field (2026-10-13's reversal
// note: "that discipline must STILL APPLY TO THE RATE FIELDS"). One test here
// as a guard against someone "simplifying" it the same way in the future.
describe("DecimalField (unchanged — rates still force two decimals)", () => {
  afterEach(cleanup);

  it("is a native number input and snaps an emptied box back to a fixed-decimal zero on blur", () => {
    function Harness2() {
      const [value, setValue] = useState(2.49);
      return <DecimalField value={value} onChange={setValue} aria-label="rate" />;
    }
    render(<Harness2 />);
    const input = screen.getByLabelText("rate") as HTMLInputElement;
    expect(input.type).toBe("number");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("0.00");
  });

  it("can be disabled for a locked rate (RateFields' card-not-present box)", () => {
    function Harness3() {
      const [value, setValue] = useState(0.033);
      return <DecimalField value={value} onChange={setValue} disabled aria-label="locked rate" />;
    }
    render(<Harness3 />);
    const input = screen.getByLabelText("locked rate") as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
