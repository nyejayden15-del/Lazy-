const $ = (id) => document.getElementById(id);
const money = (n, cents = false) => (n == null ? '—' : Number(n).toLocaleString('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0,
}));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—');
const FREQ = { WEEKLY: 'Weekly', BIWEEKLY: 'Every 2 weeks', SEMI_MONTHLY: 'Twice a month', MONTHLY: 'Monthly', ANNUALLY: 'Yearly', UNKNOWN: '—' };

let status = { demo: true };
let data = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function banner(msg) {
  const b = $('banner');
  b.hidden = !msg;
  b.innerHTML = msg || '';
}

async function load(refresh = false) {
  $('updated').textContent = refresh ? 'Refreshing from your banks…' : 'Loading…';
  try {
    data = await api(`/api/dashboard${refresh ? '?refresh=1' : ''}`);
    render();
  } catch (err) {
    $('updated').textContent = '';
    banner(`Couldn't load your data: ${esc(err.message)}`);
  }
}

function table(headers, rows, empty) {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  const th = headers.map((h) => `<th${h.num ? ' class="num"' : ''}>${esc(h.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${headers[i].num ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function render() {
  const k = data.kpis;
  $('updated').textContent = `Updated ${new Date(data.generatedAt).toLocaleString()}`;

  const warn = data.warnings.map((w) => `${esc(w.institution)}: ${esc(w.message)}${w.code === 'ITEM_LOGIN_REQUIRED' ? ' Remove and reconnect this bank.' : ''}`);
  if (!data.accounts.length && !status.demo) warn.unshift('No accounts connected yet. Click <b>+ Connect account</b> to link your bank, credit cards, Cash App or Fidelity.');
  banner(warn.join('<br>'));

  const tiles = [
    ['Net worth', money(k.netWorth), 'cash + investments − debt'],
    ['Total debt', money(k.totalDebt), `${data.debts.length} account${data.debts.length === 1 ? '' : 's'}`],
    ['Cash', money(k.cash), 'checking, savings, Cash App'],
    ['Investments', money(k.investments), 'brokerage & retirement'],
    ['Monthly income', money(k.monthlyIncome), k.incomeIsOverride ? 'entered by you' : 'detected paychecks'],
    ['Bills / month', money(k.monthlyBills), `${data.bills.length} recurring`],
    ['Subscriptions / month', money(k.monthlySubscriptions), `${money(k.monthlySubscriptions * 12)} a year`],
    ['Left over / month', money(k.monthlySurplus), 'after spending & minimums'],
  ];
  $('kpis').innerHTML = tiles.map(([l, v, s]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div>`).join('');

  renderPlan();

  $('upcoming').innerHTML = table(
    [{ label: 'Date' }, { label: 'What' }, { label: 'Amount', num: true }],
    data.upcoming.map((u) => [
      u.overdue ? '<span class="status critical">Overdue</span>' : esc(shortDate(u.date)),
      `${esc(u.name)}<div class="muted small">${esc(u.kind === 'debt' ? 'minimum payment' : u.kind)} · ${esc(u.institution)}</div>`,
      `${money(u.amount, true)}${u.estimated ? '*' : ''}`,
    ]),
    'Nothing due in the next 30 days.',
  );

  $('debts').innerHTML = table(
    [{ label: 'Account' }, { label: 'APR', num: true }, { label: 'Minimum', num: true }, { label: 'Balance', num: true }],
    data.debts.map((d) => [
      `${esc(d.name)}${d.isOverdue ? ' <span class="status critical">Overdue</span>' : ''}<div class="muted small">${esc(d.institution)}${d.limit ? ` · ${Math.round((d.balance / d.limit) * 100)}% of ${money(d.limit)} limit` : ''}</div>`,
      `${d.apr}%${d.aprEstimated ? '*' : ''}`,
      `${money(d.minPayment, true)}${d.minEstimated ? '*' : ''}`,
      money(d.balance, true),
    ]),
    'No debt found on linked accounts.',
  ) + (data.debts.some((d) => d.aprEstimated || d.minEstimated) ? '<p class="muted small">* estimated; your bank didn\'t report it.</p>' : '');

  const recurringTable = (list, empty) => table(
    [{ label: 'Name' }, { label: 'How often' }, { label: 'Next' }, { label: 'Per month', num: true }],
    list.map((r) => [
      `${esc(r.name)}<div class="muted small">${esc(r.institution)}${r.confidence === 'early' ? ' · newly detected' : ''}</div>`,
      `${esc(FREQ[r.frequency] || r.frequency)} · ${money(r.amount, true)}`,
      esc(shortDate(r.nextDate)),
      money(r.monthlyAmount, true),
    ]),
    empty,
  );
  $('bills').innerHTML = recurringTable([...data.bills, ...data.otherRecurring], 'No recurring bills detected yet. Plaid needs a few months of history to spot them.');
  $('subs').innerHTML = recurringTable(data.subscriptions, 'No subscriptions detected.');

  $('holdings').innerHTML = table(
    [{ label: 'Holding' }, { label: 'Gain', num: true }, { label: 'Value', num: true }],
    data.holdings.map((h) => {
      const gain = h.costBasis != null ? h.value - h.costBasis : null;
      return [
        `${esc(h.ticker || '')} <span class="muted">${esc(h.name)}</span><div class="muted small">${esc(h.institution)}</div>`,
        gain == null ? '—' : `${gain >= 0 ? '+' : '−'}${money(Math.abs(gain))}`,
        money(h.value, true),
      ];
    }),
    'No investment accounts linked. Connect Fidelity to see holdings.',
  );

  $('accounts').innerHTML = table(
    [{ label: 'Account' }, { label: 'Type' }, { label: 'Balance', num: true }],
    data.accounts.map((a) => [
      `${esc(a.name)}${a.mask ? ` ••${esc(a.mask)}` : ''}<div class="muted small">${esc(a.institution)}</div>`,
      esc(a.subtype || a.type),
      money(a.balance, true),
    ]),
    'No accounts yet.',
  );

  const c = data.connections;
  const conn = [
    ...c.items.map((i) => [esc(i.institution), 'Linked via Plaid', `<button class="btn link" data-remove-item="${esc(i.itemId)}">Remove</button>`]),
    ...c.csvImports.map((i) => [esc(i.label), `CSV · ${i.count} transactions`, `<button class="btn link" data-remove-csv="${esc(i.id)}">Remove</button>`]),
  ];
  $('connections').innerHTML = status.demo
    ? '<p class="muted small">Demo mode: showing sample data. Add your Plaid keys to <code>.env</code> and restart to link real accounts.</p>' + (conn.length ? table([{ label: 'Source' }, { label: 'Type' }, { label: '' }], conn, '') : '')
    : table([{ label: 'Source' }, { label: 'Type' }, { label: '' }], conn, 'Nothing connected yet.');

  const s = data.settings;
  $('set-income').value = s.monthlyIncomeOverride ?? '';
  $('set-income').placeholder = `auto: ${money(k.detectedIncome)}`;
  $('set-extra').value = s.extraDebtPayment ?? '';
  $('set-extra').placeholder = `auto: ${money(data.plan.extraIsAutomatic ? data.plan.extraDebtPayment : 0)}`;
  $('set-strategy').value = s.strategy;
}

