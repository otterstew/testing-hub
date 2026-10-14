// Drives the hub in a real browser with a fake Supabase client: linking the
// defects that block a test, seeing them from both sides, jumping between the
// two, setting the result to Blocked, unlinking, and the spreadsheet export.
// No network, no account.
//
//   npm i playwright
//   node tests/blocking_test.js
//
// A browser is already present in CI-style images at PLAYWRIGHT_BROWSERS_PATH;
// set CHROME_PATH to point somewhere else.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-10-14T09:00:00Z';
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at },
  { kind: 'test', rid: 'RUL-01', data: { id: 'RUL-01', _o: 1, section: 'Rules', objective: 'Add a rule to an existing criterion', status: 'Not run' }, updated_at: at },
  { kind: 'test', rid: 'RUL-02', data: { id: 'RUL-02', _o: 2, section: 'Rules', objective: 'Map answers to scores', status: 'Fail' }, updated_at: at },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Rules', summary: 'Rule does not save', severity: 'High', status: 'Open' }, updated_at: at },
  { kind: 'defect', rid: 'D-02', data: { id: 'D-02', date: '2026-10-13', area: 'Settings', summary: 'History shows the wrong time', severity: 'Low', status: 'Fixed' }, updated_at: at },
  { kind: 'defect', rid: 'D-03', data: { id: 'D-03', date: '2026-10-12', area: 'Rules', summary: 'Gone', severity: 'Low', status: 'Open', deleted: { at: at, reason: 'Duplicate' } }, updated_at: at },
];

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const stored = (rid) => page.evaluate((rid) => (window.__db.records.find(r => r.rid === rid) || {}).data, rid);
  const saved = () => page.waitForFunction(() => /All changes saved/.test((document.querySelector('.mode') || {}).textContent || ''));
  const T1 = 'details.item[data-id="RUL-01"]', D1 = 'details.item[data-id="D-01"]';

  await page.goto(hub.base + '#tests');
  await page.waitForSelector(T1);
  await page.click(T1 + ' summary');

  // --- the picker ---
  check('a test says nothing is linked yet', /None linked/.test(await page.locator(T1 + ' .body').innerText()));
  const groups = await page.locator('#bl-RUL-01 optgroup').evaluateAll(gs => gs.map(g => g.label + ':' + [...g.children].map(o => o.value).join(',')));
  check('the list offers open defects first, then fixed ones', JSON.stringify(groups) === '["Open:D-01","Fixed or closed:D-02"]', groups);
  check('…and leaves out deleted defects', await page.locator('#bl-RUL-01 option[value="D-03"]').count() === 0);
  check('each choice shows the status and summary', /D-01 · Open · Rule does not save/.test(await page.locator('#bl-RUL-01 option[value="D-01"]').innerText()));

  // --- link one ---
  await page.selectOption('#bl-RUL-01', 'D-01');
  await page.waitForSelector(T1 + ' .blk-chip');
  await saved();
  check('linking stores it on the test', JSON.stringify((await stored('RUL-01')).blockedBy) === '["D-01"]', (await stored('RUL-01')).blockedBy);
  check('the test keeps open after linking', await page.locator(T1 + '[open]').count() === 1);
  check('the linked defect shows with its status', /D-01\s+Rule does not save/.test(await page.locator(T1 + ' .blk-chip').innerText()) && /Open/.test(await page.locator(T1 + ' .blk-chip .pill').innerText()));
  check('a linked defect is no longer offered', await page.locator('#bl-RUL-01 option[value="D-01"]').count() === 0);
  check('the test row says what blocks it', /blocked by D-01/.test(await page.locator(T1 + ' summary').innerText()));

  // --- set the result ---
  check('it offers to set the result to Blocked', await page.locator(T1 + ' [data-act="set-blocked"]').count() === 1);
  await page.click(T1 + ' [data-act="set-blocked"]');
  await saved();
  check('Set result to Blocked does that', (await stored('RUL-01')).status === 'Blocked' && /Blocked/.test(await page.locator(T1 + ' summary .pill').innerText()));
  check('…and the offer goes away', await page.locator(T1 + ' [data-act="set-blocked"]').count() === 0);

  // --- link a second test to the same defect ---
  await page.click('details.item[data-id="RUL-02"] summary');
  await page.selectOption('#bl-RUL-02', 'D-01');
  await saved();

  // --- the defect side ---
  await page.click('[data-tab="defects"]');
  await page.waitForSelector(D1);
  check('the defect row counts the tests it blocks', /blocks 2 tests/.test(await page.locator(D1 + ' summary').innerText()));
  await page.click(D1 + ' summary');
  const blocking = await page.locator(D1 + ' .blk-chip').allInnerTexts();
  check('the defect lists the tests it blocks, with their results', blocking.length === 2 && /RUL-01[\s\S]*Blocked/.test(blocking[0]) && /RUL-02[\s\S]*Fail/.test(blocking[1]), blocking);
  check('the defect history records the links', /D-01: blocking RUL-01/.test(await page.locator(D1 + ' .log').innerText()));
  check('a defect blocking nothing shows no list', await page.locator('details.item[data-id="D-02"] .blk').count() === 0);

  // --- jump across ---
  await page.click(D1 + ' .blk-go >> nth=1');
  await page.waitForSelector('details.item[data-id="RUL-02"][open]');
  check('tapping a test opens it on the Test cases tab', (await page.locator('[data-tab="tests"]').getAttribute('aria-selected')) === 'true');
  await page.click('details.item[data-id="RUL-02"] .blk-go');
  await page.waitForSelector(D1 + '[open]');
  check('tapping a defect opens it on the Defects tab', (await page.locator('[data-tab="defects"]').getAttribute('aria-selected')) === 'true');
  // a filter that hides the target is cleared
  await page.fill('#f-dq', 'nothing matches this');
  await page.click('[data-tab="tests"]');
  await page.click(T1 + ' summary');
  await page.click(T1 + ' .blk-go');
  await page.waitForSelector(D1 + '[open]');
  check('jumping clears a search that would hide the defect', (await page.inputValue('#f-dq')) === '');

  // --- unlink ---
  await page.click('[data-tab="tests"]');
  await page.click(T1 + ' summary');
  await page.click(T1 + ' [data-act="unblock"]');
  await saved();
  check('× unlinks it', JSON.stringify((await stored('RUL-01')).blockedBy) === '[]' && /None linked/.test(await page.locator(T1 + ' .body').innerText()));
  check('…the result is left as it was', (await stored('RUL-01')).status === 'Blocked');
  check('…and the defect is offered again', await page.locator('#bl-RUL-01 option[value="D-01"]').count() === 1);
  await page.click('[data-tab="defects"]');
  check('the defect now blocks one test', /blocks 1 test\b/.test(await page.locator(D1 + ' summary').innerText()));

  // --- spreadsheet ---
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export"]')]);
  const file = await dl.path();
  const rows = await page.evaluate(async (b64) => {
    const wb = XLSX.read(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { type: 'array' });
    return XLSX.utils.sheet_to_json(wb.Sheets['Test cases'], { header: 1, defval: '' });
  }, require('fs').readFileSync(file).toString('base64'));
  const col = rows[0].indexOf('Blocked by defects');
  check('the export has a Blocked by defects column', col >= 0, rows[0]);
  check('…listing the links', rows[1][col] === '' && rows[2][col] === 'D-01', rows.map(r => r[col]));

  await browser.close(); hub.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
