// Live availability checker for the night of the concert (11 -> 12 July 2026).
// Party: 2 adults + 2 children (ages 5 and 2). Runs on a GitHub Actions runner
// (unrestricted internet) with full Playwright Chromium.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(process.cwd(), 'out');
fs.mkdirSync(OUT, { recursive: true });

const CHECKIN = '2026-07-11';
const CHECKOUT = '2026-07-12';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const results = { checkin: CHECKIN, checkout: CHECKOUT, party: '2 adults + children age 5 & 2', channels: {} };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newCtx(browser) {
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'sv-SE',
    timezoneId: 'Europe/Stockholm',
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['sv-SE', 'sv', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });
  return ctx;
}

async function dismiss(page, sels) {
  for (const s of sels) {
    try { const b = await page.$(s); if (b) { await b.click({ timeout: 1500 }); await sleep(400); } } catch (e) {}
  }
}

async function shot(page, name) {
  try { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false }); } catch (e) {}
}

async function bookingSearch(browser, label, ss) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const url = `https://www.booking.com/searchresults.sv.html?ss=${encodeURIComponent(ss)}` +
    `&checkin=${CHECKIN}&checkout=${CHECKOUT}&group_adults=2&group_children=2&age=5&age=2&no_rooms=1&selected_currency=SEK&lang=sv`;
  const rec = { url, blocked: false, note: '', properties: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismiss(page, ['#onetrust-accept-btn-handler', 'button[aria-label*="Godkänn"]', 'button[aria-label*="Accept"]', '[aria-label="Stäng inloggningsinfo."]', '[aria-label="Dismiss sign-in info."]']);
    await sleep(3500);
    const title = await page.title();
    const bodyTxt = (await page.evaluate(() => document.body.innerText || '')).slice(0, 400);
    if (/access denied|are you a robot|captcha|unusual traffic|verifiera/i.test(title + bodyTxt)) {
      rec.blocked = true; rec.note = 'bot-blocked: ' + title;
    }
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 2400); await sleep(900); }
    rec.properties = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-testid="property-card"]').forEach(c => {
        const q = (s) => c.querySelector(s)?.innerText?.trim() || null;
        out.push({
          name: q('[data-testid="title"]'),
          price: q('[data-testid="price-and-discounted-price"]') || q('[data-testid="availability-single-price"]'),
          config: q('[data-testid="property-card-unit-configuration"]'),
          score: (q('[data-testid="review-score"]') || '').replace(/\n+/g, ' ') || null,
          dist: q('[data-testid="distance"]'),
          link: (c.querySelector('a[data-testid="title-link"]') || c.querySelector('a'))?.href?.split('?')[0] || null,
        });
      });
      return out;
    });
    rec.count = rec.properties.length;
  } catch (e) {
    rec.error = e.message;
  } finally {
    await shot(page, 'booking-' + label);
    try { fs.writeFileSync(path.join(OUT, 'booking-' + label + '.html'), await page.content()); } catch (e) {}
    await ctx.close();
  }
  return rec;
}

async function airbnbSearch(browser, label, place) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const url = `https://www.airbnb.se/s/${encodeURIComponent(place)}/homes?checkin=${CHECKIN}&checkout=${CHECKOUT}&adults=2&children=2`;
  const rec = { url, blocked: false, properties: [] };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismiss(page, ['[data-testid="accept-btn"]', 'button[aria-label*="Godkänn"]', 'button:has-text("OK")']);
    await sleep(4000);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 2200); await sleep(900); }
    const title = await page.title();
    if (/access|robot|captcha|blocked/i.test(title)) { rec.blocked = true; rec.note = title; }
    rec.properties = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[itemprop="itemListElement"], [data-testid="card-container"]').forEach(c => {
        const t = c.innerText.replace(/\s+/g, ' ').trim();
        const a = c.querySelector('a[href*="/rooms/"]');
        if (t) out.push({ text: t.slice(0, 220), link: a ? 'https://www.airbnb.se' + a.getAttribute('href').split('?')[0] : null });
      });
      return out.slice(0, 40);
    });
    rec.count = rec.properties.length;
  } catch (e) {
    rec.error = e.message;
  } finally {
    await shot(page, 'airbnb-' + label);
    await ctx.close();
  }
  return rec;
}

async function genericProbe(browser, label, url, waitSel) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const rec = { url };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismiss(page, ['#onetrust-accept-btn-handler', 'button:has-text("Godkänn")', 'button:has-text("Acceptera")', 'button:has-text("Tillåt alla")']);
    await sleep(4000);
    if (waitSel) { try { await page.waitForSelector(waitSel, { timeout: 8000 }); } catch (e) {} }
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 2000); await sleep(800); }
    rec.title = await page.title();
    rec.textSample = (await page.evaluate(() => document.body.innerText || '')).replace(/\s+/g, ' ').slice(0, 1200);
    rec.status = 'ok';
  } catch (e) {
    rec.error = e.message;
  } finally {
    await shot(page, 'probe-' + label);
    await ctx.close();
  }
  return rec;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
  });
  try {
    results.channels.booking_tanndalen = await bookingSearch(browser, 'tanndalen', 'Tänndalen');
    results.channels.booking_funasdalen = await bookingSearch(browser, 'funasdalen', 'Funäsdalen');
    results.channels.booking_region = await bookingSearch(browser, 'region', 'Funäsfjällen');
    results.channels.booking_bruksvallarna = await bookingSearch(browser, 'bruksvallarna', 'Bruksvallarna');
    results.channels.booking_ramundberget = await bookingSearch(browser, 'ramundberget', 'Ramundberget');
    results.channels.airbnb_tanndalen = await airbnbSearch(browser, 'tanndalen', 'Tänndalen, Sverige');
    results.channels.airbnb_hamra = await airbnbSearch(browser, 'hamrafjallet', 'Hamrafjället, Sverige');
    // Local/official inventory (Citybreak) + direct hotel engines — capture what renders.
    results.channels.stugvarden = await genericProbe(browser, 'stugvarden', 'https://stugvarden.online.citybreak.com/sv/stugor', null);
  } catch (e) {
    results.fatal = e.message;
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));

  // Compact, log-friendly summary
  const line = (s) => console.log(s);
  line('\n================ AVAILABILITY SUMMARY (11->12 Jul 2026, 2 adults + kids 5 & 2) ================');
  for (const [k, v] of Object.entries(results.channels)) {
    if (v.properties) {
      const avail = v.properties.filter(p => p.price || (p.text && /kr|SEK|\$/.test(p.text)));
      line(`\n### ${k}  ${v.blocked ? '[BLOCKED: ' + (v.note || '') + ']' : ''}  (${v.count || 0} cards, ${avail.length} with price)`);
      avail.slice(0, 30).forEach(p => {
        if (p.name) line(`  - ${p.name} | ${p.price || '?'} | ${p.config || ''} | ${p.dist || ''} | ${p.link || ''}`);
        else line(`  - ${p.text} | ${p.link || ''}`);
      });
      if (v.error) line('  ERROR: ' + v.error);
    } else {
      line(`\n### ${k}  title="${v.title || ''}" ${v.error ? 'ERROR:' + v.error : ''}`);
      if (v.textSample) line('  sample: ' + v.textSample.slice(0, 300));
    }
  }
  line('\n================ END SUMMARY ================');
})();
