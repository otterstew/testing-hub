// Drives the hub with a fake Supabase client through finishing a test pass: the
// test pass report (printed to PDF by the browser) carries the summary, every test
// case and defect, and their screenshots; a clear needs the hub password and the
// word CLEAR, saves a full copy to the archive first, and either resets the
// results or empties the hub. No network, no account.
//
//   npm i playwright
//   node tests/finish_test.js
//
// Set CHROME_PATH to use a browser other than Playwright's own.

const { chromium } = require('playwright');
const { serve } = require('./fake_hub');

const at = '2026-11-10T09:00:00Z';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const shot = (id, path, name) => ({ id, name, path, size: 70, type: 'image/png', added: '2026-11-10T10:00' });
const RECORDS = [
  { kind: 'meta', rid: 'project', data: { project: 'ISRA scoring engine UAT' }, updated_at: at },
  { kind: 'test', rid: 'RUL-01', data: { id: 'RUL-01', _o: 1, section: 'Rules (phase 2)', objective: 'Add a rule', steps: 'Open Rules, add a rule', expected: 'It saves', actual: 'Weighting lost', comments: 'Seen twice', status: 'Fail', blockedBy: ['D-01'],
    shots: [shot('s1', 'tests/RUL-01/s1-rule.png', 'rule.png'), { id: 'v1', name: 'Recording 1.webm', path: 'tests/RUL-01/v1-Recording 1.webm', size: 9000, type: 'video/webm', added: '2026-11-10T10:05', secs: 75 }] }, updated_at: at },
  { kind: 'test', rid: 'RUL-02', data: { id: 'RUL-02', _o: 2, section: 'Rules (phase 2)', objective: 'Remove a rule', status: 'Pass' }, updated_at: at },
  { kind: 'test', rid: 'RUL-03', data: { id: 'RUL-03', _o: 3, section: 'Rules (phase 2)', objective: 'Not a real case', status: 'Invalid' }, updated_at: at },
  { kind: 'party', rid: 'TP-01', data: { id: 'TP-01', _o: 1, name: 'High risk company', module: 'Investor', type: 'Company', tests: 'RUL-01', expectedFinal: 'High', recorded: 'High' }, updated_at: at },
  { kind: 'defect', rid: 'D-01', data: { id: 'D-01', date: '2026-11-10', area: 'Rules', summary: 'Weighting lost on save', steps: 'See RUL-01', severity: 'High', status: 'Open', shots: [shot('s2', 'defects/D-01/s2-error.png', 'error.png')] }, updated_at: at },
  { kind: 'question', rid: '1', data: { n: 1, q: 'Who signs off?', a: '', tests: '', status: 'Open' }, updated_at: at },
  { kind: 'doc', rid: 'doc1', data: { id: 'doc1', name: 'Spec.pdf', path: 'docs/doc1/Spec.pdf', size: 100, added: at }, updated_at: at },
];
const FILES = { 'tests/RUL-01/s1-rule.png': PNG, 'tests/RUL-01/v1-Recording 1.webm': 'data:video/webm;base64,AAAA', 'defects/D-01/s2-error.png': PNG, 'docs/doc1/Spec.pdf': 'data:application/pdf;base64,JVBERg==' };

