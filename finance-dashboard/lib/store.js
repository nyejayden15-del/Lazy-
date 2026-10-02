// Local JSON storage. Plaid access tokens are encrypted with AES-256-GCM before they touch disk.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  items: [], // { itemId, institution, accessToken (encrypted), addedAt }
  csvImports: [], // { id, label, importedAt, transactions: [...] }
  settings: {
    monthlyIncomeOverride: null,
    extraDebtPayment: null, // null = let the planner choose from your surplus
    strategy: 'avalanche', // or 'snowball'
  },
};

export class Store {
  constructor({ dir, encryptionKeyHex }) {
    this.file = path.join(dir, 'store.json');
    this.dir = dir;
    this.key = encryptionKeyHex ? Buffer.from(encryptionKeyHex, 'hex') : null;
    if (this.key && this.key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
    }
    this.state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...structuredClone(DEFAULT_STATE),
        ...raw,
        settings: { ...DEFAULT_STATE.settings, ...raw.settings },
      };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return structuredClone(DEFAULT_STATE);
    }
  }

  #save() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  #encrypt(plain) {
    if (!this.key) throw new Error('TOKEN_ENCRYPTION_KEY is not set; refusing to store bank tokens unencrypted.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  #decrypt(blob) {
    const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }

  // --- Plaid items ---
  addItem({ itemId, institution, accessToken }) {
    this.state.items = this.state.items.filter((i) => i.itemId !== itemId);
    this.state.items.push({
      itemId,
      institution,
      accessToken: this.#encrypt(accessToken),
      addedAt: new Date().toISOString(),
    });
    this.#save();
  }

  listItems() {
    return this.state.items.map(({ itemId, institution, addedAt }) => ({ itemId, institution, addedAt }));
  }

  itemsWithTokens() {
    return this.state.items.map((i) => ({ ...i, accessToken: this.#decrypt(i.accessToken) }));
  }

  removeItem(itemId) {
    this.state.items = this.state.items.filter((i) => i.itemId !== itemId);
    this.#save();
  }

  // --- CSV imports (e.g. Cash App statements) ---
  addCsvImport({ label, transactions }) {
    const id = crypto.randomUUID();
    this.state.csvImports.push({ id, label, importedAt: new Date().toISOString(), transactions });
    this.#save();
    return id;
  }

  listCsvImports() {
    return this.state.csvImports;
  }

  removeCsvImport(id) {
    this.state.csvImports = this.state.csvImports.filter((c) => c.id !== id);
    this.#save();
  }

  // --- settings ---
  getSettings() {
    return { ...this.state.settings };
  }

  updateSettings(patch) {
    const s = this.state.settings;
    if ('monthlyIncomeOverride' in patch) s.monthlyIncomeOverride = numOrNull(patch.monthlyIncomeOverride);
    if ('extraDebtPayment' in patch) s.extraDebtPayment = numOrNull(patch.extraDebtPayment);
    if ('strategy' in patch && ['avalanche', 'snowball'].includes(patch.strategy)) s.strategy = patch.strategy;
    this.#save();
    return this.getSettings();
  }
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
