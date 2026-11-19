// Turns raw DAHLIA API responses into the slim shape the site uses.
// Kept dependency-free so the same function can run in Node or a browser.

export function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

export function normalizeListing(browse, detailRaw, unitsRaw, prefsRaw) {
  const d = (detailRaw && (detailRaw.listing || detailRaw)) || {};
  const b = browse || {};
  const pick = (k) => (d[k] !== undefined && d[k] !== null ? d[k] : b[k]);
  const id = b.listingID || b.Id || d.listingID || d.Id;

  const unitsArr = (unitsRaw && (unitsRaw.units || unitsRaw)) || [];
  let units = (Array.isArray(unitsArr) ? unitsArr : []).map((u) => ({
    type: u.Unit_Type || null,
    number: u.Unit_Number || null,
    floor: u.Unit_Floor || null,
    baths: num(u.Number_of_Bathrooms),
    sqft: num(u.Unit_Square_Footage),
    price: num(u.Price_Without_Parking) ?? num(u.Price_With_Parking),
    priceWithParking: num(u.Price_With_Parking),
    hoa: num(u.HOA_Dues_Without_Parking) ?? num(u.HOA_Dues_With_Parking),
    hoaWithParking: num(u.HOA_Dues_With_Parking),
    maxAmi: num(u.Max_AMI_for_Qualifying_Unit),
    minOccupancy: num(u.Min_Occupancy),
    maxOccupancy: num(u.Max_Occupancy),
    status: u.Status || null,
    availability: num(u.Availability),
    reserved: !!u.isReservedCommunity,
  }));

  // Fall back to the browse summary when unit records are missing.
  if (!units.length) {
    const sums = [...((b.unitSummaries && b.unitSummaries.general) || []), ...((b.unitSummaries && b.unitSummaries.reserved) || [])];
    units = sums.map((s) => ({
      type: s.unitType || null,
      number: null, floor: null, baths: null,
      sqft: num(s.minSquareFt),
      price: num(s.minPriceWithoutParking) ?? num(s.minPriceWithParking),
      priceWithParking: num(s.minPriceWithParking),
      hoa: num(s.minHoaDuesWithoutParking) ?? num(s.minHoaDuesWithParking),
      hoaWithParking: num(s.minHoaDuesWithParking),
      maxAmi: num(s.maxQualifyingAMI),
      minOccupancy: num(s.minOccupancy),
      maxOccupancy: num(s.maxOccupancy),
      status: null,
      availability: num(s.availability ?? s.totalUnits),
      reserved: false,
    }));
  }

  const prefsArr = (prefsRaw && (prefsRaw.preferences || prefsRaw)) || [];
  const prefs = (Array.isArray(prefsArr) ? prefsArr : [])
    .sort((a, c) => (a.order || 0) - (c.order || 0))
    .map((p) => ({ name: p.preferenceName || p.name, description: stripHtml(p.description || p.customPreferenceDescription || ''), url: p.readMoreUrl || null }))
    .filter((p) => p.name);

  const openHouses = (Array.isArray(d.Open_Houses) ? d.Open_Houses : []).map((o) => ({
    date: o.Date || null, start: o.Start_Time || null, end: o.End_Time || null,
    note: stripHtml(o.Venue || ''),
  }));

  const listingType = pick('Listing_Type') || '';
  const isFcfs = /first come/i.test(listingType);
  const notesText = stripHtml(d.Listing_Other_Notes || '');
  // MOHCD's temporary resale waivers (Announcement 2026-01) are only stated
  // in each listing's notes, so detect them from the wording.
  const waivers = {
    raisedAmi: /one-time 20% increase|higher income limit/i.test(notesText),
    assetsExcluded: /income from assets excluded/i.test(notesText),
    educationAfterApplying: /homebuyer education after applying/i.test(notesText),
    largeDownPayment: /down payment more than 50%/i.test(notesText),
    expires: (notesText.match(/expire on (\d{2}\/\d{2}\/\d{4})/i) || [])[1] || null,
  };

  return {
    id,
    name: pick('Name'),
    building: pick('Building_Name'),
    address: pick('Building_Street_Address'),
    zip: pick('Building_Zip_Code'),
    neighborhood: d.Neighborhood || null,
    yearBuilt: num(d.Year_Built),
    method: isFcfs ? 'fcfs' : 'lottery',
    listingType,
    tenure: pick('Tenure') || null,
    programType: d.Program_Type || null,
    dueDate: pick('Application_Due_Date') || null,
    lotteryDate: d.Lottery_Date || null,
    lotteryResultsDate: pick('Lottery_Results_Date') || null,
    unitsAvailable: num(pick('Units_Available')),
    image: b.imageURL || d.imageURL || null,
    url: `https://housing.sfgov.org/listings/${id}`,
    mlsUrl: d.Multiple_Listing_Service_URL || null,
    parking: d.Parking_Information || null,
    buildingParkingCost: num(d.Building && d.Building.Parking_Cost),
    appliances: d.Appliances || null,
    amenities: d.Amenities || null,
    petPolicy: d.Pet_Policy || null,
    notes: notesText,
    waivers,
    agent: {
      name: d.Leasing_Agent_Name || null,
      title: d.Leasing_Agent_Title || null,
      phone: d.Leasing_Agent_Phone || null,
      email: d.Leasing_Agent_Email || null,
    },
    openHouses,
    prefs,
    units,
    lastModified: pick('LastModifiedDate') || null,
  };
}

