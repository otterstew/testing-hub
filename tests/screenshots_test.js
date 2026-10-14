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
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Stands in for vendor/supabase.js. Records live on window.__db; stored files
// on window.__files (path -> Blob); every storage call on window.__calls.
const FAKE = `
// Kept in sessionStorage so a reload finds what was saved, like the real server.
var saved = JSON.parse(sessionStorage.getItem('fakeSupabase') || 'null');
window.__calls = saved ? saved.calls : [];
window.__files = saved ? saved.files : {}; // path -> data: URL
function persist() { sessionStorage.setItem('fakeSupabase', JSON.stringify({ db: window.__db, files: window.__files, calls: window.__calls })); }
window.__db = saved ? saved.db : {
  records: [
    { kind: 'meta', rid: 'project', data: { project: 'Test project' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'test', rid: 'T-01', data: { id: 'T-01', section: 'Rules', objective: 'A test', status: 'Not run' }, updated_at: '2026-10-14T09:00:00Z' },
    { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-10-14', area: 'Rules', summary: 'Rule does not save', steps: '', severity: 'High', ref: '', status: 'Open' }, updated_at: '2026-10-14T09:00:00Z' }
  ],
  log: []
};
(function () {
  function q(table) {
    var self = {
      _t: table,
      select: function () { return self; }, range: function () { return self; }, order: function () { return self; },
      limit: function () { return self; }, eq: function () { return self; },
      upsert: function (rows) {
        rows.forEach(function (r) {
          var at = new Date().toISOString(), found = false;
          window.__db.records.forEach(function (x) { if (x.kind === r.kind && x.rid === r.rid) { x.data = r.data; x.updated_at = at; found = true; } });
          if (!found) window.__db.records.push({ kind: r.kind, rid: r.rid, data: r.data, updated_at: at });
        });
        persist();
        self._rows = rows.map(function (r) { return { kind: r.kind, rid: r.rid, updated_at: new Date().toISOString() }; });
        return self;
      },
      insert: function (rows) { if (table === 'th_log') rows.forEach(function (r) { window.__db.log.unshift({ at: new Date().toISOString(), text: r.text, by: r.by }); }); persist(); return self; },
      delete: function () { return self; },
      then: function (ok, bad) {
        var data = self._rows || (table === 'th_records' ? JSON.parse(JSON.stringify(window.__db.records)) : window.__db.log);
        return Promise.resolve({ data: data, error: null }).then(ok, bad);
      }
    };
    return self;
  }
  var bucket = {
    upload: function (p, f) {
      window.__calls.push(['upload', p]); persist();
      if (window.__failUpload) return Promise.resolve({ error: { message: 'boom' } });
      return new Promise(function (ok) { var fr = new FileReader(); fr.onload = function () { window.__files[p] = fr.result; persist(); ok({ data: { path: p }, error: null }); }; fr.readAsDataURL(f); });
    },
    download: function (p) {
      window.__calls.push(['download', p]); persist();
      if (!window.__files[p]) return Promise.resolve({ data: null, error: { message: 'missing' } });
      // Not fetch(): the hub's CSP blocks fetching data: URLs.
      var m = /^data:([^;]*);base64,(.*)$/.exec(window.__files[p]), bin = atob(m[2]), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return Promise.resolve({ data: new Blob([u], { type: m[1] }), error: null });
    },
    remove: function (ps) { window.__calls.push(['remove', ps[0]]); delete window.__files[ps[0]]; persist(); return Promise.resolve({ data: [], error: null }); },
    createSignedUrl: function (p) { window.__calls.push(['sign', p]); persist(); return Promise.resolve({ data: { signedUrl: 'about:blank#' + encodeURIComponent(p) }, error: null }); }
  };
  window.supabase = { createClient: function () { return {
    auth: {
      onAuthStateChange: function (cb) { setTimeout(function () { cb('SIGNED_IN', { user: { id: 'u1', email: 'tester@example.com' } }); }, 0); },
      signOut: function () { return Promise.resolve(); }
    },
    from: q,
    storage: { from: function () { return bucket; } }
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

// A real 2x2 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4EIwDiqEAoAhpUFAQr8VXUAAAAASUVORK5CYII=', 'base64');

(async () => {
  await new Promise(r => server.listen(0, r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
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

  await browser.close(); server.close();
  let failed = 0;
  for (const r of results) { if (!r.ok) failed++; console.log((r.ok ? 'ok   ' : 'FAIL ') + r.label + (r.ok || r.extra === undefined ? '' : '  → ' + JSON.stringify(r.extra))); }
  for (const e of errors) console.log(e);
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed' + (errors.length ? ', ' + errors.length + ' page errors' : ''));
  process.exit(failed || errors.length ? 1 : 0);
})();
