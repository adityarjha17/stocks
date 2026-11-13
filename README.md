# 1.Stocks

Personal stock analysis page for Indian stocks. Live at https://stocks.adityarjha.com
One Cloudflare Worker serves the page (public/) and a small API (src/index.js).

## Data sources (all free)
- Yahoo Finance: price, day change, 52-week range, charts, search backup, fallback ratios
- IndianAPI.in (free plan, 500 calls/month): ratios, peers, results, shareholding
- Google News RSS: headlines. Google answers 503 to Cloudflare's addresses, so when
  that happens the Worker notes it for 15 minutes and uses Yahoo's per-ticker RSS feed instead.
- NSE company list (public/symbols.json): instant name search. Refresh it monthly with `npm run update-symbols`.

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
