// stocks.adityarjha.com - one Worker: serves the page (public/) and the API below.
// Secrets come from .dev.vars locally, and from `wrangler secret` once deployed.
//
// Sources (all free):
//   Yahoo Finance chart  -> price, day change, 52W range, chart        (no key)
//   IndianAPI.in /stock  -> ratios, financials, peers, shareholding    (INDIANAPI_KEY, 500 calls/month)
//   Yahoo quoteSummary   -> fallback for ratios when IndianAPI has no match or no quota (no key)
//   Yahoo search         -> fallback search for names not in public/symbols.json
//   Google News RSS      -> headlines                                  (no key)

const INDIANAPI = "https://stock.indianapi.in";
const SYMBOL_RE = /^[A-Z0-9&-]{1,20}$/;            // NSE symbols like ITC, ARE&M, BAJAJ-AUTO
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SUFFIX = { NSE: ".NS", BSE: ".BO", IDX: "" };
const RANGES = { "1M": ["1mo", "1d"], "6M": ["6mo", "1d"], "1Y": ["1y", "1d"], "5Y": ["5y", "1wk"] };
const TTL_PRICE = 30 * 60;          // 30 min: price, chart, news
const TTL_FUND = 12 * 60 * 60;      // 12 h: fundamentals (saves the monthly quota)
const TTL_FAIL = 5 * 60;            // 5 min: remember a failed headline fetch, so a dead
                                    // source is not retried on every single request
const GNEWS_DOWN = "gnews-down/v1"; // set when Google News refuses us; skips it for 15 min
const T_FETCH = 8000;               // ms: upstream budget, so one slow source cannot hang a reply
const T_NEWS = 4000;                // ms: headlines are secondary, so they get less

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/stock") return json(await stockRoute(url, env, ctx));
      if (url.pathname === "/api/index") return json(await indexRoute(url, ctx));
      if (url.pathname === "/api/chart") return json(await chartRoute(url, ctx));
      if (url.pathname === "/api/watchlist") return json(await watchlistRoute(request, env));
      if (url.pathname === "/api/symbols") return json(await symbolsRoute(ctx));
      if (url.pathname === "/api/search") return json(await searchRoute(url, env, ctx));
      if (url.pathname === "/api/raw") return await rawRoute(url, env);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);
    }
    return env.ASSETS.fetch(request);   // everything else: the page and its files
  },
};

// One click = one call here.
async function stockRoute(url, env, ctx) {
  const s = readSymbol(url), ex = readEx(url);
  const quote = await settle(cached(`y2/${ex}/${s}/1Y`, TTL_PRICE, ctx, () => yahoo(s, ex, "1Y")));
  const qName = quote.ok ? quote.data.name : null;
  // Fundamentals: IndianAPI first (has peers, results, shareholding). If it has no
  // matching company or no quota left, fall back to Yahoo for the key ratios.
  const missKey = `i-miss/${s}`;
  let fundamentals = (await cacheGet(missKey))
    ? { ok: false, error: "IndianAPI has no exact match for " + s + " (remembered)" }
    : await settle(cached(`i/v3/${s}`, TTL_FUND, ctx, () => indianApiStock(s, qName, env)));
  if (!fundamentals.ok && /no exact match/.test(fundamentals.error) && !/remembered/.test(fundamentals.error)) {
    ctx.waitUntil(cachePut(missKey, 6 * 3600, { miss: true }));
  }
  if (!fundamentals.ok) {
    const why = fundamentals.error;
    fundamentals = await settle(cached(`yf/${ex}/${s}`, TTL_FUND / 2, ctx, () => yahooFundamentals(s, ex)));
    fundamentals.primaryError = why;
  }
  const name = qName || (fundamentals.ok && fundamentals.data.companyName) || s;
  const news = await settle(cached(`n/${s}`, TTL_PRICE, ctx, () => headlines(name, false, ctx), TTL_FAIL));
  return { symbol: s, exchange: ex, fetchedAt: new Date().toISOString(), quote, fundamentals, news };
}

