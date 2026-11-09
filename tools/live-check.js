// End-to-end check against the LIVE store and backend. It places clearly fake "Test Order" orders,
// checks what lands in the sheet, then deletes them and resets the order counter (only if no real orders exist).
// Run from the project folder: node tools/live-check.js [screenshotDir]
const fs = require('fs');
const path = require('path');
const puppeteer = require('C:/Users/kevsc/Desktop/Claude/hyrox_pdf/node_modules/puppeteer');

const SITE = 'https://koda-crossfit.github.io/tulsa-apparel/';
const API = 'https://script.google.com/macros/s/AKfycbxIViWiqdWGze2y5mL6FQ1LhMdD2o9OQD7yTvZhIpbeU9N5qvdVq0j-0ObedoIEIdzj/exec';
const KEY = fs.readFileSync('C:/Users/kevsc/Desktop/Claude/Credentials - SENSITIVE Do Not Share/koda-tulsa-apparel-admin-key.txt', 'utf8').trim();
const out = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
fs.mkdirSync(out, { recursive: true });

let failures = 0;
function check(ok, label) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failures++;
}
async function post(body) {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
  return JSON.parse(await r.text());
}
const admin = (action, extra) => post(Object.assign({ action, adminKey: KEY }, extra || {}));

(async () => {
  const before = await admin('adminList');
  const realBefore = before.orders.slice(1).filter((r) => !/^Test Order/.test(r[2]));
  if (realBefore.length) console.log('NOTE: ' + realBefore.length + ' real order(s) already on the sheet; the counter will not be reset.');

  // 1. Through the live page, the way a customer does it.
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(SITE, { waitUntil: 'networkidle2' });
  const click = async (sel) => {
    await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await new Promise((r) => setTimeout(r, 150));
    await page.click(sel);
  };
  await click('.card[data-id="bronco"] [data-act="style"][data-val="2"]');
  await click('.card[data-id="bronco"] [data-act="size"][data-val="L"]');
  await click('.card[data-id="bronco"] [data-act="add"]');
  await click('.card[data-id="university"] [data-act="size"][data-val="M"]');
  await click('.card[data-id="university"] [data-act="inc"]');
  await click('.card[data-id="university"] [data-act="add"]');
  await page.type('#first', 'Test Order');
  await page.type('#last', 'Venmo');
  await page.type('#email', 'test.venmo@example.com');
  await page.type('#phone', '918-555-0100');
  await click('.pay[data-pay="venmo"]');
  const t0 = Date.now();
  await click('#placeBtn');
  await page.waitForSelector('dialog[open]', { timeout: 60000 });
  console.log('live order saved in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  const receipt = await page.$eval('#receipt', (r) => r.innerText);
  const no = (receipt.match(/KT-\d+/) || [])[0];
  check(!!no, 'live page got an order number: ' + no);
  check(/Koda Bronco Camo Hoodie/.test(receipt) && /Koda University Tee/.test(receipt), 'receipt shows the real item names');
  check(/\$100\.00/.test(receipt), 'receipt total $100.00 (50 + 2×25)');
  const venmo = await page.$eval('.btn-venmo', (a) => a.href);
  check(/amount=100\.00/.test(venmo) && venmo.includes(no), 'Venmo link has the amount and ' + no);
  await page.screenshot({ path: path.join(out, 'live-receipt.png') });
  check(errors.length === 0, 'no page errors on the live site' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();

  // 2. Straight to the backend: PushPress, odd input, a retry with the same key, and a bad item.
  const key = 'livecheck' + Date.now();
  const order = {
    action: 'order', key, payment: 'pushpress',
    customer: { first: '=Test Order', last: '+PushPress', email: 'TEST.PushPress@Example.com', phone: '+1 (918) 555-0101' },
    items: [{ sku: 'grizz-tee', color: 'Vintage White', size: 'XS', qty: 1 }, { sku: 'grizz-tee', color: 'Vintage White', size: 'XS', qty: 2 }, { sku: 'uk-tee', color: 'Black', size: '3XL', qty: 1 }],
  };
  const a = await post(order);
  const b = await post(order);
  check(a.ok && a.order.total === 100 && a.order.pieces === 4, 'PushPress order: $100, 4 pieces (same lines merged)');
  check(b.ok && b.order.no === a.order.no, 'retry with the same key returns the same order (' + (b.order && b.order.no) + ')');
  check((await post(Object.assign({}, order, { key: key + 'x', items: [{ sku: 'university-tee', color: 'Bay', size: 'XS', qty: 1 }] }))).code === 'bad_item', 'XS University tee is refused');
  check((await post(Object.assign({}, order, { key: key + 'y', items: [{ sku: 'grizz-tee', color: 'Vintage White', size: 'M', qty: 1, price: 1 }] }))).ok === true, 'a price sent by a page is ignored (order still priced by the backend)');
  const cheap = await admin('adminList');
  const cheapRow = cheap.orders.find((r) => r[0] !== a.order.no && r[0] !== no && /^Test Order|^=Test/.test(r[2]));
  check(cheapRow && cheapRow[7] === '$25.00', 'that order was charged $25.00, not $1');
  check((await post(Object.assign({}, order, { key: key + 'z', website: 'http://spam' }))).ok === false, 'honeypot field blocks bots');

  // 3. What landed in the sheet.
  const list = await admin('adminList');
  const rowOf = (n) => list.orders.find((r) => r[0] === n);
  const r1 = rowOf(no);
  const r2 = rowOf(a.order.no);
  check(r1 && r1[2] === 'Test Order Venmo' && r1[8] === 'Venmo' && r1[7] === '$100.00' && r1[6] === '3', 'Orders row for the page order: ' + JSON.stringify(r1));
  check(r1 && r1[5].includes('1× Koda Bronco Camo Hoodie · Deadwood Camo · L') && r1[5].includes('2× Koda University Tee · Bay · M'), 'Items column reads Order Lines');
  check(r2 && r2[2] === '=Test Order +PushPress' && r2[4] === '918-555-0101' && r2[3] === 'test.pushpress@example.com', 'odd input stored as plain text: ' + JSON.stringify(r2 && r2.slice(2, 5)));
  check(r2 && r2[8] === 'PushPress' && r2[9] === 'FALSE' && r2[10] === 'FALSE', 'PushPress row has unchecked Paid / Picked Up boxes');
  const tot = (item, color) => list.totals.find((r) => r[0] === item && r[2] === color);
  check(tot('Koda Grizz Tee', 'Vintage White')[3] === '3', 'Totals: 3 Grizz XS');
  check(tot('Koda University Tee', 'Bay')[5] === '2', 'Totals: 2 University Bay M');
  check(tot('Koda Bronco Camo Hoodie', 'Deadwood Camo')[6] === '1', 'Totals: 1 Bronco hoodie L');
  const money = list.totals.find((r) => r[0] === 'Venmo');
  check(money && money[1] === '1' && money[2] === '$100.00' && money[4] === '$100.00', 'Money: Venmo 1 order, $100 still to collect');

  const prev = await admin('adminSummaryPreview');
  fs.writeFileSync(path.join(out, 'summary.html'), prev.html);
  check(prev.ok && prev.to === 'chris@kodacrossfittulsa.com', 'summary goes to ' + prev.to + ': "' + prev.subject + '"');
  const fin = await admin('adminSummaryPreview', { now: '2026-12-07T14:00:00Z' });
  fs.writeFileSync(path.join(out, 'summary-final.html'), fin.html);
  check(/final summary/i.test(fin.subject), 'after the close it is the final summary: "' + fin.subject + '"');

  // 4. Clean up every test order and reset the counter.
  const testNos = list.orders.slice(1).filter((r) => /^(=)?Test Order/.test(r[2])).map((r) => r[0]);
  const del = await admin('adminDelete', { orders: testNos });
  check(del.ok, 'deleted test orders ' + testNos.join(', ') + ' (' + del.orders + ' order rows, ' + del.lines + ' item rows)');
  const reset = await admin('adminResetCounter');
  const after = await admin('adminList');
  check(after.orders.length === 1 + realBefore.length, 'no test orders left on the sheet');
  if (!realBefore.length) check(reset.ok && after.lastOrderNo === '1000', 'counter reset: the first real order will be KT-1001');
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
