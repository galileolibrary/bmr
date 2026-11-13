// Parses the sf.gov "City Second Program current listings" page.
// That page is plain prose, not data, so this is deliberately forgiving:
// if the wording changes, it returns whatever it can and the site falls back
// to linking to the page.

export const CITY_SECOND_URL = 'https://www.sf.gov/reports--december-2024--city-second-program-current-listings';

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

export function extractLinks(html) {
  const out = {};
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = m[2].replace(/<[^>]+>/g, '').trim();
    if (text) out[text.toLowerCase()] = m[1].startsWith('http') ? m[1] : `https://www.sf.gov${m[1]}`;
  }
  return out;
}

const money = (s) => (s ? Number(String(s).replace(/[^\d.]/g, '')) || null : null);

export function parseCitySecond(text, links = {}) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const startIdx = lines.findIndex((l) => /^accepting applications$/i.test(l));
  const closedIdx = lines.findIndex((l, i) => i > startIdx && /^closed applications$/i.test(l));
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^unit size:\s*(.+)$/i);
    if (!m || i === 0) continue;
    const name = lines[i - 1];
    const get = (label) => {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const mm = lines[j].match(new RegExp('^' + label + ':\\s*(.+)$', 'i'));
        if (mm) return mm[1];
      }
      return null;
    };
    const size = m[1];
    const beds = (size.match(/(\d+)\s*bed/i) || [])[1];
    const sqft = (size.match(/([\d,]+)\s*sq/i) || [])[1];
    const period = get('application period');
    const section = closedIdx !== -1 && i > closedIdx ? 'closed' : 'open';
    items.push({
      name,
      unitSize: size,
      beds: beds ? Number(beds) : null,
      sqft: sqft ? Number(sqft.replace(/,/g, '')) : null,
      price: money(get('offer price to match')),
      hoa: money(get('hoa dues')),
      process: get('application process'),
      period: period ? period.replace(/^period:\s*/i, '') : null,
      status: section === 'closed' || /closed/i.test(period || '') ? 'closed' : 'open',
      url: links[name.toLowerCase()] || null,
    });
  }
  return { ok: items.length > 0, url: CITY_SECOND_URL, incomeLimitAmi: 148, items };
}
