// Drives the hub with a fake Supabase client: you stay where you were. A test you
// close stays closed when the page redraws, Refresh keeps the page and the scroll
// position while it fetches (on a phone too), and the new-defect form starts as a
// single button. No network, no account.
//
//   npm i playwright
//   node tests/navigation_test.js
//
// Set CHROME_PATH to use a browser other than Playwright's own.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-11-10T09:00:00Z';
const RECORDS = [{ kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at }];
for (let i = 1; i <= 40; i++) {
  const id = 'T-' + String(i).padStart(2, '0');
  RECORDS.push({ kind: 'test', rid: id, data: { id, _o: i, section: i <= 20 ? 'First' : 'Second', objective: 'Objective ' + i, steps: 'Step one\nStep two\nStep three\nStep four', expected: 'It works', status: 'Not run' }, updated_at: at });
}
RECORDS.push({ kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-11-10', area: 'Rules', summary: 'Something breaks', severity: 'Medium', status: 'Open' }, updated_at: at });

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const item = id => `details.item[data-id="${id}"]`;

  for (const [w, h, name] of [[1280, 800, 'desktop'], [390, 844, 'phone']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
    const saved = () => page.waitForFunction(() => /All changes saved/.test((document.querySelector('.mode') || {}).textContent || ''));
    const openIds = () => page.evaluate(() => [...document.querySelectorAll('details.item[open]')].map(d => d.dataset.id));
    await page.goto(hub.base + '#tests');
    await page.waitForSelector(item('T-30'));

    // --- 1. a closed test stays closed ---
    await page.locator(item('T-30') + ' summary').scrollIntoViewIfNeeded();
    await page.click(item('T-30') + ' summary');
    await page.selectOption('#st-T-30', 'Pass');
    await saved();
    await page.click(item('T-30') + ' summary');
    await page.waitForTimeout(150);
    await page.click('[data-act="reload"]');
    await page.waitForFunction(() => !/Refreshing/.test((document.querySelector('.mode') || {}).textContent || ''));
    check(name + ': a closed test stays closed after Refresh', (await openIds()).length === 0, await openIds());

    // --- 2. Refresh keeps the page and the place ---
    await page.evaluate(() => { window.__delay = 400; });
    const y0 = await page.evaluate(() => Math.round(scrollY));
    await page.click('[data-act="reload"]');
    await page.waitForTimeout(150);
    const during = await page.evaluate(() => ({ items: document.querySelectorAll('details.item').length, chip: (document.querySelector('.mode') || {}).textContent, y: Math.round(scrollY) }));
    check(name + ': while refreshing, the list stays and says Refreshing', during.items === 40 && /Refreshing/.test(during.chip), during);
    await page.waitForFunction(() => !/Refreshing/.test((document.querySelector('.mode') || {}).textContent || ''));
    const y1 = await page.evaluate(() => Math.round(scrollY));
    check(name + ': after Refresh the scroll position is kept', y0 > 300 && Math.abs(y1 - y0) < 5, { y0, y1 });
    await page.evaluate(() => { window.__delay = 0; });

    // --- 3. the new-defect form starts small ---
    await page.click('[data-tab="defects"]');
    check(name + ': Defects shows a New defect button, not the form', await page.locator('[data-act="nd-open"]').isVisible() && !(await page.locator('#add-defect').count()));
    await page.click('[data-act="nd-open"]');
    check(name + ': the button opens the form', await page.locator('#nd-area').isVisible());
    await page.click('[data-act="nd-cancel"]');
    check(name + ': Cancel closes it again', await page.locator('[data-act="nd-open"]').isVisible());
    await page.goto(hub.base + '#tests/T-05');
    await page.waitForSelector(item('T-05') + '[open]');
    await page.click(item('T-05') + ' [data-act="raise-defect"]');
    await page.waitForSelector('#add-defect');
    check(name + ': raising a defect from a test opens the form straight away', /from T-05/.test(await page.locator('#add-defect .eyebrow').innerText()));

    check(name + ': no page errors', errors.length === 0, errors);
  }

  await browser.close(); hub.close && hub.close();
  let fail = 0;
  for (const r of results) { if (!r.ok) fail++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.ok ? '' : '  ' + JSON.stringify(r.extra))); }
  console.log(`${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
