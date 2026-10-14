// A local server for the hub with a fake Supabase client in place of
// vendor/supabase.js, shared by the browser tests. serve(records) starts it
// with those th_records rows and resolves to { base, close }.
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function fake(records) {
  return `
// Kept in sessionStorage so a reload finds what was saved, like the real server.
var saved = JSON.parse(sessionStorage.getItem('fakeSupabase') || 'null');
window.__calls = saved ? saved.calls : [];
window.__files = saved ? saved.files : {}; // path -> data: URL
function persist() { sessionStorage.setItem('fakeSupabase', JSON.stringify({ db: window.__db, files: window.__files, calls: window.__calls })); }
window.__db = saved ? saved.db : {
  records: ${JSON.stringify(records).replace(/</g, '\\u003c')},
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
}

function serve(records) {
  const FAKE = fake(records);
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/vendor/supabase.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(FAKE); }
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(file).pipe(res);
  });
  return new Promise(r => server.listen(0, () => r({ base: 'http://127.0.0.1:' + server.address().port + '/', close: () => server.close() })));
}

module.exports = { serve };