const STATUS_LABEL = { done: ['✓', 'Done'], action: ['→', 'Do now'], urgent: ['!', 'Urgent'], later: ['…', 'Next up'], info: ['i', 'Tip'] };

function renderPlan() {
  const p = data.plan;
  $('plan-sub').textContent = `${money(data.kpis.monthlySurplus)}/month left over after spending and ${money(p.minPayments)} in minimum payments`;
  $('steps').innerHTML = p.steps.map((s) => {
    const [icon, label] = STATUS_LABEL[s.status] || STATUS_LABEL.info;
    const progress = s.progress != null && s.status !== 'done'
      ? `<div class="progress" role="progressbar" aria-valuenow="${Math.round(s.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${Math.round(s.progress * 100)}%"></div></div>` : '';
    return `<li class="step ${s.status}"><span class="icon ${s.status}" aria-hidden="true">${icon}</span>
      <div class="title">${esc(s.title)}<span class="tag">${label}</span></div><p>${esc(s.detail)}</p>${progress}</li>`;
  }).join('');

  const debtStep = p.steps.find((s) => s.id === 'debt' && s.payoff);
  $('payoff-wrap').hidden = !debtStep;
  if (debtStep) renderPayoffChart(debtStep.payoff);

  const b = p.budget;
  if (b.income) {
    const cell = (name, x, hint) => `<div class="b"><div class="muted small">${name} · target ${x.target}%</div><div class="pct">${x.pct}%</div><div class="muted small">${money(x.amount)}/mo · ${hint}</div></div>`;
    $('budget').innerHTML = `<h3>Where your income goes (50/30/20 guideline)</h3><div class="budget">
      ${cell('Needs', b.needs, 'housing, bills, groceries, minimums')}
      ${cell('Wants', b.wants, 'eating out, shopping, subscriptions')}
      ${cell('Savings & extra debt', b.savingsAndExtraDebt, 'what\'s left to work with')}</div>`;
  } else {
    $('budget').innerHTML = '';
  }
}

