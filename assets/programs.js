// Program rules used by the questionnaire. Every number here comes from the
// linked sf.gov / CalHFA page as of November 2026. Update this file when MOHCD
// changes a program (income limits update every June in data/ami.json).

export const LINKS = {
  bmr: 'https://www.sf.gov/reports/august-2024/below-market-rate-bmr-ownership-programs',
  dahlia: 'https://housing.sfgov.org/listings/for-sale',
  incomeLimits: 'https://www.sf.gov/reports--income-limits-and-sales-price-levels-mohcd-homeownership-programs',
  amiPdf: 'https://media.api.sf.gov/documents/2026_AMI-IncomeLimits-HMFA.pdf',
  waivers: 'https://media.api.sf.gov/documents/Temporary_Waivers_to_BMR_Resales_2026-6-15.pdf',
  education: 'https://www.homeownershipsf.org/homebuyer-education/',
  agencies: 'https://www.sf.gov/resource/2022/homebuyer-program-counseling-agencies',
  lenders: 'https://www.sf.gov/reports--december-2024--find-lender-downpayment-and-mortgage-assistance-programs/',
  alerts: 'https://confirmsubscription.com/h/y/C3BAFCD742D47910',
  loans: 'https://www.sf.gov/apply-downpayment-loan',
  citySecond: 'https://www.sf.gov/reports--december-2024--city-second-program-current-listings',
};

// SFUSD roles named by MOHCD for Teacher Next Door and Educators-DALP.
export const ROLES = [
  { id: 'teacher', label: 'Teacher' },
  { id: 'para', label: 'Paraeducator / paraprofessional' },
  { id: 'certificated', label: 'Counselor, nurse, librarian, psychologist, social worker, speech pathologist, behavioral analyst, or SPED content specialist' },
  { id: 'dean', label: 'Dean' },
  { id: 'earlyed', label: 'Early Education department staff' },
  { id: 'other', label: 'Other SFUSD role (office, custodial, nutrition, administration…)' },
];

// Roles each SFUSD program names explicitly.
const TND_ROLES = ['teacher', 'para', 'certificated'];
const EDALP_ROLES = ['teacher', 'para', 'certificated', 'dean', 'earlyed'];

/**
 * a = answers: { sfusd: 'full'|'part30'|'partUnder'|'no', role, size, income,
 *   amiPct, owned: 'no'|'outsideSF'|'inSF', firstGen: 'yes'|'no'|'unsure',
 *   savings, bmrMaxCap }
 * Returns a list of { id, name, verdict: 'likely'|'maybe'|'unlikely', reasons[], ... }
 */