// ---------------------------------------------------------------------------
// Rentals. Same DAHLIA shape as ownership, plus rent, minimum income,
// occupancy limits, waitlist details and resident selection criteria.

// Buildings known to give priority to SFUSD (and sometimes City College)
// employees. Matched on name or address; anything else mentioning SFUSD or
// educators in its name, notes or preferences is flagged too.
export const EDUCATOR_BUILDINGS = [
  { key: 'chisholm', name: 'Shirley Chisholm Village', match: /chisholm|1360 43rd/i },
  { key: 'brightwell', name: 'Brightwell West', match: /brightwell|750 golden gate/i },
];
const EDUCATOR_TEXT = /\bSFUSD\b|school district|educator|city college|\bCCSF\b/i;

export function normalizeRental(browse, detailRaw, unitsRaw, prefsRaw) {
  const b = browse || {};
  const d = (detailRaw && (detailRaw.listing || detailRaw)) || {};
  const pick = (k) => (d[k] !== undefined && d[k] !== null ? d[k] : b[k]);
  const id = b.listingID || b.Id || d.listingID || d.Id;

  const unitsArr = (unitsRaw && (unitsRaw.units || unitsRaw)) || [];
  let units = (Array.isArray(unitsArr) ? unitsArr : []).map((u) => ({
    type: u.Unit_Type || null,
    number: u.Unit_Number || null,
    floor: u.Unit_Floor || null,
    baths: num(u.Number_of_Bathrooms),
    sqft: num(u.Unit_Square_Footage),
    rent: num(u.BMR_Rent_Monthly),
    minIncomeMonthly: num(u.BMR_Rental_Minimum_Monthly_Income_Needed),
    rentPercentIncome: num(u.Rent_percent_of_income),
    maxAmi: num(u.Max_AMI_for_Qualifying_Unit),
    amiChart: u.AMI_chart_type || null,
    amiChartYear: num(u.AMI_chart_year),
    minOccupancy: num(u.Min_Occupancy),
    maxOccupancy: num(u.Max_Occupancy),
    status: u.Status || null,
    availability: num(u.Availability),
    reserved: !!u.isReservedCommunity,
  }));
  if (!units.length) {
    const sums = [...((b.unitSummaries && b.unitSummaries.general) || []), ...((b.unitSummaries && b.unitSummaries.reserved) || [])];
    units = sums.map((s) => ({
      type: s.unitType || null, number: null, floor: null, baths: null,
      sqft: num(s.minSquareFt),
      rent: num(s.minMonthlyRent),
      minIncomeMonthly: num(s.minRentalMinIncome),
      rentPercentIncome: num(s.minPercentIncome),
      maxAmi: num(s.maxQualifyingAMI),
      amiChart: null, amiChartYear: null,
      minOccupancy: num(s.minOccupancy),
      maxOccupancy: num(s.maxOccupancy),
      status: null,
      availability: num(s.availability ?? s.totalUnits),
      reserved: false,
    }));
  }

  // Big buildings list hundreds of identical units; group them so the data
  // stays small. Each group keeps a total count and how many are available.
  const groups = new Map();
  for (const u of units) {
    const key = [u.type, u.rent, u.minIncomeMonthly, u.rentPercentIncome, u.maxAmi, u.amiChart, u.amiChartYear, u.minOccupancy, u.maxOccupancy, u.reserved].join('|');
    const g = groups.get(key) || { type: u.type, rent: u.rent, minIncomeMonthly: u.minIncomeMonthly, rentPercentIncome: u.rentPercentIncome, maxAmi: u.maxAmi, amiChart: u.amiChart, amiChartYear: u.amiChartYear, minOccupancy: u.minOccupancy, maxOccupancy: u.maxOccupancy, reserved: u.reserved, sqftMin: null, sqftMax: null, count: 0, available: 0 };
    g.count += u.availability && !u.status ? u.availability : 1;
    if (u.status === 'Available' || (!u.status && u.availability)) g.available += u.status ? 1 : u.availability;
    if (u.sqft) { g.sqftMin = Math.min(g.sqftMin ?? u.sqft, u.sqft); g.sqftMax = Math.max(g.sqftMax ?? u.sqft, u.sqft); }
    groups.set(key, g);
  }
  const unitGroups = [...groups.values()].sort((a, c) => (a.rent ?? 0) - (c.rent ?? 0));

  const prefsArr = (prefsRaw && (prefsRaw.preferences || prefsRaw)) || [];
  const prefs = (Array.isArray(prefsArr) ? prefsArr : [])
    .sort((a, c) => (a.order || 0) - (c.order || 0))
    .map((p) => ({ name: (p.preferenceName || p.name || '').replace(/\s+/g, ' ').trim(), description: stripHtml(p.description || p.customPreferenceDescription || '') }))
    .filter((p) => p.name);

  const notes = stripHtml(d.Listing_Other_Notes || '');
  const listingType = pick('Listing_Type') || '';
  const method = /waitlist/i.test(listingType) ? 'waitlist' : /first come/i.test(listingType) ? 'fcfs' : 'lottery';
  const name = pick('Name') || '';
  const address = pick('Building_Street_Address') || '';
  const known = EDUCATOR_BUILDINGS.find((x) => x.match.test(`${name} ${address} ${pick('Building_Name') || ''}`));
  const textHit = EDUCATOR_TEXT.test(`${name} ${notes} ${prefs.map((p) => `${p.name} ${p.description}`).join(' ')}`);
  const accessible = (d.prioritiesDescriptor || b.prioritiesDescriptor || []).map((p) => ({ name: p.name, units: num(p.numberOfUnits) }));
  const reservedFor = (d.reservedDescriptor || b.reservedDescriptor || []).map((r) => r.name).filter(Boolean);

  return {
    id,
    name,
    building: pick('Building_Name'),
    address,
    zip: pick('Building_Zip_Code'),
    neighborhood: d.Neighborhood || null,
    yearBuilt: num(d.Year_Built),
    method,
    listingType,
    listingStatus: pick('Status') || null,          // "Active" or "Lease Up"
    tenure: pick('Tenure') || null,                 // "New rental" or "Re-rental"
    programType: d.Program_Type || null,            // e.g. IH-RENTAL, MF-RENTAL
    dueDate: pick('Application_Due_Date') || null,
    lotteryDate: d.Lottery_Date || null,
    lotteryResultsDate: pick('Lottery_Results_Date') || null,
    unitsAvailable: num(pick('Units_Available')),
    waitlist: {
      has: !!pick('hasWaitlist'),
      current: num(d.Number_of_people_currently_on_waitlist),
      max: num(d.Maximum_waitlist_size),
      openings: num(d.Total_waitlist_openings),
    },
    educator: known ? { key: known.key, name: known.name } : textHit ? { key: 'other', name: null } : null,
    reservedFor,
    accessible,
    image: b.imageURL || d.imageURL || null,
    url: `https://housing.sfgov.org/listings/${id}`,
    fee: num(d.Fee),
    depositMin: num(d.Deposit_Min),
    depositMax: num(d.Deposit_Max),
    utilities: stripHtml(d.Utilities || ''),
    parking: d.Parking_Information || null,
    credit: stripHtml(d.Credit_Rating || ''),
    eviction: stripHtml(d.Eviction_History || ''),
    criteriaUrl: d.Building_Selection_Criteria || null,
    requiredDocs: stripHtml(d.Required_Documents || ''),
    amenities: d.Amenities || null,
    notes,
    prefs: prefs.map((p) => ({ name: p.name, description: /educat|sfusd|city college|\btier\b/i.test(`${p.name} ${p.description}`) ? p.description : '' })),
    units: unitGroups,
    lastModified: pick('LastModifiedDate') || null,
  };
}

// The AMI charts a set of rentals uses, as {chartType, year, percent} triples.
export function chartsNeeded(rentals) {
  const seen = new Map();
  for (const l of rentals) for (const g of l.units) {
    if (!g.amiChart || !g.amiChartYear || !g.maxAmi) continue;
    const k = `${g.amiChart}|${g.amiChartYear}|${g.maxAmi}`;
    if (!seen.has(k)) seen.set(k, { chartType: g.amiChart, year: g.amiChartYear, percent: g.maxAmi });
  }
  return [...seen.values()];
}

// Attach maxIncome (array, index 0 = 1 person) to every unit group, given
// DAHLIA's /listings/ami.json response values.
export function attachLimits(rentals, amiResponse) {
  const table = new Map();
  for (const row of (amiResponse && amiResponse.ami) || []) {
    for (const v of row.values || []) {
      const k = `${v.chartType}|${v.year}|${v.percent}`;
      const arr = table.get(k) || [];
      arr[v.numOfHousehold - 1] = v.amount;
      table.set(k, arr);
    }
  }
  for (const l of rentals) for (const g of l.units) {
    g.maxIncome = table.get(`${g.amiChart}|${g.amiChartYear}|${g.maxAmi}`) || null;
  }
  return rentals;
}
