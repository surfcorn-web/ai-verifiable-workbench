/* store.js — 資料存取層 + 工作台資料函式
 * 全域物件：Store
 * - 資料存 localStorage，key = aiwb_state_v01；讀不到或格式不符時用 SEED。
 * - transact(fn)：動作「當下」重新讀取最新狀態再執行（RULE-004 核准時重新讀取庫存）。
 *   瀏覽器單執行緒，同一分頁內 transact 是不可分割的；跨分頁靠「執行當下再讀一次」降低時間差。
 * - memory(initial)：記憶體版 Store，給 tests.js 用，不碰 localStorage。
 * - Store.wb.*：工作台資料函式，第一個參數為 db，回傳 { ok, message, state }。
 */
var Store = (function () {
  'use strict';

  var KEY = 'aiwb_state_v01';
  var fallback = null; // localStorage 不可用時的記憶體備援

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function now() { return new Date().toISOString(); }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }

  function valid(s) {
    return !!(s && s.meta && s.meta.schema === KEY && s.products && s.orders && s.wb);
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (valid(s)) return s;
      }
    } catch (e) { /* file:// 或隱私模式可能擋 localStorage，改用記憶體 */ }
    return fallback ? clone(fallback) : clone(SEED);
  }

  function save(state) {
    fallback = clone(state);
    try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch (e) { return false; }
  }

  function reset() { var s = clone(SEED); save(s); return s; }

  function persistent() {
    try { var k = KEY + '_probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; }
  }

  function transact(fn) {
    var current = load();
    var res = fn(current);
    if (res && res.state) save(res.state);
    return res;
  }

  function memory(initial) {
    var data = clone(initial);
    return {
      load: function () { return clone(data); },
      save: function (s) { data = clone(s); return true; },
      transact: function (fn) {
        var res = fn(clone(data));
        if (res && res.state) data = clone(res.state);
        return res;
      }
    };
  }

  // =====================================================================
  // 工作台資料函式（畫面一律透過這些函式改資料）
  // =====================================================================
  function result(ok, message, state, data) { return { ok: ok, message: message, state: state, data: data }; }
  function wbLog(s, action, detail) {
    s.wb.log.push({ at: now(), action: action, detail: detail || '' });
    if (s.wb.log.length > 300) s.wb.log = s.wb.log.slice(-300);
  }
  function findReq(s, id) { return s.wb.requirements.filter(function (r) { return r.id === id; })[0]; }
  function findRule(s, id) { return s.wb.rules.filter(function (r) { return r.id === id; })[0]; }

  var wb = {};

  wb.updateProject = function (db, fields) {
    var s = clone(db);
    ['name', 'need', 'owner'].forEach(function (k) {
      if (fields && typeof fields[k] === 'string') s.wb.project[k] = fields[k].trim();
    });
    if (!s.wb.project.name) return result(false, '專案名稱不可空白', db);
    wbLog(s, 'PROJECT', s.wb.project.name);
    return result(true, '專案已儲存', s);
  };

  wb.addSource = function (db, src) {
    if (!src || !src.name) return result(false, '沒有檔名', db);
    var s = clone(db);
    var id = 'SRC-' + pad(s.seq.source++, 2);
    s.wb.sources.push({
      id: id, name: String(src.name), kind: src.kind || '檔案', size: Number(src.size) || 0,
      note: src.note || '', added_at: now()
    });
    wbLog(s, 'SOURCE_ADD', id + ' ' + src.name);
    return result(true, '已登記來源 ' + id + '：' + src.name, s);
  };

  wb.removeSource = function (db, id) {
    var s = clone(db);
    var before = s.wb.sources.length;
    s.wb.sources = s.wb.sources.filter(function (x) { return x.id !== id; });
    if (s.wb.sources.length === before) return result(false, '找不到來源 ' + id, db);
    wbLog(s, 'SOURCE_REMOVE', id);
    return result(true, '已移除來源 ' + id, s);
  };

  // ---------- B 需求訪談 ----------
  wb.interviewSend = function (db, text) {
    text = String(text || '').trim();
    if (!text) return result(false, '請先輸入回答', db);
    var s = clone(db);
    var it = s.wb.interview;
    var r = Rules.interviewRespond(s.wb, text);
    it.messages.push({ who: 'user', text: text, at: now(), reqs: [] });
    r.adds.forEach(function (a) {
      var cat = Rules.REQ_CATALOG[a.id];
      if (!cat || findReq(s, a.id)) return;
      s.wb.requirements.push({
        id: a.id, text: cat.text, priority: cat.priority, quality: cat.quality.slice(),
        group: cat.group || '', status: a.status, source: a.source, evidence: a.evidence,
        note: a.note || '', edited: false,
        history: [{ at: now(), by: 'AI', to: a.status, note: '訪談產生草稿' }]
      });
    });
    r.questions.forEach(function (q) {
      if (!it.questions.some(function (x) { return x.text === q; })) it.questions.push({ text: q, resolved: false });
    });
    it.messages.push({ who: 'ai', text: r.ai, at: now(), reqs: r.adds.map(function (a) { return a.id; }) });
    if (it.step === 0 && !s.wb.project.need) s.wb.project.need = text;
    it.step = r.nextStep;
    wbLog(s, 'INTERVIEW', '新增需求草稿 ' + r.adds.length + ' 條');
    return result(true, r.adds.length ? 'AI 整理出 ' + r.adds.length + ' 條需求草稿' : '已記錄回答', s);
  };

  wb.restartInterview = function (db) {
    var s = clone(db);
    s.wb.interview = clone(SEED.wb.interview);
    s.wb.requirements = [];
    s.wb.rules = [];
    s.wb.devpack = null;
    wbLog(s, 'INTERVIEW_RESTART', '清除訪談、需求、規則');
    return result(true, '已清除訪談紀錄、需求與規則，可重新訪談', s);
  };

  wb.resolveQuestion = function (db, index) {
    var s = clone(db);
    var q = s.wb.interview.questions[index];
    if (!q) return result(false, '找不到這個待釐清問題', db);
    q.resolved = true;
    wbLog(s, 'QUESTION_RESOLVED', q.text);
    return result(true, '已標為已釐清', s);
  };

  // ---------- B 需求確認（只有人可以把需求改成「已確認」） ----------
  var ACTIONS = {
    confirm: { from: ['pending'], to: 'confirmed', word: '已確認' },
    adopt: { from: ['ai'], to: 'confirmed', word: '已採納' },
    defer: { from: ['pending', 'ai'], to: 'deferred', word: '已延後' },
    reject: { from: ['pending', 'ai'], to: 'rejected', word: '已拒絕' },
    revert: { from: ['confirmed', 'deferred', 'rejected'], to: 'pending', word: '已撤回為待確認' }
  };

  wb.setReqStatus = function (db, id, action) {
    var act = ACTIONS[action];
    if (!act) return result(false, '不支援的操作：' + action, db);
    var s = clone(db);
    var r = findReq(s, id);
    if (!r) return result(false, '找不到需求 ' + id, db);
    if (act.from.indexOf(r.status) < 0) return result(false, id + ' 目前是「' + Rules.REQ_STATUS[r.status] + '」，不能' + act.word.replace('已', ''), db);

    var extra = '';
    if (act.to === 'confirmed' && r.group) {
      var others = s.wb.requirements.filter(function (x) { return x.group === r.group && x.id !== r.id; });
      var clash = others.filter(function (x) { return x.status === 'confirmed'; })[0];
      if (clash) return result(false, id + ' 與 ' + clash.id + ' 是互斥決策，兩者不可同時確認；請先撤回 ' + clash.id, db);
      others.forEach(function (x) {
        if (x.status === 'pending' || x.status === 'ai') {
          x.history.push({ at: now(), by: 'HUMAN', to: 'rejected', note: '互斥：已採用 ' + id });
          x.status = 'rejected';
          x.note = '互斥決策，已採用 ' + id;
          extra = '；' + x.id + ' 自動標為已拒絕（互斥）';
        }
      });
    }
    r.history.push({ at: now(), by: 'HUMAN', to: act.to, note: action });
    r.status = act.to;
    wbLog(s, 'REQ_' + action.toUpperCase(), id);
    return result(true, id + ' ' + act.word + extra, s);
  };

  // 直接指定目標狀態；需要時自動先撤回再改（全部成功才儲存，中途失敗則資料完全不變）
  wb.moveReq = function (db, id, to) {
    var r = findReq(db, id);
    if (!r) return result(false, '找不到需求 ' + id, db);
    if (r.status === to) return result(false, id + ' 已經是「' + Rules.REQ_STATUS[to] + '」', db);
    var path = Rules.REQ_MOVES[r.status] && Rules.REQ_MOVES[r.status][to];
    if (!path) return result(false, id + ' 目前是「' + Rules.REQ_STATUS[r.status] + '」，不能直接改成「' + Rules.REQ_STATUS[to] + '」', db);
    var s = db, res = null;
    for (var i = 0; i < path.length; i++) {
      res = wb.setReqStatus(s, id, path[i]);
      if (!res.ok) return result(false, res.message, db);
      s = res.state;
    }
    return result(true, res.message, s);
  };

  wb.editReq = function (db, id, text) {
    text = String(text || '').trim();
    if (!text) return result(false, '需求內容不可空白', db);
    var s = clone(db);
    var r = findReq(s, id);
    if (!r) return result(false, '找不到需求 ' + id, db);
    if (r.status === 'confirmed') return result(false, '已確認的需求要先撤回才能修改', db);
    r.history.push({ at: now(), by: 'HUMAN', to: r.status, note: '修改：' + r.text + ' → ' + text });
    r.text = text;
    r.edited = true;
    wbLog(s, 'REQ_EDIT', id);
    return result(true, id + ' 已修改', s);
  };

  // ---------- C IF 閉環規則 ----------
  wb.buildRules = function (db) {
    var blockers = Rules.buildBlockers(db.wb);
    if (blockers.length) return result(false, '還有需求未決定：' + blockers.join('、'), db);
    var s = clone(db);
    var created = [];
    Rules.RULE_TEMPLATES.forEach(function (tpl) {
      var req = findReq(s, tpl.primary);
      var on = !!req && req.status === 'confirmed';
      var existing = findRule(s, tpl.id);
      if (existing) { existing.orphan = !on; return; }
      if (!on) return;
      var rule = clone(tpl);
      rule.version = 'v0.1.0';
      rule.orphan = false;
      rule.created_at = now();
      rule.edited_at = null;
      s.wb.rules.push(rule);
      created.push(rule.id);
    });
    s.wb.rules.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    if (!s.wb.rules.length) return result(false, '沒有可建立規則的已確認需求', db);
    wbLog(s, 'RULES_BUILD', created.join(',') || '無新增');
    return result(true, created.length ? '已建立 ' + created.length + ' 條 IF 規則：' + created.join('、') : '規則已是最新（共 ' + s.wb.rules.length + ' 條）', s);
  };

  var RULE_FIELDS = ['title', 'if', 't.action', 't.effect', 't.message', 't.audit', 't.tests', 't.final',
    'f.action', 'f.effect', 'f.message', 'f.audit', 'f.tests', 'f.final', 'edge.text', 'edge.tests'];

  wb.updateRule = function (db, ruleId, field, value) {
    if (RULE_FIELDS.indexOf(field) < 0) return result(false, '不可編輯的欄位：' + field, db);
    var s = clone(db);
    var rule = findRule(s, ruleId);
    if (!rule) return result(false, '找不到規則 ' + ruleId, db);
    var parts = field.split('.');
    var v = /tests$/.test(field) ? Rules.parseTestIds(value) : String(value == null ? '' : value).trim();
    if (parts.length === 1) rule[parts[0]] = v;
    else { rule[parts[0]] = rule[parts[0]] || {}; rule[parts[0]][parts[1]] = v; }
    rule.edited_at = now();
    var ck = Rules.check(rule);
    wbLog(s, 'RULE_EDIT', ruleId + ' ' + field);
    return result(true, ruleId + ' 已更新（閉環 ' + ck.score + '／8）', s);
  };

  // ---------- C 開發包 ----------
  wb.genDevpack = function (db) {
    var pack = Rules.devpack(db);
    if (!pack.ready.length) return result(false, '沒有閉環 8／8 的規則，不能產生開發包', db);
    var s = clone(db);
    s.wb.devpack = { at: now(), ready: pack.ready, blocked: pack.blocked, version: Rules.nextVersion(s.wb.versions) };
    wbLog(s, 'DEVPACK', pack.ready.join(','));
    return result(true, '開發包已產生：' + pack.ready.length + ' 條規則進入開發，' + pack.blocked.length + ' 條被閘門擋下', s);
  };

  // ---------- D 驗收、追蹤、版本 ----------
  wb.recordTestRun = function (db, results) {
    var s = clone(db);
    var pass = results.filter(function (r) { return r.pass; }).length;
    s.wb.testRuns.push({
      at: now(), pass: pass, total: results.length,
      results: results.map(function (r) { return { id: r.id, pass: r.pass, actual: r.actual, ms: r.ms }; })
    });
    if (s.wb.testRuns.length > 30) s.wb.testRuns = s.wb.testRuns.slice(-30);
    wbLog(s, 'TEST_RUN', pass + '/' + results.length);
    return result(pass === results.length, '驗收測試 ' + pass + '／' + results.length + ' PASS', s);
  };

  wb.setCheck = function (db, key, value) {
    var s = clone(db);
    s.wb.checklist[key] = !!value;
    wbLog(s, 'CHECK', key + '=' + !!value);
    return result(true, value ? '已勾選' : '已取消勾選', s);
  };

  wb.saveVersion = function (db, note) {
    var s = clone(db);
    var label = Rules.nextVersion(s.wb.versions);
    var run = s.wb.testRuns[s.wb.testRuns.length - 1] || null;
    var checks = Rules.checklist(s);
    s.wb.versions.push({
      id: label, at: now(), note: String(note || '').trim(),
      reqs: s.wb.requirements.map(function (r) { return { id: r.id, status: r.status, text: r.text }; }),
      rules: s.wb.rules.map(function (r) { var c = Rules.check(r); return { id: r.id, title: r.title, score: c.score, complete: c.complete }; }),
      tests: run ? { at: run.at, pass: run.pass, total: run.total, failed: run.results.filter(function (x) { return !x.pass; }).map(function (x) { return x.id; }) } : null,
      checklist: checks.map(function (c) { return { key: c.key, ok: c.ok }; })
    });
    s.meta.version = label;
    wbLog(s, 'VERSION', label);
    return result(true, '已建立版本 ' + label, s);
  };

  return {
    KEY: KEY,
    clone: clone,
    load: load,
    save: save,
    reset: reset,
    persistent: persistent,
    transact: transact,
    memory: memory,
    wb: wb
  };
})();
