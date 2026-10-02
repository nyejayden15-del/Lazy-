// Import transactions from a CSV export (Cash App statements, or any bank's CSV) and find recurring charges in them.
// Used for accounts Plaid can't reach.
import { classifyOutflow } from './classify.js';
import { round2, daysBetween, toMonthly, nextAfter } from './money.js';

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function findCol(headers, candidates) {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}

function parseAmount(s) {
  if (s == null) return NaN;
  let t = String(s).trim();
  const paren = /^\(.*\)$/.test(t);
  t = t.replace(/[()$,\s]/g, '');
  const n = Number(t);
  return paren ? -n : n;
}

function parseDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

// Cash App activity types that are just moving your own money around.
const IGNORED_TYPES = ['cash out', 'cash in', 'transfer', 'bitcoin', 'stock', 'savings', 'round up'];

/**
 * Turn CSV text into normalized transactions. Negative amounts in the file are money out
 * (Cash App and most banks); we flip to "positive = money out" to match Plaid.
 */
export function transactionsFromCsv(text, { institution = 'CSV import' } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV has no data rows.');
  const headers = rows[0];
  const dateCol = findCol(headers, ['date', 'transaction date', 'posted date', 'posting date']);
  const amountCol = findCol(headers, ['net amount', 'amount', 'transaction amount']);
  const nameCol = findCol(headers, ['name of sender/receiver', 'description', 'payee', 'merchant', 'name', 'notes', 'memo']);
  const notesCol = findCol(headers, ['notes', 'memo']);
  const typeCol = findCol(headers, ['transaction type', 'type']);
  const statusCol = findCol(headers, ['status']);
  if (dateCol === -1 || amountCol === -1) {
    throw new Error(`Could not find Date and Amount columns. Found: ${headers.join(', ')}`);
  }

  const out = [];
  for (const r of rows.slice(1)) {
    const date = parseDate(r[dateCol]);
    const amt = parseAmount(r[amountCol]);
    if (!date || !Number.isFinite(amt) || amt === 0) continue;
    const status = statusCol === -1 ? '' : (r[statusCol] || '').toLowerCase();
    if (/(fail|cancel|declin|refund)/.test(status)) continue;
    const type = typeCol === -1 ? '' : (r[typeCol] || '').toLowerCase();
    const isTransfer = IGNORED_TYPES.some((t) => type.includes(t));
    const name = (r[nameCol] || '').trim() || (notesCol !== -1 ? (r[notesCol] || '').trim() : '') || 'Unknown';
    const isIncome = amt > 0 && /(direct deposit|payroll|salary|paycheck)/.test(`${type} ${name.toLowerCase()}`);
    out.push({
      date,
      amount: round2(-amt),
      name,
      primary: isTransfer ? 'TRANSFER_OUT' : isIncome ? 'INCOME' : null,
      detailed: null,
      accountId: `csv:${institution}`,
      institution,
    });
  }
  if (!out.length) throw new Error('No usable transactions found in the CSV.');
  return out;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function frequencyFor(interval) {
  if (interval >= 6 && interval <= 8) return 'WEEKLY';
  if (interval >= 13 && interval <= 16) return 'BIWEEKLY';
  if (interval >= 26 && interval <= 35) return 'MONTHLY';
  if (interval >= 350 && interval <= 380) return 'ANNUALLY';
  return null;
}

const normalizeName = (n) => n.toLowerCase().replace(/[#*\d]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Find charges/income that repeat on a regular schedule with a steady amount. */
export function detectRecurring(transactions, { now = new Date() } = {}) {
  const groups = new Map();
  for (const t of transactions) {
    if (t.primary === 'TRANSFER_OUT') continue;
    const key = `${t.amount > 0 ? 'out' : 'in'}|${normalizeName(t.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const streams = [];
  for (const [key, list] of groups) {
    const minCount = key.startsWith('in') ? 2 : 3;
    if (list.length < minCount) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const intervals = list.slice(1).map((t, i) => daysBetween(list[i].date, t.date));
    const frequency = frequencyFor(median(intervals));
    if (!frequency) continue;
    const amounts = list.map((t) => Math.abs(t.amount));
    const typical = median(amounts);
    if (amounts.some((a) => Math.abs(a - typical) > typical * 0.2)) continue; // amount too irregular

    const last = list[list.length - 1];
    const isIncome = key.startsWith('in');
    const kind = isIncome ? 'income' : classifyOutflow({ name: last.name });
    if (kind === 'ignore') continue;
    const amount = round2(Math.abs(last.amount));
    streams.push({
      id: `csv:${key}`,
      institution: last.institution,
      accountId: last.accountId,
      name: last.name,
      kind,
      frequency,
      amount,
      monthlyAmount: toMonthly(amount, frequency),
      lastDate: last.date,
      nextDate: nextAfter(last.date, frequency, now),
      category: null,
      confidence: list.length >= 4 ? 'high' : 'early',
    });
  }
  return streams;
}
