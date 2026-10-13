/* app.js — 畫面層
 * 全域物件：App
 * 只負責顯示與收集輸入；改資料一律呼叫 ERP.* 或 Store.wb.*（經 Store.transact 執行當下重新讀取最新狀態）。
 */
var App = (function () {
  'use strict';

  var db = null;
  var ui = {
    route: 'a',
    erpUser: 'U01',
    erpQuery: '',
    ruleSel: '',
    devTab: 'SPEC.md',
    focus: '',
    demoOpen: false,
    demoStep: 0,
    timer: { left: 480, running: false, handle: null }
  };

  var ROUTES = [
    { id: 'a', nav: 'A 專案與來源', title: '專案與來源' },
    { id: 'interview', nav: 'B 需求訪談', title: '需求訪談' },
    { id: 'confirm', nav: 'B 需求確認', title: '需求確認' },
    { id: 'rules', nav: 'C IF 閉環規則', title: 'IF 閉環規則' },
    { id: 'devpack', nav: 'C 開發包', title: '開發包' },
    { id: 'verify', nav: 'D 驗收與追蹤', title: '驗收與追蹤' },
    { id: 'versions', nav: 'D 版本', title: '版本' },
    { id: 'erp', nav: 'ERP 預覽', title: 'ERP 預覽' }
  ];

  var DEMO = [
    { t: '0:00', to: 'a', title: 'A　建立專案、輸入一句話需求', say: '按「填入範例需求」→「開始 AI 訪談」。' },
    { t: '0:45', to: 'interview', title: 'B　AI 追問', say: '依序點建議回答；第 2 輪 AI 問出「送出就預留，還是核准才預留？」' },
    { t: '2:15', to: 'confirm', title: 'B　人工確認', say: '確認 Must 需求；確認 REQ-004 時 REQ-004B 自動互斥。AI 推論需由人採納／延後／拒絕。' },
    { t: '3:00', to: 'rules', title: 'C　IF 閉環規則', say: 'RULE-004 閉環 8／8；RULE-008 缺 False 分支與測試 → 閘門擋下。' },
    { t: '4:00', to: 'devpack', title: 'C　開發包', say: '產生 SPEC／TASKS／TESTS 與給 Coding Agent 的指令。' },
    { t: '4:45', to: 'erp', title: 'ERP 預覽', say: '阿明查庫存（看不到成本）→ 205/55R16 × 2 送出 → 王老闆核准，可用 124 → 122；再送 225/45R17 × 2 → 核准被拒，資料不變。' },
    { t: '6:30', to: 'verify', title: 'D　驗收與追蹤', say: '執行 9 個驗收測試全部 PASS；看「需求 → 規則 → 程式 → 測試 → 版本」。' },
    { t: '7:15', to: 'versions', title: 'D　版本', say: '勾選人工檢查項目，建立 v0.1.0 版本快照。' }
  ];

  var FLOW = ['查詢庫存', '加入叫貨', '送出', '老闆核准', '建立預留', '更新可用庫存'];

  // =====================================================================
  // 小工具
  // =====================================================================
  function $(sel) { return document.querySelector(sel); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>'); }
  function last(a) { return a && a.length ? a[a.length - 1] : null; }
  function two(n) { return n < 10 ? '0' + n : String(n); }
  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return two(d.getMonth() + 1) + '/' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
  }
  function fmtNum(n) { return typeof n === 'number' ? n.toLocaleString('zh-TW') : esc(n); }
  function fmtSize(b) {
    if (!b) return '—';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function userName(id) {
    var u = ERP.view.user(db, id);
    return u ? u.name + '（' + Rules.ROLE[u.role] + '）' : id;
  }
  function orderPill(s) { return '<span class="pill st-' + esc(s) + '">' + esc(Rules.ORDER_STATUS[s] || s) + '</span>'; }
  function reqPill(s) { return '<span class="pill st-' + esc(s) + '">' + esc(Rules.REQ_STATUS[s] || s) + '</span>'; }
  function reqById(id) { return db.wb.requirements.filter(function (r) { return r.id === id; })[0] || null; }
  function sortedReqs() {
    return db.wb.requirements.slice().sort(function (a, b) { return Rules.REQ_ORDER.indexOf(a.id) - Rules.REQ_ORDER.indexOf(b.id); });
  }

  // =====================================================================
  // 動作：一律經 Store.transact（執行當下重新讀取最新資料）
  // =====================================================================
  function act(fn, opts) {
    var res = Store.transact(fn);
    db = Store.load();
    if (res && res.message && !(opts && opts.silent)) toast(res.message, res.ok);
    render();
    return res;
  }

  function go(id) {
    if (location.hash === '#/' + id) { render(); return; }
    location.hash = '#/' + id;
  }

  function toast(msg, ok) {
    var el = document.createElement('div');
    el.className = 'toast' + (ok === false ? ' bad' : '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(function () { el.remove(); }, ok === false ? 6000 : 3500);
  }

  function modal(opts) {
    var wrap = $('#modal');
    var btns = opts.ok
      ? '<button type="button" class="btn ghost" data-m="cancel">取消</button><button type="button" class="btn primary" data-m="ok">' + esc(opts.ok) + '</button>'
      : '<button type="button" class="btn primary" data-m="cancel">關閉</button>';
    wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle"><h2 id="mTitle">' + esc(opts.title) + '</h2>' + opts.html + '<div class="row-actions">' + btns + '</div></div>';
    wrap.hidden = false;
    function close() { wrap.hidden = true; wrap.innerHTML = ''; wrap.onclick = null; }
    wrap.onclick = function (e) {
      if (e.target === wrap || e.target.closest('[data-m="cancel"]')) close();
      else if (e.target.closest('[data-m="ok"]')) { if (opts.onOk(wrap) !== false) close(); }
    };
    var first = wrap.querySelector('textarea, input');
    if (first) { first.focus(); if (first.select) first.select(); }
    App._closeModal = close;
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      toast(ok ? '已複製到剪貼簿' : '複製失敗，請手動選取文字', ok);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('已複製到剪貼簿', true); }, fallback);
    } else fallback();
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // =====================================================================
  // 進度（工作台九步）
  // =====================================================================
  function workflowSteps() {
    var w = db.wb;
    var conf = w.requirements.filter(function (r) { return r.status === 'confirmed'; });
    var parts = Rules.partition(w);
    var run = Rules.lastRun(db);
    var erpDone = db.audit.some(function (a) { return a.action === 'APPROVED' || a.action === 'REJECTED'; });
    return [
      { n: 1, label: '建立 ERP 試做專案', tag: '定義問題', done: !!w.project.name, to: 'a' },
      { n: 2, label: '輸入初始需求', tag: '定義問題', done: !!w.project.need, to: 'a' },
      { n: 3, label: 'AI 需求訪談', tag: '拆解難點', done: w.interview.step >= Rules.DONE_STEP, to: 'interview' },
      { n: 4, label: '人工確認', tag: '人做決定', done: conf.length > 0 && Rules.buildBlockers(w).length === 0, to: 'confirm' },
      { n: 5, label: 'IF 閉環規則', tag: '拆解難點', done: parts.ready.length > 0, to: 'rules' },
      { n: 6, label: '產生開發包', tag: 'AI 提方案／查證', done: !!w.devpack, to: 'devpack' },
      { n: 7, label: 'Codex／Claude 開發', tag: '小步建立', done: parts.ready.length > 0 && parts.ready.every(Rules.implemented), to: 'devpack' },
      { n: 8, label: 'ERP 原型預覽', tag: '小步建立', done: erpDone, to: 'erp' },
      { n: 9, label: '驗收與追蹤', tag: '形成閉環', done: !!run && run.pass === run.total && w.versions.length > 0, to: 'verify' }
    ];
  }

  function navDone(id, steps) {
    var s = function (n) { return steps[n - 1].done; };
    switch (id) {
      case 'a': return s(1) && s(2);
      case 'interview': return s(3);
      case 'confirm': return s(4);
      case 'rules': return s(5);
      case 'devpack': return s(6);
      case 'verify': var r = Rules.lastRun(db); return !!r && r.pass === r.total;
      case 'versions': return db.wb.versions.length > 0;
      case 'erp': return s(8);
    }
    return false;
  }

  // =====================================================================
  // A 專案與來源
  // =====================================================================
  function pageA() {
    var w = db.wb, p = w.project;
    var steps = workflowSteps();
    var srcRows = w.sources.map(function (s) {
      return '<tr><td class="mono">' + esc(s.id) + '</td><td>' + esc(s.name) + '<br><small class="muted">' + esc(s.note) + '</small></td>' +
        '<td>' + esc(s.kind) + '</td><td class="num">' + fmtSize(s.size) + '</td><td class="nowrap">' + fmtTime(s.added_at) + '</td>' +
        '<td><button type="button" class="link" data-act="del-source" data-id="' + esc(s.id) + '">移除</button></td></tr>';
    }).join('');
    return '' +
      '<div class="page-head"><div><h1>A　專案與需求來源</h1><p class="sub">建立專案、輸入一句話需求、登記 Excel／單據來源</p></div></div>' +
      '<div class="grid-2">' +
        '<section class="card"><h2>專案</h2>' +
          '<form data-form="project">' +
            '<label>專案名稱<input name="name" value="' + esc(p.name) + '" maxlength="60"></label>' +
            '<label>一句話需求<textarea name="need" rows="2" placeholder="例：' + esc(Rules.DEFAULT_NEED) + '">' + esc(p.need) + '</textarea></label>' +
            '<label>負責人<input name="owner" value="' + esc(p.owner) + '" placeholder="例：研究生姓名"></label>' +
            '<div class="row-actions">' +
              '<button type="button" class="btn ghost" data-act="sample-need">填入範例需求</button>' +
              '<button type="submit" class="btn">儲存</button>' +
              '<button type="button" class="btn primary" data-act="save-and-interview">開始 AI 訪談 →</button>' +
            '</div>' +
          '</form>' +
        '</section>' +
        '<section class="card"><h2>需求來源 <span class="muted">（' + w.sources.length + '）</span></h2>' +
          '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>ID</th><th>檔名</th><th>類型</th><th class="num">大小</th><th>登記時間</th><th></th></tr></thead><tbody>' +
          (srcRows || '<tr><td colspan="6" class="muted">尚無來源</td></tr>') + '</tbody></table></div>' +
          '<label class="file-btn">＋ 上傳 Excel／單據<input type="file" data-change="add-source" multiple accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.txt,.docx"></label>' +
          '<p class="hint">v0.1 只登記檔名、類型與大小作為追溯來源，不解析檔案內容。</p>' +
        '</section>' +
      '</div>' +
      '<section class="card"><h2>工作台九步 <span class="muted small">每一步對應「先想清楚再動手」的七步驟；點方塊可前往</span></h2>' +
        '<ol class="steps9">' + steps.map(function (s) {
          return '<li class="c' + s.n + (s.done ? ' done' : '') + '" data-act="go" data-to="' + s.to + '"><span class="n">' + s.n + '</span><span class="lb">' + esc(s.label) + '</span><span class="tag">' + esc(s.tag) + '</span><span class="ok">' + (s.done ? '✓ 完成' : '未完成') + '</span></li>';
        }).join('') + '</ol>' +
        '<div class="grid-2">' +
          '<div class="note orange"><b>閉環：</b>⑨ 驗收不通過 → 回到 ⑦ 修正；發現需求誤解 → 回到 ③④；需求變更 → 回到 ⑤ 更新 IF 規則</div>' +
          '<div class="note"><b>三層：</b>Prompt（③ 問對問題）→ Context（⑤⑥ 規格、規則檔、開發包）→ Harness（⑦⑨ 測試、Git、關卡、人工審查）</div>' +
        '</div>' +
        '<div class="banner mt">AI 系統開發不是「Prompt → 程式碼」，而是「問題 → 拆解 → 解法 → 驗證 → 實作 → 回饋閉環」</div>' +
      '</section>' +
      '<section class="card"><h2>第一版收斂：工作台 4 區＋ERP 一條垂直流程</h2>' +
        '<div class="areas">' +
          '<div class="area" data-act="go" data-to="a"><b>A　專案與需求來源</b><span>建立專案、輸入一句話需求、上傳 Excel／單據</span></div>' +
          '<div class="area" data-act="go" data-to="interview"><b>B　AI 需求訪談＋確認</b><span>追問、整理需求卡、Confirmed／Rejected／Pending</span></div>' +
          '<div class="area c" data-act="go" data-to="rules"><b>C　IF 閉環規則＋開發包</b><span>規則卡、閉環檢查、SPEC／TASKS／TESTS</span></div>' +
          '<div class="area d" data-act="go" data-to="verify"><b>D　驗收、追蹤與版本</b><span>測試結果、需求→規則→程式→測試→版本</span></div>' +
        '</div>' +
        '<div class="flow mt">' + FLOW.map(function (f, i) { return (i ? '<span class="ar">›</span>' : '') + '<span class="st' + (i === 3 ? ' boss' : '') + '">' + f + '</span>'; }).join('') + '</div>' +
        '<div class="note">先不實作（列為 AI 找出的潛在需求候選）：寄庫、庫齡、部分出貨、取消已核准訂單、Excel 匯入清理、報表。展示 AI 能發現它們，第二階段再依優先序實作。</div>' +
      '</section>';
  }

  // =====================================================================
  // B 需求訪談
  // =====================================================================
  function reqTag(id) {
    var r = reqById(id);
    return '<span class="pill st-' + (r ? r.status : 'deferred') + '">→ ' + esc(id) + ' ' + (r ? esc(Rules.REQ_STATUS[r.status]) : '') + '</span>';
  }

  function msgHtml(m) {
    return '<div class="msg ' + m.who + '">' + (m.who === 'ai' ? '<span class="who">AI：</span>' : '') + md(m.text) +
      (m.reqs && m.reqs.length ? '<div class="tags">' + m.reqs.map(reqTag).join('') + '</div>' : '') + '</div>';
  }

  function pageInterview() {
    var it = db.wb.interview;
    var chips = Rules.interviewChips(it.step, db.wb);
    var open = it.questions.filter(function (q) { return !q.resolved; }).length;
    var reqs = db.wb.requirements;
    return '' +
      '<div class="page-head"><div><h1>B　AI 需求訪談</h1><p class="sub">AI 追問，把「送出就預留還是核准才預留」問出來</p></div>' +
        '<div class="head-actions"><button type="button" class="btn ghost sm" data-act="restart-interview">重新訪談</button></div></div>' +
      '<div class="interview">' +
        '<section class="card chat">' +
          '<div class="chat-log" id="chatLog">' +
            (it.messages.length ? it.messages.map(msgHtml).join('') :
              '<div class="chat-empty"><b>AI：</b>您好，請用一句話描述想解決的問題。我會依「ERP 難點檢核清單」追問細節。</div>') +
          '</div>' +
          (chips.length ? '<div class="chips"><span class="muted small">建議回答：</span>' + chips.map(function (c, i) {
            return '<button type="button" class="chip" data-act="chip" data-i="' + i + '">' + esc(c) + '</button>';
          }).join('') + '</div>' : '') +
          '<form class="chat-input" data-form="chat"><input id="chatMsg" name="msg" placeholder="輸入回答…" autocomplete="off" aria-label="輸入回答"><button type="submit" class="btn primary">送出</button></form>' +
          '<p class="hint">示範版：AI 追問由規則式引擎依「ERP 難點檢核清單」產生（不連網、不呼叫大型語言模型）。AI 只能提出需求草稿，確認由人決定。</p>' +
        '</section>' +
        '<aside class="card">' +
          '<h2>即時整理的需求（草稿）</h2>' +
          (reqs.length ? '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>ID</th><th>需求</th><th>狀態</th></tr></thead><tbody>' +
            reqs.map(function (r) { return '<tr><td class="nowrap mono">' + esc(r.id) + '</td><td>' + esc(r.text) + '</td><td>' + reqPill(r.status) + '</td></tr>'; }).join('') +
            '</tbody></table></div>' : '<p class="muted">訪談開始後，AI 會在這裡即時整理需求。</p>') +
          '<h3>尚待釐清 <span class="count-badge">' + open + '</span></h3>' +
          (it.questions.length ? '<ul class="qs">' + it.questions.map(function (q, i) {
            return '<li class="' + (q.resolved ? 'done' : '') + '">' + esc(q.text) + (q.resolved ? '' : ' <button type="button" class="link" data-act="resolve-q" data-i="' + i + '">標為已釐清</button>') + '</li>';
          }).join('') + '</ul>' : '<p class="muted small">目前沒有。</p>') +
          '<button type="button" class="btn primary block" data-act="go" data-to="confirm"' + (reqs.length ? '' : ' disabled') + '>前往需求確認 →</button>' +
        '</aside>' +
      '</div>';
  }

  // =====================================================================
  // B 需求確認
  // =====================================================================
  function reqOps(r) {
    var b = function (action, label, cls) {
      return '<button type="button" class="btn sm ' + (cls || '') + '" data-act="req" data-op="' + action + '" data-id="' + esc(r.id) + '">' + label + '</button>';
    };
    if (r.status === 'pending') return b('confirm', '確認', 'primary') + b('edit', '修改') + b('reject', '拒絕', 'danger');
    if (r.status === 'ai') return b('adopt', '採納', 'primary') + b('defer', '延後') + b('reject', '拒絕', 'danger');
    return '<span class="muted">—</span> <button type="button" class="link" data-act="req" data-op="revert" data-id="' + esc(r.id) + '">撤回</button>';
  }

  function pageConfirm() {
    var reqs = sortedReqs();
    var head = '<div class="page-head"><div><h1>B　需求確認</h1><p class="sub">需求逐條確認；AI 推論的需求必須由人採納</p></div>';
    if (!reqs.length) {
      return head + '</div><section class="card empty">尚無需求草稿。<br><button type="button" class="btn primary" data-act="go" data-to="interview">前往 AI 需求訪談</button></section>';
    }
    var n = function (st) { return reqs.filter(function (r) { return st.indexOf(r.status) >= 0; }).length; };
    var blockers = Rules.buildBlockers(db.wb);
    var rows = reqs.map(function (r) {
      var q = Rules.qualityScore(r.quality);
      var qt = Rules.QUALITY.map(function (name, i) { return name + ' ' + r.quality[i] + '／2'; }).join('\n');
      return '<tr class="' + (r.status === 'rejected' || r.status === 'deferred' ? 'dim' : '') + '">' +
        '<td class="nowrap mono">' + esc(r.id) + '</td>' +
        '<td class="req-text">' + esc(r.text) + (r.edited ? ' <span class="pill blue">已修改</span>' : '') + (r.note ? '<small>' + esc(r.note) + '</small>' : '') + '</td>' +
        '<td><button type="button" class="link" data-act="evidence" data-id="' + esc(r.id) + '">' + esc(r.source) + '</button></td>' +
        '<td class="num"><span class="q" title="' + esc(qt) + '">' + q + '／14</span></td>' +
        '<td class="nowrap">' + esc(r.priority) + '</td>' +
        '<td>' + reqPill(r.status) + '</td>' +
        '<td><div class="ops">' + reqOps(r) + '</div></td></tr>';
    }).join('');
    return head +
      '<div class="head-actions"><button type="button" class="btn primary" data-act="build-rules"' + (blockers.length ? ' disabled title="' + esc('尚未決定：' + blockers.join('、')) + '"' : '') + '>全部確認後建立 IF 規則 →</button></div></div>' +
      '<section class="card">' +
        '<div class="counters">' +
          '<span class="pill teal">Confirmed ' + n(['confirmed']) + '</span>' +
          '<span class="pill orange">Pending ' + n(['pending']) + '</span>' +
          '<span class="pill purple">AI 推論 ' + n(['ai']) + '</span>' +
          '<span class="pill">Rejected／延後 ' + n(['rejected', 'deferred']) + '</span>' +
        '</div>' +
        '<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th>ID</th><th>需求</th><th>來源</th><th class="num">品質</th><th>優先</th><th>狀態</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="hint">原則：AI 只能提出與評分，不能把需求改成「已確認」；每條需求都可點「來源」看原始訪談段落。REQ-004（核准才預留）與 REQ-004B（送出即預留）互斥，兩者不可同時確認。</p>' +
        (blockers.length ? '<div class="note orange mt"><b>還不能建立 IF 規則：</b>' + esc(blockers.join('、')) + '</div>' : '<div class="note teal mt">Must 需求都已決定，可以建立 IF 規則。</div>') +
      '</section>';
  }

  // =====================================================================
  // C IF 閉環規則
  // =====================================================================
  function testBadges(ids) {
    var run = Rules.lastRun(db);
    return (ids || []).map(function (id) {
      var tc = Tests.byId(id);
      if (!tc) return '<span class="pill purple">' + esc(id) + ' 未實作</span>';
      var r = run && run.results.filter(function (x) { return x.id === id; })[0];
      if (!r) return '<span class="pill">' + esc(id) + ' 未執行</span>';
      return '<span class="pill ' + (r.pass ? 'teal' : 'fail') + '">' + esc(id) + ' ' + (r.pass ? 'PASS' : 'FAIL') + '</span>';
    }).join('');
  }

  function fieldRow(rule, key, label) {
    var parts = key.split('.');
    var v = parts.length === 1 ? rule[key] : (rule[parts[0]] || {})[parts[1]];
    var isTests = /tests$/.test(key);
    var val = isTests ? (v || []).join(', ') : (v || '');
    var miss = !String(val).trim() && key !== 'edge.tests' && key !== 'edge.text';
    return '<div class="field"><span>' + label + '</span>' +
      '<input data-rule="' + esc(rule.id) + '" data-field="' + key + '" value="' + esc(val) + '" class="' + (miss ? 'missing' : '') + '" placeholder="' + (miss ? '（缺，必填）' : '') + '" aria-label="' + esc(rule.id + ' ' + label) + '">' +
      (isTests && v && v.length ? '<span class="tbadges">' + testBadges(v) + '</span>' : '') + '</div>';
  }

  function branchBox(rule, b) {
    var p = b === 't' ? 't.' : 'f.';
    return '<div class="branch ' + (b === 't' ? 'true' : 'false') + '"><h3>' + (b === 't' ? 'True 分支' : 'False 分支') + '</h3>' +
      fieldRow(rule, p + 'action', '動作') + fieldRow(rule, p + 'effect', '資料效果') + fieldRow(rule, p + 'message', '訊息') +
      fieldRow(rule, p + 'audit', '稽核') + fieldRow(rule, p + 'tests', '測試') + fieldRow(rule, p + 'final', '最終狀態') + '</div>';
  }

  function pageRules() {
    var rules = db.wb.rules;
    var head = '<div class="page-head"><div><h1>C　IF 閉環規則</h1><p class="sub">教授要求的 IF 閉環：8 項缺一項就不能進入開發</p></div>';
    if (!rules.length) {
      return head + '</div><section class="card empty">尚未建立規則。請先到「需求確認」決定所有 Must 需求，再按「全部確認後建立 IF 規則」。<br><button type="button" class="btn primary" data-act="go" data-to="confirm">前往需求確認</button></section>' + referenceCards();
    }
    var sel = rules.filter(function (r) { return r.id === ui.ruleSel; })[0] || rules.filter(function (r) { return r.id === 'RULE-004'; })[0] || rules[0];
    ui.ruleSel = sel.id;
    var ck = Rules.check(sel);
    var blocked = rules.filter(function (r) { return r.id !== sel.id && (r.orphan || !Rules.check(r).complete); });

    var tabs = '<div class="rule-tabs">' + rules.map(function (r) {
      var c = Rules.check(r);
      return '<button type="button" class="rule-tab ' + (r.id === sel.id ? 'on ' : '') + (c.complete && !r.orphan ? 'ok' : 'bad') + '" data-act="rule-sel" data-id="' + esc(r.id) + '">' +
        '<b>' + esc(r.id) + '　' + c.score + '／8</b><span>' + esc(r.title) + (r.orphan ? '（需求已撤回）' : '') + '</span></button>';
    }).join('') + '</div>';

    var main = '<section class="card rule-main">' +
      '<div class="rule-title"><h2>' + esc(sel.id) + '</h2>' +
        '<input class="title-in" data-rule="' + esc(sel.id) + '" data-field="title" value="' + esc(sel.title) + '" aria-label="規則名稱">' +
        '<span class="pill">對應 ' + esc(sel.reqs.join('、')) + '</span><span class="pill">' + esc(sel.version) + '</span><span class="pill">難點：' + esc(sel.difficulty) + '</span></div>' +
      (sel.orphan ? '<div class="note red" style="margin-bottom:12px">對應需求 ' + esc(sel.primary) + ' 目前不是「已確認」，此規則不會進入開發。</div>' : '') +
      (sel.note ? '<div class="note purple" style="margin-bottom:12px">' + esc(sel.note) + '</div>' : '') +
      '<div class="if-box"><b>IF</b><textarea rows="2" data-rule="' + esc(sel.id) + '" data-field="if" class="' + (sel.if ? '' : 'missing') + '" aria-label="IF 條件">' + esc(sel.if) + '</textarea></div>' +
      '<div class="branches">' + branchBox(sel, 't') + branchBox(sel, 'f') + '</div>' +
      '<div class="edge-box">' + fieldRow(sel, 'edge.text', '邊界') + fieldRow(sel, 'edge.tests', '邊界測試') + '</div>' +
      '<p class="hint">程式對應：' + (sel.code.length ? sel.code.map(function (c) { return '<code>' + esc(c) + '</code>'; }).join('、') : '（尚未實作）') +
      '　｜　欄位修改後離開輸入框即儲存；測試以逗號分隔，例如 TC-004-01, TC-004-02。</p>' +
    '</section>';

    var aside = '<aside class="card rule-check">' +
      '<span class="score ' + (ck.complete ? 'ok' : 'bad') + '">閉環完整 ' + ck.score + '／8</span>' +
      '<h3 style="margin-top:12px">閉環檢查</h3>' +
      '<ul class="checklist">' + ck.items.map(function (i) {
        return '<li class="' + (i.ok ? 'ok' : 'no') + '"><span class="mk">' + (i.ok ? '✓' : '✗') + '</span>' + esc(i.label) + '</li>';
      }).join('') + '</ul>' +
      '<div class="gate ' + (ck.complete && !sel.orphan ? 'ok' : 'bad') + '">' +
        (ck.complete && !sel.orphan ? '✔ 已形成完整閉環，可進入開發（會放進開發包）' : '✘ 尚未形成完整閉環，不可進入開發' + (ck.missing.length ? '：缺 ' + esc(ck.missing.join('、')) : '')) + '</div>' +
      (blocked.length ? '<div class="note orange mt small">' + blocked.map(function (r) {
        var c = Rules.check(r);
        return '<div><b>' + esc(r.id) + '（' + esc(r.title) + '）</b>：' + (r.orphan ? '需求已撤回' : '缺 ' + esc(c.missing.join('、'))) + ' → 不可進入開發</div>';
      }).join('') + '</div>' : '') +
      '<div class="row-actions mt"><button type="button" class="btn ghost sm" data-act="build-rules">依已確認需求更新規則</button><button type="button" class="btn primary sm" data-act="go" data-to="devpack">前往開發包 →</button></div>' +
    '</aside>';

    return head + '</div>' + tabs + '<div class="rule-layout">' + main + aside + '</div>' + referenceCards();
  }

  function referenceCards() {
    var diff = Rules.DIFFICULTIES.map(function (d) {
      var cls = d.v1 === '做' ? 'teal' : d.v1 === '部分' ? 'orange' : '';
      return '<tr><td>' + esc(d.name) + '</td><td class="mono nowrap">' + esc(d.rule) + '</td><td><span class="pill ' + cls + '">' + esc(d.v1) + '</span></td><td class="small">' + esc(d.ask) + '</td></tr>';
    }).join('');
    var sm = Rules.STATE_MACHINE.map(function (t) {
      return '<tr class="' + (t.v1 ? '' : 'dim') + '"><td class="nowrap">' + orderPill(t.from) + ' → ' + orderPill(t.to) + '</td><td class="small">' + esc(t.cond) + '</td><td class="mono nowrap">' + esc(t.rule) + '</td><td>' + (t.v1 ? '<span class="pill teal">第一版</span>' : '<span class="pill">候選</span>') + '</td></tr>';
    }).join('');
    return '<div class="grid-2 mt">' +
      '<section class="card"><h2>ERP 九大難點 → AI 必問的問題</h2><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>難點</th><th>規則</th><th>第一版</th><th>AI 必問</th></tr></thead><tbody>' + diff + '</tbody></table></div>' +
        '<p class="hint">綠＝第一版做　橘＝部分　灰＝潛在需求候選</p></section>' +
      '<section class="card"><h2>訂單狀態機：每個箭頭都是一條 IF 規則</h2><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>轉換</th><th>條件</th><th>規則</th><th></th></tr></thead><tbody>' + sm + '</tbody></table></div></section>' +
    '</div>';
  }

  // =====================================================================
  // C 開發包
  // =====================================================================
  function pageDevpack() {
    var head = '<div class="page-head"><div><h1>C　開發包</h1><p class="sub">只有閉環 8／8 的規則會進入開發包，交給 Codex／Claude Code 實作</p></div>';
    if (!db.wb.rules.length) {
      return head + '</div><section class="card empty">尚未建立 IF 規則，無法產生開發包。<br><button type="button" class="btn primary" data-act="go" data-to="rules">前往 IF 閉環規則</button></section>';
    }
    var pack = Rules.devpack(db);
    var dp = db.wb.devpack;
    var stale = dp && dp.ready.join(',') !== pack.ready.join(',');
    var names = Object.keys(pack.files);
    if (names.indexOf(ui.devTab) < 0) ui.devTab = names[0];
    var blockedRules = Rules.partition(db.wb).blocked;
    return head +
      '<div class="head-actions"><button type="button" class="btn primary" data-act="gen-devpack"' + (pack.ready.length ? '' : ' disabled') + '>' + (dp ? '重新產生開發包' : '產生開發包') + '</button></div></div>' +
      '<div class="grid-2">' +
        '<section class="card"><h2>進入開發 <span class="pill teal">' + pack.ready.length + '</span></h2>' +
          (pack.ready.length ? pack.ready.map(function (id) { return '<span class="pill teal">' + esc(id) + ' 8／8</span> '; }).join('') : '<p class="muted">沒有閉環 8／8 的規則。</p>') +
          '<p class="hint">' + (dp ? '最近產生：' + fmtTime(dp.at) + '（目標版本 ' + esc(dp.version) + '）' : '尚未產生開發包。') + '</p>' +
          (stale ? '<div class="note orange mt small">規則在產生後有變動，請重新產生開發包。</div>' : '') +
        '</section>' +
        '<section class="card"><h2>閘門擋下 <span class="pill orange">' + blockedRules.length + '</span></h2>' +
          (blockedRules.length ? '<ul class="checklist">' + blockedRules.map(function (b) {
            return '<li class="no"><span class="mk">✗</span><span><b>' + esc(b.rule.id) + '</b> ' + esc(b.rule.title) + '：' + (b.rule.orphan ? '需求已撤回' : '缺 ' + esc(b.check.missing.join('、'))) + '</span></li>';
          }).join('') + '</ul>' : '<p class="muted">沒有被擋下的規則。</p>') +
        '</section>' +
      '</div>' +
      '<section class="card">' +
        '<div class="tabs" role="tablist">' + names.map(function (n) {
          return '<button type="button" role="tab" class="tab ' + (n === ui.devTab ? 'on' : '') + '" data-act="dev-tab" data-tab="' + esc(n) + '">' + esc(n) + '</button>';
        }).join('') + '</div>' +
        '<pre class="code">' + esc(pack.files[ui.devTab]) + '</pre>' +
        '<div class="row-actions mt"><button type="button" class="btn" data-act="dev-copy">複製 ' + esc(ui.devTab) + '</button><button type="button" class="btn ghost" data-act="dev-download">下載 ' + esc(ui.devTab) + '</button></div>' +
        '<p class="hint">開發包內容隨規則即時更新；按「產生開發包」會把這次交付記錄下來（完成前檢查「寫在 SPEC」會用到）。</p>' +
      '</section>';
  }

  // =====================================================================
  // D 驗收與追蹤
  // =====================================================================
  function pageVerify() {
    var run = Rules.lastRun(db);
    var res = {};
    if (run) run.results.forEach(function (r) { res[r.id] = r; });
    var parts = Rules.partition(db.wb);
    var reqs = sortedReqs();
    var confirmed = reqs.filter(function (r) { return r.status === 'confirmed'; }).length;
    var found = Rules.RRB.filter(function (x) { return x.reqs.some(function (id) { return !!reqById(id); }); }).length;
    var allPass = run && run.pass === run.total;

    var testRows = Tests.cases.map(function (c) {
      var r = res[c.id];
      return '<tr><td class="mono nowrap">' + esc(c.id) + '</td><td class="mono nowrap">' + esc(c.rule) + '</td><td>' + esc(c.branch) + '</td>' +
        '<td><b>' + esc(c.title) + '</b><br><span class="small muted">前提：' + esc(c.given) + '</span><br><span class="small">預期：' + esc(c.expect) + '</span></td>' +
        '<td class="small">' + (r ? esc(r.actual) : '<span class="muted">尚未執行</span>') + '</td>' +
        '<td>' + (r ? '<span class="res ' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? 'PASS' : 'FAIL') + '</span>' : '—') + '</td></tr>';
    }).join('');

    var traceRows = reqs.map(function (q) {
      var rules = db.wb.rules.filter(function (r) { return r.reqs.indexOf(q.id) >= 0; });
      var ver = db.wb.versions.filter(function (v) {
        return v.reqs.some(function (x) { return x.id === q.id && x.status === 'confirmed'; }) &&
          (!rules.length || v.rules.some(function (x) { return x.complete && rules.some(function (r) { return r.id === x.id; }); }));
      })[0];
      var ruleCell = rules.length ? rules.map(function (r) {
        var c = Rules.check(r);
        return '<span class="pill ' + (c.complete && !r.orphan ? 'teal' : 'orange') + '">' + esc(r.id) + ' ' + c.score + '／8</span>';
      }).join(' ') : '<span class="muted">—</span>';
      var code = [];
      rules.forEach(function (r) { r.code.forEach(function (c) { if (code.indexOf(c) < 0) code.push(c); }); });
      var tests = [];
      rules.forEach(function (r) { Rules.testIds(r).forEach(function (t) { if (tests.indexOf(t) < 0) tests.push(t); }); });
      return '<tr class="' + (q.status === 'confirmed' ? '' : 'dim') + '"><td><b class="mono">' + esc(q.id) + '</b> ' + reqPill(q.status) + '<br><span class="small">' + esc(q.text) + '</span></td>' +
        '<td>' + ruleCell + '</td>' +
        '<td class="small">' + (code.length ? code.map(function (c) { return '<code>' + esc(c) + '</code>'; }).join('<br>') : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (tests.length ? testBadges(tests) : '<span class="muted">—</span>') + '</td>' +
        '<td class="mono">' + (ver ? esc(ver.id) : '<span class="muted">—</span>') + '</td></tr>';
    }).join('');

    var rrbRows = Rules.RRB.map(function (x) {
      var hit = x.reqs.filter(function (id) { return !!reqById(id); });
      return '<tr><td>' + esc(x.name) + (x.v1 ? ' <span class="pill blue">第一版涉及</span>' : '') + '</td><td class="mono small">' + esc(x.reqs.join('、')) + '</td><td>' +
        (hit.length ? '<span class="pill teal">AI 找到 ' + esc(hit.join('、')) + '</span>' : '<span class="pill fail">未找到</span>') + '</td></tr>';
    }).join('');

    return '' +
      '<div class="page-head"><div><h1>D　驗收與追蹤</h1><p class="sub">每條規則的 True 和 False 都要 PASS；需求 → 規則 → 程式 → 測試 → 版本全程可追溯</p></div>' +
        '<div class="head-actions"><button type="button" class="btn primary" data-act="run-tests">執行全部驗收測試（' + Tests.cases.length + '）</button></div></div>' +
      '<div class="kpis">' +
        '<div class="kpi ' + (run ? (allPass ? 'good' : 'warn') : '') + '"><div class="v">' + (run ? run.pass : '—') + '／' + Tests.cases.length + '</div><div class="l">驗收測試 PASS' + (run ? '（' + fmtTime(run.at) + '）' : '（尚未執行）') + '</div></div>' +
        '<div class="kpi ' + (parts.ready.length ? 'good' : '') + '"><div class="v">' + parts.ready.length + '／' + db.wb.rules.length + '</div><div class="l">規則閉環 8／8</div></div>' +
        '<div class="kpi"><div class="v">' + confirmed + '／' + reqs.length + '</div><div class="l">已確認需求</div></div>' +
        '<div class="kpi"><div class="v">' + found + '／' + Rules.RRB.length + '</div><div class="l">RRB 隱含需求召回（示意）</div></div>' +
      '</div>' +
      '<section class="card"><h2>驗收測試結果 ' + (run ? '<span class="pill ' + (allPass ? 'teal' : 'fail') + '">' + (allPass ? '全部 PASS' : (run.total - run.pass) + ' 項 FAIL') + '</span>' : '') + '</h2>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>測試</th><th>規則</th><th>分支</th><th>案例</th><th>實際結果</th><th>結果</th></tr></thead><tbody>' + testRows + '</tbody></table></div>' +
        '<p class="hint">測試每次都從 SEED 複本開始執行，不會改動目前的 ERP 資料；也可在瀏覽器主控台執行 <code>Tests.runAll()</code>。</p>' +
      '</section>' +
      '<section class="card"><h2>追蹤矩陣：需求 → 規則 → 程式 → 測試 → 版本</h2>' +
        (reqs.length ? '<div class="tbl-wrap"><table class="tbl trace"><thead><tr><th>需求</th><th>規則</th><th>程式</th><th>測試</th><th>版本</th></tr></thead><tbody>' + traceRows + '</tbody></table></div>'
          : '<p class="muted">尚無需求。請先完成 AI 需求訪談。</p>') +
      '</section>' +
      '<section class="card"><h2>參考需求基準 RRB（七項）</h2>' +
        '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>參考需求</th><th>對應需求</th><th>AI 是否找到</th></tr></thead><tbody>' + rrbRows + '</tbody></table></div>' +
        '<p class="hint">隱含需求召回率 ＝ AI 正確找出的隱含需求數 ÷ RRB 中的隱含需求總數。RRB 需經「整理候選 → 獨立分類 → 專家確認 → 記錄爭議 → 凍結 v1.0 → 正式測試」六步程序凍結後才作正式計算，目前為示意。</p>' +
      '</section>';
  }

  // =====================================================================
  // D 版本
  // =====================================================================
  function pageVersions() {
    var checks = Rules.checklist(db);
    var okCount = checks.filter(function (c) { return c.ok; }).length;
    var next = Rules.nextVersion(db.wb.versions);
    var run = Rules.lastRun(db);
    var parts = Rules.partition(db.wb);
    var confirmed = db.wb.requirements.filter(function (r) { return r.status === 'confirmed'; }).length;
    var vers = db.wb.versions.slice().reverse();

    var chk = checks.map(function (c) {
      return '<div class="chk-row">' +
        (c.auto ? '<span class="auto-mk ' + (c.ok ? 'ok' : 'no') + '" aria-label="' + (c.ok ? '已通過' : '未通過') + '">' + (c.ok ? '✓' : '✗') + '</span>'
          : '<input type="checkbox" id="chk-' + c.key + '" ' + (c.ok ? 'checked ' : '') + 'data-check="' + c.key + '">') +
        '<label for="chk-' + c.key + '" style="margin:0"><b>' + esc(c.label) + '</b> ' + (c.auto ? '<span class="pill auto ' + (c.ok ? 'teal' : 'orange') + '">自動</span>' : '<span class="pill auto">人工</span>') +
        '<br><span class="small muted">' + esc(c.hint) + '</span></label></div>';
    }).join('');

    var rows = vers.map(function (v, i) {
      var prev = vers[i + 1];
      var conf = function (x) { return x ? x.reqs.filter(function (r) { return r.status === 'confirmed'; }).map(function (r) { return r.id; }) : []; };
      var ready = function (x) { return x ? x.rules.filter(function (r) { return r.complete; }).map(function (r) { return r.id; }) : []; };
      var diff = [];
      if (prev) {
        conf(v).filter(function (id) { return conf(prev).indexOf(id) < 0; }).forEach(function (id) { diff.push('＋' + id); });
        conf(prev).filter(function (id) { return conf(v).indexOf(id) < 0; }).forEach(function (id) { diff.push('－' + id); });
        ready(v).filter(function (id) { return ready(prev).indexOf(id) < 0; }).forEach(function (id) { diff.push('＋' + id); });
        ready(prev).filter(function (id) { return ready(v).indexOf(id) < 0; }).forEach(function (id) { diff.push('－' + id); });
        var tp = v.tests ? v.tests.pass : 0, pp = prev.tests ? prev.tests.pass : 0;
        if (tp !== pp) diff.push('測試 ' + pp + ' → ' + tp);
      }
      var ck = v.checklist.filter(function (c) { return c.ok; }).length;
      return '<tr><td class="mono"><b>' + esc(v.id) + '</b></td><td class="nowrap">' + fmtTime(v.at) + '</td><td>' + esc(v.note || '—') + '</td>' +
        '<td class="num">' + conf(v).length + '</td><td class="num">' + ready(v).length + '／' + v.rules.length + '</td>' +
        '<td>' + (v.tests ? '<span class="res ' + (v.tests.pass === v.tests.total ? 'pass' : 'fail') + '">' + v.tests.pass + '／' + v.tests.total + '</span>' : '<span class="muted">未測</span>') + '</td>' +
        '<td class="num">' + ck + '／9</td><td class="small">' + (prev ? (diff.length ? esc(diff.join('、')) : '無變動') : '第一版') + '</td></tr>';
    }).join('');

    var logs = db.wb.log.slice(-12).reverse().map(function (l) {
      return '<tr><td class="nowrap">' + fmtTime(l.at) + '</td><td class="mono">' + esc(l.action) + '</td><td class="small">' + esc(l.detail) + '</td></tr>';
    }).join('');

    return '' +
      '<div class="page-head"><div><h1>D　版本</h1><p class="sub">每個功能完成前 9 項檢查；每次交付存一個版本快照</p></div>' +
        '<div class="head-actions"><button type="button" class="btn ghost" data-act="export">匯出全部資料（JSON）</button></div></div>' +
      '<div class="grid-2">' +
        '<section class="card"><h2>完成前 9 項檢查 <span class="pill ' + (okCount === 9 ? 'teal' : 'orange') + '">' + okCount + '／9</span></h2>' + chk + '</section>' +
        '<section class="card"><h2>建立版本快照</h2>' +
          '<p>下一個版本：<b class="mono">' + esc(next) + '</b></p>' +
          '<ul class="checklist">' +
            '<li class="' + (confirmed ? 'ok' : 'no') + '"><span class="mk">' + (confirmed ? '✓' : '✗') + '</span>已確認需求 ' + confirmed + ' 條</li>' +
            '<li class="' + (parts.ready.length ? 'ok' : 'no') + '"><span class="mk">' + (parts.ready.length ? '✓' : '✗') + '</span>閉環 8／8 規則 ' + parts.ready.length + ' 條（擋下 ' + parts.blocked.length + ' 條）</li>' +
            '<li class="' + (run && run.pass === run.total ? 'ok' : 'no') + '"><span class="mk">' + (run && run.pass === run.total ? '✓' : '✗') + '</span>最近一次測試 ' + (run ? run.pass + '／' + run.total + '（' + fmtTime(run.at) + '）' : '尚未執行') + '</li>' +
          '</ul>' +
          '<form data-form="version"><label>版本說明<textarea name="note" rows="3" placeholder="例：第一版垂直切片：查詢、叫貨、核准預留"></textarea></label>' +
          (okCount < 9 ? '<div class="note orange small" style="margin-bottom:10px">還有 ' + (9 - okCount) + ' 項檢查未完成；仍可存版本，快照會記錄未完成項目。</div>' : '') +
          '<button type="submit" class="btn primary">建立 ' + esc(next) + ' 快照</button></form>' +
        '</section>' +
      '</div>' +
      '<section class="card"><h2>版本紀錄</h2>' +
        (rows ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>版本</th><th>時間</th><th>說明</th><th class="num">已確認需求</th><th class="num">規則 8／8</th><th>測試</th><th class="num">檢查</th><th>與上一版差異</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<p class="muted">尚無版本。</p>') +
      '</section>' +
      '<section class="card"><h2>工作台操作紀錄 <span class="muted small">（最近 12 筆）</span></h2>' +
        (logs ? '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>時間</th><th>動作</th><th>內容</th></tr></thead><tbody>' + logs + '</tbody></table></div>' : '<p class="muted">尚無紀錄。</p>') +
      '</section>';
  }

  // =====================================================================
  // ERP 預覽
  // =====================================================================
  function flowHot() {
    var a = last(db.audit);
    if (!a) return [];
    switch (a.action) {
      case 'QUERY': return [0];
      case 'ADD_LINE': case 'UPDATE_LINE': case 'REMOVE_LINE': return [1];
      case 'SUBMITTED': return [2];
      case 'APPROVED': return [3, 4, 5];
      case 'REJECTED': case 'RETURNED': return [3];
      default: return [];
    }
  }

  function linesTable(o, editable) {
    return '<table class="lines">' + o.lines.map(function (l) {
      return '<tr><td>' + esc(ERP.view.label(db, l.sku)) + '</td><td class="right nowrap">' +
        (editable ? '× <input class="qty" data-line-qty="' + esc(o.id + '|' + l.sku) + '" value="' + esc(l.qty) + '" inputmode="numeric" aria-label="數量"> <button type="button" class="link" data-act="remove-line" data-id="' + esc(o.id) + '" data-sku="' + esc(l.sku) + '">移除</button>'
          : '× ' + l.qty) + '</td></tr>';
    }).join('') + '</table>';
  }

  function orderCard(o, opts) {
    var lastH = last(o.history);
    return '<div class="order' + (opts && opts.short ? ' short' : '') + '"><div class="order-h"><b class="mono">' + esc(o.id) + '</b>' + orderPill(o.status) +
      '<span class="small muted">' + esc(o.customer || '（未填客戶）') + '｜' + esc(userName(o.created_by)) + '｜' + fmtTime(lastH ? lastH.at : o.created_at) + '</span></div>' +
      ((opts && opts.body) || linesTable(o, false)) +
      (o.status === 'RETURNED' && o.return_reason ? '<div class="why">退回原因：' + esc(o.return_reason) + '</div>' : '') +
      (o.status === 'REJECTED' && lastH ? '<div class="why">' + esc(lastH.note) + '</div>' : '') +
      ((opts && opts.actions) ? '<div class="row-actions mt">' + opts.actions + '</div>' : '') + '</div>';
  }

  function pageERP() {
    var u = ERP.view.user(db, ui.erpUser) || db.users[0];
    ui.erpUser = u.id;
    var boss = Rules.isBoss(u);
    var q = ERP.queryStock(db, u.id, ui.erpQuery); // 只取查詢結果顯示；狀態不存（按「查詢」才寫稽核）
    var rows = q.data || [];
    var hot = flowHot();
    var inv = ERP.view.invariants(db);

    var roles = '<div class="roles">' + db.users.map(function (x) {
      return '<button type="button" class="role ' + (x.id === u.id ? 'on' : '') + '" data-act="erp-user" data-id="' + esc(x.id) + '">' + esc(x.name) + '（' + Rules.ROLE[x.role] + '）</button>';
    }).join('') + '</div>';

    var flow = '<div class="flow">' + FLOW.map(function (f, i) {
      return (i ? '<span class="ar">›</span>' : '') + '<span class="st' + (i === 3 ? ' boss' : '') + (hot.indexOf(i) >= 0 ? ' hot' : '') + '">' + f + '</span>';
    }).join('') + '</div>';

    var stockRows = rows.map(function (r) {
      var zero = r.available <= 0;
      return '<tr><td class="nowrap"><b>' + esc(r.spec) + '</b></td><td>' + esc(r.brand) + '<br><span class="small muted">' + esc(r.name) + '</span></td><td class="num">' + esc(r.year) + '</td>' +
        '<td class="num">' + r.on_hand + '</td><td class="num">' + r.reserved + '</td><td class="num"><b class="' + (zero ? 'zero' : '') + '">' + r.available + '</b></td>' +
        '<td class="num">' + fmtNum(r.price) + '</td>' +
        (boss ? '<td class="num">' + fmtNum(r.cost) + '</td><td class="num">' + fmtNum(r.margin) + '</td>' :
          '<td class="nowrap"><input class="qty" id="qty-' + esc(r.sku) + '" value="1" inputmode="numeric" aria-label="' + esc(r.spec) + ' 叫貨數量"> <button type="button" class="btn sm primary" data-act="add-line" data-sku="' + esc(r.sku) + '">加入叫貨</button></td>') +
        '</tr>';
    }).join('');

    var stock = '<section class="card"><h2>查詢庫存 <span class="muted small">（' + (boss ? '老闆：含成本' : '業務：看不到成本') + '）</span></h2>' +
      '<form class="search" data-form="search"><input type="search" name="kw" value="' + esc(ui.erpQuery) + '" placeholder="輸入規格、品牌或型號，例如 205/55R16" aria-label="查詢關鍵字"><button type="submit" class="btn primary">查詢</button>' +
      (ui.erpQuery ? '<button type="button" class="btn ghost" data-act="clear-search">全部</button>' : '') + '</form>' +
      '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>規格</th><th>品牌／型號</th><th class="num">年份</th><th class="num">在庫</th><th class="num">預留</th><th class="num">可用</th><th class="num">售價</th>' +
      (boss ? '<th class="num">成本</th><th class="num">毛利</th>' : '<th>叫貨數量</th>') + '</tr></thead><tbody>' +
      (stockRows || '<tr><td colspan="9" class="muted">查無資料</td></tr>') + '</tbody></table></div>' +
      '<p class="fields-proof">RULE-001 查詢結果物件欄位：<code>' + esc(rows.length ? Object.keys(rows[0]).join(', ') : Rules.SALES_FIELDS.join(', ')) + '</code>' + (boss ? '' : '（無 cost）') + '　｜　可用 = 在庫 − 預留</p>' +
      (boss ? '' : '<p class="hint">可試著輸入 0、-1、1.5 再加入叫貨，會被 RULE-002 擋下。</p>') +
    '</section>';

    var right;
    if (boss) {
      var pend = ERP.view.pending(db, u.id);
      var pendHtml = pend.map(function (o) {
        var body = '<table class="lines">' + o.lines.map(function (l) {
          return '<tr><td>' + esc(l.label) + ' × ' + l.qty + '</td><td class="right nowrap small ' + (l.enough ? 'inv-ok' : 'inv-bad') + '">目前可用 ' + l.available + (l.enough ? ' ✓' : ' ✗ 不足') + '</td></tr>';
        }).join('') + '</table>';
        return orderCard(o, {
          short: !o.enough, body: body,
          actions: '<button type="button" class="btn sm primary" data-act="approve" data-id="' + esc(o.id) + '">核准</button><button type="button" class="btn sm" data-act="return" data-id="' + esc(o.id) + '">退回</button>'
        });
      }).join('');
      var all = ERP.view.orders(db, u.id).map(function (o) {
        return '<tr><td class="mono">' + esc(o.id) + '</td><td>' + esc(userName(o.created_by)) + '</td><td>' + esc(o.customer || '—') + '</td>' +
          '<td class="small">' + o.lines.map(function (l) { return esc(ERP.view.label(db, l.sku).split(' ')[0]) + '×' + l.qty; }).join('、') + '</td>' +
          '<td>' + orderPill(o.status) + '</td><td>' + (o.status === 'SUBMITTED' ? '' : '<button type="button" class="link" data-act="return" data-id="' + esc(o.id) + '" title="示範 RULE-005：非待審核訂單不可退回">退回</button>') + '</td></tr>';
      }).join('');
      right = '<section class="card"><h2>待審核 <span class="pill orange">' + pend.length + '</span></h2>' +
          (pendHtml || '<p class="muted">沒有待審核的叫貨單。</p>') +
          '<p class="hint">RULE-004：按「核准」時會重新讀取最新庫存再判斷；畫面上的「目前可用」只供參考。可開兩個分頁，分別以王老闆、王太太核准同一批最後庫存。</p>' +
        '</section>' +
        '<section class="card"><h2>全部訂單</h2><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>單號</th><th>業務</th><th>客戶</th><th>品項</th><th>狀態</th><th></th></tr></thead><tbody>' +
          (all || '<tr><td colspan="6" class="muted">尚無訂單</td></tr>') + '</tbody></table></div></section>';
    } else {
      var d = ERP.view.draft(db, u.id);
      var cart = d ? orderCard(d, {
        body: '<label class="small">客戶<input data-cust="' + esc(d.id) + '" value="' + esc(d.customer) + '" placeholder="客戶名稱（選填）"></label>' + linesTable(d, true),
        actions: '<button type="button" class="btn primary" data-act="submit" data-id="' + esc(d.id) + '"' + (d.lines.length ? '' : ' disabled') + '>送出叫貨單</button>'
      }) : '<p class="muted">購物車是空的：在左邊輸入數量後按「加入叫貨」。</p>';
      var mine = ERP.view.orders(db, u.id).map(function (o) {
        if (o.status === 'RETURNED') {
          return orderCard(o, { body: linesTable(o, true), actions: '<button type="button" class="btn sm primary" data-act="submit" data-id="' + esc(o.id) + '">修改後重新送出</button>' });
        }
        return orderCard(o);
      }).join('');
      right = '<section class="card"><h2>我的叫貨單（購物車）</h2>' + cart + '<p class="hint">送出後狀態為「待審核」，此時還不會預留庫存（REQ-004：老闆核准時才預留）。</p></section>' +
        '<section class="card"><h2>我的訂單</h2>' + (mine || '<p class="muted">尚無送出的訂單。</p>') + '</section>';
    }

    var audits = db.audit.slice(-15).reverse().map(function (a) {
      return '<tr><td class="nowrap">' + fmtTime(a.at) + '</td><td class="nowrap">' + esc(a.actor_name) + '</td><td class="mono nowrap">' + esc(a.action) + '</td><td class="mono nowrap">' + esc(a.rule || '—') + '</td>' +
        '<td>' + (a.ok ? '<span class="inv-ok">✓</span>' : '<span class="inv-bad">✗</span>') + ' ' + esc(a.message) + '</td></tr>';
    }).join('');

    return '' +
      '<div class="page-head"><div><h1>ERP 預覽｜輪胎批發</h1><p class="sub">一條垂直流程：查庫存 → 叫貨 → 送出 → 老闆核准 → 建立預留 → 更新可用庫存</p></div>' + roles + '</div>' +
      flow +
      '<div class="erp-grid"><div>' + stock + '</div><div>' + right + '</div></div>' +
      '<section class="card"><h2>稽核日誌 <span class="muted small">（最近 15 筆，共 ' + db.audit.length + ' 筆）</span>' +
        '<span class="small ' + (inv.length ? 'inv-bad' : 'inv-ok') + '">' + (inv.length ? '✗ 不變式異常：' + esc(inv.join('；')) : '✓ 不變式：每個品項 0 ≤ 預留 ≤ 在庫，且預留 = 已核准數量合計') + '</span></h2>' +
        (audits ? '<div class="tbl-wrap"><table class="tbl compact audit-log"><thead><tr><th>時間</th><th>人員</th><th>動作</th><th>規則</th><th>訊息</th></tr></thead><tbody>' + audits + '</tbody></table></div>' : '<p class="muted">尚無紀錄。每個 ERP 動作（含被拒絕的）都會寫一筆。</p>') +
      '</section>';
  }

  // =====================================================================
  // 示範腳本（8 分鐘）
  // =====================================================================
  function fmtClock(s) { var a = Math.abs(s); return (s < 0 ? '-' : '') + Math.floor(a / 60) + ':' + two(a % 60); }

  function renderDemo() {
    var el = $('#demo');
    el.hidden = !ui.demoOpen;
    if (!ui.demoOpen) return;
    var t = ui.timer;
    el.innerHTML = '<h2>8 分鐘示範 <button type="button" class="btn sm ghost" data-act="toggle-demo">關閉</button></h2>' +
      '<div class="timer ' + (t.left < 0 ? 'over' : '') + '" id="demoClock">' + fmtClock(t.left) + '</div>' +
      '<div class="row-actions" style="justify-content:center"><button type="button" class="btn sm primary" data-act="timer">' + (t.running ? '暫停' : '開始計時') + '</button><button type="button" class="btn sm ghost" data-act="timer-reset">歸零</button></div>' +
      '<ol>' + DEMO.map(function (d, i) {
        return '<li class="' + (i === ui.demoStep ? 'cur' : '') + '" data-act="demo-step" data-i="' + i + '"><span class="t">' + d.t + '</span><b>' + (i + 1) + '. ' + esc(d.title) + '</b>' + esc(d.say) + '</li>';
      }).join('') + '</ol>' +
      '<p class="hint">示範前可按右上「重設資料」回到初始狀態。</p>';
  }

  function tick() {
    ui.timer.left -= 1;
    var c = $('#demoClock');
    if (c) { c.textContent = fmtClock(ui.timer.left); c.className = 'timer' + (ui.timer.left < 0 ? ' over' : ''); }
  }

  // =====================================================================
  // 主畫面
  // =====================================================================
  var PAGES = { a: pageA, interview: pageInterview, confirm: pageConfirm, rules: pageRules, devpack: pageDevpack, verify: pageVerify, versions: pageVersions, erp: pageERP };

  function currentRoute() {
    var id = (location.hash || '').replace(/^#\/?/, '');
    return ROUTES.filter(function (r) { return r.id === id; })[0] || ROUTES[0];
  }

  function render() {
    var r = currentRoute();
    ui.route = r.id;
    var steps = workflowSteps();
    $('#nav').innerHTML = ROUTES.map(function (x) {
      return (x.id === 'erp' ? '<div class="sep"></div>' : '') +
        '<a href="#/' + x.id + '" class="' + (x.id === r.id ? 'active' : '') + '"' + (x.id === r.id ? ' aria-current="page"' : '') + '><span>' + esc(x.nav) + '</span><span class="dot ' + (navDone(x.id, steps) ? 'done' : '') + '"></span></a>';
    }).join('');
    $('#crumb').textContent = '工作台／' + db.wb.project.name + '／' + r.title;
    $('#verBadge').textContent = db.wb.versions.length ? db.meta.version : '尚未發版';
    $('#sideFoot').innerHTML = '九步完成 ' + steps.filter(function (s) { return s.done; }).length + '／9<br>' +
      (Store.persistent() ? '資料存在本機瀏覽器（localStorage）' : '⚠ 瀏覽器不允許 localStorage，關閉後資料會消失');
    $('#main').innerHTML = PAGES[r.id]();
    var log = $('#chatLog');
    if (log) log.scrollTop = log.scrollHeight;
    if (ui.focus) { var f = document.getElementById(ui.focus); if (f) f.focus(); ui.focus = ''; }
    renderDemo();
  }

  // =====================================================================
  // 事件
  // =====================================================================
  function sendChat(text) {
    ui.focus = 'chatMsg';
    act(function (cur) { return Store.wb.interviewSend(cur, text); });
  }

  function projectFields() {
    var f = document.querySelector('form[data-form="project"]');
    return f ? { name: f.elements.name.value, need: f.elements.need.value, owner: f.elements.owner.value } : {};
  }

  var ACTIONS = {
    go: function (el) { go(el.dataset.to); },
    reset: function () {
      if (!window.confirm('確定要重設？所有訪談、需求、規則、訂單、稽核與版本都會回到初始資料（SEED）。')) return;
      db = Store.reset();
      ui.erpQuery = ''; ui.ruleSel = '';
      toast('已重設回初始資料', true);
      render();
    },
    'toggle-demo': function () { ui.demoOpen = !ui.demoOpen; renderDemo(); },
    timer: function () {
      var t = ui.timer;
      if (t.running) { clearInterval(t.handle); t.running = false; }
      else { t.handle = setInterval(tick, 1000); t.running = true; }
      renderDemo();
    },
    'timer-reset': function () { var t = ui.timer; clearInterval(t.handle); t.running = false; t.left = 480; ui.demoStep = 0; renderDemo(); },
    'demo-step': function (el) { ui.demoStep = Number(el.dataset.i); go(DEMO[ui.demoStep].to); renderDemo(); },

    // A
    'sample-need': function () {
      var f = projectFields();
      f.need = Rules.DEFAULT_NEED;
      act(function (cur) { return Store.wb.updateProject(cur, f); });
    },
    'save-and-interview': function () {
      var f = projectFields();
      var res = act(function (cur) { return Store.wb.updateProject(cur, f); }, { silent: true });
      if (res.ok) go('interview'); else toast(res.message, false);
    },
    'del-source': function (el) { act(function (cur) { return Store.wb.removeSource(cur, el.dataset.id); }); },

    // B 訪談
    chip: function (el) {
      var text = Rules.interviewChips(db.wb.interview.step, db.wb)[Number(el.dataset.i)];
      if (text) sendChat(text);
    },
    'restart-interview': function () {
      if (!window.confirm('重新訪談會清除訪談紀錄、需求與 IF 規則（ERP 資料不受影響）。確定嗎？')) return;
      act(function (cur) { return Store.wb.restartInterview(cur); });
    },
    'resolve-q': function (el) { act(function (cur) { return Store.wb.resolveQuestion(cur, Number(el.dataset.i)); }); },

    // B 確認
    req: function (el) {
      var id = el.dataset.id, op = el.dataset.op;
      if (op === 'edit') {
        var r = reqById(id);
        modal({
          title: '修改 ' + id, ok: '儲存',
          html: '<label>需求內容<textarea id="mReq" rows="3">' + esc(r ? r.text : '') + '</textarea></label><p class="hint">修改會留下紀錄；修改後仍需按「確認」。</p>',
          onOk: function (w) { var res = act(function (cur) { return Store.wb.editReq(cur, id, w.querySelector('#mReq').value); }); return res.ok; }
        });
        return;
      }
      act(function (cur) { return Store.wb.setReqStatus(cur, id, op); });
    },
    evidence: function (el) {
      var r = reqById(el.dataset.id);
      if (!r) return;
      modal({
        title: r.id + '　' + r.text,
        html: '<p><b>來源：</b>' + esc(r.source) + '</p><div class="quote">' + esc(r.evidence) + '</div>' +
          (r.note ? '<p class="small"><b>備註：</b>' + esc(r.note) + '</p>' : '') +
          '<h3 style="margin:12px 0 6px">狀態紀錄</h3><table class="tbl compact"><tbody>' + r.history.map(function (h) {
            return '<tr><td class="nowrap">' + fmtTime(h.at) + '</td><td>' + (h.by === 'AI' ? 'AI' : '人') + '</td><td>' + reqPill(h.to) + '</td><td class="small">' + esc(h.note) + '</td></tr>';
          }).join('') + '</tbody></table>'
      });
    },
    'build-rules': function () {
      var res = act(function (cur) { return Store.wb.buildRules(cur); });
      if (res.ok && ui.route !== 'rules') go('rules');
    },

    // C
    'rule-sel': function (el) { ui.ruleSel = el.dataset.id; render(); },
    'gen-devpack': function () { act(function (cur) { return Store.wb.genDevpack(cur); }); },
    'dev-tab': function (el) { ui.devTab = el.dataset.tab; render(); },
    'dev-copy': function () { copyText(Rules.devpack(db).files[ui.devTab]); },
    'dev-download': function () { download(ui.devTab, Rules.devpack(db).files[ui.devTab]); },

    // D
    'run-tests': function () {
      var results = Tests.runAll();
      act(function (cur) { return Store.wb.recordTestRun(cur, results); });
    },
    export: function () {
      download('aiwb_state_v01_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(db, null, 2), 'application/json;charset=utf-8');
    },

    // ERP
    'erp-user': function (el) { ui.erpUser = el.dataset.id; render(); },
    'clear-search': function () { ui.erpQuery = ''; render(); },
    'add-line': function (el) {
      var sku = el.dataset.sku;
      var input = document.getElementById('qty-' + sku);
      var qty = input ? input.value : '';
      act(function (cur) { return ERP.addLine(cur, ui.erpUser, sku, qty); });
    },
    'remove-line': function (el) { act(function (cur) { return ERP.removeLine(cur, ui.erpUser, el.dataset.id, el.dataset.sku); }); },
    submit: function (el) { act(function (cur) { return ERP.submitOrder(cur, ui.erpUser, el.dataset.id); }); },
    approve: function (el) { act(function (cur) { return ERP.approveOrder(cur, ui.erpUser, el.dataset.id); }); },
    'return': function (el) {
      var id = el.dataset.id;
      modal({
        title: '退回 ' + id, ok: '退回',
        html: '<label>退回原因<input id="mReason" value="數量請再確認"></label><p class="hint">RULE-005：只有待審核（SUBMITTED）的訂單可以退回。</p>',
        onOk: function (w) { act(function (cur) { return ERP.returnOrder(cur, ui.erpUser, id, w.querySelector('#mReason').value); }); }
      });
    }
  };

  var FORMS = {
    project: function (f) {
      act(function (cur) { return Store.wb.updateProject(cur, { name: f.elements.name.value, need: f.elements.need.value, owner: f.elements.owner.value }); });
    },
    chat: function (f) { var v = f.elements.msg.value; if (v.trim()) sendChat(v); },
    search: function (f) {
      ui.erpQuery = f.elements.kw.value.trim();
      act(function (cur) { return ERP.queryStock(cur, ui.erpUser, ui.erpQuery); });
    },
    version: function (f) { act(function (cur) { return Store.wb.saveVersion(cur, f.elements.note.value); }); }
  };

  function onChange(e) {
    var t = e.target;
    if (t.dataset.rule) {
      var id = t.dataset.rule, field = t.dataset.field, v = t.value;
      act(function (cur) { return Store.wb.updateRule(cur, id, field, v); });
    } else if (t.dataset.check) {
      var key = t.dataset.check, on = t.checked;
      act(function (cur) { return Store.wb.setCheck(cur, key, on); }, { silent: true });
    } else if (t.dataset.lineQty) {
      var p = t.dataset.lineQty.split('|');
      var qv = t.value;
      act(function (cur) { return ERP.updateLine(cur, ui.erpUser, p[0], p[1], qv); });
    } else if (t.dataset.cust) {
      var oid = t.dataset.cust, cv = t.value;
      act(function (cur) { return ERP.setCustomer(cur, ui.erpUser, oid, cv); });
    } else if (t.dataset.change === 'add-source') {
      var files = Array.prototype.slice.call(t.files || []);
      files.forEach(function (file) {
        var kind = /\.(xlsx|xls|csv)$/i.test(file.name) ? 'Excel' : /\.(jpg|jpeg|png|pdf)$/i.test(file.name) ? '單據' : '文件';
        act(function (cur) { return Store.wb.addSource(cur, { name: file.name, kind: kind, size: file.size, note: '使用者上傳（只登記檔名與大小）' }); });
      });
    }
  }

  function init() {
    db = Store.load();
    Store.save(db);
    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      var fn = ACTIONS[el.dataset.act];
      if (fn) { e.preventDefault(); fn(el, e); }
    });
    document.addEventListener('submit', function (e) {
      var f = e.target.closest('form[data-form]');
      if (!f) return;
      e.preventDefault();
      if (FORMS[f.dataset.form]) FORMS[f.dataset.form](f);
    });
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal').hidden && App._closeModal) App._closeModal();
    });
    window.addEventListener('hashchange', function () { render(); window.scrollTo(0, 0); });
    // 其他分頁改了資料（例如另一位老闆核准）→ 重新讀取
    window.addEventListener('storage', function (e) {
      if (e.key === Store.KEY) { db = Store.load(); render(); toast('其他分頁更新了資料，已重新讀取', true); }
    });
    render();
  }

  init();

  return {
    render: render,
    state: function () { return db; },
    go: go,
    _closeModal: null
  };
})();
