// Koda Tulsa Apparel Preorder: the backend for https://koda-crossfit.github.io/tulsa-apparel/
//
// Bound to the Google Sheet "Koda Tulsa Apparel Preorder — Orders". It runs as kevschuetz3@gmail.com, and anyone
// with the store link can place an order without an account. Prices come from CATALOG below, never from the page.
//
// Tabs (setup() lays them out and is safe to run again):
//   Orders       One row per order: who it is, how they're paying, and Paid / Picked Up check boxes.
//                Items, Pieces and Total are formulas over Order Lines, so an edit there updates the order.
//   Order Lines  One row per item. Change a size or quantity here.
//   Totals       What to order from the printer (item, color, size) and the money by payment type.
//   Settings     When the store closes and who gets the Monday summary.
//   About        How to use the sheet.
//
// The only email this script sends is weeklySummary(): Mondays at 8 AM Central, to the address(es) on Settings.
// After the store closes it sends one final summary and removes its own trigger.

const SHEET_ID = '1OzEEQo238fERGIFq6eI2z902rAvxeA528LJQn-cYUEo';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit';
const STORE_URL = 'https://koda-crossfit.github.io/tulsa-apparel/';
const TZ = 'America/Chicago';
const DEFAULT_CLOSE = '2026-12-06T23:59:59-06:00';
const DEFAULT_SUMMARY_TO = 'chris@kodacrossfittulsa.com';
const ORDER_PREFIX = 'KT-';
const FIRST_ORDER_NO = 1001;
// SHA-256 of the admin key kept in Kevin's credentials folder. Admin requests are only for setup, tests and checks.
const ADMIN_KEY_SHA256 = 'e43494c55a0da780d0950c9131637d9336071eeec08419e3d077b5f61abefaae';

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const CC_SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL'];

// The page sends the sku. Prices are whole dollars. The order here is the order rows appear on Totals.
const CATALOG = {
  'grizz-tee': { item: 'Koda Grizz Tee', brand: 'Bella+Canvas', price: 25, colors: ['Vintage White'], sizes: SIZES },
  'bronco-tee': { item: 'Koda Bronco Camo Tee', brand: 'Independent', price: 30, colors: ['Deadwood Camo'], sizes: SIZES },
  // Was the $50 crewneck until 11/10/2026; the sku stays the same so saved carts keep working.
  'bronco-crew': { item: 'Koda Bronco Camo Long Sleeve', brand: 'Independent', price: 40, colors: ['Deadwood Camo'], sizes: SIZES },
  'bronco-hoodie': { item: 'Koda Bronco Camo Hoodie', brand: 'Independent', price: 50, colors: ['Deadwood Camo'], sizes: SIZES },
  'uk-tee': { item: 'Koda United Kingdom Tee', brand: 'Bella+Canvas', price: 25, colors: ['Black'], sizes: SIZES },
  'uk-hoodie': { item: 'Koda United Kingdom Hoodie', brand: 'Independent', price: 50, colors: ['Black'], sizes: SIZES },
  'university-tee': { item: 'Koda University Tee', brand: 'Comfort Colors', price: 25, colors: ['Bay', 'Berry'], sizes: CC_SIZES },
};
const PAYMENTS = { pushpress: 'PushPress', venmo: 'Venmo' };

const TABS = { orders: 'Orders', lines: 'Order Lines', totals: 'Totals', settings: 'Settings', about: 'About' };
const ORDER_HEADERS = ['Order #', 'Placed', 'Name', 'Email', 'Phone', 'Items', 'Pieces', 'Total', 'Payment', 'Paid', 'Picked Up', 'Notes'];
const LINE_HEADERS = ['Order #', 'Placed', 'Name', 'Item', 'Brand', 'Color', 'Size', 'Qty', 'Each', 'Line Total', 'Payment'];
const OL = "'Order Lines'!";
const MAX_LINES = 30;
const MAX_QTY = 20;
const MAX_PIECES = 60;
const TEAL = '#02afad';
const INK = '#101418';

// ─── Web app ─────────────────────────────────────────────────────────────────────────────────────────

// Read-only: is the store open, and when does it close?
function doGet() {
  return reply_(() => status_());
}

