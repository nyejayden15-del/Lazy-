// Small shared helpers for amounts, dates and recurring frequencies.

const PER_MONTH = {
  WEEKLY: 52 / 12,
  BIWEEKLY: 26 / 12,
  SEMI_MONTHLY: 2,
  MONTHLY: 1,
  ANNUALLY: 1 / 12,
};

/** Convert a per-occurrence amount at a given frequency into a monthly amount. */
export function toMonthly(amount, frequency) {
  const factor = PER_MONTH[frequency] ?? 1;
  return round2(Math.abs(amount) * factor);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function sum(list, pick = (x) => x) {
  return round2(list.reduce((acc, x) => acc + (Number(pick(x)) || 0), 0));
}

/** YYYY-MM-DD for a Date (local time). */
export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseIsoDate(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function daysBetween(a, b) {
  return Math.round((parseIsoDate(b) - parseIsoDate(a)) / 86_400_000);
}

/**
 * Roll a predicted date forward by the stream's frequency until it is on or after `from`.
 * Plaid's predicted_next_date can be stale if the account hasn't synced recently.
 */
export function nextOccurrence(dateStr, frequency, from = new Date()) {
  if (!dateStr) return null;
  const stepDays = { WEEKLY: 7, BIWEEKLY: 14, SEMI_MONTHLY: 15 }[frequency];
  let d = parseIsoDate(dateStr);
  const today = parseIsoDate(isoDate(from));
  let guard = 0;
  while (d < today && guard++ < 500) {
    if (stepDays) d = addDays(d, stepDays);
    else if (frequency === 'ANNUALLY') d.setFullYear(d.getFullYear() + 1);
    else d.setMonth(d.getMonth() + 1);
  }
  return isoDate(d);
}

/** The next occurrence strictly after `lastDate` that is not in the past. */
export function nextAfter(lastDate, frequency, now = new Date()) {
  if (!lastDate) return null;
  const dayAfter = addDays(parseIsoDate(lastDate), 1);
  return nextOccurrence(lastDate, frequency, dayAfter > now ? dayAfter : now);
}
