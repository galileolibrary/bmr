import { GOATCOUNTER_CODE, DEFAULT_RATE, RATE_SOURCE, PROPERTY_TAX_RATE, INSURANCE_MONTHLY } from './config.js';
import { LINKS, ROLES, matchPrograms, matchRentalPrograms } from './programs.js';

/* ------------------------------------------------------------------
   Everything typed into this page lives only in the `state` object
   below, in this browser tab's memory. It is never saved to storage,
   never put in the URL, and never sent anywhere.
------------------------------------------------------------------- */
const state = {
  hh: { size: '', income: '', assets: '', downPayment: '', owned: 'no' },
  prog: { tenure: '', sfusd: '', role: '', owned: '', firstGen: '' },
  filters: { q: '', show: 'open', method: 'any', beds: 'any', maxPrice: '', hood: 'any', sort: 'deadline', fitOnly: false },
  cost: { price: '', hoa: '', down: '', rate: String(DEFAULT_RATE) },
  rent: { voucher: false },
  rentFilters: { show: 'open', method: 'any', beds: 'any', maxRent: '', hood: 'any', eduOnly: false, fitOnly: false },
  dalp: { price: '', cash: '', hoa: '', debts: '', rate: String(DEFAULT_RATE), years: '7', growth: '3' },
  counted: {},
};

let AMI = null;
let DATA = null;
let HISTORY = null;
let CHECKED = null;
let BALANCES = null;
let RENTALS = null;
const view = document.getElementById('view');

/* ---------------- small helpers ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = (n) => (n === null || n === undefined || isNaN(n) ? '—' : usd.format(Math.round(n)));
const kmoney = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);
// Down payment can be typed as dollars ("20,000") or a percent of the price ("10%").
const isPercent = (s) => /%/.test(String(s ?? ''));
function resolveDown(raw, price) {
  const str = String(raw ?? '').trim();
  if (!str) return null;
  if (isPercent(str)) {
    const pct = Number(str.replace(/[^\d.]/g, ''));
    if (isNaN(pct) || !price) return null;
    return (price * Math.min(Math.max(pct, 0), 100)) / 100;
  }
  return parseMoney(str);
}
const parseMoney = (s) => { const n = Number(String(s ?? '').replace(/[^\d.]/g, '')); return String(s ?? '').trim() === '' || isNaN(n) ? null : n; };
const TZ = 'America/Los_Angeles';
const toDate = (s) => {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00-08:00`);
  return new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
};
const fmtDate = (s, time = false) => {
  const d = toDate(s); if (!d || isNaN(d)) return '';
  const opts = { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' };
  if (time) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return new Intl.DateTimeFormat('en-US', opts).format(d);
};
const daysFromNow = (s) => { const d = toDate(s); return d ? (d - Date.now()) / 86400000 : null; };
const median = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const bedsOf = (type) => { if (!type) return null; if (/studio/i.test(type)) return 0; const m = String(type).match(/(\d)/); return m ? Number(m[1]) : null; };
const typeLabel = (t) => (t ? String(t).replace(/\bBR\b/, 'bedroom') : 'Unit');

function count(event) {
  if (!GOATCOUNTER_CODE || state.counted[event]) return;
  state.counted[event] = true;
  if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: event, title: event, event: true });
}
function countPage(path) {
  if (GOATCOUNTER_CODE && window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: path || '/' });
}

/* ---------------- income math ---------------- */
function sizeIndex(size) { return Math.min(Math.max(Number(size) || 1, 1), 11) - 1; }
function limitFor(pct, size) {
  const i = sizeIndex(size);
  const row = AMI.limits[String(pct)];
  if (row) return { value: row[i], approx: false };
  const base = AMI.limits['100'][i];
  return { value: Math.round((base * pct) / 100 / 50) * 50, approx: true };
}
function amiPctOf(income, size) { return (income / AMI.limits['100'][sizeIndex(size)]) * 100; }

// MOHCD asset rule: liquid assets above $80,000 (or above the full down
// payment, if that's 20%+ of the price) add 10% of the excess to income.
function assetAdd(assets, down, price) {
  if (!assets) return 0;
  const excl = down && price && down >= 0.2 * price ? Math.max(down, 80000) : 80000;
  return Math.max(0, assets - excl) * 0.1;
}

function hh() {
  const size = Number(state.hh.size) || null;
  const income = parseMoney(state.hh.income);
  return { size, income, assets: parseMoney(state.hh.assets), downRaw: state.hh.downPayment, down: (price) => resolveDown(state.hh.downPayment, price), owned: state.hh.owned, ready: !!(size && income) };
}

function isAvailable(u) { return !u.status || u.status === 'Available'; }
function isOpen(l) {
  if (l.method === 'fcfs') return l.units.some(isAvailable);
  const d = toDate(l.dueDate);
  return !!d && d > new Date();
}

function unitFit(l, u, h) {
  if (!h.ready) return null;
  const reasons = []; let ok = true;
  const minOcc = u.minOccupancy ?? Math.max(1, bedsOf(u.type) ?? 1);
  if (h.size < minOcc) { ok = false; reasons.push(`Needs at least ${minOcc} ${minOcc === 1 ? 'person' : 'people'} in the household.`); }
  if (u.maxOccupancy && h.size > u.maxOccupancy) { ok = false; reasons.push(`Allows at most ${u.maxOccupancy} people.`); }
  if (u.maxAmi) {
    const lim = limitFor(u.maxAmi, h.size);
    const add = l.waivers && l.waivers.assetsExcluded ? 0 : assetAdd(h.assets, h.down(u.price), u.price);
    const counted = h.income + add;
    if (counted > lim.value) { ok = false; reasons.push(`Counted income ${money(counted)} is over the ${lim.approx ? 'approx. ' : ''}${money(lim.value)} limit for ${h.size} at ${u.maxAmi}% AMI.`); }
    else reasons.push(`Under the ${lim.approx ? 'approx. ' : ''}${money(lim.value)} limit for ${h.size} at ${u.maxAmi}% AMI.`);
    if (add > 0) reasons.push(`Includes ${money(add)} added for savings above the asset allowance.`);
  }
  if (h.owned === 'yes') { ok = false; reasons.push('BMR buyers can’t have owned a home in the last 3 years.'); }
  if (h.owned === 'unsure') reasons.push('Check the first-time buyer rule: no home ownership in the last 3 years.');
  return { verdict: ok ? 'likely' : 'unlikely', reasons };
}
function listingFit(l, h) {
  const units = l.units.filter(isAvailable);
  const fits = (units.length ? units : l.units).map((u) => ({ u, f: unitFit(l, u, h) })).filter((x) => x.f);
  if (!fits.length) return null;
  return fits.find((x) => x.f.verdict === 'likely') || fits[0];
}

function monthlyCost(price, hoa, down, rate) {
  const loan = Math.max(0, price - (down || 0));
  const r = rate / 100 / 12, n = 360;
  const pi = r ? (loan * r) / (1 - Math.pow(1 + r, -n)) : loan / n;
  const tax = (price * PROPERTY_TAX_RATE) / 100 / 12;
  return { pi, tax, ins: INSURANCE_MONTHLY, hoa: hoa || 0, total: pi + tax + INSURANCE_MONTHLY + (hoa || 0) };
}


/* ---------------- official links ---------------- */
const ICONS = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.2-8.2M16 7l2 2M14 9l2 2"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M15.5 14.2A5 5 0 0 1 21 19"/>',
  bank: '<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
};
const EXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>';
const OFFICIAL = {
  dahliaSale: { t: 'BMR homes for sale', d: 'Browse and apply on DAHLIA, the City’s housing portal', url: 'https://housing.sfgov.org/listings/for-sale', ico: 'home' },
  dahliaRent: { t: 'BMR rentals', d: 'Affordable apartments and waitlists on DAHLIA', url: 'https://housing.sfgov.org/listings/for-rent', ico: 'key' },
  rentals: { t: 'Affordable rentals', d: 'Rentals, waitlists and housing for SFUSD staff', url: '#/rentals', ico: 'key', internal: true },
  alerts: { t: 'Get new-listing emails', d: 'MOHCD emails you when homes or rentals post', url: 'https://confirmsubscription.com/h/y/C3BAFCD742D47910', ico: 'bell' },
  education: { t: 'Sign up for homebuyer classes', d: 'The required 10 hours: orientation, workshop, counseling', url: 'https://www.homeownershipsf.org/homebuyer-education/', ico: 'book' },
  agencies: { t: 'Housing counseling agencies', d: 'Free one-on-one help; addresses and phone numbers', url: '#/verify', ico: 'people', internal: true },
  lenders: { t: 'MOHCD-approved lenders', d: 'Required for your pre-approval letter', url: 'https://www.sf.gov/reports--december-2024--find-lender-downpayment-and-mortgage-assistance-programs/', ico: 'bank' },
  dalp: { t: 'Down payment loan programs', d: 'DALP, Teacher Next Door and current fund levels', url: '#/dalp', ico: 'coins', internal: true },
  mohcd: { t: 'Ask MOHCD', d: 'sfhousinginfo@sfgov.org, (415) 701-5622', url: 'mailto:sfhousinginfo@sfgov.org', ico: 'phone' },
  limits: { t: '2026 income limits', d: 'MOHCD’s official chart (PDF)', url: 'https://media.api.sf.gov/documents/2026_AMI-IncomeLimits-HMFA.pdf', ico: 'doc' },
};
function hostOf(url) {
  if (url.startsWith('#')) return 'On this site';
  if (url.startsWith('mailto:')) return 'Email';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function linkCard(key, opts = {}) {
  const l = OFFICIAL[key];
  return `<li><a class="linkcard${opts.key ? ' key' : ''}" href="${esc(l.url)}">
    <span class="ico"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[l.ico]}</svg></span>
    <span><span class="t">${esc(l.t)}</span><span class="d">${esc(l.d)}</span></span>
    <span class="host">${esc(hostOf(l.url))}${l.internal || l.url.startsWith('mailto:') ? '' : EXT}</span>
  </a></li>`;
}
function nextSteps(title, keys) {
  return `<div class="nextsteps"><h3>${esc(title)}</h3><ul class="linkcards">${keys.map((k, i) => linkCard(k, { key: i === 0 })).join('')}</ul></div>`;
}

/* ---------------- shared bits ---------------- */
function verdictChip(v) {
  if (!v) return '';
  const text = { likely: 'Likely eligible', maybe: 'Maybe eligible', unlikely: 'Likely not eligible' }[v];
  return `<span class="verdict ${v}">${text}</span>`;
}
const DISCLAIMER = `<p class="small muted">An estimate based on MOHCD’s published 2026 rules, not a decision. A housing counselor, a MOHCD-approved lender and MOHCD’s document review decide eligibility. <a href="#/verify">How to get it confirmed</a></p>`;

function sizeOptions(selected) {
  let o = '<option value="">Choose…</option>';
  for (let i = 1; i <= 11; i++) o += `<option value="${i}"${String(selected) === String(i) ? ' selected' : ''}>${i} ${i === 1 ? 'person' : 'people'}</option>`;
  return o;
}

window.__houseIcon = undefined;
const houseIcon = `<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M6 34 A14 14 0 0 1 34 34 Z" fill="none" stroke="#5A3E9E" stroke-width="2"/><path d="M18 34 V22 M22 34 V22" stroke="#5A3E9E" stroke-width="2"/></svg>`;

window.__houseIcon = houseIcon;
function openListings() { return DATA.listings.filter(isOpen); }

/* ---------------- star chart ---------------- */
function starPath(cx, cy, r) {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    d += `${i ? 'L' : 'M'}${(cx + rad * Math.cos(a)).toFixed(1)} ${(cy + rad * Math.sin(a)).toFixed(1)}`;
  }
  return d + 'Z';
}
function starChart(pct, caps) {
  const W = 960, H = 230, L = 30, R = 30, base = 180;
  const maxP = Math.min(260, Math.max(200, Math.ceil((pct + 15) / 10) * 10));
  const x = (p) => L + (p / maxP) * (W - L - R);
  const groups = {};
  caps.forEach((c) => { groups[c] = (groups[c] || 0) + 1; });
  let stars = '';
  Object.entries(groups).forEach(([cap, n]) => {
    const c = Number(cap); const reach = c >= pct;
    const shown = Math.min(n, 6);
    for (let k = 0; k < shown; k++) stars += `<path class="cap${reach ? ' reach' : ''}" d="${starPath(x(c), base - 16 - k * 17, 7)}"/>`;
    stars += `<text class="lbl" x="${x(c)}" y="${base - 16 - shown * 17 - 4}" text-anchor="middle">${n > 6 ? `${n} units` : ''}</text>`;
  });
  let ticks = '';
  for (let p = 0; p <= maxP; p += 50) ticks += `<g class="tick"><line class="axis" x1="${x(p)}" x2="${x(p)}" y1="${base}" y2="${base + 6}"/><text x="${x(p)}" y="${base + 22}" text-anchor="middle">${p}%</text></g>`;
  const yx = x(Math.min(pct, maxP));
  const labelAnchor = yx > W - 140 ? 'end' : yx < 140 ? 'start' : 'middle';
  return `<svg class="starchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Your household is at ${Math.round(pct)}% of area median income. ${caps.filter((c) => c >= pct).length} of ${caps.length} open units have an income cap at or above that.">
    <rect class="zone" x="${yx}" y="34" width="${Math.max(0, x(maxP) - yx)}" height="${base - 34}"/>
    <line class="axis" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>
    ${ticks}${stars}
    <line x1="${yx}" x2="${yx}" y1="34" y2="${base}" stroke="#E8831F" stroke-width="1.5" stroke-dasharray="3 4"/>
    <path class="you" d="${starPath(yx, base, 15)}"/>
    <text class="you-lbl" x="${yx}" y="22" text-anchor="${labelAnchor}">You: ${Math.round(pct)}% AMI</text>
    <text class="lbl" x="${W - R}" y="${H - 6}" text-anchor="end">Percent of area median income (AMI)</text>
  </svg>`;
}

