import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { simulatePayoff, prepareDebts, buildPlan } from '../lib/planner.js';
import { parseCsv, transactionsFromCsv, detectRecurring } from '../lib/csvImport.js';
import { classifyOutflow } from '../lib/classify.js';
import { toMonthly, nextAfter } from '../lib/money.js';
import { Store } from '../lib/store.js';
import { syncItem } from '../lib/plaidSync.js';
import { buildDashboard } from '../lib/dashboard.js';
import { demoSources } from '../lib/demoData.js';

const NOW = new Date(2026, 9, 2); // Oct 2 2026

test('payoff: single debt at 0% pays off in balance / payment months', () => {
  const r = simulatePayoff([{ name: 'A', balance: 1000, apr: 0, minPayment: 100 }], 0);
  assert.equal(r.months, 10);
  assert.equal(r.totalInterest, 0);
  assert.equal(r.series.at(-1), 0);
});

test('payoff: interest matches standard amortization', () => {
  // $5,000 at 12% APR, $200/month: n = -ln(1 - 0.01*5000/200)/ln(1.01) = 28.9 payments -> ~$782 interest
  const r = simulatePayoff([{ name: 'A', balance: 5000, apr: 12, minPayment: 200 }], 0);
  assert.equal(r.months, 29);
  assert.ok(Math.abs(r.totalInterest - 782) < 5, `interest ${r.totalInterest}`);
});

test('payoff: avalanche never pays more interest than snowball', () => {
  const debts = [
    { name: 'small low', balance: 500, apr: 10, minPayment: 25 },
    { name: 'big high', balance: 4000, apr: 28, minPayment: 100 },
  ];
  const av = simulatePayoff(debts, 300, 'avalanche');
  const sn = simulatePayoff(debts, 300, 'snowball');
  assert.equal(av.order[0].name, 'big high');
  assert.equal(sn.order[0].name, 'small low');
  assert.ok(av.totalInterest <= sn.totalInterest);
});

test('payoff: payment below interest is flagged infeasible', () => {
  const r = simulatePayoff([{ name: 'A', balance: 10000, apr: 30, minPayment: 100 }], 0);
  assert.equal(r.feasible, false);
  assert.equal(r.months, null);
});

test('prepareDebts estimates missing APR and minimum', () => {
  const [d] = prepareDebts([{ name: 'Card', kind: 'credit', balance: 2000, apr: null, minPayment: null }]);
  assert.equal(d.apr, 24);
  assert.ok(d.aprEstimated && d.minEstimated);
  assert.ok(d.minPayment > (2000 * 24) / 1200, 'estimated minimum must exceed monthly interest');
});

test('plan flags shortfall, overdue debt and missing income', () => {
  const p = buildPlan({
    monthlyIncome: 2000, monthlyLivingCosts: 2100, monthlyEssentials: 1500, cash: 200, investments: 0,
    debts: [{ name: 'Card', kind: 'credit', balance: 1000, apr: 25, minPayment: 40, isOverdue: true }],
    subscriptions: [],
  }, {}, NOW);
  const ids = p.steps.map((s) => s.id);
  assert.ok(ids.includes('overdue'));
  assert.ok(ids.includes('shortfall'));
  assert.equal(p.surplus, -140);
  const noIncome = buildPlan({ monthlyIncome: 0, monthlyLivingCosts: 0, monthlyEssentials: 0, cash: 0, investments: 0, debts: [], subscriptions: [] });
  assert.equal(noIncome.steps[0].id, 'income');
});

test('plan honors a manual extra payment', () => {
  const p = buildPlan({
    monthlyIncome: 5000, monthlyLivingCosts: 3000, monthlyEssentials: 2000, cash: 5000, investments: 0,
    debts: [{ name: 'Card', kind: 'credit', balance: 3000, apr: 20, minPayment: 60 }], subscriptions: [],
  }, { extraDebtPayment: 440 }, NOW);
  assert.equal(p.extraDebtPayment, 440);
  assert.equal(p.payoff.months, 7);
});

