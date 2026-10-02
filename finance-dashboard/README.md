# Money Dashboard

A personal finance dashboard that runs on your own computer. It connects to your bank, credit cards, Cash App and Fidelity through [Plaid](https://plaid.com), then shows:

- **Debt**: every credit card and loan, with balance, APR, minimum payment, due date and how much of your limit you're using
- **Renewing bills**: rent, utilities, phone, insurance and so on, plus when each one is due next
- **Subscriptions**: Netflix, Spotify, gym and others, as a monthly and yearly cost
- **Due in the next 30 days**: bills, subscriptions and card payments on one calendar list
- **Investments**: Fidelity (or any brokerage) holdings, with value and gain
- **A financial plan**, worked out from your real numbers:
  1. Catch up on anything overdue and close any monthly shortfall
  2. Keep a $1,000 starter emergency fund
  3. Get your full employer 401(k) match
  4. Pay off high-interest debt with the avalanche or snowball method, including your debt-free date, total interest, and a chart comparing this plan with paying only the minimums
  5. Review your subscriptions
  6. Build a 3-month emergency fund
  7. Invest 15% of income
  
  It also shows a 50/30/20 breakdown of where your money goes.

The plan is plain arithmetic, so you can check every number. It is not professional financial advice.

## Quick start (sample data, no accounts needed)

```bash
cd finance-dashboard
npm install
npm run demo
```

Open http://localhost:3000.

## Connect your real accounts

1. **Create a Plaid account** at https://dashboard.plaid.com/signup and copy your `client_id` and secret from *Developers → Keys*.
2. **Create your `.env`:**
   ```bash
   cp .env.example .env
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into TOKEN_ENCRYPTION_KEY
   ```
   Fill in `PLAID_CLIENT_ID` and `PLAID_SECRET`.
3. **Try it in Sandbox first** (`PLAID_ENV=sandbox`): run `npm start`, click **+ Connect account**, pick any bank, and log in with `user_good` / `pass_good`. This uses fake test data.
4. **Switch to your real accounts:** request Production access in the Plaid dashboard, then set `PLAID_ENV=production` and use your production secret. In the Plaid dashboard, also enable these products:
   - **Transactions**, with the **Recurring Transactions** add-on, for bills and subscriptions
   - **Liabilities**, for credit card APRs, minimum payments and due dates
   - **Investments**, for Fidelity

   Plaid may charge per connected account in Production. Check their current pricing.
5. Click **+ Connect account** once for each institution: your bank, each credit card company, Cash App and Fidelity.

### Notes on specific institutions

| Institution | How it connects | What you get |
|---|---|---|
| Your bank | Plaid | Balances, transactions, recurring bills and subscriptions |
| Credit cards | Plaid (Liabilities) | Balance, APR, minimum payment, due date, overdue status |
| Fidelity | Plaid (Investments) | Holdings and account values. Fidelity uses a secure OAuth login, so Plaid may ask you to finish its OAuth/institution setup in the dashboard first. |
| Cash App | Plaid if it shows up when you search, otherwise **CSV import** | Cash App coverage through data aggregators is limited. If you can't find it in Plaid Link, go to Cash App → Activity → Statements → Export CSV and upload the file under **Connections → Import a CSV**. The dashboard finds recurring charges in the file. A CSV can't show your live Cash App balance. |

The CSV importer works with any bank's CSV that has Date and Amount columns. Negative amounts are treated as money going out.

## Settings

- **Monthly take-home pay**: the dashboard detects paychecks automatically. Enter an amount here if it gets your income wrong, for example if you're paid in cash or by an employer it can't see.
- **Extra toward debt each month**: by default it uses 50–80% of what's left over each month. Set your own number to see how the debt-free date changes.
- **Payoff method**: avalanche (highest APR first) costs the least interest; snowball (smallest balance first) pays off individual cards sooner.

## Privacy & security

- The server listens on `127.0.0.1` only, so other devices on your network can't reach it. It also rejects requests addressed to any host other than localhost and only accepts JSON for changes, which blocks malicious websites from using it.
- Your bank login goes straight to Plaid. This app never sees your passwords.
- Plaid access tokens are encrypted with AES-256-GCM using your `TOKEN_ENCRYPTION_KEY` before they're saved to `data/store.json`. That file is created with owner-only permissions.
- `.env` and `data/` are git-ignored. **Never commit them.**
- **Remove** in the Connections panel also revokes that connection at Plaid.

## How it works

```
server.js            Express server, API routes, localhost-only guards
lib/plaidSync.js     Plaid calls -> one normalized shape (accounts, debts, recurring, holdings, transactions)
lib/classify.js      Decides bill vs subscription vs transfer for recurring charges
lib/csvImport.js     CSV parser + recurring-charge detection for Cash App / other exports
lib/dashboard.js     Combines all sources, works out monthly income/spending, upcoming 30 days
lib/planner.js       Payoff simulation and the step-by-step plan
lib/store.js         Encrypted local storage
public/              The dashboard page (plain HTML/CSS/JS, no build step)
```

Data is cached for 15 minutes. Click **Refresh** to pull fresh numbers from your banks.

Run the tests with `npm test`.
