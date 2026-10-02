// Realistic sample data in the same normalized shape plaidSync produces, so the dashboard
// can be tried without connecting anything. All names and numbers are made up.
import { isoDate, addDays, toMonthly, nextAfter } from './money.js';

export function demoSources(now = new Date()) {
  const d = (offset) => isoDate(addDays(now, offset));

  const accounts = [
    { id: 'chk', institution: 'Chase', name: 'Total Checking', mask: '4821', type: 'depository', subtype: 'checking', balance: 1843.27, source: 'demo' },
    { id: 'sav', institution: 'Chase', name: 'Savings', mask: '9910', type: 'depository', subtype: 'savings', balance: 650, source: 'demo' },
    { id: 'cashapp', institution: 'Cash App', name: 'Cash App balance', mask: null, type: 'depository', subtype: 'checking', balance: 212.4, source: 'demo' },
    { id: 'cap1', institution: 'Capital One', name: 'Quicksilver Card', mask: '3002', type: 'credit', subtype: 'credit card', balance: 3420.55, limit: 5000, source: 'demo' },
    { id: 'disc', institution: 'Discover', name: 'Discover it Card', mask: '7741', type: 'credit', subtype: 'credit card', balance: 890.12, limit: 2500, source: 'demo' },
    { id: 'loan', institution: 'Nelnet', name: 'Federal Student Loan', mask: '0042', type: 'loan', subtype: 'student', balance: 14250, source: 'demo' },
    { id: 'fid-brk', institution: 'Fidelity', name: 'Individual Brokerage', mask: '1188', type: 'investment', subtype: 'brokerage', balance: 2740.18, source: 'demo' },
    { id: 'fid-roth', institution: 'Fidelity', name: 'Roth IRA', mask: '5520', type: 'investment', subtype: 'roth', balance: 4115.62, source: 'demo' },
  ];

  const debts = [
    { accountId: 'cap1', institution: 'Capital One', name: 'Quicksilver Card', kind: 'credit', balance: 3420.55, apr: 29.74, minPayment: 105, nextDueDate: d(9), isOverdue: false, limit: 5000 },
    { accountId: 'disc', institution: 'Discover', name: 'Discover it Card', kind: 'credit', balance: 890.12, apr: 22.99, minPayment: 35, nextDueDate: d(17), isOverdue: false, limit: 2500 },
    { accountId: 'loan', institution: 'Nelnet', name: 'Federal Student Loan', kind: 'student', balance: 14250, apr: 5.5, minPayment: 162.4, nextDueDate: d(21), isOverdue: false, limit: null },
  ];

  const stream = (id, name, kind, frequency, amount, lastOffset, institution, accountId, category) => ({
    id, institution, accountId, name, kind, frequency, amount,
    monthlyAmount: toMonthly(amount, frequency),
    lastDate: d(lastOffset),
    nextDate: nextAfter(d(lastOffset), frequency, now),
    category, confidence: 'high', lastOffset,
  });

  const recurring = [
    stream('s-pay', 'ACME Corp Payroll', 'income', 'BIWEEKLY', 1685, -6, 'Chase', 'chk', 'INCOME_WAGES'),
    stream('s-rent', 'Maple Court Apartments', 'bill', 'MONTHLY', 1150, -27, 'Chase', 'chk', 'RENT_AND_UTILITIES_RENT'),
    stream('s-elec', 'City Electric', 'bill', 'MONTHLY', 96.4, -12, 'Chase', 'chk', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'),
    stream('s-net', 'Xfinity Internet', 'bill', 'MONTHLY', 70, -20, 'Capital One', 'cap1', 'RENT_AND_UTILITIES_INTERNET_AND_CABLE'),
    stream('s-phone', 'T-Mobile', 'bill', 'MONTHLY', 65, -3, 'Capital One', 'cap1', 'RENT_AND_UTILITIES_TELEPHONE'),
    stream('s-ins', 'GEICO Auto Insurance', 'bill', 'MONTHLY', 132.5, -15, 'Chase', 'chk', 'GENERAL_SERVICES_INSURANCE'),
    stream('s-netflix', 'Netflix', 'subscription', 'MONTHLY', 15.49, -8, 'Capital One', 'cap1', 'ENTERTAINMENT_TV_AND_MOVIES'),
    stream('s-spotify', 'Spotify', 'subscription', 'MONTHLY', 11.99, -25, 'Discover', 'disc', 'ENTERTAINMENT_MUSIC_AND_AUDIO'),
    stream('s-hulu', 'Hulu', 'subscription', 'MONTHLY', 17.99, -2, 'Cash App', 'cashapp', 'ENTERTAINMENT_TV_AND_MOVIES'),
    stream('s-icloud', 'Apple iCloud+', 'subscription', 'MONTHLY', 2.99, -18, 'Capital One', 'cap1', null),
    stream('s-gym', 'Planet Fitness', 'subscription', 'MONTHLY', 24.99, -10, 'Discover', 'disc', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS'),
    stream('s-xbox', 'Xbox Game Pass', 'subscription', 'MONTHLY', 19.99, -22, 'Cash App', 'cashapp', 'ENTERTAINMENT_VIDEO_GAMES'),
    stream('s-prime', 'Amazon Prime', 'subscription', 'ANNUALLY', 139, -340, 'Capital One', 'cap1', null),
  ];

  // 90 days of everyday spending.
  const transactions = [];
  const add = (offset, name, amount, primary, detailed, accountId, institution) =>
    transactions.push({ date: d(offset), amount, name, primary, detailed, accountId, institution });
  for (let day = -89; day <= 0; day++) {
    if (day % 7 === 0) add(day, 'Kroger', 92 + ((day * 13) % 25), 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', 'cap1', 'Capital One');
    if (day % 3 === 0) add(day, 'Chipotle', 14.5, 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD', 'cashapp', 'Cash App');
    if (day % 9 === 0) add(day, 'Shell', 46, 'TRANSPORTATION', 'TRANSPORTATION_GAS', 'disc', 'Discover');
    if (day % 11 === 0) add(day, 'Target', 58, 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_SUPERSTORES', 'cap1', 'Capital One');
    if ((day + 6) % 14 === 0) add(day, 'ACME Corp Payroll', -1685, 'INCOME', 'INCOME_WAGES', 'chk', 'Chase');
  }
  for (const r of recurring.filter((x) => x.kind !== 'income' && x.frequency === 'MONTHLY')) {
    for (let offset = r.lastOffset; offset >= -89; offset -= 30) {
      add(offset, r.name, r.amount, primaryOf(r.category), r.category, r.accountId, r.institution);
    }
  }
  for (const r of recurring) delete r.lastOffset;

  const holdings = [
    { accountId: 'fid-roth', institution: 'Fidelity', ticker: 'FXAIX', name: 'Fidelity 500 Index Fund', type: 'mutual fund', quantity: 17.62, value: 3602.4, costBasis: 3010 },
    { accountId: 'fid-roth', institution: 'Fidelity', ticker: 'SPAXX', name: 'Fidelity Government Money Market', type: 'cash', quantity: 513.22, value: 513.22, costBasis: 513.22 },
    { accountId: 'fid-brk', institution: 'Fidelity', ticker: 'AAPL', name: 'Apple Inc.', type: 'equity', quantity: 6, value: 1384.5, costBasis: 1120 },
    { accountId: 'fid-brk', institution: 'Fidelity', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf', quantity: 4.5, value: 1355.68, costBasis: 1190 },
  ];

  return [{ accounts, debts, recurring, holdings, transactions, warnings: [] }];
}

function primaryOf(detailed) {
  if (!detailed) return 'GENERAL_SERVICES';
  const known = ['RENT_AND_UTILITIES', 'GENERAL_SERVICES', 'ENTERTAINMENT', 'PERSONAL_CARE', 'INCOME'];
  return known.find((p) => detailed.startsWith(p)) || 'GENERAL_SERVICES';
}