// Every call from the page: {action: 'order' | 'status', ...}. Admin calls carry adminKey.
function doPost(e) {
  return reply_(() => {
    let req;
    try {
      req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (err) {
      return { ok: false, code: 'bad_request' };
    }
    const action = String(req.action || '');
    if (action === 'status') return status_();
    if (action === 'order') return withLock_(() => placeOrder_(req));
    if (action.indexOf('admin') === 0) {
      if (!isAdmin_(req.adminKey)) return { ok: false, code: 'forbidden' };
      return withLock_(() => admin_(req));
    }
    return { ok: false, code: 'bad_request' };
  });
}

function reply_(fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    console.error((err && err.stack) || err);
    out = { ok: false, code: 'server_error' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, code: 'busy' };
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function status_() {
  const close = closeAt_();
  return { ok: true, open: Date.now() <= close.getTime(), closesAt: close.toISOString() };
}

// ─── Orders ──────────────────────────────────────────────────────────────────────────────────────────

function placeOrder_(req) {
  if (req.website) return { ok: false, code: 'bad_request' }; // hidden field people never see; bots fill it in
  const close = closeAt_();
  if (Date.now() > close.getTime()) return { ok: false, code: 'closed', closesAt: close.toISOString() };

  // The page sends the same key again if it retries, so a retry never makes a second order.
  const key = String(req.key || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return { ok: false, code: 'bad_request' };
  const cache = CacheService.getScriptCache();
  const seen = cache.get('order:' + key);
  if (seen) return JSON.parse(seen);

  const c = req.customer || {};
  const first = clean_(c.first, 40);
  const last = clean_(c.last, 40);
  const email = clean_(c.email, 120).toLowerCase();
  const phone = phone_(c.phone);
  const payment = PAYMENTS[req.payment];
  if (!first || !last) return { ok: false, code: 'bad_request', field: 'name' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { ok: false, code: 'bad_request', field: 'email' };
  if (!phone) return { ok: false, code: 'bad_request', field: 'phone' };
  if (!payment) return { ok: false, code: 'bad_request', field: 'payment' };

  const items = Array.isArray(req.items) ? req.items : [];
  if (!items.length || items.length > MAX_LINES) return { ok: false, code: 'bad_request', field: 'items' };
  const lines = [];
  for (const it of items) {
    const p = CATALOG[it && it.sku];
    const color = String((it && it.color) || '');
    const size = String((it && it.size) || '');
    const qty = Number(it && it.qty);
    if (!p || p.colors.indexOf(color) < 0 || p.sizes.indexOf(size) < 0) return { ok: false, code: 'bad_item' };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { ok: false, code: 'bad_item' };
    const same = lines.find((l) => l.sku === it.sku && l.color === color && l.size === size);
    if (same) same.qty += qty;
    else lines.push({ sku: it.sku, item: p.item, brand: p.brand, color: color, size: size, qty: qty, each: p.price });
  }
  const pieces = lines.reduce((s, l) => s + l.qty, 0);
  if (pieces > MAX_PIECES) return { ok: false, code: 'too_many' };
  const total = lines.reduce((s, l) => s + l.qty * l.each, 0);

  const ss = ss_();
  const orders = tab_(ss, TABS.orders);
  const lineSh = tab_(ss, TABS.lines);
  const no = nextOrderNo_(orders);
  const now = new Date();
  const name = first + ' ' + last;

  const row = Math.max(orders.getLastRow(), 1) + 1;
  orders.getRange(row, 1, 1, ORDER_HEADERS.length).setValues([[
    no, now, text_(name), text_(email), text_(phone),
    itemsFormula_(row), '=SUMIFS(' + OL + '$H$2:$H,' + OL + '$A$2:$A,$A' + row + ')',
    '=SUMIFS(' + OL + '$J$2:$J,' + OL + '$A$2:$A,$A' + row + ')',
    payment, false, false, '',
  ]]);
  orders.getRange(row, 10, 1, 2).insertCheckboxes();

  const first_ = Math.max(lineSh.getLastRow(), 1) + 1;
  lineSh.getRange(first_, 1, lines.length, LINE_HEADERS.length).setValues(lines.map((l, i) => [
    no, now, text_(name), l.item, l.brand, l.color, l.size, l.qty, l.each, '=H' + (first_ + i) + '*I' + (first_ + i), payment,
  ]));
  SpreadsheetApp.flush();

  const out = {
    ok: true,
    order: {
      no: no,
      total: total,
      pieces: pieces,
      payment: req.payment,
      items: lines.map((l) => ({ item: l.item, color: l.color, size: l.size, qty: l.qty, each: l.each })),
    },
  };
  cache.put('order:' + key, JSON.stringify(out), 21600);
  return out;
}

// "2× Koda Grizz Tee · Vintage White · M", one item per line, read live from Order Lines.
function itemsFormula_(row) {
  return '=IFERROR(TEXTJOIN(CHAR(10),TRUE,FILTER(' +
    OL + '$H$2:$H&"× "&' + OL + '$D$2:$D&" · "&' + OL + '$F$2:$F&" · "&' + OL + '$G$2:$G,' +
    OL + '$A$2:$A=$A' + row + ',' + OL + '$H$2:$H>0)),"")';
}

// KT-1001, KT-1002, ... A number is never reused, even when an order row is deleted.
function nextOrderNo_(orders) {
  const props = PropertiesService.getScriptProperties();
  let n = Number(props.getProperty('LAST_ORDER_NO')) || FIRST_ORDER_NO - 1;
  orderNos_(orders).forEach((no) => {
    const m = /^KT-(\d+)$/i.exec(no);
    if (m) n = Math.max(n, Number(m[1]));
  });
  n += 1;
  props.setProperty('LAST_ORDER_NO', String(n));
  return ORDER_PREFIX + n;
}

function orderNos_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getDisplayValues().map((r) => String(r[0]).trim()).filter(String);
}

// ─── Settings ────────────────────────────────────────────────────────────────────────────────────────

function settings_() {
  const sh = ss_().getSheetByName(TABS.settings);
  const map = {};
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach((r) => {
      map[String(r[0]).trim().toLowerCase()] = r[1];
    });
  }
  let close = map['orders close'];
  if (!(close instanceof Date) || isNaN(close.getTime())) {
    const parsed = close ? new Date(close) : null;
    close = parsed && !isNaN(parsed.getTime()) ? parsed : new Date(DEFAULT_CLOSE);
  }
  const rawTo = 'weekly summary to' in map ? String(map['weekly summary to']) : DEFAULT_SUMMARY_TO;
  const to = rawTo.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
  return { closeAt: close, summaryTo: to.join(',') };
}

// Cached for a minute so page loads don't each open the sheet. A Settings change shows up within a minute.
function closeAt_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('closeAt');
  if (hit) return new Date(Number(hit));
  const d = settings_().closeAt;
  cache.put('closeAt', String(d.getTime()), 60);
  return d;
}

// ─── Weekly summary ──────────────────────────────────────────────────────────────────────────────────

// Runs Mondays at 8 AM Central (setup() makes the trigger). This is the only email the store sends.
function weeklySummary() {
  const s = settings_();
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const closed = now.getTime() > s.closeAt.getTime();
  if (closed && props.getProperty('FINAL_SENT')) {
    removeSummaryTrigger_();
    return;
  }
  if (!s.summaryTo) return;
  const since = new Date(Number(props.getProperty('LAST_SUMMARY_AT')) || now.getTime() - 7 * 864e5);
  const m = buildSummary_(since, now, s);
  MailApp.sendEmail({ to: s.summaryTo, subject: m.subject, htmlBody: m.html, body: m.text, name: 'Koda Tulsa Apparel' });
  props.setProperty('LAST_SUMMARY_AT', String(now.getTime()));
  if (closed) {
    props.setProperty('FINAL_SENT', String(now.getTime()));
    removeSummaryTrigger_();
  }
}

function buildSummary_(since, now, s) {
  const ss = ss_();
  const orders = values_(ss.getSheetByName(TABS.orders), ORDER_HEADERS.length)
    .filter((r) => String(r[0]).trim())
    .map((r) => ({
      no: String(r[0]).trim(),
      placed: r[1] instanceof Date ? r[1] : new Date(r[1]),
      name: String(r[2]),
      items: String(r[5]),
      pieces: Number(r[6]) || 0,
      total: Number(r[7]) || 0,
      payment: String(r[8]).trim(),
      paid: r[9] === true,
      picked: r[10] === true,
    }));
  const lines = values_(ss.getSheetByName(TABS.lines), LINE_HEADERS.length)
    .filter((r) => String(r[0]).trim() && Number(r[7]) > 0)
    .map((r) => ({ item: String(r[3]).trim(), color: String(r[5]).trim(), size: String(r[6]).trim(), qty: Number(r[7]) }));

  const closed = now.getTime() > s.closeAt.getTime();
  const fresh = orders.filter((o) => o.placed.getTime() >= since.getTime());
  const pieces = lines.reduce((t, l) => t + l.qty, 0);
  const sales = orders.reduce((t, o) => t + o.total, 0);
  const money = ['PushPress', 'Venmo'].map((p) => {
    const list = orders.filter((o) => o.payment === p);
    const total = list.reduce((t, o) => t + o.total, 0);
    const paid = list.filter((o) => o.paid).reduce((t, o) => t + o.total, 0);
    return { payment: p, count: list.length, total: total, paid: paid, open: total - paid };
  });
  const waiting = orders.filter((o) => o.payment === 'Venmo' && !o.paid);

  // What to order: one row per item and color, in catalog order, plus anything typed in by hand.
  const rows = [];
  Object.keys(CATALOG).forEach((sku) => {
    const p = CATALOG[sku];
    p.colors.forEach((color) => rows.push({ item: p.item, color: color, sizes: p.sizes, counts: {}, total: 0 }));
  });
  lines.forEach((l) => {
    let row = rows.find((r) => r.item === l.item && r.color === l.color);
    if (!row) {
      row = { item: l.item, color: l.color, sizes: SIZES, counts: {}, total: 0 };
      rows.push(row);
    }
    row.counts[l.size] = (row.counts[l.size] || 0) + l.qty;
    row.total += l.qty;
  });
  const sizeCols = SIZES.slice();
  lines.forEach((l) => {
    if (sizeCols.indexOf(l.size) < 0) sizeCols.push(l.size);
  });

  const day = (d) => Utilities.formatDate(d, TZ, 'EEEE, MMMM d');
  const closeLabel = day(s.closeAt) + ' at ' + Utilities.formatDate(s.closeAt, TZ, 'h:mm a');
  const daysLeft = Math.round((dayStart_(s.closeAt) - dayStart_(now)) / 864e5);
  const status = closed
    ? 'The preorder closed ' + closeLabel + '. These are the final numbers to order from.'
    : 'The store is open until ' + closeLabel + ' (' + (daysLeft <= 0 ? 'last day' : daysLeft === 1 ? '1 day left' : daysLeft + ' days left') + ').';
  const subject = closed
    ? 'Koda Tulsa apparel preorder: final summary'
    : 'Koda Tulsa apparel preorder: weekly summary, ' + Utilities.formatDate(now, TZ, 'MMM d');
  const usd = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const sinceLabel = Utilities.formatDate(since, TZ, 'MMM d');

  const th = 'padding:8px 10px;border-bottom:2px solid ' + INK + ';text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#555;';
  const thc = th + 'text-align:center;';
  const td = 'padding:8px 10px;border-bottom:1px solid #e3e5e7;font-size:14px;vertical-align:top;';
  const tdc = td + 'text-align:center;';
  const tdr = td + 'text-align:right;white-space:nowrap;';
  const h2 = 'font:700 17px/1.3 Helvetica,Arial,sans-serif;color:' + INK + ';margin:28px 0 10px;';

  const kpi = (label, value) =>
    '<td style="padding:14px 16px;background:#f4f5f5;border-radius:10px;width:33%;">' +
    '<div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#666;">' + label + '</div>' +
    '<div style="font:800 24px/1.2 Helvetica,Arial,sans-serif;color:' + INK + ';margin-top:4px;">' + value + '</div></td>';

  const matrix =
    '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">' +
    '<tr><th style="' + th + '">Item</th><th style="' + th + '">Color</th>' +
    sizeCols.map((z) => '<th style="' + thc + '">' + esc(z) + '</th>').join('') + '<th style="' + thc + '">Total</th></tr>' +
    rows.map((r) => '<tr><td style="' + td + '">' + esc(r.item) + '</td><td style="' + td + '">' + esc(r.color) + '</td>' +
      sizeCols.map((z) => {
        if (r.sizes.indexOf(z) < 0 && !r.counts[z]) return '<td style="' + tdc + 'color:#c4c8cb;">–</td>';
        const n = r.counts[z] || 0;
        return '<td style="' + tdc + (n ? 'font-weight:700;color:' + INK + ';' : 'color:#c4c8cb;') + '">' + (n || '·') + '</td>';
      }).join('') +
      '<td style="' + tdc + 'font-weight:800;color:' + INK + ';">' + r.total + '</td></tr>').join('') +
    '<tr><td style="' + td + 'font-weight:800;" colspan="2">All items</td>' +
    sizeCols.map((z) => {
      const n = rows.reduce((t, r) => t + (r.counts[z] || 0), 0);
      return '<td style="' + tdc + 'font-weight:800;">' + (n || '·') + '</td>';
    }).join('') +
    '<td style="' + tdc + 'font-weight:800;">' + pieces + '</td></tr></table>';

  const moneyTable =
    '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">' +
    '<tr><th style="' + th + '">Payment</th><th style="' + thc + '">Orders</th><th style="' + th + 'text-align:right;">Total</th>' +
    '<th style="' + th + 'text-align:right;">Marked paid</th><th style="' + th + 'text-align:right;">Still to collect</th></tr>' +
    money.map((m) => '<tr><td style="' + td + '">' + (m.payment === 'PushPress' ? 'Bill to PushPress' : 'Venmo @Senorespy') + '</td>' +
      '<td style="' + tdc + '">' + m.count + '</td><td style="' + tdr + '">' + usd(m.total) + '</td>' +
      '<td style="' + tdr + '">' + usd(m.paid) + '</td><td style="' + tdr + 'font-weight:700;">' + usd(m.open) + '</td></tr>').join('') +
    '</table>';

  const orderTable = (list) =>
    '<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;">' +
    '<tr><th style="' + th + '">Order</th><th style="' + th + '">Name</th><th style="' + th + '">Items</th>' +
    '<th style="' + th + '">Pay</th><th style="' + th + 'text-align:right;">Total</th></tr>' +
    list.map((o) => '<tr><td style="' + td + 'white-space:nowrap;">' + esc(o.no) +
      '<div style="font-size:12px;color:#888;">' + Utilities.formatDate(o.placed, TZ, 'MMM d') + '</div></td>' +
      '<td style="' + td + '">' + esc(o.name) + '</td>' +
      '<td style="' + td + 'font-size:13px;">' + esc(o.items).replace(/\n/g, '<br>') + '</td>' +
      '<td style="' + td + '">' + esc(o.payment) + (o.paid ? ' <span style="color:#017a78;">✓</span>' : '') + '</td>' +
      '<td style="' + tdr + '">' + usd(o.total) + '</td></tr>').join('') +
    '</table>';

  const button = (href, label, primary) =>
    '<a href="' + href + '" style="display:inline-block;margin:0 8px 8px 0;padding:12px 18px;border-radius:10px;text-decoration:none;font:700 14px Helvetica,Arial,sans-serif;' +
    (primary ? 'background:' + INK + ';color:#fff;' : 'background:#fff;color:' + INK + ';border:1.5px solid #d3d7da;') + '">' + label + '</a>';

  const html =
    '<div style="background:#f4f5f5;padding:24px 12px;">' +
    '<div style="max-width:680px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #e3e5e7;font-family:Helvetica,Arial,sans-serif;color:#2d3236;">' +
    '<div style="background:' + TEAL + ';color:#fff;padding:18px 24px;font:700 13px Helvetica,Arial,sans-serif;letter-spacing:.14em;">KODA CROSSFIT TULSA · APPAREL PREORDER</div>' +
    '<div style="padding:24px;">' +
    '<h1 style="font:800 26px/1.2 Helvetica,Arial,sans-serif;color:' + INK + ';margin:0 0 8px;">' + (closed ? 'Final summary' : 'Weekly summary') + '</h1>' +
    '<p style="margin:0 0 18px;font-size:15px;">' + esc(status) + '</p>' +
    '<table role="presentation" cellspacing="8" cellpadding="0" style="width:100%;margin:0 -8px;"><tr>' +
    kpi('Orders', orders.length + (fresh.length ? ' <span style="font-size:14px;color:#017a78;">+' + fresh.length + ' new</span>' : '')) +
    kpi('Pieces', pieces) + kpi('Sales', usd(sales)) + '</tr></table>' +
    '<h2 style="' + h2 + '">What to order</h2>' + matrix +
    '<h2 style="' + h2 + '">Money</h2>' + moneyTable +
    '<p style="font-size:13px;color:#666;margin:8px 0 0;">"Marked paid" counts the Paid boxes on the Orders tab. Check one when you\'ve charged the PushPress account or the Venmo has come in.</p>' +
    (waiting.length ? '<h2 style="' + h2 + '">Venmo not marked paid yet (' + waiting.length + ')</h2>' + orderTable(waiting) : '') +
    '<h2 style="' + h2 + '">New since ' + esc(sinceLabel) + ' (' + fresh.length + ')</h2>' +
    (fresh.length ? orderTable(fresh) : '<p style="font-size:14px;color:#666;margin:0;">No new orders this week.</p>') +
    '<div style="margin-top:28px;">' + button(SHEET_URL, 'Open the orders sheet', true) + button(STORE_URL, 'Open the store', false) + '</div>' +
    '</div>' +
    '<div style="padding:16px 24px;background:#f9fafa;border-top:1px solid #e3e5e7;font-size:12px;color:#777;">' +
    (closed ? 'This is the last summary. ' : 'Sent Mondays at 8 AM Central. ') +
    'Change who gets it, or the closing date, on the Settings tab of the orders sheet.</div>' +
    '</div></div>';

  const text = [
    (closed ? 'Final summary' : 'Weekly summary') + ': Koda Tulsa apparel preorder',
    status,
    '',
    'Orders: ' + orders.length + ' (' + fresh.length + ' new since ' + sinceLabel + ')',
    'Pieces: ' + pieces,
    'Sales: ' + usd(sales),
    '',
    'WHAT TO ORDER',
  ].concat(rows.filter((r) => r.total).map((r) => r.item + ' (' + r.color + '): ' +
    sizeCols.filter((z) => r.counts[z]).map((z) => z + ' ' + r.counts[z]).join(', ') + ' = ' + r.total))
    .concat(['', 'MONEY'])
    .concat(money.map((m) => m.payment + ': ' + m.count + ' orders, ' + usd(m.total) + ', ' + usd(m.paid) + ' marked paid, ' + usd(m.open) + ' still to collect'))
    .concat(['', 'NEW SINCE ' + sinceLabel.toUpperCase()])
    .concat(fresh.length ? fresh.map((o) => o.no + '  ' + o.name + '  ' + usd(o.total) + ' ' + o.payment + '  ' + o.items.replace(/\n/g, '; ')) : ['None'])
    .concat(['', 'Orders sheet: ' + SHEET_URL, 'Store: ' + STORE_URL])
    .join('\n');

  return { subject: subject, html: html, text: text, to: s.summaryTo };
}

function dayStart_(d) {
  const p = Utilities.formatDate(d, TZ, 'yyyy-MM-dd').split('-').map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}

function removeSummaryTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'weeklySummary')
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

