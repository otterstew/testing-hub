(function () {
  "use strict";
  var TITLE = "ISRA Testing Hub";
  var OFFLINE_RESET = ":root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}";
  var STATUSES = ["Not run", "Pass", "Partial pass", "Fail", "Blocked"];
  var DSTATUS = ["Open", "To confirm", "Retest", "Raised with B4", "Fixed", "Closed"];
  var SEV = ["High", "Medium", "Low"];
  var LEVELS = ["", "Low", "Medium", "High", "High+", "Blocked"];
  var DRAFT_KEY = "isra-hub-draft";
  var PEND_KEY = "isra-hub-pending";
  var BUCKET = "testing-hub";
  var KIND = { tests: "test", parties: "party", defects: "defect", questions: "question", docs: "doc" };
  var LIST = { test: "tests", party: "parties", defect: "defects", question: "questions", doc: "docs" };

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var local = function (d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
  var now = function () { return local(new Date()); };
  var fmt = function (iso) { if (!iso) return ""; return String(iso).replace("T", " ").slice(0, 16); };
  var sclass = function (s) { return { "Pass": "s-pass", "Partial pass": "s-partial", "Fail": "s-fail", "Blocked": "s-blocked" }[s] || "s-notrun"; };
  var scolor = function (s) { return { "Pass": "var(--pass)", "Partial pass": "var(--partial)", "Fail": "var(--fail)", "Blocked": "var(--blocked)" }[s] || "var(--notrun)"; };
  var short = function (sec) { return String(sec || "").replace(/\s*\(.*\)\s*$/, ""); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var ext = function (n) { var m = /\.([a-z0-9]+)$/i.exec(n || ""); return m ? m[1].toLowerCase() : ""; };
  var size = function (b) { b = +b || 0; return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; };
  var num = function (s) { var m = /(\d+)/.exec(String(s || "")); return m ? +m[1] : 0; };

  // hosted = this page talks to Supabase; offline = a saved copy carrying its own data
  var hosted = !!(window.supabase && window.HUB_CONFIG && !document.getElementById("data"));
  var mode = hosted ? "starting" : "offline";
  var sb = null, user = null, loadedFor = null;
  var recovering = /type=recovery/.test(location.hash || "");
  var state = { project: "ISRA scoring engine UAT", tests: [], parties: [], defects: [], questions: [], docs: [], log: [] };
  var base = null;
  var ui = { tab: "overview", q: "", area: "", status: "", dq: "", dstatus: "", notice: null, importDiff: null, readOnly: false, auth: "signin" };
  try { var t0 = (location.hash || "").replace("#", ""); if (["overview", "tests", "defects", "parties", "questions", "documents"].indexOf(t0) >= 0) ui.tab = t0; } catch (e) {}
  var dirty = 0;

  // ---------- offline copy: data travels inside the file ----------
  function saveDraft() { try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ baseRev: base.rev, state: state, dirty: dirty })); } catch (e) {} }
  function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} }
  if (!hosted) {
    base = JSON.parse($("#data").textContent);
    state = clone(base);
    if (!state.docs) state.docs = [];
    (function loadDraft() {
      var d = null;
      try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch (e) {}
      if (!d || !d.state || !d.dirty) return;
      if (d.baseRev === base.rev) { state = d.state; dirty = d.dirty; ui.notice = { kind: "", text: "Unsaved changes from this browser were restored (" + dirty + ")." }; }
      else if (d.baseRev < base.rev) ui.notice = { kind: "warn", text: "This browser holds " + d.dirty + " unsaved change(s) made to an older copy.", draft: d };
      else clearDraft();
    })();
  }

  // ---------- hosted: every change is saved straight away ----------
  var pend = {}, pendLog = [], serverAt = {}, flushing = false, retryMs = 0, timer = null, lastSaved = null;
  function ridOf(kind, rec) { return kind === "question" ? String(rec.n) : rec.id; }
  function persistPend() { try { localStorage.setItem(PEND_KEY, JSON.stringify({ who: user && user.email, recs: pend, log: pendLog })); } catch (e) {} }
  function pendingCount() { return Object.keys(pend).length + pendLog.length; }
  function queue(kind, rec, del) {
    var key = kind + "|" + ridOf(kind, rec);
    pend[key] = { kind: kind, rid: ridOf(kind, rec), data: del ? null : clone(rec), del: !!del, baseAt: serverAt[key] || null };
    persistPend(); schedule(400);
  }
  function addLog(text) {
    var e = { at: now(), text: text };
    state.log.unshift(e);
    if (hosted) { pendLog.push({ text: text }); persistPend(); schedule(400); }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(flush, ms); }
  function flush() {
    if (!sb || !user || flushing) return;
    var keys = Object.keys(pend), logs = pendLog.slice();
    if (!keys.length && !logs.length) return;
    flushing = true; render();
    var snap = {}; keys.forEach(function (k) { snap[k] = JSON.stringify(pend[k]); });
    var ups = keys.filter(function (k) { return !pend[k].del; }).map(function (k) { return { kind: pend[k].kind, rid: pend[k].rid, data: pend[k].data, updated_by: user.email }; });
    var dels = keys.filter(function (k) { return pend[k].del; });
    var jobs = [];
    if (ups.length) jobs.push(sb.from("th_records").upsert(ups, { onConflict: "kind,rid" }).select("kind,rid,updated_at").then(function (r) {
      if (r.error) throw r.error;
      (r.data || []).forEach(function (row) { serverAt[row.kind + "|" + row.rid] = row.updated_at; });
    }));
    dels.forEach(function (k) { jobs.push(sb.from("th_records").delete().eq("kind", pend[k].kind).eq("rid", pend[k].rid).then(function (r) { if (r.error) throw r.error; delete serverAt[k]; })); });
    if (logs.length) jobs.push(sb.from("th_log").insert(logs.map(function (l) { return { text: l.text, by: user.email }; })).then(function (r) { if (r.error) throw r.error; }));
    Promise.all(jobs).then(function () {
      keys.forEach(function (k) { if (pend[k] && JSON.stringify(pend[k]) === snap[k]) delete pend[k]; });
      pendLog.splice(0, logs.length);
      persistPend(); flushing = false; retryMs = 0; lastSaved = now();
      if (ui.saveErr) { ui.saveErr = null; }
      if (pendingCount()) schedule(200); else render();
    }, function (err) {
      flushing = false;
      retryMs = Math.min(60000, retryMs ? retryMs * 2 : 3000);
      ui.saveErr = (err && err.message) || "network error";
      render(); schedule(retryMs);
    });
  }
  window.addEventListener("online", function () { schedule(100); });
  window.addEventListener("beforeunload", function (e) { if (hosted && pendingCount()) { e.preventDefault(); e.returnValue = ""; } });

  function sortState() {
    var o = function (a, b) { return (a._o || 0) - (b._o || 0); };
    state.tests.sort(o); state.parties.sort(o);
    state.defects.sort(function (a, b) { return num(a.id) - num(b.id); });
    state.questions.sort(function (a, b) { return num(a.n) - num(b.n); });
    state.docs.sort(function (a, b) { return String(a.uploaded).localeCompare(String(b.uploaded)); });
  }

  function loadAll() {
    mode = "loading"; render();
    return Promise.all([
      sb.from("th_records").select("kind,rid,data,updated_at").range(0, 9999),
      sb.from("th_log").select("at,text,by").order("at", { ascending: false }).limit(300)
    ]).then(function (r) {
      if (r[0].error) throw r[0].error;
      var s = { project: "ISRA scoring engine UAT", tests: [], parties: [], defects: [], questions: [], docs: [], log: [] }, latest = "";
      serverAt = {};
      (r[0].data || []).forEach(function (row) {
        serverAt[row.kind + "|" + row.rid] = row.updated_at;
        if (row.updated_at > latest) latest = row.updated_at;
        if (row.kind === "meta") { if (row.data && row.data.project) s.project = row.data.project; if (row.data && row.data.source) s.source = row.data.source; return; }
        if (LIST[row.kind]) s[LIST[row.kind]].push(row.data);
      });
      s.log = (r[1].data || []).map(function (l) { return { at: local(new Date(l.at)), text: l.text }; });
      s.updated = latest ? local(new Date(latest)) : "";
      state = s; sortState();
      mode = r[0].data && r[0].data.length ? "online" : "noaccess";
      reapplyPending();
      render();
    }).catch(function (e) { mode = "error"; ui.notice = { kind: "err", text: "Couldn’t load the hub: " + ((e && e.message) || "network error") + ". Check the connection, then reload." }; render(); });
  }

  function reapplyPending() {
    var p = null;
    try { p = JSON.parse(localStorage.getItem(PEND_KEY) || "null"); } catch (e) {}
    if (!p || p.who !== user.email) return;
    var kept = 0, skipped = [];
    Object.keys(p.recs || {}).forEach(function (k) {
      var e = p.recs[k];
      if ((serverAt[k] || null) !== (e.baseAt || null)) { skipped.push(e.rid); return; }
      var list = state[LIST[e.kind]], i = -1;
      for (var j = 0; j < list.length; j++) if (ridOf(e.kind, list[j]) === e.rid) { i = j; break; }
      if (e.del) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = e.data; else list.push(e.data);
      pend[k] = e; kept++;
    });
    (p.log || []).forEach(function (l) { pendLog.push(l); });
    sortState(); persistPend();
    if (kept) { ui.notice = { kind: "", text: kept + " change(s) this browser hadn’t saved yet are being saved now." }; schedule(300); }
    if (skipped.length) ui.notice = { kind: "warn", text: "Unsaved changes from this browser to " + skipped.join(", ") + " were not applied: those records were changed somewhere else since. Check them." };
  }

  // ---------- edits ----------
  function find(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function getRec(k, id) { return k === "questions" ? state.questions.filter(function (q) { return String(q.n) === String(id); })[0] : find(state[k] || [], id); }
  function setField(k, id, field, value, label) {
    var rec = getRec(k, id);
    if (!rec || rec[field] === value) return;
    rec[field] = value;
    if (label) addLog(id + ": " + label + " → " + (value || "(blank)"));
    if (hosted) queue(KIND[k], rec); else { dirty++; saveDraft(); }
    render();
  }

  // ---------- files ----------
  function saveFile(filename, data, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime });
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return Promise.resolve();
  }

  function docHtml(next, css, lib, app) {
    var data = JSON.stringify(next).replace(/</g, "\\u003c");
    var safe = function (s) { return String(s).replace(/<\/script/gi, "<\\/script"); };
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>' + TITLE + " (offline)</title><style>" + OFFLINE_RESET + '</style><style id="css">' + css + "</style></head><body>" +
      '<div id="root"></div><script type="application/json" id="data">' + data + '<\/script><script id="lib">' + safe(lib) + '<\/script><script id="app">' + safe(app) + "<\/script></body></html>";
  }
  function offlineCopy() {
    var name = "ISRA-Testing-Hub-" + now().slice(0, 10) + ".html";
    var n = clone(state); n.rev = (base && base.rev || 0) + 1; n.updated = now();
    if (!hosted) {
      saveFile(name, docHtml(n, $("#css").textContent, $("#lib") ? $("#lib").textContent : "", $("#app").textContent), "text/html");
      base = n; dirty = 0; clearDraft(); render(); return;
    }
    var get = function (u) { return fetch(u, { cache: "no-cache" }).then(function (r) { if (!r.ok) throw new Error(u); return r.text(); }); };
    Promise.all([get("style.css"), get("vendor/xlsx.js"), get("app.js")]).then(function (r) {
      n.rev = 1; saveFile(name, docHtml(n, r[0], r[1], r[2]), "text/html");
      notify("", "Offline copy saved as " + name + ". Open it in any browser; it needs no connection.");
    }, function () { notify("err", "Couldn’t build the offline copy. Check the connection and try again."); });
  }

  // ---------- views ----------
  function counts(list) { var c = {}; STATUSES.forEach(function (s) { c[s] = 0; }); list.forEach(function (t) { c[STATUSES.indexOf(t.status) >= 0 ? t.status : "Not run"]++; }); return c; }
  function segs(c, total) { return STATUSES.slice(1).concat(["Not run"]).map(function (s) { var w = total ? (c[s] / total * 100) : 0; return w ? '<i style="width:' + w.toFixed(2) + '%;background:' + scolor(s) + '" title="' + esc(s + ": " + c[s]) + '"></i>' : ""; }).join(""); }
  function pill(s) { return '<span class="pill ' + sclass(s) + '">' + esc(s || "Not run") + "</span>"; }
  function sevPill(s) { var c = s === "High" ? "s-fail" : s === "Medium" ? "s-partial" : "s-notrun"; return '<span class="pill ' + c + '">' + esc(s || "–") + "</span>"; }
  function openDefect(d) { return ["Fixed", "Closed"].indexOf(d.status) < 0; }
  function qOpen(q) { return !/^answered$/i.test(q.status || "") && !/^answered[:\s]/i.test(q.status || ""); }

  function vOverview() {
    var T = state.tests, c = counts(T), total = T.length, done = total - c["Not run"];
    var secs = []; T.forEach(function (t) { if (secs.indexOf(t.section) < 0) secs.push(t.section); });
    var rows = secs.map(function (s) {
      var L = T.filter(function (t) { return t.section === s; }), cc = counts(L), d = L.length - cc["Not run"];
      return "<tr><td>" + esc(short(s)) + '</td><td class="mono">' + d + "/" + L.length + '</td><td><div class="areabar">' + segs(cc, L.length) + '</div></td><td class="mono">' + cc.Pass + '</td><td class="mono">' + cc.Fail + '</td><td class="mono">' + cc.Blocked + "</td></tr>";
    }).join("");
    var D = state.defects, od = D.filter(openDefect);
    var dsum = SEV.map(function (sv) {
      var n = od.filter(function (d) { return d.severity === sv; }).length, all = D.filter(function (d) { return d.severity === sv; }).length;
      return "<div>" + sevPill(sv) + '</div><div class="num">' + n + ' open</div><div class="num" style="color:var(--muted)">' + (all - n) + ' closed</div><div class="num" style="color:var(--muted)">' + all + " total</div>";
    }).join("");
    var attTests = T.filter(function (t) { return t.status === "Fail" || t.status === "Blocked"; });
    var high = od.filter(function (d) { return d.severity === "High"; });
    var oq = state.questions.filter(qOpen);
    var next = T.filter(function (t) { return t.status === "Not run"; }).slice(0, 5);
    return '<section class="summary"><div class="panel"><div class="eyebrow">Test cases</div><div class="big"><strong>' + done + "</strong><span>of " + total + " run · " + c.Pass + " passed</span></div>" +
      '<div class="seg">' + segs(c, total) + '</div><div class="legend">' + STATUSES.slice(1).concat(["Not run"]).map(function (s) { return '<button data-go-status="' + esc(s) + '"><span class="dot" style="background:' + scolor(s) + '"></span>' + esc(s) + ' <span class="num">' + c[s] + "</span></button>"; }).join("") + "</div></div>" +
      '<div class="panel"><div class="eyebrow">Defects</div><div class="big"><strong>' + od.length + "</strong><span>open of " + D.length + '</span></div><div class="defsum">' + dsum + "</div></div></section>" +
      "<h2>By area<small>run / total, then the split by result</small></h2>" +
      '<div class="tablewrap"><table><thead><tr><th>Area</th><th>Run</th><th>Results</th><th>Pass</th><th>Fail</th><th>Blocked</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<div class="cols"><div><h2>Needs attention<small>' + (attTests.length + high.length) + "</small></h2>" +
      ((attTests.length + high.length) ? '<ul class="att">' + attTests.map(function (t) { return '<li class="sev-High"><span class="mono">' + esc(t.id) + "</span><p>" + pill(t.status) + " " + esc(t.objective) + "</p></li>"; }).join("") +
        high.map(function (d) { return '<li class="sev-High"><span class="mono">' + esc(d.id) + "</span><p>" + esc(d.summary) + "</p></li>"; }).join("") + "</ul>" : '<p class="empty">Nothing failing or blocked.</p>') +
      "<h2>Next to run</h2>" + (next.length ? '<ul class="att">' + next.map(function (t) { return '<li><span class="mono">' + esc(t.id) + "</span><p>" + esc(t.objective) + "</p></li>"; }).join("") + "</ul>" : '<p class="empty">Every test has a result.</p>') +
      "</div><div><h2>Open questions<small>" + oq.length + "</small></h2>" + (oq.length ? '<ul class="att">' + oq.map(function (q) { return '<li class="sev-Low"><span class="mono">Q' + esc(q.n) + "</span><p>" + esc(q.q) + "</p></li>"; }).join("") + "</ul>" : '<p class="empty">No open questions.</p>') +
      "<h2>Activity</h2><ul class=\"log\">" + state.log.slice(0, 12).map(function (l) { return "<li><time>" + esc(fmt(l.at)) + "</time>" + esc(l.text) + "</li>"; }).join("") + "</ul></div></div>";
  }

  function vTests() {
    var areas = []; state.tests.forEach(function (t) { var s = short(t.section); if (areas.indexOf(s) < 0) areas.push(s); });
    var q = ui.q.toLowerCase();
    var L = state.tests.filter(function (t) {
      if (ui.area && short(t.section) !== ui.area) return false;
      if (ui.status && (t.status || "Not run") !== ui.status) return false;
      if (q && (t.id + " " + t.objective + " " + t.steps + " " + t.expected + " " + t.data).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var html = '<div class="filters"><input type="search" id="f-q" placeholder="Search tests" value="' + esc(ui.q) + '"><select id="f-area"><option value="">All areas</option>' + areas.map(function (a) { return "<option" + (a === ui.area ? " selected" : "") + ">" + esc(a) + "</option>"; }).join("") +
      '</select><select id="f-status"><option value="">All results</option>' + STATUSES.map(function (s) { return "<option" + (s === ui.status ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + '</select><span class="count">' + L.length + " shown</span></div><div class=\"list\">";
    var last = null;
    L.forEach(function (t) {
      if (short(t.section) !== last) { last = short(t.section); html += '<div class="sec">' + esc(last) + "</div>"; }
      html += '<details class="item" data-id="' + esc(t.id) + '"' + (ui.open === t.id ? " open" : "") + '><summary><span class="mono">' + esc(t.id) + '</span><span class="obj">' + esc(t.objective) + "<small>" + esc(t.ref) + (t.prev ? " · before: " + esc(t.prev) : "") + "</small></span>" + pill(t.status) + "</summary>" +
        '<div class="body"><div class="field" style="gap:10px">' +
        (t.pre ? '<div class="field"><span class="lab">Pre-conditions</span><div class="txt">' + esc(t.pre) + "</div></div>" : "") +
        '<div class="field"><span class="lab">Steps</span><div class="txt">' + esc(t.steps) + "</div></div>" +
        (t.data && t.data !== "–" ? '<div class="field"><span class="lab">Test data</span><div class="txt">' + esc(t.data) + "</div></div>" : "") +
        '<div class="field"><span class="lab">Expected result</span><div class="txt">' + esc(t.expected) + "</div></div></div>" +
        '<div class="edit"><div class="row2"><div class="field"><label for="st-' + esc(t.id) + '">Result</label><select id="st-' + esc(t.id) + '" data-k="tests" data-f="status" data-l="result" data-id="' + esc(t.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + STATUSES.map(function (s) { return "<option" + (s === (t.status || "Not run") ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label for="ev-' + esc(t.id) + '">Evidence</label><input type="text" id="ev-' + esc(t.id) + '" data-k="tests" data-f="evidence" data-l="evidence" data-id="' + esc(t.id) + '" value="' + esc(t.evidence) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div>" +
        '<div class="field"><label for="ac-' + esc(t.id) + '">Actual result</label><textarea id="ac-' + esc(t.id) + '" data-k="tests" data-f="actual" data-l="actual result" data-id="' + esc(t.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(t.actual) + "</textarea></div>" +
        '<div class="field"><label for="co-' + esc(t.id) + '">Comments</label><textarea id="co-' + esc(t.id) + '" data-k="tests" data-f="comments" data-l="comments" data-id="' + esc(t.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(t.comments) + "</textarea></div></div></div></details>";
    });
    return html + (L.length ? "" : '<p class="empty">No tests match these filters.</p>') + "</div>";
  }

  function vDefects() {
    var q = ui.dq.toLowerCase();
    var L = state.defects.filter(function (d) {
      if (ui.dstatus === "open" && !openDefect(d)) return false;
      if (ui.dstatus && ui.dstatus !== "open" && d.status !== ui.dstatus) return false;
      if (q && (d.id + " " + d.summary + " " + d.area + " " + d.ref).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var nextId = nextDefectId();
    var html = '<div class="filters"><input type="search" id="f-dq" placeholder="Search defects" value="' + esc(ui.dq) + '"><select id="f-dstatus"><option value="">All defects</option><option value="open"' + (ui.dstatus === "open" ? " selected" : "") + ">Open only</option>" + DSTATUS.map(function (s) { return "<option" + (s === ui.dstatus ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + '</select><span class="count">' + L.length + " shown</span></div>";
    if (!ui.readOnly) html += '<form class="add" id="add-defect"><div class="eyebrow">New defect · ' + nextId + '</div><div class="row3"><div class="field"><label for="nd-area">Area</label><input type="text" id="nd-area" required placeholder="e.g. Rules"></div><div class="field"><label for="nd-sev">Severity</label><select id="nd-sev">' + SEV.map(function (s) { return "<option" + (s === "Medium" ? " selected" : "") + ">" + s + "</option>"; }).join("") + '</select></div><div class="field"><label for="nd-ref">Test ref</label><input type="text" id="nd-ref" placeholder="e.g. RUL-01"></div></div><div class="field"><label for="nd-sum">What goes wrong</label><textarea id="nd-sum" required></textarea></div><div class="field"><label for="nd-steps">Steps / evidence</label><input type="text" id="nd-steps"></div><div><button class="btn primary" type="submit">Add defect</button></div></form>';
    html += '<div class="list">' + L.map(function (d) {
      return '<details class="item" data-id="' + esc(d.id) + '"' + (ui.open === d.id ? " open" : "") + '><summary><span class="mono">' + esc(d.id) + '</span><span class="obj">' + esc(d.summary) + "<small>" + esc(d.area) + (d.ref ? " · " + esc(d.ref) : "") + " · " + esc(d.date) + "</small></span>" + sevPill(d.severity) + "</summary>" +
        '<div class="body"><div class="field" style="gap:10px"><div class="field"><span class="lab">Steps / evidence</span><div class="txt">' + esc(d.steps || "–") + "</div></div>" +
        '<div class="field"><label for="dsum-' + esc(d.id) + '">Summary</label><textarea id="dsum-' + esc(d.id) + '" data-k="defects" data-f="summary" data-l="summary" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(d.summary) + "</textarea></div></div>" +
        '<div class="edit"><div class="row2"><div class="field"><label for="ds-' + esc(d.id) + '">Status</label><select id="ds-' + esc(d.id) + '" data-k="defects" data-f="status" data-l="status" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + (DSTATUS.indexOf(d.status) < 0 ? "<option selected>" + esc(d.status) + "</option>" : "") + DSTATUS.map(function (s) { return "<option" + (s === d.status ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label for="dv-' + esc(d.id) + '">Severity</label><select id="dv-' + esc(d.id) + '" data-k="defects" data-f="severity" data-l="severity" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + SEV.map(function (s) { return "<option" + (s === d.severity ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div></div>" +
        '<div class="row2"><div class="field"><label for="dr-' + esc(d.id) + '">Raised with B4 (date)</label><input type="text" id="dr-' + esc(d.id) + '" data-k="defects" data-f="raised" data-l="raised" data-id="' + esc(d.id) + '" value="' + esc(d.raised) + '"' + (ui.readOnly ? " disabled" : "") + "></div>" +
        '<div class="field"><label for="df-' + esc(d.id) + '">Fix version</label><input type="text" id="df-' + esc(d.id) + '" data-k="defects" data-f="fix" data-l="fix version" data-id="' + esc(d.id) + '" value="' + esc(d.fix) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div>" +
        '<div class="field"><label for="drr-' + esc(d.id) + '">Retest result</label><input type="text" id="drr-' + esc(d.id) + '" data-k="defects" data-f="retestResult" data-l="retest result" data-id="' + esc(d.id) + '" value="' + esc(d.retestResult) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div></div></details>";
    }).join("") + (L.length ? "" : '<p class="empty">No defects match.</p>') + "</div>";
    return html;
  }

  function vParties() {
    var rec = state.parties.filter(function (p) { return p.recorded; }).length;
    return "<h2>Test parties<small>" + rec + " of " + state.parties.length + " recorded</small></h2>" +
      '<div class="tablewrap"><table><thead><tr><th>ID</th><th>Record</th><th>Purpose</th><th>Expected now</th><th>Once working</th><th>Recorded</th></tr></thead><tbody>' +
      state.parties.map(function (p) {
        var match = p.recorded ? (String(p.expectedNow).indexOf(p.recorded) === 0 && String(p.expectedNow).charAt(p.recorded.length) !== "+") : null;
        return '<tr><td class="mono">' + esc(p.id) + "</td><td>" + esc(p.name) + '<br><span class="count">' + esc(p.module + " · " + p.type) + "</span></td><td>" + esc(p.purpose) + "</td><td>" + esc(p.expectedNow) + "</td><td>" + esc(p.expectedFinal) + (p.total ? ' <span class="count num">(' + esc(p.total) + ")</span>" : "") + "</td>" +
          '<td><select aria-label="Recorded result for ' + esc(p.id) + '" id="pr-' + esc(p.id) + '" data-k="parties" data-f="recorded" data-l="recorded" data-id="' + esc(p.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + LEVELS.map(function (l) { return '<option value="' + l + '"' + (l === (p.recorded || "") ? " selected" : "") + ">" + (l || "–") + "</option>"; }).join("") + "</select>" +
          (match === null ? "" : match ? ' <span class="pill s-pass">matches</span>' : ' <span class="pill s-partial">check</span>') + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  function vQuestions() {
    return "<h2>Questions and answers<small>" + state.questions.filter(qOpen).length + " open</small></h2><div class=\"list\">" + state.questions.map(function (q) {
      var open = qOpen(q);
      return '<details class="item"><summary><span class="mono">Q' + esc(q.n) + '</span><span class="obj">' + esc(q.q) + "<small>" + esc(q.tests) + "</small></span>" + '<span class="pill ' + (open ? "s-partial" : "s-pass") + '">' + esc(q.status || "Open") + "</span></summary>" +
        '<div class="body"><div class="field"><label for="qa-' + esc(q.n) + '">Answer</label><textarea id="qa-' + esc(q.n) + '" data-k="questions" data-f="a" data-l="answer" data-id="' + esc(q.n) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(q.a) + '</textarea></div><div class="field"><label for="qs-' + esc(q.n) + '">Status</label><input type="text" id="qs-' + esc(q.n) + '" data-k="questions" data-f="status" data-l="status" data-id="' + esc(q.n) + '" value="' + esc(q.status) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div></details>";
    }).join("") + "</div>";
  }

  var COLS = {
    tests: [["ID", "id"], ["Area", "area"], ["Note ref", "ref"], ["Previous result (13 Oct)", "prev"], ["Objective", "objective"], ["Pre-conditions", "pre"], ["Steps", "steps"], ["Test data", "data"], ["Expected result", "expected"], ["Actual result", "actual"], ["Status", "status"], ["Evidence", "evidence"], ["Comments", "comments"]],
    parties: [["ID", "id"], ["Record name to create", "name"], ["Module", "module"], ["Party type", "type"], ["Purpose", "purpose"], ["Expected final risk (once working)", "expectedFinal"], ["Expected in current build", "expectedNow"], ["Used by tests", "tests"], ["Recorded in CFG-05", "recorded"]],
    defects: [["ID", "id"], ["Date found", "date"], ["Area", "area"], ["Summary", "summary"], ["Steps / evidence", "steps"], ["Severity", "severity"], ["Test ref", "ref"], ["Status", "status"], ["Raised with B4 (date)", "raised"], ["Fix version", "fix"], ["Retest date", "retestDate"], ["Retest result", "retestResult"]],
    questions: [["#", "n"], ["Question", "q"], ["Answer", "a"], ["Tests affected", "tests"], ["Status", "status"]]
  };
  var SHEETS = { tests: "Test cases", parties: "Test parties", defects: "Defect log", questions: "Questions and answers" };
  var EDITABLE = { tests: ["actual", "status", "evidence", "comments"], parties: ["recorded"], defects: ["area", "summary", "steps", "severity", "ref", "status", "raised", "fix", "retestDate", "retestResult"], questions: ["a", "status"] };

  function exportXlsx() {
    if (!window.XLSX) { notify("err", "The spreadsheet library didn't load."); return; }
    var wb = XLSX.utils.book_new();
    Object.keys(SHEETS).forEach(function (k) {
      var rows = [COLS[k].map(function (c) { return c[0]; })];
      state[k].forEach(function (r) { rows.push(COLS[k].map(function (c) { return r[c[1]] || ""; })); });
      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = COLS[k].map(function (c) { return { wch: Math.min(60, Math.max(8, c[0].length + 2)) }; });
      XLSX.utils.book_append_sheet(wb, ws, SHEETS[k]);
    });
    var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveFile("ISRA-Testing-Hub-" + now().slice(0, 10) + ".xlsx", new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  function readSheet(ws, k) {
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
    var idHead = COLS[k][0][0], hr = -1;
    for (var i = 0; i < Math.min(aoa.length, 12); i++) if (String(aoa[i][0]).trim() === idHead) { hr = i; break; }
    if (hr < 0) return [];
    var heads = aoa[hr].map(function (h) { return String(h).trim(); });
    var out = [];
    for (var r = hr + 1; r < aoa.length; r++) {
      var row = aoa[r], idv = String(row[0] || "").trim();
      if (!idv) continue;
      var rec = {};
      COLS[k].forEach(function (c) { var ix = heads.indexOf(c[0]); if (ix >= 0) rec[c[1]] = String(row[ix] == null ? "" : row[ix]).trim(); });
      rec[COLS[k][0][1]] = idv;
      out.push(rec);
    }
    return out;
  }

  function importFile(file) {
    if (!window.XLSX) { notify("err", "The spreadsheet library didn't load."); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var wb;
      try { wb = XLSX.read(new Uint8Array(fr.result), { type: "array" }); } catch (e) { notify("err", "That file couldn't be read as a spreadsheet."); return; }
      var changes = [];
      Object.keys(SHEETS).forEach(function (k) {
        var ws = wb.Sheets[SHEETS[k]]; if (!ws) return;
        readSheet(ws, k).forEach(function (rec) {
          var key = COLS[k][0][1], id = rec[key];
          var cur = k === "questions" ? state.questions.filter(function (q) { return q.n === id; })[0] : find(state[k], id);
          if (!cur) { if (k === "defects" && rec.summary) changes.push({ k: k, id: id, add: rec }); return; }
          EDITABLE[k].forEach(function (f) {
            if (rec[f] === undefined || rec[f] === "" || rec[f] === (cur[f] || "")) return;
            if (f === "status" && k === "tests" && rec[f] === "Not run") return; // an older sheet must not wipe a recorded result
            changes.push({ k: k, id: id, f: f, from: cur[f] || "", to: rec[f] });
          });
        });
      });
      ui.importDiff = { name: file.name, changes: changes };
      render();
    };
    fr.readAsArrayBuffer(file);
  }
  function applyImport() {
    var d = ui.importDiff; if (!d) return;
    d.changes.forEach(function (c) {
      if (c.add) {
        var rec = {}; COLS.defects.forEach(function (x) { rec[x[1]] = c.add[x[1]] || ""; });
        state.defects.push(rec); if (hosted) queue("defect", rec); return;
      }
      var cur = getRec(c.k, c.id);
      if (cur) { cur[c.f] = c.to; if (hosted) queue(KIND[c.k], cur); }
    });
    addLog("Imported " + d.changes.length + " change(s) from " + d.name + ".");
    if (!hosted) { dirty += d.changes.length; saveDraft(); }
    ui.importDiff = null; render();
  }

  function notify(kind, text) { ui.notice = { kind: kind, text: text }; render(); }

  // ---------- documents ----------
  function vDocuments() {
    var canUp = hosted && mode === "online";
    var h = "<h2>Documents<small>" + state.docs.length + " stored</small></h2>";
    if (canUp) h += '<div class="notice"><p>Upload any file up to 50 MB: Word, Excel, PDF, images, emails. Files are kept in private storage that only your account can open.</p><label class="btn primary" for="doc-up">' + (ui.uploading ? "Uploading…" : "Upload files") + '</label><input type="file" id="doc-up" multiple hidden></div>';
    else h += '<div class="notice warn"><p>Files are stored in the online hub. This offline copy lists them; open the online hub to download them.</p></div>';
    if (!state.docs.length) return h + '<p class="empty">No documents yet.</p>';
    h += '<div class="tablewrap"><table><thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Added</th><th>Note</th><th></th></tr></thead><tbody>' + state.docs.map(function (d) {
      var acts = !canUp ? '<span class="count">In the online hub</span>' :
        '<button class="btn" data-act="doc-dl" data-id="' + esc(d.id) + '">Download</button> <button class="btn" data-act="doc-open" data-id="' + esc(d.id) + '">Open</button>' +
        (ui.confirmDel === d.id ? ' <button class="btn" data-act="doc-del-yes" data-id="' + esc(d.id) + '" style="color:var(--fail)">Delete for good</button> <button class="btn" data-act="doc-del-no">Keep</button>' : ' <button class="btn" data-act="doc-del" data-id="' + esc(d.id) + '">Remove</button>');
      return "<tr><td>" + esc(d.name) + '</td><td class="mono">' + esc(ext(d.name).toUpperCase()) + '</td><td class="mono">' + esc(size(d.size)) + '</td><td class="mono">' + esc(fmt(d.uploaded)) + "</td>" +
        '<td><input type="text" aria-label="Note for ' + esc(d.name) + '" id="dn-' + esc(d.id) + '" data-k="docs" data-f="note" data-l="note" data-id="' + esc(d.id) + '" value="' + esc(d.note) + '"' + (canUp ? "" : " disabled") + '></td><td style="white-space:nowrap">' + acts + "</td></tr>";
    }).join("") + "</tbody></table></div>";
    return h;
  }
  function newId() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function uploadDocs(files) {
    var list = Array.prototype.slice.call(files), added = 0, problems = [];
    ui.uploading = true; render();
    var next = function () {
      if (!list.length) {
        ui.uploading = false;
        if (added) notify(problems.length ? "warn" : "", added + " file(s) uploaded. " + problems.join(" "));
        else notify("err", problems.join(" ") || "Nothing was uploaded.");
        return;
      }
      var f = list.shift();
      if (f.size > 52428800) { problems.push(f.name + ": over the 50 MB limit."); return next(); }
      var id = newId(), path = "docs/" + id + "/" + f.name.replace(/[^\w.\- ]+/g, "_");
      sb.storage.from(BUCKET).upload(path, f, { contentType: f.type || "application/octet-stream", upsert: false }).then(function (r) {
        if (r.error) throw r.error;
        var rec = { id: id, name: f.name, size: f.size, type: f.type || "", path: path, uploaded: now(), note: "" };
        state.docs.push(rec); queue("doc", rec); addLog("Document added: " + f.name); added++; next();
      }).catch(function (err) { problems.push(f.name + ": upload failed (" + ((err && err.message) || "error") + ")."); next(); });
    };
    next();
  }
  function downloadDoc(id) {
    var d = find(state.docs, id); if (!d) return;
    sb.storage.from(BUCKET).download(d.path).then(function (r) {
      if (r.error) throw r.error;
      return saveFile(d.name, r.data, d.type);
    }).catch(function (e) { notify("err", "Couldn’t download " + d.name + " (" + ((e && e.message) || "error") + ")."); });
  }
  function openDoc(id) {
    var d = find(state.docs, id); if (!d) return;
    var w = window.open("", "_blank");
    sb.storage.from(BUCKET).createSignedUrl(d.path, 600).then(function (r) {
      if (r.error) throw r.error;
      if (w) { w.opener = null; w.location.href = r.data.signedUrl; } else location.href = r.data.signedUrl;
    }).catch(function (e) { if (w) w.close(); notify("err", "Couldn’t open " + d.name + " (" + ((e && e.message) || "error") + ")."); });
  }
  function deleteDoc(id) {
    var d = find(state.docs, id); if (!d) return;
    sb.storage.from(BUCKET).remove([d.path]).then(function (r) {
      if (r.error) throw r.error;
      state.docs = state.docs.filter(function (x) { return x.id !== id; });
      queue("doc", d, true); addLog("Document removed: " + d.name); ui.confirmDel = null; render();
    }).catch(function (e) { ui.confirmDel = null; notify("err", "Couldn’t remove " + d.name + " (" + ((e && e.message) || "error") + ")."); });
  }

  // ---------- sign-in ----------
  function vSignin() {
    var a = ui.auth, busy = ui.authBusy ? " disabled" : "";
    var title = a === "signup" ? "Create your password" : a === "reset" ? "Reset your password" : a === "newpass" ? "Choose a new password" : "Sign in";
    var h = '<main class="wrap"><form class="panel signin" id="auth-form" autocomplete="on"><div class="eyebrow">' + TITLE + "</div><h1>" + title + "</h1>";
    if (ui.authMsg) h += '<p class="notice ' + esc(ui.authMsg.kind) + '" role="status">' + esc(ui.authMsg.text) + "</p>";
    if (a !== "newpass") h += '<div class="field"><label for="au-email">Email</label><input type="email" id="au-email" autocomplete="username" required value="' + esc(ui.authEmail || "") + '"></div>';
    if (a !== "reset") h += '<div class="field"><label for="au-pass">' + (a === "signin" ? "Password" : "New password (at least 12 characters)") + '</label><input type="password" id="au-pass" required ' + (a === "signin" ? 'autocomplete="current-password"' : 'autocomplete="new-password" minlength="12"') + "></div>";
    h += '<button class="btn primary" type="submit"' + busy + ">" + (ui.authBusy ? "Please wait…" : a === "signup" ? "Create password and sign in" : a === "reset" ? "Email me a reset link" : a === "newpass" ? "Save new password" : "Sign in") + "</button>";
    if (a === "signin") h += '<p class="links"><button type="button" class="link" data-auth="reset">Forgot password?</button> · <button type="button" class="link" data-auth="signup">First time here? Create your password</button></p>';
    else if (a !== "newpass") h += '<p class="links"><button type="button" class="link" data-auth="signin">Back to sign in</button></p>';
    return h + "</form></main>";
  }
  function authSubmit() {
    var a = ui.auth, email = $("#au-email") ? $("#au-email").value.trim() : "", pass = $("#au-pass") ? $("#au-pass").value : "";
    ui.authEmail = email; ui.authBusy = true; ui.authMsg = null; render();
    var done = function (msg) { ui.authBusy = false; ui.authMsg = msg || null; render(); };
    var fail = function (e) { done({ kind: "err", text: (e && e.message) || "Something went wrong. Try again." }); };
    if (a === "signin") sb.auth.signInWithPassword({ email: email, password: pass }).then(function (r) { if (r.error) return fail(r.error); done(); }, fail);
    else if (a === "signup") sb.auth.signUp({ email: email, password: pass, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
      if (r.error) return fail(/database error/i.test(r.error.message) ? { message: "This address can’t create an account here." } : r.error);
      if (r.data && r.data.session) return done();
      sb.auth.signInWithPassword({ email: email, password: pass }).then(function (s) {
        if (s.error) return done({ kind: "warn", text: "Account created. Check your email for a confirmation link, then sign in." });
        done();
      }, fail);
    }, fail);
    else if (a === "reset") sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) {
      if (r.error) return fail(r.error);
      ui.auth = "signin"; done({ kind: "", text: "If that address has an account, a reset link is on its way. Open it on this device." });
    }, fail);
    else if (a === "newpass") sb.auth.updateUser({ password: pass }).then(function (r) {
      if (r.error) return fail(r.error);
      recovering = false; ui.auth = "signin"; done({ kind: "", text: "Password changed." });
      try { history.replaceState(null, "", location.pathname); } catch (x) {}
      if (user) { loadedFor = user.id; loadAll(); }
    }, fail);
  }

  // ---------- page ----------
  function vNotice() {
    var h = "";
    if (mode === "offline") h += '<div class="notice warn"><p><b>Offline copy.</b> Changes are kept in this browser. Use “Save offline copy” to write them into a new file, or “Export spreadsheet” and upload it to the online hub to bring it up to date.</p></div>';
    if (ui.saveErr) h += '<div class="notice err"><p>Changes aren’t reaching the hub (' + esc(ui.saveErr) + "). They are kept in this browser and will be saved when the connection is back.</p><button class=\"btn\" data-act=\"retry\">Try now</button></div>";
    if (ui.notice) h += '<div class="notice ' + esc(ui.notice.kind || "") + '"><p>' + esc(ui.notice.text) + "</p>" + (ui.notice.draft ? '<button class="btn" data-act="apply-draft">Re-apply them</button><button class="btn" data-act="drop-draft">Discard</button>' : "") + '<button class="btn" data-act="dismiss">Dismiss</button></div>';
    if (ui.importDiff) {
      var d = ui.importDiff;
      h += '<div class="notice"><p><b>' + esc(d.name) + "</b>: " + (d.changes.length ? d.changes.length + " change(s) found. Review, then apply." : "no differences from the hub.") + "</p>" +
        (d.changes.length ? '<button class="btn primary" data-act="apply-import">Apply ' + d.changes.length + "</button>" : "") + '<button class="btn" data-act="cancel-import">' + (d.changes.length ? "Cancel" : "Close") + "</button>" +
        (d.changes.length ? '<ul class="diff">' + d.changes.slice(0, 200).map(function (c) { return c.add ? "<li>New defect " + esc(c.id) + ": " + esc(c.add.summary) + "</li>" : '<li><span class="mono">' + esc(c.id) + "</span> " + esc(c.f) + ": " + esc(c.from || "(blank)") + " → " + esc(c.to) + "</li>"; }).join("") + "</ul>" : "") + "</div>";
    }
    return h;
  }

  function render() {
    var root = $("#root"); if (!root) return;
    if (hosted && (mode === "starting" || mode === "loading")) { root.innerHTML = '<main class="wrap"><p class="empty">' + (mode === "loading" ? "Loading the hub…" : "Starting…") + "</p></main>"; return; }
    if (hosted && mode === "signin") {
      var keep = document.activeElement && document.activeElement.id, ev = $("#au-email") ? $("#au-email").value : null;
      if (ev != null) ui.authEmail = ev;
      root.innerHTML = vSignin();
      var k = keep && document.getElementById(keep); (k || $("#au-email") || $("#au-pass")) && (k || $("#au-email") || $("#au-pass")).focus();
      return;
    }
    if (hosted && (mode === "noaccess" || mode === "error")) {
      root.innerHTML = '<main class="wrap">' + vNotice() + '<div class="panel signin"><h1>' + (mode === "noaccess" ? "No access" : "Couldn’t load") + "</h1><p>" + (mode === "noaccess" ? "This account can’t open the hub." : "The hub didn’t load.") + '</p><div class="actions"><button class="btn" data-act="reload">Try again</button><button class="btn" data-act="signout">Sign out</button></div></div></main>';
      return;
    }
    var focusId = document.activeElement && document.activeElement.id, selStart = null;
    try { selStart = document.activeElement && document.activeElement.selectionStart; } catch (e) {}
    var openEl = root.querySelector("details.item[open]"); if (openEl) ui.open = openEl.getAttribute("data-id");
    var c = counts(state.tests), od = state.defects.filter(openDefect).length, pc = pendingCount();
    var chip = !hosted ? '<span class="mode off">Offline copy</span>' : ui.saveErr ? '<span class="mode off">Not saved yet · ' + pc + "</span>" : (flushing || pc) ? '<span class="mode">Saving…</span>' : '<span class="mode on">All changes saved</span>';
    var acts = hosted
      ? chip + '<button class="btn" data-act="reload" title="Load the latest from the hub">Refresh</button><label class="btn" for="imp">Upload spreadsheet</label><input type="file" id="imp" accept=".xlsx,.xls" hidden><button class="btn" data-act="export">Export spreadsheet</button><button class="btn" data-act="offline">Download offline copy</button><button class="btn" data-act="signout" title="' + esc(user && user.email) + '">Sign out</button>'
      : chip + '<label class="btn" for="imp">Upload spreadsheet</label><input type="file" id="imp" accept=".xlsx,.xls" hidden><button class="btn" data-act="export">Export spreadsheet</button><button class="btn primary" data-act="offline">Save offline copy' + (dirty ? " (" + dirty + ")" : "") + "</button>";
    var sub = esc(state.project) + (hosted ? (state.updated ? " · last change " + esc(fmt(state.updated)) : "") : " · copy " + esc(state.rev) + " · " + esc(fmt(state.updated)));
    var tabs = [["overview", "Overview", ""], ["tests", "Test cases", state.tests.length - c["Not run"] + "/" + state.tests.length], ["defects", "Defects", od + " open"], ["parties", "Test parties", state.parties.length], ["questions", "Questions", state.questions.filter(qOpen).length + " open"], ["documents", "Documents", state.docs.length]];
    root.innerHTML = '<header class="bar"><div class="bar-in"><div class="brand"><b>' + TITLE + "</b><span>" + sub + '</span></div><div class="actions">' + acts + '</div></div><nav class="tabs" role="tablist">' +
      tabs.map(function (t) { return '<button class="tab" role="tab" data-tab="' + t[0] + '" aria-selected="' + (ui.tab === t[0]) + '">' + t[1] + (t[2] !== "" ? '<span class="n">' + esc(t[2]) + "</span>" : "") + "</button>"; }).join("") + "</nav></header>" +
      '<main class="wrap">' + vNotice() + (ui.tab === "tests" ? vTests() : ui.tab === "defects" ? vDefects() : ui.tab === "parties" ? vParties() : ui.tab === "questions" ? vQuestions() : ui.tab === "documents" ? vDocuments() : vOverview()) + "</main>";
    if (focusId) { var f = document.getElementById(focusId); if (f) { f.focus(); try { if (selStart != null && f.setSelectionRange) f.setSelectionRange(selStart, selStart); } catch (e) {} } }
  }

  function signOut() {
    if (pendingCount() && !confirm("Some changes haven’t reached the hub yet. Sign out anyway? They stay in this browser and are saved next time you sign in here.")) return;
    sb.auth.signOut().then(function () {}, function () {});
  }

  // ---------- events ----------
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab],[data-act],[data-go-status],[data-auth]"); if (!t) return;
    if (t.hasAttribute("data-auth")) { ui.auth = t.getAttribute("data-auth"); ui.authMsg = null; render(); return; }
    if (t.hasAttribute("data-tab")) { ui.tab = t.getAttribute("data-tab"); ui.open = null; try { history.replaceState(null, "", "#" + ui.tab); } catch (x) {} render(); window.scrollTo(0, 0); return; }
    if (t.hasAttribute("data-go-status")) { ui.tab = "tests"; ui.status = t.getAttribute("data-go-status"); ui.area = ""; ui.q = ""; render(); return; }
    var a = t.getAttribute("data-act");
    if (a === "export") exportXlsx();
    else if (a === "offline") offlineCopy();
    else if (a === "reload") { if (pendingCount()) { ui.notice = { kind: "warn", text: "Still saving. Try Refresh again in a moment." }; render(); } else loadAll(); }
    else if (a === "retry") { retryMs = 0; schedule(0); }
    else if (a === "signout") signOut();
    else if (a === "dismiss") { ui.notice = null; render(); }
    else if (a === "apply-import") applyImport();
    else if (a === "cancel-import") { ui.importDiff = null; render(); }
    else if (a === "apply-draft" && ui.notice && ui.notice.draft) {
      var d = ui.notice.draft; state = d.state; state.rev = base.rev; dirty = d.dirty; ui.notice = { kind: "", text: "Re-applied " + dirty + " change(s). Check them, then save the offline copy." }; saveDraft(); render();
    } else if (a === "drop-draft") { clearDraft(); ui.notice = null; render(); }
    else if (a === "doc-dl") downloadDoc(t.getAttribute("data-id"));
    else if (a === "doc-open") openDoc(t.getAttribute("data-id"));
    else if (a === "doc-del") { ui.confirmDel = t.getAttribute("data-id"); render(); }
    else if (a === "doc-del-no") { ui.confirmDel = null; render(); }
    else if (a === "doc-del-yes") deleteDoc(t.getAttribute("data-id"));
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (el.id === "imp" && el.files && el.files[0]) { importFile(el.files[0]); el.value = ""; return; }
    if (el.id === "doc-up" && el.files && el.files.length) { uploadDocs(el.files); el.value = ""; return; }
    if (el.id === "f-area") { ui.area = el.value; render(); return; }
    if (el.id === "f-status") { ui.status = el.value; render(); return; }
    if (el.id === "f-dstatus") { ui.dstatus = el.value; render(); return; }
    if (el.dataset && el.dataset.k) setField(el.dataset.k, el.dataset.id, el.dataset.f, el.value, el.dataset.l);
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (el.id === "f-q") { ui.q = el.value; render(); }
    else if (el.id === "f-dq") { ui.dq = el.value; render(); }
  });
  document.addEventListener("submit", function (e) {
    if (e.target.id === "auth-form") { e.preventDefault(); authSubmit(); return; }
    if (e.target.id !== "add-defect") return;
    e.preventDefault();
    var sum = $("#nd-sum").value.trim(), area = $("#nd-area").value.trim();
    if (!sum || !area) return;
    var id = nextDefectId();
    var rec = { id: id, date: now().slice(0, 10), area: area, summary: sum, steps: $("#nd-steps").value.trim(), severity: $("#nd-sev").value, ref: $("#nd-ref").value.trim(), status: "Open", raised: "", fix: "", retestDate: "", retestResult: "" };
    state.defects.push(rec);
    addLog(id + " added: " + sum.slice(0, 80));
    if (hosted) queue("defect", rec); else { dirty++; saveDraft(); }
    ui.notice = { kind: "", text: id + " added." }; render();
  });
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (hosted) { retryMs = 0; schedule(0); } else offlineCopy(); }
  });
  function nextDefectId() { var m = 0; state.defects.forEach(function (d) { m = Math.max(m, num(d.id)); }); return "D-" + String(m + 1).padStart(2, "0"); }

  // ---------- start ----------
  if (!hosted) { mode = "offline"; render(); return; }
  sb = window.supabase.createClient(window.HUB_CONFIG.url, window.HUB_CONFIG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange(function (evt, session) {
    if (evt === "PASSWORD_RECOVERY" || (recovering && session)) { recovering = true; user = session && session.user; mode = "signin"; ui.auth = "newpass"; render(); return; }
    if (session && session.user) {
      user = session.user;
      if (loadedFor !== user.id && !(mode === "signin" && ui.auth === "newpass")) { loadedFor = user.id; setTimeout(loadAll, 0); }
    } else if (evt === "SIGNED_OUT" || evt === "INITIAL_SESSION") {
      user = null; loadedFor = null; mode = "signin"; ui.auth = "signin"; pend = {}; pendLog = [];
      state = { project: state.project, tests: [], parties: [], defects: [], questions: [], docs: [], log: [] };
      render();
    }
  });
})();
