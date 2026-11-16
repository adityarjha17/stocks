# 1.Stocks

Personal stock analysis page for Indian stocks. Live at https://stocks.adityarjha.com
One Cloudflare Worker serves the page (public/) and a small API (src/index.js).

## Data sources (all free)
- Yahoo Finance: price, day change, 52-week range, charts, the 9 ratio blocks (market cap, P/E, P/B, dividend yield, ROCE, ROE, ROA, debt/equity, OPM), quarterly and annual results, and every figure in the peers table
- IndianAPI.in (free plan, 500 calls/month): the list of peer companies, shareholding, company description, and quarterly results when Yahoo has none recent (mostly banks)
- Google News RSS, with Yahoo headlines as backup: news
- NSE company list (public/symbols.json): instant name search. Refresh it monthly with `npm run update-symbols`.

ROCE is calculated as EBIT / (total assets - current liabilities) from Yahoo's latest annual figures.

## Run locally (Windows)
1. First time only: double-click setup.cmd (installs Node.js and Wrangler).
2. Create a file named .dev.vars in this folder with:
       INDIANAPI_KEY=your_key_here
3. Double-click start.cmd, then open http://localhost:8787

## Deploy
Connected to Cloudflare Workers Builds: every push to the main branch deploys automatically.
Secrets are set in the Cloudflare dashboard (Worker > Settings > Variables and Secrets), never in this repo.

## Files
- public/index.html     the page
- public/symbols.json   NSE company list for search
- public/favicon.svg    site icon (same as adityarjha.com)
- src/index.js          the Worker: /api/stock, /api/chart, /api/index, /api/search, /api/symbols, /api/watchlist
- scripts/update-symbols.mjs  refreshes the NSE company list
- wrangler.jsonc        Worker settings (name, KV store, custom domain)