test('classifier', () => {
  assert.equal(classifyOutflow({ name: 'NETFLIX.COM' }), 'subscription');
  assert.equal(classifyOutflow({ name: 'Landlord', primary: 'RENT_AND_UTILITIES', detailed: 'RENT_AND_UTILITIES_RENT' }), 'bill');
  assert.equal(classifyOutflow({ name: 'Chase', primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }), 'ignore');
  assert.equal(classifyOutflow({ name: 'Venmo', primary: 'TRANSFER_OUT' }), 'ignore');
  assert.equal(classifyOutflow({ name: 'Joe Barber' }), 'other');
});

test('money helpers', () => {
  assert.equal(toMonthly(100, 'BIWEEKLY'), 216.67);
  assert.equal(toMonthly(120, 'ANNUALLY'), 10);
  assert.equal(nextAfter('2026-09-15', 'MONTHLY', NOW), '2026-10-15');
  assert.equal(nextAfter('2026-10-02', 'WEEKLY', NOW), '2026-10-09');
});

test('CSV parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'he said "hi"']]);
});

test('Cash App CSV import + recurring detection', () => {
  const header = 'Transaction ID,Date,Transaction Type,Currency,Amount,Fee,Net Amount,Asset Type,Asset Price,Asset Amount,Status,Notes,Name of sender/receiver,Account';
  const lines = [header];
  const months = ['2026-06', '2026-07', '2026-08', '2026-09'];
  months.forEach((m, i) => {
    lines.push(`a${i},${m}-03 10:00:00 EDT,Cash Card,USD,-$15.49,$0,-$15.49,,,,COMPLETE,,Netflix,Visa Debit`);
    lines.push(`b${i},${m}-05 10:00:00 EDT,Cash Out,USD,-$200.00,$0,-$200.00,,,,COMPLETE,,,Bank`);
    lines.push(`c${i},${m}-${10 + i} 10:00:00 EDT,Cash Card,USD,-$${(20 + i * 17).toFixed(2)},$0,-$${(20 + i * 17).toFixed(2)},,,,COMPLETE,,Taco Spot,Visa Debit`);
  });
  lines.push('d1,2026-09-20 10:00:00 EDT,Cash Card,USD,-$99.00,$0,-$99.00,,,,FAILED,,Netflix,Visa Debit');
  const tx = transactionsFromCsv(lines.join('\n'), { institution: 'Cash App' });
  assert.equal(tx.length, 12, 'failed rows are dropped');
  assert.equal(tx[0].amount, 15.49, 'outflows become positive');
  assert.equal(tx.filter((t) => t.primary === 'TRANSFER_OUT').length, 4);
  const rec = detectRecurring(tx, { now: NOW });
  assert.equal(rec.length, 1, `got ${rec.map((r) => r.name)}`);
  assert.equal(rec[0].name, 'Netflix');
  assert.equal(rec[0].kind, 'subscription');
  assert.equal(rec[0].frequency, 'MONTHLY');
  assert.equal(rec[0].nextDate, '2026-10-03');
});

test('CSV without date/amount columns is rejected with a clear error', () => {
  assert.throws(() => transactionsFromCsv('foo,bar\n1,2'), /Date and Amount/);
});

