/**
 * Cell values are numeric(24,6). Snapshot files carry them as decimal text; this turns any
 * decimal spelling ("1e2", "+100", " 100", "100.0000004") into the text Postgres prints for
 * numeric(24,6) — "100.000000" — rounding half away from zero as Postgres does. Returns null
 * for anything that is not a finite number in range (NaN, Infinity, 1e30, words).
 */
const DECIMAL = /^\s*([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,6}))?\s*$/;
const MAX_INT_DIGITS = 18;
const SCALE = 6;

export function canonicalDecimal(input: string | number): string | null {
  const text = typeof input === 'number' ? (Number.isFinite(input) ? input.toString() : '') : input;
  const m = DECIMAL.exec(text);
  if (!m || (!m[2] && !m[3])) return null;
  const negative = m[1] === '-';
  let digits = (m[2] ?? '') + (m[3] ?? '');
  let point = (m[2] ?? '').length + (m[4] ? Number(m[4]) : 0); // decimal point position within digits
  if (point < -SCALE - 2) return zero(); // far below the smallest step
  if (point > MAX_INT_DIGITS + digits.length + 1) return null;
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  let whole = digits.slice(0, point) || '0';
  let frac = digits.slice(point);
  if (frac.length > SCALE) {
    const up = frac.charCodeAt(SCALE) >= 53; // '5'
    frac = frac.slice(0, SCALE);
    if (up) {
      const all = (whole + frac).split('');
      let i = all.length - 1;
      for (; i >= 0; i--) {
        if (all[i] === '9') all[i] = '0';
        else {
          all[i] = String(Number(all[i]) + 1);
          break;
        }
      }
      const joined = (i < 0 ? '1' : '') + all.join('');
      whole = joined.slice(0, joined.length - SCALE);
      frac = joined.slice(joined.length - SCALE);
    }
  }
  frac = frac.padEnd(SCALE, '0');
  whole = whole.replace(/^0+(?=\d)/, '');
  if (whole.length > MAX_INT_DIGITS) return null;
  const isZero = /^0+$/.test(whole) && /^0+$/.test(frac);
  return `${negative && !isZero ? '-' : ''}${whole}.${frac}`;
}

function zero(): string {
  return `0.${'0'.repeat(SCALE)}`;
}

/**
 * Exact display rounding for reports: the decimal text of a value divided by 10^shift, rounded half
 * away from zero to `decimals` places (as Postgres and Excel round), as a number. Working on the
 * digits avoids binary floating point (1,005 / 1,000 to 2 places is 1.01, -1,500 to 0 places is -2).
 */
export function shiftRound(text: string, shift: number, decimals: number): number {
  const m = DECIMAL.exec(text);
  if (!m || (!m[2] && !m[3])) return Number.NaN;
  const negative = m[1] === '-';
  let digits = (m[2] ?? '') + (m[3] ?? '');
  let point = (m[2] ?? '').length + (m[4] ? Number(m[4]) : 0) - shift;
  if (point < 0) { digits = '0'.repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const keep = point + decimals;
  let kept = digits.slice(0, keep).padEnd(keep, '0').split('');
  if (digits.charCodeAt(keep) >= 53) { // the next digit is 5 or more: away from zero
    let i = kept.length - 1;
    for (; i >= 0; i--) {
      if (kept[i] === '9') kept[i] = '0';
      else { kept[i] = String(Number(kept[i]) + 1); break; }
    }
    if (i < 0) { kept = ['1', ...kept]; point++; }
  }
  const all = kept.join('');
  const whole = all.slice(0, all.length - decimals) || '0';
  const frac = all.slice(all.length - decimals);
  const value = Number(`${whole}${frac ? `.${frac}` : ''}`);
  return negative && value !== 0 ? -value : 0 + value;
}
