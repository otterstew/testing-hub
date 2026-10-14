// Drives the hub in a real browser with a fake Supabase client: adding
// screenshots to a defect (file picker and paste), thumbnails, full size,
// removing one, the defect history, and a new defect opening ready for them.
// No network, no account.
//
//   npm i playwright
//   node tests/screenshots_test.js
//
// A browser is already present in CI-style images at PLAYWRIGHT_BROWSERS_PATH;
// set CHROME_PATH to point somewhere else.

const { chromium } = require('playwright');
// The fake Supabase client (tests/fake_hub.js) keeps records on window.__db,
// stored files on window.__files and every storage call on window.__calls.
const { serve } = require('./fake_hub');

const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: '2026-10-14T09:00:00Z' },
  { kind: 'test', rid: 'T-01', data: { id: 'T-01', section: 'Rules', objective: 'A test', status: 'Not run' }, updated_at: '2026-10-14T09:00:00Z' },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Rules', summary: 'Rule does not save', steps: '', severity: 'High', ref: '', status: 'Open' }, updated_at: '2026-10-14T09:00:00Z' }
];

// A real 2x2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqEAoAhpUFAQr8VXUAAAAASUVORK5CYII=', 'base64');

(async () => {
  const hub = await serve(RECORDS), BASE = hub.base;
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });

  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const calls = () => page.evaluate(() => window.__calls);
  const stored = () => page.evaluate(() => (window.__db.records.find(r => r.rid === 'D-01') || {}).data);
  const saved = () => page.waitForFunction(() => /All changes saved/.test(document.querySelector('.mode') && document.querySelector('.mode').textContent));

  await page.goto(BASE + '#defects');
  await page.waitForSelector('details.item[data-id="D-01"]');
  // --- the row shows status, then severity ---
  const pills = () => page.locator('details.item[data-id="D-01"] > summary .pills .pill').allInnerTexts();
  check('the defect row shows status left of severity', JSON.stringify(await pills()) === '["Open","High"]', await pills());
  await page.click('details.item[data-id="D-01"] summary');
  await page.selectOption('#ds-D-01', 'Fixed');
  await page.waitForFunction(() => /Fixed/.test(document.querySelector('details.item[data-id="D-01"] > summary .pills').textContent));
  check('changing the status updates the row', JSON.stringify(await pills()) === '["Fixed","High"]', await pills());
  check('…coloured as done', await page.locator('details.item[data-id="D-01"] > summary .pills .pill').first().evaluate(e => e.classList.contains('s-pass')));
  await page.setViewportSize({ width: 390, height: 844 });
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check('both fit on a phone without sideways scrolling', fits);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.selectOption('#ds-D-01', 'Open');
  await page.waitForFunction(() => /Open/.test(document.querySelector('details.item[data-id="D-01"] > summary .pills').textContent));

  check('an open defect offers Add screenshots', await page.locator('[data-shot-up="D-01"]').count() === 1);
  check('…and says a paste works too', /paste one/.test(await page.locator('details.item[data-id="D-01"] .shot-add').innerText()));

  // --- add one with the file picker ---
  await page.setInputFiles('[data-shot-up="D-01"]', { name: 'rule-error.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('details.item[data-id="D-01"] .shot img[src^="blob:"]');
  await saved();
  let d = await stored();
  check('the picked image is stored on the defect', d && d.shots && d.shots.length === 1 && d.shots[0].name === 'rule-error.png', d && d.shots);
  check('…in the private bucket under defects/D-01/', /^defects\/D-01\/.+-rule-error\.png$/.test(d.shots[0].path), d.shots[0].path);
  check('the thumbnail shows', await page.locator('details.item[data-id="D-01"] .shot img').evaluate(i => i.complete && i.naturalWidth === 2));
  check('the summary line counts it', /1 screenshot\b/.test(await page.locator('details.item[data-id="D-01"] summary').innerText()));
  check('the defect history records it', /screenshot added \(rule-error\.png\)/.test(await page.locator('details.item[data-id="D-01"] .log').innerText()));

  // --- paste one ---
  await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], 'image.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await page.waitForFunction(() => document.querySelectorAll('details.item[data-id="D-01"] .shot').length === 2);
  await saved();
  d = await stored();
  check('a pasted image is added too', d.shots.length === 2);
  check('…named by date, not "image.png"', /^Screenshot \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/.test(d.shots[1].name), d.shots[1].name);

  // --- pasting text is left alone ---
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'just words');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  check('pasting text adds nothing', (await stored()).shots.length === 2);

  // --- non-images are refused ---
  await page.setInputFiles('[data-shot-up="D-01"]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await page.waitForSelector('.notice.err');
  check('a non-image is refused with a message', /Only images/.test(await page.locator('.notice.err').innerText()));
  await page.click('.notice.err [data-act="dismiss"]');

  // --- a failed upload says so and stores nothing ---
  await page.evaluate(() => { window.__failUpload = true; });
  await page.setInputFiles('[data-shot-up="D-01"]', { name: 'bad.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForSelector('.notice.err');
  check('a failed upload is reported', /bad\.png: upload failed \(boom\)/.test(await page.locator('.notice.err').innerText()));
  check('…and adds nothing to the defect', (await stored()).shots.length === 2);
  await page.evaluate(() => { window.__failUpload = false; });
  await page.click('.notice.err [data-act="dismiss"]');

  // --- full size ---
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('details.item[data-id="D-01"] .shot-img >> nth=0')]);
  await popup.waitForLoadState().catch(() => {});
  check('tapping a thumbnail opens it full size from a signed link', (await calls()).some(c => c[0] === 'sign' && /rule-error\.png$/.test(c[1])));
  await popup.close();

  // --- thumbnails come back after a reload (downloaded, not cached) ---
  await page.evaluate(() => { location.hash = '#defects'; });
  await page.reload();
  await page.waitForSelector('details.item[data-id="D-01"]');
  check('closed defects do not download their images', !(await calls()).some(c => c[0] === 'download'));
  await page.click('details.item[data-id="D-01"] summary');
  await page.waitForFunction(() => [...document.querySelectorAll('details.item[data-id="D-01"] .shot img')].every(i => i.src.startsWith('blob:')));
  check('opening the defect downloads its thumbnails', (await calls()).filter(c => c[0] === 'download').length === 2);

  // --- remove one ---
  await page.click('details.item[data-id="D-01"] .shot-x >> nth=0');
  check('remove asks first', await page.locator('[data-act="shot-del-yes"]').count() === 1);
  await page.click('[data-act="shot-del-no"]');
  check('Keep leaves it', await page.locator('details.item[data-id="D-01"] .shot').count() === 2);
  await page.click('details.item[data-id="D-01"] .shot-x >> nth=0');
  await page.click('[data-act="shot-del-yes"]');
  await page.waitForFunction(() => document.querySelectorAll('details.item[data-id="D-01"] .shot').length === 1);
  await saved();
  d = await stored();
  check('Delete removes it from the defect', d.shots.length === 1 && d.shots[0].name !== 'rule-error.png');
  check('…and from storage', (await calls()).some(c => c[0] === 'remove' && /rule-error\.png$/.test(c[1])));
  check('…and the history says so', /screenshot removed \(rule-error\.png\)/.test(await page.locator('details.item[data-id="D-01"] .log').innerText()));

  // --- a new defect opens ready for screenshots ---
  await page.fill('#nd-area', 'Settings');
  await page.fill('#nd-sum', 'History shows the wrong time');
  await page.click('#add-defect button[type="submit"]');
  await page.waitForSelector('details.item[data-id="D-02"][open]');
  check('a new defect opens with Add screenshots', await page.locator('[data-shot-up="D-02"]').count() === 1);
  check('…and the notice says so', /Paste or add screenshots/.test(await page.locator('.notice').first().innerText()));

  // --- deleted defects can't take screenshots ---
  await page.click('details.item[data-id="D-02"] [data-act="def-del"]');
  await page.fill('#dr-why-D-02', 'Duplicate');
  await page.click('[data-act="def-del-yes"]');
  await page.selectOption('#f-dstatus', 'deleted');
  await page.click('details.item[data-id="D-02"] summary');
  check('a deleted defect has no Add screenshots', await page.locator('[data-shot-up="D-02"]').count() === 0);

  await browser.close(); hub.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
