// Drives the hub in a real browser with a fake Supabase client: the Defects
// tab's sort, by ID (the default) and by area. No network, no account.
//
//   npm i playwright
//   node tests/defect_sort_test.js
//
// A browser is already present in CI-style images at PLAYWRIGHT_BROWSERS_PATH;
// set CHROME_PATH to point somewhere else.

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Stands in for vendor/supabase.js, with defects whose areas are out of order.
const FAKE = `
window.__db = {
  records: [
    { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Scoring', summary: 'One', severity: 'High', status: 'Open' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'defect', rid: 'D-02', data: { id: 'D-02', date: '2026-10-14', area: 'Rules', summary: 'Two', severity: 'Low', status: 'Open' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'defect', rid: 'D-03', data: { id: 'D-03', date: '2026-10-14', area: 'admin', summary: 'Three', severity: 'Medium', status: 'Fixed' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'defect', rid: 'D-10', data: { id: 'D-10', date: '2026-10-14', area: 'Rules', summary: 'Ten', severity: 'High', status: 'Open' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'defect', rid: 'D-04', data: { id: 'D-04', date: '2026-10-14', area: 'Rules', summary: 'Four', severity: 'High', status: 'Open' }, updated_at: '2026-10-14T09:00:00Z' }
  ],
  log: []
};
(function () {
  function q(table) {
    var self = {
      select: function () { return self; }, range: function () { return self; }, order: function () { return self; },
      limit: function () { return self; }, eq: function () { return self; },
      upsert: function () { return self; }, insert: function () { return self; }, delete: function () { return self; },
      then: function (ok, bad) {
        var data = table === 'th_records' ? JSON.parse(JSON.stringify(window.__db.records)) : window.__db.log;
        return Promise.resolve({ data: data, error: null }).then(ok, bad);
      }
    };
    return self;
  }
  var none = function () { return Promise.resolve({ data: null, error: null }); };
  window.supabase = { createClient: function () { return {
    auth: {
      onAuthStateChange: function (cb) { setTimeout(function () { cb('SIGNED_IN', { user: { id: 'u1', email: 'tester@example.com' } }); }, 0); },
      signOut: function () { return Promise.resolve(); }
    },
    from: q,
    storage: { from: function () { return { upload: none, download: none, remove: none, createSignedUrl: none }; } }
  }; } };
})();
`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/vendor/supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(FAKE); }
  const file = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const order = () => page.$$eval('.list details.item', els => els.map(e => e.getAttribute('data-id')).join(' '));

  await page.goto(BASE + '#defects');
  await page.waitForSelector('details.item[data-id="D-01"]');

  check('defects list by ID to begin with', await order() === 'D-01 D-02 D-03 D-04 D-10', await order());
  check('the sort menu starts on ID', await page.inputValue('#f-dsort') === '');

  await page.selectOption('#f-dsort', 'area');
  check('Sort by area puts areas A–Z, ignoring case, then ID within an area', await order() === 'D-03 D-02 D-04 D-10 D-01', await order());
  check('…and the menu keeps the choice', await page.inputValue('#f-dsort') === 'area');

  await page.selectOption('#f-dstatus', 'open');
  check('it still sorts by area under a status filter', await order() === 'D-02 D-04 D-10 D-01', await order());
  await page.fill('#f-dq', 'o');
  check('…and while searching', await order() === 'D-02 D-04 D-01', await order());
  await page.fill('#f-dq', '');
  await page.selectOption('#f-dstatus', '');

  await page.selectOption('#f-dsort', '');
  check('Sort by ID puts them back', await order() === 'D-01 D-02 D-03 D-04 D-10', await order());

  await browser.close(); server.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