/* ================================================================
   VIEWS
================================================================ */
function viewHome() {
  const open = openListings();
  const prices = open.flatMap((l) => l.units.filter(isAvailable).map((u) => u.price)).filter(Boolean);
  const lotteries = open.filter((l) => l.method === 'lottery').length;
  const ex1 = limitFor(100, 1).value;
  const teacherPct = Math.round(amiPctOf(95000, 1));
  return `
  <div class="wrap">
    <section class="view-head">
      <h1 class="hero-q">Can you secure a housing future in San Francisco on an educator’s salary?</h1>
      <p class="lede hero-lede">Through the City’s Below Market Rate (BMR) program, some condos sell for a fraction of market price and some apartments rent well below market, for households under set income limits. A lot of SFUSD households land right in that range, and two rental buildings put SFUSD staff first in line.</p>
      <p style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem">
        <a class="button" href="#/check">Check my eligibility</a>
        <a class="button quiet" href="#/homes">Browse homes for sale</a>
        <a class="button quiet" href="#/rentals">Browse rentals</a>
      </p>
    </section>

    <section class="facts" aria-label="Right now">
      <div><p class="figure num">${open.length}</p><p>BMR homes taking applications right now${lotteries ? `, ${lotteries} of them by lottery` : ''}.</p></div>
      <div><p class="figure num">${prices.length ? `${kmoney(Math.min(...prices))}–${kmoney(Math.max(...prices))}` : '—'}</p><p>Price range of those homes, before parking.</p></div>
      <div><p class="figure num">${teacherPct}%</p><p>Where a single teacher earning $95,000 sits on the 2026 income scale. Most listings allow 100–120%.</p></div>
    </section>

    <section class="section" aria-labelledby="where-to-go">
      <h2 id="where-to-go">Where to go</h2>
      <p class="muted prose">The official sites you’ll use. This guide helps you understand them; these are where you actually apply.</p>
      <div class="linkgroups">
        <div class="linkgroup"><h3>Find a home</h3><ul class="linkcards">${linkCard('dahliaSale', { key: true })}${linkCard('rentals')}${linkCard('alerts')}</ul></div>
        <div class="linkgroup"><h3>Get ready to apply</h3><ul class="linkcards">${linkCard('education', { key: true })}${linkCard('agencies')}${linkCard('lenders')}</ul></div>
      </div>
    </section>

    <section class="section split">
      <div class="prose">
        <h2>How BMR homes work</h2>
        <p>When developers build in San Francisco, some units are set aside and sold at prices the City calculates to be affordable. Each home has an income cap, written as a percent of the area median income (AMI). In 2026, 100% AMI is ${money(ex1)} for one person and ${money(limitFor(100, 4).value)} for four.</p>
        <p>Homes are offered two ways. <strong>Lottery listings</strong> take applications until a deadline, then rank applicants at random, with preferences such as living or working in San Francisco. <strong>First come, first served</strong> listings review complete applications in the order they arrive.</p>
        <p>Most are condos with monthly HOA dues, and you must live in the home yourself. You can’t rent it out.</p>
      </div>
      <div>
        <div class="callout"><p><strong>The trade-off.</strong> When you sell, the price is restricted too, so the next buyer can afford it. You build some equity, but much less than with a market-rate home.</p></div>
        <div class="callout warn" style="margin-top:1rem"><p><strong>Easier rules on many resales right now.</strong> Until June 30, 2027, MOHCD is letting many resale listings accept incomes 20 points higher than usual and ignore savings when counting income. Listings show this, and the caps here already include it. <a href="${LINKS.waivers}">Read the announcement</a></p></div>
      </div>
    </section>

    <section class="section">
      <h2>The path to buying</h2>
      <ol class="path">
        <li><h3>Check where you stand</h3><p>Compare your household income to the 2026 limits. <a href="#/check">Use the calculator</a>.</p></li>
        <li><h3>Take homebuyer education</h3><p>Every adult in the household completes 10 hours: a free 2-hour orientation, a 6-hour workshop, and a 2-hour one-on-one with a housing counselor. Sign up through <a href="${LINKS.education}">HomeownershipSF</a>.</p></li>
        <li><h3>Get pre-approved</h3><p>Get a mortgage pre-approval letter from a <a href="${LINKS.lenders}">MOHCD-approved lender</a>. It has to be dated within 120 days when you apply.</p></li>
        <li><h3>Apply to listings</h3><p>Apply on <a href="${LINKS.dahlia}">DAHLIA</a>, one application per home. You can apply to as many as fit.</p></li>
        <li><h3>Send your full application</h3><p>If you’re picked or reach the front of the line, you submit documents and MOHCD reviews your eligibility.</p></li>
        <li><h3>Close</h3><p>Your lender, your counselor and MOHCD give final approval, and you get the keys.</p></li>
      </ol>
      <p>SFUSD staff can also get down payment help, like Teacher Next Door’s $20,000 forgivable loan for BMR homes. <a href="#/programs">See which programs fit you</a>, or read about the City’s <a href="#/dalp">down payment loans for market-rate homes</a>.</p>
    </section>
  </div>`;
}

