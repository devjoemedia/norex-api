// Pure IMEI helpers (no secrets). An IMEI is 15 digits with a Luhn check digit.

export function normalizeImei(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

export function isValidImei(raw: string): boolean {
  const imei = normalizeImei(raw);
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(imei[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

// What staff see by default: only the last four digits.
export function maskImei(last4: string): string {
  return `•••• ${last4}`;
}
