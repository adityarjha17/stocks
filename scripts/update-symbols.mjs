// Saves NSE's public list of listed companies into public/symbols.json,
// so the page can search company names without asking NSE at runtime.
// Run by start.cmd when the file is missing or older than 30 days.
import { writeFileSync, statSync } from "node:fs";

const OUT = new URL("../public/symbols.json", import.meta.url);
const MAX_AGE_DAYS = 30;

try {
  const age = (Date.now() - statSync(OUT).mtimeMs) / 864e5;
  if (age < MAX_AGE_DAYS && !process.argv.includes("--force")) {
    console.log(`Company list is ${Math.floor(age)} days old. No update needed.`);
    process.exit(0);
  }
} catch { /* file missing: download it */ }

try {
  const res = await fetch("https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv", {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "text/csv,*/*" },
    signal: AbortSignal.timeout(20000),   // never block start-up for long
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.text()).split(/\r?\n/).slice(1);
  const list = [];
  for (const line of rows) {
    const m = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*),/);
    if (!m) continue;
    const sym = m[1].trim().toUpperCase();
    const name = m[2].replace(/^"|"$/g, "").replace(/""/g, '"').trim();
    if (/^[A-Z0-9&-]{1,20}$/.test(sym) && name) list.push([sym, name]);
  }
  if (list.length < 500) throw new Error(`only ${list.length} rows, looks incomplete`);
  writeFileSync(OUT, JSON.stringify(list));
  console.log(`Saved ${list.length} NSE companies to public/symbols.json`);
} catch (e) {
  // Not fatal: the page falls back to asking the server for the list.
  console.log(`Could not update the company list (${e.message}). Continuing.`);
}
