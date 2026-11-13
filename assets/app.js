import { GOATCOUNTER_CODE, DEFAULT_RATE, RATE_SOURCE, PROPERTY_TAX_RATE, INSURANCE_MONTHLY } from './config.js';
import { LINKS, ROLES, matchPrograms } from './programs.js';

/* ------------------------------------------------------------------
   Everything typed into this page lives only in the `state` object
   below, in this browser tab's memory. It is never saved to storage,
   never put in the URL, and never sent anywhere.
------------------------------------------------------------------- */
const state = {
  hh: { size: '', income: '', assets: '', downPayment: '', owned: 'no' },
  prog: { sfusd: '', role: '', owned: '', firstGen: '' },
  filters: { q: '', show: 'open', method: 'any', beds: 'any', maxPrice: '', hood: 'any', sort: 'deadline', fitOnly: false },
  cost: { price: '', hoa: '', down: '', rate: String(DEFAULT_RATE) },
  counted: {},
};

let AMI = null;
let DATA = null;
let HISTORY = null;
let CHECKED = null;
const view = document.getElementById('view');

/* ---------------- small helpers ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money = (n) => (n === null || n === undefined || isNaN(n) ? '—' : usd.format(Math.round(n)));
const kmoney = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}k`);
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
  return { size, income, assets: parseMoney(state.hh.assets), down: parseMoney(state.hh.downPayment), owned: state.hh.owned, ready: !!(size && income) };
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
    const add = l.waivers && l.waivers.assetsExcluded ? 0 : assetAdd(h.assets, h.down, u.price);
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
      <h1 class="hero-q">Can you buy a home in San Francisco on an educator’s salary?</h1>
      <p class="lede">Through the City’s Below Market Rate (BMR) program, some condos sell for a fraction of market price to households under set income limits. A lot of SFUSD households land right in that range.</p>
      <p style="display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.5rem">
        <a class="button" href="#/check">Check my eligibility</a>
        <a class="button quiet" href="#/homes">Browse homes for sale</a>
      </p>
    </section>

    <section class="facts" aria-label="Right now">
      <div><p class="figure num">${open.length}</p><p>BMR homes taking applications right now${lotteries ? `, ${lotteries} of them by lottery` : ''}.</p></div>
      <div><p class="figure num">${prices.length ? `${kmoney(Math.min(...prices))}–${kmoney(Math.max(...prices))}` : '—'}</p><p>Price range of those homes, before parking.</p></div>
      <div><p class="figure num">${teacherPct}%</p><p>Where a single teacher earning $95,000 sits on the 2026 income scale. Most listings allow 100–120%.</p></div>
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
      <p>SFUSD staff can also get down payment help, like Teacher Next Door’s $20,000 forgivable loan for BMR homes. <a href="#/programs">See which programs fit you</a>.</p>
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
          <span class="hint">Used for the monthly cost estimate. The BMR minimum is 1% of the price, and it can be a gift.</span>
          <div class="money"><input id="hh-down" data-hh="downPayment" inputmode="decimal" type="text" value="${esc(s.downPayment)}" placeholder="20,000"></div>
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

function costEstimator() {
  const h = hh();
  const open = openListings();
  const avail = open.flatMap((l) => l.units.filter(isAvailable));
  const defPrice = Math.round((median(avail.map((u) => u.price)) || 400000) / 1000) * 1000;
  const defHoa = Math.round(median(avail.map((u) => u.hoa)) || 600);
  const c = state.cost;
  const price = parseMoney(c.price) ?? defPrice;
  const hoa = parseMoney(c.hoa) ?? defHoa;
  const down = parseMoney(c.down) ?? (h.down ?? Math.round(price * 0.05));
  const rate = Number(c.rate) || DEFAULT_RATE;
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
  return `<h2>What would it cost each month?</h2>
  <p class="muted prose">A rough estimate for a 30-year fixed loan, which is what BMR purchases require. Defaults use the middle price and HOA of the homes open now.</p>
  <div class="split">
    <form class="form" id="cost-form" autocomplete="off" onsubmit="return false">
      <div class="field"><label for="c-price">Home price</label><div class="money"><input id="c-price" data-cost="price" inputmode="decimal" type="text" value="${esc(c.price)}" placeholder="${defPrice.toLocaleString()}"></div></div>
      <div class="field"><label for="c-hoa">Monthly HOA dues</label><div class="money"><input id="c-hoa" data-cost="hoa" inputmode="decimal" type="text" value="${esc(c.hoa)}" placeholder="${defHoa}"></div></div>
      <div class="field"><label for="c-down">Down payment</label><div class="money"><input id="c-down" data-cost="down" inputmode="decimal" type="text" value="${esc(c.down)}" placeholder="${down.toLocaleString()}"></div></div>
      <div class="field"><label for="c-rate">Interest rate (%)</label><span class="hint">Default is the ${esc(RATE_SOURCE)}. Your lender’s rate will differ.</span><input id="c-rate" data-cost="rate" inputmode="decimal" type="text" value="${esc(c.rate)}" style="max-width:8rem"></div>
    </form>
    <div class="panel" aria-live="polite">
      <p class="small muted" style="margin:0 0 .3rem">Estimated monthly cost</p>
      <p class="result-figure num">${money(m.total)}</p>
      <table class="small"><tbody>
        <tr><td>Mortgage (principal and interest)</td><td class="r num">${money(m.pi)}</td></tr>
        <tr><td>Property tax (about ${PROPERTY_TAX_RATE}%)</td><td class="r num">${money(m.tax)}</td></tr>
        <tr><td>Homeowner’s insurance (estimate)</td><td class="r num">${money(m.ins)}</td></tr>
        <tr><td>HOA dues</td><td class="r num">${money(m.hoa)}</td></tr>
      </tbody></table>
      <div style="margin-top:1rem">${ratioLine}${maxLine}</div>
    </div>
  </div>`;
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
  const down = h.down;
  const mc = prices.length ? monthlyCost(minP, hoas.length ? Math.min(...hoas) : 0, down ?? minP * 0.05, Number(state.cost.rate) || DEFAULT_RATE) : null;
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
      <p class="lede">Answer a few questions to see which City and state programs you might qualify for, including the ones only for SFUSD staff.</p>
    </section>
    <div class="split">
      <form class="form" id="prog-form" autocomplete="off" onsubmit="return false">
        <fieldset class="field"><legend>Do you work for SFUSD?</legend>
          ${radio('sfusd', [['full', 'Yes, full time'], ['part30', 'Part time, and SFUSD is at least 30% of my income'], ['partUnder', 'Part time, under 30%'], ['no', 'No']])}
        </fieldset>
        ${p.sfusd && p.sfusd !== 'no' ? `<div class="field"><label for="p-role">What’s your role?</label><select id="p-role" data-prog="role"><option value="">Choose…</option>${ROLES.map((r) => `<option value="${r.id}"${p.role === r.id ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>` : ''}
        <div class="field"><label for="p-size">How many people will live in the home?</label><select id="p-size" data-hh="size">${sizeOptions(s.size)}</select></div>
        <div class="field"><label for="p-income">Total yearly household income, before taxes</label><div class="money"><input id="p-income" data-hh="income" inputmode="decimal" type="text" value="${esc(s.income)}" placeholder="95,000"></div></div>
        <fieldset class="field"><legend>Has anyone in the household owned a home in the last 3 years?</legend>
          ${radio('owned', [['no', 'No'], ['outsideSF', 'Yes, but only outside San Francisco'], ['inSF', 'Yes, in San Francisco']])}
        </fieldset>
        <div class="field"><label for="p-sav">Savings and investments (optional)</label><div class="money"><input id="p-sav" data-hh="assets" inputmode="decimal" type="text" value="${esc(s.assets)}" placeholder="0"></div></div>
        <fieldset class="field"><legend>Did your parents ever own a home?</legend><span class="hint">Only used for CalHFA’s first-generation program.</span>
          ${radio('firstGen', [['no', 'Yes, they did'], ['yes', 'No, never'], ['unsure', 'Not sure']])}
        </fieldset>
        <p class="small muted">Nothing you type here is saved or sent anywhere.</p>
      </form>
      <div id="prog-result" aria-live="polite">${programsResult()}</div>
    </div>
  </div>`;
}

function programsResult() {
  const p = state.prog; const h = hh();
  const missing = [];
  if (!p.sfusd) missing.push('whether you work for SFUSD');
  if (p.sfusd && p.sfusd !== 'no' && !p.role) missing.push('your role');
  if (!h.size) missing.push('household size');
  if (!h.income) missing.push('income');
  if (!p.owned) missing.push('past home ownership');
  if (missing.length) return `<div class="panel"><h2 style="font-size:var(--step-2)">Your programs</h2><p class="muted">Still needed: ${missing.join(', ')}.</p></div>`;
  count('used-programs');
  const caps = openListings().flatMap((l) => l.units.filter(isAvailable).map((u) => u.maxAmi)).filter(Boolean);
  const res = matchPrograms({
    sfusd: p.sfusd, role: p.role, size: h.size, income: h.income, amiPct: amiPctOf(h.income, h.size),
    owned: p.owned, firstGen: p.firstGen || 'unsure', savings: h.assets, bmrMaxCap: caps.length ? Math.max(...caps) : 120,
  });
  const order = { likely: 0, maybe: 1, unlikely: 2 };
  res.sort((a, b) => order[a.verdict] - order[b.verdict]);
  // keep the household's first-time answer in sync for the listings page
  state.hh.owned = p.owned === 'no' ? 'no' : p.owned === 'inSF' ? 'yes' : 'yes';
  return `<p class="small muted" style="margin-top:0">At about ${Math.round(amiPctOf(h.income, h.size))}% of AMI for a household of ${h.size}:</p>
  <ul class="programs">${res.map((r) => `<li class="program${r.verdict === 'unlikely' ? ' dim' : ''}">
      <div>${verdictChip(r.verdict)}</div>
      <div>
        <h3>${esc(r.name)}</h3>
        <p class="who">${esc(r.who)}. <span class="badge ${r.status.tone}">${esc(r.status.label)}</span></p>
        <p>${esc(r.what)}</p>
        <ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <p style="margin:.6rem 0 0"><a href="${esc(r.link)}">${esc(r.linkText)}</a></p>
      </div></li>`).join('')}</ul>
  ${DISCLAIMER}`;
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
      <ul class="agencies">
        <li><h3>HomeownershipSF</h3><p>The hub for orientations and workshop sign-ups.</p><p>275 5th St, Suite 314, San Francisco, CA 94103</p><p>(415) 202-5464</p><p><a href="https://www.homeownershipsf.org/homebuyers/">homeownershipsf.org</a></p></li>
        <li><h3>Asian, Inc.</h3><p>1167 Mission St, 4th Floor, San Francisco, CA 94103</p><p>(415) 928-5910</p><p>English, Cantonese, Mandarin</p><p><a href="https://www.asianinc.org/housing/">asianinc.org</a></p></li>
        <li><h3>BALANCE</h3><p>3543 18th St, San Francisco, CA 94110</p><p>(800) 777-7526</p><p>English, Spanish, Tagalog, Russian</p><p><a href="https://www.balancepro.org/housing-workshops">balancepro.org</a></p></li>
        <li><h3>Mission Economic Development Agency (MEDA)</h3><p>2301 Mission St, Suite 301, San Francisco, CA 94110</p><p>(415) 282-3334 ext. 115</p><p>English, Spanish</p><p><a href="https://medasf.org/programs/housing-opportunities/">medasf.org</a></p></li>
        <li><h3>San Francisco LGBT Community Center</h3><p>1800 Market St, San Francisco, CA 94102</p><p>(415) 865-5555</p><p><a href="https://www.sfcenter.org/program/housing-financial/">sfcenter.org</a></p></li>
        <li><h3>San Francisco Housing Development Corporation</h3><p>A HomeownershipSF member agency.</p><p><a href="https://www.sfhdc.org/">sfhdc.org</a></p></li>
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

/* ================================================================
   ROUTER + EVENTS
================================================================ */
const ROUTES = { '': viewHome, check: viewCheck, homes: viewHomes, programs: viewPrograms, recent: viewRecent, verify: viewVerify, privacy: viewPrivacy };
function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const fn = ROUTES[path] || viewHome;
  view.innerHTML = fn(new URLSearchParams(query || ''));
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = (a.dataset.nav === 'home' && !ROUTES[path]) || (a.dataset.nav === 'home' && path === '') || a.dataset.nav === path;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const titles = { check: 'Check eligibility', homes: 'Homes for sale', programs: 'Find programs', recent: 'Recent and upcoming', verify: 'Get it confirmed', privacy: 'Privacy' };
  document.title = `${titles[path] ? `${titles[path]} | ` : ''}BMR Homes for SFUSD Staff`;
  countPage(`/${path}`);
}

