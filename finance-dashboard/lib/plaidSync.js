// Talks to Plaid and normalizes every connected institution into one shape the dashboard understands.
import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from 'plaid';
import { classifyOutflow } from './classify.js';
import { toMonthly, round2, isoDate, addDays, nextOccurrence } from './money.js';

export function createPlaidClient({ clientId, secret, env }) {
  if (!PlaidEnvironments[env]) throw new Error(`PLAID_ENV must be one of: ${Object.keys(PlaidEnvironments).join(', ')}`);
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
  }));
}

export async function createLinkToken(client, userId) {
  const res = await client.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'My Finance Dashboard',
    language: 'en',
    country_codes: [CountryCode.Us],
    products: [Products.Transactions],
    // Requested when the institution supports them (credit cards & loans, brokerages like Fidelity).
    optional_products: [Products.Liabilities, Products.Investments],
    transactions: { days_requested: 180 },
  });
  return res.data.link_token;
}

export async function exchangePublicToken(client, publicToken) {
  const res = await client.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: res.data.access_token, itemId: res.data.item_id };
}

export async function removeItem(client, accessToken) {
  await client.itemRemove({ access_token: accessToken });
}

/** Errors that just mean "this institution doesn't offer that product" - not worth surfacing. */
const BENIGN_ERRORS = new Set([
  'PRODUCTS_NOT_SUPPORTED', 'NO_LIABILITY_ACCOUNTS', 'NO_INVESTMENT_ACCOUNTS',
  'NO_INVESTMENT_AUTH_ACCOUNTS', 'PRODUCT_NOT_ENABLED', 'INVALID_PRODUCT',
]);

async function optional(label, fn, warnings, institution) {
  try {
    return await fn();
  } catch (err) {
    const code = err?.response?.data?.error_code;
    if (!BENIGN_ERRORS.has(code)) {
      warnings.push({
        institution,
        product: label,
        code: code || 'UNKNOWN',
        message: err?.response?.data?.error_message || err.message,
      });
    }
    return null;
  }
}