(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const results = [];
  const check = (label, ok, extra) => results.push({ label, ok, extra });

  async function fresh() {
    const hub = await serve(JSON.parse(JSON.stringify(RECORDS)));
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => { window.print = () => { window.__printed = (window.__printed || 0) + 1; }; });
    const page = await ctx.newPage();
    page.__errors = [];
    page.on('pageerror', e => page.__errors.push('PAGEERROR: ' + e.message));
    await page.goto(hub.base + '#overview');
    await page.waitForSelector('[data-act="report"]');
    await page.evaluate(files => { Object.assign(window.__files, files); }, FILES);
    return { hub, ctx, page };
  }
  const data = (page) => page.evaluate(() => window.__db);
  const notice = (page) => page.locator('main').innerText();

  // --- 1. the report ---
  {
    const { hub, ctx, page } = await fresh();
    await page.click('[data-act="report"]');
    await page.waitForFunction(() => window.__printed === 1, null, { timeout: 10000 });
    const rep = await page.locator('#report').innerText();
    check('the report opens the print window', await page.evaluate(() => document.body.classList.contains('reporting')));
    check('…with a summary that leaves Invalid out', /Test cases run\s*2 of 2 \(1 invalid, not counted\)/.test(rep), rep.slice(0, 400));
    check('…every test case with its result and actual result', /RUL-01 Add a rule\s*Fail/.test(rep) && /Weighting lost/.test(rep) && /RUL-02 Remove a rule\s*Pass/.test(rep), rep.slice(0, 900));
    check('…the defects', /D-01 Weighting lost on save\s*Open · High/.test(rep));
    const imgs = await page.$$eval('#report img', els => els.map(i => ({ ok: i.complete && i.naturalWidth > 0, alt: i.alt })));
    check('…the screenshots of tests and defects, loaded', imgs.length === 2 && imgs.every(i => i.ok), imgs);
    check('…and recordings listed by name, not embedded', /Recording 1\.webm \(1:15\)/.test(rep) && /Recordings can’t go in a PDF/.test(rep));
    await page.emulateMedia({ media: 'print' });
    const printed = await page.evaluate(() => ({ root: getComputedStyle(document.getElementById('root')).display, report: getComputedStyle(document.getElementById('report')).display }));
    check('when printing, only the report shows', printed.root === 'none' && printed.report === 'block', printed);
    await page.screenshot({ path: process.env.REPORT_SHOT || '/dev/null', fullPage: true }).catch(() => {});
    await page.emulateMedia({ media: 'screen' });
    check('no page errors (report)', page.__errors.length === 0, page.__errors);
    await ctx.close(); hub.close && hub.close();
  }

  // --- 2. the clear is protected ---
  {
    const { hub, ctx, page } = await fresh();
    await page.click('[data-act="clear-open"]');
    await page.fill('#clr-pass', 'wrong');
    await page.fill('#clr-word', 'CLEAR');
    await page.click('#clear-form button[type="submit"]');
    await page.waitForFunction(() => /password isn’t right/.test(document.querySelector('main').innerText));
    let db = await data(page);
    check('a wrong password clears nothing', db.records.length === RECORDS.length && !(await page.evaluate(() => window.__calls.some(c => c[0] === 'rpc'))));
    await page.fill('#clr-pass', 'right-password');
    await page.fill('#clr-word', 'clear');
    await page.click('#clear-form button[type="submit"]');
    check('CLEAR must be typed in capitals', /Type CLEAR, in capitals/.test(await notice(page)) && !(await page.evaluate(() => window.__calls.some(c => c[0] === 'rpc'))));

    // --- 3. reset results ---
    await page.fill('#clr-pass', 'right-password');
    await page.fill('#clr-word', 'CLEAR');
    await page.click('#clear-form button[type="submit"]');
    await page.waitForFunction(() => /New test pass started/.test(document.querySelector('main').innerText), null, { timeout: 10000 });
    db = await data(page);
    const calls = await page.evaluate(() => window.__calls);
    const archive = Object.keys(await page.evaluate(() => window.__files)).find(k => /^archive\/.+ results\/hub\.json$/.test(k));
    const snap = archive && JSON.parse(Buffer.from((await page.evaluate(k => window.__files[k], archive)).split(',')[1], 'base64').toString());
    const order = calls.map(c => c[0]).filter(c => ['signin', 'upload', 'rpc'].includes(c)).join(',');
    check('the full copy is saved first, then the clear runs', /signin.*upload.*rpc/.test(order) && snap && snap.records.length === RECORDS.length && snap.log && snap.mode === 'results', { order, archive });
    const t1 = db.records.find(r => r.rid === 'RUL-01').data, t3 = db.records.find(r => r.rid === 'RUL-03').data;
    check('results reset: Not run, last result kept as before, actual and attachments cleared', t1.status === 'Not run' && t1.prev === 'Fail' && !t1.actual && !t1.comments && t1.shots.length === 0 && t1.blockedBy.length === 0, t1);
    check('…an Invalid test stays Invalid', t3.status === 'Invalid', t3);
    check('…defects removed; parties lose their recorded risk; questions and documents kept', !db.records.some(r => r.kind === 'defect') && db.records.find(r => r.rid === 'TP-01').data.recorded === '' && db.records.some(r => r.kind === 'question') && db.records.some(r => r.kind === 'doc'));
    const files = await page.evaluate(() => Object.keys(window.__files));
    check('…test and defect files moved into the archive, documents left alone', !files.includes('tests/RUL-01/s1-rule.png') && files.some(f => /^archive\/.+\/files\/tests\/RUL-01\/s1-rule\.png$/.test(f)) && files.some(f => /^archive\/.+\/files\/defects\/D-01\/s2-error\.png$/.test(f)) && files.includes('docs/doc1/Spec.pdf'), files);
    check('…and the page shows the reset', /before: Fail/.test(await page.evaluate(() => { location.hash = '#tests'; return new Promise(r => setTimeout(() => r(document.querySelector('main').innerText), 300)); })));
    check('no page errors (reset)', page.__errors.length === 0, page.__errors);
    await ctx.close(); hub.close && hub.close();
  }

  // --- 4. empty everything ---
  {
    const { hub, ctx, page } = await fresh();
    await page.click('[data-act="clear-open"]');
    await page.check('input[name="clr-mode"][value="everything"]');
    check('choosing Empty everything changes the button', /Empty the hub/.test(await page.locator('#clear-form button[type="submit"]').innerText()));
    await page.fill('#clr-pass', 'right-password');
    await page.fill('#clr-word', 'CLEAR');
    await page.click('#clear-form button[type="submit"]');
    await page.waitForFunction(() => /The hub is empty/.test(document.body.innerText), null, { timeout: 10000 });
    const db = await data(page);
    const files = await page.evaluate(() => Object.keys(window.__files));
    check('everything: only the project name is left, and one log line', db.records.length === 1 && db.records[0].rid === 'project' && db.log.length === 1, db.records.map(r => r.kind + ':' + r.rid));
    check('…documents moved into the archive with the rest', files.some(f => /^archive\/.+ everything\/files\/docs\/doc1\/Spec\.pdf$/.test(f)) && files.some(f => /^archive\/.+ everything\/hub\.json$/.test(f)) && !files.includes('docs/doc1/Spec.pdf'), files);
    check('no page errors (everything)', page.__errors.length === 0, page.__errors);
    await ctx.close(); hub.close && hub.close();
  }

  await browser.close();
  let fail = 0;
  for (const r of results) { if (!r.ok) fail++; console.log((r.ok ? 'PASS ' : 'FAIL ') + r.label + (r.ok ? '' : '  ' + JSON.stringify(r.extra))); }
  console.log(`${results.length - fail} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
