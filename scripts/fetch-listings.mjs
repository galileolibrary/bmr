#!/usr/bin/env node
// Pulls BMR ownership and rental listings from DAHLIA (housing.sfgov.org) and
// City Second listings from sf.gov, then writes:
//   data/listings.json        - ownership listings in the DAHLIA feed + City Second
//   data/history.json         - every ownership listing ever seen
//   data/rentals.json         - rental listings in the DAHLIA feed
//   data/rental-history.json  - every rental listing ever seen
// Run by .github/workflows/refresh-data.yml. Node 20+, no dependencies.

import { readFile, writeFile } from 'node:fs/promises';
import { normalizeListing, normalizeRental, chartsNeeded, attachLimits } from './normalize.mjs';
import { CITY_SECOND_URL, htmlToText, extractLinks, parseCitySecond } from './citysecond.mjs';

const BASE = 'https://housing.sfgov.org/api/v1/listings';
const UA = 'galileolibrary-bmr-guide (+https://github.com/galileolibrary/bmr)';
const DATA = new URL('../data/', import.meta.url);

async function getJson(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(new URL(name, DATA), 'utf8')); } catch { return fallback; }
}

async function main() {
  const now = new Date().toISOString();
  const feed = await getJson(`${BASE}.json?type=ownership`);
  const browse = feed.listings || [];
  if (!browse.length) throw new Error('DAHLIA returned no ownership listings; keeping previous data.');

  const listings = await mapLimit(browse, 4, async (b) => {
    const id = b.listingID || b.Id;
    const [detail, units, prefs] = await Promise.all([
      getJson(`${BASE}/${id}.json`).catch(() => null),
      getJson(`${BASE}/${id}/units.json`).catch(() => null),
      getJson(`${BASE}/${id}/preferences.json`).catch(() => null),
    ]);
    return normalizeListing(b, detail, units, prefs);
  });

  let citySecond = { ok: false, url: CITY_SECOND_URL, incomeLimitAmi: 148, items: [] };
  try {
    const r = await fetch(CITY_SECOND_URL, { headers: { 'User-Agent': UA } });
    if (r.ok) {
      const html = await r.text();
      citySecond = parseCitySecond(htmlToText(html), extractLinks(html));
    }
  } catch (e) {
    console.warn('City Second page could not be read:', e.message);
  }
  if (!citySecond.ok) {
    const prev = await readJson('listings.json', null);
    if (prev && prev.citySecond && prev.citySecond.ok) citySecond = { ...prev.citySecond, stale: true };
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()); // YYYY-MM-DD, Pacific

  // Only rewrite listings.json when the content actually changed, so the repo
  // doesn't get a commit every few hours for nothing.
  const prev = await readJson('listings.json', null);
  const same = prev && JSON.stringify(prev.listings) === JSON.stringify(listings) && JSON.stringify(prev.citySecond) === JSON.stringify(citySecond);
  if (!same) {
    await writeFile(new URL('listings.json', DATA), JSON.stringify({ updated: now, source: 'https://housing.sfgov.org/listings/for-sale', count: listings.length, listings, citySecond }, null, 1));
  }

  // History: every listing ever seen. Dates are day-level so it changes at most daily.
  const history = await readJson('history.json', { listings: {} });
  const before = JSON.stringify(history.listings);
  for (const l of listings) {
    const h = history.listings[l.id];
    const { notes, amenities, appliances, petPolicy, agent, openHouses, ...slim } = l;
    history.listings[l.id] = { ...slim, firstSeen: h ? h.firstSeen : today, lastSeen: today };
  }
  if (JSON.stringify(history.listings) !== before) {
    history.updated = now;
    await writeFile(new URL('history.json', DATA), JSON.stringify(history, null, 1));
  }

  // Rentals. A failure here shouldn't stop the ownership data from saving.
  let rentalCount = null;
  try {
    const rfeed = await getJson(`${BASE}.json?type=rental`);
    const rbrowse = rfeed.listings || [];
    if (!rbrowse.length) throw new Error('DAHLIA returned no rental listings');
    const rentals = await mapLimit(rbrowse, 4, async (b) => {
      const id = b.listingID || b.Id;
      const [detail, units, prefs] = await Promise.all([
        getJson(`${BASE}/${id}.json`).catch(() => null),
        getJson(`${BASE}/${id}/units.json`).catch(() => null),
        getJson(`${BASE}/${id}/preferences.json`).catch(() => null),
      ]);
      return normalizeRental(b, detail, units, prefs);
    });
    // Exact income limits for every chart the rentals use (MOHCD, TCAC, HUD...).
    const charts = chartsNeeded(rentals);
    const amiAll = { ami: [] };
    for (let i = 0; i < charts.length; i += 10) {
      const q = charts.slice(i, i + 10).map((c) => `year[]=${c.year}&percent[]=${c.percent}&chartType[]=${encodeURIComponent(c.chartType)}`).join('&');
      const res = await getJson(`${BASE}/ami.json?${q}`).catch(() => ({ ami: [] }));
      amiAll.ami.push(...(res.ami || []));
    }
    attachLimits(rentals, amiAll);
    rentalCount = rentals.length;
    const prevR = await readJson('rentals.json', null);
    if (!prevR || JSON.stringify(prevR.listings) !== JSON.stringify(rentals)) {
      await writeFile(new URL('rentals.json', DATA), JSON.stringify({ updated: now, source: 'https://housing.sfgov.org/listings/for-rent', count: rentals.length, listings: rentals }, null, 1));
    }
    const rh = await readJson('rental-history.json', { listings: {} });
    const rbefore = JSON.stringify(rh.listings);
    for (const l of rentals) {
      const h = rh.listings[l.id];
      const { notes, amenities, credit, eviction, utilities, requiredDocs, prefs, units, ...slim } = l;
      slim.units = units.map(({ maxIncome, ...g }) => g);
      rh.listings[l.id] = { ...slim, firstSeen: h ? h.firstSeen : today, lastSeen: today };
    }
    if (JSON.stringify(rh.listings) !== rbefore) {
      rh.updated = now;
      await writeFile(new URL('rental-history.json', DATA), JSON.stringify(rh, null, 1));
    }
  } catch (e) {
    console.warn('Rental refresh failed, keeping previous rental data:', e.message);
  }

  // A once-a-day "last checked" stamp so the site can show the job is alive.
  const checked = await readJson('checked.json', {});
  if (checked.date !== today) await writeFile(new URL('checked.json', DATA), JSON.stringify({ date: today }));

  console.log(`${same ? 'No change' : 'Updated'}: ${listings.length} DAHLIA ownership listings, ${rentalCount ?? 'no'} rentals, ${citySecond.items.length} City Second.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
