// Drives the hub with a fake Supabase client: a screen recording attaches to a
// defect and to a test case, shows as a tile with its length, opens through a
// signed link, can be deleted, and stops by itself when sharing ends. Test cases
// take screenshots too. No network, no account.
//
// A headless browser has no screen to share, so getDisplayMedia is replaced with
// an animated canvas's stream; MediaRecorder records it for real.
//
//   npm i playwright
//   node tests/recording_test.js
//
// Set CHROME_PATH to use a browser other than Playwright's own.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-11-10T09:00:00Z';
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: at },
  { kind: 'test', rid: 'RUL-01', data: { id: 'RUL-01', _o: 1, section: 'Rules', objective: 'Add a rule', status: 'Not run' }, updated_at: at },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-11-10', area: 'Rules', summary: 'Weighting lost', severity: 'High', status: 'Open' }, updated_at: at },
];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const hub = await serve(RECORDS);
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = function () {
      if (window.__denyShare) return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const g = c.getContext('2d'); let n = 0;
      window.__paint = setInterval(() => { g.fillStyle = n++ % 2 ? '#c33' : '#3c3'; g.fillRect(0, 0, 320, 180); }, 50);
      const stream = c.captureStream(15);
      window.__share = stream;
      return Promise.resolve(stream);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });
  const item = id => `details.item[data-id="${id}"]`;
  const stored = (kind, rid) => page.evaluate(([k, r]) => (window.__db.records.find(x => x.kind === k && x.rid === r) || {}).data, [kind, rid]);
  const saved = () => page.waitForFunction(() => /All changes saved/.test((document.querySelector('.mode') || {}).textContent || ''));

  // --- 1. record on a defect, stop with the button ---
  await page.goto(hub.base + '#defects/D-01');
  await page.waitForSelector(item('D-01') + '[open]');
  check('a defect offers Record screen', await page.locator(item('D-01') + ' [data-act="rec-start"]').isVisible());
  await page.click(item('D-01') + ' [data-act="rec-start"]');
  await page.waitForSelector('#rec-btn');
  await page.waitForTimeout(2200);
  check('while recording the button counts up', /0:0[12]/.test(await page.locator('#rec-time').innerText()), await page.locator('#rec-time').innerText());
  await page.click('#rec-btn');
  await page.waitForFunction(() => [...document.querySelectorAll('details.item[open] .lab')].some(l => /\d recording/.test(l.textContent)));
  await saved();
  let d1 = await stored('defect', 'D-01');
  const v = (d1.shots || [])[0] || {};
  check('the clip is saved on the defect as a video', d1.shots && d1.shots.length === 1 && /^video\//.test(v.type) && /^defects\/D-01\/.+Recording .+\.(webm|mp4)$/.test(v.path) && v.secs >= 2, d1.shots);
  check('…with real bytes uploaded', await page.evaluate(p => (window.__files[p] || '').length > 1000, v.path));
  const tile = await page.locator(item('D-01') + ' .shot-video').innerText();
  check('it shows as a Recording tile with its length and size', /Recording · 0:0[2-3]/.test(tile) && /MB/.test(tile), tile);
  check('the screen share is released', await page.evaluate(() => window.__share.getTracks().every(t => t.readyState === 'ended')));
  check('the history records it', /D-01: recording added/.test(await page.evaluate(() => JSON.stringify(window.__db.log))));
  const pages = ctx.pages().length;
  await page.click(item('D-01') + ' .shot-video');
  await page.waitForTimeout(300);
  check('opening it asks for a signed link', await page.evaluate(p => window.__calls.some(c => c[0] === 'sign' && c[1] === p), v.path));
  for (const p of ctx.pages().slice(pages)) await p.close();

  // --- 2. on a test case; stopping the share from the browser counts as Stop ---
  await page.goto(hub.base + '#tests/RUL-01');
  await page.waitForSelector(item('RUL-01') + '[open]');
  check('a test case offers screenshots and Record screen', await page.locator(item('RUL-01') + ' [data-act="rec-start"]').isVisible() && await page.locator('[data-shot-up="RUL-01"][data-shot-k="tests"]').count() === 1);
  await page.click(item('RUL-01') + ' [data-act="rec-start"]');
  await page.waitForSelector('#rec-btn');
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__share.getVideoTracks().forEach(t => { t.stop(); t.dispatchEvent(new Event('ended')); }));
  await page.waitForFunction(() => [...document.querySelectorAll('details.item[open] .lab')].some(l => /\d recording/.test(l.textContent)));
  await saved();
  let t1 = await stored('test', 'RUL-01');
  check('ending the share stops and saves the clip on the test', t1.shots && t1.shots.length === 1 && /^tests\/RUL-01\//.test(t1.shots[0].path), t1.shots);

  // --- 3. a screenshot on a test case ---
  await page.setInputFiles('[data-shot-up="RUL-01"]', { name: 'rule.png', mimeType: 'image/png', buffer: PNG });
  await page.waitForFunction(() => document.querySelectorAll('details.item[open] .shot').length === 2);
  await saved();
  t1 = await stored('test', 'RUL-01');
  check('a test case takes a screenshot too', t1.shots.length === 2 && t1.shots.some(x => x.name === 'rule.png' && /^tests\/RUL-01\//.test(x.path)), t1.shots);

  // --- 4. delete the recording from the test ---
  await page.click(item('RUL-01') + ' .shot:has(.shot-video) .shot-x');
  await page.click(item('RUL-01') + ' [data-act="shot-del-yes"]');
  await saved();
  t1 = await stored('test', 'RUL-01');
  check('Delete removes the recording from the test and from storage', t1.shots.length === 1 && t1.shots[0].name === 'rule.png' && await page.evaluate(() => window.__calls.some(c => c[0] === 'remove' && /^tests\/RUL-01\/.+Recording/.test(c[1]))), t1.shots);

  // --- 5. cancelling the browser's share prompt is not an error ---
  await page.evaluate(() => { window.__denyShare = true; });
  await page.click(item('RUL-01') + ' [data-act="rec-start"]');
  await page.waitForTimeout(300);
  check('cancelling the share prompt shows no error and no recording', !(await page.locator('#rec-btn').count()) && !/Couldn/.test(await page.locator('main').innerText()));

  check('no page errors', errors.length === 0, errors);
  await browser.close(); hub.close && hub.close();
  let fail = 0;
  for (const r of results) { if (!r.ok) fail++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.ok ? '' : '  ' + JSON.stringify(r.extra))); }
  console.log(`${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
