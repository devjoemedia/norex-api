// Amounts in customer messages: major units with the currency's own decimals
// (GMD 87.08, GNF 7,320,000). Stored values are always integer minor units.
export function formatAmount(minor: number, currency: string): string {
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // unknown code: fall back to 2 decimals
  }
  return (minor / 10 ** digits).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