export function matchPrograms(a) {
  const out = [];
  const pct = a.amiPct;
  const sfusdOk = a.sfusd === 'full' || a.sfusd === 'part30';
  const noOwnAnywhere = a.owned === 'no';
  const noOwnSF = a.owned === 'no' || a.owned === 'outsideSF';
  const fmt = (n) => `${Math.round(n)}%`;

  // BMR ownership
  {
    const reasons = [];
    let v = 'likely';
    if (!noOwnAnywhere) { v = 'unlikely'; reasons.push('BMR requires that no one in the household has owned a home anywhere in the last 3 years.'); }
    if (pct > a.bmrMaxCap) { v = 'unlikely'; reasons.push(`Your income is about ${fmt(pct)} of AMI. The highest cap on any current listing is ${a.bmrMaxCap}%.`); }
    else if (pct > 120) { if (v === 'likely') v = 'maybe'; reasons.push(`At about ${fmt(pct)} of AMI, only a few current listings (with caps up to ${a.bmrMaxCap}%) are open to you.`); }
    else reasons.push(`At about ${fmt(pct)} of AMI you're under the cap on many listings. Check the Homes page for exact matches.`);
    out.push({
      id: 'bmr', name: 'Below Market Rate (BMR) homes', who: 'Anyone who qualifies',
      what: 'Buy a condo or townhome at a price set by the City, usually a fraction of market price. Resale prices are also restricted.',
      status: { label: 'Listings open now', tone: 'open' },
      verdict: v, reasons, link: LINKS.bmr, linkText: 'BMR program rules on sf.gov',
    });
  }

  // BMR-DALP
  {
    const reasons = ['Need-based: the City lends only what you need to qualify for the mortgage, with no monthly payment and no interest.'];
    let v = noOwnAnywhere && pct <= a.bmrMaxCap ? 'maybe' : 'unlikely';
    if (v === 'maybe' && a.savings !== null && a.savings < 30000) { v = 'likely'; reasons.push('With modest savings you are the kind of buyer it is meant for.'); }
    if (!noOwnAnywhere) reasons.unshift('Requires meeting BMR eligibility, including the first-time buyer rule.');
    out.push({
      id: 'bmrdalp', name: 'BMR Downpayment Assistance Loan (BMR-DALP)', who: 'BMR buyers who need help with the down payment',
      what: 'A down payment loan for buying a BMR home. You apply through your lender.',
      status: { label: 'Ask your lender', tone: 'neutral' },
      verdict: v, reasons, link: 'https://www.sf.gov/reports--august-2024--about-below-market-rate-downpayment-assistance-loan-program-bmr-dalp', linkText: 'BMR-DALP details',
    });
  }

  // Teacher Next Door
  {
    const reasons = [];
    let v = 'likely';
    if (!sfusdOk) { v = 'unlikely'; reasons.push(a.sfusd === 'partUnder' ? 'Part-time educators must earn at least 30% of their income from SFUSD.' : 'Only for current SFUSD educators.'); }
    else if (!TND_ROLES.includes(a.role)) { v = 'maybe'; reasons.push('MOHCD lists teachers, paraprofessionals and certificated staff. Confirm with MOHCD whether your role counts.'); }
    if (pct > 200) { v = 'unlikely'; reasons.push('Household income must be at or below 200% of AMI.'); }
    if (!noOwnSF) { v = 'unlikely'; reasons.push('No adult in the household can have owned a home in San Francisco in the last 3 years.'); }
    if (v === 'likely') reasons.push('You appear to meet the role, income and first-time rules.');
    reasons.push('You must stay at SFUSD for the 10-year term. Leaving makes the loan due.');
    out.push({
      id: 'tnd', name: 'Teacher Next Door', who: 'SFUSD educators',
      what: 'A forgivable loan: $20,000 toward a BMR home or $40,000 toward a market-rate home. No interest; forgiven after 10 years if you meet the rules.',
      status: { label: 'Ask your lender about funds', tone: 'neutral' },
      verdict: v, reasons, link: 'https://www.sf.gov/reports--august-2024--about-teacher-next-door-program', linkText: 'Teacher Next Door rules',
    });
  }

  // Educators-DALP
  {
    const reasons = [];
    let v = 'likely';
    if (!sfusdOk) { v = 'unlikely'; reasons.push(a.sfusd === 'partUnder' ? 'Part-time educators must earn at least 30% of their income from SFUSD.' : 'Only for SFUSD employees.'); }
    else if (!EDALP_ROLES.includes(a.role)) { v = 'maybe'; reasons.push('MOHCD lists UESF members such as teachers, paras, counselors, deans, nurses and librarians, plus Early Education staff. Confirm whether your role counts.'); }
    if (pct > 200) { v = 'unlikely'; reasons.push('Household income must be at or below 200% of AMI.'); }
    if (!noOwnSF) { v = 'unlikely'; reasons.push('No one can have owned a home in San Francisco in the last 3 years (owning elsewhere is OK).'); }
    reasons.push('For market-rate homes, not BMR units. Awarded by lottery during an application window.');
    out.push({
      id: 'edalp', name: 'Educators Downpayment Assistance Loan (Educators-DALP)', who: 'SFUSD employees',
      what: 'Up to $500,000 toward a market-rate home anywhere in San Francisco. No monthly payments; repaid with a share of appreciation when you sell.',
      status: { label: 'Between rounds: last round closed June 2, 2025', tone: 'closed' },
      verdict: v, reasons, link: 'https://www.sf.gov/educators-downpayment-assistance-loan-program', linkText: 'Educators-DALP on sf.gov',
    });
  }

  // General DALP
  {
    const reasons = [];
    let v = noOwnAnywhere && pct <= 200 ? 'likely' : 'unlikely';
    if (!noOwnAnywhere) reasons.push('No one in the household can have owned a home anywhere in the last 3 years.');
    if (pct > 200) reasons.push('Household income must be at or below 200% of AMI.');
    if (v === 'likely') reasons.push('Educators apply on the same application. If not picked for Educators-DALP, you are also considered here.');
    out.push({
      id: 'dalp', name: 'Downpayment Assistance Loan Program (DALP)', who: 'First-time buyers up to 200% AMI',
      what: 'Up to $500,000 toward a market-rate home. Same application and lottery as Educators-DALP.',
      status: { label: 'Between rounds: last round closed June 2, 2025', tone: 'closed' },
      verdict: v, reasons, link: 'https://sf.gov/apply-downpayment-loan-buy-market-rate-home', linkText: 'DALP on sf.gov',
    });
  }

  // City Second
  {
    const reasons = [];
    let v = noOwnAnywhere && pct <= 148 ? 'likely' : 'unlikely';
    if (pct > 148) reasons.push('Household income must be at or below 148% of AMI.');
    if (!noOwnAnywhere) reasons.push('First-time homebuyer rules apply.');
    if (v === 'likely') reasons.push('Only for specific homes the City lists, first come, first served.');
    out.push({
      id: 'cslp', name: 'City Second Loan Program', who: 'Buyers up to 148% AMI',
      what: 'A no-interest down payment loan for specific homes sold at a fixed "offer price to match". Listings are posted on sf.gov.',
      status: { label: 'Check current listings', tone: 'open' },
      verdict: v, reasons, link: LINKS.citySecond, linkText: 'City Second listings',
    });
  }

  // Dream Keeper DALP
  {
    const reasons = ['First come, first served while funds last. Priority goes to Certificate of Preference holders, Section 8 voucher holders and HOPE SF residents.'];
    const v = noOwnAnywhere && pct <= 200 ? 'maybe' : 'unlikely';
    if (pct > 200) reasons.unshift('Household income must be at or below 200% of AMI.');
    if (!noOwnAnywhere) reasons.unshift('First-time homebuyer rules apply.');
    out.push({
      id: 'dkdalp', name: 'Dream Keeper Downpayment Assistance (DK-DALP)', who: 'First-time buyers up to 200% AMI',
      what: 'Up to $500,000 toward a market-rate home, plus up to $30,000 in wealth-building assistance.',
      status: { label: 'Check fund availability', tone: 'neutral' },
      verdict: v, reasons, link: 'https://www.sf.gov/reports/may-2023/dream-keeper-downpayment-assistance-loan-program-dk-dalp', linkText: 'DK-DALP details',
    });
  }

  // CalHFA Dream For All
  {
    const reasons = [];
    let v = a.firstGen === 'yes' ? 'maybe' : a.firstGen === 'unsure' ? 'maybe' : 'unlikely';
    if (a.firstGen === 'no') reasons.push('This state program is for first-generation homebuyers.');
    else reasons.push('A state program for first-generation, first-time buyers. Income limits are set by CalHFA by county.');
    reasons.push('Requires the Dream For All first mortgage, so it is usually not combined with BMR purchases. Ask a lender.');
    out.push({
      id: 'dfa', name: 'CalHFA Dream For All', who: 'First-generation homebuyers in California',
      what: 'A shared-appreciation loan for up to 20% of the price (capped at $150,000). You repay it plus a share of the gain when you sell.',
      status: { label: 'Between rounds: 2026 window closed March 16', tone: 'closed' },
      verdict: v, reasons, link: 'https://calhfa.ca.gov/dream/', linkText: 'Dream For All on calhfa.ca.gov',
    });
  }

  // MCC
  out.push({
    id: 'mcc', name: 'Mortgage Credit Certificate (MCC)', who: 'First-time buyers',
    what: 'A federal tax credit worth 15% of your yearly mortgage interest.',
    status: { label: 'Suspended until funding returns', tone: 'closed' },
    verdict: 'unlikely', reasons: ['MOHCD has suspended new MCCs until more funding is available.'],
    link: 'https://www.sf.gov/reports--december-2024--mortgage-credit-certificate', linkText: 'MCC status on sf.gov',
  });

  return out;
}