/** Pull and normalize everything for one connected item. */
export async function syncItem(client, item, { now = new Date() } = {}) {
  const { accessToken, institution, itemId } = item;
  const warnings = [];
  const out = { accounts: [], debts: [], recurring: [], holdings: [], transactions: [], warnings };

  // Accounts are required; if this fails (e.g. ITEM_LOGIN_REQUIRED) report it and stop for this item.
  const acct = await optional('accounts', () => client.accountsGet({ access_token: accessToken }), warnings, institution);
  if (!acct) {
    // accountsGet failures are never benign, but make sure we always say something.
    if (!warnings.length) warnings.push({ institution, product: 'accounts', code: 'UNKNOWN', message: 'Could not load accounts.' });
    return out;
  }

  for (const a of acct.data.accounts) {
    out.accounts.push({
      id: a.account_id,
      itemId,
      institution,
      name: a.official_name || a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      balance: round2(a.balances.current ?? 0),
      available: a.balances.available,
      limit: a.balances.limit,
      source: 'plaid',
    });
  }

  // --- Liabilities: credit cards, student loans, mortgages ---
  const liab = await optional('liabilities', () => client.liabilitiesGet({ access_token: accessToken }), warnings, institution);
  const liabByAccount = new Map();
  if (liab) {
    const { credit = [], student = [], mortgage = [] } = liab.data.liabilities;
    for (const c of credit || []) {
      const purchase = c.aprs?.find((x) => x.apr_type === 'purchase_apr') || c.aprs?.[0];
      liabByAccount.set(c.account_id, {
        kind: 'credit', apr: purchase?.apr_percentage ?? null, minPayment: c.minimum_payment_amount,
        nextDueDate: c.next_payment_due_date, isOverdue: !!c.is_overdue,
      });
    }
    for (const s of student || []) {
      liabByAccount.set(s.account_id, {
        kind: 'student', apr: s.interest_rate_percentage, minPayment: s.minimum_payment_amount,
        nextDueDate: s.next_payment_due_date, isOverdue: !!s.is_overdue,
      });
    }
    for (const m of mortgage || []) {
      liabByAccount.set(m.account_id, {
        kind: 'mortgage', apr: m.interest_rate?.percentage ?? null, minPayment: m.next_monthly_payment,
        nextDueDate: m.next_payment_due_date, isOverdue: false,
      });
    }
  }

  for (const a of out.accounts) {
    if (a.type !== 'credit' && a.type !== 'loan') continue;
    const l = liabByAccount.get(a.id) || {};
    if (a.balance <= 0 && a.type === 'credit') continue; // paid-off card, nothing owed
    out.debts.push({
      accountId: a.id,
      institution,
      name: a.name,
      kind: l.kind || (a.type === 'credit' ? 'credit' : 'loan'),
      balance: a.balance,
      apr: l.apr ?? null,
      minPayment: l.minPayment ?? null,
      nextDueDate: l.nextDueDate ?? null,
      isOverdue: l.isOverdue ?? false,
      limit: a.limit ?? null,
    });
  }

  // --- Recurring bills, subscriptions and income ---
  const rec = await optional('recurring', () => client.transactionsRecurringGet({ access_token: accessToken }), warnings, institution);
  if (rec) {
    const live = (s) => s.is_active && s.status !== 'TOMBSTONED';
    for (const s of rec.data.outflow_streams.filter(live)) {
      const name = s.merchant_name || s.description;
      const kind = classifyOutflow({
        name,
        primary: s.personal_finance_category?.primary,
        detailed: s.personal_finance_category?.detailed,
      });
      if (kind === 'ignore') continue;
      const amount = round2(Math.abs(s.last_amount?.amount ?? s.average_amount?.amount ?? 0));
      out.recurring.push({
        id: s.stream_id,
        institution,
        accountId: s.account_id,
        name,
        kind,
        frequency: s.frequency,
        amount,
        monthlyAmount: toMonthly(amount, s.frequency),
        lastDate: s.last_date,
        nextDate: nextOccurrence(s.predicted_next_date || s.last_date, s.frequency, now),
        category: s.personal_finance_category?.detailed || null,
        confidence: s.status === 'MATURE' ? 'high' : 'early',
      });
    }
    for (const s of rec.data.inflow_streams.filter(live)) {
      if (s.personal_finance_category?.primary !== 'INCOME') continue;
      const amount = round2(Math.abs(s.average_amount?.amount ?? 0));
      out.recurring.push({
        id: s.stream_id,
        institution,
        accountId: s.account_id,
        name: s.merchant_name || s.description,
        kind: 'income',
        frequency: s.frequency,
        amount,
        monthlyAmount: toMonthly(amount, s.frequency),
        lastDate: s.last_date,
        nextDate: nextOccurrence(s.predicted_next_date || s.last_date, s.frequency, now),
        category: s.personal_finance_category?.detailed || null,
        confidence: s.status === 'MATURE' ? 'high' : 'early',
      });
    }
  }

  // --- Recent transactions (last 90 days) for spending estimates ---
  const cutoff = isoDate(addDays(now, -90));
  await optional('transactions', async () => {
    let cursor;
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages++ < 50) {
      const res = await client.transactionsSync({ access_token: accessToken, cursor, count: 500 });
      for (const t of res.data.added) {
        if (t.pending || t.date < cutoff) continue;
        out.transactions.push({
          date: t.date,
          amount: round2(t.amount), // positive = money out
          name: t.merchant_name || t.name,
          primary: t.personal_finance_category?.primary || null,
          detailed: t.personal_finance_category?.detailed || null,
          accountId: t.account_id,
          institution,
        });
      }
      cursor = res.data.next_cursor;
      hasMore = res.data.has_more;
    }
  }, warnings, institution);

  // --- Investments (e.g. Fidelity) ---
  const inv = await optional('investments', () => client.investmentsHoldingsGet({ access_token: accessToken }), warnings, institution);
  if (inv) {
    const securities = new Map(inv.data.securities.map((s) => [s.security_id, s]));
    for (const h of inv.data.holdings) {
      const sec = securities.get(h.security_id) || {};
      out.holdings.push({
        accountId: h.account_id,
        institution,
        ticker: sec.ticker_symbol || null,
        name: sec.name || 'Unknown security',
        type: sec.type || null,
        quantity: h.quantity,
        value: round2(h.institution_value ?? 0),
        costBasis: h.cost_basis == null ? null : round2(h.cost_basis),
      });
    }
  }

  return out;
}