/* ---------- Check eligibility ---------- */
function viewCheck() {
  const s = state.hh;
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Check your eligibility</h1>
      <p class="lede">Enter your household and see where you fall on the 2026 income scale, and which homes for sale are within reach.</p>
    </section>
    <div class="split">
      <form class="form" id="hh-form" autocomplete="off" onsubmit="return false">
        <div class="field">
          <label for="hh-size">How many people will live in the home?</label>
          <span class="hint">Count everyone, including children. Unborn children don’t count yet.</span>
          <select id="hh-size" data-hh="size">${sizeOptions(s.size)}</select>
        </div>
        <div class="field">
          <label for="hh-income">Total yearly household income, before taxes</label>
          <span class="hint">Add up everyone 18 or older who will live there. MOHCD uses the higher of your current income projected over 12 months or last year’s tax return.</span>
          <div class="money"><input id="hh-income" data-hh="income" inputmode="decimal" type="text" value="${esc(s.income)}" placeholder="95,000"></div>
        </div>
        <div class="field">
          <label for="hh-owned">Has anyone in the household owned a home in the last 3 years?</label>
          <select id="hh-owned" data-hh="owned">
            <option value="no"${s.owned === 'no' ? ' selected' : ''}>No</option>
            <option value="yes"${s.owned === 'yes' ? ' selected' : ''}>Yes</option>
            <option value="unsure"${s.owned === 'unsure' ? ' selected' : ''}>Not sure</option>
          </select>
        </div>
        <div class="field">
          <label for="hh-assets">Savings and investments (optional)</label>
          <span class="hint">Cash, savings and brokerage accounts. MOHCD adds 10% of anything above $80,000 to your counted income.</span>
          <div class="money"><input id="hh-assets" data-hh="assets" inputmode="decimal" type="text" value="${esc(s.assets)}" placeholder="0"></div>
        </div>
        <div class="field">
          <label for="hh-down">Planned down payment (optional)</label>
          <span class="hint">A dollar amount or a percent of the price, like 20,000 or 10%. Used for monthly costs. The BMR minimum is 1% of the price, and it can be a gift.</span>
          <input id="hh-down" data-hh="downPayment" type="text" value="${esc(s.downPayment)}" placeholder="20,000 or 10%">
        </div>
        <p class="small muted">Nothing you type here is saved or sent anywhere.</p>
      </form>
      <div id="check-result" aria-live="polite">${checkResult()}</div>
    </div>
    <div id="check-chart">${checkChart()}</div>
    <section class="section" id="ami-table">${amiTable()}</section>
    <section class="section" id="cost">${costEstimator()}</section>
  </div>`;
}

function checkResult() {
  const h = hh();
  if (!h.ready) return `<div class="panel"><h2 style="font-size:var(--step-2)">Your result</h2><p class="muted">Choose a household size and enter your income to see where you stand.</p></div>`;
  count('used-calculator');
  const pct = amiPctOf(h.income, h.size);
  const open = openListings();
  const capUnits = open.flatMap((l) => l.units.filter(isAvailable).map((u) => ({ l, u }))).filter((x) => x.u.maxAmi);
  const fits = open.map((l) => listingFit(l, h)).filter((x) => x && x.f.verdict === 'likely').length;
  const assetsMax = assetAdd(h.assets, null, null);
  const verdict = h.owned === 'yes' ? 'unlikely' : fits > 0 ? 'likely' : 'unlikely';
  let msg;
  if (h.owned === 'yes') msg = 'BMR homes are only for buyers who haven’t owned a home in the last 3 years, so you likely don’t qualify right now.';
  else if (fits > 0) msg = `You’re likely eligible for <strong>${fits}</strong> of the ${open.length} homes open now, based on income and household size.`;
  else msg = `None of the ${open.length} homes open now fit your income and household size. New listings post often, and caps vary.`;
  return `<div class="panel">
    <p class="small muted" style="margin:0 0 .4rem">Your household is at about</p>
    <p class="result-figure num">${Math.round(pct)}%<small>of AMI</small></p>
    <p style="margin-bottom:.6rem">${verdictChip(verdict)}</p>
    <p>${msg}</p>
    ${assetsMax > 0 ? `<p class="small" style="margin-top:1rem">Your savings add up to ${money(assetsMax)} to counted income on listings without the asset waiver. ${open.filter((l) => l.waivers && l.waivers.assetsExcluded).length} open listings waive it.</p>` : ''}
    ${h.owned === 'unsure' ? `<p class="small notice" style="margin-top:1rem">Not sure about past ownership? A housing counselor can tell you. Any ownership interest in a home in the last 3 years counts.</p>` : ''}
    <p style="margin-top:1rem"><a class="button" href="#/homes?fit=1">See homes that fit</a></p>
    ${nextSteps('Your next steps', ['education', 'lenders', 'dahliaSale'])}
    ${DISCLAIMER}
  </div>`;
}

function checkChart() {
  const h = hh();
  if (!h.ready) return '';
  const pct = amiPctOf(h.income, h.size);
  const caps = openListings().flatMap((l) => l.units.filter(isAvailable).map((u) => u.maxAmi)).filter(Boolean);
  const reach = caps.filter((c) => c >= pct).length;
  return `<section class="chart-band">
    <h2>Where you sit among the homes open now</h2>
    <p>Each small star is an open unit, placed at its income cap. Stars to the right of you have caps above your income: ${reach} of ${caps.length}. Household size and savings can still rule some out.</p>
    ${starChart(pct, caps)}
    <ul class="legend">
      <li><span class="dot" style="background:#E8831F"></span>Your household</li>
      <li><span class="dot" style="background:#F1EEFB"></span>Cap at or above you</li>
      <li><span class="dot" style="background:#9C8FDB"></span>Cap below you</li>
    </ul>
  </section>`;
}

function amiTable() {
  const h = hh();
  const size = h.size || 1;
  const levels = [80, 90, 100, 105, 110, 120, 130, 140, 150, 200];
  const rows = levels.map((p) => {
    const lim = limitFor(p, size).value;
    const status = h.ready ? (h.income <= lim ? '<span class="verdict likely">Under</span>' : '<span class="verdict unlikely">Over</span>') : '';
    return `<tr><td>${p}% AMI</td><td class="r num">${money(lim)}</td>${h.ready ? `<td>${status}</td>` : ''}</tr>`;
  }).join('');
  return `<div class="prose">
    <h2>2026 income limits for ${size} ${size === 1 ? 'person' : 'people'}</h2>
    <p class="muted">Effective June 1, 2026. Each listing names one of these levels as its cap. Most BMR homes for sale use 80% to 120%. <a href="${LINKS.amiPdf}">Full MOHCD chart (PDF)</a></p>
    <table><thead><tr><th>Level</th><th class="r">Maximum income</th>${h.ready ? '<th>You</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

function costInputs() {
  const h = hh();
  const avail = openListings().flatMap((l) => l.units.filter(isAvailable));
  const defPrice = Math.round((median(avail.map((u) => u.price)) || 400000) / 1000) * 1000;
  const defHoa = Math.round(median(avail.map((u) => u.hoa)) || 600);
  const c = state.cost;
  const price = parseMoney(c.price) ?? defPrice;
  const hoa = parseMoney(c.hoa) ?? defHoa;
  const down = resolveDown(c.down, price) ?? h.down(price) ?? Math.round(price * 0.05);
  const rate = Number(String(c.rate).replace(/[^\d.]/g, '')) || DEFAULT_RATE;
  return { h, c, defPrice, defHoa, price, hoa, down, rate };
}

// The form is rendered once; only the result panel updates while typing,
// so keystrokes are never lost to a re-render.
function costEstimator() {
  const { c, defPrice, defHoa } = costInputs();
  return `<h2>What would it cost each month?</h2>
  <p class="muted prose">A rough estimate for a 30-year fixed loan, which is what BMR purchases require. Defaults use the middle price and HOA of the homes open now.</p>
  <div class="split">
    <form class="form" id="cost-form" autocomplete="off" onsubmit="return false">
      <div class="field"><label for="c-price">Home price</label><div class="money"><input id="c-price" data-cost="price" inputmode="decimal" type="text" value="${esc(c.price)}" placeholder="${defPrice.toLocaleString()}"></div></div>
      <div class="field"><label for="c-hoa">Monthly HOA dues</label><div class="money"><input id="c-hoa" data-cost="hoa" inputmode="decimal" type="text" value="${esc(c.hoa)}" placeholder="${defHoa}"></div></div>
      <div class="field"><label for="c-down">Down payment</label><span class="hint">Dollars or a percent of the price, like 20,000 or 10%. Leave blank to use your planned down payment above, or 5%.</span><input id="c-down" data-cost="down" type="text" value="${esc(c.down)}" placeholder="20,000 or 10%"></div>
      <div class="field"><label for="c-rate">Interest rate (%)</label><span class="hint">Default is the ${esc(RATE_SOURCE)}. Your lender’s rate will differ.</span><input id="c-rate" data-cost="rate" inputmode="decimal" type="text" value="${esc(c.rate)}" style="max-width:8rem"></div>
    </form>
    <div class="panel" id="cost-result" aria-live="polite">${costResult()}</div>
  </div>`;
}

function costResult() {
  const { h, c, price, hoa, down, rate } = costInputs();
  const m = monthlyCost(price, hoa, down, rate);
  let ratioLine = '<p class="muted">Enter your income above to compare this to what lenders and MOHCD allow.</p>';
  let maxLine = '';
  if (h.income) {
    const mi = h.income / 12;
    const ratio = (m.total / mi) * 100;
    let judge;
    if (ratio > 45) judge = 'That’s above MOHCD’s 43% limit (45% in some cases), so a lender likely wouldn’t approve this price for you.';
    else if (ratio > 43) judge = 'That’s just above MOHCD’s usual 43% limit. It can go to 45% with strong savings, credit or rent history.';
    else if (ratio < 28) judge = 'That’s under 28%. MOHCD expects housing costs of at least 28% of income, so a counselor may adjust your down payment or loan.';
    else judge = 'That’s inside MOHCD’s range of 28% to 43% of income.';
    ratioLine = `<p>That’s <strong class="num">${Math.round(ratio)}%</strong> of your gross monthly income. ${judge}</p>`;
    const dFrac = price ? down / price : 0.05;
    const r = rate / 100 / 12; const f = r / (1 - Math.pow(1 + r, -360));
    const maxP = (0.43 * mi - INSURANCE_MONTHLY - hoa) / (f * (1 - dFrac) + PROPERTY_TAX_RATE / 100 / 12);
    if (maxP > 0) maxLine = `<p>At this rate, with ${money(hoa)} HOA dues and the same down payment share, the most you could likely spend is about <strong class="num">${money(Math.floor(maxP / 1000) * 1000)}</strong>.</p>`;
  }
  const pctTxt = price ? ((down / price) * 100).toFixed(1).replace(/\.0$/, '') : '0';
  return `<p class="small muted" style="margin:0 0 .3rem">Estimated monthly cost</p>
      <p class="result-figure num">${money(m.total)}</p>
      <table class="small"><tbody>
        <tr><td>Mortgage (principal and interest)</td><td class="r num">${money(m.pi)}</td></tr>
        <tr><td>Property tax (about ${PROPERTY_TAX_RATE}%)</td><td class="r num">${money(m.tax)}</td></tr>
        <tr><td>Homeowner’s insurance (estimate)</td><td class="r num">${money(m.ins)}</td></tr>
        <tr><td>HOA dues</td><td class="r num">${money(m.hoa)}</td></tr>
      </tbody></table>
      <p class="small muted" style="margin:.6rem 0 0">Down payment: ${money(down)} (${pctTxt}% of the price)${!c.down && !h.downRaw ? ', the 5% default' : ''}. Loan amount: ${money(Math.max(0, price - down))}.</p>
      <div style="margin-top:1rem">${ratioLine}${maxLine}</div>`;
}

/* ---------- Homes ---------- */
function viewHomes(params) {
  if (params.get('fit') === '1') state.filters.fitOnly = true;
  const f = state.filters;
  const s = state.hh;
  const hoods = [...new Set(DATA.listings.map((l) => l.neighborhood).filter(Boolean))].sort();
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Homes for sale</h1>
      <p class="lede">Every BMR home listed on DAHLIA, the City’s housing portal. Add your household to see which ones you likely qualify for.</p>
    </section>
    <form class="household-bar" id="hh-bar" autocomplete="off" onsubmit="return false" aria-label="Your household">
      <div class="field"><label for="b-size">People in household</label><select id="b-size" data-hh="size">${sizeOptions(s.size)}</select></div>
      <div class="field"><label for="b-income">Yearly household income</label><div class="money"><input id="b-income" data-hh="income" inputmode="decimal" type="text" value="${esc(s.income)}" placeholder="95,000"></div></div>
      <div class="field"><label for="b-assets">Savings (optional)</label><div class="money"><input id="b-assets" data-hh="assets" inputmode="decimal" type="text" value="${esc(s.assets)}" placeholder="0"></div></div>
      <div class="field"><label class="choices" style="margin:0"><span style="display:inline-flex;gap:.45rem;align-items:center;font-weight:700"><input type="checkbox" id="b-fit" data-filter="fitOnly"${f.fitOnly ? ' checked' : ''}> Only homes I likely qualify for</span></label></div>
    </form>
    <form class="toolbar" id="filters" autocomplete="off" onsubmit="return false" aria-label="Filter homes">
      <div class="field"><label for="f-q">Search</label><input id="f-q" type="search" data-filter="q" value="${esc(f.q)}" placeholder="Street or building"></div>
      <div class="field"><label for="f-show">Show</label><select id="f-show" data-filter="show">
        <option value="open"${f.show === 'open' ? ' selected' : ''}>Open for applications</option>
        <option value="all"${f.show === 'all' ? ' selected' : ''}>Everything on DAHLIA</option></select></div>
      <div class="field"><label for="f-method">How to apply</label><select id="f-method" data-filter="method">
        <option value="any">Any</option>
        <option value="lottery"${f.method === 'lottery' ? ' selected' : ''}>Lottery (deadline)</option>
        <option value="fcfs"${f.method === 'fcfs' ? ' selected' : ''}>First come, first served</option></select></div>
      <div class="field"><label for="f-beds">Bedrooms</label><select id="f-beds" data-filter="beds">
        ${['any', '0', '1', '2', '3'].map((b) => `<option value="${b}"${f.beds === b ? ' selected' : ''}>${b === 'any' ? 'Any' : b === '0' ? 'Studio' : b === '3' ? '3+' : b}</option>`).join('')}</select></div>
      <div class="field"><label for="f-max">Max price</label><div class="money"><input id="f-max" data-filter="maxPrice" inputmode="decimal" type="text" value="${esc(f.maxPrice)}" placeholder="Any"></div></div>
      <div class="field"><label for="f-hood">Neighborhood</label><select id="f-hood" data-filter="hood"><option value="any">Any</option>${hoods.map((h) => `<option${f.hood === h ? ' selected' : ''}>${esc(h)}</option>`).join('')}</select></div>
      <div class="field"><label for="f-sort">Sort by</label><select id="f-sort" data-filter="sort">
        <option value="deadline"${f.sort === 'deadline' ? ' selected' : ''}>Deadline first</option>
        <option value="price"${f.sort === 'price' ? ' selected' : ''}>Lowest price</option>
        <option value="cap"${f.sort === 'cap' ? ' selected' : ''}>Highest income cap</option>
        <option value="newest"${f.sort === 'newest' ? ' selected' : ''}>Recently updated</option></select></div>
    </form>
    <div id="homes-list" aria-live="polite">${homesList()}</div>
    <section class="section" id="city-second">${citySecondBlock()}</section>
  </div>`;
}

function filteredListings() {
  const f = state.filters; const h = hh();
  const maxPrice = parseMoney(f.maxPrice);
  const q = f.q.trim().toLowerCase();
  let list = DATA.listings.map((l) => ({ l, open: isOpen(l), fit: listingFit(l, h) }));
  list = list.filter(({ l, open, fit }) => {
    if (f.show === 'open' && !open) return false;
    if (f.method !== 'any' && l.method !== f.method) return false;
    if (f.hood !== 'any' && l.neighborhood !== f.hood) return false;
    if (q && !`${l.name} ${l.building} ${l.address} ${l.neighborhood}`.toLowerCase().includes(q)) return false;
    const units = l.units.filter(isAvailable).length ? l.units.filter(isAvailable) : l.units;
    if (f.beds !== 'any') { const b = Number(f.beds); if (!units.some((u) => (b === 3 ? bedsOf(u.type) >= 3 : bedsOf(u.type) === b))) return false; }
    if (maxPrice && !units.some((u) => u.price && u.price <= maxPrice)) return false;
    if (f.fitOnly && h.ready && !(fit && fit.f.verdict === 'likely')) return false;
    return true;
  });
  const minPrice = (l) => Math.min(...l.units.map((u) => u.price || Infinity));
  const maxCap = (l) => Math.max(...l.units.map((u) => u.maxAmi || 0));
  list.sort((a, b) => {
    if (f.sort === 'price') return minPrice(a.l) - minPrice(b.l);
    if (f.sort === 'cap') return maxCap(b.l) - maxCap(a.l);
    if (f.sort === 'newest') return String(b.l.lastModified).localeCompare(String(a.l.lastModified));
    // deadline: open lotteries by date, then first-come listings, then closed
    const rank = (x) => (x.open && x.l.method === 'lottery' ? 0 : x.open ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 0) return toDate(a.l.dueDate) - toDate(b.l.dueDate);
    return minPrice(a.l) - minPrice(b.l);
  });
  return list;
}

function homesList() {
  const h = hh();
  const list = filteredListings();
  const fitNote = state.filters.fitOnly && !h.ready ? ' Add your household size and income above to filter by eligibility.' : '';
  if (!list.length) return `<p class="count-line">No homes match these filters.${fitNote}</p><div class="empty-state"><p>Try “Everything on DAHLIA”, a higher max price, or a different bedroom count. New listings post every few weeks. <a href="${LINKS.alerts}">Get MOHCD’s email alerts</a>.</p></div>`;
  const nLikely = h.ready ? list.filter((x) => x.fit && x.fit.f.verdict === 'likely').length : null;
  return `<p class="count-line">${list.length} ${list.length === 1 ? 'home' : 'homes'}${h.ready ? `, ${nLikely} likely a fit for your household` : ''}.${fitNote}</p>
  <ul class="listings">${list.map(listingRow).join('')}</ul>
  ${h.ready ? DISCLAIMER : ''}`;
}

function listingRow({ l, open, fit }) {
  const h = hh();
  const avail = l.units.filter(isAvailable);
  const units = avail.length ? avail : l.units;
  const prices = units.map((u) => u.price).filter(Boolean);
  const hoas = units.map((u) => u.hoa).filter(Boolean);
  const caps = [...new Set(units.map((u) => u.maxAmi).filter(Boolean))].sort((a, b) => a - b);
  const types = [...new Set(units.map((u) => typeLabel(u.type)))];
  const sqft = units.map((u) => u.sqft).filter(Boolean);
  const minP = Math.min(...prices), maxP = Math.max(...prices);
  const priceTxt = prices.length ? (minP === maxP ? money(minP) : `${kmoney(minP)}–${kmoney(maxP)}`) : 'See listing';
  let how;
  if (l.method === 'lottery') {
    const d = daysFromNow(l.dueDate);
    how = open ? `<span class="badge open">Lottery: apply by ${fmtDate(l.dueDate, true)}</span>${d !== null && d < 7 ? ' <span class="badge open">Closes soon</span>' : ''}`
      : `<span class="badge closed">Lottery closed ${fmtDate(l.dueDate)}</span>`;
  } else how = open ? '<span class="badge open">First come, first served</span>' : '<span class="badge closed">No units available</span>';
  const mc = prices.length ? monthlyCost(minP, hoas.length ? Math.min(...hoas) : 0, h.down(minP) ?? minP * 0.05, Number(state.cost.rate) || DEFAULT_RATE) : null;
  const img = l.image ? `<img class="thumb" src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb empty',innerHTML:window.__houseIcon}))">` : `<div class="thumb empty">${houseIcon}</div>`;
  const waiver = l.waivers && (l.waivers.raisedAmi || l.waivers.assetsExcluded);
  return `<li class="listing"><details data-listing="${esc(l.id)}">
    <summary>
      ${img}
      <div>
        <p class="l-title">${esc(l.name)}</p>
        <p class="l-meta">${esc([l.neighborhood, types.join(', '), sqft.length ? `${Math.min(...sqft).toLocaleString()}${sqft.length > 1 && Math.max(...sqft) !== Math.min(...sqft) ? `–${Math.max(...sqft).toLocaleString()}` : ''} sq ft` : '', l.tenure === 'New sale' ? 'New construction' : 'Resale'].filter(Boolean).join(', '))}</p>
        <div class="l-tags">${how} ${caps.length ? `<span class="badge">Income cap ${caps.join('/')}% AMI</span>` : ''} ${waiver ? '<span class="badge">Temporary waivers</span>' : ''} ${fit ? verdictChip(fit.f.verdict) : ''}</div>
      </div>
      <div class="l-side">
        <div class="l-price num">${priceTxt}</div>
        <p class="l-price-note">${hoas.length ? `HOA ${money(Math.min(...hoas))}/mo` : ''}${mc ? `<br>About ${money(mc.total)}/mo all in` : ''}</p>
        <span class="l-more"><span class="when-closed">Details</span><span class="when-open">Hide details</span></span>
      </div>
    </summary>
    <div class="l-body">${listingBody(l, fit)}</div>
  </details></li>`;
}

function listingBody(l, fit) {
  const h = hh();
  const rows = l.units.map((u) => {
    const uf = unitFit(l, u, h);
    const lim = u.maxAmi && h.size ? limitFor(u.maxAmi, h.size) : null;
    return `<tr>
      <td>${esc(u.number || '')}</td><td>${esc(typeLabel(u.type))}</td><td class="r">${u.baths ?? ''}</td><td class="r">${u.sqft ? u.sqft.toLocaleString() : ''}</td>
      <td class="r">${money(u.price)}${u.priceWithParking && u.priceWithParking !== u.price ? `<br><span class="small muted">${money(u.priceWithParking)} with parking</span>` : ''}</td>
      <td class="r">${money(u.hoa)}</td>
      <td>${u.maxAmi ? `${u.maxAmi}%${lim ? `<br><span class="small muted">${money(lim.value)} for ${h.size}</span>` : ''}` : ''}</td>
      <td class="r">${u.minOccupancy ?? ''}</td>
      <td>${esc(u.status || '')}</td>
      ${h.ready ? `<td>${uf ? verdictChip(uf.verdict) : ''}</td>` : ''}
    </tr>`;
  }).join('');
  const w = l.waivers || {};
  const waiverItems = [
    w.raisedAmi && 'The income cap shown already includes a one-time 20-point increase.',
    w.assetsExcluded && 'Savings don’t count toward your income.',
    w.educationAfterApplying && 'You can finish homebuyer education after applying.',
    w.largeDownPayment && 'You can put down more than 50% of the price.',
  ].filter(Boolean);
  const opens = (l.openHouses || []).filter((o) => o.date && daysFromNow(o.date) > -1);
  const lotteryInfo = l.method === 'lottery'
    ? `<p>Applications due ${fmtDate(l.dueDate, true)}.${l.lotteryDate ? ` Lottery held ${fmtDate(l.lotteryDate, true)}.` : ''}${l.lotteryResultsDate ? ` Results posted ${fmtDate(l.lotteryResultsDate)}.` : ''}</p>` : '<p>Complete applications are reviewed in the order received.</p>';
  return `
    ${fit ? `<div><h4>Your fit for the best-matching unit ${verdictChip(fit.f.verdict)}</h4><ul class="reasons">${fit.f.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    <div><h4>How to apply</h4>${lotteryInfo}</div>
    <div class="table-scroll"><h4>Units</h4><table class="small"><thead><tr><th>Unit</th><th>Type</th><th class="r">Baths</th><th class="r">Sq ft</th><th class="r">Price</th><th class="r">HOA</th><th>Income cap</th><th class="r">Min. people</th><th>Status</th>${h.ready ? '<th>You</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    ${waiverItems.length ? `<div class="callout warn"><p><strong>Temporary waivers on this listing${w.expires ? ` (through ${esc(w.expires)})` : ''}:</strong></p><ul class="reasons" style="color:inherit">${waiverItems.map((x) => `<li>${x}</li>`).join('')}</ul></div>` : ''}
    ${opens.length ? `<div><h4>Open houses</h4><ul>${opens.map((o) => `<li>${fmtDate(o.date)}${o.start ? `, ${esc(o.start)}${o.end ? `–${esc(o.end)}` : ''}` : ''}${o.note ? `<br><span class="small muted">${esc(o.note)}</span>` : ''}</li>`).join('')}</ul></div>` : ''}
    ${l.prefs && l.prefs.length ? `<div><h4>Lottery preferences</h4><p class="small muted">Applicants with these preferences are ranked first. Most SFUSD staff qualify for Live or Work in San Francisco.</p><ul>${[...new Set(l.prefs.map((p) => p.name))].map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    ${cleanNotes(l) ? `<div><h4>Notes from the listing</h4><p style="white-space:pre-line">${esc(cleanNotes(l))}</p></div>` : ''}
    <div><h4>Building</h4><p class="small">${esc([l.address, l.yearBuilt ? `Built ${l.yearBuilt}` : '', l.parking].filter(Boolean).join('. '))}</p>${l.amenities ? `<p class="small muted">${esc(l.amenities)}</p>` : ''}</div>
    ${l.agent && l.agent.name ? `<div><h4>Questions about this home</h4><p class="small">${esc(l.agent.name)}${l.agent.title ? `, ${esc(l.agent.title)}` : ''}<br>${l.agent.phone ? `${esc(l.agent.phone)}<br>` : ''}${l.agent.email ? `<a href="mailto:${esc(l.agent.email)}">${esc(l.agent.email)}</a>` : ''}</p></div>` : ''}
    <div class="l-links"><a class="button" href="${esc(l.url)}">Read the listing and apply on DAHLIA</a>${l.mlsUrl ? `<a class="button quiet" href="${esc(l.mlsUrl)}">Photos on MLS</a>` : ''}</div>`;
}

// The waiver paragraph is summarized in its own box, so drop it from the notes.
function cleanNotes(l) {
  if (!l.notes) return '';
  return l.notes
    .replace(/Applicants applying for this BMR unit are eligible for one or more of the following one-time waivers[\s\S]*?(program announcement\.?|announcement\.)/i, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function citySecondBlock() {
  const cs = DATA.citySecond;
  const h = hh();
  const pct = h.ready ? amiPctOf(h.income, h.size) : null;
  const openItems = cs && cs.items ? cs.items.filter((i) => i.status === 'open') : [];
  const items = openItems.map((i) => `<li class="listing" style="padding:1rem 0">
      <p class="l-title">${esc(i.name)}</p>
      <p class="l-meta">${esc(i.unitSize || '')}${i.hoa ? `, HOA ${money(i.hoa)}/mo` : ''}</p>
      <p><span class="l-price num" style="font-size:var(--step-1)">${money(i.price)}</span> <span class="small muted">offer price to match</span></p>
      <p class="small">${esc(i.period || '')}</p>
      ${pct !== null ? `<p>${verdictChip(pct <= 148 && h.owned !== 'yes' ? 'likely' : 'unlikely')} <span class="small muted">Income cap 148% AMI (${money(limitFor(148, h.size).value)} for ${h.size})</span></p>` : ''}
      ${i.url ? `<a href="${esc(i.url)}">Details and application</a>` : ''}
    </li>`).join('');
  return `<h2>Market-price homes with a City loan</h2>
  <p class="prose muted">The City Second program sells certain homes at market price, with a no-interest City loan of up to $500,000 for buyers up to 148% AMI. These aren’t on DAHLIA; they’re posted on sf.gov.</p>
  ${openItems.length ? `<ul class="listings">${items}</ul>` : `<p class="empty-state">No City Second homes are taking applications right now.</p>`}
  <p><a href="${esc((cs && cs.url) || LINKS.citySecond)}">All City Second listings on sf.gov</a>${cs && cs.stale ? ' <span class="small muted">(couldn’t refresh this list on the last check)</span>' : ''}</p>`;
}

/* ---------- Programs ---------- */
function viewPrograms() {
  const p = state.prog, s = state.hh;
  const radio = (name, opts) => `<div class="choices">${opts.map(([v, t]) => `<label><input type="radio" name="${name}" value="${v}" data-prog="${name}"${p[name] === v ? ' checked' : ''}> ${t}</label>`).join('')}</div>`;
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Find programs that fit you</h1>
      <p class="lede">Answer a few questions to see which City and state programs you might qualify for, for renting or buying, including the ones only for SFUSD staff.</p>
    </section>
    <div class="split">
      <form class="form" id="prog-form" autocomplete="off" onsubmit="return false">
        <fieldset class="field"><legend>Are you looking to rent or buy?</legend>
          ${radio('tenure', [['buy', 'Buy'], ['rent', 'Rent'], ['unsure', 'I don’t know yet']])}
        </fieldset>
        <fieldset class="field"><legend>Do you work for SFUSD?</legend>
          ${radio('sfusd', [['full', 'Yes, full time'], ['part30', 'Part time, and SFUSD is at least 30% of my income'], ['partUnder', 'Part time, under 30%'], ['no', 'No']])}
        </fieldset>
        ${p.sfusd && p.sfusd !== 'no' ? `<div class="field"><label for="p-role">What’s your role?</label><select id="p-role" data-prog="role"><option value="">Choose…</option>${ROLES.map((r) => `<option value="${r.id}"${p.role === r.id ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="p-size">How many people will live in the home?</label><select id="p-size" data-hh="size">${sizeOptions(s.size)}</select></div>
        <div class="field"><label for="p-income">Total yearly household income, before taxes</label><div class="money"><input id="p-income" data-hh="income" inputmode="decimal" type="text" value="${esc(s.income)}" placeholder="95,000"></div></div>
        ${p.tenure === 'rent' ? '' : `<fieldset class="field"><legend>Has anyone in the household owned a home in the last 3 years?</legend>
          ${radio('owned', [['no', 'No'], ['outsideSF', 'Yes, but only outside San Francisco'], ['inSF', 'Yes, in San Francisco']])}
        </fieldset>
        <div class="field"><label for="p-sav">Savings and investments (optional)</label><div class="money"><input id="p-sav" data-hh="assets" inputmode="decimal" type="text" value="${esc(s.assets)}" placeholder="0"></div></div>
        <fieldset class="field"><legend>Did your parents ever own a home?</legend><span class="hint">Only used for CalHFA’s first-generation program.</span>
          ${radio('firstGen', [['no', 'Yes, they did'], ['yes', 'No, never'], ['unsure', 'Not sure']])}
        </fieldset>`}
        <p class="small muted">Nothing you type here is saved or sent anywhere.</p>
      </form>
      <div id="prog-result" aria-live="polite">${programsResult()}</div>
    </div>
  </div>`;
}

function programsResult() {
  const p = state.prog; const h = hh();
  const buying = p.tenure !== 'rent';
  const missing = [];
  if (!p.tenure) missing.push('whether you want to rent or buy');
  if (!p.sfusd) missing.push('whether you work for SFUSD');
  if (p.sfusd && p.sfusd !== 'no' && !p.role) missing.push('your role');
  if (!h.size) missing.push('household size');
  if (!h.income) missing.push('income');
  if (buying && p.tenure && !p.owned) missing.push('past home ownership');
  if (missing.length) return `<div class="panel"><h2 style="font-size:var(--step-2)">Your programs</h2><p class="muted">Still needed: ${missing.join(', ')}.</p></div>`;
  count('used-programs');
  const pct = amiPctOf(h.income, h.size);
  const order = { likely: 0, maybe: 1, unlikely: 2 };
  const render = (res) => `<ul class="programs">${res.sort((a, b) => order[a.verdict] - order[b.verdict]).map((r) => `<li class="program${r.verdict === 'unlikely' ? ' dim' : ''}">
      <div>${verdictChip(r.verdict)}</div>
      <div>
        <h3>${esc(r.name)}</h3>
        <p class="who">${esc(r.who)}. <span class="badge ${r.status.tone}">${esc(r.status.label)}</span></p>
        <p>${esc(r.what)}</p>
        <ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p style="margin:.6rem 0 0"><a href="${esc(r.link)}">${esc(r.linkText)}</a>${['edalp', 'dalp', 'tnd', 'dkdalp'].includes(r.id) ? '. <a href="#/dalp">More on how DALP works</a>' : ''}</p>
      </div></li>`).join('')}</ul>`;

  let rentHtml = '';
  if (p.tenure !== 'buy') {
    const rh = { ...h, voucher: false };
    const all = RENTALS ? RENTALS.listings : [];
    const open = all.filter(rentalOpen);
    const fitsOpen = open.filter((l) => { const f = rentalFit(l, rh); return f && f.f.verdict === 'likely'; }).length;
    const fitsAny = all.filter((l) => { const f = rentalFit(l, rh); return f && f.f.verdict === 'likely'; }).length;
    const eduOpen = all.some((l) => l.educator && rentalOpen(l));
    rentHtml = render(matchRentalPrograms({ sfusd: p.sfusd, amiPct: pct, rentals: { openListings: open.length, fitsOpen, fitsAny, eduOpen } }));
  }
  let buyHtml = '';
  if (buying) {
    state.hh.owned = p.owned === 'no' ? 'no' : 'yes';
    const caps = openListings().flatMap((l) => l.units.filter(isAvailable).map((u) => u.maxAmi)).filter(Boolean);
    buyHtml = render(matchPrograms({
      sfusd: p.sfusd, role: p.role, size: h.size, income: h.income, amiPct: pct,
      owned: p.owned, firstGen: p.firstGen || 'unsure', savings: h.assets, bmrMaxCap: caps.length ? Math.max(...caps) : 120, balances: BALANCES,
    }));
  }
  const head = `<p class="small muted" style="margin-top:0">At about ${Math.round(pct)}% of AMI for a household of ${h.size}:</p>`;
  let body;
  if (p.tenure === 'rent') body = `${rentHtml}<p class="small muted" style="margin-top:1rem">Thinking about buying someday? Choose “Buy” or “I don’t know yet” above to see homeownership programs too.</p>`;
  else if (p.tenure === 'buy') body = buyHtml;
  else body = `<h3 style="margin:.5rem 0">If you rent</h3>${rentHtml}<h3 style="margin:2rem 0 .5rem">If you buy</h3>${buyHtml}`;
  const steps = p.tenure === 'rent' ? nextSteps('Your next steps', ['rentals', 'alerts', 'dahliaRent']) : nextSteps('Your next steps', ['education', 'agencies', 'lenders']);
  return `${head}${body}${steps}${DISCLAIMER}`;
}

/* ---------- Recent & upcoming ---------- */
function viewRecent() {
  const now = Date.now();
  const all = Object.values(HISTORY.listings || {});
  const current = new Map(DATA.listings.map((l) => [l.id, l]));
  const merged = all.map((h) => current.get(h.id) || h);
  const lotteriesOpen = DATA.listings.filter((l) => l.method === 'lottery' && isOpen(l)).sort((a, b) => toDate(a.dueDate) - toDate(b.dueDate));
  const closed = merged.filter((l) => l.method === 'lottery' && l.dueDate && toDate(l.dueDate) < now).sort((a, b) => toDate(b.dueDate) - toDate(a.dueDate));
  const opens = DATA.listings.flatMap((l) => (l.openHouses || []).filter((o) => o.date && daysFromNow(o.date) > -1 && daysFromNow(o.date) < 45).map((o) => ({ l, o }))).sort((a, b) => toDate(a.o.date) - toDate(b.o.date));
  const firstDates = all.map((h) => h.firstSeen).filter(Boolean).sort();
  const trackingStart = firstDates[0];
  const fresh = all.filter((h) => h.firstSeen && h.firstSeen > trackingStart && daysFromNow(h.firstSeen) > -30).map((h) => current.get(h.id) || h);
  const priceOf = (l) => { const p = l.units.map((u) => u.price).filter(Boolean); return p.length ? (Math.min(...p) === Math.max(...p) ? money(p[0]) : `${kmoney(Math.min(...p))}–${kmoney(Math.max(...p))}`) : ''; };
  const capOf = (l) => [...new Set(l.units.map((u) => u.maxAmi).filter(Boolean))].join('/');
  const typesOf = (l) => [...new Set(l.units.map((u) => typeLabel(u.type)))].join(', ');
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Recent and upcoming</h1>
      <p class="lede">Deadlines and open houses coming up, and the lotteries that recently closed.</p>
    </section>
    <div class="split">
      <section>
        <h2>Deadlines coming up</h2>
        ${lotteriesOpen.length ? `<ol class="timeline">${lotteriesOpen.map((l) => `<li class="${daysFromNow(l.dueDate) < 7 ? 'soon' : ''}"><span class="when">${fmtDate(l.dueDate, true)}</span><br><a href="#/homes" data-open="${esc(l.id)}">${esc(l.name)}</a><br><span class="small muted">${esc(typesOf(l))}, ${priceOf(l)}, cap ${capOf(l)}% AMI${l.lotteryDate ? `. Lottery ${fmtDate(l.lotteryDate)}` : ''}</span></li>`).join('')}</ol>` : '<p class="muted">No lottery deadlines right now. First-come listings are still open on the Homes page.</p>'}
      </section>
      <section>
        <h2>Open houses</h2>
        ${opens.length ? `<ol class="timeline">${opens.map(({ l, o }) => `<li><span class="when">${fmtDate(o.date)}${o.start ? `, ${esc(o.start)}` : ''}</span><br>${esc(l.name)}</li>`).join('')}</ol>` : '<p class="muted">No open houses posted for the next few weeks. Many first-come listings show by appointment; contact the agent on the listing.</p>'}
      </section>
    </div>

    <section class="section">
      <h2>Recently closed lotteries</h2>
      <p class="muted prose">Listing prices when the lottery opened. The City doesn’t publish final sale prices. Lottery results are posted on each DAHLIA listing.</p>
      ${closed.length ? `<div class="table-scroll"><table><thead><tr><th>Home</th><th>Closed</th><th>Units</th><th class="r">Price</th><th>Income cap</th><th>Results</th></tr></thead><tbody>
        ${closed.map((l) => `<tr><td><a href="${esc(l.url)}">${esc(l.name)}</a>${l.neighborhood ? `<br><span class="small muted">${esc(l.neighborhood)}</span>` : ''}</td><td>${fmtDate(l.dueDate)}</td><td>${esc(typesOf(l))}</td><td class="r num">${priceOf(l)}</td><td>${capOf(l)}% AMI</td><td>${l.lotteryResultsDate ? fmtDate(l.lotteryResultsDate) : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">None in the data yet.</p>'}
    </section>

    <section class="section">
      <h2>New listings</h2>
      ${fresh.length ? `<ul>${fresh.map((l) => `<li>${esc(l.name)}: first seen ${fmtDate(l.firstSeen)}</li>`).join('')}</ul>` : `<p class="muted prose">This page started tracking listings on ${fmtDate(trackingStart)}. Homes that appear after that date will show here for 30 days.</p>`}
    </section>

    <section class="section prose">
      <h2>What’s coming</h2>
      <p>There’s no public schedule of future BMR listings. They appear on DAHLIA when a developer or seller is ready, usually with a few weeks’ notice before a lottery deadline. The best early warning is <a href="${LINKS.alerts}">MOHCD’s housing email alerts</a>.</p>
      <p>Down payment programs run in rounds. The last City DALP round, which includes Educators-DALP, took applications March 4 to June 2, 2025. CalHFA’s Dream For All took applications February 24 to March 16, 2026. Neither has announced its next round yet.</p>
    </section>
  </div>`;
}

/* ---------- Verify ---------- */
function viewVerify() {
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Get it confirmed</h1>
      <p class="lede">This guide gives you a sense of where you stand. These are the people who actually decide, and they’re free to talk to.</p>
    </section>
    <section aria-label="Key links" style="margin-bottom:2.5rem">
      <ul class="linkcards" style="max-width:760px">${linkCard('education', { key: true })}${linkCard('lenders')}${linkCard('mohcd')}</ul>
    </section>
    <section class="prose">
      <h2>Who confirms what</h2>
      <ul>
        <li><strong>A housing counselor</strong> reviews your finances one on one and tells you which programs you can apply for. This meeting is part of the required 10 hours of homebuyer education.</li>
        <li><strong>A MOHCD-approved lender</strong> decides how large a mortgage you qualify for and writes your pre-approval letter. <a href="${LINKS.lenders}">Find an approved lender</a>.</li>
        <li><strong>MOHCD</strong> makes the final eligibility decision after you’re selected for a home, based on your documents.</li>
      </ul>
      <p>Your counselor will give you an exact document list. Expect recent pay stubs, several years of tax returns and bank statements for everyone 18 or older.</p>
    </section>

    <section class="section">
      <h2>Housing counseling agencies</h2>
      <p class="prose muted">All are HUD-approved and members of HomeownershipSF. You must do your workshop and counseling session at the same agency.</p>
      <ul class="agency-cards">
        ${[
          { n: 'HomeownershipSF', hub: true, note: 'Start here. Book the free 2-hour orientation, then pick an agency below for your workshop and counseling.', addr: '275 5th St, Suite 314, San Francisco, CA 94103', tel: '(415) 202-5464', web: 'https://www.homeownershipsf.org/homebuyer-education/', webLabel: 'Sign up for classes' },
          { n: 'Asian, Inc.', note: 'English, Cantonese, Mandarin', addr: '1167 Mission St, 4th Floor, San Francisco, CA 94103', tel: '(415) 928-5910', web: 'https://www.asianinc.org/housing/' },
          { n: 'BALANCE', note: 'English, Spanish, Tagalog, Russian', addr: '3543 18th St, San Francisco, CA 94110', tel: '(800) 777-7526', web: 'https://www.balancepro.org/housing-workshops' },
          { n: 'Mission Economic Development Agency (MEDA)', note: 'English, Spanish', addr: '2301 Mission St, Suite 301, San Francisco, CA 94110', tel: '(415) 282-3334', ext: '115', web: 'https://medasf.org/programs/housing-opportunities/' },
          { n: 'San Francisco LGBT Community Center', note: '', addr: '1800 Market St, San Francisco, CA 94102', tel: '(415) 865-5555', web: 'https://www.sfcenter.org/program/housing-financial/' },
          { n: 'San Francisco Housing Development Corporation', note: 'A HomeownershipSF member agency.', addr: '', tel: '', web: 'https://www.sfhdc.org/' },
        ].map((g) => `<li class="agency-card${g.hub ? ' hub' : ''}">
            <h3>${esc(g.n)}</h3>
            ${g.note ? `<p>${esc(g.note)}</p>` : ''}
            ${g.addr ? `<p>${esc(g.addr)}</p>` : ''}
            ${g.tel ? `<p class="num">${esc(g.tel)}${g.ext ? ` ext. ${g.ext}` : ''}</p>` : ''}
            <div class="actions">
              <a class="button${g.hub ? '' : ' quiet'}" href="${g.web}">${esc(g.webLabel || 'Website')}</a>
              ${g.tel ? `<a class="button quiet" href="tel:+1${g.tel.replace(/\D/g, '')}${g.ext ? `,${g.ext}` : ''}">Call</a>` : ''}
            </div>
          </li>`).join('')}
      </ul>
      <p class="small muted" style="margin-top:1rem">Agency details from <a href="${LINKS.agencies}">sf.gov</a>, November 2026. Call ahead; hours and locations change.</p>
    </section>

    <section class="section split">
      <div class="prose">
        <h2>MOHCD</h2>
        <p>Mayor’s Office of Housing and Community Development<br>1 South Van Ness Ave, 5th Floor, San Francisco</p>
        <p>Front desk: (415) 701-5500<br>Housing programs: (415) 701-5622 (English), 701-5624 (Español), 701-5623 (中文), 701-5570 (Filipino)<br>Email: <a href="mailto:sfhousinginfo@sfgov.org">sfhousinginfo@sfgov.org</a></p>
        <p>For a specific listing, contact the agent named on it.</p>
      </div>
      <div class="prose">
        <h2>For SFUSD staff</h2>
        <p>HomeownershipSF runs housing clinics for SFUSD educators with free help on BMR homes and Teacher Next Door. <a href="https://www.homeownershipsf.org/educators/">See educator resources</a>.</p>
        <p>Teacher Next Door and Educators-DALP need proof of SFUSD employment, such as a recent pay stub or a letter from SFUSD.</p>
      </div>
    </section>
  </div>`;
}

function viewPrivacy() {
  return `
  <div class="wrap prose">
    <h1>Privacy</h1>
    <p class="lede">Nothing you type into this site is stored, saved or sent anywhere.</p>
    <ul>
      <li>All calculations run in your own browser. Your income, household and answers live only in this page’s memory.</li>
      <li>Nothing is written to cookies or browser storage, and nothing goes into the page address.</li>
      <li>Closing or reloading the page erases everything you entered.</li>
      <li>There are no accounts and no forms that submit anywhere.</li>
    </ul>
    <h2>What the site does load</h2>
    <ul>
      <li>Listing data saved in this site’s own files, refreshed every few hours from the City’s DAHLIA portal.</li>
      <li>Listing photos load directly from the City’s servers, which see a normal image request from your browser.</li>
      <li>${GOATCOUNTER_CODE ? 'Anonymous visit counts through <a href="https://www.goatcounter.com/">GoatCounter</a>: which page was viewed, the referring site, browser type, screen size and rough country. No cookies. It also counts that a calculator was used, but never what was typed into it.' : 'No analytics are currently turned on.'}</li>
    </ul>
    <p>Links to sf.gov, DAHLIA, lenders and agencies take you to their sites, which have their own privacy policies.</p>
  </div>`;
}

/* ---------- Down payment loans (DALP) ---------- */
// Figures and rules from MOHCD's DALP Manual (September 2025) and sf.gov.
const DALP_LINKS = {
  manual: 'https://www.sf.gov/documents/36972/DALP_Manual_September_2025.pdf',
  apply: 'https://sf.gov/apply-downpayment-loan-buy-market-rate-home',
  educators: 'https://www.sf.gov/educators-downpayment-assistance-loan-program',
  terms: 'https://www.sf.gov/reports--december-2024--downpayment-assistance-loan-program-dalp',
  balances: 'https://www.sf.gov/data--mohcd-loan-program-balances',
  results: 'https://sf.gov/dalp-lottery-results',
  tnd: 'https://www.sf.gov/reports--august-2024--about-teacher-next-door-program',
  bmrDalp: 'https://www.sf.gov/reports--august-2024--about-below-market-rate-downpayment-assistance-loan-program-bmr-dalp',
  dk: 'https://www.sf.gov/reports/may-2023/dream-keeper-downpayment-assistance-loan-program-dk-dalp',
  subordination: 'https://www.sf.gov/refinancing-and-subordination',
};
const DALP_MAX = 500000;
const CLOSING_COST_SHARE = 0.02;   // manual's example: closing costs ~2% of price
const INSURANCE_SHARE = 0.002;     // manual's example: $250/mo on $1.5M, about 0.2% a year

function dalpInputs() {
  const h = hh();
  const d = state.dalp;
  const price = parseMoney(d.price) ?? 1000000;
  const cash = resolveDown(d.cash, price) ?? price * 0.01;
  return {
    h, price, cash,
    cashIsPct: !d.cash || isPercent(d.cash),
    hoa: parseMoney(d.hoa) ?? 0,
    debts: parseMoney(d.debts) ?? 0,
    rate: Number(String(d.rate).replace(/[^\d.]/g, '')) || DEFAULT_RATE,
    years: Math.min(Math.max(Number(d.years) || 7, 1), 30),
    growth: Number(String(d.growth).replace(/[^\d.-]/g, '')) || 0,
  };
}

// Size the loans the way the manual describes: the first mortgage is the
// largest the household qualifies for (housing costs up to 43% of income,
// total debts up to 45%), and DALP covers only the remaining gap.
function dalpCalc(price, cash, inp) {
  const { h, hoa, debts, rate } = inp;
  const mi = h.income / 12;
  const r = rate / 100 / 12; const f = r / (1 - Math.pow(1 + r, -360));
  const nonLoan = (price * PROPERTY_TAX_RATE) / 100 / 12 + (price * INSURANCE_SHARE) / 12 + hoa;
  const cap = Math.min(0.43 * mi - nonLoan, 0.45 * mi - debts - nonLoan);
  const maxFirst = cap > 0 ? cap / f : 0;
  const needed = price * (1 + CLOSING_COST_SHARE) - cash;
  const first = Math.max(0, Math.min(maxFirst, needed));
  const dalp = Math.max(0, needed - first);
  const monthly = first * f + nonLoan;
  return { mi, f, nonLoan, maxFirst, needed, first, dalp, monthly, ratio: (monthly / mi) * 100, closing: price * CLOSING_COST_SHARE };
}

function dalpMaxPrice(inp) {
  const d = state.dalp;
  const cashFor = (p) => resolveDown(d.cash, p) ?? p * 0.01;
  const ok = (p) => { const c = dalpCalc(p, cashFor(p), inp); return c.dalp <= DALP_MAX && c.first >= 0.5 * p; };
  let lo = 100000, hi = 5000000;
  if (!ok(lo)) return null;
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ok(mid)) lo = mid; else hi = mid; }
  return Math.floor(lo / 5000) * 5000;
}

function balanceRows() {
  if (!BALANCES) return '';
  const p = BALANCES.programs;
  const row = (k, note) => {
    const x = p[k]; if (!x) return '';
    const empty = x.balance === 0;
    return `<tr><td>${esc(x.label)}</td><td class="r num">${money(x.balance)}</td><td>${x.households != null ? (empty ? '<span class="badge closed">No funds</span>' : `About ${x.households} ${x.households === 1 ? 'household' : 'households'}`) : ''}</td><td class="small muted">${note || ''}</td></tr>`;
  };
  return `<div class="table-scroll"><table>
    <thead><tr><th>Program</th><th class="r">Funds left</th><th>Enough for</th><th></th></tr></thead>
    <tbody>
      ${row('educators', 'Educators are also considered in the General pools.')}
      ${row('tnd', 'One more $20,000 BMR loan, or half of a $40,000 one.')}
      ${row('general120')}
      ${row('general200')}
      ${row('bmrDalp', 'Need-based; requested through your lender.')}
      ${row('citySecond', 'Only for specific City Second homes.')}
    </tbody></table></div>
    <p class="small muted">From MOHCD’s <a href="${BALANCES.source}">loan program balances</a> as of ${fmtDate(BALANCES.asOf)}. MOHCD updates that page every weekday; this site copies it by hand, so check there for today’s numbers.</p>`;
}

function viewDalp() {
  const d = state.dalp; const s = state.hh;
  const lim = (pct, n) => money(limitFor(pct, n).value);
  const limRows = [1, 2, 3, 4, 5, 6].map((n) => `<tr><td>${n} ${n === 1 ? 'person' : 'people'}</td><td class="r num">${lim(120, n)}</td><td class="r num">${lim(200, n)}</td></tr>`).join('');
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Down payment loans (DALP)</h1>
      <p class="lede">The City lends first-time buyers up to $500,000 toward a market-rate home anywhere in San Francisco. There’s no interest and no monthly payment. When you sell, you repay the loan plus the City’s share of any rise in value.</p>
    </section>

    <section class="split">
      <div class="prose">
        <h2>Where the money stands</h2>
        <p>DALP loans are handed out in yearly rounds by lottery. The last round took applications March 4 to June 2, 2025, and drew its lottery June 25, 2025. No 2026 round has been announced.</p>
        <p><strong>Funds left from that round are small</strong>, and the educator pool is empty. Under the program rules, money left after a lottery can be offered first come, first served until it runs out, so it’s worth asking MOHCD whether any is open: <a href="mailto:sfhousinginfo@sfgov.org">sfhousinginfo@sfgov.org</a>.</p>
      </div>
      <div>${balanceRows()}</div>
    </section>

    <section class="section">
      <h2>The DALP family</h2>
      <p class="prose muted">MOHCD runs several loan programs under the DALP name. They share most rules but differ in who can use them and for what kind of home.</p>
      <div class="table-scroll"><table>
        <thead><tr><th>Program</th><th>For</th><th>Amount</th><th>Paid back</th><th>Who</th></tr></thead>
        <tbody>
          <tr><td><a href="${DALP_LINKS.apply}">General DALP</a></td><td>Market-rate homes</td><td>Up to $500,000</td><td>Loan plus share of appreciation, when you sell</td><td>First-time buyers up to 200% AMI</td></tr>
          <tr><td><a href="${DALP_LINKS.educators}">Educators-DALP</a></td><td>Market-rate homes</td><td>Up to $500,000</td><td>Same as General DALP</td><td>SFUSD employees up to 200% AMI</td></tr>
          <tr><td><a href="${DALP_LINKS.tnd}">Teacher Next Door</a></td><td>BMR or market-rate homes</td><td>$20,000 (BMR) or $40,000 (market rate)</td><td>Forgiven over 10 years if you stay at SFUSD</td><td>SFUSD educators up to 200% AMI</td></tr>
          <tr><td><a href="${DALP_LINKS.bmrDalp}">BMR-DALP</a></td><td>BMR homes</td><td>What you need, up to 20% of the price</td><td>When you sell</td><td>BMR buyers</td></tr>
          <tr><td><a href="${LINKS.citySecond}">City Second</a></td><td>Specific listed homes</td><td>Up to $500,000</td><td>When you sell</td><td>Up to 148% AMI</td></tr>
          <tr><td><a href="${DALP_LINKS.dk}">Dream Keeper DALP</a></td><td>Market-rate homes</td><td>Up to $500,000</td><td>Loan plus share of appreciation</td><td>Up to 200% AMI, with priority groups</td></tr>
        </tbody></table></div>
      <p class="small muted">Teacher Next Door can be added on top of Educators-DALP, General DALP or a BMR purchase. You need to qualify for each program you combine, and the stricter rule wins.</p>
    </section>

    <section class="section" id="estimator">
      <h2>Estimate a DALP loan</h2>
      <p class="prose muted">This sizes the loans the way MOHCD does: your first mortgage is the biggest you qualify for, and DALP fills only the gap. Then it shows what you’d owe the City when you sell.</p>
      <div class="split">
        <form class="form" id="dalp-form" autocomplete="off" onsubmit="return false">
          <div class="field"><label for="d-size">People in household</label><select id="d-size" data-hh="size">${sizeOptions(s.size)}</select></div>
          <div class="field"><label for="d-income">Yearly household income, before taxes</label><div class="money"><input id="d-income" data-hh="income" inputmode="decimal" type="text" value="${esc(s.income)}" placeholder="160,000"></div></div>
          <div class="field"><label for="d-price">Home price</label><span class="hint">A market-rate home. DALP can’t be used for BMR units.</span><div class="money"><input id="d-price" data-dalp="price" inputmode="decimal" type="text" value="${esc(d.price)}" placeholder="1,000,000"></div></div>
          <div class="field"><label for="d-cash">Your own cash toward the purchase</label><span class="hint">Dollars or a percent of the price. The minimum is 1%, and it can all be gifts.</span><input id="d-cash" data-dalp="cash" type="text" value="${esc(d.cash)}" placeholder="1%"></div>
          <div class="field"><label for="d-hoa">Monthly HOA dues</label><span class="hint">Leave blank for a house with no HOA.</span><div class="money"><input id="d-hoa" data-dalp="hoa" inputmode="decimal" type="text" value="${esc(d.hoa)}" placeholder="0"></div></div>
          <div class="field"><label for="d-debts">Other monthly debt payments</label><span class="hint">Car, student loan and credit card minimums. Total debts can’t top 45% of income.</span><div class="money"><input id="d-debts" data-dalp="debts" inputmode="decimal" type="text" value="${esc(d.debts)}" placeholder="0"></div></div>
          <div class="field"><label for="d-rate">Mortgage rate (%)</label><input id="d-rate" data-dalp="rate" inputmode="decimal" type="text" value="${esc(d.rate)}" style="max-width:8rem"></div>
          <fieldset class="field"><legend>When you sell</legend>
            <div style="display:flex;gap:1rem;flex-wrap:wrap">
              <div><label for="d-years" style="font-weight:400">Years from now</label><input id="d-years" data-dalp="years" inputmode="numeric" type="text" value="${esc(d.years)}" style="max-width:6rem"></div>
              <div><label for="d-growth" style="font-weight:400">Yearly price growth (%)</label><input id="d-growth" data-dalp="growth" inputmode="decimal" type="text" value="${esc(d.growth)}" style="max-width:6rem"></div>
            </div>
          </fieldset>
          <p class="small muted">Nothing you type here is saved or sent anywhere.</p>
        </form>
        <div class="panel" id="dalp-result" aria-live="polite">${dalpResult()}</div>
      </div>
    </section>

    <section class="section">
      <h2>How a DALP round works</h2>
      <ol class="path">
        <li><h3>Get ready before the round opens</h3><p>Finish homebuyer education (good for one year) and get a pre-approval letter from a <a href="${LINKS.lenders}">MOHCD-approved lender</a> dated within 120 days. It must show a market-rate price, your maximum first loan and the DALP amount.</p></li>
        <li><h3>Apply once during the window</h3><p>Windows open at least 90 days before the lottery. There’s one application; it asks whether you’re an educator. Applying again as the general public can get all your applications thrown out.</p></li>
        <li><h3>Lottery</h3><p>Every application gets a random rank. Educators are reviewed first, then first responders, then everyone else. Educators not funded in their pool move to the general pool if they qualify.</p></li>
        <li><h3>Send your full application within 5 business days</h3><p>MOHCD contacts people in rank order. Have three years of tax returns and W-2s, three recent pay stubs, three months of bank statements, ID and your lease ready before the lottery.</p></li>
        <li><h3>Find a home within 90 days</h3><p>Once funds are reserved, you have 90 calendar days to get into contract. Your lender then has 21 days to send the loan package, and MOHCD reviews it in 15 business days.</p></li>
        <li><h3>Close</h3><p>MOHCD’s commitment letter is good for 30 days. Everyone on the loan meets with MOHCD before closing.</p></li>
      </ol>
    </section>

    <section class="section split">
      <div class="prose">
        <h2>Rules that catch people</h2>
        <ul>
          <li><strong>First-time buyer:</strong> no one in the household can have owned any home, anywhere, in the last 3 years. For Educators-DALP and Teacher Next Door, only San Francisco ownership counts.</li>
          <li><strong>Savings cap after closing:</strong> liquid assets can’t be over $80,000 once you buy. Extra cash goes into the down payment. 401(k), 403(b), IRA, HSA and 529 balances don’t count.</li>
          <li><strong>Reserves:</strong> you need at least 2 months of housing costs left after closing. Retirement funds you can withdraw from can count.</li>
          <li><strong>Housing costs between 28% and 43% of income.</strong> MOHCD can allow 45% with two of: a 12-month rent history at that level, 6 months of reserves, 20% down, a credit score over 700, or costs rising less than 5%.</li>
          <li><strong>Home size:</strong> no more than one bedroom over your household size. This doesn’t apply to Educators-DALP or Teacher Next Door.</li>
          <li><strong>No sizing tricks:</strong> you can’t lower your first mortgage, gifts or credits to get a bigger DALP loan.</li>
        </ul>
      </div>
      <div class="prose">
        <h2>After you buy</h2>
        <ul>
          <li>The home must stay your main residence. Renting it out, even a parking space, makes the loan due.</li>
          <li>You can repay early, but only in full, with an appraisal to set the City’s share.</li>
          <li>You can refinance your first mortgage after 12 months to lower your rate, term or payment, with MOHCD’s approval. No cash-out until DALP is repaid.</li>
          <li>Home equity loans and lines of credit aren’t allowed.</li>
          <li>If the home doesn’t gain value, you repay only what you borrowed.</li>
        </ul>
        <h2>2026 income limits</h2>
        <table class="small"><thead><tr><th>Household</th><th class="r">120% AMI</th><th class="r">200% AMI</th></tr></thead><tbody>${limRows}</tbody></table>
        <p class="small muted">The 120% and 200% pools are funded separately. Everyone is ranked on one list.</p>
      </div>
    </section>

    <section class="section">
      <h2>For SFUSD staff</h2>
      <div class="split">
        <div class="prose">
          <h3>Educators-DALP</h3>
          <ul>
            <li>For SFUSD employees, including Early Education. Part-time staff need at least 30% of their income from SFUSD.</li>
            <li>Same loan terms as General DALP, but educators are reviewed first in the lottery.</li>
            <li>Bring a pay stub or SFUSD letter with your job title, dated within 45 days.</li>
            <li>Its fund is empty as of ${BALANCES ? fmtDate(BALANCES.asOf) : 'November 2026'}. Educators can still be funded from the General pools.</li>
          </ul>
        </div>
        <div class="prose">
          <h3>Teacher Next Door</h3>
          <ul>
            <li>$20,000 for a BMR home or $40,000 for a market-rate one; one per household. No interest and no share of appreciation.</li>
            <li>Forgiven 20% a year after year 5, fully after year 10, as long as you stay at SFUSD and in the home.</li>
            <li>Leave SFUSD in the first 10 years and the unforgiven balance is due. If the job ended through disability, layoff or position elimination, you can repay monthly over 5 years instead.</li>
            <li>First come, first served. No separate application when added to a BMR or DALP purchase; ask your lender.</li>
          </ul>
        </div>
      </div>
    </section>

    <section class="section prose">
      <h2>Be ready for the next round</h2>
      <ul>
        <li>Finish homebuyer education now; it stays valid for a year. <a href="${LINKS.education}">Sign up through HomeownershipSF</a>.</li>
        <li>Gather three years of tax returns and W-2s and keep recent pay stubs and bank statements handy. The 5-day turnaround after the lottery is tight.</li>
        <li>Talk to a <a href="${LINKS.lenders}">MOHCD-approved lender</a> about a DALP pre-approval.</li>
        <li><a href="${LINKS.alerts}">Sign up for MOHCD’s email alerts</a> to hear when the next round opens.</li>
      </ul>
      <p class="small muted">Sources: <a href="${DALP_LINKS.manual}">DALP Manual, September 2025</a>, <a href="${DALP_LINKS.terms}">DALP loan terms</a>, <a href="${DALP_LINKS.educators}">Educators-DALP</a>, <a href="${DALP_LINKS.apply}">DALP application page</a>. The program manual and promissory note control if anything here differs.</p>
    </section>
  </div>`;
}

function dalpResult() {
  const inp = dalpInputs();
  const { h, price, cash, years, growth, rate } = inp;
  if (!h.ready) return `<h2 style="font-size:var(--step-2)">Your estimate</h2><p class="muted">Choose a household size and enter your income to see an estimate.</p>`;
  count('used-dalp-estimator');
  const pct = amiPctOf(h.income, h.size);
  const c = dalpCalc(price, cash, inp);
  const notes = [];
  let verdict = 'likely';
  if (pct > 200) { verdict = 'unlikely'; notes.push(`Your income is about ${Math.round(pct)}% of AMI. DALP’s limit is 200% (${money(limitFor(200, h.size).value)} for ${h.size}).`); }
  else if (pct > 120) notes.push(`At about ${Math.round(pct)}% of AMI you’d draw from the 200% pool, which is the smaller one.`);
  else notes.push(`At about ${Math.round(pct)}% of AMI you’re eligible for both the 120% and 200% pools.`);
  if (cash < price * 0.01 - 1) { verdict = 'unlikely'; notes.push(`You need at least 1% of the price in your own cash or gifts: ${money(price * 0.01)}.`); }
  let headline;
  if (c.maxFirst <= 0) { verdict = 'unlikely'; headline = 'Your income doesn’t support a first mortgage at this price, HOA and debt level.'; }
  else if (c.dalp <= 0) headline = 'You likely wouldn’t need DALP for this price. Your income supports a first mortgage that covers it.';
  else if (c.dalp > DALP_MAX) { verdict = 'unlikely'; headline = `This price needs ${money(c.dalp)} of help, over the $500,000 maximum. You’d need ${money(c.dalp - DALP_MAX)} more cash, or a lower price.`; }
  else headline = `You’d likely need a DALP loan of about <strong>${money(c.dalp)}</strong>.`;
  if (c.dalp > 0 && c.first < 0.5 * price) { verdict = 'unlikely'; notes.push('Your first mortgage must cover at least half the price.'); }
  const maxP = dalpMaxPrice(inp);
  const dalpAmt = Math.min(Math.max(c.dalp, 0), DALP_MAX);
  const share = price ? dalpAmt / price : 0;
  // resale
  const resale = price * Math.pow(1 + growth / 100, years);
  const gain = Math.max(0, resale - price);
  const cityShare = share * gain;
  const owed = dalpAmt + cityShare;
  const r = rate / 100 / 12; const n = 360, k = Math.min(years * 12, n);
  const firstBal = c.first * (Math.pow(1 + r, n) - Math.pow(1 + r, k)) / (Math.pow(1 + r, n) - 1);
  const yours = resale - firstBal - owed;
  return `<p class="small muted" style="margin:0 0 .3rem">Estimated DALP loan</p>
    <p class="result-figure num">${money(dalpAmt)}</p>
    <p style="margin-bottom:.6rem">${verdictChip(verdict)}</p>
    <p>${headline}</p>
    <table class="small"><tbody>
      <tr><td>Price plus closing costs (about 2%)</td><td class="r num">${money(price + c.closing)}</td></tr>
      <tr><td>Your cash</td><td class="r num">−${money(cash)}</td></tr>
      <tr><td>First mortgage (the most you qualify for)</td><td class="r num">−${money(c.first)}</td></tr>
      <tr><td><strong>DALP covers</strong></td><td class="r num"><strong>${money(dalpAmt)}</strong></td></tr>
      ${c.dalp > DALP_MAX ? `<tr><td><strong>Still short</strong></td><td class="r num" style="color:var(--no)"><strong>${money(c.dalp - DALP_MAX)}</strong></td></tr>` : ''}
      <tr><td>Monthly housing cost</td><td class="r num">${money(c.monthly)} (${Math.round(c.ratio)}% of income)</td></tr>
    </tbody></table>
    <ul class="reasons" style="margin-top:.75rem">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    ${maxP ? `<p style="margin-top:.75rem">With the full $500,000, the highest price your income likely supports is about <strong class="num">${money(maxP)}</strong>.</p>` : ''}
    ${dalpAmt > 0 && c.dalp <= DALP_MAX && c.maxFirst > 0 && pct <= 200 ? `<h3 style="margin-top:1.25rem;font-size:var(--step-0)">If you sell in ${years} ${years === 1 ? 'year' : 'years'}</h3>
    <table class="small"><tbody>
      <tr><td>Sale price at ${growth}% a year</td><td class="r num">${money(resale)}</td></tr>
      <tr><td>City’s share of the gain (${(share * 100).toFixed(1).replace(/\.0$/, '')}%, set when you buy)</td><td class="r num">${money(cityShare)}</td></tr>
      <tr><td>Repay the City: loan plus share</td><td class="r num">${money(owed)}</td></tr>
      <tr><td>Pay off first mortgage</td><td class="r num">${money(firstBal)}</td></tr>
      <tr><td><strong>Left for you, before selling costs</strong></td><td class="r num"><strong>${money(yours)}</strong></td></tr>
    </tbody></table>` : ''}
    <p class="small muted" style="margin-top:1rem">Assumes a 30-year fixed loan, ${PROPERTY_TAX_RATE}% property tax and insurance of 0.2% of the price a year. MOHCD lends only what you need after the first mortgage you’re pre-approved for. This assumes the largest first mortgage within MOHCD’s limits (43% housing, 45% total debt), so it’s roughly the smallest DALP you’d get; your lender’s pre-approval sets the real split.</p>`;
}

/* ---------- Rentals ---------- */
// SFUSD-priority buildings. Status details here are from the buildings'
// own pages (Nov 2026); live status comes from DAHLIA when a listing is up.
const EDU_BUILDINGS = [
  {
    key: 'chisholm', name: 'Shirley Chisholm Village', where: '1360 43rd Ave, Outer Sunset',
    size: '135 apartments, studios to 3 bedrooms', who: 'SFUSD educators first, then other SFUSD employees',
    incomes: 'Roughly 30% to 120% of AMI, depending on the unit',
    last: 'The last waitlist opening was January 20 to February 3, 2026, for SFUSD employees only.',
    links: [['SFUSD employee housing page', 'https://www.sfusd.edu/employees/human-resources/affordable-housing/district-employee-housing'], ['Building site (MidPen Housing)', 'https://www.midpen-housing.org/?p=14537']],
  },
  {
    key: 'brightwell', name: 'Brightwell West', where: '750 Golden Gate Ave',
    size: '74 apartments', who: 'SFUSD and City College employees first; you’ll need your employee ID from your pay stub',
    incomes: 'Low- and moderate-income units',
    last: 'The first lottery took applications April 22 to May 13, 2026.',
    links: [['How the Brightwell West lottery works', 'https://www.sf.gov/learn-how-lottery-works-brightwell-west'], ['Building site (MidPen Housing)', 'https://www.midpen-housing.org/property/brightwell-west/']],
  },
];

function rentalOpen(l) {
  const d = toDate(l.dueDate);
  if (d && d > new Date()) return true;
  if (l.method === 'fcfs') return l.listingStatus === 'Active' && l.units.some((g) => g.available > 0);
  return false;
}
function rentalStage(l) {
  if (rentalOpen(l)) return { label: l.method === 'waitlist' ? `Waitlist open: apply by ${fmtDate(l.dueDate, true)}` : l.method === 'fcfs' ? 'First come, first served' : `Lottery: apply by ${fmtDate(l.dueDate, true)}`, tone: 'open' };
  if (l.listingStatus === 'Lease Up') return { label: `Closed ${l.dueDate ? fmtDate(l.dueDate) : ''}; leasing from the lottery list`, tone: 'closed' };
  return { label: l.dueDate ? `Closed ${fmtDate(l.dueDate)}; results pending` : 'Closed', tone: 'closed' };
}

function rentHH() {
  const h = hh();
  return { ...h, voucher: !!state.rent.voucher };
}
function groupFit(l, g, h) {
  if (!h.ready) return null;
  const reasons = []; let ok = true; let unsure = false;
  const minOcc = g.minOccupancy ?? 1;
  if (h.size < minOcc) { ok = false; reasons.push(`Needs at least ${minOcc} ${minOcc === 1 ? 'person' : 'people'}.`); }
  if (g.maxOccupancy && h.size > g.maxOccupancy) { ok = false; reasons.push(`Allows at most ${g.maxOccupancy} people.`); }
  const max = g.maxIncome && g.maxIncome[h.size - 1];
  if (max) {
    if (h.income > max) { ok = false; reasons.push(`Income over the ${money(max)} limit for ${h.size} at ${g.maxAmi}% AMI.`); }
    else reasons.push(`Under the ${money(max)} limit for ${h.size} at ${g.maxAmi}% AMI.`);
  } else { unsure = true; reasons.push('The income limit for this unit’s chart isn’t published here; check the listing.'); }
  if (g.rentPercentIncome) reasons.push(`Rent is ${g.rentPercentIncome}% of your income, so there’s no minimum income.`);
  else if (g.minIncomeMonthly) {
    const minYear = g.minIncomeMonthly * 12;
    if (h.voucher) reasons.push('Minimum income doesn’t apply with a Section 8 voucher.');
    else if (h.income < minYear) { ok = false; reasons.push(`Under the minimum income of ${money(g.minIncomeMonthly)} a month (${money(minYear)} a year), which is 2× the rent.`); }
    else reasons.push(`Meets the minimum income of ${money(g.minIncomeMonthly)} a month.`);
  }
  return { verdict: !ok ? 'unlikely' : unsure ? 'maybe' : 'likely', reasons };
}
function rentalFit(l, h) {
  const pool = l.units.some((g) => g.available > 0) ? l.units.filter((g) => g.available > 0) : l.units;
  const fits = pool.map((g) => ({ g, f: groupFit(l, g, h) })).filter((x) => x.f);
  if (!fits.length) return null;
  return fits.find((x) => x.f.verdict === 'likely') || fits.find((x) => x.f.verdict === 'maybe') || fits[0];
}

function eduCard(b) {
  const live = RENTALS ? RENTALS.listings.filter((l) => l.educator && l.educator.key === b.key) : [];
  const open = live.find(rentalOpen);
  const any = live[0];
  let status;
  if (open) status = `<span class="badge open">${esc(rentalStage(open).label)}</span>`;
  else if (any && any.listingStatus === 'Lease Up') status = `<span class="badge closed">Leasing from its lottery list</span>`;
  else status = '<span class="badge closed">Not taking applications right now</span>';
  return `<li class="agency-card${open ? ' hub' : ''}">
    <h3>${esc(b.name)}</h3>
    <p>${status}</p>
    <p>${esc(b.where)}. ${esc(b.size)}.</p>
    <p><strong>Who gets priority:</strong> ${esc(b.who)}.</p>
    <p><strong>Incomes:</strong> ${esc(b.incomes)}.</p>
    <p>${esc(b.last)}${any && any.waitlist && any.waitlist.max ? ` Its DAHLIA listing shows a waitlist of up to ${any.waitlist.max.toLocaleString()}.` : ''}</p>
    <div class="actions">
      ${open || any ? `<a class="button${open ? '' : ' quiet'}" href="${esc((open || any).url)}">${open ? 'Apply on DAHLIA' : 'DAHLIA listing'}</a>` : ''}
      ${b.links.map(([t, u]) => `<a class="button quiet" href="${u}">${esc(t)}</a>`).join('')}
    </div>
  </li>`;
}

function viewRentals() {
  const f = state.rentFilters; const s = state.hh;
  const all = RENTALS ? RENTALS.listings : [];
  const open = all.filter(rentalOpen);
  const leaseUp = all.filter((l) => !rentalOpen(l) && l.listingStatus === 'Lease Up').length;
  const hoods = [...new Set(all.map((l) => l.neighborhood).filter(Boolean))].sort();
  return `
  <div class="wrap">
    <section class="view-head prose">
      <h1>Affordable rentals</h1>
      <p class="lede">The City’s below market rate rentals are apartments with rents set by income limits. Unlike buying, there’s no class to take or loan to get, but you need to earn enough as well as not too much.</p>
    </section>

    <section aria-labelledby="edu-h">
      <h2 id="edu-h">Housing for SFUSD staff</h2>
      <p class="prose muted">Two affordable buildings put SFUSD employees at the front of the line. Openings are short and announced on DAHLIA, so <a href="${LINKS.alerts}">sign up for MOHCD’s alerts</a> and watch SFUSD staff announcements.</p>
      <ul class="agency-cards" style="grid-template-columns:repeat(auto-fit,minmax(320px,1fr))">${EDU_BUILDINGS.map(eduCard).join('')}</ul>
      <p class="small muted" style="margin-top:1rem">SFUSD has also set aside sites at 1620 7th Ave and 95 Gough St for future employee housing. <a href="https://www.sfusd.edu/employees/human-resources/affordable-housing/district-employee-housing">SFUSD’s housing page</a> has the latest.</p>
    </section>

    <section class="section">
      <h2>Renting vs. buying</h2>
      <div class="table-scroll"><table>
        <thead><tr><th></th><th>BMR rental</th><th>BMR home to buy</th></tr></thead>
        <tbody>
          <tr><td>Income</td><td>A <strong>minimum</strong> (usually 2× the rent) and a maximum</td><td>A maximum only</td></tr>
          <tr><td>Typical income caps</td><td>About 25% to 150% of AMI, mostly 50% to 80%</td><td>About 80% to 140% of AMI</td></tr>
          <tr><td>Household size</td><td>A minimum and a maximum for each unit</td><td>At least one person per bedroom</td></tr>
          <tr><td>Before you apply</td><td>Nothing required</td><td>10 hours of classes and a lender pre-approval</td></tr>
          <tr><td>Past home ownership</td><td>Doesn’t matter</td><td>No ownership in the last 3 years</td></tr>
          <tr><td>Screening</td><td>Credit, rental history and background, set by each building</td><td>Lender’s credit review</td></tr>
          <tr><td>After you move in</td><td>Re-qualify every year; you can stay as income rises, up to a limit (often 200% of AMI)</td><td>Yours to keep; resale price is restricted</td></tr>
          <tr><td>How you apply</td><td colspan="2">On DAHLIA: by lottery, waitlist, or first come, first served. Lottery preferences such as Live or Work in San Francisco apply to both.</td></tr>
        </tbody></table></div>
    </section>

    <section class="section">
      <h2>Rentals on DAHLIA</h2>
      <p class="prose muted">${all.length} rental listings are on DAHLIA right now, but only ${open.length} are taking applications. ${leaseUp} have already held their lottery and are leasing apartments to people from the ranked list, which can take months, so they stay posted.</p>
      <form class="household-bar" autocomplete="off" onsubmit="return false" aria-label="Your household">
        <div class="field"><label for="r-size">People in household</label><select id="r-size" data-hh="size">${sizeOptions(s.size)}</select></div>
        <div class="field"><label for="r-income">Yearly household income</label><div class="money"><input id="r-income" data-hh="income" inputmode="decimal" type="text" value="${esc(s.income)}" placeholder="70,000"></div></div>
        <div class="field"><label class="choices" style="margin:0"><span style="display:inline-flex;gap:.45rem;align-items:center;font-weight:700"><input type="checkbox" data-rent="voucher"${state.rent.voucher ? ' checked' : ''}> I have a Section 8 voucher</span></label></div>
        <div class="field"><label class="choices" style="margin:0"><span style="display:inline-flex;gap:.45rem;align-items:center;font-weight:700"><input type="checkbox" data-rfilter="fitOnly"${f.fitOnly ? ' checked' : ''}> Only ones I likely qualify for</span></label></div>
      </form>
      <form class="toolbar" autocomplete="off" onsubmit="return false" aria-label="Filter rentals">
        <div class="field"><label for="rf-show">Show</label><select id="rf-show" data-rfilter="show">
          <option value="open"${f.show === 'open' ? ' selected' : ''}>Taking applications</option>
          <option value="all"${f.show === 'all' ? ' selected' : ''}>Everything on DAHLIA</option></select></div>
        <div class="field"><label for="rf-method">How to apply</label><select id="rf-method" data-rfilter="method">
          <option value="any">Any</option>
          <option value="lottery"${f.method === 'lottery' ? ' selected' : ''}>Lottery</option>
          <option value="waitlist"${f.method === 'waitlist' ? ' selected' : ''}>Waitlist</option></select></div>
        <div class="field"><label for="rf-beds">Bedrooms</label><select id="rf-beds" data-rfilter="beds">
          ${['any', '0', '1', '2', '3'].map((x) => `<option value="${x}"${f.beds === x ? ' selected' : ''}>${x === 'any' ? 'Any' : x === '0' ? 'Studio' : x === '3' ? '3+' : x}</option>`).join('')}</select></div>
        <div class="field"><label for="rf-max">Max rent</label><div class="money"><input id="rf-max" data-rfilter="maxRent" inputmode="decimal" type="text" value="${esc(f.maxRent)}" placeholder="Any"></div></div>
        <div class="field"><label for="rf-hood">Neighborhood</label><select id="rf-hood" data-rfilter="hood"><option value="any">Any</option>${hoods.map((x) => `<option${f.hood === x ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
        <div class="field"><label for="rf-edu" style="display:flex;gap:.45rem;align-items:center;margin-top:1.6rem"><input id="rf-edu" type="checkbox" data-rfilter="eduOnly"${f.eduOnly ? ' checked' : ''}> SFUSD priority only</label></div>
      </form>
      <div id="rentals-list" aria-live="polite">${rentalsList()}</div>
    </section>

    <section class="section split">
      <div class="prose">
        <h2>How it works</h2>
        <ul>
          <li><strong>Rent is set by formula:</strong> 30% of the income limit for the unit, so it stays below market. It goes up a little each year with the AMI.</li>
          <li><strong>Minimum income:</strong> usually 2× the monthly rent. People with Section 8 vouchers are exempt; some 100% affordable buildings set rent at 30% of your actual income instead.</li>
          <li><strong>Lottery preferences:</strong> applicants with a Certificate of Preference, a Displaced Tenant certificate, or who live in the neighborhood are ranked first, then those who live or work in San Francisco. Most SFUSD staff qualify for Live or Work.</li>
          <li><strong>After the lottery:</strong> the leasing office contacts people in rank order, checks income and documents, and runs its screening.</li>
          <li><strong>Every year:</strong> you re-certify your income. Your income can grow while you live there, up to the program limit.</li>
        </ul>
      </div>
      <div class="prose">
        <h2>Before you apply</h2>
        <ul>
          <li>Apply to each listing separately on DAHLIA. Applying is free; a few buildings charge a screening fee after you’re selected.</li>
          <li>Read each building’s resident selection criteria. Credit, eviction and rental history rules differ by building.</li>
          <li>Have recent pay stubs, tax returns and bank statements ready for everyone 18 or older.</li>
          <li>Free help is available from <a href="https://housing.sfgov.org/housing-counselors">rental housing counselors</a>.</li>
        </ul>
        ${DISCLAIMER}
      </div>
    </section>
  </div>`;
}

function filteredRentals() {
  const f = state.rentFilters; const h = rentHH();
  const maxRent = parseMoney(f.maxRent);
  let list = (RENTALS ? RENTALS.listings : []).map((l) => ({ l, open: rentalOpen(l), fit: rentalFit(l, h) }));
  list = list.filter(({ l, open, fit }) => {
    if (f.show === 'open' && !open) return false;
    if (f.method !== 'any' && l.method !== f.method) return false;
    if (f.hood !== 'any' && l.neighborhood !== f.hood) return false;
    if (f.eduOnly && !l.educator) return false;
    const groups = l.units.some((g) => g.available > 0) ? l.units.filter((g) => g.available > 0) : l.units;
    if (f.beds !== 'any') { const b = Number(f.beds); if (!groups.some((g) => (b === 3 ? bedsOf(g.type) >= 3 : bedsOf(g.type) === b))) return false; }
    if (maxRent && !groups.some((g) => (g.rent && g.rent <= maxRent) || g.rentPercentIncome)) return false;
    if (f.fitOnly && h.ready && !(fit && fit.f.verdict !== 'unlikely')) return false;
    return true;
  });
  list.sort((a, b) => {
    const ra = a.open ? 0 : 1, rb = b.open ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.l.educator && !b.l.educator) return -1;
    if (b.l.educator && !a.l.educator) return 1;
    return (toDate(b.l.dueDate) || 0) - (toDate(a.l.dueDate) || 0);
  });
  if (list.length && list.every((x) => x.open)) list.sort((a, b) => (toDate(a.l.dueDate) || Infinity) - (toDate(b.l.dueDate) || Infinity));
  return list;
}

function rentalsList() {
  const h = rentHH();
  const list = filteredRentals();
  if (!list.length) return `<p class="count-line">No rentals match these filters.</p><div class="empty-state"><p>Try “Everything on DAHLIA” or fewer filters. New rentals post every week or two. <a href="${LINKS.alerts}">Get MOHCD’s email alerts</a>.</p></div>`;
  const nFit = h.ready ? list.filter((x) => x.fit && x.fit.f.verdict === 'likely').length : null;
  return `<p class="count-line">${list.length} ${list.length === 1 ? 'listing' : 'listings'}${h.ready ? `, ${nFit} likely a fit for your household` : '. Add your household above to see which fit'}.</p>
  <ul class="listings">${list.map(rentalRow).join('')}</ul>`;
}

function rentalRow({ l, open, fit }) {
  const h = rentHH();
  const groups = l.units.some((g) => g.available > 0) ? l.units.filter((g) => g.available > 0) : l.units;
  const rents = groups.map((g) => g.rent).filter(Boolean);
  const pctRent = groups.some((g) => g.rentPercentIncome);
  const caps = [...new Set(groups.map((g) => g.maxAmi).filter(Boolean))].sort((a, b) => a - b);
  const types = [...new Set(groups.map((g) => typeLabel(g.type)))];
  const availUnits = l.units.reduce((a, g) => a + g.available, 0);
  const stage = rentalStage(l);
  const rentTxt = rents.length ? (Math.min(...rents) === Math.max(...rents) ? money(rents[0]) : `${money(Math.min(...rents))}–${money(Math.max(...rents))}`) : pctRent ? '30% of income' : 'See listing';
  let incomeLine = '';
  if (h.ready) {
    const mins = groups.map((g) => (g.rentPercentIncome || h.voucher ? 0 : (g.minIncomeMonthly || 0) * 12));
    const maxs = groups.map((g) => g.maxIncome && g.maxIncome[h.size - 1]).filter(Boolean);
    if (maxs.length) incomeLine = `Income for ${h.size}: ${money(Math.min(...mins))} to ${money(Math.max(...maxs))} a year`;
  }
  const img = l.image ? `<img class="thumb" src="${esc(l.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb empty',innerHTML:window.__houseIcon}))">` : `<div class="thumb empty">${houseIcon}</div>`;
  return `<li class="listing"><details data-listing="${esc(l.id)}">
    <summary>
      ${img}
      <div>
        <p class="l-title">${esc(l.name)}</p>
        <p class="l-meta">${esc([l.neighborhood, types.join(', '), l.reservedFor.length ? l.reservedFor.map((r) => (/housing/i.test(r) ? r : `${r} housing`)).join(', ') : '', l.tenure].filter(Boolean).join(', '))}</p>
        <div class="l-tags"><span class="badge ${stage.tone}">${esc(stage.label)}</span>${l.educator ? ' <span class="badge open">SFUSD priority</span>' : ''} ${caps.length ? `<span class="badge">Income cap ${caps.join('/')}% AMI</span>` : ''} ${fit ? verdictChip(fit.f.verdict) : ''}</div>
      </div>
      <div class="l-side">
        <div class="l-price num">${rentTxt}</div>
        <p class="l-price-note">a month${open && availUnits ? `<br>${availUnits} ${availUnits === 1 ? 'unit' : 'units'} available` : ''}${incomeLine ? `<br>${incomeLine}` : ''}</p>
        <span class="l-more"><span class="when-closed">Details</span><span class="when-open">Hide details</span></span>
      </div>
    </summary>
    <div class="l-body">${rentalBody(l, fit)}</div>
  </details></li>`;
}

function rentalBody(l, fit) {
  const h = rentHH();
  const rows = l.units.map((g) => {
    const gf = groupFit(l, g, h);
    const max = g.maxIncome && h.size ? g.maxIncome[h.size - 1] : null;
    return `<tr>
      <td>${esc(typeLabel(g.type))}</td>
      <td class="r">${g.rentPercentIncome ? `${g.rentPercentIncome}% of income` : money(g.rent)}</td>
      <td class="r">${g.rentPercentIncome ? 'None' : g.minIncomeMonthly ? `${money(g.minIncomeMonthly)}/mo` : ''}</td>
      <td>${g.maxAmi ? `${g.maxAmi}% AMI${max ? `<br><span class="small muted">${money(max)} for ${h.size}</span>` : ''}` : ''}</td>
      <td class="r">${g.minOccupancy ?? ''}${g.maxOccupancy ? `–${g.maxOccupancy}` : ''}</td>
      <td class="r">${g.available}${g.count > g.available ? ` of ${g.count}` : ''}</td>
      ${h.ready ? `<td>${gf ? verdictChip(gf.verdict) : ''}</td>` : ''}
    </tr>`;
  }).join('');
  const how = l.method === 'waitlist' ? 'Joining the waitlist: applications are ranked by lottery, and you’re offered a unit when your number comes up.' : l.method === 'fcfs' ? 'First come, first served.' : `Lottery${l.lotteryDate ? ` on ${fmtDate(l.lotteryDate, true)}` : ''}${l.lotteryResultsDate ? `; results ${fmtDate(l.lotteryResultsDate)}` : ''}.`;
  const prefNames = [...new Set(l.prefs.map((p) => p.name))];
  return `
    ${fit ? `<div><h4>Your fit for the best-matching unit ${verdictChip(fit.f.verdict)}</h4><ul class="reasons">${fit.f.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
    <div><h4>How to apply</h4><p>${l.dueDate ? `Applications ${rentalOpen(l) ? 'due' : 'closed'} ${fmtDate(l.dueDate, true)}. ` : ''}${esc(how)}</p>${l.waitlist && l.waitlist.has && l.waitlist.max ? `<p class="small muted">Waitlist: ${l.waitlist.current ?? 0} of up to ${l.waitlist.max.toLocaleString()} spots filled.</p>` : ''}</div>
    <div class="table-scroll"><h4>Apartments</h4><table class="small"><thead><tr><th>Type</th><th class="r">Rent</th><th class="r">Min. income</th><th>Max. income</th><th class="r">People</th><th class="r">Available</th>${h.ready ? '<th>You</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    ${l.educator ? `<div class="callout"><p><strong>SFUSD priority.</strong> ${l.prefs.some((p) => /tier 1/i.test(p.name)) ? 'The “Tier 1” preferences on this listing are for school district employees, who are ranked ahead of everyone else.' : 'School district employees are ranked ahead of other applicants.'}</p></div>` : ''}
    ${prefNames.length ? `<div><h4>Lottery preferences</h4><ul>${prefNames.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    ${l.accessible.length ? `<div><h4>Accessible units</h4><p>${l.accessible.map((a) => `${a.units} for ${esc(a.name.toLowerCase())}`).join(', ')}</p></div>` : ''}
    ${l.credit || l.eviction ? `<div><h4>Screening</h4>${l.credit ? `<p style="white-space:pre-line">${esc(l.credit)}</p>` : ''}${l.eviction ? `<p style="white-space:pre-line">${esc(l.eviction)}</p>` : ''}</div>` : ''}
    ${l.depositMin || l.fee ? `<div><h4>Costs</h4><p>${l.depositMin ? `Deposit ${money(l.depositMin)}${l.depositMax && l.depositMax !== l.depositMin ? `–${money(l.depositMax)}` : ''}. ` : ''}${l.fee ? `Application fee ${money(l.fee)}.` : ''}</p>${l.utilities ? `<p class="small muted">${esc(l.utilities)}</p>` : ''}</div>` : ''}
    <div class="l-links"><a class="button" href="${esc(l.url)}">${rentalOpen(l) ? 'Apply on DAHLIA' : 'See the listing on DAHLIA'}</a>${l.criteriaUrl ? `<a class="button quiet" href="${esc(l.criteriaUrl)}">Resident selection criteria</a>` : ''}</div>`;
}

/* ================================================================
   ROUTER + EVENTS
================================================================ */
const ROUTES = { '': viewHome, check: viewCheck, homes: viewHomes, programs: viewPrograms, dalp: viewDalp, rentals: viewRentals, recent: viewRecent, verify: viewVerify, privacy: viewPrivacy };
function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const fn = ROUTES[path] || viewHome;
  view.innerHTML = fn(new URLSearchParams(query || ''));
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = (a.dataset.nav === 'home' && !ROUTES[path]) || (a.dataset.nav === 'home' && path === '') || a.dataset.nav === path;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const titles = { check: 'Check eligibility', homes: 'Homes for sale', programs: 'Find programs', dalp: 'Down payment loans (DALP)', rentals: 'Affordable rentals', recent: 'Recent and upcoming', verify: 'Get it confirmed', privacy: 'Privacy' };
  document.title = `${titles[path] ? `${titles[path]} | ` : ''}BMR Homes for SFUSD Staff`;
  countPage(`/${path}`);
}

function refreshPartial() {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const swap = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  if (path === 'check') { swap('check-result', checkResult()); swap('check-chart', checkChart()); swap('ami-table', amiTable()); swap('cost-result', costResult()); }
  if (path === 'homes') { swap('homes-list', homesList()); swap('city-second', citySecondBlock()); }
  if (path === 'programs') swap('prog-result', programsResult());
  if (path === 'dalp') swap('dalp-result', dalpResult());
  if (path === 'rentals') swap('rentals-list', rentalsList());
}
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.hh) {
    state.hh[t.dataset.hh] = t.value;
    // mirror into any other copy of the same field on screen
    document.querySelectorAll(`[data-hh="${t.dataset.hh}"]`).forEach((el) => { if (el !== t) el.value = t.value; });
    if (t.dataset.hh === 'size' || t.dataset.hh === 'income' || t.dataset.hh === 'assets' || t.dataset.hh === 'downPayment' || t.dataset.hh === 'owned') refreshPartial();
  } else if (t.dataset.filter) {
    state.filters[t.dataset.filter] = t.type === 'checkbox' ? t.checked : t.value;
    const el = document.getElementById('homes-list'); if (el) el.innerHTML = homesList();
  } else if (t.dataset.rent) {
    state.rent[t.dataset.rent] = t.type === 'checkbox' ? t.checked : t.value;
    const el = document.getElementById('rentals-list'); if (el) el.innerHTML = rentalsList();
  } else if (t.dataset.rfilter) {
    state.rentFilters[t.dataset.rfilter] = t.type === 'checkbox' ? t.checked : t.value;
    const el = document.getElementById('rentals-list'); if (el) el.innerHTML = rentalsList();
  } else if (t.dataset.dalp) {
    state.dalp[t.dataset.dalp] = t.value;
    const el = document.getElementById('dalp-result'); if (el) el.innerHTML = dalpResult();
  } else if (t.dataset.cost) {
    state.cost[t.dataset.cost] = t.value;
    const el = document.getElementById('cost-result'); if (el) el.innerHTML = costResult();
  } else if (t.dataset.prog) {
    state.prog[t.dataset.prog] = t.value;
    if (t.dataset.prog === 'sfusd' || t.dataset.prog === 'tenure') {
      // show or hide the role question
      const keep = document.activeElement && document.activeElement.value;
      view.innerHTML = viewPrograms();
      const el = view.querySelector(`input[name="${t.dataset.prog}"][value="${keep}"]`); if (el) el.focus();
    } else refreshPartial();
  }
});
document.addEventListener('change', (e) => {
  // selects and radios fire change; route them through the same handler
  if (e.target.matches('select, input[type="radio"], input[type="checkbox"]')) e.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details[data-listing]') && e.target.open) count(location.hash.startsWith('#/rentals') ? 'opened-rental' : 'opened-listing');
}, true);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-open]');
  if (a) {
    e.preventDefault();
    state.filters = { ...state.filters, q: '', show: 'all', method: 'any', beds: 'any', maxPrice: '', hood: 'any', fitOnly: false };
    location.hash = '#/homes';
    setTimeout(() => { const d = document.querySelector(`details[data-listing="${CSS.escape(a.dataset.open)}"]`); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } }, 30);
  }
});
window.addEventListener('hashchange', () => { route(); document.getElementById('main').focus({ preventScroll: true }); window.scrollTo(0, 0); });

/* ---------------- boot ---------------- */
async function boot() {
  if (GOATCOUNTER_CODE) {
    const s = document.createElement('script');
    s.async = true; s.src = 'https://gc.zgo.at/count.js';
    s.dataset.goatcounter = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;
    s.dataset.goatcounterSettings = JSON.stringify({ no_onload: true });
    s.onload = () => countPage(location.hash.replace(/^#/, '').split('?')[0] || '/');
    document.head.appendChild(s);
  }
  try {
    const [ami, data, hist, checked, balances, rentals] = await Promise.all([
      fetch('data/ami.json').then((r) => r.json()),
      fetch('data/listings.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/history.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ listings: {} })),
      fetch('data/checked.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
      fetch('data/dalp-balances.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
      fetch('data/rentals.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
    ]);
    AMI = ami; DATA = data; HISTORY = hist; CHECKED = checked; BALANCES = balances; RENTALS = rentals;
  } catch (e) {
    view.innerHTML = `<div class="wrap"><p class="notice">The listing data didn’t load. Check your connection and reload the page. You can always browse homes directly on <a href="${LINKS.dahlia}">DAHLIA</a>.</p></div>`;
    return;
  }
  const stamp = document.getElementById('data-stamp');
  const stale = CHECKED && CHECKED.date && daysFromNow(CHECKED.date) < -2;
  stamp.innerHTML = `Listings last changed ${fmtDate(DATA.updated, true)}. ${CHECKED ? `Checked automatically every few hours; last check ${fmtDate(CHECKED.date)}.` : ''}${stale ? ' <strong>The automatic check may be stuck, so confirm details on DAHLIA.</strong>' : ''}`;
  route();
}
boot();
