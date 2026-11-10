// Renders the favicon PNGs and the link-preview image (og-image.jpg) with headless Chrome.
// Run from the project folder: node tools/make-assets.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('C:/Users/kevsc/Desktop/Claude/hyrox_pdf/node_modules/puppeteer');

const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets');
const MARK = '<path d="M0 0H316L855 539L316 1078H0L539 539Z"/><path d="M566 0H882L1263 381L1645 0H1961L1422 539L1961 1078H1645L1263 697L882 1078H566L1105 539Z"/>';

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#02afad"/><svg x="10" y="18.5" width="44" height="27" viewBox="0 0 1961 1078" fill="#fff">${MARK}</svg></svg>`;
fs.writeFileSync(path.join(assets, 'favicon.svg'), favicon);

function img(name) {
  return 'data:image/webp;base64,' + fs.readFileSync(path.join(assets, 'products', name)).toString('base64');
}

const og = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; font-family: Inter, sans-serif; display: grid; grid-template-columns: 560px 640px; overflow: hidden; }
  .left { position: relative; padding: 56px 52px; color: #fff; background: linear-gradient(155deg, #02afad 0%, #029593 52%, #017c7a 100%); display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font: 700 22px/1 "Helvetica Neue", Helvetica, Arial, sans-serif; letter-spacing: .01em; }
  .brand svg { width: 46px; height: 25px; fill: #fff; }
  .tag { margin-top: 64px; display: inline-flex; align-self: flex-start; padding: 8px 16px; border-radius: 999px; background: rgba(255,255,255,.18); font-size: 17px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
  h1 { margin-top: 20px; font-size: 76px; line-height: .96; letter-spacing: -.04em; font-weight: 800; }
  .prices { margin-top: auto; display: flex; flex-wrap: wrap; gap: 10px; }
  .prices span { padding: 9px 15px; border-radius: 999px; background: #fff; color: #101418; font-size: 18px; font-weight: 600; }
  .prices b { color: #017a78; font-weight: 800; }
  .when { margin-top: 18px; font-size: 21px; font-weight: 600; }
  .right { background: #f3f4f4; padding: 34px; display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .right img { width: 100%; height: 100%; object-fit: cover; border-radius: 18px; box-shadow: 0 10px 26px rgba(16,20,24,.14); }
</style></head><body>
  <div class="left">
    <div class="brand"><svg viewBox="0 0 1961 1078">${MARK}</svg>KODA CROSSFIT TULSA</div>
    <div class="tag">Apparel preorder</div>
    <h1>Koda Tulsa<br>Apparel</h1>
    <div class="prices"><span><b>$25</b> Tees</span><span><b>$30</b> Camo tee</span><span><b>$40</b> Camo long sleeve</span><span><b>$50</b> Hoodies</span></div>
    <div class="when">Order by Sunday, December 6</div>
  </div>
  <div class="right">
    <img src="${img('grizz-tee-vintage-white.webp')}">
    <img src="${img('bronco-hoodie-back.webp')}">
    <img src="${img('university-tee-berry.webp')}">
    <img src="${img('uk-tee-black.webp')}">
  </div>
</body></html>`;

(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  for (const [file, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    // The apple icon is full-bleed (iOS rounds the corners itself).
    const svg = size === 180 ? favicon.replace('rx="14"', 'rx="0"') : favicon;
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(assets, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }

  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.setContent(og, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const inter = await page.evaluate(() => Promise.race([
    document.fonts.load('800 76px Inter').then(() => document.fonts.check('800 76px Inter')),
    new Promise((r) => setTimeout(() => r(false), 15000)),
  ]));
  await page.evaluate(() => Promise.all(Array.from(document.images).map((i) => i.decode().catch(() => null))));
  console.log('Inter loaded:', inter);
  await page.screenshot({ path: path.join(assets, 'og-image.jpg'), type: 'jpeg', quality: 86 });

  await browser.close();
  for (const f of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'og-image.jpg']) {
    console.log(f.padEnd(22), fs.statSync(path.join(assets, f)).size, 'bytes');
  }
})().catch((e) => { console.error(e); process.exit(1); });
