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

  // ---------- 舊資料升級 ----------
  // data_version 1：核准才預留；2：送出即預留（待審核與已核准的訂單都佔用庫存）；3：加入參考 ERP 案例的候選需求；4：寄庫採購買當下就扣庫存；5：Sprint 1 進出貨與商品管理；6：Sprint 3 安全庫存警示與規則變更
  var DATA_VERSION = 6;

  function prodOf(s, sku) { return s.products.filter(function (p) { return p.sku === sku; })[0]; }

  function fromTemplate(tpl, old) {
    var rule = clone(tpl);
    rule.version = old ? old.version : 'v0.1.0';
    rule.orphan = old ? old.orphan : false;
    rule.created_at = old ? old.created_at : now();
    rule.edited_at = old ? old.edited_at : null;
    return rule;
  }

  // 預留量一律由訂單重新計算；來不及預留的待審核單自動退回；沒被人改過的規則與需求文字用新版更新
  function migrate(s) {
    var v = (s.meta && s.meta.data_version) || 1;
    if (v >= DATA_VERSION) return s;
    if (v < 2) migrateToV2(s);
    if (v < 3) migrateToV3(s);
    if (v < 4) migrateToV4(s);
    if (v < 5) migrateToV5(s);
    if (v < 6) migrateToV6(s);
    s.meta.data_version = DATA_VERSION;
    return s;
  }

  // 沒被人改過的需求文字、規則內容，用程式內最新版更新（人改過的不動）
  function refreshUnedited(s) {
    s.wb.requirements.forEach(function (r) {
      var c = Rules.REQ_CATALOG[r.id];
      if (!c || r.edited) return;
      r.text = c.text; r.priority = c.priority; r.quality = c.quality.slice();
      if (!r.note && c.decision) r.note = c.decision;
    });
    s.wb.rules = s.wb.rules.map(function (r) {
      var t = r.edited_at ? null : Rules.RULE_TEMPLATES.filter(function (x) { return x.id === r.id; })[0];
      return t ? fromTemplate(t, r) : r;
    });
  }

  // v4：寄庫決定採用「購買當下就扣庫存」。更新需求與規則，並拿掉已經決定的舊疑問
  function migrateToV4(s) {
    refreshUnedited(s);
    s.wb.interview.questions = s.wb.interview.questions.filter(function (q) { return q.text.indexOf('寄庫的輪胎，購買當下') < 0; });
  }

  // v5：Sprint 1 進出貨與商品管理。補進貨單清單與編號、更新規則，問答已完成的專案補上兩條 AI 建議，拿掉已有定義的「出貨」疑問
  function migrateToV5(s) {
    s.receipts = s.receipts || [];
    s.seq.receipt = s.seq.receipt || (s.receipts.length + 1);
    s.seq.product = s.seq.product || (s.products.reduce(function (m, p) { var x = /^TR-(\d+)$/.exec(p.sku); return x ? Math.max(m, Number(x[1])) : m; }, 0) + 1);
    refreshUnedited(s);
    s.wb.interview.questions = s.wb.interview.questions.filter(function (q) { return q.text.indexOf('還要不要有「出貨」這一步') < 0; });
    if (s.wb.interview.step < Rules.DONE_STEP) return;
    ['REQ-024', 'REQ-025'].forEach(function (id) {
      if (s.wb.requirements.some(function (r) { return r.id === id; })) return;
      var c = Rules.REQ_CATALOG[id];
      s.wb.requirements.push({
        id: id, text: c.text, priority: c.priority, quality: c.quality.slice(), group: '',
        status: 'ai', source: 'AI 流程走查（升級補充）', evidence: 'AI 依 ERP 難點檢核清單推論（沒有使用者原話）', note: '', edited: false,
        history: [{ at: now(), by: 'AI', to: 'ai', note: '資料升級時補充（Sprint 1）' }]
      });
    });
  }

  // v6：Sprint 3 安全庫存警示與規則變更。補安全庫存欄位、低庫存規則設定、變更紀錄；問答已完成的專案補上 REQ-026（AI 建議）
  function migrateToV6(s) {
    s.products.forEach(function (p) {
      if (p.safety != null) return;
      var seed = SEED.products.filter(function (x) { return x.sku === p.sku; })[0];
      p.safety = seed ? seed.safety : 0;
    });
    s.settings = s.settings || { low_stock_op: 'lt' };
    s.wb.changes = s.wb.changes || [];
    refreshUnedited(s);
    if (s.wb.interview.step < Rules.DONE_STEP) return;
    if (s.wb.requirements.some(function (r) { return r.id === 'REQ-026'; })) return;
    var c = Rules.REQ_CATALOG['REQ-026'];
    s.wb.requirements.push({
      id: 'REQ-026', text: c.text, priority: c.priority, quality: c.quality.slice(), group: '',
      status: 'ai', source: 'AI 流程走查（升級補充）', evidence: 'AI 依 ERP 難點檢核清單推論（沒有使用者原話）', note: '', edited: false,
      history: [{ at: now(), by: 'AI', to: 'ai', note: '資料升級時補充（Sprint 3）' }]
    });
  }

  // v3：問答已完成的專案，補上「參考 ERP 案例」的候選需求（AI 建議，不影響已做的決定）
  function migrateToV3(s) {
    if (s.wb.interview.step < Rules.DONE_STEP) return;
    Rules.REF_CANDIDATES.forEach(function (id) {
      if (s.wb.requirements.some(function (r) { return r.id === id; })) return;
      var c = Rules.REQ_CATALOG[id];
      s.wb.requirements.push({
        id: id, text: c.text, priority: c.priority, quality: c.quality.slice(), group: '',
        status: 'ai', source: Rules.REF_SOURCE, evidence: Rules.REF_EVIDENCE[id], note: '', edited: false,
        history: [{ at: now(), by: 'AI', to: 'ai', note: '資料升級時補充（參考 ERP 案例）' }]
      });
    });
  }

  function migrateToV2(s) {
    var sum = {};
    s.orders.forEach(function (o) {
      if (o.status !== 'APPROVED') return;
      o.lines.forEach(function (l) { sum[l.sku] = (sum[l.sku] || 0) + l.qty; });
    });
    s.products.forEach(function (p) { p.reserved = sum[p.sku] || 0; });
    s.orders.filter(function (o) { return o.status === 'SUBMITTED'; })
      .sort(function (a, b) { return a.id < b.id ? -1 : 1; })
      .forEach(function (o) {
        var need = {};
        o.lines.forEach(function (l) { need[l.sku] = (need[l.sku] || 0) + l.qty; });
        var skus = Object.keys(need);
        var enough = skus.every(function (k) { var p = prodOf(s, k); return !!p && p.on_hand - p.reserved >= need[k]; });
        var msg;
        if (enough) {
          skus.forEach(function (k) { prodOf(s, k).reserved += need[k]; });
          msg = o.id + ' 資料升級：待審核訂單補上預留';
        } else {
          o.history.push({ at: now(), by: 'SYSTEM', from: 'SUBMITTED', to: 'RETURNED', note: '資料升級：可用庫存不足，已退回' });
          o.status = 'RETURNED';
          o.return_reason = '系統升級為「送出即預留」，當時可用庫存不足，請修改後重新送出';
          msg = o.id + ' 資料升級：可用庫存不足，已退回請重送';
        }
        s.audit.push({
          id: 'AU-' + pad(s.seq.audit++, 4), at: now(), actor: 'SYSTEM', actor_name: '系統', role: '-',
          action: 'MIGRATED', rule: 'RULE-003', target: o.id, ok: enough, message: msg, detail: {}
        });
      });
    s.wb.rules = s.wb.rules.map(function (r) {
      var t = r.edited_at ? null : Rules.RULE_TEMPLATES.filter(function (x) { return x.id === r.id; })[0];
      return t ? fromTemplate(t, r) : r;
    });
    s.wb.requirements.forEach(function (r) {
      var c = Rules.REQ_CATALOG[r.id];
      if (!c || r.edited) return;
      r.text = c.text; r.priority = c.priority; r.quality = c.quality.slice();
    });
    if (s.wb.interview.step >= Rules.DONE_STEP && !s.wb.requirements.some(function (r) { return r.id === 'REQ-010'; })) {
      var c10 = Rules.REQ_CATALOG['REQ-010'];
      s.wb.requirements.push({
        id: 'REQ-010', text: c10.text, priority: c10.priority, quality: c10.quality.slice(), group: '',
        status: 'ai', source: 'AI 流程走查（升級補充）', evidence: 'AI 依「單據狀態」難點推論（沒有使用者原話）',
        note: '送出即預留後，老闆要能核准或拒絕待審核單；拒絕要釋放預留', edited: false,
        history: [{ at: now(), by: 'AI', to: 'ai', note: '資料升級時補充' }]
      });
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (valid(s)) return migrate(s);
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
        note: a.note || cat.decision || '', edited: false,
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
    var titles = [];
    Rules.RULE_TEMPLATES.forEach(function (tpl) {
      var req = findReq(s, tpl.primary);
      var on = !!req && req.status === 'confirmed';
      var existing = findRule(s, tpl.id);
      if (existing) {
        existing.orphan = !on;
        // 沒被人改過的規則，用最新範本更新內容
        if (!existing.edited_at) {
          var i = s.wb.rules.indexOf(existing);
          s.wb.rules[i] = fromTemplate(tpl, existing);
          s.wb.rules[i].orphan = !on;
        }
        return;
      }
      if (!on) return;
      s.wb.rules.push(fromTemplate(tpl, null));
      created.push(tpl.id);
      titles.push(tpl.title);
    });
    s.wb.rules.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    if (!s.wb.rules.length) return result(false, '沒有可建立規則的已確認需求', db);
    wbLog(s, 'RULES_BUILD', created.join(',') || '無新增');
    return result(true, created.length ? '已建立 ' + created.length + ' 條規則：' + titles.join('、') : '規則已是最新（共 ' + s.wb.rules.length + ' 條）', s);
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
    return result(true, '已儲存（8 項檢查已完成 ' + ck.score + ' 項）', s);
  };

  // ---------- C 開發包 ----------
  wb.genDevpack = function (db) {
    var pack = Rules.devpack(db);
    if (!pack.ready.length) return result(false, '沒有閉環 8／8 的規則，不能產生開發包', db);
    var s = clone(db);
    s.wb.devpack = { at: now(), ready: pack.ready, blocked: pack.blocked, version: Rules.nextVersion(s.wb.versions) };
    wbLog(s, 'DEVPACK', pack.ready.join(','));
    return result(true, '開發包已產生：' + pack.ready.length + ' 條規則可以開發，' + pack.blocked.length + ' 條先不做（還沒寫完整）', s);
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
    return result(pass === results.length, '驗收測試 ' + pass + '／' + results.length + ' 項通過', s);
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

  // ---------- 變更需求：先看影響範圍 → 確認 → 套用 → 重跑全部測試 → 綁定新版本（可回復）----------
  function findChange(s, id) { return s.wb.changes.filter(function (c) { return c.id === id; })[0]; }
  function bossOf(s) { return s.users.filter(Rules.isBoss)[0]; }
  function opLabel(op) { return Rules.LOW_OPS[op] ? Rules.LOW_OPS[op].short : String(op); }

  wb.applyChange = function (db, spec) {
    spec = spec || {};
    var reason = String(spec.reason || '').trim();
    if (!reason) return result(false, '請先寫下為什麼要改（理由會留在變更紀錄裡）', db);
    var s = clone(db);
    var req = findReq(s, spec.req_id);
    if (!req) return result(false, '找不到需求 ' + spec.req_id + '，請先完成「AI 問答」', db);
    if (req.status !== 'confirmed') return result(false, req.id + ' 還沒有確認。請先到「確認需求」決定，再來變更', db);
    var ch = {
      id: 'CHG-' + pad(s.wb.changes.length + 1, 3), at: now(), kind: spec.kind, req_id: req.id, reason: reason, by: '需求負責人',
      status: 'applied', impact: Rules.impactOf(s, req.id), from: '', to: '', title: '', regression: null, version: '', reverted_at: null
    };
    if (spec.kind === 'low-op') {
      var op = spec.to;
      var boss = bossOf(s);
      var r = ERP.setLowStockRule(s, boss.id, op, reason);
      if (!r.ok) return result(false, r.message, r.state);
      s = r.state;
      ch.from = r.data.before; ch.to = r.data.after;
      ch.title = '低庫存警示的比較方式：' + opLabel(ch.from) + ' → ' + opLabel(ch.to);
    } else if (spec.kind === 'req-text') {
      var text = String(spec.to || '').trim();
      if (!text) return result(false, '新的說法不可空白', db);
      if (text === req.text) return result(false, '新的說法和原本一樣，不需要變更', db);
      ch.from = req.text; ch.to = text;
      ch.title = '修改需求文字（' + req.id + '）';
      req.history.push({ at: now(), by: 'HUMAN', to: req.status, note: '變更 ' + ch.id + '：' + req.text + ' → ' + text + '（理由：' + reason + '）' });
      req.text = text;
      req.edited = true;
    } else {
      return result(false, '不認得的變更類型', db);
    }
    s.wb.changes.push(ch);
    wbLog(s, 'CHANGE', ch.id + ' ' + ch.title);
    return result(true, ch.id + ' 已套用，接下來自動重跑全部驗收測試', s, { id: ch.id });
  };

  // 變更（或回復）之後：記錄測試結果；全部通過才綁定新版本，沒全過就停下來等人決定（可以回復）
  wb.finishChange = function (db, id, results, mode) {
    var s = clone(db);
    var ch = findChange(s, id);
    if (!ch) return result(false, '找不到變更 ' + id, db);
    var reverting = mode === 'revert';
    var failed = results.filter(function (r) { return !r.pass; }).map(function (r) { return r.id; });
    var reg = { at: now(), pass: results.length - failed.length, total: results.length, failed: failed };
    s = wb.recordTestRun(s, results).state;
    ch = findChange(s, id);
    if (reverting) ch.revert_regression = reg; else ch.regression = reg;
    if (!failed.length) {
      var label = reverting ? '回復 ' + ch.id + '：' + ch.title : '變更 ' + ch.id + '：' + ch.title + '（理由：' + ch.reason + '）';
      s = wb.saveVersion(s, label).state;
      ch = findChange(s, id);
      if (reverting) ch.revert_version = s.meta.version; else { ch.version = s.meta.version; ch.status = 'verified'; }
    } else if (!reverting) {
      ch.status = 'failed';
    }
    wbLog(s, reverting ? 'CHANGE_REVERT_TEST' : 'CHANGE_TEST', ch.id + ' ' + reg.pass + '/' + reg.total);
    var msg = failed.length
      ? ch.id + '：有 ' + failed.length + ' 項驗收沒通過，沒有存成新版本。可以回復這次變更'
      : ch.id + (reverting ? ' 已回復，' : ' 已套用，') + '全部 ' + reg.total + ' 項驗收通過，已存成 ' + s.meta.version;
    return result(!failed.length, msg, s);
  };

  // 回復：只能回復「同一個對象最新的一次有效變更」，否則會蓋掉比較新的修改
  wb.revertChange = function (db, id, reason) {
    var why = String(reason || '').trim();
    if (!why) return result(false, '請寫下為什麼要回復（理由會留在變更紀錄裡）', db);
    var s = clone(db);
    var ch = findChange(s, id);
    if (!ch) return result(false, '找不到變更 ' + id, db);
    if (ch.status === 'reverted') return result(false, ch.id + ' 已經回復過了', db);
    var newer = s.wb.changes.filter(function (c) { return c.kind === ch.kind && c.req_id === ch.req_id && c.status !== 'reverted' && c.id > ch.id; });
    if (newer.length) return result(false, '要先回復比較新的變更 ' + newer[newer.length - 1].id, db);
    if (ch.kind === 'low-op') {
      var r = ERP.setLowStockRule(s, bossOf(s).id, ch.from, '回復 ' + ch.id + '：' + why);
      if (!r.ok) return result(false, r.message, r.state);
      s = r.state;
    } else if (ch.kind === 'req-text') {
      var req = findReq(s, ch.req_id);
      req.history.push({ at: now(), by: 'HUMAN', to: req.status, note: '回復 ' + ch.id + '：' + req.text + ' → ' + ch.from + '（理由：' + why + '）' });
      req.text = ch.from;
    }
    ch = findChange(s, id);
    ch.status = 'reverted';
    ch.reverted_at = now();
    ch.revert_reason = why;
    wbLog(s, 'CHANGE_REVERT', ch.id);
    return result(true, ch.id + ' 已回復，接下來自動重跑全部驗收測試', s, { id: ch.id });
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
