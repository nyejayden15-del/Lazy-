// Decides whether a recurring outflow is a bill, a subscription, or something to ignore
// (transfers, credit card payments) using Plaid's personal_finance_category plus merchant names.

const SUBSCRIPTION_DETAILED = new Set([
  'ENTERTAINMENT_TV_AND_MOVIES',
  'ENTERTAINMENT_MUSIC_AND_AUDIO',
  'ENTERTAINMENT_VIDEO_GAMES',
  'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES',
  'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS',
  'GENERAL_SERVICES_OTHER_GENERAL_SERVICES',
]);

const SUBSCRIPTION_MERCHANTS = [
  'netflix', 'hulu', 'spotify', 'apple', 'icloud', 'youtube', 'disney', 'max', 'hbo',
  'paramount', 'peacock', 'amazon prime', 'prime video', 'audible', 'xbox', 'playstation',
  'nintendo', 'adobe', 'microsoft', 'google storage', 'google one', 'dropbox', 'chatgpt',
  'openai', 'claude', 'anthropic', 'patreon', 'onlyfans', 'twitch', 'crunchyroll', 'siriusxm',
  'planet fitness', 'peloton', 'duolingo', 'canva', 'notion', 'nytimes', 'new york times',
  'wall street journal', 'doordash dashpass', 'uber one', 'instacart+', 'walmart+', 'costco',
];

const BILL_PRIMARY = new Set(['RENT_AND_UTILITIES', 'LOAN_PAYMENTS']);
const BILL_DETAILED_HINTS = ['INSURANCE', 'TELEPHONE', 'INTERNET', 'CHILDCARE', 'EDUCATION'];
const BILL_MERCHANTS = [
  'verizon', 't-mobile', 'at&t', 'xfinity', 'comcast', 'spectrum', 'geico', 'progressive',
  'state farm', 'allstate', 'electric', 'energy', 'water', 'gas co', 'rent', 'mortgage', 'insurance',
];

// Moving money between your own accounts or paying a card is not a bill/subscription.
const IGNORE_DETAILED = new Set([
  'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  'TRANSFER_OUT_ACCOUNT_TRANSFER',
  'TRANSFER_OUT_SAVINGS',
  'TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS',
]);

function matches(name, list) {
  const n = (name || '').toLowerCase();
  return list.some((m) => n.includes(m));
}

/** @returns {'bill'|'subscription'|'other'|'ignore'} */
export function classifyOutflow({ name, primary, detailed }) {
  if (detailed && IGNORE_DETAILED.has(detailed)) return 'ignore';
  if (primary === 'TRANSFER_OUT') return 'ignore';
  if (matches(name, SUBSCRIPTION_MERCHANTS)) return 'subscription';
  if (detailed && SUBSCRIPTION_DETAILED.has(detailed)) return 'subscription';
  if (primary && BILL_PRIMARY.has(primary)) return 'bill';
  if (detailed && BILL_DETAILED_HINTS.some((h) => detailed.includes(h))) return 'bill';
  if (matches(name, BILL_MERCHANTS)) return 'bill';
  return 'other';
}

/** Is a transaction "essential" for emergency-fund sizing? */
export function isEssentialCategory(primary) {
  return ['RENT_AND_UTILITIES', 'LOAN_PAYMENTS', 'FOOD_AND_DRINK', 'TRANSPORTATION', 'MEDICAL']
    .includes(primary);
}