// Home page: the Nifty 50 index (price, chart) plus market headlines.
async function indexRoute(url, ctx) {
  const r = RANGES[url.searchParams.get("range")] ? url.searchParams.get("range") : "1Y";
  const quote = await settle(cached(`idx/NSEI/${r}`, TTL_PRICE, ctx, () => yahoo("^NSEI", "IDX", r)));
  if (url.searchParams.get("news") !== "1") return { quote };
  const news = await settle(cached("n/market", TTL_PRICE, ctx, () => headlines("Nifty Sensex stock market today", true, ctx), TTL_FAIL));
  return { fetchedAt: new Date().toISOString(), quote, news };
}

async function chartRoute(url, ctx) {
  const s = readSymbol(url), ex = readEx(url);
  const r = RANGES[url.searchParams.get("range")] ? url.searchParams.get("range") : "1Y";
  return settle(cached(`y2/${ex}/${s}/${r}`, TTL_PRICE, ctx, () => yahoo(s, ex, r)));
}

// Fallback search (the page searches public/symbols.json first).
async function searchRoute(url, env, ctx) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 60);
  if (q.length < 2) return { ok: true, data: [] };
  const first = await yahooSearch(q, ctx);
  // "deep" is sent only when the user presses Enter and nothing else matched.
  // It uses 1 IndianAPI call, so it is never used while typing.
  if (url.searchParams.get("deep") !== "1" || (first.ok && first.data.length)) return first;
  // IndianAPI's /stock endpoint accepts loose names ("jb chemicals"). We keep its
  // answer in the cache, so opening the stock right after costs no extra call.
  return settle(cached(`s3/${q.toLowerCase()}`, TTL_FUND, ctx, async () => {
    const d = await indianApiRaw(q, env);
    const nse = String(d.companyProfile?.exchangeCodeNse || "").toUpperCase();
    const bse = String(d.companyProfile?.exchangeCodeBse || "");
    const sym = SYMBOL_RE.test(nse) ? nse : SYMBOL_RE.test(bse) ? bse : null;
    if (!sym) throw new Error("no exchange code in the answer");
    await cachePut(`i/v3/${sym}`, TTL_FUND, { data: summarize(d, sym), source: "IndianAPI" });
    await caches.default.delete(new Request("https://cache.stocks.local/" + encodeURIComponent(`i-miss/${sym}`)));
    return { data: [{ s: sym, n: d.companyName, nse: sym === nse, bse: !!bse }] };
  }));
}

// Shared watchlist, kept in Cloudflare KV (a small key-value store, free tier).
// GET returns the saved list (null if never saved). PUT replaces it.
async function watchlistRoute(request, env) {
  if (!env.STORE) throw new Error("storage not configured");
  if (request.method === "GET") return { ok: true, list: await env.STORE.get("watchlist", "json") };
  if (request.method !== "PUT") throw new Error("method not allowed");
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body) || body.length > 60) throw new Error("bad watchlist");
  const seen = new Set(), list = [];
  for (const x of body) {
    const sym = String(x?.s || "").toUpperCase();
    if (!SYMBOL_RE.test(sym) || seen.has(sym)) continue;
    seen.add(sym);
    list.push({ s: sym, n: String(x?.n || sym).replace(/[<>]/g, "").slice(0, 60) });
  }
  await env.STORE.put("watchlist", JSON.stringify(list));
  return { ok: true, list };
}

// Full list of NSE-listed companies (symbol + name) for instant search on the page.
// NSE publishes this as a public download. We fetch it at most once every 30 days.
function symbolsRoute(ctx) {
  return settle(cached("nse-list/v1", 30 * 24 * 3600, ctx, async () => {
    const res = await fetchT("https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv", { headers: { "User-Agent": UA, Accept: "text/csv,*/*" } }, 15000);
    if (!res.ok) throw new Error(`NSE list HTTP ${res.status}`);
    const rows = (await res.text()).split(/\r?\n/).slice(1);
    const data = [];
    for (const line of rows) {
      const m = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*),/);
      if (!m) continue;
      const sym = m[1].trim().toUpperCase(), name = m[2].replace(/^"|"$/g, "").replace(/""/g, '"').trim();
      if (SYMBOL_RE.test(sym) && name) data.push([sym, name]);
    }
    if (data.length < 500) throw new Error("NSE list looks incomplete");
    return { data };
  }));
}

