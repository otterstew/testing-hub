// Drives the hub with a fake Supabase client: a test case can be marked Invalid,
// which leaves it out of the run totals, and a test's own wording (objective,
// pre-conditions, steps, test data, expected result) can be edited in place.
// No network, no account.
//
//   npm i playwright
//   node tests/wording_invalid_test.js
//
// Set CHROME_PATH to use a browser other than Playwright's own.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-11-10T09:00:00Z';
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at },
  { kind: 'test', rid: 'RUL-01', data: { id: 'RUL-01', _o: 1, section: 'Rules', objective: 'Add a rule', steps: 'Open Rules, add a rul', expected: 'The rule saves', status: 'Pass' }, updated_at: at },
  { kind: 'test', rid: 'RUL-02', data: { id: 'RUL-02', _o: 2, section: 'Rules', objective: 'Map answers to scores', status: 'Not run' }, updated_at: at },
  { kind: 'test', rid: 'RUL-03', data: { id: 'RUL-03', _o: 3, section: 'Rules', objective: 'Remove a rule', status: 'Not run' }, updated_at: at },
];

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const item = id => `details.item[data-id="${id}"]`;
  const stored = rid => page.evaluate(rid => (window.__db.records.find(r => r.rid === rid) || {}).data, rid);
  const saved = () => page.waitForFunction(() => /All changes saved/.test((document.querySelector('.mode') || {}).textContent || ''));
  const tabCount = () => page.locator('[data-tab="tests"] .n').innerText();

  // --- 1. Invalid is a result, and it leaves the totals ---
  await page.goto(hub.base + '#tests/RUL-03');
  await page.waitForSelector(item('RUL-03') + '[open]');
  check('the tab counts 1 of 3 run before', (await tabCount()) === '1/3', await tabCount());
  await page.selectOption('#st-RUL-03', 'Invalid');
  await saved();
  check('Invalid is saved as the result', (await stored('RUL-03')).status === 'Invalid', await stored('RUL-03'));
  check('…and the tab now counts 1 of 2', (await tabCount()) === '1/2', await tabCount());
  check('…with its own pill', await page.locator(item('RUL-03') + ' summary .pill.s-invalid').count() === 1);
  await page.click('[data-tab="overview"]');
  const legend = await page.locator('.legend').innerText();
  check('the overview names it as not counted', /Invalid, not counted\s*1/.test(legend), legend);
  check('…and it is not in "next to run"', !(await page.locator('main').innerText()).includes('Remove a rule'));

  // --- 2. a test's wording can be edited in place ---
  await page.goto(hub.base + '#tests/RUL-01');
  await page.waitForSelector(item('RUL-01') + '[open]');
  await page.click(item('RUL-01') + ' [data-act="edit-wording"]');
  await page.waitForSelector('#tw-steps-RUL-01');
  check('the boxes start with the current wording', (await page.inputValue('#tw-steps-RUL-01')) === 'Open Rules, add a rul');
  await page.fill('#tw-steps-RUL-01', 'Open Rules, add a rule');
  await page.locator('#tw-steps-RUL-01').blur();
  await page.fill('#tw-expected-RUL-01', 'The rule saves with its weighting');
  await page.locator('#tw-expected-RUL-01').blur();
  await page.fill('#tw-pre-RUL-01', 'Signed in as an admin');
  await page.click(item('RUL-01') + ' [data-act="done-wording"]');
  await saved();
  const r1 = await stored('RUL-01');
  check('steps, expected and a new pre-condition save', r1.steps === 'Open Rules, add a rule' && r1.expected === 'The rule saves with its weighting' && r1.pre === 'Signed in as an admin', r1);
  check('the result is untouched', r1.status === 'Pass', r1);
  const body = await page.locator(item('RUL-01') + ' .body').innerText();
  check('Done shows the new wording read-only again', /add a rule\b/.test(body) && /with its weighting/.test(body) && !(await page.locator('#tw-steps-RUL-01').count()), body.slice(0, 200));
  await page.click('[data-tab="overview"]');
  const log = await page.locator('ul.log').innerText().catch(() => '');
  check('each change is in the activity log', /RUL-01: steps → Open Rules, add a rule/.test(log), log.slice(0, 200));

  check('no page errors', errors.length === 0, errors);
  await browser.close(); hub.close && hub.close();
  let fail = 0;
  for (const r of results) { if (!r.ok) fail++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.ok ? '' : '  ' + JSON.stringify(r.extra))); }
  console.log(`${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