test('store encrypts access tokens at rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-'));
  const key = crypto.randomBytes(32).toString('hex');
  const s = new Store({ dir, encryptionKeyHex: key });
  s.addItem({ itemId: 'i1', institution: 'Fidelity', accessToken: 'access-sandbox-SECRET' });
  const raw = fs.readFileSync(path.join(dir, 'store.json'), 'utf8');
  assert.ok(!raw.includes('SECRET'));
  const reopened = new Store({ dir, encryptionKeyHex: key });
  assert.equal(reopened.itemsWithTokens()[0].accessToken, 'access-sandbox-SECRET');
  assert.throws(() => new Store({ dir, encryptionKeyHex: crypto.randomBytes(32).toString('hex') }).itemsWithTokens());
  assert.throws(() => new Store({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-')) }).addItem({ itemId: 'x', accessToken: 'y' }), /TOKEN_ENCRYPTION_KEY/);
});

test('syncItem normalizes Plaid responses and tolerates unsupported products', async () => {
  const plaidError = (code) => Object.assign(new Error(code), { response: { data: { error_code: code, error_message: code } } });
  const client = {
    accountsGet: async () => ({ data: { accounts: [
      { account_id: 'c1', name: 'Card', type: 'credit', subtype: 'credit card', mask: '1', balances: { current: 1200, limit: 3000 } },
      { account_id: 'k1', name: 'Checking', type: 'depository', subtype: 'checking', mask: '2', balances: { current: 800 } },
    ] } }),
    liabilitiesGet: async () => ({ data: { liabilities: { credit: [{
      account_id: 'c1', aprs: [{ apr_type: 'purchase_apr', apr_percentage: 27.5 }],
      minimum_payment_amount: 40, next_payment_due_date: '2026-10-20', is_overdue: false,
    }], student: null, mortgage: null } } }),
    transactionsRecurringGet: async () => ({ data: {
      outflow_streams: [
        { stream_id: 's1', account_id: 'c1', merchant_name: 'Spotify', description: 'SPOTIFY', frequency: 'MONTHLY', last_amount: { amount: 11.99 }, last_date: '2026-09-07', predicted_next_date: '2026-10-07', is_active: true, status: 'MATURE', personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_MUSIC_AND_AUDIO' } },
        { stream_id: 's2', account_id: 'k1', description: 'CARD PAYMENT', frequency: 'MONTHLY', last_amount: { amount: 300 }, last_date: '2026-09-01', is_active: true, status: 'MATURE', personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } },
        { stream_id: 's3', account_id: 'k1', description: 'OLD GYM', frequency: 'MONTHLY', last_amount: { amount: 30 }, last_date: '2025-01-01', is_active: false, status: 'TOMBSTONED', personal_finance_category: {} },
      ],
      inflow_streams: [
        { stream_id: 'i1', account_id: 'k1', description: 'PAYROLL', frequency: 'BIWEEKLY', average_amount: { amount: -1500 }, last_date: '2026-09-26', predicted_next_date: '2026-10-10', is_active: true, status: 'MATURE', personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } },
      ],
    } }),
    transactionsSync: async () => ({ data: { added: [
      { date: '2026-09-20', amount: 50, merchant_name: 'Kroger', pending: false, account_id: 'c1', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } },
      { date: '2026-09-21', amount: 5, name: 'pending', pending: true, account_id: 'c1' },
    ], next_cursor: 'c', has_more: false } }),
    investmentsHoldingsGet: async () => { throw plaidError('PRODUCTS_NOT_SUPPORTED'); },
  };
  const out = await syncItem(client, { accessToken: 't', institution: 'Test Bank', itemId: 'it' }, { now: NOW });
  assert.equal(out.accounts.length, 2);
  assert.deepEqual(out.warnings, [], 'unsupported products are not warnings');
  assert.equal(out.debts[0].apr, 27.5);
  assert.equal(out.debts[0].minPayment, 40);
  assert.deepEqual(out.recurring.map((r) => [r.name, r.kind]), [['Spotify', 'subscription'], ['PAYROLL', 'income']]);
  assert.equal(out.recurring[1].monthlyAmount, 3250);
  assert.equal(out.transactions.length, 1);

  client.accountsGet = async () => { throw plaidError('ITEM_LOGIN_REQUIRED'); };
  const broken = await syncItem(client, { accessToken: 't', institution: 'Test Bank', itemId: 'it' }, { now: NOW });
  assert.equal(broken.warnings[0].code, 'ITEM_LOGIN_REQUIRED');
});

test('dashboard from demo data is internally consistent', () => {
  const d = buildDashboard({ sources: demoSources(NOW), settings: { strategy: 'avalanche' }, now: NOW });
  assert.equal(d.kpis.netWorth, Math.round((d.kpis.cash + d.kpis.investments - d.kpis.totalDebt) * 100) / 100);
  assert.ok(d.subscriptions.length > 0 && d.bills.length > 0 && d.holdings.length > 0);
  assert.ok(d.upcoming.every((u) => u.date >= '2026-10-02' && u.date <= '2026-11-01'));
  assert.ok(d.plan.steps.some((s) => s.id === 'debt' && s.payoff?.feasible));
});
