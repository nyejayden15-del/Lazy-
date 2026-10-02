// Builds a step-by-step financial plan from normalized account data.
// Deterministic, rule-based math (no guessing): you can check every number it shows.
import { round2, sum } from './money.js';

const HIGH_INTEREST_APR = 8; // % - above this, paying debt beats typical investing returns
const ASSUMED_CARD_APR = 24; // used when a card's APR isn't reported
const STARTER_FUND = 1000;
const MAX_MONTHS = 600;

/** Fill in missing APR / minimum payment with conservative estimates, flagging them. */
export function prepareDebts(debts) {
  return debts
    .filter((d) => d.balance > 0)
    .map((d) => {
      const aprEstimated = d.apr == null;
      const apr = aprEstimated ? (d.kind === 'credit' ? ASSUMED_CARD_APR : 7) : d.apr;
      const monthlyInterest = (d.balance * apr) / 1200;
      const minEstimated = d.minPayment == null || d.minPayment <= 0;
      const minPayment = minEstimated
        ? round2(Math.max(25, d.kind === 'credit' ? d.balance * 0.01 + monthlyInterest : d.balance * 0.02))
        : d.minPayment;
      return { ...d, apr, aprEstimated, minPayment: Math.min(minPayment, d.balance), minEstimated };
    });
}

/**
 * Month-by-month payoff simulation. Every month: interest accrues, every debt gets its minimum,
 * and the rest of the budget (extra + minimums freed up by paid-off debts) goes to the target debt.
 */
export function simulatePayoff(debts, extra = 0, strategy = 'avalanche') {
  const list = debts.map((d) => ({ name: d.name, balance: d.balance, apr: d.apr, min: d.minPayment, paidOffMonth: null }));
  if (!list.length) return { months: 0, totalInterest: 0, order: [], series: [0], feasible: true };

  const order = [...list].sort(strategy === 'snowball'
    ? (a, b) => a.balance - b.balance || b.apr - a.apr
    : (a, b) => b.apr - a.apr || a.balance - b.balance);
  const budget = sum(list, (d) => d.min) + Math.max(0, extra);
  const series = [round2(sum(list, (d) => d.balance))];
  let totalInterest = 0;
  let month = 0;

  while (list.some((d) => d.balance > 0.005) && month < MAX_MONTHS) {
    month++;
    for (const d of list) {
      if (d.balance <= 0) continue;
      const interest = (d.balance * d.apr) / 1200;
      d.balance += interest;
      totalInterest += interest;
    }
    let pool = budget;
    for (const d of list) {
      if (d.balance <= 0) continue;
      const pay = Math.min(d.min, d.balance, pool);
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of order) {
      if (pool <= 0) break;
      if (d.balance <= 0) continue;
      const pay = Math.min(d.balance, pool);
      d.balance -= pay;
      pool -= pay;
    }
    for (const d of list) {
      if (d.balance <= 0.005 && d.paidOffMonth === null) { d.balance = 0; d.paidOffMonth = month; }
    }
    series.push(round2(sum(list, (d) => d.balance)));
  }

  const feasible = list.every((d) => d.balance <= 0.005);
  return {
    months: feasible ? month : null,
    totalInterest: round2(totalInterest),
    order: order.map((d) => ({ name: d.name, apr: d.apr, paidOffMonth: d.paidOffMonth })),
    series,
    feasible,
  };
}

