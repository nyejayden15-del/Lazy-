// Combines every source (Plaid institutions, CSV imports) into the numbers the dashboard shows,
// then hands the financial picture to the planner.
import { detectRecurring } from './csvImport.js';
import { buildPlan } from './planner.js';
import { round2, sum, isoDate, addDays, parseIsoDate } from './money.js';

const NOT_SPENDING = new Set(['TRANSFER_OUT', 'TRANSFER_IN', 'LOAN_PAYMENTS', 'INCOME']);
const ESSENTIAL_PRIMARY = new Set(['RENT_AND_UTILITIES', 'TRANSPORTATION', 'MEDICAL']);
const ESSENTIAL_DETAILED = new Set([
  'FOOD_AND_DRINK_GROCERIES', 'GENERAL_SERVICES_INSURANCE', 'GENERAL_SERVICES_CHILDCARE',
]);

export function buildDashboard({ sources = [], csvImports = [], settings = {}, now = new Date(), connections = {} }) {
  const accounts = sources.flatMap((s) => s.accounts);
  const debts = sources.flatMap((s) => s.debts);
  const holdings = sources.flatMap((s) => s.holdings);
  const warnings = sources.flatMap((s) => s.warnings || []);
  const transactions = sources.flatMap((s) => s.transactions);
  let recurring = sources.flatMap((s) => s.recurring);

  for (const imp of csvImports) {
    transactions.push(...imp.transactions);
    recurring.push(...detectRecurring(imp.transactions, { now }));
  }
  recurring = dedupeRecurring(recurring);

  const bills = recurring.filter((r) => r.kind === 'bill');
  const subscriptions = recurring.filter((r) => r.kind === 'subscription');
  const otherRecurring = recurring.filter((r) => r.kind === 'other');
  const incomeStreams = recurring.filter((r) => r.kind === 'income');

  const cash = sum(accounts.filter((a) => a.type === 'depository'), (a) => a.balance);
  const investments = sum(accounts.filter((a) => a.type === 'investment'), (a) => a.balance);
  const totalDebt = sum(debts, (d) => d.balance);

  // --- monthly spending from the last 90 days of transactions ---
  const cutoff = isoDate(addDays(now, -90));
  const recent = transactions.filter((t) => t.date >= cutoff);
  const earliest = recent.reduce((min, t) => (t.date < min ? t.date : min), isoDate(now));
  const months = Math.min(3, Math.max(1, (parseIsoDate(isoDate(now)) - parseIsoDate(earliest)) / (86_400_000 * 30.44)));
  const spending = recent.filter((t) => t.amount > 0 && !NOT_SPENDING.has(t.primary));
  const essentialTx = spending.filter((t) => ESSENTIAL_PRIMARY.has(t.primary) || ESSENTIAL_DETAILED.has(t.detailed));

  const billsMonthly = sum(bills, (b) => b.monthlyAmount);
  const nonLoanBillsMonthly = sum(bills.filter((b) => !b.category?.startsWith('LOAN_PAYMENTS')), (b) => b.monthlyAmount);
  const subsMonthly = sum(subscriptions, (s) => s.monthlyAmount);
  const otherMonthly = sum(otherRecurring, (s) => s.monthlyAmount);

  const monthlyEssentials = round2(Math.max(sum(essentialTx, (t) => t.amount) / months, nonLoanBillsMonthly));
  const monthlyLivingCosts = round2(Math.max(
    sum(spending, (t) => t.amount) / months,
    monthlyEssentials + subsMonthly + (spending.length ? 0 : otherMonthly),
  ));

  const detectedIncome = incomeStreams.length
    ? sum(incomeStreams, (s) => s.monthlyAmount)
    : round2(-sum(recent.filter((t) => t.primary === 'INCOME' && t.amount < 0), (t) => t.amount) / months);
  const monthlyIncome = settings.monthlyIncomeOverride ?? detectedIncome;

  const plan = buildPlan({
    monthlyIncome, monthlyLivingCosts, monthlyEssentials, cash, investments, debts, subscriptions,
  }, settings, now);

  return {
    generatedAt: now.toISOString(),
    kpis: {
      netWorth: round2(cash + investments - totalDebt),
      cash,
      investments,
      totalDebt,
      monthlyIncome,
      incomeIsOverride: settings.monthlyIncomeOverride != null,
      detectedIncome,
      monthlyBills: billsMonthly,
      monthlySubscriptions: subsMonthly,
      monthlyLivingCosts,
      monthlyEssentials,
      monthlySurplus: plan.surplus,
    },
    accounts,
    debts: plan.debts,
    bills: sortByNext(bills),
    subscriptions: sortByNext(subscriptions),
    otherRecurring: sortByNext(otherRecurring),
    incomeStreams: sortByNext(incomeStreams),
    upcoming: upcoming({ bills, subscriptions, otherRecurring, debts: plan.debts, now }),
    holdings: [...holdings].sort((a, b) => b.value - a.value),
    plan,
    settings,
    warnings,
    connections,
  };
}

function sortByNext(list) {
  return [...list].sort((a, b) => (a.nextDate || '9999').localeCompare(b.nextDate || '9999'));
}

/** Same subscription seen on two accounts (e.g. card + Cash App CSV) should count once. */
function dedupeRecurring(list) {
  const seen = new Map();
  for (const r of list) {
    const key = `${r.kind}|${r.name.toLowerCase().trim()}|${Math.round(r.amount)}`;
    if (!seen.has(key) || seen.get(key).confidence !== 'high') seen.set(key, r);
  }
  return [...seen.values()];
}

/** Everything due in the next 30 days: recurring charges plus credit card / loan due dates. */
function upcoming({ bills, subscriptions, otherRecurring, debts, now }) {
  const start = isoDate(now);
  const end = isoDate(addDays(now, 30));
  const items = [];
  for (const r of [...bills, ...subscriptions, ...otherRecurring]) {
    if (r.nextDate && r.nextDate >= start && r.nextDate <= end) {
      items.push({ date: r.nextDate, name: r.name, amount: r.amount, kind: r.kind, institution: r.institution });
    }
  }
  for (const d of debts) {
    if (d.nextDueDate && d.nextDueDate <= end) {
      items.push({
        date: d.nextDueDate, name: `${d.name} payment`, amount: d.minPayment, kind: 'debt',
        institution: d.institution, overdue: d.isOverdue || d.nextDueDate < start, estimated: d.minEstimated,
      });
    }
  }
  return items.sort((a, b) => a.date.localeCompare(b.date));
}