// ─── Setup ───────────────────────────────────────────────────────────────────────────────────────────

// Run once from the editor to approve the script's permissions. It lays out the sheet and makes the
// Monday trigger. Running it again only fills in what's missing and remakes the trigger.
function setup() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(TZ);
  setupSheets_(ss);
  removeSummaryTrigger_();
  ScriptApp.newTrigger('weeklySummary').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).nearMinute(0).inTimezone(TZ).create();
  const msg = 'Sheet ready; weekly summary trigger set for Mondays at 8 AM Central';
  console.log(msg);
  return msg;
}

function setupSheets_(ss) {
  const sheets = ss.getSheets();
  let orders = ss.getSheetByName(TABS.orders);
  if (!orders) {
    const blank = sheets.find((sh) => /^Sheet\d*$/.test(sh.getName()) && sh.getLastRow() === 0);
    orders = blank ? blank.setName(TABS.orders) : ss.insertSheet(TABS.orders);
  }
  if (orders.getLastRow() === 0) {
    header_(orders, ORDER_HEADERS, [86, 150, 170, 220, 120, 380, 64, 90, 100, 60, 86, 240]);
    orders.getRange('B2:B').setNumberFormat('m/d/yyyy h:mm am/pm');
    orders.getRange('G2:G').setNumberFormat('0').setHorizontalAlignment('center');
    orders.getRange('H2:H').setNumberFormat('$#,##0.00');
    orders.getRange('J2:K').setHorizontalAlignment('center');
    orders.getRange('F2:F').setWrap(true);
    orders.getRange('A2:L').setVerticalAlignment('top');
  }

  let lines = ss.getSheetByName(TABS.lines) || ss.insertSheet(TABS.lines);
  if (lines.getLastRow() === 0) {
    header_(lines, LINE_HEADERS, [86, 150, 170, 230, 120, 130, 60, 56, 76, 90, 100]);
    lines.getRange('B2:B').setNumberFormat('m/d/yyyy h:mm am/pm');
    lines.getRange('G2:H').setHorizontalAlignment('center');
    lines.getRange('I2:J').setNumberFormat('$#,##0.00');
  }

  const totals = ss.getSheetByName(TABS.totals) || ss.insertSheet(TABS.totals);
  if (totals.getLastRow() === 0) layoutTotals_(totals);

  const settings = ss.getSheetByName(TABS.settings) || ss.insertSheet(TABS.settings);
  if (settings.getLastRow() === 0) {
    header_(settings, ['Setting', 'Value', 'How it works'], [190, 330, 560]);
    settings.getRange(2, 1, 2, 3).setValues([
      ['Orders close', new Date(DEFAULT_CLOSE),
        'The store stops taking orders after this date and time (Central). Change it to extend the preorder or close it early. The site picks up the change within a minute or two.'],
      ['Weekly summary to', DEFAULT_SUMMARY_TO,
        'Gets the order summary every Monday at 8 AM Central, plus a final one the Monday after the store closes. Separate more than one address with commas. Leave it blank to stop the emails.'],
    ]);
    settings.getRange('B2').setNumberFormat('dddd, mmmm d, yyyy "at" h:mm AM/PM');
    settings.getRange('A2:C3').setVerticalAlignment('top').setWrap(true);
    settings.getRange('A2:A3').setFontWeight('bold');
  }

  const about = ss.getSheetByName(TABS.about) || ss.insertSheet(TABS.about);
  if (about.getLastRow() === 0) layoutAbout_(about);

  [TABS.orders, TABS.lines, TABS.totals, TABS.settings, TABS.about].forEach((name, i) => {
    ss.setActiveSheet(ss.getSheetByName(name));
    ss.moveActiveSheet(i + 1);
  });
  ss.setActiveSheet(ss.getSheetByName(TABS.orders));
}

