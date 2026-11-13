#!/usr/bin/env node
// One-off helper: builds data/listings.json + data/history.json from a raw
// snapshot captured in a browser (used before the scheduled job first runs).
// Usage: node scripts/seed-from-snapshot.mjs snapshot.json [citysecond.txt]
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeListing } from './normalize.mjs';
import { parseCitySecond, CITY_SECOND_URL } from './citysecond.mjs';

const [snapPath, csPath] = process.argv.slice(2);
const raw = JSON.parse(await readFile(snapPath, 'utf8'));
const now = new Date().toISOString();
const listings = raw.map((r) => normalizeListing(r.b, r.d, r.u, r.p));
let citySecond = { ok: false, url: CITY_SECOND_URL, incomeLimitAmi: 148, items: [] };
if (csPath) {
  const cs = JSON.parse(await readFile(csPath, 'utf8'));
  citySecond = parseCitySecond(cs.text, cs.links || {});
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date()); // YYYY-MM-DD, Pacific
const history = { updated: now, listings: {} };
for (const l of listings) {
  const { notes, amenities, appliances, petPolicy, agent, openHouses, ...slim } = l;
  history.listings[l.id] = { ...slim, firstSeen: today, lastSeen: today };
}
await writeFile(new URL('../data/checked.json', import.meta.url), JSON.stringify({ date: today }));
const DATA = new URL('../data/', import.meta.url);
await writeFile(new URL('listings.json', DATA), JSON.stringify({ updated: now, source: 'https://housing.sfgov.org/listings/for-sale', count: listings.length, listings, citySecond }, null, 1));
await writeFile(new URL('history.json', DATA), JSON.stringify(history, null, 1));
console.log(`Seeded ${listings.length} listings, ${citySecond.items.length} City Second.`);