function renderPayoffChart(payoff) {
  const plan = payoff.series;
  const minOnly = payoff.minimumOnlySeries || [];
  const months = Math.min(120, Math.max(plan.length, minOnly.length) - 1);
  const series = [
    { name: `Your plan (+${money(payoff.extra)}/mo)`, color: 'var(--series-1)', values: plan.slice(0, months + 1) },
    { name: 'Minimum payments only', color: 'var(--series-2)', values: minOnly.slice(0, months + 1) },
  ].filter((s) => s.values.length);

  $('payoff-legend').innerHTML = series.map((s) => `<span><span class="sw" style="background:${s.color}"></span>${esc(s.name)}</span>`).join('');

  const el = $('payoff-chart');
  const W = Math.max(300, el.clientWidth || 600);
  const H = 220;
  const m = { t: 10, r: 12, b: 26, l: 56 };
  const maxY = Math.max(...series.flatMap((s) => s.values)) || 1;
  const niceMax = niceCeil(maxY);
  const x = (i) => m.l + (i / Math.max(1, months)) * (W - m.l - m.r);
  const y = (v) => m.t + (1 - v / niceMax) * (H - m.t - m.b);

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * niceMax);
  const xStep = months <= 12 ? 2 : months <= 36 ? 6 : 12;
  const xTicks = [];
  for (let i = 0; i <= months; i += xStep) xTicks.push(i);

  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Debt balance over time: your plan versus minimum payments only">
    <g class="grid">${yTicks.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 8}" y="${y(t) + 4}" text-anchor="end">${money(t)}</text>`).join('')}</g>
    ${xTicks.map((t) => `<text x="${x(t)}" y="${H - 6}" text-anchor="middle">${t === 0 ? 'Now' : `${t} mo`}</text>`).join('')}
    ${series.map((s) => `<path d="${path(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`).join('')}
    <line id="xhair" y1="${m.t}" y2="${H - m.b}" stroke="var(--text-muted)" stroke-width="1" visibility="hidden"/>
    ${series.map((s, i) => `<circle id="dot${i}" r="4" fill="${s.color}" stroke="var(--surface-1)" stroke-width="2" visibility="hidden"/>`).join('')}
    <rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" id="hit"/>
  </svg>`;

  const svg = el.querySelector('svg');
  const tip = $('tooltip');
  const hit = el.querySelector('#hit');
  const hide = () => {
    tip.hidden = true;
    svg.querySelector('#xhair').setAttribute('visibility', 'hidden');
    series.forEach((_, i) => svg.querySelector(`#dot${i}`).setAttribute('visibility', 'hidden'));
  };
  hit.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(months, Math.round(((px - m.l) / (W - m.l - m.r)) * months)));
    const xh = svg.querySelector('#xhair');
    xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.setAttribute('visibility', 'visible');
    const lines = series.map((s, si) => {
      const v = s.values[Math.min(i, s.values.length - 1)];
      const dot = svg.querySelector(`#dot${si}`);
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(v)); dot.setAttribute('visibility', 'visible');
      return `<div><span class="sw" style="display:inline-block;width:10px;height:3px;background:${s.color};vertical-align:middle;margin-right:6px"></span>${esc(s.name)}: <b>${money(v)}</b></div>`;
    });
    tip.innerHTML = `<div class="muted small">${i === 0 ? 'Today' : `Month ${i}`}</div>${lines.join('')}`;
    tip.hidden = false;
    const tx = Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14);
    tip.style.left = `${tx}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  hit.addEventListener('pointerleave', hide);

  const rows = [];
  for (let i = 0; i <= months; i += xStep) rows.push([i === 0 ? 'Now' : `Month ${i}`, ...series.map((s) => money(s.values[Math.min(i, s.values.length - 1)]))]);
  $('payoff-table').innerHTML = table([{ label: 'When' }, ...series.map((s) => ({ label: s.name, num: true }))], rows, '');
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((f) => f * p).find((n) => n >= v);
}

// --- Plaid Link ---
async function connect() {
  if (status.demo) {
    banner('Demo mode: add your Plaid keys to <code>.env</code> and restart the server to connect real accounts. See README.md.');
    return;
  }
  try {
    const { linkToken } = await api('/api/link-token', { method: 'POST', body: {} });
    const handler = window.Plaid.create({
      token: linkToken,
      onSuccess: async (publicToken, metadata) => {
        banner('Connected! Pulling your data…');
        await api('/api/exchange', { method: 'POST', body: { publicToken, institution: metadata.institution?.name } });
        banner('');
        await load(true);
      },
      onExit: (err) => { if (err) banner(`Connection didn't finish: ${esc(err.display_message || err.error_message || err.error_code)}`); },
    });
    handler.open();
  } catch (err) {
    banner(`Couldn't start the connection: ${esc(err.message)}`);
  }
}