function refreshPartial() {
  const path = location.hash.replace(/^#\/?/, '').split('?')[0];
  const swap = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
  if (path === 'check') { swap('check-result', checkResult()); swap('check-chart', checkChart()); swap('ami-table', amiTable()); swap('cost', costEstimatorPreservingFocus()); }
  if (path === 'homes') { swap('homes-list', homesList()); swap('city-second', citySecondBlock()); }
  if (path === 'programs') swap('prog-result', programsResult());
}
// The cost form is re-rendered as a whole; keep the cursor where it was.
function costEstimatorPreservingFocus() {
  const active = document.activeElement;
  const id = active && active.id; const pos = active && active.selectionStart;
  const html = costEstimator();
  if (id && id.startsWith('c-')) setTimeout(() => { const el = document.getElementById(id); if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch { /* not a text field */ } } });
  return html;
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
  } else if (t.dataset.cost) {
    state.cost[t.dataset.cost] = t.value;
    const el = document.getElementById('cost'); if (el) el.innerHTML = costEstimatorPreservingFocus();
  } else if (t.dataset.prog) {
    state.prog[t.dataset.prog] = t.value;
    if (t.dataset.prog === 'sfusd') {
      // show or hide the role question
      const keep = document.activeElement && document.activeElement.value;
      view.innerHTML = viewPrograms();
      const el = view.querySelector(`input[name="sfusd"][value="${keep}"]`); if (el) el.focus();
    } else refreshPartial();
  }
});
document.addEventListener('change', (e) => {
  // selects and radios fire change; route them through the same handler
  if (e.target.matches('select, input[type="radio"], input[type="checkbox"]')) e.target.dispatchEvent(new Event('input', { bubbles: true }));
});
document.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details[data-listing]') && e.target.open) count('opened-listing');
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
    const [ami, data, hist, checked] = await Promise.all([
      fetch('data/ami.json').then((r) => r.json()),
      fetch('data/listings.json', { cache: 'no-cache' }).then((r) => r.json()),
      fetch('data/history.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({ listings: {} })),
      fetch('data/checked.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => null),
    ]);
    AMI = ami; DATA = data; HISTORY = hist; CHECKED = checked;
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
