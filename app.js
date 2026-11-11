(function () {
  "use strict";
  var TITLE = "Testing Hub";
  var OFFLINE_RESET = ":root{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}";
  // "Invalid" (11 Nov 2026): a test case that should not be run as written. It is left out of
  // the run totals and progress bars, so it counts neither as done nor as still to do.
  var STATUSES = ["Not run", "Retest", "Pass", "Partial pass", "Fail", "Blocked", "Invalid"];
  // Bar and legend order: results first, then what still needs running.
  var ORDER = ["Pass", "Partial pass", "Fail", "Blocked", "Retest", "Not run"];
  var QSTATUS = ["Open", "Asked B4", "Answered"];
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
  var sclass = function (s) { return { "Pass": "s-pass", "Partial pass": "s-partial", "Fail": "s-fail", "Blocked": "s-blocked", "Retest": "s-retest", "Invalid": "s-invalid" }[s] || "s-notrun"; };
  var scolor = function (s) { return { "Pass": "var(--pass)", "Partial pass": "var(--partial)", "Fail": "var(--fail)", "Blocked": "var(--blocked)", "Retest": "var(--retest)", "Invalid": "var(--invalid)" }[s] || "var(--notrun)"; };
  var trunc = function (v, n) { v = String(v || ""); return v.length > n ? v.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : v; };
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
  // #tests opens a tab; #tests/RUL-01 also opens that item in it (once the data is in).
  var TABS = ["overview", "tests", "defects", "parties", "questions", "documents"];
  function readHash(from) {
    try { var h = decodeURIComponent((from == null ? location.hash || "" : from).replace("#", "")), tab = h.split("/")[0]; } catch (e) { return null; }
    return TABS.indexOf(tab) >= 0 ? { tab: tab, id: h.slice(tab.length + 1) } : null;
  }
  var h0 = readHash(); if (h0) { ui.tab = h0.tab; ui.go = h0.id; }
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
    // A Refresh keeps the page on screen while it fetches, so you stay where you were; only the
    // first load shows "Loading the hub…" (blanking the page lost the scroll position).
    if (mode === "online") { ui.refreshing = true; render(); } else { mode = "loading"; render(); }
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
        if (row.kind === "meta") { if (row.rid === "setup") { s.setup = row.data; return; } if (row.data && row.data.project) s.project = row.data.project; if (row.data && row.data.source) s.source = row.data.source; return; }
        if (LIST[row.kind]) s[LIST[row.kind]].push(row.data);
      });
      s.log = (r[1].data || []).map(function (l) { return { at: local(new Date(l.at)), text: l.text }; });
      s.updated = latest ? local(new Date(latest)) : "";
      state = s; sortState();
      mode = r[0].data && r[0].data.length ? "online" : "noaccess";
      ui.refreshing = false;
      reapplyPending();
      render();
    }).catch(function (e) { ui.refreshing = false; mode = "error"; ui.notice = { kind: "err", text: "Couldn’t load the hub: " + ((e && e.message) || "network error") + ". Check the connection, then reload." }; render(); });
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
    if (k === "defects" && field === "status") freeTests(rec);
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
    var name = "Testing-Hub-" + now().slice(0, 10) + ".html";
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
  function toRun(t) { return !t.status || t.status === "Not run" || t.status === "Retest"; }
  function segs(c, total) { return ORDER.map(function (s) { var w = total ? (c[s] / total * 100) : 0; return w ? '<i style="width:' + w.toFixed(2) + '%;background:' + scolor(s) + '" title="' + esc(s + ": " + c[s]) + '"></i>' : ""; }).join(""); }
  function pill(s) { return '<span class="pill ' + sclass(s) + '">' + esc(s || "Not run") + "</span>"; }
  // Defect status on the list row: amber while it's with us, purple while it's with B4, green once fixed.
  function dstatusPill(d) {
    if (!live(d)) return '<span class="pill s-notrun">Deleted</span>';
    var s = d.status || "Open", c = { "Open": "s-fail", "To confirm": "s-partial", "Retest": "s-partial", "Raised with B4": "s-blocked", "Fixed": "s-pass", "Closed": "s-notrun" }[s] || "s-notrun";
    return '<span class="pill ' + c + '" title="Status">' + esc(s) + "</span>";
  }
  function sevPill(s) { var c = s === "High" ? "s-fail" : s === "Medium" ? "s-partial" : "s-notrun"; return '<span class="pill ' + c + '">' + esc(s || "–") + "</span>"; }
  function live(d) { return !d.deleted; }
  function openDefect(d) { return live(d) && ["Fixed", "Closed"].indexOf(d.status) < 0; }
  function delText(x) { return x && x.at ? fmt(x.at) + (x.by ? " by " + x.by : "") + ": " + x.reason : ""; }
  function historyFor(id) { return state.log.filter(function (l) { var t = String(l.text || ""); return t.indexOf(id + ":") === 0 || t.indexOf(id + " ") === 0; }).slice(0, 30); }
  function qOpen(q) { return !/^answered$/i.test(q.status || "") && !/^answered[:\s]/i.test(q.status || ""); }

  // ---------- cross-references ----------
  // Any test, defect, party or question ID written in a text field links to that item, and each
  // item lists the others that mention it. IDs are matched against the items that exist, so no
  // ID format is assumed. Rebuilt on every render.
  var REF_FIELDS = {
    tests: ["ref", "objective", "pre", "steps", "data", "expected", "actual", "comments"],
    defects: ["summary", "steps", "ref", "retestResult"],
    parties: ["purpose", "values", "related", "tests"],
    questions: ["q", "a", "tests", "status"]
  };
  var refs = { item: {}, re: null, by: {} };
  function qid(q) { return "Q" + q.n; }
  function itemId(tab, r) { return tab === "questions" ? qid(r) : r.id; }
  function buildRefs() {
    var item = {}, by = {};
    Object.keys(REF_FIELDS).forEach(function (tab) {
      (state[tab] || []).forEach(function (r) {
        var id = itemId(tab, r);
        // A bare number would match every count and date in the text.
        if (id && /[A-Za-z]/.test(id) && /\d/.test(id) && !item[id]) item[id] = { tab: tab, rec: r };
      });
    });
    var ids = Object.keys(item).sort(function (a, b) { return b.length - a.length; });
    var re = ids.length ? new RegExp("(^|[^A-Za-z0-9_-])(" + ids.map(function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|") + ")(?![A-Za-z0-9_-])", "g") : null;
    if (re) Object.keys(REF_FIELDS).forEach(function (tab) {
      (state[tab] || []).forEach(function (r) {
        var from = itemId(tab, r), seen = {};
        REF_FIELDS[tab].forEach(function (f) {
          String(r[f] == null ? "" : r[f]).replace(re, function (m, pre, id) {
            if (id !== from && !seen[id]) { seen[id] = 1; (by[id] = by[id] || []).push({ tab: tab, id: from, rec: r }); }
            return m;
          });
        });
      });
    });
    refs = { item: item, re: re, by: by };
  }
  // Plain links to #tab/id, so Back returns to where you were and they open in a new tab too.
  function href(tab, id) { return "#" + tab + "/" + encodeURIComponent(id); }
  function idLink(tab, id, cls) { return '<a class="ref' + (cls ? " " + cls : "") + '" href="' + esc(href(tab, id)) + '">' + esc(id) + "</a>"; }
  // Escapes text and links the IDs in it (not self, the item the text belongs to).
  function linked(text, self) {
    var h = esc(text);
    if (!refs.re) return h;
    return h.replace(refs.re, function (m, pre, id) {
      var it = refs.item[id];
      return it && id !== self ? pre + idLink(it.tab, id) : m;
    });
  }
  function refLabel(tab, r) { return tab === "tests" ? r.objective : tab === "defects" ? r.summary : tab === "parties" ? r.name : r.q; }
  function refPill(tab, r) { return tab === "tests" ? pill(r.status) : tab === "defects" ? dstatusPill(r) : tab === "questions" ? '<span class="pill ' + (qOpen(r) ? "s-partial" : "s-pass") + '">' + esc(r.status || "Open") + "</span>" : ""; }
  // The items whose text mentions this one, less any already shown by a direct link.
  function referencedByHtml(id, skip) {
    var L = (refs.by[id] || []).filter(function (x) { return !skip || skip.indexOf(x.id) < 0; });
    if (!L.length) return "";
    var order = ["tests", "defects", "parties", "questions"];
    L = L.slice().sort(function (a, b) { return order.indexOf(a.tab) - order.indexOf(b.tab); });
    return '<div class="field"><span class="lab">Referenced by · ' + L.length + '</span><div class="blk">' + L.map(function (x) {
      return '<span class="blk-chip"><a class="blk-go" href="' + esc(href(x.tab, x.id)) + '"><b class="mono">' + esc(x.id) + "</b> " + esc(refLabel(x.tab, x.rec)) + "</a>" + refPill(x.tab, x.rec) + "</span>";
    }).join("") + "</div></div>";
  }

  function vOverview() {
    var T = state.tests, c = counts(T), total = T.length - c.Invalid, done = total - c["Not run"] - c.Retest;
    var secs = []; T.forEach(function (t) { if (secs.indexOf(t.section) < 0) secs.push(t.section); });
    var rows = secs.map(function (s) {
      var L = T.filter(function (t) { return t.section === s; }), cc = counts(L), n = L.length - cc.Invalid, d = n - cc["Not run"] - cc.Retest;
      return "<tr><td>" + esc(short(s)) + '</td><td class="mono">' + d + "/" + n + '</td><td><div class="areabar">' + segs(cc, n) + '</div></td><td class="mono">' + cc.Pass + '</td><td class="mono">' + cc.Fail + '</td><td class="mono">' + cc.Blocked + "</td></tr>";
    }).join("");
    var D = state.defects.filter(live), od = D.filter(openDefect);
    var dsum = SEV.map(function (sv) {
      var n = od.filter(function (d) { return d.severity === sv; }).length, all = D.filter(function (d) { return d.severity === sv; }).length;
      return "<div>" + sevPill(sv) + '</div><div class="num">' + n + ' open</div><div class="num" style="color:var(--muted)">' + (all - n) + ' closed</div><div class="num" style="color:var(--muted)">' + all + " total</div>";
    }).join("");
    var attTests = T.filter(function (t) { return t.status === "Fail" || t.status === "Blocked"; });
    var high = od.filter(function (d) { return d.severity === "High"; });
    var oq = state.questions.filter(qOpen);
    var next = T.filter(function (t) { return t.status === "Retest"; }).concat(T.filter(function (t) { return toRun(t) && t.status !== "Retest"; })).slice(0, 5);
    return '<section class="summary"><div class="panel"><div class="eyebrow">Test cases</div><div class="big"><strong>' + done + "</strong><span>of " + total + " run · " + c.Pass + " passed</span></div>" +
      '<div class="seg">' + segs(c, total) + '</div><div class="legend">' + ORDER.map(function (s) { return '<button data-go-status="' + esc(s) + '"><span class="dot" style="background:' + scolor(s) + '"></span>' + esc(s) + ' <span class="num">' + c[s] + "</span></button>"; }).join("") +
        (c.Invalid ? '<button data-go-status="Invalid" title="Left out of the totals"><span class="dot" style="background:' + scolor("Invalid") + '"></span>Invalid, not counted <span class="num">' + c.Invalid + "</span></button>" : "") + "</div></div>" +
      '<div class="panel"><div class="eyebrow">Defects</div><div class="big"><strong>' + od.length + "</strong><span>open of " + D.length + '</span></div><div class="defsum">' + dsum + "</div></div></section>" +
      "<h2>By area<small>run / total, then the split by result</small></h2>" +
      '<div class="tablewrap"><table><thead><tr><th>Area</th><th>Run</th><th>Results</th><th>Pass</th><th>Fail</th><th>Blocked</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<div class="cols"><div><h2>Needs attention<small>' + (attTests.length + high.length) + "</small></h2>" +
      ((attTests.length + high.length) ? '<ul class="att">' + attTests.map(function (t) { return '<li class="sev-High">' + idLink("tests", t.id, "mono") + "<p>" + pill(t.status) + " " + esc(t.objective) + "</p></li>"; }).join("") +
        high.map(function (d) { return '<li class="sev-High">' + idLink("defects", d.id, "mono") + "<p>" + esc(d.summary) + "</p></li>"; }).join("") + "</ul>" : '<p class="empty">Nothing failing or blocked.</p>') +
      "<h2>Next to run</h2>" + (next.length ? '<ul class="att">' + next.map(function (t) { return '<li>' + idLink("tests", t.id, "mono") + "<p>" + (t.status === "Retest" ? pill("Retest") + " " : "") + esc(t.objective) + "</p></li>"; }).join("") + "</ul>" : '<p class="empty">Every test has a result.</p>') +
      "</div><div><h2>Open questions<small>" + oq.length + "</small></h2>" + (oq.length ? '<ul class="att">' + oq.map(function (q) { return '<li class="sev-Low">' + idLink("questions", qid(q), "mono") + "<p>" + esc(q.q) + "</p></li>"; }).join("") + "</ul>" : '<p class="empty">No open questions.</p>') +
      "<h2>Activity</h2><ul class=\"log\">" + state.log.slice(0, 12).map(function (l) { return "<li><time>" + esc(fmt(l.at)) + "</time>" + linked(l.text) + "</li>"; }).join("") + "</ul></div></div>";
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
      html += '<details class="item" data-id="' + esc(t.id) + '"' + (ui.open === t.id ? " open" : "") + '><summary><span class="mono">' + esc(t.id) + '</span><span class="obj">' + esc(t.objective) + "<small>" + [linked(t.ref, t.id), t.prev ? "before: " + esc(t.prev) : "", t.blockedBy && t.blockedBy.length ? "blocked by " + t.blockedBy.map(function (id) { return idLink("defects", id); }).join(", ") : ""].filter(Boolean).join(" · ") + "</small></span>" + pill(t.status) + "</summary>" +
        '<div class="body"><div class="field" style="gap:10px">' + (ui.wording === t.id && !ui.readOnly ? wordingHtml(t) :
        (t.pre ? '<div class="field"><span class="lab">Pre-conditions</span><div class="txt">' + linked(t.pre, t.id) + "</div></div>" : "") +
        '<div class="field"><span class="lab">Steps</span><div class="txt">' + linked(t.steps, t.id) + "</div></div>" +
        (t.data && t.data !== "–" ? '<div class="field"><span class="lab">Test data</span><div class="txt">' + linked(t.data, t.id) + "</div></div>" : "") +
        '<div class="field"><span class="lab">Expected result</span><div class="txt">' + linked(t.expected, t.id) + "</div></div>" +
        (ui.readOnly ? "" : '<div><button class="btn" data-act="edit-wording" data-id="' + esc(t.id) + '">Edit the wording</button></div>')) +
        referencedByHtml(t.id, t.blockedBy) + "</div>" +
        '<div class="edit"><div class="row2"><div class="field"><label for="st-' + esc(t.id) + '">Result</label><select id="st-' + esc(t.id) + '" data-k="tests" data-f="status" data-l="result" data-id="' + esc(t.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + STATUSES.map(function (s) { return "<option" + (s === (t.status || "Not run") ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label for="ev-' + esc(t.id) + '">Evidence</label><input type="text" id="ev-' + esc(t.id) + '" data-k="tests" data-f="evidence" data-l="evidence" data-id="' + esc(t.id) + '" value="' + esc(t.evidence) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div>" +
        '<div class="field"><label for="ac-' + esc(t.id) + '">Actual result</label><textarea id="ac-' + esc(t.id) + '" data-k="tests" data-f="actual" data-l="actual result" data-id="' + esc(t.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(t.actual) + "</textarea></div>" +
        '<div class="field"><label for="co-' + esc(t.id) + '">Comments</label><textarea id="co-' + esc(t.id) + '" data-k="tests" data-f="comments" data-l="comments" data-id="' + esc(t.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(t.comments) + "</textarea></div>" + shotsHtml(t, "tests") + blockedByHtml(t) +
        (ui.readOnly ? "" : '<div><button class="btn" data-act="raise-defect" data-id="' + esc(t.id) + '">Raise a defect from this test</button></div>') + "</div></div></details>";
    });
    return html + (L.length ? "" : '<p class="empty">No tests match these filters.</p>') + "</div>";
  }

  // ---------- defects blocking tests ----------
  // A test's own wording, editable in place (11 Nov 2026), so a correction no longer means
  // exporting the spreadsheet, changing it and uploading it again. Each box saves when it loses
  // focus, like every other field, and the change is logged.
  var WORDING = [["objective", "Objective"], ["pre", "Pre-conditions"], ["steps", "Steps"], ["data", "Test data"], ["expected", "Expected result"]];
  function wordingHtml(t) {
    return WORDING.map(function (w) {
      var id = "tw-" + w[0] + "-" + t.id;
      return '<div class="field"><label for="' + esc(id) + '">' + w[1] + '</label><textarea id="' + esc(id) + '" data-k="tests" data-f="' + w[0] + '" data-l="' + w[1].toLowerCase() + '" data-id="' + esc(t.id) + '">' + esc(t[w[0]]) + "</textarea></div>";
    }).join("") + '<div><button class="btn" data-act="done-wording">Done</button></div>';
  }

  // A test keeps the defects blocking it in blockedBy: ["D-01", ...]. The defect
  // side is worked out from the tests, so the link lives in one place only.
  function blockedTests(did) { return state.tests.filter(function (t) { return (t.blockedBy || []).indexOf(did) >= 0; }); }
  function saveTest(t) { if (hosted) queue("test", t); else { dirty++; saveDraft(); } }
  function blockedByHtml(t) {
    var ids = t.blockedBy || [], ro = ui.readOnly;
    var h = '<div class="field"><span class="lab">Blocked by defects</span>';
    h += ids.length ? '<div class="blk">' + ids.map(function (id) {
      var d = find(state.defects, id);
      return '<span class="blk-chip"><button class="blk-go" data-act="goto-defect" data-id="' + esc(id) + '" title="Open ' + esc(id) + '"><b class="mono">' + esc(id) + "</b> " + esc(d ? d.summary : "(no longer in the log)") + "</button>" + (d ? dstatusPill(d) : "") +
        (ro ? "" : '<button class="chip-x" data-act="unblock" data-id="' + esc(t.id) + '" data-def="' + esc(id) + '" title="Unlink ' + esc(id) + '" aria-label="Unlink ' + esc(id) + '">×</button>') + "</span>";
    }).join("") + "</div>" : '<div class="txt count">None linked.</div>';
    if (!ro) {
      var free = state.defects.filter(function (d) { return live(d) && ids.indexOf(d.id) < 0; });
      var opt = function (d) { return '<option value="' + esc(d.id) + '">' + esc(d.id + " · " + (d.status || "Open") + " · " + trunc(d.summary, 60)) + "</option>"; };
      var open = free.filter(openDefect), done = free.filter(function (d) { return !openDefect(d); });
      if (free.length) h += '<select id="bl-' + esc(t.id) + '" data-block="' + esc(t.id) + '" aria-label="Link a defect blocking ' + esc(t.id) + '"><option value="">Link a defect…</option>' +
        (open.length ? '<optgroup label="Open">' + open.map(opt).join("") + "</optgroup>" : "") +
        (done.length ? '<optgroup label="Fixed or closed">' + done.map(opt).join("") + "</optgroup>" : "") + "</select>";
      else if (!state.defects.filter(live).length) h += '<div class="count">No defects logged yet.</div>';
      if (ids.length && t.status !== "Blocked") h += '<div><button class="btn" data-act="set-blocked" data-id="' + esc(t.id) + '">Set result to Blocked</button></div>';
    }
    return h + "</div>";
  }
  function blockingHtml(d) {
    var T = blockedTests(d.id);
    if (!T.length) return "";
    return '<div class="field"><span class="lab">Blocking tests · ' + T.length + '</span><div class="blk">' + T.map(function (t) {
      return '<span class="blk-chip"><button class="blk-go" data-act="goto-test" data-id="' + esc(t.id) + '" title="Open ' + esc(t.id) + '"><b class="mono">' + esc(t.id) + "</b> " + esc(t.objective) + "</button>" + pill(t.status) + "</span>";
    }).join("") + "</div></div>";
  }
  function linkBlock(tid, did) {
    var t = find(state.tests, tid); if (!t || !did || (t.blockedBy || []).indexOf(did) >= 0) return;
    t.blockedBy = (t.blockedBy || []).concat(did);
    addLog(tid + ": blocked by " + did); addLog(did + ": blocking " + tid);
    saveTest(t); ui.open = tid; render();
  }
  function unlinkBlock(tid, did) {
    var t = find(state.tests, tid); if (!t) return;
    t.blockedBy = (t.blockedBy || []).filter(function (x) { return x !== did; });
    addLog(tid + ": no longer blocked by " + did); addLog(did + ": no longer blocking " + tid);
    saveTest(t); ui.open = tid; render();
  }
  // Jump to an item through the address, so Back comes back here.
  function goTo(tab, id) {
    rememberPlace();
    if (location.hash !== href(tab, id)) location.hash = href(tab, id); else showItem(tab, id);
  }
  // Before leaving, put the open item in the address so Back reopens it.
  function rememberPlace() {
    var o = document.querySelector("details.item[open][data-id]");
    try { history.replaceState(null, "", o ? href(ui.tab, o.getAttribute("data-id")) : "#" + ui.tab); } catch (x) {}
  }
  function itemEl(id) { return Array.prototype.filter.call(document.querySelectorAll("details.item[data-id]"), function (el) { return el.getAttribute("data-id") === id; })[0]; }
  // Open a test, defect, party or question, clearing filters that would hide it.
  function showItem(tab, id) {
    Array.prototype.forEach.call(document.querySelectorAll("details.item[open]"), function (el) { el.open = false; });
    ui.tab = tab; ui.open = id || null;
    if (tab === "tests") { ui.q = ""; ui.area = ""; ui.status = ""; }
    else if (tab === "defects") { ui.dq = ""; ui.dstatus = live(find(state.defects, id) || {}) ? "" : "deleted"; }
    else if (tab === "parties") { ui.pq = ""; ui.ptype = ""; ui.precorded = ""; }
    render();
    var el = id && itemEl(id); if (el) el.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0);
  }

  function defectTail(d) {
    var h = "";
    if (!live(d)) h += '<div class="delbox"><p><b>Deleted</b> ' + esc(delText(d.deleted)) + '</p><button class="btn" data-act="def-restore" data-id="' + esc(d.id) + '">Restore</button></div>';
    else if (ui.delAsk === d.id) h += '<div class="delbox"><div class="field"><label for="dr-why-' + esc(d.id) + '">Why delete ' + esc(d.id) + '? (kept in the activity log)</label><textarea id="dr-why-' + esc(d.id) + '" placeholder="e.g. Not a defect: company setting, not functionality"></textarea></div>' +
      '<div class="actions"><button class="btn danger" data-act="def-del-yes" data-id="' + esc(d.id) + '">Delete defect</button><button class="btn" data-act="def-del-no">Cancel</button></div></div>';
    else h += '<div><button class="btn" data-act="def-del" data-id="' + esc(d.id) + '">Delete…</button></div>';
    var hist = historyFor(d.id);
    if (hist.length) h += '<div class="field"><span class="lab">History</span><ul class="log">' + hist.map(function (l) { return "<li><time>" + esc(fmt(l.at)) + "</time>" + linked(l.text, d.id) + "</li>"; }).join("") + "</ul></div>";
    return h;
  }

  function vDefects() {
    var q = ui.dq.toLowerCase();
    var L = state.defects.filter(function (d) {
      if (ui.dstatus === "deleted") { if (live(d)) return false; }
      else if (!live(d)) return false;
      if (ui.dstatus === "open" && !openDefect(d)) return false;
      if (ui.dstatus && ui.dstatus !== "open" && ui.dstatus !== "deleted" && d.status !== ui.dstatus) return false;
      if (q && (d.id + " " + d.summary + " " + d.area + " " + d.ref).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var nextId = nextDefectId();
    var html = '<div class="filters"><input type="search" id="f-dq" placeholder="Search defects" value="' + esc(ui.dq) + '"><select id="f-dstatus"><option value="">All defects</option><option value="open"' + (ui.dstatus === "open" ? " selected" : "") + ">Open only</option>" + DSTATUS.map(function (s) { return "<option" + (s === ui.dstatus ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + '<option value="deleted"' + (ui.dstatus === "deleted" ? " selected" : "") + ">Deleted (" + state.defects.filter(function (d) { return !live(d); }).length + ")</option>" + '</select><span class="count">' + L.length + " shown</span></div>";
    var ndDraft = ui.nd && (ui.nd.link || ui.nd.area || ui.nd.sum || ui.nd.steps || ui.nd.ref);
    if (!ui.readOnly && !ui.ndOpen && !ndDraft) {
      // Starts as one button (11 Nov 2026), so the list of defects is what you see first.
      html += '<div class="add-closed"><button class="btn" data-act="nd-open">+ New defect · ' + nextId + "</button></div>";
    } else if (!ui.readOnly) {
      var nd = ui.nd || {}, from = nd.link && find(state.tests, nd.link);
      html += '<form class="add" id="add-defect"><div class="eyebrow">New defect · ' + nextId + (from ? " · from " + esc(from.id) : "") + '</div><div class="row3"><div class="field"><label for="nd-area">Area</label><input type="text" id="nd-area" required placeholder="e.g. Rules" value="' + esc(nd.area || "") + '"></div><div class="field"><label for="nd-sev">Severity</label><select id="nd-sev">' + SEV.map(function (s) { return "<option" + (s === (nd.sev || "Medium") ? " selected" : "") + ">" + s + "</option>"; }).join("") + '</select></div><div class="field"><label for="nd-ref">Test ref</label><input type="text" id="nd-ref" placeholder="e.g. RUL-01" value="' + esc(nd.ref || "") + '"></div></div>' +
        '<div class="field"><label for="nd-sum">What goes wrong</label><textarea id="nd-sum" required>' + esc(nd.sum || "") + '</textarea></div><div class="field"><label for="nd-steps">Steps / evidence</label><textarea id="nd-steps">' + esc(nd.steps || "") + "</textarea></div>" +
        (from ? '<label class="check"><input type="checkbox" id="nd-link"' + (nd.linkOff ? "" : " checked") + "> Link it to " + esc(from.id) + " as a defect blocking it, so the test is set to Retest once it’s fixed</label>" : "") +
        '<div class="actions"><button class="btn primary" type="submit">Add defect</button><button class="btn" type="button" data-act="nd-cancel">Cancel</button></div></form>';
    }
    html += '<div class="list">' + L.map(function (d) {
      return '<details class="item" data-id="' + esc(d.id) + '"' + (ui.open === d.id ? " open" : "") + '><summary><span class="mono">' + esc(d.id) + '</span><span class="obj">' + esc(d.summary) + "<small>" + esc(d.area) + (d.ref ? " · " + linked(d.ref, d.id) : "") + " · " + esc(d.date) + (d.shots && d.shots.length ? " · " + d.shots.length + " screenshot" + (d.shots.length === 1 ? "" : "s") : "") + (blockedTests(d.id).length ? " · blocks " + blockedTests(d.id).length + " test" + (blockedTests(d.id).length === 1 ? "" : "s") : "") + "</small></span>" + '<span class="pills">' + dstatusPill(d) + sevPill(d.severity) + "</span></summary>" +
        '<div class="body"><div class="field" style="gap:10px"><div class="field"><span class="lab">Steps / evidence</span><div class="txt">' + linked(d.steps || "–", d.id) + "</div></div>" + shotsHtml(d, "defects") + blockingHtml(d) + referencedByHtml(d.id, blockedTests(d.id).map(function (t) { return t.id; })) +
        '<div class="field"><label for="dsum-' + esc(d.id) + '">Summary</label><textarea id="dsum-' + esc(d.id) + '" data-k="defects" data-f="summary" data-l="summary" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(d.summary) + "</textarea></div></div>" +
        '<div class="edit"><div class="row2"><div class="field"><label for="ds-' + esc(d.id) + '">Status</label><select id="ds-' + esc(d.id) + '" data-k="defects" data-f="status" data-l="status" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + (DSTATUS.indexOf(d.status) < 0 ? "<option selected>" + esc(d.status) + "</option>" : "") + DSTATUS.map(function (s) { return "<option" + (s === d.status ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label for="dv-' + esc(d.id) + '">Severity</label><select id="dv-' + esc(d.id) + '" data-k="defects" data-f="severity" data-l="severity" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + SEV.map(function (s) { return "<option" + (s === d.severity ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select></div></div>" +
        '<div class="row2"><div class="field"><label for="dr-' + esc(d.id) + '">Raised with B4 (date)</label><input type="text" id="dr-' + esc(d.id) + '" data-k="defects" data-f="raised" data-l="raised" data-id="' + esc(d.id) + '" value="' + esc(d.raised) + '"' + (ui.readOnly ? " disabled" : "") + "></div>" +
        '<div class="field"><label for="df-' + esc(d.id) + '">Fix version</label><input type="text" id="df-' + esc(d.id) + '" data-k="defects" data-f="fix" data-l="fix version" data-id="' + esc(d.id) + '" value="' + esc(d.fix) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div>" +
        '<div class="row2">' + dInput(d, "area", "Area", "area") + dInput(d, "ref", "Test ref", "test ref") + "</div>" +
        '<div class="field"><label for="dsp-' + esc(d.id) + '">Steps / evidence</label><textarea id="dsp-' + esc(d.id) + '" data-k="defects" data-f="steps" data-l="steps" data-id="' + esc(d.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(d.steps) + "</textarea></div>" +
        '<div class="row2">' + dInput(d, "retestDate", "Retest date", "retest date", "YYYY-MM-DD") +
        '<div class="field"><label for="drr-' + esc(d.id) + '">Retest result</label><input type="text" id="drr-' + esc(d.id) + '" data-k="defects" data-f="retestResult" data-l="retest result" data-id="' + esc(d.id) + '" value="' + esc(d.retestResult) + '"' + (ui.readOnly ? " disabled" : "") + "></div></div>" + defectTail(d) + "</div></div></details>";
    }).join("") + (L.length ? "" : '<p class="empty">No defects match.</p>') + "</div>";
    return html;
  }

  var DIN = { area: "da-", ref: "dtr-", retestDate: "drd-" };
  function dInput(d, f, label, logLabel, ph) {
    var id = DIN[f] + d.id;
    return '<div class="field"><label for="' + esc(id) + '">' + esc(label) + '</label><input type="text" id="' + esc(id) + '" data-k="defects" data-f="' + f + '" data-l="' + esc(logLabel) + '" data-id="' + esc(d.id) + '" value="' + esc(d[f]) + '"' + (ph ? ' placeholder="' + ph + '"' : "") + (ui.readOnly ? " disabled" : "") + "></div>";
  }

  function vSetup() {
    var g = state.setup; if (!g) return "";
    var anyRec = state.parties.some(function (p) { return p.recorded; });
    return '<details class="guide"' + (anyRec ? "" : " open") + "><summary>" + esc(g.title || "How to set up a test party") + "</summary><div class=\"guide-in\">" +
      (g.intro ? "<p>" + esc(g.intro) + "</p>" : "") +
      (g.steps && g.steps.length ? "<ol>" + g.steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" : "") +
      (g.controls && g.controls.length ? '<div class="eyebrow">Control values</div><table class="ctl"><tbody>' + g.controls.map(function (c) { return "<tr><th>" + esc(c[0]) + "</th><td>" + esc(c[1]) + "</td></tr>"; }).join("") + "</tbody></table>" : "") +
      (g.order ? '<p class="count">' + esc(g.order) + "</p>" : "") + "</div></details>";
  }

  function vParties() {
    var rec = state.parties.filter(function (p) { return p.recorded; }).length;
    var q = (ui.pq || "").toLowerCase(), types = [];
    state.parties.forEach(function (p) { var t = p.module + " · " + p.type; if (types.indexOf(t) < 0) types.push(t); });
    var L = state.parties.filter(function (p) {
      if (ui.ptype && p.module + " · " + p.type !== ui.ptype) return false;
      if (ui.precorded === "yes" && !p.recorded) return false;
      if (ui.precorded === "no" && p.recorded) return false;
      if (q && (p.id + " " + p.name + " " + p.purpose + " " + p.values + " " + p.related + " " + p.tests).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var h = "<h2>Test parties<small>" + rec + " of " + state.parties.length + " recorded</small></h2>" + vSetup() +
      '<div class="filters"><input type="search" id="f-pq" placeholder="Search parties, values or tests" value="' + esc(ui.pq || "") + '">' +
      '<select id="f-ptype"><option value="">All party types</option>' + types.map(function (t) { return "<option" + (t === ui.ptype ? " selected" : "") + ">" + esc(t) + "</option>"; }).join("") + "</select>" +
      '<select id="f-prec"><option value="">Recorded or not</option><option value="no"' + (ui.precorded === "no" ? " selected" : "") + '>Not recorded yet</option><option value="yes"' + (ui.precorded === "yes" ? " selected" : "") + ">Recorded</option></select>" +
      '<span class="count">' + L.length + " shown</span></div><div class=\"list\">";
    h += L.map(function (p) {
      // Recorded against "Once working" (11 Nov 2026): "Expected in current build" is no longer
      // shown. The values stay in the data and the spreadsheet, in case they are wanted again.
      var match = p.recorded ? (String(p.expectedFinal).indexOf(p.recorded) === 0 && String(p.expectedFinal).charAt(p.recorded.length) !== "+") : null;
      var chip = match === null ? '<span class="pill s-notrun">Not recorded</span>' : match ? '<span class="pill s-pass">' + esc(p.recorded) + " · matches</span>" : '<span class="pill s-partial">' + esc(p.recorded) + " · check</span>";
      return '<details class="item" data-id="' + esc(p.id) + '"' + (ui.open === p.id ? " open" : "") + '><summary><span class="mono">' + esc(p.id) + '</span><span class="obj">' + esc(p.name) + "<small>" + esc(p.module + " · " + p.type) + (p.expectedFinal ? " · once working: " + esc(p.expectedFinal) : "") + "</small></span>" + chip + "</summary>" +
        '<div class="body"><div class="field" style="gap:10px">' +
        '<div class="field"><span class="lab">Purpose</span><div class="txt">' + linked(p.purpose, p.id) + "</div></div>" +
        '<div class="field"><span class="lab">Values to enter (everything else: control values)</span><div class="txt setv">' + linked(p.values || "All control values.", p.id) + "</div></div>" +
        '<div class="field"><span class="lab">Related parties to add</span><div class="txt setv">' + linked(p.related || "None", p.id) + "</div></div>" + referencedByHtml(p.id) + "</div>" +
        '<div class="edit"><div class="field"><span class="lab">Once working</span><div class="txt">' + esc(p.expectedFinal) + (p.total ? ' <span class="count num">(' + esc(p.total) + ")</span>" : "") + "</div></div>" +
        '<div class="field"><label for="pr-' + esc(p.id) + '">Recorded final risk</label><select id="pr-' + esc(p.id) + '" data-k="parties" data-f="recorded" data-l="recorded" data-id="' + esc(p.id) + '"' + (ui.readOnly ? " disabled" : "") + ">" + LEVELS.map(function (l) { return '<option value="' + l + '"' + (l === (p.recorded || "") ? " selected" : "") + ">" + (l || "–") + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><span class="lab">Used by tests</span><div class="txt">' + linked(p.tests, p.id) + "</div></div></div></div></details>";
    }).join("") + (L.length ? "" : '<p class="empty">No parties match.</p>') + "</div>";
    return h;
  }

  function vQuestions() {
    return "<h2>Questions and answers<small>" + state.questions.filter(qOpen).length + " open</small></h2><div class=\"list\">" + state.questions.map(function (q) {
      var open = qOpen(q);
      return '<details class="item" data-id="' + esc(qid(q)) + '"' + (ui.open === qid(q) ? " open" : "") + '><summary><span class="mono">' + esc(qid(q)) + '</span><span class="obj">' + linked(q.q, qid(q)) + "<small>" + linked(q.tests, qid(q)) + "</small></span>" + '<span class="pill ' + (open ? "s-partial" : "s-pass") + '">' + esc(q.status || "Open") + "</span></summary>" +
        '<div class="body"><div class="field">' + referencedByHtml(qid(q)) + '<label for="qa-' + esc(q.n) + '">Answer</label><textarea id="qa-' + esc(q.n) + '" data-k="questions" data-f="a" data-l="answer" data-id="' + esc(q.n) + '"' + (ui.readOnly ? " disabled" : "") + ">" + esc(q.a) + '</textarea></div><div class="field"><label for="qs-' + esc(q.n) + '">Status</label><select id="qs-' + esc(q.n) + '" data-k="questions" data-f="status" data-l="status" data-id="' + esc(q.n) + '"' + (ui.readOnly ? " disabled" : "") + ">" +
        (q.status && QSTATUS.indexOf(q.status) < 0 ? "<option selected>" + esc(q.status) + "</option>" : "") + QSTATUS.map(function (s) { return "<option" + (s === (q.status || "Open") ? " selected" : "") + ">" + esc(s) + "</option>"; }).join("") + "</select></div></div></details>";
    }).join("") + "</div>";
  }

  var COLS = {
    tests: [["ID", "id"], ["Area", "area"], ["Note ref", "ref"], ["Previous result (13 Oct)", "prev"], ["Objective", "objective"], ["Pre-conditions", "pre"], ["Steps", "steps"], ["Test data", "data"], ["Expected result", "expected"], ["Actual result", "actual"], ["Status", "status"], ["Evidence", "evidence"], ["Comments", "comments"], ["Blocked by defects", "blockedBy"]],
    parties: [["ID", "id"], ["Record name to create", "name"], ["Module", "module"], ["Party type", "type"], ["Purpose", "purpose"], ["Values to enter (fields that drive the score)", "values"], ["Related parties to add", "related"], ["Expected final risk (once working)", "expectedFinal"], ["Expected in current build", "expectedNow"], ["Used by tests", "tests"], ["Recorded in CFG-05", "recorded"]],
    defects: [["ID", "id"], ["Date found", "date"], ["Area", "area"], ["Summary", "summary"], ["Steps / evidence", "steps"], ["Severity", "severity"], ["Test ref", "ref"], ["Status", "status"], ["Raised with B4 (date)", "raised"], ["Fix version", "fix"], ["Retest date", "retestDate"], ["Retest result", "retestResult"], ["Deleted (reason)", "deleted"]],
    questions: [["#", "n"], ["Question", "q"], ["Answer", "a"], ["Tests affected", "tests"], ["Status", "status"]]
  };
  var SHEETS = { tests: "Test cases", parties: "Test parties", defects: "Defect log", questions: "Questions and answers" };
  var EDITABLE = { tests: ["actual", "status", "evidence", "comments"], parties: ["recorded"], defects: ["area", "summary", "steps", "severity", "ref", "status", "raised", "fix", "retestDate", "retestResult"], questions: ["a", "status"] };

  function exportXlsx() {
    if (!window.XLSX) { notify("err", "The spreadsheet library didn't load."); return; }
    var wb = XLSX.utils.book_new();
    Object.keys(SHEETS).forEach(function (k) {
      var rows = [COLS[k].map(function (c) { return c[0]; })];
      state[k].forEach(function (r) { rows.push(COLS[k].map(function (c) { return c[1] === "deleted" ? delText(r.deleted) : Array.isArray(r[c[1]]) ? r[c[1]].join(", ") : (r[c[1]] || ""); })); });
      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = COLS[k].map(function (c) { return { wch: Math.min(60, Math.max(8, c[0].length + 2)) }; });
      XLSX.utils.book_append_sheet(wb, ws, SHEETS[k]);
    });
    var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    saveFile("Testing-Hub-" + now().slice(0, 10) + ".xlsx", new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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
        var rec = {}; COLS.defects.forEach(function (x) { rec[x[1]] = c.add[x[1]] || ""; }); delete rec.deleted;
        state.defects.push(rec); if (hosted) queue("defect", rec); return;
      }
      var cur = getRec(c.k, c.id);
      if (cur) { cur[c.f] = c.to; if (hosted) queue(KIND[c.k], cur); }
    });
    addLog("Imported " + d.changes.length + " change(s) from " + d.name + ".");
    if (!hosted) { dirty += d.changes.length; saveDraft(); }
    ui.importDiff = null; render();
  }

  function persistDefect(d) { if (hosted) queue("defect", d); else { dirty++; saveDraft(); } }
  function deleteDefect(id) {
    var d = find(state.defects, id), el = document.getElementById("dr-why-" + id), why = el ? el.value.trim() : "";
    if (!d) return;
    if (!why) { if (el) { el.focus(); el.setAttribute("aria-invalid", "true"); el.placeholder = "A reason is needed to delete " + id; } return; }
    d.deleted = { at: now(), by: (user && user.email) || "", reason: why };
    addLog(id + " deleted: " + why);
    persistDefect(d); ui.delAsk = null; ui.open = null;
    ui.notice = { kind: "", text: id + " deleted. It stays under Deleted in the defect filter, where you can restore it." }; render();
  }
  function restoreDefect(id) {
    var d = find(state.defects, id); if (!d || !d.deleted) return;
    var why = d.deleted.reason; delete d.deleted;
    addLog(id + " restored (had been deleted: " + why + ")");
    persistDefect(d); ui.notice = { kind: "", text: id + " restored." }; render();
  }

  function notify(kind, text) { ui.notice = { kind: kind, text: text }; render(); }

  // ---------- screenshots and screen recordings ----------
  // Defects and test cases carry shots: [{ id, name, path, size, type, added, by }]. The files
  // sit in the same private bucket as the documents, under defects/<id>/ or tests/<id>/, and
  // are fetched with the signed-in session, so a thumbnail is a blob: URL (the page's CSP
  // allows blob: and data: images only). A recording (video/*) shows as a tile and opens in
  // a new tab through a signed link; it is never downloaded just to draw the list.
  var shotUrl = {}, shotLoading = {};
  var SHOT_DIR = { defects: "defects", tests: "tests" };
  function shotRec(k, id) { return find(state[k] || [], id); }
  function isVideo(x) { return /^video\//.test(x.type || ""); }
  function canShoot(d) { return hosted && mode === "online" && !ui.readOnly && live(d); }
  function shotsHtml(d, k) {
    k = k || "defects";
    var S = d.shots || [], can = canShoot(d);
    if (!S.length && !can) return "";
    var nv = S.filter(isVideo).length, ni = S.length - nv;
    var label = can && CAN_REC ? "Screenshots and recordings" : nv ? "Screenshots and recordings" : "Screenshots";
    var h = '<div class="field"><span class="lab">' + label + (S.length ? " · " + [ni ? ni + " image" + (ni === 1 ? "" : "s") : "", nv ? nv + " recording" + (nv === 1 ? "" : "s") : ""].filter(Boolean).join(", ") : "") + "</span>";
    if (S.length) h += '<div class="shots">' + S.map(function (x) {
      var del = !can ? "" : ui.shotDel === x.id
        ? '<div class="shot-ask"><button class="btn danger" data-act="shot-del-yes" data-k="' + k + '" data-id="' + esc(d.id) + '" data-shot="' + esc(x.id) + '">Delete</button><button class="btn" data-act="shot-del-no">Keep</button></div>'
        : '<button class="shot-x" data-act="shot-del" data-shot="' + esc(x.id) + '" title="Remove this ' + (isVideo(x) ? "recording" : "screenshot") + '" aria-label="Remove ' + esc(x.name) + '">×</button>';
      var face = !hosted ? '<div class="shot-img off">' + esc(x.name) + "</div>"
        : isVideo(x) ? '<button class="shot-img shot-video" data-act="shot-open" data-shot="' + esc(x.id) + '" title="Play the recording (opens in a new tab)"><span class="play" aria-hidden="true">▶</span><span>Recording' + (x.secs ? " · " + mmss(x.secs) : "") + "</span><span class=\"count\">" + esc(mb(x.size)) + "</span></button>"
        : '<button class="shot-img" data-act="shot-open" data-shot="' + esc(x.id) + '" title="Open full size"><img alt="' + esc(x.name) + '" data-shot-img="' + esc(x.id) + '"' + (shotUrl[x.id] ? ' src="' + shotUrl[x.id] + '"' : "") + "></button>";
      return '<figure class="shot">' + face + "<figcaption>" + esc(fmt(x.added)) + "</figcaption>" + del + "</figure>";
    }).join("") + "</div>";
    if (can) {
      var busy = ui.shotBusy === d.id, mine = recording && recording.id === d.id && recording.k === k;
      h += '<div class="shot-add"><label class="btn" for="shot-up-' + k + "-" + esc(d.id) + '">' + (busy ? "Uploading…" : "Add screenshots") + '</label><input type="file" id="shot-up-' + k + "-" + esc(d.id) + '" data-shot-up="' + esc(d.id) + '" data-shot-k="' + k + '" accept="image/*,video/*" multiple hidden>' +
        (CAN_REC ? (mine ? '<button class="btn danger" data-act="rec-stop" id="rec-btn">■ Stop recording · <span id="rec-time">' + mmss(recSecs()) + "</span></button>"
          : '<button class="btn" data-act="rec-start" data-k="' + k + '" data-id="' + esc(d.id) + '"' + (recording || busy ? " disabled" : "") + ">● Record screen</button>") : "") +
        '<span class="count">or paste one (Ctrl+V / ⌘V) while this is open' + (CAN_REC ? ". Recordings stop by themselves at " + REC_MAX_MIN + " minutes" : "") + "</span></div>";
    } else if (!hosted && S.length) h += '<p class="count">Open the online hub to see them.</p>';
    return h + "</div>";
  }
  function mmss(n) { n = Math.max(0, Math.round(n)); return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0"); }
  function mb(b) { return b ? (b / 1048576 < 0.1 ? "<0.1" : (b / 1048576).toFixed(1)) + " MB" : ""; }
  function findShot(id) {
    var lists = [state.defects, state.tests];
    for (var L = 0; L < lists.length; L++) for (var i = 0; i < lists[L].length; i++) { var S = lists[L][i].shots || []; for (var j = 0; j < S.length; j++) if (S[j].id === id) return S[j]; }
    return null;
  }
  // Thumbnails load only for the item that is open, and only for images.
  function loadThumbs() {
    if (!sb) return;
    Array.prototype.forEach.call(document.querySelectorAll("details.item[open] img[data-shot-img]:not([src])"), function (img) {
      var id = img.getAttribute("data-shot-img"), x = findShot(id);
      if (!x || shotLoading[id]) return;
      shotLoading[id] = true;
      sb.storage.from(BUCKET).download(x.path).then(function (r) {
        if (r.error) throw r.error;
        shotUrl[id] = URL.createObjectURL(r.data);
        Array.prototype.forEach.call(document.querySelectorAll('img[data-shot-img="' + id + '"]'), function (el) { el.src = shotUrl[id]; });
      }).catch(function () { img.alt = x.name + " (couldn’t load)"; }).then(function () { delete shotLoading[id]; });
    });
  }
  var IMG_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" };
  function persistShots(k, rec) { if (k === "tests") saveTest(rec); else persistDefect(rec); }
  function addShots(k, id, files, meta) {
    var list = Array.prototype.filter.call(files, function (f) { return /^(image|video)\//.test(f.type); });
    if (!shotRec(k, id) || !sb) return;
    if (!list.length) { notify("err", "Only images and videos can be added here."); return; }
    var added = [], problems = [];
    ui.shotBusy = id; ui.open = id; render();
    var next = function () {
      if (!list.length) {
        ui.shotBusy = null;
        // Merge into the item as it is now: a refresh may have replaced it meanwhile.
        var d = shotRec(k, id);
        if (d && added.length) {
          d.shots = (d.shots || []).concat(added);
          var vids = added.filter(isVideo).length, imgs = added.length - vids;
          addLog(id + ": " + [imgs ? (imgs === 1 ? "screenshot added" : imgs + " screenshots added") : "", vids ? (vids === 1 ? "recording added" : vids + " recordings added") : ""].filter(Boolean).join(", ") + (added.length === 1 ? " (" + added[0].name + ")" : ""));
          persistShots(k, d);
        }
        if (problems.length) notify(added.length ? "warn" : "err", problems.join(" ")); else render();
        return;
      }
      var f = list.shift(), sid = newId();
      // A pasted image arrives as "image.png"; give it a dated name instead.
      var name = f.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name) ? f.name : "Screenshot " + now().replace("T", " ").replace(/:/g, ".") + "." + (IMG_EXT[f.type] || "png");
      if (f.size > 52428800) { problems.push(name + ": over the 50 MB limit."); return next(); }
      var path = SHOT_DIR[k] + "/" + id.replace(/[^\w-]+/g, "_") + "/" + sid + "-" + name.replace(/[^\w.\- ]+/g, "_");
      sb.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false }).then(function (r) {
        if (r.error) throw r.error;
        var x = { id: sid, name: name, path: path, size: f.size, type: f.type, added: now(), by: (user && user.email) || "" };
        if (meta && meta.secs) x.secs = meta.secs;
        added.push(x);
        if (!/^video\//.test(f.type)) shotUrl[sid] = URL.createObjectURL(f);
        next();
      }).catch(function (err) { problems.push(name + ": upload failed (" + ((err && err.message) || "error") + ")."); next(); });
    };
    next();
  }
  function deleteShot(k, id, sid) {
    var d = shotRec(k, id), x = d && (d.shots || []).filter(function (s) { return s.id === sid; })[0];
    if (!x) return;
    sb.storage.from(BUCKET).remove([x.path]).then(function (r) {
      if (r.error) throw r.error;
      var cur = shotRec(k, id) || d;
      cur.shots = (cur.shots || []).filter(function (s) { return s.id !== sid; });
      addLog(id + ": " + (isVideo(x) ? "recording" : "screenshot") + " removed (" + x.name + ")");
      persistShots(k, cur); ui.shotDel = null; render();
    }).catch(function (e) { ui.shotDel = null; notify("err", "Couldn’t remove " + x.name + " (" + ((e && e.message) || "error") + ")."); });
  }
  function openShot(sid) {
    var x = findShot(sid); if (!x) return;
    var w = window.open("", "_blank");
    sb.storage.from(BUCKET).createSignedUrl(x.path, 600).then(function (r) {
      if (r.error) throw r.error;
      if (w) { w.opener = null; w.location.href = r.data.signedUrl; } else location.href = r.data.signedUrl;
    }).catch(function (e) { if (w) w.close(); notify("err", "Couldn’t open " + x.name + " (" + ((e && e.message) || "error") + ")."); });
  }

  // ---------- screen recording (11 Nov 2026) ----------
  // "Record screen" asks the browser to share a window, tab or screen, records it until Stop
  // (or until sharing ends, or REC_MAX_MIN minutes), then attaches the clip like a screenshot.
  // Computers only: phones' browsers don't offer screen sharing, so the button isn't shown.
  // About 1 Mbit/s keeps five minutes near 38 MB, under the bucket's 50 MB limit.
  var REC_MAX_MIN = 5, REC_BITS = 1000000;
  var CAN_REC = !!(typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && typeof MediaRecorder !== "undefined");
  var recording = null;
  function recSecs() { return recording ? (Date.now() - recording.started) / 1000 : 0; }
  function recType() {
    var c = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
    for (var i = 0; i < c.length; i++) if (!MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(c[i])) return c[i];
    return "";
  }
  function startRecording(k, id) {
    if (recording || !CAN_REC || !shotRec(k, id)) return;
    navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }).then(function (stream) {
      var type = recType(), chunks = [];
      var mr = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: REC_BITS } : { videoBitsPerSecond: REC_BITS });
      recording = { k: k, id: id, mr: mr, stream: stream, started: Date.now(), type: (type || "video/webm").split(";")[0] };
      mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = function () {
        var r = recording; recording = null;
        clearInterval(r.tick); clearTimeout(r.cap);
        r.stream.getTracks().forEach(function (t) { t.stop(); });
        var secs = Math.round((Date.now() - r.started) / 1000);
        if (!chunks.length) { notify("err", "The recording was empty, so nothing was added."); return; }
        var blob = new Blob(chunks, { type: r.type }), ext = /mp4/.test(r.type) ? "mp4" : "webm";
        var file = new File([blob], "Recording " + now().replace("T", " ").replace(/:/g, ".") + "." + ext, { type: r.type });
        addShots(r.k, r.id, [file], { secs: secs });
      };
      // Sharing stopped from the browser's own bar counts as Stop.
      stream.getVideoTracks().forEach(function (t) { t.onended = stopRecording; });
      recording.tick = setInterval(function () { var el = document.getElementById("rec-time"); if (el) el.textContent = mmss(recSecs()); }, 1000);
      recording.cap = setTimeout(stopRecording, REC_MAX_MIN * 60000);
      mr.start(1000);
      ui.open = id; render();
    }).catch(function (e) {
      // Cancelling the browser's share prompt is a choice, not an error.
      if (e && (e.name === "NotAllowedError" || e.name === "AbortError")) return;
      notify("err", "Couldn’t start recording (" + ((e && e.message) || "error") + ").");
    });
  }
  function stopRecording() { if (recording && recording.mr.state !== "inactive") recording.mr.stop(); }

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

  // ---------- a fixed defect frees its tests ----------
  // When a defect is fixed or closed, every test it was holding up (Blocked, Fail or
  // Partial pass) that nothing else open still blocks is set to Retest. The notice
  // offers Undo.
  function andList(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }
  function freeTests(d) {
    if (openDefect(d)) return;
    var T = blockedTests(d.id).filter(function (t) {
      if (["Blocked", "Fail", "Partial pass"].indexOf(t.status) < 0) return false;
      return (t.blockedBy || []).every(function (id) { var x = find(state.defects, id); return !x || !openDefect(x); });
    });
    if (!T.length) return;
    var prev = {};
    T.forEach(function (t) { prev[t.id] = t.status; t.status = "Retest"; addLog(t.id + ": result → Retest (" + d.id + " " + String(d.status || "").toLowerCase() + ")"); saveTest(t); });
    var ids = T.map(function (t) { return t.id; });
    ui.notice = { kind: "", text: andList(ids) + (ids.length === 1 ? " is" : " are") + " now Retest: " + d.id + " is " + d.status + " and nothing else open blocks " + (ids.length === 1 ? "it." : "them."), undo: prev };
  }
  function undoFree() {
    var prev = ui.notice && ui.notice.undo; if (!prev) return;
    Object.keys(prev).forEach(function (id) {
      var t = find(state.tests, id); if (!t || t.status !== "Retest") return;
      t.status = prev[id]; addLog(id + ": result → " + prev[id] + " (undone)"); saveTest(t);
    });
    ui.notice = null; render();
  }

  // ---------- raise a defect from a test ----------
  function raiseFrom(tid) {
    var t = find(state.tests, tid); if (!t) return;
    var steps = [t.steps && "Steps: " + t.steps, t.data && t.data !== "–" && "Test data: " + t.data, t.expected && "Expected: " + t.expected, t.actual && "Actual: " + t.actual, t.evidence && "Evidence: " + t.evidence].filter(Boolean).join("\n");
    ui.nd = { area: t.area || short(t.section) || "", sev: "Medium", ref: t.id, sum: t.actual || "", steps: steps, link: t.id };
    ui.peek = null;
    rememberPlace();
    ui.tab = "defects"; ui.open = null; ui.dq = ""; ui.dstatus = "";
    try { history.pushState(null, "", "#defects"); } catch (x) {}
    Array.prototype.forEach.call(document.querySelectorAll("details.item[open]"), function (el) { el.open = false; });
    render();
    var f = $("#add-defect"); if (f) f.scrollIntoView({ block: "start" });
    var s = $("#nd-sum"); if (s) s.focus();
  }
  var ND = { "nd-area": "area", "nd-sev": "sev", "nd-ref": "ref", "nd-sum": "sum", "nd-steps": "steps" };
  function ndCapture(el) {
    if (el.id === "nd-link") { ui.nd = ui.nd || {}; ui.nd.linkOff = !el.checked; return true; }
    if (!ND[el.id]) return false;
    ui.nd = ui.nd || {}; ui.nd[ND[el.id]] = el.value; return true;
  }

  // ---------- side panel ----------
  // A linked item opens in a panel beside the one you're working on (over it, on a
  // phone), so following links never loses your place. Links inside the panel open
  // there too, with Back; "Open" takes you to the item itself.
  var KINDNAME = { tests: "Test case", defects: "Defect", parties: "Test party", questions: "Question" };
  function peekRec(tab, id) { return tab === "questions" ? state.questions.filter(function (q) { return qid(q) === id; })[0] : find(state[tab] || [], id); }
  function openPeek(tab, id, push) {
    var top = { tab: tab, id: id };
    ui.peek = push && ui.peek ? ui.peek.concat([top]) : [top];
    ui.peekTop = true; render();
    var x = $("#peek-x"); if (x) x.focus();
  }
  function pf(label, text, self, plain) {
    if (text == null || text === "" || text === "–") return "";
    return '<div class="field"><span class="lab">' + esc(label) + '</span><div class="txt">' + (plain ? esc(text) : linked(text, self)) + "</div></div>";
  }
  function peekChips(label, tab, ids) {
    if (!ids.length) return "";
    return '<div class="field"><span class="lab">' + esc(label) + " · " + ids.length + '</span><div class="blk">' + ids.map(function (id) {
      var r = peekRec(tab, id);
      return '<span class="blk-chip"><a class="blk-go" href="' + esc(href(tab, id)) + '"><b class="mono">' + esc(id) + "</b> " + esc(r ? refLabel(tab, r) : "(no longer in the hub)") + "</a>" + (r ? refPill(tab, r) : "") + "</span>";
    }).join("") + "</div></div>";
  }
  function vPeek() {
    var top = ui.peek[ui.peek.length - 1], r = peekRec(top.tab, top.id), id = top.id;
    var h = '<aside class="peek" id="peek" aria-label="' + esc(KINDNAME[top.tab] + " " + id) + '"><div class="peek-head">' +
      (ui.peek.length > 1 ? '<button class="btn" data-act="peek-back" title="Back to ' + esc(ui.peek[ui.peek.length - 2].id) + '">← Back</button>' : "") +
      '<span class="peek-kind">' + esc(KINDNAME[top.tab]) + ' <b class="mono">' + esc(id) + "</b></span>" +
      (r ? '<button class="btn" data-act="peek-open" title="Go to ' + esc(id) + ' in its own tab">Open</button>' : "") +
      '<button class="btn" id="peek-x" data-act="peek-close" aria-label="Close the side panel" title="Close (Esc)">×</button></div>';
    if (!r) return h + '<p class="empty">' + esc(id) + " isn’t in the hub any more.</p></aside>";
    h += '<div class="peek-body"><h3>' + linked(refLabel(top.tab, r), id) + "</h3>";
    if (top.tab === "tests") {
      h += '<div class="pills">' + pill(r.status) + '</div><p class="count">' + esc(short(r.section)) + "</p>" +
        pf("Note ref", r.ref, id) + pf("Pre-conditions", r.pre, id) + pf("Steps", r.steps, id) + pf("Test data", r.data, id) + pf("Expected result", r.expected, id) +
        pf("Actual result", r.actual, id) + pf("Evidence", r.evidence, id) + pf("Comments", r.comments, id) +
        peekChips("Blocked by defects", "defects", r.blockedBy || []) + referencedByHtml(id, r.blockedBy);
    } else if (top.tab === "defects") {
      var bl = blockedTests(id).map(function (t) { return t.id; });
      h += '<div class="pills">' + dstatusPill(r) + sevPill(r.severity) + '</div><p class="count">' + esc([r.area, r.date].filter(Boolean).join(" · ")) + (r.shots && r.shots.length ? " · " + r.shots.length + " screenshot" + (r.shots.length === 1 ? "" : "s") : "") + "</p>" +
        (live(r) ? "" : pf("Deleted", delText(r.deleted), id, true)) +
        pf("Test ref", r.ref, id) + pf("Steps / evidence", r.steps, id) + pf("Raised with B4", r.raised, id, true) + pf("Fix version", r.fix, id, true) +
        pf("Retest date", r.retestDate, id, true) + pf("Retest result", r.retestResult, id) +
        peekChips("Blocking tests", "tests", bl) + referencedByHtml(id, bl);
    } else if (top.tab === "parties") {
      h += '<p class="count">' + esc(r.module + " · " + r.type) + "</p>" + pf("Purpose", r.purpose, id) + pf("Values to enter", r.values || "All control values.", id) +
        pf("Related parties to add", r.related, id) + pf("Once working", r.expectedFinal, id, true) +
        pf("Recorded final risk", r.recorded, id, true) + pf("Used by tests", r.tests, id) + referencedByHtml(id);
    } else {
      h += '<div class="pills">' + refPill("questions", r) + "</div>" + pf("Answer", r.a || "Not answered yet.", id) + pf("Tests affected", r.tests, id) + referencedByHtml(id);
    }
    return h + "</div></aside>";
  }

  // ---------- page ----------
  function vNotice() {
    var h = "";
    if (mode === "offline") h += '<div class="notice warn"><p><b>Offline copy.</b> Changes are kept in this browser. Use “Save offline copy” to write them into a new file, or “Export spreadsheet” and upload it to the online hub to bring it up to date.</p></div>';
    if (ui.saveErr) h += '<div class="notice err"><p>Changes aren’t reaching the hub (' + esc(ui.saveErr) + "). They are kept in this browser and will be saved when the connection is back.</p><button class=\"btn\" data-act=\"retry\">Try now</button></div>";
    if (ui.notice) h += '<div class="notice ' + esc(ui.notice.kind || "") + '"><p>' + esc(ui.notice.text) + "</p>" + (ui.notice.draft ? '<button class="btn" data-act="apply-draft">Re-apply them</button><button class="btn" data-act="drop-draft">Discard</button>' : "") + (ui.notice.undo ? '<button class="btn" data-act="undo-free">Undo</button>' : "") + '<button class="btn" data-act="dismiss">Dismiss</button></div>';
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
    if (ui.go != null) { var go = ui.go; ui.go = null; showItem(ui.tab, go); return; }
    buildRefs();
    var focusId = document.activeElement && document.activeElement.id, selStart = null;
    // A save or refresh redraws the page; keep text that's been typed but not yet saved.
    var keep = {}, ae = document.activeElement;
    if (ae && ae.id && /^(TEXTAREA|INPUT)$/.test(ae.tagName) && ae.type !== "checkbox" && ae.value !== ae.defaultValue) keep[ae.id] = ae.value;
    var pe = $("#peek"), peekScroll = pe && !ui.peekTop ? pe.scrollTop : 0;
    try { selStart = document.activeElement && document.activeElement.selectionStart; } catch (e) {}
    var openEl = root.querySelector("details.item[open]"); if (openEl) ui.open = openEl.getAttribute("data-id");
    var keepY = ui.drawnTab === ui.tab ? window.scrollY : null;
    var c = counts(state.tests), od = state.defects.filter(openDefect).length, pc = pendingCount();
    var chip = !hosted ? '<span class="mode off">Offline copy</span>' : ui.saveErr ? '<span class="mode off">Not saved yet · ' + pc + "</span>" : ui.refreshing ? '<span class="mode">Refreshing…</span>' : (flushing || pc) ? '<span class="mode">Saving…</span>' : '<span class="mode on">All changes saved</span>';
    var acts = hosted
      ? chip + '<button class="btn" data-act="reload" title="Load the latest from the hub">Refresh</button><label class="btn" for="imp">Upload spreadsheet</label><input type="file" id="imp" accept=".xlsx,.xls" hidden><button class="btn" data-act="export">Export spreadsheet</button><button class="btn" data-act="offline">Download offline copy</button><button class="btn" data-act="signout" title="' + esc(user && user.email) + '">Sign out</button>'
      : chip + '<label class="btn" for="imp">Upload spreadsheet</label><input type="file" id="imp" accept=".xlsx,.xls" hidden><button class="btn" data-act="export">Export spreadsheet</button><button class="btn primary" data-act="offline">Save offline copy' + (dirty ? " (" + dirty + ")" : "") + "</button>";
    var sub = esc(state.project) + (hosted ? (state.updated ? " · last change " + esc(fmt(state.updated)) : "") : " · copy " + esc(state.rev) + " · " + esc(fmt(state.updated)));
    var tabs = [["overview", "Overview", ""], ["tests", "Test cases", state.tests.length - c.Invalid - c["Not run"] - c.Retest + "/" + (state.tests.length - c.Invalid)], ["defects", "Defects", od + " open"], ["parties", "Test parties", state.parties.length], ["questions", "Questions", state.questions.filter(qOpen).length + " open"], ["documents", "Documents", state.docs.length]];
    root.innerHTML = '<header class="bar"><div class="bar-in"><div class="brand"><b>' + TITLE + "</b><span>" + sub + '</span></div><div class="actions">' + acts + '</div></div><nav class="tabs" role="tablist">' +
      tabs.map(function (t) { return '<button class="tab" role="tab" data-tab="' + t[0] + '" aria-selected="' + (ui.tab === t[0]) + '">' + t[1] + (t[2] !== "" ? '<span class="n">' + esc(t[2]) + "</span>" : "") + "</button>"; }).join("") + "</nav></header>" +
      '<main class="wrap">' + vNotice() + (ui.tab === "tests" ? vTests() : ui.tab === "defects" ? vDefects() : ui.tab === "parties" ? vParties() : ui.tab === "questions" ? vQuestions() : ui.tab === "documents" ? vDocuments() : vOverview()) + "</main>" +
      (ui.peek ? vPeek() : "");
    document.body.classList.toggle("peeking", !!ui.peek);
    // Same tab, same place: the redraw replaces the page, and the browser does not always keep
    // the scroll position when it does. A tab change scrolls to the top on purpose.
    if (keepY != null && window.scrollY !== keepY) window.scrollTo(0, keepY);
    ui.drawnTab = ui.tab;
    Object.keys(keep).forEach(function (id) { var el = document.getElementById(id); if (el && el.value === el.defaultValue) el.value = keep[id]; });
    if (ui.peek) { $("#peek").scrollTop = peekScroll; ui.peekTop = false; }
    if (focusId) { var f = document.getElementById(focusId); if (f) { f.focus(); try { if (selStart != null && f.setSelectionRange) f.setSelectionRange(selStart, selStart); } catch (e) {} } }
    loadThumbs();
  }

  function signOut() {
    if (pendingCount() && !confirm("Some changes haven’t reached the hub yet. Sign out anyway? They stay in this browser and are saved next time you sign in here.")) return;
    sb.auth.signOut().then(function () {}, function () {});
  }

  // ---------- events ----------
  document.addEventListener("mousedown", function (e) {
    if (e.target.closest && e.target.closest('[data-act="done-wording"]')) e.preventDefault();
  });
  document.addEventListener("click", function (e) {
    var ln = e.target.closest('a[href^="#"]');
    if (ln) {
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      // Links to an item open in the side panel, except on the overview, which is for going places.
      var to = readHash(ln.getAttribute("href")), inPeek = !!ln.closest("#peek");
      if (to && to.id && (inPeek || ui.tab !== "overview")) { e.preventDefault(); openPeek(to.tab, to.id, inPeek); return; }
      rememberPlace(); return;
    }
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
    else if (a === "def-del") { ui.delAsk = t.getAttribute("data-id"); render(); var w = document.getElementById("dr-why-" + ui.delAsk); if (w) w.focus(); }
    else if (a === "def-del-no") { ui.delAsk = null; render(); }
    else if (a === "def-del-yes") deleteDefect(t.getAttribute("data-id"));
    else if (a === "def-restore") restoreDefect(t.getAttribute("data-id"));
    else if (a === "unblock") unlinkBlock(t.getAttribute("data-id"), t.getAttribute("data-def"));
    else if (a === "set-blocked") setField("tests", t.getAttribute("data-id"), "status", "Blocked", "result");
    else if (a === "goto-defect") openPeek("defects", t.getAttribute("data-id"));
    else if (a === "goto-test") openPeek("tests", t.getAttribute("data-id"));
    else if (a === "peek-close") { ui.peek = null; render(); }
    else if (a === "peek-back") { ui.peek = ui.peek.slice(0, -1); ui.peekTop = true; render(); }
    else if (a === "peek-open") { var top = ui.peek[ui.peek.length - 1]; ui.peek = null; goTo(top.tab, top.id); }
    else if (a === "raise-defect") raiseFrom(t.getAttribute("data-id"));
    else if (a === "edit-wording") { ui.wording = t.getAttribute("data-id"); ui.open = ui.wording; render(); var f = document.getElementById("tw-objective-" + ui.wording); if (f) f.focus(); }
    else if (a === "done-wording") {
      // Done keeps the focus (see the mousedown below), so the box still being typed in is saved
      // here rather than by a blur that would redraw the page under the click.
      var fe = document.activeElement;
      ui.wording = null;
      if (fe && fe.dataset && fe.dataset.k) setField(fe.dataset.k, fe.dataset.id, fe.dataset.f, fe.value, fe.dataset.l);
      render();
    }
    else if (a === "nd-cancel") { ui.nd = null; ui.ndOpen = false; render(); }
    else if (a === "nd-open") { ui.ndOpen = true; render(); var na = $("#nd-area"); if (na) na.focus(); }
    else if (a === "undo-free") undoFree();
    else if (a === "shot-open") openShot(t.getAttribute("data-shot"));
    else if (a === "shot-del") { ui.shotDel = t.getAttribute("data-shot"); render(); }
    else if (a === "shot-del-no") { ui.shotDel = null; render(); }
    else if (a === "shot-del-yes") deleteShot(t.getAttribute("data-k") || "defects", t.getAttribute("data-id"), t.getAttribute("data-shot"));
    else if (a === "rec-start") startRecording(t.getAttribute("data-k"), t.getAttribute("data-id"));
    else if (a === "rec-stop") stopRecording();
  });
  // Following a link, or Back and Forward between them.
  window.addEventListener("hashchange", function () { var h = readHash(); if (h) { ui.tab = h.tab; ui.go = h.id; render(); } });
  // Opening a defect loads its thumbnails.
  document.addEventListener("toggle", function (e) {
    if (!e.target.matches || !e.target.matches("details.item")) return;
    // Remember what is open, and forget what was closed (11 Nov 2026): a redraw used to reopen
    // the item you had just closed, because closing never cleared it.
    var id = e.target.getAttribute("data-id");
    if (e.target.open) { ui.open = id; loadThumbs(); } else if (ui.open === id) ui.open = null;
  }, true);
  // Pasting an image while a defect or test is open adds it as a screenshot.
  document.addEventListener("paste", function (e) {
    if (ui.tab !== "defects" && ui.tab !== "tests") return;
    var openEl = document.querySelector("details.item[open]"), id = openEl && openEl.getAttribute("data-id"), d = id && find(state[ui.tab], id);
    if (!d || !canShoot(d)) return;
    var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(function (f) { return /^image\//.test(f.type); });
    if (!files.length) return;
    e.preventDefault(); addShots(ui.tab, id, files);
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (el.id === "imp" && el.files && el.files[0]) { importFile(el.files[0]); el.value = ""; return; }
    if (el.id === "doc-up" && el.files && el.files.length) { uploadDocs(el.files); el.value = ""; return; }
    if (el.dataset && el.dataset.shotUp && el.files && el.files.length) { addShots(el.dataset.shotK || "defects", el.dataset.shotUp, el.files); el.value = ""; return; }
    if (el.dataset && el.dataset.block) { linkBlock(el.dataset.block, el.value); return; }
    if (el.id === "f-area") { ui.area = el.value; render(); return; }
    if (el.id === "f-status") { ui.status = el.value; render(); return; }
    if (el.id === "f-dstatus") { ui.dstatus = el.value; render(); return; }
    if (el.id === "f-ptype") { ui.ptype = el.value; render(); return; }
    if (el.id === "f-prec") { ui.precorded = el.value; render(); return; }
    if (ndCapture(el)) return;
    if (el.dataset && el.dataset.k) setField(el.dataset.k, el.dataset.id, el.dataset.f, el.value, el.dataset.l);
  });
  document.addEventListener("input", function (e) {
    var el = e.target;
    if (ndCapture(el)) return;
    if (el.id === "f-q") { ui.q = el.value; render(); }
    else if (el.id === "f-dq") { ui.dq = el.value; render(); }
    else if (el.id === "f-pq") { ui.pq = el.value; render(); }
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
    var lk = $("#nd-link"), from = ui.nd && ui.nd.link && lk && lk.checked && find(state.tests, ui.nd.link);
    if (from && (from.blockedBy || []).indexOf(id) < 0) { from.blockedBy = (from.blockedBy || []).concat(id); addLog(from.id + ": blocked by " + id); addLog(id + ": blocking " + from.id); saveTest(from); }
    ui.nd = null; ui.ndOpen = false;
    // Open the new defect (render keeps whichever one is open in the page, so close that first).
    Array.prototype.forEach.call(document.querySelectorAll("details.item[open]"), function (el) { el.open = false; });
    ui.open = id;
    ui.notice = { kind: "", text: id + " added" + (from ? " and linked to " + from.id : "") + "." + (hosted ? " Paste or add screenshots in it below." : "") }; render();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && ui.peek) { ui.peek = null; render(); return; }
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
      state = { project: state.project, tests: [], parties: [], defects: [], questions: [], docs: [], log: [] }; ui.pq = ""; ui.ptype = ""; ui.precorded = ""; ui.peek = null; ui.nd = null;
      render();
    }
  });
})();
