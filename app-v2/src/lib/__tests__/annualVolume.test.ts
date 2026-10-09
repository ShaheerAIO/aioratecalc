import { describe, it, expect } from "vitest";

// Kept in step with `annualVolumeLabel` in app/rep/prospects/new/page.tsx. It
// lives in that file because nothing else needs it; this exists because the
// first version of it was wrong in the direction that makes an implausible
// volume look reasonable — on the control whose only job is to catch one.
const annualVolumeLabel = (monthly: number) => {
  const yearly = monthly * 12;
  return yearly >= 1_000_000_000
    ? `$${(yearly / 1_000_000_000).toFixed(1)}B`
    : `$${(yearly / 1_000_000).toFixed(1)}M`;
};

describe("restating a monthly volume as an annual one", () => {
  it("multiplies by twelve", () => {
    // The reported bug: $1,234,567 a month read as "1.2M a year". It is
    // $14.8M a year — the monthly figure in millions, with no x12 at all.
    expect(annualVolumeLabel(1_234_567)).toBe("$14.8M");
    expect(annualVolumeLabel(1_000_000)).toBe("$12.0M");
    expect(annualVolumeLabel(100_000)).toBe("$1.2M");
  });

  it("switches to billions rather than printing a four-digit M", () => {
    expect(annualVolumeLabel(100_000_000)).toBe("$1.2B");
  });

  it("stays within a rounding step of the true annual figure, across the range it is shown in", () => {
    // Only ever rendered above $1M/month (IMPLAUSIBLE_MONTHLY_VOLUME), so one
    // decimal place of millions is always at least three significant figures.
    for (const monthly of [1_000_000, 1_234_567, 4_500_000, 83_000_000, 250_000_000]) {
      const label = annualVolumeLabel(monthly);
      const unit = label.endsWith("B") ? 1e9 : 1e6;
      const shown = parseFloat(label.replace(/[$MB]/g, "")) * unit;
      expect(Math.abs(shown - monthly * 12)).toBeLessThanOrEqual(unit / 20);
      // And always larger than the monthly figure, which is the sanity the
      // broken version failed: it printed a number SMALLER than the input.
      expect(shown).toBeGreaterThan(monthly);
    }
  });
});
