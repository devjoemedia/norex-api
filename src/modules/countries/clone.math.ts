// Integer-only FX for the one-time catalog clone (docs/15 "Clone math"):
// target = round_to_step(source × fxRatePpm / 1e6), half-up. No floats in money paths.
export function convertMinor(
  sourceMinor: number,
  fxRatePpm: number,
  roundingStepMinor: number,
): number {
  if (
    !Number.isInteger(sourceMinor) ||
    !Number.isInteger(fxRatePpm) ||
    !Number.isInteger(roundingStepMinor)
  ) {
    throw new Error('convertMinor takes integers only');
  }
  if (fxRatePpm <= 0 || roundingStepMinor < 1)
    throw new Error('fxRatePpm > 0 and roundingStepMinor ≥ 1');
  const scaled = BigInt(sourceMinor) * BigInt(fxRatePpm);
  const unit = 1_000_000n * BigInt(roundingStepMinor);
  const steps = (scaled * 2n + unit) / (unit * 2n); // half-up for non-negative amounts
  return Number(steps * BigInt(roundingStepMinor));
}

// Minor-unit digits differ (GMD 2, GNF 0), so the rate must bridge the exponents:
// ppm per *minor* unit = ppm per major unit × 10^(targetDigits − sourceDigits).
export function minorRatePpm(
  majorRatePpm: number,
  sourceDigits: number,
  targetDigits: number,
): number {
  const shift = targetDigits - sourceDigits;
  return shift >= 0 ? majorRatePpm * 10 ** shift : Math.round(majorRatePpm / 10 ** -shift);
}
