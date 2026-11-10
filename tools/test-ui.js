// Click-through test of index.html against a fake backend (no real orders are made).
// Run from the project folder: node tools/test-ui.js [outDir]
// Serves the folder on localhost, intercepts calls to the Apps Script URL, and checks the main flows
// at desktop and phone width. Screenshots go to outDir (default: tools/out).
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('C:/Users/kevsc/Desktop/Claude/hyrox_pdf/node_modules/puppeteer');

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
fs.mkdirSync(out, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

let failures = 0;
function check(ok, label) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failures++;
}

const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port + '/';
  const browser = await puppeteer.launch({ headless: 'new' });

  // Fake backend state for each page.
  function mock(page, opts) {
    const state = { posts: [], open: opts.open !== false, failNext: !!opts.failFirstOrder };
    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('https://script.google.com/')) {
        if (/fonts\.(googleapis|gstatic)\.com/.test(url) || url.startsWith(base) || url.startsWith('data:')) return req.continue();
        return req.abort();
      }
      const headers = { 'Access-Control-Allow-Origin': '*' };
      if (req.method() === 'GET') {
        return req.respond({ status: 200, headers, contentType: 'application/json',
          body: JSON.stringify({ ok: true, open: state.open, closesAt: '2026-12-07T05:59:59.000Z' }) });
      }
      const body = JSON.parse(req.postData() || '{}');
      state.posts.push(body);
      if (state.failNext) { state.failNext = false; return req.abort('failed'); }
      const items = body.items.map((i) => ({ item: i.sku, color: i.color, size: i.size, qty: i.qty, each: i.sku.indexOf('hoodie') >= 0 ? 50 : 25 }));
      const total = items.reduce((t, i) => t + i.qty * i.each, 0);
      return req.respond({ status: 200, headers, contentType: 'application/json',
        body: JSON.stringify({ ok: true, order: { no: 'KT-1001', total, pieces: 3, payment: body.payment, items } }) });
    });
    return state;
  }

  async function newPage(viewport, opts) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await page.setRequestInterception(true);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
    const state = mock(page, opts || {});
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await new Promise((r) => setTimeout(r, 600));
    return { page, errors, state };
  }

  const card = (id) => `.card[data-id="${id}"]`;
  // The page scrolls smoothly, so jump instantly before clicking or the click lands mid-scroll.
  const click = async (page, sel) => {
    await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await new Promise((r) => setTimeout(r, 120));
    await page.click(sel);
  };
  const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim());

  // ── Desktop: full flow with a dropped first request ──
  {
    const { page, errors, state } = await newPage({ width: 1366, height: 900 }, { failFirstOrder: true });
    await page.screenshot({ path: path.join(out, 'desktop-top.png') });
    check((await page.$$('.card')).length === 4, 'four designs on the page');
    check(/days left to order|closes/i.test(await text(page, '#countdown')), 'countdown shows: ' + await text(page, '#countdown'));
    check(!(await page.$eval('body', (b) => b.classList.contains('is-closed'))), 'store shows open');

    await click(page, card('grizz') + ' [data-act="add"]');
    check(await page.$(card('grizz') + ' .need') !== null, 'adding without a size asks for a size');
    check((await text(page, '#cartBadge')) === '0', 'nothing added without a size');

    await click(page, card('grizz') + ' [data-act="size"][data-val="M"]');
    await click(page, card('grizz') + ' [data-act="add"]');
    check((await text(page, '#cartBadge')) === '1', 'Grizz tee M added');

    await click(page, card('bronco') + ' [data-act="style"][data-val="2"]');
    check((await text(page, card('bronco') + ' [data-act="add"]')).includes('$50'), 'Bronco hoodie shows $50');
    check((await page.$eval(card('bronco') + ' .media img', (i) => i.getAttribute('src'))).includes('bronco-hoodie-back'), 'Bronco hoodie shows the back first');
    await click(page, card('bronco') + ' [data-act="view"][data-val="1"]');
    check((await page.$eval(card('bronco') + ' .media img', (i) => i.getAttribute('src'))).includes('bronco-hoodie-front'), 'Front button shows the front');
    await click(page, card('bronco') + ' [data-act="size"][data-val="L"]');
    await click(page, card('bronco') + ' [data-act="inc"]');
    check((await text(page, card('bronco') + ' [data-act="add"]')).includes('$100'), 'qty 2 hoodie shows $100');
    await click(page, card('bronco') + ' [data-act="add"]');

    await click(page, card('bronco') + ' [data-act="style"][data-val="0"]');
    check((await text(page, card('bronco') + ' [data-act="add"]')).includes('$30'), 'Bronco camo tee shows $30');
    check((await text(page, card('bronco') + ' [data-act="style"][data-val="1"]')).replace(/\s+/g, ' ') === 'Long Sleeve $40', 'Bronco style button reads "Long Sleeve $40"');
    await click(page, card('bronco') + ' [data-act="style"][data-val="1"]');
    check((await text(page, card('bronco') + ' [data-act="add"]')).includes('$40'), 'Bronco long sleeve shows $40');

    check((await page.$$(card('university') + ' [data-act="size"][data-val="XS"]')).length === 0, 'University tee has no XS');
    await click(page, card('university') + ' [data-act="color"][data-val="1"]');
    check((await page.$eval(card('university') + ' .media img', (i) => i.getAttribute('src'))).includes('berry'), 'Berry swatch shows the berry shirt');
    await click(page, card('university') + ' [data-act="size"][data-val="S"]');
    await click(page, card('university') + ' [data-act="add"]');

    await click(page, card('united-kingdom') + ' [data-act="style"][data-val="1"]');
    check((await text(page, card('united-kingdom') + ' .sub')).startsWith('Independent'), 'UK hoodie is Independent');
    check((await text(page, card('united-kingdom') + ' [data-act="add"]')).includes('$50'), 'UK hoodie shows $50');

    check((await text(page, '#cartBadge')) === '4', 'badge counts 4 pieces');
    check((await text(page, '#grandTotal')) === '$150.00', 'total $150.00 (25 + 2×50 + 25)');

    await click(page, '.line [data-line="inc"]');
    check((await text(page, '#grandTotal')) === '$175.00', 'line + raises the total to $175.00');
    await click(page, '.line [data-line="remove"]');
    check((await text(page, '#grandTotal')) === '$125.00', 'remove drops the Grizz line: $125.00');

    await click(page, '#placeBtn');
    check((await page.$$('.field.invalid')).length === 4, 'empty info shows 4 field errors');
    check(await page.$('#pays.invalid') !== null, 'missing payment is flagged');
    check(state.posts.length === 0, 'nothing sent while the form is incomplete');

    await page.type('#first', 'Test');
    await page.type('#last', 'Buyer');
    await page.type('#email', 'test.buyer@example.com');
    await page.type('#phone', '918 555 0142');
    await click(page, '.pay[data-pay="venmo"]');
    check((await text(page, '.pay[data-pay="venmo"] .js-total')) === '$125.00', 'Venmo choice repeats the total');
    await page.screenshot({ path: path.join(out, 'desktop-checkout.png'), fullPage: false });

    await click(page, '#placeBtn');
    await new Promise((r) => setTimeout(r, 800));
    check(await page.$eval('#toast', (t) => t.classList.contains('error')), 'a dropped request shows an error and keeps the order');
    check((await text(page, '#cartBadge')) === '3', 'cart kept after the failed send');
    await click(page, '#placeBtn');
    await page.waitForSelector('dialog[open]', { timeout: 5000 });
    check(state.posts.length === 2 && state.posts[0].key === state.posts[1].key, 'the retry reuses the same order key');
    const sent = state.posts[1];
    check(sent.payment === 'venmo' && sent.customer.first === 'Test' && sent.customer.phone === '918 555 0142', 'payment and customer sent');
    check(JSON.stringify(sent.items) === JSON.stringify([
      { sku: 'bronco-hoodie', color: 'Deadwood Camo', size: 'L', qty: 2 },
      { sku: 'university-tee', color: 'Berry', size: 'S', qty: 1 },
    ]), 'items sent: ' + JSON.stringify(sent.items));
    check(!('price' in sent.items[0]), 'no prices are sent from the page');
    const venmo = await page.$eval('.btn-venmo', (a) => a.href);
    check(/recipients=Senorespy/.test(venmo) && /amount=125\.00/.test(venmo) && /KT-1001/.test(decodeURIComponent(venmo)), 'Venmo link: ' + venmo);
    await page.screenshot({ path: path.join(out, 'desktop-done.png') });
    await click(page, '#doneBtn');
    check((await text(page, '#cartBadge')) === '0' && (await page.$eval('#first', (i) => i.value)) === '', 'Done clears the order and the form');
    check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await page.screenshot({ path: path.join(out, 'desktop-full.png'), fullPage: true });
    await page.close();
  }

  // ── Phone: layout, PushPress flow ──
  {
    const { page, errors, state } = await newPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, 'no sideways scrolling at 390px (overflow ' + overflow + ')');
    await page.screenshot({ path: path.join(out, 'phone-top.png') });
    await page.$eval('#shop', (el) => el.scrollIntoView());
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(out, 'phone-card.png') });
    await click(page, card('united-kingdom') + ' [data-act="size"][data-val="XL"]');
    await click(page, card('united-kingdom') + ' [data-act="add"]');
    await new Promise((r) => setTimeout(r, 400));
    check(await page.$eval('#mbar', (m) => m.classList.contains('show')), 'phone order bar appears');
    await page.screenshot({ path: path.join(out, 'phone-bar.png') });
    await page.$eval('#checkout', (el) => el.scrollIntoView());
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: path.join(out, 'phone-checkout.png') });
    await page.type('#first', 'Pat');
    await page.type('#last', 'Member');
    await page.type('#email', 'pat@example.com');
    await page.type('#phone', '(918) 555-0199');
    await click(page, '.pay[data-pay="pushpress"]');
    await click(page, '#placeBtn');
    try {
      await page.waitForSelector('dialog[open]', { timeout: 5000 });
    } catch (e) {
      await page.screenshot({ path: path.join(out, 'phone-fail.png') });
      console.log('DEBUG', JSON.stringify(await page.evaluate(() => ({
        invalid: Array.from(document.querySelectorAll('.field.invalid')).map((f) => f.dataset.field),
        pays: document.getElementById('pays').className,
        checked: (document.querySelector('.pay input:checked') || {}).value,
        toast: document.getElementById('toast').textContent,
        place: document.getElementById('placeBtn').textContent,
        top: (() => { const r = document.getElementById('placeBtn').getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el && (el.id || el.className); })(),
      }))), 'posts', state.posts.length);
      throw e;
    }
    check(state.posts[0].payment === 'pushpress', 'PushPress choice sent');
    check(/PushPress/.test(await text(page, '#receipt')) && !(await page.$('.btn-venmo')), 'PushPress receipt has no Venmo button');
    await page.screenshot({ path: path.join(out, 'phone-done.png') });
    check(errors.length === 0, 'no page errors on phone' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await page.close();
  }

  // ── Closed store ──
  {
    const { page, errors } = await newPage({ width: 1366, height: 900 }, { open: false });
    check(await page.$eval('body', (b) => b.classList.contains('is-closed')), 'closed status from the backend closes the page');
    check((await page.$$('[data-act="add"]')).length === 0, 'no Add buttons when closed');
    check(await page.$eval('#checkout', (s) => getComputedStyle(s).display === 'none'), 'checkout hidden when closed');
    check(/Closed/.test(await text(page, '#heroEyebrow')), 'hero says closed');
    await page.screenshot({ path: path.join(out, 'desktop-closed.png') });
    check(errors.length === 0, 'no page errors when closed');
    await page.close();
  }

  await browser.close();
  server.close();
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