// --- events ---
$('connect').addEventListener('click', connect);
$('refresh').addEventListener('click', () => load(true));

$('connections').addEventListener('click', async (e) => {
  const item = e.target.dataset.removeItem;
  const csv = e.target.dataset.removeCsv;
  if (!item && !csv) return;
  if (!confirm('Disconnect this account from the dashboard?')) return;
  await api(item ? `/api/items/${encodeURIComponent(item)}` : `/api/csv/${encodeURIComponent(csv)}`, { method: 'DELETE', body: {} });
  load(true);
});

$('csv-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = $('csv-file').files[0];
  if (!file) return;
  try {
    const r = await api('/api/import-csv', { method: 'POST', body: { label: $('csv-label').value, csv: await file.text() } });
    banner(`Imported ${r.count} transactions.`);
    $('csv-file').value = '';
    load();
  } catch (err) {
    banner(`Import failed: ${esc(err.message)}`);
  }
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/settings', {
    method: 'PUT',
    body: { monthlyIncomeOverride: $('set-income').value, extraDebtPayment: $('set-extra').value, strategy: $('set-strategy').value },
  });
  load();
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => data && renderPlan(), 150);
});

(async () => {
  status = await api('/api/status').catch(() => ({ demo: true }));
  $('mode').textContent = status.demo ? 'Demo data' : `Plaid · ${status.plaidEnv}`;
  load();
})();
