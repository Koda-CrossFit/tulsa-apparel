// Admin requests to the live store backend: node tools/admin.js <action> ['{"extra":"json"}']
// Actions: adminList, adminSetup, adminDelete {"orders":["KT-1001"]}, adminResetCounter,
//          adminSummaryPreview {"now":"2026-12-07T14:00:00Z"}, adminShare {"email":"..."}, adminEditors
// The key is read from Kevin's credentials folder; only its SHA-256 is in Code.js.
const fs = require('fs');

const KEY_FILE = 'C:/Users/kevsc/Desktop/Claude/Credentials - SENSITIVE Do Not Share/koda-tulsa-apparel-admin-key.txt';
const API = 'https://script.google.com/macros/s/AKfycbxIViWiqdWGze2y5mL6FQ1LhMdD2o9OQD7yTvZhIpbeU9N5qvdVq0j-0ObedoIEIdzj/exec';

(async () => {
  const action = process.argv[2];
  if (!action) throw new Error('usage: node tools/admin.js <action> [json]');
  const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const adminKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action, adminKey }, extra)),
    redirect: 'follow',
  });
  const text = await res.text();
  let out;
  try {
    out = JSON.parse(text);
  } catch (e) {
    console.error('HTTP ' + res.status + ': ' + text.slice(0, 300));
    process.exit(1);
  }
  if (process.argv.includes('--html') && out.html) {
    fs.writeFileSync(process.argv[process.argv.indexOf('--html') + 1], out.html);
    delete out.html;
  }
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
