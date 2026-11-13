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
