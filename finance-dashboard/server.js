// Local web server for the finance dashboard. Binds to 127.0.0.1 only: your bank data never
// leaves your machine except for the calls this server makes to Plaid.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { createPlaidClient, createLinkToken, exchangePublicToken, removeItem, syncItem } from './lib/plaidSync.js';
import { transactionsFromCsv } from './lib/csvImport.js';
import { buildDashboard } from './lib/dashboard.js';
import { demoSources } from './lib/demoData.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';
const plaidConfigured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1' || !plaidConfigured;
const CACHE_MS = 15 * 60 * 1000;

if (!DEMO && !process.env.TOKEN_ENCRYPTION_KEY) {
  console.error('TOKEN_ENCRYPTION_KEY is required when connecting real accounts. See .env.example.');
  process.exit(1);
}

const store = new Store({ dir: path.join(here, 'data'), encryptionKeyHex: process.env.TOKEN_ENCRYPTION_KEY });
const plaid = DEMO ? null : createPlaidClient({
  clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, env: PLAID_ENV,
});

let cache = { at: 0, sources: null };

async function loadSources(force) {
  if (DEMO) return demoSources();
  if (!force && cache.sources && Date.now() - cache.at < CACHE_MS) return cache.sources;
  const sources = await Promise.all(store.itemsWithTokens().map((item) => syncItem(plaid, item)));
  cache = { at: Date.now(), sources };
  return sources;
}

const app = express();

// Only answer requests addressed to localhost (blocks DNS-rebinding attacks), and only accept
// JSON for writes (a cross-site form post can't send that without a CORS preflight we never allow).
app.use((req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1'].includes(host)) return res.status(403).send('Forbidden host');
  if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected application/json' });
  }
  next();
});
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(here, 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  const plaidErr = err?.response?.data;
  console.error(plaidErr || err);
  res.status(500).json({ error: plaidErr?.error_message || err.message });
});

app.get('/api/status', (req, res) => {
  res.json({ demo: DEMO, plaidConfigured, plaidEnv: DEMO ? null : PLAID_ENV });
});

app.get('/api/dashboard', wrap(async (req, res) => {
  const sources = await loadSources(req.query.refresh === '1');
  res.json(buildDashboard({
    sources,
    csvImports: store.listCsvImports(),
    settings: store.getSettings(),
    connections: {
      items: DEMO ? [] : store.listItems(),
      csvImports: store.listCsvImports().map(({ id, label, importedAt, transactions }) => ({ id, label, importedAt, count: transactions.length })),
    },
  }));
}));

app.post('/api/link-token', wrap(async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'Demo mode: add Plaid keys to .env to connect real accounts.' });
  res.json({ linkToken: await createLinkToken(plaid, 'local-user') });
}));

app.post('/api/exchange', wrap(async (req, res) => {
  if (DEMO) return res.status(400).json({ error: 'Demo mode.' });
  const { publicToken, institution } = req.body || {};
  if (typeof publicToken !== 'string') return res.status(400).json({ error: 'publicToken is required' });
  const { accessToken, itemId } = await exchangePublicToken(plaid, publicToken);
  store.addItem({ itemId, institution: String(institution || 'Unknown bank').slice(0, 100), accessToken });
  cache.at = 0;
  res.json({ ok: true });
}));

app.delete('/api/items/:itemId', wrap(async (req, res) => {
  const item = store.itemsWithTokens().find((i) => i.itemId === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  await removeItem(plaid, item.accessToken).catch((err) => console.warn('Plaid itemRemove failed:', err?.response?.data || err.message));
  store.removeItem(item.itemId);
  cache.at = 0;
  res.json({ ok: true });
}));

app.post('/api/import-csv', wrap(async (req, res) => {
  const { label, csv } = req.body || {};
  if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'csv text is required' });
  const name = String(label || 'Cash App').slice(0, 60);
  let transactions;
  try {
    transactions = transactionsFromCsv(csv, { institution: name });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const id = store.addCsvImport({ label: name, transactions });
  res.json({ ok: true, id, count: transactions.length });
}));

app.delete('/api/csv/:id', wrap(async (req, res) => {
  store.removeCsvImport(req.params.id);
  res.json({ ok: true });
}));

app.put('/api/settings', wrap(async (req, res) => {
  res.json(store.updateSettings(req.body || {}));
}));

app.listen(PORT, HOST, () => {
  console.log(`Finance dashboard running at http://localhost:${PORT}`);
  console.log(DEMO ? 'Mode: DEMO (sample data). Add Plaid keys to .env to connect real accounts.' : `Mode: Plaid ${PLAID_ENV}`);
});