async function yahooSearch(q, ctx) {
  const key = `s/${q.toLowerCase()}`;
  const hit = await cacheGet(key);
  if (hit) return { ok: true, ...hit, cached: true };
  const out = await settle((async () => {
    const res = await fetchT(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&region=IN`, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`Yahoo search HTTP ${res.status}`);
    const j = await res.json();
    const map = new Map();
    for (const x of j.quotes || []) {
      if (x.quoteType !== "EQUITY" || !["NSI", "BSE"].includes(x.exchange)) continue;
      const m = String(x.symbol).match(/^(.+)\.(NS|BO)$/);
      if (!m || !SYMBOL_RE.test(m[1])) continue;
      const e = map.get(m[1]) || { s: m[1], n: x.longname || x.shortname || m[1], nse: false, bse: false };
      if (m[2] === "NS") e.nse = true; else e.bse = true;
      map.set(m[1], e);
    }
    return { data: [...map.values()].slice(0, 8) };
  })());
  if (out.ok && out.data.length) ctx.waitUntil(cachePut(key, TTL_FUND, { data: out.data }));   // empty answers are not kept
  return out;
}

// Dev-only helper: see IndianAPI's raw answer while we map fields.
// Works only when DEV_DEBUG=1 in .dev.vars and only on localhost. Each call uses 1 of the 500 monthly calls.
async function rawRoute(url, env) {
  if (env.DEV_DEBUG !== "1" || !["localhost", "127.0.0.1"].includes(url.hostname)) return json({ error: "not found" }, 404);
  const s = readSymbol(url);
  if (url.searchParams.get("src") === "yahoo") return json(await settle(yahooFundamentals(s, readEx(url))));
  const out = await indianApiRaw(s, env).then(data => ({ data, summary: summarize(data, s) })).catch(e => ({ error: String(e.message || e) }));
  return json(out);
}

// ---------- Yahoo ----------
async function yahoo(symbol, ex, range) {
  const [r, interval] = RANGES[range];
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol + SUFFIX[ex])}?range=${r}&interval=${interval}`;
  const res = await fetchT(u, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const j = await res.json();
  const r0 = j?.chart?.result?.[0];
  if (!r0) throw new Error(j?.chart?.error?.description || "Yahoo returned no data");
  const m = r0.meta || {};
  if (m.regularMarketPrice == null) throw new Error("Yahoo returned no price");
  const closes = r0.indicators?.quote?.[0]?.close || [];
  let points = (r0.timestamp || []).map((t, i) => [t, closes[i]]).filter(p => p[1] != null);
  // Yahoo often has no BSE price history. Then we show the NSE history (same company) and say so.
  let chartFrom = ex;
  if (ex === "BSE" && points.length < 5) {
    const alt = await yahoo(symbol, "NSE", range).catch(() => null);
    if (alt && alt.data.points.length >= 5) { points = alt.data.points; chartFrom = "NSE"; }
  }
  return {
    data: {
      name: m.longName || m.shortName || symbol,
      price: m.regularMarketPrice,
      change: m.fulldayChange ?? null,
      changePct: m.regularMarketChangePercent ?? m.fulldayChangePercent ?? null,
      high52: m.fiftyTwoWeekHigh ?? null,
      low52: m.fiftyTwoWeekLow ?? null,
      time: m.regularMarketTime ?? null,
      range, exchange: ex, chartFrom, currency: m.currency || "INR",
      points,
    },
  };
}

// ---------- IndianAPI.in ----------
// /stock takes a name or search term. We pass the NSE symbol, then check the NSE code
// it returns, so a wrong company is flagged instead of silently shown.
async function indianApiRaw(symbol, env) {
  const key = (env.INDIANAPI_KEY || "").trim();
  if (!key || key.startsWith("PASTE")) throw new Error("IndianAPI key missing: add INDIANAPI_KEY to .dev.vars");
  const res = await fetchT(`${INDIANAPI}/stock?name=${encodeURIComponent(symbol)}`, {
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`IndianAPI HTTP ${res.status}: not JSON`); }
  if (!res.ok) throw new Error(`IndianAPI HTTP ${res.status}: ${data?.message || data?.error || data?.detail || "error"}`);
  // A 200 can still be a notice or an empty answer: require real company data.
  if (!data || typeof data !== "object" || !data.companyName || !data.keyMetrics) {
    throw new Error(`IndianAPI returned no company data${data?.message ? ": " + data.message : ""}`);
  }
  return data;
}

async function indianApiStock(symbol, nameHint, env) {
  const codes = d => [d.companyProfile?.exchangeCodeNse, d.companyProfile?.exchangeCodeBse].map(c => String(c || "").toUpperCase());
  // "no company data" is a real no-match. Anything else (rate limit, outage, bad key) is passed up and NOT remembered.
  const tryName = q => indianApiRaw(q, env).catch(e => { if (/no company data/.test(e.message)) return null; throw e; });
  let d = await tryName(symbol);
  if (!d || !codes(d).includes(symbol)) {
    // The source searches by name. Retry once with the company name from Yahoo.
    const clean = (nameHint || "").replace(/\b(limited|ltd\.?)\b/gi, "").replace(/\s+/g, " ").trim();
    d = clean ? await tryName(clean) : null;
    if (!d || !codes(d).includes(symbol)) throw new Error("IndianAPI has no exact match for " + symbol);
  }
  return { data: summarize(d, symbol), source: "IndianAPI" };
}

// ---------- Yahoo quoteSummary (fallback for ratios) ----------
// Needs a cookie + crumb pair, which we fetch once and reuse for an hour.
let yAuth = null;
async function yahooAuth(force) {
  if (!force && yAuth && Date.now() - yAuth.t < 3600e3) return yAuth;
  const r = await fetchT("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const list = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  const cookie = list.map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Yahoo gave no session cookie");
  const c = await fetchT("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await c.text()).trim();
  if (!c.ok || !crumb || crumb.length > 40 || /[<{ ]/.test(crumb)) throw new Error(`Yahoo crumb failed (HTTP ${c.status})`);
  yAuth = { cookie, crumb, t: Date.now() };
  return yAuth;
}

async function yahooFundamentals(symbol, ex) {
  const mods = "summaryDetail,defaultKeyStatistics,financialData,assetProfile,price";
  let j, res;
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await yahooAuth(attempt > 0);
    res = await fetchT(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol + SUFFIX[ex])}?modules=${mods}&crumb=${encodeURIComponent(a.crumb)}`,
      { headers: { "User-Agent": UA, Cookie: a.cookie, Accept: "application/json" } });
    if (res.status !== 401) break;
  }
  if (!res.ok) throw new Error(`Yahoo fundamentals HTTP ${res.status}`);
  j = await res.json();
  const q = j?.quoteSummary?.result?.[0];
  if (!q) throw new Error("Yahoo fundamentals returned no data");
  const raw = o => (o && typeof o.raw === "number" ? o.raw : null);
  const x100 = v => (v == null ? null : v * 100);
  const sd = q.summaryDetail || {}, ks = q.defaultKeyStatistics || {}, fd = q.financialData || {}, ap = q.assetProfile || {}, pr = q.price || {};
  const mcap = raw(sd.marketCap) ?? raw(pr.marketCap);
  const de = raw(fd.debtToEquity);
  const ratios = {
    mcap: mcap == null ? null : mcap / 1e7,           // rupees -> Rs Cr
    pe: raw(sd.trailingPE), pb: raw(ks.priceToBook), dy: x100(raw(sd.dividendYield)),
    roe: x100(raw(fd.returnOnEquity)), roi: null, roa: x100(raw(fd.returnOnAssets)),
    de: de == null ? null : de / 100,                 // Yahoo gives a percentage
    ltde: null, opm: x100(raw(fd.operatingMargins)), npm: x100(raw(fd.profitMargins)),
  };
  if (ratios.pe == null && ratios.pb == null && ratios.mcap == null) throw new Error("Yahoo fundamentals are empty for this stock");
  return {
    data: { companyName: pr.longName || pr.shortName || symbol, industry: ap.industry || ap.sector || null,
      description: ap.longBusinessSummary || "", nse: symbol, bse: null, ratios, peers: [], quarterly: [], annual: [], shareholding: [] },
    source: "Yahoo Finance",
  };
}

// Keep only what the page uses (smaller cache, simpler page code).
function summarize(d, symbol) {
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const kv = {};
  for (const group of Object.values(d.keyMetrics || {})) {
    if (Array.isArray(group)) for (const x of group) kv[String(x.key).replace(/\)$/, "")] = num(x.value);
  }
  const prof = d.companyProfile || {};
  const ratios = {
    mcap: kv.marketCap,                                            // Rs Cr
    pe: kv.pPerEBasicExcludingExtraordinaryItemsTTM,
    pb: kv.priceToBookMostRecentQuarter ?? kv.priceToBookMostRecentFiscalYear,
    dy: kv.currentDividendYieldCommonStockPrimaryIssueLTM,
    roe: kv.returnOnAverageEquityTrailing12Month,
    roi: kv.returnOnInvestmentTrailing12Month,                     // no ROCE in this source
    de: kv.totalDebtPerTotalEquityMostRecentQuarter,
    ltde: kv.ltDebtPerEquityMostRecentFiscalYear,
    opm: kv.operatingMarginTrailing12Month,
    npm: kv.netProfitMarginPercentTrailing12Month,
  };
  const peers = (prof.peerCompanyList || []).map(p => ({
    name: p.companyName, price: num(p.price), chgPct: num(p.percentChange), mcap: num(p.marketCap),
    pe: num(p.priceToEarningsValueRatio), pb: num(p.priceToBookValueRatio),
    roe: num(p.returnOnAverageEquityTrailing12Month), npm: num(p.netProfitMarginPercentTrailing12Month),
    ltde: num(p.ltDebtPerEquityMostRecentFiscalYear), dy: num(p.dividendYieldIndicatedAnnualDividend),
    rating: p.overallRating || null,
  }));
  const fin = Array.isArray(d.financials) ? d.financials : [];
  const row = x => {
    const m = {};
    for (const r of x.stockFinancialMap?.INC || []) m[r.key] = num(r.value);
    const rev = m.TotalRevenue ?? m.Revenue, op = m.OperatingIncome;
    return { end: x.EndDate, fy: x.FiscalYear, revenue: rev, opInc: op,
      opm: rev && op != null ? (op / rev) * 100 : null, netProfit: m.NetIncome,
      eps: m.DilutedEPSExcludingExtraOrdItems ?? m.DilutedNormalizedEPS ?? null };
  };
  const byType = t => fin.filter(x => x.Type === t).sort((a, b) => (a.EndDate < b.EndDate ? 1 : -1)).map(row);
  const shareholding = (d.shareholding || []).map(s => {
    const c = (s.categories || []).slice().sort((a, b) => (a.holdingDate < b.holdingDate ? -1 : 1));
    const last = c[c.length - 1], prev = c[c.length - 2];
    return { name: s.displayName, pct: last ? num(last.percentage) : null, prevPct: prev ? num(prev.percentage) : null, date: last ? last.holdingDate : null };
  });
  return {
    companyName: d.companyName, industry: d.industry || prof.mgIndustry || null,
    description: prof.companyDescription || "", nse: prof.exchangeCodeNse || symbol, bse: prof.exchangeCodeBse || null,
    ratios, peers, quarterly: byType("Interim").slice(0, 8), annual: byType("Annual").slice(0, 5), shareholding,
  };
}

// ---------- Headlines ----------
// Google News RSS is the better source, but it answers 503 to some data-centre
// addresses, including the ones this Worker goes out on. When that happens we note it
// for 15 minutes and serve Yahoo's headlines instead, rather than paying Google's
// timeout on every request.
async function headlines(name, asIs, ctx) {
  if (!(await cacheGet(GNEWS_DOWN))) {
    try {
      return await googleNews(name, asIs);
    } catch (e) {
      ctx.waitUntil(cachePut(GNEWS_DOWN, 15 * 60, { why: String(e.message || e) }));
    }
  }
  return yahooNews(name, asIs);
}

async function googleNews(companyName, asIs) {
  const clean = companyName.replace(/\b(limited|ltd\.?)\b/gi, "").replace(/\s+/g, " ").trim();
  const q = encodeURIComponent(asIs ? companyName : `"${clean}" share`);
  const res = await fetchT(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`, { headers: { "User-Agent": UA } }, T_NEWS);
  if (!res.ok) throw new Error(`Google News HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const get = tag => {
      const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return r ? decodeXml(r[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : "";
    };
    const source = get("source");
    let title = get("title");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    items.push({ title, link: get("link"), date: get("pubDate"), source });
  }
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;   // last 60 days
  const list = items
    .filter(i => i.title && i.link && Date.parse(i.date) > cutoff)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 10);
  return { data: { query: clean, items: list } };
}

// Same shape as googleNews, from the search endpoint the fallback search already uses.
async function yahooNews(companyName, asIs) {
  const clean = companyName.replace(/\b(limited|ltd\.?)\b/gi, "").replace(/\s+/g, " ").trim();
  const q = asIs ? "Nifty 50 India stock market" : clean;
  const res = await fetchT(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=12&region=IN`,
    { headers: { "User-Agent": UA, Accept: "application/json" } }, T_NEWS);
  if (!res.ok) throw new Error(`Yahoo news HTTP ${res.status}`);
  const j = await res.json();
  const items = (j.news || [])
    .map(n => ({
      title: String(n.title || "").trim(),
      link: n.link || "",
      date: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toUTCString() : "",
      source: n.publisher || "",
    }))
    .filter(i => i.title && i.link)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 10);
  if (!items.length) throw new Error("no headlines for this company");
  return { data: { query: clean, items } };
}

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// ---------- helpers ----------
// Every outbound call gets a deadline. Without one, a source that stalls (or answers
// slowly before refusing) holds the whole reply open for as long as it likes.
function fetchT(url, opts = {}, ms = T_FETCH) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

async function cacheGet(key) {
  const hit = await caches.default.match(new Request("https://cache.stocks.local/" + encodeURIComponent(key)));
  return hit ? hit.json() : null;
}

function cachePut(key, ttl, value) {
  const req = new Request("https://cache.stocks.local/" + encodeURIComponent(key));
  return caches.default.put(req, new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } }));
}

// Cache successful answers. A failure sticks only when the caller asks for it with
// failTtl, and then only briefly: long enough to stop one dead source from costing
// every visitor a wait, short enough that the source is picked up again when it returns.
async function cached(key, ttl, ctx, loader, failTtl = 0) {
  const cache = caches.default;
  const req = new Request("https://cache.stocks.local/" + encodeURIComponent(key));
  const hit = await cache.match(req);
  if (hit) {
    const v = await hit.json();
    if (v && v.__fail) throw new Error(v.error);
    return { ...v, cached: true };
  }
  let value;
  try {
    value = await loader();
  } catch (e) {
    const msg = String(e.message || e);
    if (failTtl) ctx.waitUntil(cachePut(key, failTtl, { __fail: true, error: msg }));
    throw e;
  }
  const res = new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` } });
  ctx.waitUntil(cache.put(req, res));
  return value;
}

function settle(p) {
  return p.then(v => ({ ok: true, ...v }), e => ({ ok: false, error: String(e.message || e) }));
}

function readEx(url) {
  return (url.searchParams.get("ex") || "NSE").toUpperCase() === "BSE" ? "BSE" : "NSE";
}

function readSymbol(url) {
  const s = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw new Error("Invalid symbol");
  return s;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