function monthsFromNow(n, now) {
  if (n == null) return null;
  const d = new Date(now.getFullYear(), now.getMonth() + n, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/**
 * @param {object} f  financial picture
 * @param {number} f.monthlyIncome
 * @param {number} f.monthlyLivingCosts   everything you spend except debt payments and transfers
 * @param {number} f.monthlyEssentials    housing, utilities, groceries, transport, insurance, medical
 * @param {number} f.cash                 checking + savings
 * @param {number} f.investments
 * @param {Array}  f.debts
 * @param {Array}  f.subscriptions
 * @param {object} settings  { extraDebtPayment, strategy }
 */
export function buildPlan(f, settings = {}, now = new Date()) {
  const strategy = settings.strategy === 'snowball' ? 'snowball' : 'avalanche';
  const debts = prepareDebts(f.debts || []);
  const minPayments = sum(debts, (d) => d.minPayment);
  const surplus = round2(f.monthlyIncome - f.monthlyLivingCosts - minPayments);
  const highInterest = debts.filter((d) => d.apr >= HIGH_INTEREST_APR);
  const lowInterest = debts.filter((d) => d.apr < HIGH_INTEREST_APR);
  const subsMonthly = sum(f.subscriptions || [], (s) => s.monthlyAmount);
  const steps = [];

  // How much extra goes to debt each month.
  const starterDone = f.cash >= STARTER_FUND;
  const autoExtra = surplus > 0 ? round2(surplus * (starterDone ? 0.8 : 0.5)) : 0;
  const extra = settings.extraDebtPayment ?? autoExtra;

  // 0. Income missing -> plan can't be trusted.
  if (!f.monthlyIncome) {
    steps.push({
      id: 'income', status: 'action', title: 'Tell the dashboard your monthly take-home pay',
      detail: 'No regular paycheck was detected in your linked accounts. Enter your monthly take-home pay in Settings so the plan can work out what you can afford.',
    });
  }

  // 1. Overdue or cash-flow emergencies first.
  const overdue = debts.filter((d) => d.isOverdue);
  if (overdue.length) {
    steps.push({
      id: 'overdue', status: 'urgent', title: 'Catch up on overdue payments',
      detail: `${overdue.map((d) => d.name).join(', ')} ${overdue.length > 1 ? 'are' : 'is'} past due. Pay at least the minimum now to stop late fees and credit score damage, then call the lender to ask about waiving the fee.`,
    });
  }
  if (f.monthlyIncome && surplus < 0) {
    steps.push({
      id: 'shortfall', status: 'urgent', title: `Close a ${fmt(-surplus)}/month shortfall`,
      detail: `You're spending about ${fmt(f.monthlyLivingCosts)} a month plus ${fmt(minPayments)} in minimum debt payments, against ${fmt(f.monthlyIncome)} of income. Start with subscriptions (${fmt(subsMonthly)}/month) and your largest non-essential spending categories.`,
    });
  }

  // 2. Starter emergency fund.
  steps.push({
    id: 'starter-fund', status: starterDone ? 'done' : 'action',
    title: `Keep a ${fmt(STARTER_FUND)} starter emergency fund`,
    detail: starterDone
      ? `You have ${fmt(f.cash)} in cash, so a surprise bill won't go on a credit card.`
      : `You have ${fmt(f.cash)} in cash. Set aside ${fmt(STARTER_FUND - f.cash)} more so a surprise expense doesn't go onto a credit card.`,
    progress: Math.min(1, f.cash / STARTER_FUND),
  });

  // 3. Employer match note.
  steps.push({
    id: 'match', status: 'info', title: "Get your full employer 401(k) match, if you have one",
    detail: "A match is an instant 50-100% return, which beats paying off any debt. If your job offers one, contribute at least enough to get all of it, even while you pay down debt.",
  });

  // 4. Pay off high-interest debt.
  let payoff = null;
  if (highInterest.length) {
    payoff = simulatePayoff(highInterest, extra, strategy);
    const minimumOnly = simulatePayoff(highInterest, 0, strategy);
    const other = simulatePayoff(highInterest, extra, strategy === 'avalanche' ? 'snowball' : 'avalanche');
    const total = sum(highInterest, (d) => d.balance);
    const orderText = payoff.order.map((d, i) => `${i + 1}. ${d.name} (${d.apr}% APR)`).join('  ');
    let detail = `Pay the minimum on everything and put an extra ${fmt(extra)}/month toward one debt at a time, in this order: ${orderText}. `;
    if (payoff.feasible) {
      detail += `You'd be free of this ${fmt(total)} by ${monthsFromNow(payoff.months, now)} (${payoff.months} months), paying ${fmt(payoff.totalInterest)} in interest.`;
      if (minimumOnly.feasible) {
        detail += ` Paying only minimums would take ${minimumOnly.months} months and cost ${fmt(minimumOnly.totalInterest)} in interest.`;
      } else {
        detail += ' Paying only minimums would never pay it off.';
      }
      if (other.feasible && Math.abs(other.totalInterest - payoff.totalInterest) >= 1) {
        const diff = other.totalInterest - payoff.totalInterest;
        const otherName = strategy === 'avalanche' ? 'snowball (smallest balance first)' : 'avalanche (highest APR first)';
        detail += diff > 0
          ? ` The ${otherName} method would cost ${fmt(diff)} more in interest.`
          : ` The ${otherName} method would save ${fmt(-diff)} in interest.`;
      }
    } else {
      detail += 'At this payment the balances keep growing. Lower your spending or add income so you can pay more than the interest each month.';
    }
    const estimated = highInterest.filter((d) => d.aprEstimated || d.minEstimated);
    if (estimated.length) detail += ` (Some APRs or minimums weren't reported by your bank and are estimated: ${estimated.map((d) => d.name).join(', ')}.)`;
    steps.push({
      id: 'debt', status: 'action', title: `Pay off ${fmt(total)} of high-interest debt (${strategy})`, detail,
      payoff: { ...payoff, minimumOnlyMonths: minimumOnly.months, minimumOnlyInterest: minimumOnly.totalInterest, minimumOnlySeries: minimumOnly.series, extra },
    });
  } else if (debts.length) {
    steps.push({ id: 'debt', status: 'done', title: 'No high-interest debt', detail: `All your debt is under ${HIGH_INTEREST_APR}% APR. Keep making the regular payments.` });
  } else {
    steps.push({ id: 'debt', status: 'done', title: 'No debt', detail: 'No balances were found on linked credit cards or loans.' });
  }

  // 5. Subscriptions review.
  if (f.subscriptions?.length) {
    const top = [...f.subscriptions].sort((a, b) => b.monthlyAmount - a.monthlyAmount).slice(0, 5);
    steps.push({
      id: 'subscriptions', status: 'action',
      title: `Review ${f.subscriptions.length} subscriptions (${fmt(subsMonthly)}/month, ${fmt(subsMonthly * 12)}/year)`,
      detail: `Cancel anything you haven't used in the last month. Biggest: ${top.map((s) => `${s.name} ${fmt(s.monthlyAmount)}/mo`).join(', ')}. Every dollar cut goes straight to your plan.`,
    });
  }

  // 6. Full emergency fund.
  const efTarget = round2(f.monthlyEssentials * 3);
  const efDone = f.cash >= efTarget && efTarget > 0;
  steps.push({
    id: 'emergency-fund', status: efDone ? 'done' : highInterest.length ? 'later' : 'action',
    title: `Build a 3-month emergency fund (${fmt(efTarget)})`,
    detail: efDone
      ? `Your ${fmt(f.cash)} in cash covers about ${(f.cash / Math.max(1, f.monthlyEssentials)).toFixed(1)} months of essentials.`
      : `Your essentials run about ${fmt(f.monthlyEssentials)}/month. After high-interest debt is gone, keep saving in a high-yield savings account until you have 3 months (6 if your income is irregular).`,
    progress: efTarget > 0 ? Math.min(1, f.cash / efTarget) : 0,
  });

  // 7. Invest.
  const investTarget = round2(f.monthlyIncome * 0.15);
  steps.push({
    id: 'invest', status: highInterest.length || !efDone ? 'later' : 'action',
    title: `Invest 15% of income for retirement (${fmt(investTarget)}/month)`,
    detail: `You have ${fmt(f.investments)} invested. Once the steps above are done, put about 15% of take-home pay into a Roth IRA or 401(k) using low-cost index funds.${lowInterest.length ? ` Keep paying your lower-interest debt (${lowInterest.map((d) => d.name).join(', ')}) on schedule; extra payments there are optional.` : ''}`,
  });

  // Budget snapshot (50/30/20 guideline).
  const income = f.monthlyIncome || 0;
  const needs = round2(f.monthlyEssentials + minPayments);
  const wants = round2(Math.max(0, f.monthlyLivingCosts - f.monthlyEssentials));
  const save = round2(income - needs - wants);
  const pct = (n) => (income ? Math.round((n / income) * 100) : null);
  const budget = {
    income,
    needs: { amount: needs, pct: pct(needs), target: 50 },
    wants: { amount: wants, pct: pct(wants), target: 30 },
    savingsAndExtraDebt: { amount: save, pct: pct(save), target: 20 },
  };

  return {
    strategy,
    surplus,
    minPayments,
    extraDebtPayment: extra,
    extraIsAutomatic: settings.extraDebtPayment == null,
    steps,
    budget,
    payoff,
    debts,
  };
}
