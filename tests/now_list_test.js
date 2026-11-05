// Drives the hub in a real browser with a fake Supabase client: long text stays on
// a phone screen, every defect field can be edited, fixing a defect sets the tests
// it held up to Retest (with Undo), a defect can be raised from a test, linked items
// open in a side panel, a question's status is a choice, and text being typed
// survives a save. No network, no account.
//
//   npm i playwright
//   node tests/now_list_test.js
//
// A browser is already present in CI-style images at PLAYWRIGHT_BROWSERS_PATH;
// set CHROME_PATH to point somewhere else.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-10-14T09:00:00Z';
const LONG = 'When a rule is saved with a weighting the weighting is lost and the score falls back to the default value for every party type';
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at },
  { kind: 'test', rid: 'RUL-01', data: { id: 'RUL-01', _o: 1, section: 'Rules (phase 2)', objective: 'Add a rule to an existing criterion', steps: 'Open Rules, add a rule', expected: 'The rule saves', actual: 'Weighting is lost on save', status: 'Blocked', blockedBy: ['D-01'] }, updated_at: at },
  { kind: 'test', rid: 'RUL-02', data: { id: 'RUL-02', _o: 2, section: 'Rules (phase 2)', objective: 'Map answers to scores', status: 'Fail', blockedBy: ['D-01', 'D-02'] }, updated_at: at },
  { kind: 'test', rid: 'RUL-03', data: { id: 'RUL-03', _o: 3, section: 'Rules (phase 2)', objective: 'Remove a rule', status: 'Pass', blockedBy: ['D-01'] }, updated_at: at },
  { kind: 'test', rid: 'RUL-04', data: { id: 'RUL-04', _o: 4, section: 'Rules (phase 2)', objective: 'Copy a rule', status: 'Not run', steps: 'See TP-01' }, updated_at: at },
  { kind: 'party', rid: 'TP-01', data: { id: 'TP-01', _o: 1, name: 'High risk company', module: 'Investor', type: 'Company', purpose: 'Used by RUL-04', tests: 'RUL-04', expectedNow: 'Low', expectedFinal: 'High' }, updated_at: at },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Rules', summary: LONG, steps: 'Seen on TP-01', severity: 'High', status: 'Open', ref: 'RUL-01' }, updated_at: at },
  { kind: 'defect', rid: 'D-02', data: { id: 'D-02', date: '2026-10-14', area: 'Rules', summary: 'Score ignores the new field', severity: 'Medium', status: 'Open' }, updated_at: at },
  { kind: 'question', rid: '1', data: { n: 1, q: 'Does a config change re-score customers?', a: '', tests: 'RUL-01', status: 'Open' }, updated_at: at },
  { kind: 'question', rid: '2', data: { n: 2, q: 'Who signs off?', a: 'The project lead', tests: '', status: 'Answered: by email 3 Oct' }, updated_at: at },
];

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const item = id => `details.item[data-id="${id}"]`;
  const stored = rid => page.evaluate(rid => (window.__db.records.find(r => r.rid === rid) || {}).data, rid);
  const saved = () => page.waitForFunction(() => /All changes saved/.test((document.querySelector('.mode') || {}).textContent || ''));
  const tabOn = async tab => (await page.locator(`[data-tab="${tab}"]`).getAttribute('aria-selected')) === 'true';
  // Opens an item's row unless it's open already (a click on an open row closes it).
  const openItem = async id => { if (!(await page.locator(item(id) + '[open]').count())) await page.click(item(id) + ' summary'); await page.waitForSelector(item(id) + '[open]'); };
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  // --- 1. long text stays on a phone screen ---
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(hub.base + '#tests/RUL-01');
  await page.waitForSelector(item('RUL-01') + '[open]');
  check('a test linked to a long defect fits a phone', await fits());
  check('…its defect picker too', await page.locator('#bl-RUL-01').evaluate(el => el.getBoundingClientRect().right <= window.innerWidth));
  check('picker choices are cut short', (await page.locator('#bl-RUL-01 option[value="D-02"]').innerText()).length <= 80);
  await page.goto(hub.base + '#defects/D-01');
  await page.waitForSelector(item('D-01') + '[open]');
  check('a long defect fits a phone', await fits());
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- 2. every defect field can be edited ---
  for (const [sel, val] of [['#da-D-02', 'Scoring'], ['#dtr-D-02', 'RUL-02'], ['#dsp-D-02', 'Open TP-01, save'], ['#drd-D-02', '2026-11-05']]) {
    await openItem('D-02');
    await page.fill(sel, val); await page.locator(sel).blur();
  }
  await saved();
  let d2 = await stored('D-02');
  check('area, test ref, steps and retest date save', d2.area === 'Scoring' && d2.ref === 'RUL-02' && d2.steps === 'Open TP-01, save' && d2.retestDate === '2026-11-05', d2);
  await openItem('D-02');
  const h2 = await page.locator(item('D-02') + ' .log').innerText().catch(e => 'ERR ' + e.message.slice(0, 80));
  check('…and each change is in the defect history', /D-02: test ref → RUL-02/.test(h2), h2);

  // --- 3. fixing a defect sets the tests it held up to Retest ---
  await openItem('D-01');
  await page.selectOption('#ds-D-01', 'Fixed');
  await saved();
  check('a Blocked test held up only by it becomes Retest', (await stored('RUL-01')).status === 'Retest');
  check('a test still blocked by another open defect is left alone', (await stored('RUL-02')).status === 'Fail');
  check('a passed test is left alone', (await stored('RUL-03')).status === 'Pass');
  check('the notice says what changed and why', /RUL-01 is now Retest: D-01 is Fixed/.test(await page.locator('.notice').first().innerText()));
  await page.click('[data-act="undo-free"]');
  await saved();
  check('Undo puts the result back', (await stored('RUL-01')).status === 'Blocked');
  // Reopen and fix again; then fixing the second blocker frees the test both were holding up.
  await page.selectOption('#ds-D-01', 'Open');
  await page.selectOption('#ds-D-01', 'Fixed');
  await saved();
  await openItem('D-02');
  await page.selectOption('#ds-D-02', 'Closed');
  await saved();
  check('a Fail test is set to Retest once its last blocker closes', (await stored('RUL-02')).status === 'Retest');
  await page.click('[data-tab="overview"]');
  check('the overview lists Retest tests first under Next to run', /^RUL-01/.test(await page.locator('h2:text-is("Next to run") + ul li').first().innerText()));
  check('…and Retest is in the legend', await page.locator('[data-go-status="Retest"]').count() === 1);

  // --- 4. raise a defect from a test ---
  await page.click('[data-tab="tests"]');
  await openItem('RUL-01');
  await page.click(item('RUL-01') + ' [data-act="raise-defect"]');
  await page.waitForSelector('#add-defect');
  check('it goes to the Defects tab', await tabOn('defects'));
  check('…with the area, test ref and actual result filled in', (await page.inputValue('#nd-area')) === 'Rules' && (await page.inputValue('#nd-ref')) === 'RUL-01' && (await page.inputValue('#nd-sum')) === 'Weighting is lost on save');
  check('…and the steps and expected result copied', /Steps: Open Rules[\s\S]*Expected: The rule saves/.test(await page.inputValue('#nd-steps')));
  check('…ready to type in', await page.evaluate(() => document.activeElement.id) === 'nd-sum');
  await page.fill('#nd-sum', 'Weighting lost when a rule is saved');
  await page.click('[data-tab="overview"]');
  await page.click('[data-tab="defects"]');
  check('the draft survives switching tabs', (await page.inputValue('#nd-sum')) === 'Weighting lost when a rule is saved');
  await page.click('#add-defect button[type="submit"]');
  await saved();
  const d3 = await stored('D-03');
  check('the new defect is saved', d3 && d3.ref === 'RUL-01' && d3.area === 'Rules' && d3.summary === 'Weighting lost when a rule is saved', d3);
  check('…and linked to the test as blocking it', JSON.stringify((await stored('RUL-01')).blockedBy) === '["D-01","D-03"]');
  check('the form is empty again', (await page.inputValue('#nd-area')) === '' && await page.locator('#nd-link').count() === 0);
  await page.goBack();
  await page.waitForSelector(item('RUL-01') + '[open]');
  check('Back returns to the test', await tabOn('tests'));

  // --- 5. the side panel ---
  await page.click(item('RUL-01') + ' .blk-go:has-text("D-03")');
  await page.waitForSelector('#peek');
  check('a linked defect opens beside the test', /Defect\s+D-03/.test(await page.locator('#peek .peek-kind').innerText()) && await tabOn('tests') && await page.locator(item('RUL-01') + '[open]').count() === 1);
  check('…not on top of it, on a wide screen', await page.evaluate(() => document.querySelector('details.item[open]').getBoundingClientRect().right <= document.getElementById('peek').getBoundingClientRect().left));
  check('…showing its fields', /Steps \/ evidence[\s\S]*Expected: The rule saves/.test(await page.locator('#peek').innerText()));
  await page.click('#peek a.ref:text-is("RUL-01")');
  await page.waitForFunction(() => /RUL-01/.test(document.querySelector('#peek .peek-kind').textContent));
  check('a link inside the panel opens there', /Test case\s+RUL-01/.test(await page.locator('#peek .peek-kind').innerText()));
  await page.click('#peek [data-act="peek-back"]');
  check('Back in the panel returns to the defect', /D-03/.test(await page.locator('#peek .peek-kind').innerText()));
  // Typing in the test while the panel is open; a change elsewhere saves and redraws the page.
  await page.click('#ac-RUL-01');
  await page.keyboard.type('still typing');
  await page.evaluate(() => { const s = document.getElementById('st-RUL-04'); s.value = 'Pass'; s.dispatchEvent(new Event('change', { bubbles: true })); });
  await saved();
  const typed = [await page.inputValue('#ac-RUL-01'), await page.evaluate(() => document.activeElement.id)];
  check('text being typed survives a save', typed[0] === 'Weighting is lost on savestill typing' && typed[1] === 'ac-RUL-01', typed);
  check('…and the panel stays open through it', await page.locator('#peek').count() === 1);
  await page.keyboard.press('Escape');
  check('Esc closes the panel', await page.locator('#peek').count() === 0);
  await page.click('[data-tab="overview"]');
  await page.click('.att a.ref:text-is("RUL-02")');
  await page.waitForSelector(item('RUL-02') + '[open]');
  check('overview links still go straight to the item', await tabOn('tests') && await page.locator('#peek').count() === 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(hub.base + '#tests/RUL-04');
  await page.waitForSelector(item('RUL-04') + '[open]');
  await page.click(item('RUL-04') + ' .field:has(> .lab:text-is("Steps")) a.ref');
  await page.waitForSelector('#peek');
  check('on a phone the panel covers the screen', await page.locator('#peek').evaluate(el => Math.round(el.getBoundingClientRect().width) === window.innerWidth));
  check('…with no sideways scroll', await fits());
  await page.click('#peek-x');
  check('× closes it', await page.locator('#peek').count() === 0);
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- 6. a question's status is a choice ---
  await page.click('[data-tab="questions"]');
  await openItem('Q1');
  const opts = await page.locator('#qs-1 option').allInnerTexts();
  check('question status offers Open, Asked B4, Answered', JSON.stringify(opts) === '["Open","Asked B4","Answered"]', opts);
  await page.selectOption('#qs-1', 'Answered');
  await saved();
  check('choosing Answered closes the question', (await stored('1')).status === 'Answered' && /0 open/.test(await page.locator('[data-tab="questions"]').innerText()));
  await openItem('Q2');
  check('an older free-text status is kept as it was', (await page.inputValue('#qs-2')) === 'Answered: by email 3 Oct');

  await browser.close(); hub.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
