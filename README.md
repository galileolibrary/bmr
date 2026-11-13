# BMR homes for SFUSD staff

An unofficial guide to San Francisco's Below Market Rate (BMR) homeownership program for SFUSD teachers, paraeducators and staff. It lets people:

- check their eligibility against the 2026 MOHCD income limits
- browse and filter BMR homes for sale, with a "likely eligible / likely not eligible" estimate per unit
- answer a short questionnaire to see which City and state down payment programs fit
- see upcoming deadlines, open houses and recently closed lotteries
- find the counselors, lenders and MOHCD contacts who actually confirm eligibility

Not affiliated with SFUSD or the City and County of San Francisco.

## Privacy

Everything a visitor types stays in the page's memory. Nothing is written to cookies, localStorage or the URL, and nothing is sent anywhere. Fonts are self-hosted. The only outside requests are listing photos (from the City's servers) and, if turned on, GoatCounter page counts.

## How it works

It's a static site with no build step.

| Path | What it is |
|---|---|
| `index.html`, `assets/` | The site. `assets/app.js` holds the calculators and pages, and `assets/programs.js` holds the program rules. |
| `data/ami.json` | MOHCD's 2026 "Maximum Income by Household Size" chart (1 to 11 people, 15% to 200% AMI). |
| `data/listings.json` | Current ownership listings from DAHLIA, plus City Second listings from sf.gov. |
| `data/history.json` | Every listing ever seen, so closed lotteries stay visible on the Recent page. |
| `scripts/fetch-listings.mjs` | Refreshes the data. Node 20, no dependencies. |
| `.github/workflows/refresh-data.yml` | Runs the refresh every 3 hours, commits any changes, and publishes to GitHub Pages. |

Listing data comes from the JSON endpoints that power housing.sfgov.org (`/api/v1/listings.json?type=ownership`, plus `/{id}.json`, `/{id}/units.json` and `/{id}/preferences.json`). They're public but undocumented. If they change, the refresh step fails and the site keeps showing the last good data, with a warning in the footer after 2 days without a successful check.

## One-time setup

1. **Turn on Pages:** go to Settings → Pages → Build and deployment and set Source to **GitHub Actions**.
2. **Run it once:** go to Actions → "Refresh listings and publish site" → Run workflow.
3. **Optional analytics:** sign up at goatcounter.com, then put your site code in `assets/config.js` (`GOATCOUNTER_CODE`).

## Yearly upkeep

- **Every June:** MOHCD publishes new income limits. Replace `data/ami.json` with the new chart (same shape: `limits["100"]` is the 100% AMI row, index 0 = 1 person), and update "2026" in the page text.
- **When programs change:** edit `assets/programs.js`. The DALP round dates, Teacher Next Door amounts, City Second cap (148% AMI) and the MCC suspension all live there.
- **DALP fund balances:** `data/dalp-balances.json` is copied by hand from MOHCD's [loan program balances](https://www.sf.gov/data--mohcd-loan-program-balances) page (a Power BI report the job can't read). Update the amounts and `asOf` date every few weeks, or when a new DALP round opens.
- **DALP rules:** the Down payment loans page (`viewDalp` in `assets/app.js`) follows the DALP Manual, September 2025. Check it when MOHCD publishes a new manual.
- **Mortgage rate default:** `assets/config.js`.
- **Resale waivers:** MOHCD's temporary waivers run through June 30, 2027. Listings state them in their notes; `scripts/normalize.mjs` detects them by wording.

## Run locally

```sh
python3 -m http.server 8000      # then open http://localhost:8000
node scripts/fetch-listings.mjs  # refresh data (needs access to housing.sfgov.org)
```

Fonts: Atkinson Hyperlegible (Braille Institute) and Bricolage Grotesque, both under the SIL Open Font License; see `assets/fonts/`.
