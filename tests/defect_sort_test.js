// Drives the hub in a real browser with a fake Supabase client: the Defects
// tab's sort, by ID (the default) and by area. No network, no account.
//
//   npm i playwright
//   node tests/defect_sort_test.js
//
// A browser is already present in CI-style images at PLAYWRIGHT_BROWSERS_PATH;
// set CHROME_PATH to point somewhere else.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-10-14T09:00:00Z';
// Areas out of order, one in lower case, and IDs that sort wrongly as text (D-10).
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Scoring', summary: 'One', severity: 'High', status: 'Open' }, updated_at: at },
  { kind: 'defect', rid: 'D-02', data: { id: 'D-02', date: '2026-10-14', area: 'Rules', summary: 'Two', severity: 'Low', status: 'Open' }, updated_at: at },
  { kind: 'defect', rid: 'D-03', data: { id: 'D-03', date: '2026-10-14', area: 'admin', summary: 'Three', severity: 'Medium', status: 'Fixed' }, updated_at: at },
  { kind: 'defect', rid: 'D-10', data: { id: 'D-10', date: '2026-10-14', area: 'Rules', summary: 'Ten', severity: 'High', status: 'Open' }, updated_at: at },
  { kind: 'defect', rid: 'D-04', data: { id: 'D-04', date: '2026-10-14', area: 'Rules', summary: 'Four', severity: 'High', status: 'Open' }, updated_at: at },
];

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const order = () => page.$$eval('.list details.item', els => els.map(e => e.getAttribute('data-id')).join(' '));

  await page.goto(hub.base + '#defects');
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

  await browser.close(); hub.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