function header_(sh, headers, widths) {
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(TEAL).setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  sh.setRowHeight(1, 30);
  widths.forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

function layoutTotals_(sh) {
  sh.getRange('A1').setValue('What to order').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('Counts every row on Order Lines, so they always match the orders. Sizes a garment doesn\'t come in show a dash.')
    .setFontColor('#666666');
  const head = ['Item', 'Brand', 'Color'].concat(SIZES, ['Pieces', 'Sales']);
  sh.getRange(4, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(TEAL);
  const variants = [];
  Object.keys(CATALOG).forEach((sku) => {
    const p = CATALOG[sku];
    p.colors.forEach((color) => variants.push({ p: p, color: color }));
  });
  const first = 5;
  const sizeCol = (i) => String.fromCharCode(68 + i); // D..J
  const rows = variants.map((v, k) => {
    const r = first + k;
    const cells = SIZES.map((z, i) => v.p.sizes.indexOf(z) < 0 ? '–' :
      '=SUMIFS(' + OL + '$H$2:$H,' + OL + '$D$2:$D,$A' + r + ',' + OL + '$F$2:$F,$C' + r + ',' + OL + '$G$2:$G,' + sizeCol(i) + '$4)');
    return [v.p.item, v.p.brand, v.color].concat(cells, [
      '=SUM(D' + r + ':J' + r + ')',
      '=SUMIFS(' + OL + '$J$2:$J,' + OL + '$D$2:$D,$A' + r + ',' + OL + '$F$2:$F,$C' + r + ')',
    ]);
  });
  sh.getRange(first, 1, rows.length, head.length).setValues(rows);
  const end = first + rows.length - 1;
  const totalRow = end + 1;
  sh.getRange(totalRow, 1, 1, head.length).setValues([['All items', '', ''].concat(
    SIZES.map((z, i) => '=SUM(' + sizeCol(i) + first + ':' + sizeCol(i) + end + ')'),
    ['=SUM(K' + first + ':K' + end + ')', '=SUM(L' + first + ':L' + end + ')'])]).setFontWeight('bold');
  sh.getRange(totalRow, 1, 1, head.length).setBorder(true, null, null, null, null, null, INK, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange(first, 4, rows.length + 1, SIZES.length + 1).setNumberFormat('#,##0;-#,##0;"·"').setHorizontalAlignment('center');
  sh.getRange(first, 12, rows.length + 1, 1).setNumberFormat('$#,##0.00');
  sh.getRange(first, 4, rows.length, SIZES.length).setFontColor(INK);

  const m = totalRow + 3;
  sh.getRange(m, 1).setValue('Money').setFontSize(14).setFontWeight('bold');
  sh.getRange(m + 1, 1, 1, 5).setValues([['Payment', 'Orders', 'Total', 'Marked paid', 'Still to collect']])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground(TEAL);
  const pay = (label, r) => [label,
    '=COUNTIF(Orders!$I$2:$I,"' + label + '")',
    '=SUMIF(Orders!$I$2:$I,"' + label + '",Orders!$H$2:$H)',
    '=SUMIFS(Orders!$H$2:$H,Orders!$I$2:$I,"' + label + '",Orders!$J$2:$J,TRUE)',
    '=C' + r + '-D' + r];
  sh.getRange(m + 2, 1, 3, 5).setValues([
    pay('PushPress', m + 2),
    pay('Venmo', m + 3),
    ['All orders', '=B' + (m + 2) + '+B' + (m + 3), '=C' + (m + 2) + '+C' + (m + 3), '=D' + (m + 2) + '+D' + (m + 3), '=E' + (m + 2) + '+E' + (m + 3)],
  ]);
  sh.getRange(m + 4, 1, 1, 5).setFontWeight('bold')
    .setBorder(true, null, null, null, null, null, INK, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sh.getRange(m + 2, 2, 3, 1).setHorizontalAlignment('center');
  sh.getRange(m + 2, 3, 3, 3).setNumberFormat('$#,##0.00');
  sh.getRange(m + 6, 1).setValue('Check Paid on the Orders tab when you\'ve charged someone\'s PushPress account or their Venmo has come in.')
    .setFontColor('#666666');

  [250, 120, 130].concat(SIZES.map(() => 52), [70, 100]).forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(4);
}

function layoutAbout_(sh) {
  const lines = [
    ['Koda Tulsa Apparel Preorder'],
    ['Store: ' + STORE_URL],
    [''],
    ['Orders: one row per order. Check Paid once you\'ve charged their PushPress account or their Venmo has come in. Check Picked Up when they get their gear. Notes is yours to use.'],
    ['Order Lines: one row per item. To change a size, color or quantity, edit it here. Orders and Totals update by themselves.'],
    ['To cancel an order, delete its row on Orders and its rows on Order Lines. Order numbers are never reused.'],
    ['To add an order for someone, the easiest way is to place it for them on the store.'],
    ['Totals: what to order from the printer by item, color and size, and the money by payment type.'],
    ['Settings: when the store closes, and who gets the summary email every Monday at 8 AM Central.'],
    [''],
    ['Venmo payments go to @Senorespy. Each Venmo note has the order number, like KT-1001.'],
    ['PushPress orders: charge the amount on the Orders tab to that person\'s PushPress account.'],
    ['Nobody gets an email when an order comes in: the Monday summary is the only email the store sends.'],
    [''],
    ['Please don\'t rename the tabs or the column headers: the store writes to them by name.'],
  ];
  sh.getRange(1, 1, lines.length, 1).setValues(lines).setWrap(true).setVerticalAlignment('top');
  sh.getRange('A1').setFontSize(16).setFontWeight('bold');
  sh.setColumnWidth(1, 900);
}

// ─── Admin (setup, tests and checks) ─────────────────────────────────────────────────────────────────

function isAdmin_(key) {
  if (!key || typeof key !== 'string' || key.length > 200) return false;
  const hex = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8)
    .map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  return hex === ADMIN_KEY_SHA256;
}

function admin_(req) {
  const ss = ss_();
  const props = PropertiesService.getScriptProperties();
  switch (req.action) {
    case 'adminSetup':
      return { ok: true, result: setup() };
    case 'adminList':
      return {
        ok: true,
        orders: displayRows_(ss.getSheetByName(TABS.orders)),
        lines: displayRows_(ss.getSheetByName(TABS.lines)),
        totals: displayRows_(ss.getSheetByName(TABS.totals)),
        settings: displayRows_(ss.getSheetByName(TABS.settings)),
        lastOrderNo: props.getProperty('LAST_ORDER_NO'),
        lastSummaryAt: props.getProperty('LAST_SUMMARY_AT'),
        finalSent: props.getProperty('FINAL_SENT'),
        triggers: ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction() + ' ' + t.getEventType()),
        status: status_(),
      };
    case 'adminDelete': {
      const nos = (Array.isArray(req.orders) ? req.orders : []).map(String);
      if (!nos.length) return { ok: false, code: 'bad_request' };
      return { ok: true, orders: deleteRows_(ss.getSheetByName(TABS.orders), nos), lines: deleteRows_(ss.getSheetByName(TABS.lines), nos) };
    }
    case 'adminResetCounter':
      if (orderNos_(ss.getSheetByName(TABS.orders)).length) return { ok: false, code: 'orders_exist' };
      props.setProperty('LAST_ORDER_NO', String(FIRST_ORDER_NO - 1));
      props.deleteProperty('LAST_SUMMARY_AT');
      return { ok: true };
    case 'adminShare': {
      // Gives someone edit access to the sheet, which includes this script (Extensions > Apps Script).
      const email = clean_(req.email, 120).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, code: 'bad_request' };
      ss.addEditor(email);
      return { ok: true, editors: ss.getEditors().map((u) => u.getEmail()) };
    }
    case 'adminCatalog':
      return { ok: true, catalog: CATALOG };
    case 'adminRenameItem': {
      // Renames an item on Totals (column A) and on Order Lines (column D), e.g. after a catalog name change.
      const from = clean_(req.from, 80);
      const to = clean_(req.to, 80);
      if (!from || !to) return { ok: false, code: 'bad_request' };
      const renamed = {};
      [[TABS.totals, 1], [TABS.lines, 4]].forEach((t) => {
        const sh = ss.getSheetByName(t[0]);
        let n = 0;
        if (sh && sh.getLastRow() >= 1) {
          const rng = sh.getRange(1, t[1], sh.getLastRow(), 1);
          const vals = rng.getValues();
          vals.forEach((r) => {
            if (String(r[0]).trim() === from) {
              r[0] = to;
              n++;
            }
          });
          if (n) rng.setValues(vals);
        }
        renamed[t[0]] = n;
      });
      return { ok: true, renamed: renamed };
    }
    case 'adminEditors':
      return { ok: true, editors: ss.getEditors().map((u) => u.getEmail()), viewers: ss.getViewers().map((u) => u.getEmail()) };
    case 'adminSummaryPreview': {
      const s = settings_();
      const now = req.now ? new Date(req.now) : new Date();
      const m = buildSummary_(new Date(now.getTime() - 7 * 864e5), now, s);
      return { ok: true, subject: m.subject, to: m.to, html: m.html, text: m.text };
    }
    default:
      return { ok: false, code: 'bad_request' };
  }
}

function deleteRows_(sh, nos) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const vals = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  let n = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (nos.indexOf(String(vals[i][0]).trim()) >= 0) {
      sh.deleteRow(i + 2);
      n++;
    }
  }
  return n;
}

function displayRows_(sh) {
  if (!sh || sh.getLastRow() === 0) return [];
  return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────────

function ss_() {
  return SpreadsheetApp.openById(SHEET_ID);
}

function tab_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    setupSheets_(ss);
    sh = ss.getSheetByName(name);
  }
  return sh;
}

function values_(sh, width) {
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues();
}

function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A leading apostrophe keeps what people type as plain text, so nothing they enter can become a formula.
function text_(s) {
  return s ? "'" + s : '';
}

function phone_(v) {
  const raw = clean_(v, 30);
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  if (d.length === 11 && d[0] === '1') return d.slice(1, 4) + '-' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length >= 7 && d.length <= 15) return raw;
  return '';
}
