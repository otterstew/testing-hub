// Drives the hub in a real browser with a fake Supabase client: IDs written in
// text link to their item, each item lists what references it, links work from
// a row's summary line, the overview and the activity log, Back returns to where
// you were, and #tab/id opens an item straight away. No network, no account.
//
//   npm i playwright
//   node tests/crossref_test.js
//
// A browser is already present in CI-style images at PLAYWRIGHT_BROWSERS_PATH;
// set CHROME_PATH to point somewhere else.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-10-14T09:00:00Z';
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at },
  { kind: 'test', rid: 'RUL-01', data: { id: 'RUL-01', _o: 1, section: 'Rules', objective: 'Add a rule to an existing criterion', status: 'Blocked', data: 'Use party TP-01. Not RUL-010 or 2026-10-14.', steps: 'See Q1 first. RUL-01 is this test.', expected: 'Saved', blockedBy: ['D-01'] }, updated_at: at },
  { kind: 'test', rid: 'RUL-02', data: { id: 'RUL-02', _o: 2, section: 'Rules', objective: 'Map answers to scores', status: 'Not run', steps: 'Repeat RUL-01 with a list rule' }, updated_at: at },
  { kind: 'party', rid: 'TP-01', data: { id: 'TP-01', _o: 1, name: 'ISRA High Ltd', module: 'Investor', type: 'Company', purpose: 'High-risk company', values: 'Country = Iran', related: 'TP-02 as BO', tests: 'RUL-01, RUL-02', expectedNow: 'Low', expectedFinal: 'High' }, updated_at: at },
  { kind: 'party', rid: 'TP-02', data: { id: 'TP-02', _o: 2, name: 'ISRA BO', module: 'Investor', type: 'BO', purpose: 'BO of TP-01', tests: 'RUL-02', expectedNow: 'Low', expectedFinal: 'Low' }, updated_at: at },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Rules', summary: 'Rule does not save', severity: 'High', status: 'Open', ref: 'RUL-01', steps: 'Seen on TP-01' }, updated_at: at },
  { kind: 'defect', rid: 'D-02', data: { id: 'D-02', date: '2026-10-13', area: 'Rules', summary: 'Score ignores the new field', severity: 'Medium', status: 'Open', ref: 'RUL-02' }, updated_at: at },
  { kind: 'question', rid: '1', data: { n: 1, q: 'Does a config change re-score customers?', a: '', tests: 'RUL-01', status: 'Open' }, updated_at: at },
];

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const item = id => `details.item[data-id="${id}"]`;
  const tabOn = async tab => (await page.locator(`[data-tab="${tab}"]`).getAttribute('aria-selected')) === 'true';
  const links = sel => page.locator(sel + ' a.ref').evaluateAll(as => as.map(a => a.textContent));

  // --- a test: links in its text, and what references it ---
  await page.goto(hub.base + '#tests');
  await page.waitForSelector(item('RUL-01'));
  await page.click(item('RUL-01') + ' summary');
  check('test data links the party it uses', JSON.stringify(await links(item('RUL-01') + ' .body .field:has(> .lab:text-is("Test data"))')) === '["TP-01"]');
  check('…and not a longer ID or a date', !/RUL-010|2026/.test((await links(item('RUL-01') + ' .body')).join(' ')));
  check('a test does not link to itself', JSON.stringify(await links(item('RUL-01') + ' .body .field:has(> .lab:text-is("Steps"))')) === '["Q1"]');
  check('the row links the defect blocking it', JSON.stringify(await links(item('RUL-01') + ' summary')) === '["D-01"]');
  const refBy = await page.locator(item('RUL-01') + ' .field:has(> .lab:text-matches("Referenced by")) .blk-chip').allInnerTexts();
  check('the test lists what references it: tests, parties, questions', refBy.length === 3 && /RUL-02/.test(refBy[0]) && /TP-01[\s\S]*ISRA High Ltd/.test(refBy[1]) && /Q1[\s\S]*Open/.test(refBy[2]), refBy);
  check('…less the defect already shown under Blocked by', !refBy.some(t => /D-01/.test(t)));

  // --- follow a link, then Back ---
  await page.click(item('RUL-01') + ' .field:has(> .lab:text-is("Test data")) a.ref');
  await page.waitForSelector(item('TP-01') + '[open]');
  check('a party link opens it on the Test parties tab', await tabOn('parties'));
  check('the party links the tests that use it', JSON.stringify(await links(item('TP-01') + ' .field:has(> .lab:text-is("Used by tests"))')) === '["RUL-01","RUL-02"]');
  check('…and the related party', JSON.stringify(await links(item('TP-01') + ' .field:has(> .lab:text-is("Related parties to add"))')) === '["TP-02"]');
  const pRef = await page.locator(item('TP-01') + ' .field:has(> .lab:text-matches("Referenced by")) .blk-chip').allInnerTexts();
  check('the party lists the test data, defect and party that mention it', pRef.length === 3 && /RUL-01/.test(pRef[0]) && /D-01/.test(pRef[1]) && /TP-02/.test(pRef[2]), pRef);
  await page.goBack();
  await page.waitForSelector(item('RUL-01') + '[open]');
  check('Back returns to the test, still open', await tabOn('tests'));

  // --- a defect's test ref ---
  await page.click('[data-tab="defects"]');
  check('the defect row links its test ref', JSON.stringify(await links(item('D-02') + ' summary')) === '["RUL-02"]');
  await page.click(item('D-02') + ' summary a.ref');
  await page.waitForSelector(item('RUL-02') + '[open]');
  check('the link on the row opens the test', await tabOn('tests'));
  const r2 = await page.locator(item('RUL-02') + ' .field:has(> .lab:text-matches("Referenced by")) .blk-chip').allInnerTexts();
  check('the test lists the defect raised against it', r2.some(t => /D-02[\s\S]*Score ignores/.test(t)), r2);
  await page.click(item('RUL-02') + ' .blk-go:has-text("D-02")');
  await page.waitForSelector(item('D-02') + '[open]');
  check('…which opens the defect', await tabOn('defects'));

  // --- questions ---
  await page.click('[data-tab="questions"]');
  check('a question links the tests it affects', JSON.stringify(await links(item('Q1') + ' summary')) === '["RUL-01"]');
  await page.click('[data-tab="tests"]');
  await page.click(item('RUL-01') + ' summary');
  await page.click(item('RUL-01') + ' .field:has(> .lab:text-is("Steps")) a.ref');
  await page.waitForSelector(item('Q1') + '[open]');
  check('a question link opens it on the Questions tab', await tabOn('questions'));

  // --- overview and activity ---
  await page.click('[data-tab="overview"]');
  check('the overview links the items it lists', (await page.locator('.att a.ref').evaluateAll(as => as.map(a => a.textContent))).join(',') === 'RUL-01,D-01,RUL-02,Q1');
  await page.click('[data-tab="parties"]');
  await page.click(item('TP-01') + ' summary');
  await page.selectOption('#pr-TP-01', 'High');
  await page.click('[data-tab="overview"]');
  check('the activity log links the IDs in it', /TP-01/.test((await links('.log')).join(' ')), await links('.log'));

  // --- an address opens an item ---
  const p2 = await ctx.newPage();
  await p2.goto(hub.base + '#defects/D-01');
  await p2.waitForSelector(item('D-01') + '[open]');
  check('#defects/D-01 opens that defect', true);
  await p2.close();

  await browser.close(); hub.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
