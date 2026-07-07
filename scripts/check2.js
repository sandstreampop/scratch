// Round 2: confirm the closest Tänndalen-area hotels via their Booking.com
// detail pages (with dates), paginate the region search for more inventory,
// and date-search the regional Citybreak (Stugvärden) system.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(process.cwd(), 'out2');
fs.mkdirSync(OUT, { recursive: true });
const CHECKIN = '2026-07-11', CHECKOUT = '2026-07-12';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const results = { checkin: CHECKIN, checkout: CHECKOUT, hotels: {}, region_more: [], citybreak: {} };

async function newCtx(browser) {
  const ctx = await browser.newContext({ userAgent: UA, locale: 'sv-SE', timezoneId: 'Europe/Stockholm', viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8' } });
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  return ctx;
}
async function dismiss(page, sels) { for (const s of sels) { try { const b = await page.$(s); if (b) { await b.click({ timeout: 1500 }); await sleep(400); } } catch (e) {} } }

async function bookingHotel(browser, slug, label) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const url = `https://www.booking.com/hotel/se/${slug}.sv.html?checkin=${CHECKIN}&checkout=${CHECKOUT}&group_adults=2&group_children=2&age=5&age=2&no_rooms=1&selected_currency=SEK&lang=sv`;
  const rec = { url, available: null, name: null, rooms: [], note: '' };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismiss(page, ['#onetrust-accept-btn-handler', 'button[aria-label*="Godkänn"]', 'button[aria-label*="Accept"]', '[aria-label="Stäng inloggningsinfo."]', '[aria-label="Dismiss sign-in info."]']);
    await sleep(3500);
    await page.mouse.wheel(0, 1600); await sleep(1500);
    rec.name = await page.evaluate(() => document.querySelector('h2.pp-header__title, [data-testid="title"], h1')?.innerText?.trim() || null);
    const data = await page.evaluate(() => {
      const rooms = [];
      // room rows in the availability table
      document.querySelectorAll('#hprt-table tr, [data-testid="availability-table"] tr, tr.js-rt-block-row').forEach(tr => {
        const t = tr.innerText.replace(/\s+/g, ' ').trim();
        if (t && /kr|SEK/.test(t)) rooms.push(t.slice(0, 180));
      });
      const body = document.body.innerText || '';
      const sold = /inga lediga rum|no rooms available|tyvärr.*inga|fullbokat|not available for your dates/i.test(body);
      return { rooms, sold };
    });
    rec.rooms = [...new Set(data.rooms)].slice(0, 12);
    rec.available = rec.rooms.length > 0 ? true : (data.sold ? false : null);
  } catch (e) { rec.note = 'ERR ' + e.message; }
  finally { try { await page.screenshot({ path: path.join(OUT, 'hotel-' + label + '.png') }); } catch (e) {} await ctx.close(); }
  return rec;
}

async function regionMore(browser) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const out = [];
  try {
    for (const offset of [0, 25, 50]) {
      const url = `https://www.booking.com/searchresults.sv.html?ss=Funäsfjällen&checkin=${CHECKIN}&checkout=${CHECKOUT}&group_adults=2&group_children=2&age=5&age=2&no_rooms=1&selected_currency=SEK&lang=sv&offset=${offset}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await dismiss(page, ['#onetrust-accept-btn-handler', 'button[aria-label*="Godkänn"]', '[aria-label="Stäng inloggningsinfo."]']);
      await sleep(2500);
      for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 2600); await sleep(700); }
      const cards = await page.evaluate(() => {
        const o = [];
        document.querySelectorAll('[data-testid="property-card"]').forEach(c => {
          const q = (s) => c.querySelector(s)?.innerText?.trim() || null;
          o.push({ name: q('[data-testid="title"]'), price: q('[data-testid="price-and-discounted-price"]') || q('[data-testid="availability-single-price"]'), config: q('[data-testid="property-card-unit-configuration"]'), link: (c.querySelector('a[data-testid="title-link"]') || c.querySelector('a'))?.href?.split('?')[0] || null });
        });
        return o;
      });
      out.push(...cards);
    }
  } catch (e) { out.push({ error: e.message }); }
  finally { await ctx.close(); }
  // dedupe by name
  const seen = new Set(); const dedup = [];
  for (const c of out) { if (c.name && !seen.has(c.name)) { seen.add(c.name); dedup.push(c); } }
  return dedup;
}

async function citybreak(browser) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const rec = { note: '', items: [] };
  try {
    await page.goto('https://stugvarden.online.citybreak.com/sv/stugor', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismiss(page, ['button:has-text("Jag förstår")', 'button:has-text("Godkänn")', 'button:has-text("Acceptera")', '#onetrust-accept-btn-handler']);
    await sleep(2500);
    // try to enter dates via any visible date inputs / search
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 1800); await sleep(700); }
    rec.items = await page.evaluate(() => {
      const o = [];
      document.querySelectorAll('a, article, .product, [class*="card"], [class*="Card"]').forEach(el => {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && /bädd|bäddar|kr|pers|sovrum/i.test(t) && t.length < 200) o.push(t);
      });
      return [...new Set(o)].slice(0, 60);
    });
    rec.title = await page.title();
  } catch (e) { rec.note = 'ERR ' + e.message; }
  finally { try { await page.screenshot({ path: path.join(OUT, 'citybreak.png'), fullPage: true }); } catch (e) {} await ctx.close(); }
  return rec;
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
  try {
    const hotels = {
      skarvruet: 'skarvruets-hogfjallshotell-tanndalen1',
      strandgarden_fjallnas: 'strandgarden-fjallnas-tanndalen1',
      fjallnas_est1882: 'fjallnas-est-1882',
      funasdalens_stugby: 'funasdalens-stugby',
      nobel_cabins: 'nobel-cabins',
      hotell_funasdalen: 'hotell-funa-sdalen',
    };
    for (const [label, slug] of Object.entries(hotels)) {
      results.hotels[label] = await bookingHotel(browser, slug, label);
    }
    results.region_more = await regionMore(browser);
    results.citybreak = await citybreak(browser);
  } catch (e) { results.fatal = e.message; }
  finally { await browser.close(); }
  fs.writeFileSync(path.join(OUT, 'results2.json'), JSON.stringify(results, null, 2));

  console.log('\n============= ROUND 2: HOTEL PAGES (11->12 Jul 2026, 2 ad + kids 5&2) =============');
  for (const [k, v] of Object.entries(results.hotels)) {
    console.log(`\n### ${k}  available=${v.available}  name="${v.name || ''}"  ${v.note}`);
    console.log('  ' + v.url);
    v.rooms.forEach(r => console.log('   • ' + r));
  }
  console.log('\n============= REGION (deduped, all offsets) =============');
  results.region_more.forEach(c => { if (c.name) console.log(`  - ${c.name} | ${c.price || '?'} | ${c.config || ''} | ${c.link || ''}`); });
  console.log('\n============= CITYBREAK / STUGVÄRDEN =============');
  console.log('title=' + (results.citybreak.title || '') + ' ' + results.citybreak.note);
  results.citybreak.items.forEach(t => console.log('   • ' + t));
  console.log('\n============= END ROUND 2 =============');
})();
