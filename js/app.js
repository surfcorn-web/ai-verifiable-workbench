/* app.js — 畫面層
 * 全域物件：App
 * 只負責顯示與收集輸入；改資料一律呼叫 ERP.* 或 Store.wb.*（經 Store.transact 執行當下重新讀取最新狀態）。
 * 設計原則：給不懂程式的人用——白話中文、每頁說明「這一頁在做什麼」與「建議下一步」，
 * REQ／RULE／TC 編號只當小字，程式細節收在「技術細節」摺疊區。
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
    { id: 'a', no: '1', nav: '建立專案', title: '建立專案', desc: '說出你的需求' },
    { id: 'interview', no: '2', nav: 'AI 問答', title: 'AI 問答', desc: '回答 AI 的問題' },
    { id: 'confirm', no: '3', nav: '確認需求', title: '確認需求', desc: '由你逐條決定' },
    { id: 'rules', no: '4', nav: '檢查規則', title: '檢查規則', desc: '規則寫完整才能開發' },
    { id: 'devpack', no: '5', nav: '開發包', title: '開發包', desc: '交給 AI 工程師寫程式' },
    { id: 'erp', no: '6', nav: '試用 ERP', title: '試用 ERP', desc: '實際操作看看' },
    { id: 'verify', no: '7', nav: '驗收測試', title: '驗收測試', desc: '自動檢查對不對' },
    { id: 'versions', no: '8', nav: '存成版本', title: '存成版本', desc: '留下紀錄' }
  ];

  var DEMO = [
    { t: '0:00', to: 'a', title: '建立專案', say: '按「幫我填範例」，再按「開始 AI 問答」。' },
    { t: '0:45', to: 'interview', title: 'AI 問答', say: '依序點「建議回答」。第 2 輪 AI 會問：送出就預留，還是核准才預留？' },
    { t: '2:15', to: 'confirm', title: '確認需求', say: '逐條決定。確認「送出就預留」時，「核准才預留」會自動標成已拒絕。' },
    { t: '3:00', to: 'rules', title: '檢查規則', say: '「送出叫貨單時先預留庫存」8 項都完成；「取消已核准訂單」缺 2 項，被擋下。' },
    { t: '4:00', to: 'devpack', title: '開發包', say: '產生開發包，按「複製全部」就能貼給 AI 工程師。' },
    { t: '4:45', to: 'erp', title: '試用 ERP', say: '阿明送 205/55R16 × 2，可用 124 → 122；小芳想送 225/45R17 × 2，可用只有 1，被拒絕；老闆核准，庫存不變。' },
    { t: '6:30', to: 'verify', title: '驗收測試', say: '按一下，13 項自動檢查全部通過；看「從需求追到驗收」。' },
    { t: '7:15', to: 'versions', title: '存成版本', say: '勾完人工檢查項目，存成 v0.1.0。' }
  ];

  var FLOW = ['查詢庫存', '加入叫貨', '送出並預留', '更新可用庫存', '老闆審核'];
  var FLOW_BOSS = 4;

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
  function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
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
    return u ? u.name + '（' + Rules.ROLE[u.role] + '）' : esc(id);
  }
  function orderPill(s) { return '<span class="pill st-' + esc(s) + '">' + esc(Rules.ORDER_STATUS[s] || s) + '</span>'; }
  function reqPill(s) { return '<span class="pill st-' + esc(s) + '">' + esc(Rules.REQ_STATUS[s] || s) + '</span>'; }
  // 可點擊的狀態標籤：點了開啟「修改狀態」選單
  function reqPillBtn(r) {
    return '<button type="button" class="pill pill-btn st-' + esc(r.status) + '" data-act="req-menu" data-id="' + esc(r.id) +
      '" title="點選修改狀態" aria-haspopup="dialog">' + esc(Rules.REQ_STATUS[r.status] || r.status) + ' ▾</button>';
  }
  function priPill(p) { return '<span class="pill pri-' + esc(String(p).replace("'", '')) + '">' + esc(Rules.PRIORITY_LABEL[p] || p) + '</span>'; }
  function reqById(id) { return db.wb.requirements.filter(function (r) { return r.id === id; })[0] || null; }
  function sortedReqs() {
    return db.wb.requirements.slice().sort(function (a, b) { return Rules.REQ_ORDER.indexOf(a.id) - Rules.REQ_ORDER.indexOf(b.id); });
  }
  function ruleTitle(id) {
    var r = db.wb.rules.filter(function (x) { return x.id === id; })[0] || Rules.RULE_TEMPLATES.filter(function (x) { return x.id === id; })[0];
    return r ? r.title : id;
  }
  function head(title, sub, actions) {
    return '<div class="page-head"><div><h1>' + esc(title) + '</h1><p class="sub">' + sub + '</p></div>' +
      (actions ? '<div class="head-actions">' + actions + '</div>' : '') + '</div>';
  }
  function details(summary, body, open) {
    return '<details class="more"' + (open ? ' open' : '') + '><summary>' + summary + '</summary><div class="more-body">' + body + '</div></details>';
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
    var box = $('#toasts');
    while (box.children.length >= 3) box.removeChild(box.firstChild);
    box.appendChild(el);
    setTimeout(function () { el.remove(); }, ok === false ? 7000 : 4000);
  }

  function modal(opts) {
    var wrap = $('#modal');
    var btns = opts.ok
      ? '<button type="button" class="btn ghost" data-m="cancel">取消</button><button type="button" class="btn primary" data-m="ok">' + esc(opts.ok) + '</button>'
      : '<button type="button" class="btn primary" data-m="cancel">關閉</button>';
    wrap.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle"><h2 id="mTitle">' + esc(opts.title) + '</h2>' + opts.html + '<div class="row-actions end">' + btns + '</div></div>';
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
      toast(ok ? '已複製，可以貼給 AI 工程師了' : '複製失敗，請手動選取文字', ok);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast('已複製，可以貼給 AI 工程師了', true); }, fallback);
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
  // 進度與「建議下一步」
  // =====================================================================
  function erpTried() { return db.audit.some(function (a) { return a.action === 'APPROVED' || a.action === 'REJECTED'; }); }

  function navDone(id) {
    var w = db.wb, run = Rules.lastRun(db);
    switch (id) {
      case 'a': return !!w.project.name && !!w.project.need;
      case 'interview': return w.interview.step >= Rules.DONE_STEP;
      case 'confirm': return w.requirements.length > 0 && Rules.buildBlockerItems(w).length === 0;
      case 'rules': return Rules.partition(w).ready.length > 0;
      case 'devpack': return !!w.devpack;
      case 'erp': return erpTried();
      case 'verify': return !!run && run.pass === run.total;
      case 'versions': return w.versions.length > 0;
    }
    return false;
  }

  function nextStep() {
    var w = db.wb;
    if (!w.project.need) return { to: 'a', text: '先寫下一句話需求，再按「開始 AI 問答」。', go: '去寫需求' };
    if (w.interview.step < Rules.DONE_STEP) return { to: 'interview', text: '回答 AI 的問題。不知道怎麼答，就點下面的「建議回答」。', go: '去回答' };
    var bl = Rules.buildBlockerItems(w);
    if (bl.length) return { to: 'confirm', text: '還有 ' + bl.length + ' 條需求要由你決定（確認、延後或拒絕）。', go: '去確認' };
    if (!w.rules.length) return { to: 'confirm', text: '需求都決定好了，按「建立規則」，系統會把需求寫成規則。', go: '去建立規則' };
    var parts = Rules.partition(w);
    if (!parts.ready.length) return { to: 'rules', text: '規則還沒寫完整，補完缺的地方才能開發。', go: '去補規則' };
    if (!w.devpack) return { to: 'devpack', text: '按「產生開發包」，把規則整理成給 AI 工程師的說明書。', go: '去產生' };
    if (!parts.ready.every(Rules.implemented)) return { to: 'devpack', text: '有規則還沒有程式與驗收案例：把開發包交給 AI 工程師去寫。', go: '看開發包' };
    if (!erpTried()) return { to: 'erp', text: '到 ERP 試用一次：先當業務送出叫貨單，再當老闆核准或拒絕。', go: '去試用' };
    var run = Rules.lastRun(db);
    if (!run) return { to: 'verify', text: '按「執行全部驗收測試」，讓系統自動檢查 ERP 有沒有照規則運作。', go: '去驗收' };
    if (run.pass < run.total) return { to: 'verify', text: '有 ' + (run.total - run.pass) + ' 項驗收沒通過，請查看原因。', go: '看結果' };
    if (!w.versions.length) return { to: 'versions', text: '一切順利，存成第一個版本，留下紀錄。', go: '去存版本' };
    return { to: null, text: '需求有變動時，回到「確認需求」修改，再往下重跑一次就好。' };
  }

  function nextBar() {
    var n = nextStep();
    if (!n.to) return '<div class="next-bar done"><span class="nb-ico">✔</span><div><b>這一輪全部完成了</b><p>' + esc(n.text) + '</p></div></div>';
    var here = n.to === ui.route;
    return '<div class="next-bar' + (here ? ' here' : '') + '"><span class="nb-ico">' + (here ? '●' : '→') + '</span><div><b>' + (here ? '你現在在這一步' : '建議下一步') + '</b><p>' + esc(n.text) + '</p></div>' +
      (here ? '' : '<button type="button" class="btn primary" data-act="go" data-to="' + n.to + '">' + esc(n.go) + ' →</button>') + '</div>';
  }

  function stepper() {
    return '<ol class="stepper">' + ROUTES.map(function (r) {
      var d = navDone(r.id);
      return '<li class="' + (d ? 'done' : '') + '" data-act="go" data-to="' + r.id + '"><span class="no">' + (d ? '✔' : r.no) + '</span><b>' + esc(r.nav) + '</b><span>' + esc(r.desc) + '</span></li>';
    }).join('') + '</ol>';
  }

  // =====================================================================
  // 1 建立專案
  // =====================================================================
  function nineSteps() {
    var w = db.wb;
    var parts = Rules.partition(w);
    var run = Rules.lastRun(db);
    var steps = [
      ['建立 ERP 試做專案', '定義問題', !!w.project.name],
      ['輸入初始需求', '定義問題', !!w.project.need],
      ['AI 需求訪談', '拆解難點', w.interview.step >= Rules.DONE_STEP],
      ['人工確認', '人做決定', navDone('confirm')],
      ['IF 閉環規則', '拆解難點', parts.ready.length > 0],
      ['產生開發包', 'AI 提方案／查證', !!w.devpack],
      ['Codex／Claude 開發', '小步建立', parts.ready.length > 0 && parts.ready.every(Rules.implemented)],
      ['ERP 原型預覽', '小步建立', erpTried()],
      ['驗收與追蹤', '形成閉環', !!run && run.pass === run.total && w.versions.length > 0]
    ];
    return '<ol class="steps9">' + steps.map(function (s, i) {
      return '<li class="' + (s[2] ? 'done' : '') + '"><span class="n">' + (i + 1) + '</span><span class="lb">' + esc(s[0]) + '</span><span class="tag">' + esc(s[1]) + '</span><span class="ok">' + (s[2] ? '✔ 完成' : '未完成') + '</span></li>';
    }).join('') + '</ol>' +
      '<div class="grid-2"><div class="note orange"><b>閉環：</b>驗收不通過 → 回到開發修正；發現需求誤解 → 回到訪談與確認；需求變更 → 回到規則更新</div>' +
      '<div class="note"><b>三層：</b>Prompt（問對問題）→ Context（規格、規則、開發包）→ Harness（測試、Git、關卡、人工審查）</div></div>' +
      '<p class="hint">四個工作區：A 專案與需求來源（本頁）、B AI 需求訪談＋確認、C IF 閉環規則＋開發包、D 驗收、追蹤與版本。</p>';
  }

  function pageA() {
    var w = db.wb, p = w.project;
    var srcRows = w.sources.map(function (s) {
      return '<tr><td>' + esc(s.name) + '<div class="small muted">' + esc(s.note) + '</div></td><td>' + esc(s.kind) + '</td><td class="num">' + fmtSize(s.size) + '</td>' +
        '<td><button type="button" class="link" data-act="del-source" data-id="' + esc(s.id) + '">移除</button></td></tr>';
    }).join('');
    return head('1　建立專案', '先告訴系統你想做什麼，<b>一句話就夠</b>。寫好後按「開始 AI 問答」，AI 會一步步問你細節。') +
      '<section class="card"><h2>整個流程只有 8 步，照左邊的順序做就好</h2>' + stepper() + '</section>' +
      '<div class="grid-2">' +
        '<section class="card"><h2>你的專案</h2>' +
          '<form data-form="project">' +
            '<label>專案名稱<input name="name" value="' + esc(p.name) + '" maxlength="60"></label>' +
            '<label>一句話需求<span class="lb-hint">用平常說話的方式寫，例如：「' + esc(Rules.DEFAULT_NEED) + '」</span><textarea name="need" rows="3">' + esc(p.need) + '</textarea></label>' +
            '<label>負責人（選填）<input name="owner" value="' + esc(p.owner) + '" placeholder="例：你的名字"></label>' +
            '<div class="row-actions">' +
              '<button type="button" class="btn ghost" data-act="sample-need">幫我填範例</button>' +
              '<button type="submit" class="btn">儲存</button>' +
              '<button type="button" class="btn primary big" data-act="save-and-interview">開始 AI 問答 →</button>' +
            '</div>' +
          '</form>' +
        '</section>' +
        '<section class="card"><h2>你手邊的資料（選填）</h2>' +
          '<p class="muted">有 Excel 庫存表或手寫單據，可以先放在這裡當作依據。目前只會記錄檔名，不會讀內容。</p>' +
          (srcRows ? '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>檔案</th><th>類型</th><th class="num">大小</th><th></th></tr></thead><tbody>' + srcRows + '</tbody></table></div>' : '<p class="muted">還沒有資料。</p>') +
          '<label class="file-btn">＋ 加入 Excel 或單據<input type="file" data-change="add-source" multiple accept=".xlsx,.xls,.csv,.pdf,.jpg,.jpeg,.png,.txt,.docx"></label>' +
        '</section>' +
      '</div>' +
      details('給教授看：對照簡報的九步與四個工作區', nineSteps());
  }

  // =====================================================================
  // 2 AI 問答
  // =====================================================================
  function reqTag(id) {
    var r = reqById(id);
    return '<span class="pill st-' + (r ? r.status : 'deferred') + '">' + (r ? esc(short(r.text, 16)) + '｜' + esc(Rules.REQ_STATUS[r.status]) : esc(id)) + '</span>';
  }

  function msgHtml(m) {
    return '<div class="msg ' + m.who + '">' + (m.who === 'ai' ? '<span class="who">AI：</span>' : '') + md(m.text) +
      (m.reqs && m.reqs.length ? '<div class="tags">' + m.reqs.map(reqTag).join('') + '</div>' : '') + '</div>';
  }

  function pageInterview() {
    var it = db.wb.interview;
    var chips = Rules.interviewChips(it.step, db.wb);
    var open = it.questions.filter(function (q) { return !q.resolved; }).length;
    var reqs = sortedReqs();
    var done = it.step >= Rules.DONE_STEP;
    var pct = Math.round(Math.min(it.step, Rules.DONE_STEP) / Rules.DONE_STEP * 100);
    // 問答完成後，輸入框與送出按鈕收起來，改成明確的「前往確認需求」；想補充再點連結展開
    var showInput = !done || !!ui.chatMore;
    var inputHtml =
      (chips.length ? '<div class="chips"><span class="muted small">點一下就送出：</span>' + chips.map(function (c, i) {
        return '<button type="button" class="chip" data-act="chip" data-i="' + i + '">' + esc(c) + '</button>';
      }).join('') + '</div>' : '') +
      (done ? '<p class="small muted" style="margin-top:12px">補充說明（選填）：</p>' : '') +
      '<form class="chat-input" data-form="chat"><textarea id="chatMsg" name="msg" rows="2" placeholder="' + (done ? '想補充什麼就寫在這裡…（Enter 換行）' : '也可以自己打字回答…（Enter 換行）') + '" autocomplete="off" aria-label="輸入回答"></textarea><button type="submit" class="btn primary">' + (done ? '送出補充' : '送出') + '</button></form>' +
      '<p class="hint">輸入時按 Enter 可以換行；要送出請按「送出」，或按 Ctrl + Enter。</p>';
    var doneBox = done ?
      '<div class="done-box"><div><b>✔ AI 已經問完了</b><p>我整理出 ' + reqs.length + ' 條需求草稿（在右邊）。請先看一下，再到「確認需求」逐條決定要不要採用。</p></div>' +
        '<button type="button" class="btn primary big" data-act="go" data-to="confirm">前往確認需求 →</button></div>' +
        (ui.chatMore ? '' : '<p class="hint center"><button type="button" class="link" data-act="chat-more">還有想補充的？</button></p>') : '';
    return head('2　AI 問答', done ? 'AI 已經問完了。<b>請看右邊 AI 整理的需求，再到「確認需求」逐條決定。</b>' : 'AI 會一步步問你問題，你照實回答就好。<b>不知道怎麼答，點下面的「建議回答」就能送出。</b>',
        '<button type="button" class="btn ghost sm" data-act="restart-interview">重新問答</button>') +
      '<div class="progress' + (done ? ' done' : '') + '"><div class="bar" style="width:' + pct + '%"></div><span>' + (done ? '✔ 問答完成，下一步：確認需求' : '第 ' + (it.step + 1) + ' 輪，共 ' + Rules.DONE_STEP + ' 輪') + '</span></div>' +
      '<div class="interview">' +
        '<section class="card chat">' +
          '<div class="chat-log" id="chatLog">' +
            (it.messages.length ? it.messages.map(msgHtml).join('') :
              '<div class="chat-empty"><b>AI：</b>您好！請用一句話說說您想解決什麼問題，我會一步步追問細節。</div>') +
          '</div>' +
          doneBox + (showInput ? inputHtml : '') +
          '<p class="hint">這是示範版：AI 的追問是照「ERP 常見難點清單」寫好的，不會連網。AI 只會整理出需求草稿，要不要採用由你決定。</p>' +
        '</section>' +
        '<aside class="card">' +
          '<h2>AI 整理出的需求（草稿）</h2>' +
          (done ? '<div class="note blue small" style="margin-bottom:12px">這些是 AI 的草稿，<b>還不算數</b>。下一步由你決定要確認、延後或拒絕。</div>' : '') +
          (reqs.length ? '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>編號</th><th>需求</th><th>狀態</th></tr></thead><tbody>' +
            reqs.map(function (r) { return '<tr><td class="nowrap idtag">' + esc(r.id) + '</td><td>' + esc(r.text) + '</td><td>' + reqPillBtn(r) + '</td></tr>'; }).join('') +
            '</tbody></table></div><p class="hint">點「狀態」可以直接修改：確認、採納、延後、拒絕或撤回。</p>' : '<p class="muted">開始回答後，AI 會把整理出的需求列在這裡。</p>') +
          '<h3>還有疑問' + (open ? ' <span class="count-badge">' + open + '</span>' : '') + '</h3>' +
          (it.questions.length ? '<ul class="qs">' + it.questions.map(function (q, i) {
            return '<li class="' + (q.resolved ? 'done' : '') + '">' + esc(q.text) + (q.resolved ? '' : ' <button type="button" class="link" data-act="resolve-q" data-i="' + i + '">已釐清</button>') + '</li>';
          }).join('') + '</ul>' : '<p class="muted small">目前沒有。</p>') +
          '<button type="button" class="btn primary block" data-act="go" data-to="confirm"' + (reqs.length ? '' : ' disabled') + '>前往確認需求 →</button>' +
        '</aside>' +
      '</div>';
  }

  // =====================================================================
  // 3 確認需求
  // =====================================================================
  function reqOps(r) {
    var b = function (action, label, cls) {
      return '<button type="button" class="btn sm ' + (cls || '') + '" data-act="req" data-op="' + action + '" data-id="' + esc(r.id) + '">' + label + '</button>';
    };
    if (r.status === 'pending') return b('confirm', '確認', 'primary') + b('edit', '改文字') + b('reject', '拒絕', 'danger');
    if (r.status === 'ai') return b('adopt', '採納', 'primary') + b('defer', '延後') + b('reject', '拒絕', 'danger');
    return '<button type="button" class="link" data-act="req" data-op="revert" data-id="' + esc(r.id) + '">撤回，重新決定</button>';
  }

  function pageConfirm() {
    var reqs = sortedReqs();
    if (!reqs.length) {
      return head('3　確認需求', 'AI 只能提議，最後由你決定。') +
        '<section class="card empty">還沒有需求草稿。<br><button type="button" class="btn primary" data-act="go" data-to="interview">先去回答 AI 的問題</button></section>';
    }
    var n = function (st) { return reqs.filter(function (r) { return st.indexOf(r.status) >= 0; }).length; };
    var blockers = Rules.buildBlockerItems(db.wb);
    var rows = reqs.map(function (r) {
      return '<tr class="' + (r.status === 'rejected' || r.status === 'deferred' ? 'dim' : '') + '">' +
        '<td class="nowrap idtag">' + esc(r.id) + '</td>' +
        '<td class="req-text">' + esc(r.text) + (r.edited ? ' <span class="pill blue">已修改</span>' : '') + (r.note ? '<small>' + esc(r.note) + '</small>' : '') + '</td>' +
        '<td><button type="button" class="link" data-act="evidence" data-id="' + esc(r.id) + '">看依據</button><div class="small muted">' + esc(r.source) + '</div></td>' +
        '<td>' + priPill(r.priority) + '</td>' +
        '<td>' + reqPill(r.status) + '</td>' +
        '<td><div class="ops">' + reqOps(r) + '</div></td></tr>';
    }).join('');
    var g1 = reqById('REQ-004B'), g2 = reqById('REQ-004');
    var pick = g1 && g2 && g1.status !== 'confirmed' && g2.status !== 'confirmed';
    return head('3　確認需求', 'AI 只能提議，<b>最後由你決定</b>。每一條選「確認」「延後」或「拒絕」；AI 建議的需求用「採納」。',
        '<button type="button" class="btn primary big" data-act="build-rules"' + (blockers.length ? ' disabled title="還有需求沒決定"' : '') + '>需求都決定了 → 建立規則</button>') +
      '<section class="card">' +
        '<div class="counters">' +
          '<span class="pill teal">已確認 ' + n(['confirmed']) + '</span>' +
          '<span class="pill orange">待你確認 ' + n(['pending']) + '</span>' +
          '<span class="pill purple">AI 建議 ' + n(['ai']) + '</span>' +
          '<span class="pill">已拒絕或延後 ' + n(['rejected', 'deferred']) + '</span>' +
        '</div>' +
        (pick ? '<div class="note blue mt"><b>有一題要你二選一：</b>庫存什麼時候預留？<br>「業務送出叫貨單時就預留」（避免其他業務搶走）或「老闆核准時才預留」。確認其中一條，另一條會自動標成已拒絕。</div>' : '') +
        '<div class="tbl-wrap mt"><table class="tbl"><thead><tr><th>編號</th><th>需求</th><th>依據</th><th>重要性</th><th>狀態</th><th>你要做的事</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (blockers.length ?
          '<div class="note orange mt"><b>還差 ' + blockers.length + ' 條沒決定，才能建立規則：</b><ul class="plain-list">' + blockers.map(function (b) {
            return '<li>' + (b.id ? '<span class="idtag">' + esc(b.id) + '</span> ' : '') + esc(short(b.text, 40)) + '<span class="muted">（' + esc(b.why) + '）</span></li>';
          }).join('') + '</ul></div>' :
          '<div class="note teal mt">必要的需求都決定好了，可以按右上角「建立規則」。</div>') +
      '</section>';
  }

  // =====================================================================
  // 4 檢查規則
  // =====================================================================
  function caseList(ids) {
    if (!ids || !ids.length) return '<span class="miss-text">（還沒有驗收案例）</span>';
    var run = Rules.lastRun(db);
    return '<ul class="cases">' + ids.map(function (id) {
      var tc = Tests.byId(id);
      var r = run && run.results.filter(function (x) { return x.id === id; })[0];
      var badge = !tc ? '<span class="pill purple">還沒寫成自動測試</span>' : !r ? '<span class="pill">還沒執行</span>' : r.pass ? '<span class="pill teal">通過</span>' : '<span class="pill fail">沒通過</span>';
      return '<li>' + badge + ' ' + (tc ? esc(tc.title) : '<span class="muted">' + esc(id) + '</span>') + '</li>';
    }).join('') + '</ul>';
  }

  function fieldRow(rule, key, label, optional) {
    var parts = key.split('.');
    var v = parts.length === 1 ? rule[key] : (rule[parts[0]] || {})[parts[1]];
    var miss = !optional && !String(v || '').trim();
    var id = 'f-' + rule.id + '-' + key.replace('.', '-');
    return '<div class="frow' + (miss ? ' miss' : '') + '"><label for="' + id + '">' + label + '</label>' +
      '<textarea id="' + id + '" rows="2" data-rule="' + esc(rule.id) + '" data-field="' + key + '" placeholder="' + (miss ? '（還沒寫，必填）' : '') + '">' + esc(v || '') + '</textarea></div>';
  }

  function branchCard(rule, b) {
    var p = b + '.';
    var yes = b === 't';
    return '<div class="branch ' + (yes ? 'yes' : 'no') + '"><h3>' + (yes ? '✔ 條件成立時' : '✘ 條件不成立時') + '</h3>' +
      fieldRow(rule, p + 'action', '做什麼') +
      fieldRow(rule, p + 'effect', '資料會怎麼變') +
      fieldRow(rule, p + 'message', '畫面顯示') +
      fieldRow(rule, p + 'audit', '系統留下的紀錄') +
      '<div class="frow"><label>驗收案例</label><div>' + caseList(rule[b].tests) + '</div></div>' +
      fieldRow(rule, p + 'final', '訂單最後狀態') +
    '</div>';
  }

  function referenceCards() {
    var diff = Rules.DIFFICULTIES.map(function (d) {
      var cls = d.v1 === '做' ? 'teal' : d.v1 === '部分' ? 'orange' : '';
      return '<tr><td>' + esc(d.name) + '</td><td><span class="pill ' + cls + '">' + (d.v1 === '做' ? '第一版做' : d.v1 === '部分' ? '做一部分' : '以後再做') + '</span></td><td class="small">' + esc(d.ask) + '</td></tr>';
    }).join('');
    var sm = Rules.STATE_MACHINE.map(function (t) {
      return '<tr class="' + (t.v1 ? '' : 'dim') + '"><td class="nowrap">' + orderPill(t.from) + ' → ' + orderPill(t.to) + '</td><td class="small">' + esc(t.cond) + '</td><td>' + (t.v1 ? '<span class="pill teal">第一版</span>' : '<span class="pill">以後再做</span>') + '</td></tr>';
    }).join('');
    return '<div class="grid-2">' +
      '<div><h3>ERP 常見的 9 個難點（AI 會問的問題）</h3><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>難點</th><th>第一版</th><th>AI 會問</th></tr></thead><tbody>' + diff + '</tbody></table></div></div>' +
      '<div><h3>訂單會經過哪些狀態</h3><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>狀態變化</th><th>什麼時候</th><th></th></tr></thead><tbody>' + sm + '</tbody></table></div></div>' +
    '</div>';
  }

  function pageRules() {
    var rules = db.wb.rules;
    var h = head('4　檢查規則', '規則就是把需求寫成「<b>如果…就…，否則…</b>」，再附上驗收案例。<b>8 項都寫完整，才能交給 AI 工程師開發。</b>');
    if (!rules.length) {
      return h + '<section class="card empty">還沒有規則。請先到「確認需求」決定好所有必要的需求，再按「建立規則」。<br><button type="button" class="btn primary" data-act="go" data-to="confirm">前往確認需求</button></section>' +
        details('參考資料：ERP 常見難點與訂單狀態', referenceCards());
    }
    var sel = rules.filter(function (r) { return r.id === ui.ruleSel; })[0] || rules.filter(function (r) { return r.id === 'RULE-003'; })[0] || rules[0];
    ui.ruleSel = sel.id;
    var ck = Rules.check(sel);
    var okAll = ck.complete && !sel.orphan;

    var listHtml = rules.map(function (r) {
      var c = Rules.check(r);
      var good = c.complete && !r.orphan;
      return '<button type="button" class="rule-item ' + (r.id === sel.id ? 'on ' : '') + (good ? 'ok' : 'bad') + '" data-act="rule-sel" data-id="' + esc(r.id) + '">' +
        '<span class="ri-mark">' + (good ? '✔' : '✘') + '</span><span class="ri-body"><b>' + esc(r.title) + '</b>' +
        '<small>' + (r.orphan ? '對應的需求還沒確認' : good ? '寫完整了，可以開發' : '還缺 ' + c.missing.length + ' 項') + '</small></span></button>';
    }).join('');

    var detail = '<section class="card rule-detail">' +
      '<div class="rule-top"><input class="title-in" data-rule="' + esc(sel.id) + '" data-field="title" value="' + esc(sel.title) + '" aria-label="規則名稱"><span class="idtag">' + esc(sel.id) + '</span></div>' +
      '<div class="gate ' + (okAll ? 'ok' : 'bad') + '">' + (okAll ?
        '<b>✔ 這條規則寫完整了，可以交給 AI 工程師開發</b>' :
        '<b>✘ 先不能開發</b><span>' + (sel.orphan ? '它對應的需求還沒確認。' : '還缺 ' + ck.missing.length + ' 項：' + esc(ck.missing.join('、')) + '。') + '</span>') + '</div>' +
      '<ul class="check-chips" aria-label="8 項檢查">' + ck.items.map(function (i) {
        return '<li class="' + (i.ok ? 'ok' : 'no') + '" title="' + esc(i.label) + '">' + (i.ok ? '✔' : '✘') + ' ' + esc(i.short) + '</li>';
      }).join('') + '</ul>' +
      (sel.note ? '<div class="note purple" style="margin-bottom:14px">' + esc(sel.note) + '</div>' : '') +
      '<div class="cond-box"><b>如果（條件）</b>' +
        '<textarea rows="2" data-rule="' + esc(sel.id) + '" data-field="if" class="' + (sel.if ? '' : 'miss') + '" aria-label="條件" placeholder="（還沒寫，必填）">' + esc(sel.if) + '</textarea></div>' +
      '<div class="branches">' + branchCard(sel, 't') + branchCard(sel, 'f') + '</div>' +
      '<div class="edge-box">' + fieldRow(sel, 'edge.text', '特殊情況（選填）', true) +
        (sel.edge.tests.length ? '<div class="frow"><label>特殊情況的驗收案例</label><div>' + caseList(sel.edge.tests) + '</div></div>' : '') + '</div>' +
      details('技術細節（給工程師看，不用讀懂）',
        '<p class="small">對應需求：' + esc(sel.reqs.join('、')) + '　｜　版本：' + esc(sel.version) + '　｜　ERP 難點：' + esc(sel.difficulty) + '</p>' +
        '<p class="small">程式對應：' + (sel.code.length ? sel.code.map(function (c) { return '<code>' + esc(c) + '</code>'; }).join('、') : '（還沒有程式）') + '</p>' +
        '<p class="small muted">驗收案例編號（用逗號分隔，離開輸入框就儲存）：</p>' +
        '<div class="grid-3">' +
          '<label>成立時<input data-rule="' + esc(sel.id) + '" data-field="t.tests" value="' + esc(sel.t.tests.join(', ')) + '"></label>' +
          '<label>不成立時<input data-rule="' + esc(sel.id) + '" data-field="f.tests" value="' + esc(sel.f.tests.join(', ')) + '"></label>' +
          '<label>特殊情況<input data-rule="' + esc(sel.id) + '" data-field="edge.tests" value="' + esc(sel.edge.tests.join(', ')) + '"></label>' +
        '</div>') +
    '</section>';

    var upd = '<div class="row-actions mt"><button type="button" class="btn ghost" data-act="build-rules">依最新的需求更新規則</button><button type="button" class="btn primary" data-act="go" data-to="devpack">下一步：產生開發包 →</button></div>';

    return h + '<div class="rule-layout"><aside class="rule-list card"><h2>全部規則（' + rules.length + '）</h2>' + listHtml + '</aside><div>' + detail + upd + '</div></div>' +
      details('參考資料：ERP 常見難點與訂單狀態', referenceCards());
  }

  // =====================================================================
  // 5 開發包
  // =====================================================================
  var DEV_NAMES = { 'SPEC.md': '需求規格', 'TASKS.md': '工作清單', 'TESTS.md': '驗收清單', 'AGENT_PROMPT.md': '給 AI 的指令' };

  function pageDevpack() {
    var h = head('5　開發包', '開發包是給 AI 工程師（Claude Code、Codex）的「<b>工作說明書</b>」。你不用看懂內容，按「複製全部」貼給它就可以了。');
    if (!db.wb.rules.length) {
      return h + '<section class="card empty">還沒有規則，無法產生開發包。<br><button type="button" class="btn primary" data-act="go" data-to="rules">前往檢查規則</button></section>';
    }
    var pack = Rules.devpack(db);
    var dp = db.wb.devpack;
    var stale = dp && dp.ready.join(',') !== pack.ready.join(',');
    var names = Object.keys(pack.files);
    if (names.indexOf(ui.devTab) < 0) ui.devTab = names[0];
    var parts = Rules.partition(db.wb);
    return h +
      '<section class="card">' +
        '<div class="row-actions">' +
          '<button type="button" class="btn primary big" data-act="gen-devpack"' + (pack.ready.length ? '' : ' disabled') + '>' + (dp ? '重新產生開發包' : '產生開發包') + '</button>' +
          (dp ? '<button type="button" class="btn big" data-act="dev-copy-all">複製全部（貼給 AI 工程師）</button><button type="button" class="btn ghost" data-act="dev-download-all">下載全部</button>' : '') +
        '</div>' +
        '<p class="hint">' + (dp ? '最近產生：' + fmtTime(dp.at) + '（版本 ' + esc(dp.version) + '）' : '還沒產生。按上面的按鈕，系統會把「寫完整的規則」整理成說明書。') + '</p>' +
        (stale ? '<div class="note orange mt">規則在上次產生後有變動，請再按一次「重新產生開發包」。</div>' : '') +
      '</section>' +
      '<div class="grid-2">' +
        '<section class="card"><h2>這次會交給 AI 工程師做的規則 <span class="pill teal">' + parts.ready.length + '</span></h2>' +
          (parts.ready.length ? '<ul class="plain-list ok">' + parts.ready.map(function (r) { return '<li>✔ ' + esc(r.title) + '</li>'; }).join('') + '</ul>' : '<p class="muted">還沒有寫完整的規則。</p>') + '</section>' +
        '<section class="card"><h2>先不做的規則 <span class="pill orange">' + parts.blocked.length + '</span></h2>' +
          (parts.blocked.length ? '<ul class="plain-list no">' + parts.blocked.map(function (b) {
            return '<li>✘ ' + esc(b.rule.title) + '<span class="muted">（' + (b.rule.orphan ? '對應的需求還沒確認' : '還缺：' + esc(b.check.missing.join('、'))) + '）</span></li>';
          }).join('') + '</ul>' : '<p class="muted">沒有。</p>') + '</section>' +
      '</div>' +
      details('預覽開發包內容（給 AI 看的，不用讀懂）',
        '<div class="tabs" role="tablist">' + names.map(function (n) {
          return '<button type="button" role="tab" class="tab ' + (n === ui.devTab ? 'on' : '') + '" data-act="dev-tab" data-tab="' + esc(n) + '">' + esc(DEV_NAMES[n] || n) + '</button>';
        }).join('') + '</div>' +
        '<pre class="code">' + esc(pack.files[ui.devTab]) + '</pre>' +
        '<div class="row-actions mt"><button type="button" class="btn sm" data-act="dev-copy">只複製這一份</button><button type="button" class="btn sm ghost" data-act="dev-download">只下載這一份（' + esc(ui.devTab) + '）</button></div>');
  }

  function allDevText() {
    var f = Rules.devpack(db).files;
    return Object.keys(f).map(function (k) { return '<!-- ===== ' + k + ' ===== -->\n\n' + f[k]; }).join('\n\n---\n\n');
  }

  // =====================================================================
  // 6 試用 ERP
  // =====================================================================
  function flowHot() {
    var a = last(db.audit);
    if (!a) return [];
    switch (a.action) {
      case 'QUERY': return [0];
      case 'ADD_LINE': case 'UPDATE_LINE': case 'REMOVE_LINE': return [1];
      case 'SUBMITTED': return [2, 3];
      case 'SUBMIT_DENIED': return [2];
      case 'APPROVED': case 'REJECTED': case 'RETURNED': return [4];
      default: return [];
    }
  }

  function linesTable(o, editable) {
    return '<table class="lines">' + o.lines.map(function (l) {
      var av = ERP.view.availableOf(db, l.sku);
      var lack = editable && av < l.qty;
      return '<tr><td>' + esc(ERP.view.label(db, l.sku)) +
        (editable ? '<div class="small ' + (lack ? 'lack' : 'muted') + '">目前可用 ' + av + (lack ? '，不夠，送出會被拒絕' : '') + '</div>' : '') + '</td>' +
        '<td class="right nowrap">' +
        (editable ? '× <input class="qty" data-line-qty="' + esc(o.id + '|' + l.sku) + '" value="' + esc(l.qty) + '" inputmode="numeric" aria-label="數量"> <button type="button" class="link" data-act="remove-line" data-id="' + esc(o.id) + '" data-sku="' + esc(l.sku) + '">移除</button>'
          : '× ' + l.qty) + '</td></tr>';
    }).join('') + '</table>';
  }

  function orderCard(o, opts) {
    var lastH = last(o.history);
    return '<div class="order"><div class="order-h"><b class="mono">' + esc(o.id) + '</b>' + orderPill(o.status) +
      '<span class="small muted">' + esc(o.customer || '（未填客戶）') + '｜' + userName(o.created_by) + '｜' + fmtTime(lastH ? lastH.at : o.created_at) + '</span></div>' +
      ((opts && opts.body) || linesTable(o, false)) +
      (o.status === 'RETURNED' && o.return_reason ? '<div class="why">退回原因：' + esc(o.return_reason) + '</div>' : '') +
      (o.status === 'REJECTED' && lastH ? '<div class="why">' + esc(lastH.note) + '</div>' : '') +
      ((opts && opts.actions) ? '<div class="row-actions mt">' + opts.actions + '</div>' : '') + '</div>';
  }

  function pageERP() {
    var u = ERP.view.user(db, ui.erpUser) || db.users[0];
    ui.erpUser = u.id;
    var boss = Rules.isBoss(u);
    var q = ERP.queryStock(db, u.id, ui.erpQuery); // 只取查詢結果來顯示；狀態不存（按「查詢」才寫紀錄）
    var rows = q.data || [];
    var hot = flowHot();
    var inv = ERP.view.invariants(db);

    var roles = '<div class="roles"><span class="muted small">你現在扮演：</span>' + db.users.map(function (x) {
      return '<button type="button" class="role ' + (x.id === u.id ? 'on' : '') + '" data-act="erp-user" data-id="' + esc(x.id) + '">' + esc(x.name) + '（' + Rules.ROLE[x.role] + '）</button>';
    }).join('') + '</div>' +
      '<p class="role-note">' + (boss ? '老闆：看得到成本與毛利，負責審核叫貨單。' : '業務：看不到成本，可以查庫存、叫貨、送出。') + '</p>';

    var flow = '<div class="flow">' + FLOW.map(function (f, i) {
      return (i ? '<span class="ar">›</span>' : '') + '<span class="st' + (i === FLOW_BOSS ? ' boss' : '') + (hot.indexOf(i) >= 0 ? ' hot' : '') + '">' + f + '</span>';
    }).join('') + '</div>';

    var tryit = details('不知道怎麼玩？照這個劇本試試看',
      '<ol class="tryit">' +
        '<li>選「阿明（業務）」，查 <b>205/55R16</b>，數量填 2，按「加入叫貨」，再按右邊的「送出叫貨單」。<span class="muted">→ 可用庫存會從 124 變成 122，因為送出就預留了。</span></li>' +
        '<li>選「小芳（業務）」，找 <b>225/45R17</b>（可用只有 1），叫 2 條並送出。<span class="muted">→ 被拒絕，因為庫存不夠。</span></li>' +
        '<li>選「王老闆（老闆）」，在右邊「待審核」按「核准」。<span class="muted">→ 庫存不變，因為預留早就建好了。</span></li>' +
        '<li>想試「退回」或「拒絕」？它們會把預留的庫存還回去，可用數量會變多。</li>' +
        '<li>想看「兩位業務同時搶最後 1 條」？開兩個瀏覽器分頁，各扮演一位業務，同時送出 225/45R17 × 1，只有 1 人會成功。</li>' +
      '</ol>', !db.audit.length);

    var stockRows = rows.map(function (r) {
      var zero = r.available <= 0;
      return '<tr><td class="nowrap"><b>' + esc(r.spec) + '</b></td><td>' + esc(r.brand) + '<br><span class="small muted">' + esc(r.name) + '</span></td><td class="num">' + esc(r.year) + '</td>' +
        '<td class="num">' + r.on_hand + '</td><td class="num">' + r.reserved + '</td><td class="num"><b class="' + (zero ? 'zero' : '') + '">' + r.available + '</b></td>' +
        '<td class="num">' + fmtNum(r.price) + '</td>' +
        (boss ? '<td class="num">' + fmtNum(r.cost) + '</td><td class="num">' + fmtNum(r.margin) + '</td>' :
          '<td class="nowrap"><input class="qty" id="qty-' + esc(r.sku) + '" value="1" inputmode="numeric" aria-label="' + esc(r.spec) + ' 叫貨數量"> <button type="button" class="btn sm primary" data-act="add-line" data-sku="' + esc(r.sku) + '">加入叫貨</button></td>') +
        '</tr>';
    }).join('');

    var stock = '<section class="card"><h2>查庫存 <span class="muted small">（' + (boss ? '老闆看得到成本' : '業務看不到成本') + '）</span></h2>' +
      '<form class="search" data-form="search"><input type="search" name="kw" value="' + esc(ui.erpQuery) + '" placeholder="輸入規格或品牌，例如 205/55R16" aria-label="查詢關鍵字"><button type="submit" class="btn primary">查詢</button>' +
      (ui.erpQuery ? '<button type="button" class="btn ghost" data-act="clear-search">看全部</button>' : '') + '</form>' +
      '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>規格</th><th>品牌／型號</th><th class="num">年份</th>' +
      '<th class="num" title="倉庫裡實際有幾條">在庫</th><th class="num" title="已被待審核或已核准的訂單佔用">預留</th><th class="num" title="在庫 − 預留，還能賣的數量">可用</th><th class="num">售價</th>' +
      (boss ? '<th class="num">成本</th><th class="num">毛利</th>' : '<th>叫貨數量</th>') + '</tr></thead><tbody>' +
      (stockRows || '<tr><td colspan="9" class="muted">查無資料</td></tr>') + '</tbody></table></div>' +
      '<p class="hint"><b>可用 ＝ 在庫 － 預留。</b>業務一送出叫貨單，數量就會先預留，其他業務看到的「可用」會馬上變少，不會搶到同一批庫存。</p>' +
      (boss ? '' : '<p class="hint">想試試看？數量填 0、-1 或 1.5 再按「加入叫貨」，系統會擋下來。</p>') +
      details('技術細節：這次查詢回傳的欄位', '<p class="small"><code>' + esc(rows.length ? Object.keys(rows[0]).join(', ') : Rules.SALES_FIELDS.join(', ')) + '</code>' + (boss ? '' : '（沒有 cost，業務拿不到成本）') + '</p>') +
    '</section>';

    var right;
    if (boss) {
      var pend = ERP.view.pending(db, u.id);
      var pendHtml = pend.map(function (o) {
        var body = '<table class="lines">' + o.lines.map(function (l) {
          return '<tr><td>' + esc(l.label) + '</td><td class="right nowrap">× ' + l.qty + ' <span class="pill teal">已預留</span></td></tr>';
        }).join('') + '</table>';
        return orderCard(o, {
          body: body,
          actions: '<button type="button" class="btn sm primary" data-act="approve" data-id="' + esc(o.id) + '">核准</button>' +
            '<button type="button" class="btn sm" data-act="return" data-id="' + esc(o.id) + '">退回，請業務修改</button>' +
            '<button type="button" class="btn sm danger" data-act="reject-order" data-id="' + esc(o.id) + '">拒絕</button>'
        });
      }).join('');
      var all = ERP.view.orders(db, u.id).map(function (o) {
        return '<tr><td class="mono">' + esc(o.id) + '</td><td>' + userName(o.created_by) + '</td><td>' + esc(o.customer || '—') + '</td>' +
          '<td class="small">' + o.lines.map(function (l) { return esc(ERP.view.spec(db, l.sku)) + ' × ' + l.qty; }).join('、') + '</td>' +
          '<td>' + orderPill(o.status) + '</td><td>' + (o.status === 'SUBMITTED' ? '' : '<button type="button" class="link" data-act="return" data-id="' + esc(o.id) + '" title="試試看：不是待審核的訂單不能退回">試著退回</button>') + '</td></tr>';
      }).join('');
      right = '<section class="card"><h2>待審核的叫貨單 <span class="pill orange">' + pend.length + '</span></h2>' +
          (pendHtml || '<p class="muted">目前沒有待審核的叫貨單。請先切到業務送出一張。</p>') +
          '<p class="hint">這些單子的庫存都已經預留好了。「核准」只改狀態；「退回」和「拒絕」會把預留的庫存還回去。</p>' +
        '</section>' +
        '<section class="card"><h2>全部訂單</h2><div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>單號</th><th>業務</th><th>客戶</th><th>品項</th><th>狀態</th><th></th></tr></thead><tbody>' +
          (all || '<tr><td colspan="6" class="muted">還沒有訂單</td></tr>') + '</tbody></table></div></section>';
    } else {
      var d = ERP.view.draft(db, u.id);
      var cart = d ? orderCard(d, {
        body: '<label class="small">客戶<input data-cust="' + esc(d.id) + '" value="' + esc(d.customer) + '" placeholder="客戶名稱（選填）"></label>' + linesTable(d, true),
        actions: '<button type="button" class="btn primary" data-act="submit" data-id="' + esc(d.id) + '"' + (d.lines.length ? '' : ' disabled') + '>送出叫貨單（會先預留庫存）</button>'
      }) : '<p class="muted">購物車是空的。在左邊輸入數量，按「加入叫貨」。</p>';
      var mine = ERP.view.orders(db, u.id).map(function (o) {
        if (o.status === 'RETURNED') {
          return orderCard(o, { body: linesTable(o, true), actions: '<button type="button" class="btn sm primary" data-act="submit" data-id="' + esc(o.id) + '">修改後重新送出</button>' });
        }
        return orderCard(o);
      }).join('');
      right = '<section class="card"><h2>我的購物車</h2>' + cart + '<p class="hint">加入購物車還不會預留；按「送出」的那一刻，系統會重新檢查庫存，夠的話就先替你預留。</p></section>' +
        '<section class="card"><h2>我送出的訂單</h2>' + (mine || '<p class="muted">還沒有送出的訂單。</p>') + '</section>';
    }

    var audits = db.audit.slice(-15).reverse().map(function (a) {
      return '<tr><td class="nowrap">' + fmtTime(a.at) + '</td><td class="nowrap">' + esc(a.actor_name) + '</td><td class="nowrap">' + esc(Rules.ACTION_LABEL[a.action] || a.action) + '</td>' +
        '<td>' + (a.ok ? '<span class="inv-ok">✔</span>' : '<span class="inv-bad">✘</span>') + ' ' + esc(a.message) + '</td></tr>';
    }).join('');

    return head('6　試用 ERP（輪胎批發）', '扮演業務下單、扮演老闆審核，看看庫存怎麼變。', '') + roles + flow + tryit +
      '<div class="erp-grid"><div>' + stock + '</div><div>' + right + '</div></div>' +
      '<section class="card"><h2>操作紀錄 <span class="muted small">（最近 15 筆，共 ' + db.audit.length + ' 筆；每個動作都會留下紀錄，被擋下的也會）</span></h2>' +
        '<p class="small ' + (inv.length ? 'inv-bad' : 'inv-ok') + '">' + (inv.length ? '✘ 庫存對不起來：' + esc(inv.join('；')) : '✔ 庫存檢查正常：每個品項的預留數量，剛好等於待審核與已核准訂單的數量加總') + '</p>' +
        (audits ? '<div class="tbl-wrap"><table class="tbl compact audit-log"><thead><tr><th>時間</th><th>誰</th><th>做了什麼</th><th>結果</th></tr></thead><tbody>' + audits + '</tbody></table></div>' : '<p class="muted">還沒有紀錄。</p>') +
      '</section>';
  }

  // =====================================================================
  // 7 驗收測試
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
      return '<tr><td><b>' + esc(c.title) + '</b><div class="small muted">屬於：' + esc(ruleTitle(c.rule)) + '</div></td>' +
        '<td class="small">' + esc(c.given) + '</td>' +
        '<td class="small">' + esc(c.expect) + (r ? '<div class="muted">實際：' + esc(r.actual) + '</div>' : '') + '</td>' +
        '<td>' + (r ? '<span class="res ' + (r.pass ? 'pass' : 'fail') + '">' + (r.pass ? '通過' : '沒通過') + '</span>' : '<span class="muted">還沒執行</span>') + '</td></tr>';
    }).join('');

    var traceRows = reqs.map(function (q) {
      var rules = db.wb.rules.filter(function (r) { return r.reqs.indexOf(q.id) >= 0; });
      var ver = db.wb.versions.filter(function (v) {
        return v.reqs.some(function (x) { return x.id === q.id && x.status === 'confirmed'; }) &&
          (!rules.length || v.rules.some(function (x) { return x.complete && rules.some(function (r) { return r.id === x.id; }); }));
      })[0];
      var ruleCell = rules.length ? rules.map(function (r) {
        var c = Rules.check(r);
        var good = c.complete && !r.orphan;
        return '<div><span class="pill ' + (good ? 'teal' : 'orange') + '">' + (good ? '✔ ' : '✘ ') + esc(short(r.title, 18)) + '</span></div>';
      }).join('') : '<span class="muted">—</span>';
      var tests = [];
      rules.forEach(function (r) { Rules.testIds(r).forEach(function (t) { if (tests.indexOf(t) < 0) tests.push(t); }); });
      return '<tr class="' + (q.status === 'confirmed' ? '' : 'dim') + '"><td><b>' + esc(short(q.text, 30)) + '</b><div class="small"><span class="idtag">' + esc(q.id) + '</span> ' + reqPill(q.status) + '</div></td>' +
        '<td>' + ruleCell + '</td>' +
        '<td>' + (tests.length ? tests.map(function (t) {
          var tc = Tests.byId(t), r = res[t];
          return '<div class="small">' + (!tc ? '<span class="pill purple">還沒寫成測試</span>' : !r ? '<span class="pill">還沒執行</span>' : r.pass ? '<span class="pill teal">通過</span>' : '<span class="pill fail">沒通過</span>') + ' ' + esc(tc ? short(tc.title, 22) : t) + '</div>';
        }).join('') : '<span class="muted">—</span>') + '</td>' +
        '<td class="mono">' + (ver ? esc(ver.id) : '<span class="muted">—</span>') + '</td></tr>';
    }).join('');

    var rrbRows = Rules.RRB.map(function (x) {
      var hit = x.reqs.filter(function (id) { return !!reqById(id); });
      return '<tr><td>' + esc(x.name) + (x.v1 ? ' <span class="pill blue">第一版涉及</span>' : '') + '</td><td>' +
        (hit.length ? '<span class="pill teal">AI 有找到</span>' : '<span class="pill fail">AI 沒找到</span>') + '</td><td class="small">' +
        (x.ref ? '<span class="pill teal">有</span> ' + esc(x.ref) : '<span class="pill">沒看到</span>') + '</td></tr>';
    }).join('');
    var refSeen = Rules.RRB.filter(function (x) { return !!x.ref; }).length;

    return head('7　驗收測試', '按一下按鈕，系統會自動做 ' + Tests.cases.length + ' 項檢查，看 ERP 有沒有照規則運作。',
        '<button type="button" class="btn primary big" data-act="run-tests">執行全部驗收測試</button>') +
      '<div class="kpis">' +
        '<div class="kpi ' + (run ? (allPass ? 'good' : 'warn') : '') + '"><div class="v">' + (run ? run.pass : '—') + '／' + Tests.cases.length + '</div><div class="l">驗收案例通過' + (run ? '（' + fmtTime(run.at) + '）' : '（還沒執行）') + '</div></div>' +
        '<div class="kpi ' + (parts.ready.length ? 'good' : '') + '"><div class="v">' + parts.ready.length + '／' + db.wb.rules.length + '</div><div class="l">規則寫完整，可以開發</div></div>' +
        '<div class="kpi"><div class="v">' + confirmed + '／' + reqs.length + '</div><div class="l">需求已確認</div></div>' +
        '<div class="kpi"><div class="v">' + found + '／' + Rules.RRB.length + '</div><div class="l">AI 找到的參考需求（示意）</div></div>' +
      '</div>' +
      '<section class="card"><h2>驗收案例 ' + (run ? '<span class="pill ' + (allPass ? 'teal' : 'fail') + '">' + (allPass ? '全部通過' : (run.total - run.pass) + ' 項沒通過') + '</span>' : '') + '</h2>' +
        '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>檢查什麼</th><th>怎麼測</th><th>應該要看到</th><th>結果</th></tr></thead><tbody>' + testRows + '</tbody></table></div>' +
        '<p class="hint">每個案例都從「初始資料的複本」開始測，不會動到你在「試用 ERP」操作的資料。</p>' +
      '</section>' +
      '<section class="card"><h2>從需求一路追到驗收（可追溯）</h2>' +
        (reqs.length ? '<div class="tbl-wrap"><table class="tbl trace"><thead><tr><th>需求</th><th>對應的規則</th><th>驗收案例</th><th>存在哪個版本</th></tr></thead><tbody>' + traceRows + '</tbody></table></div>'
          : '<p class="muted">還沒有需求。請先完成「AI 問答」。</p>') +
      '</section>' +
      details('研究用：參考需求基準（RRB）七項，AI 找到幾項',
        '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>參考需求</th><th>AI 是否找到</th><th>參考 ERP（旺盛輪業）有沒有</th></tr></thead><tbody>' + rrbRows + '</tbody></table></div>' +
        '<p class="hint">七項參考需求裡，有 ' + refSeen + ' 項在這套真實運作的輪胎 ERP 也看得到，可以當作「這些需求不是憑空想像」的佐證。參考 ERP 只做唯讀觀察，沒有改動它的任何資料。</p>' +
        '<p class="hint">隱含需求召回率 ＝ AI 正確找出的隱含需求數 ÷ 參考基準中的隱含需求總數。參考基準要經「整理候選 → 獨立分類 → 專家確認 → 記錄爭議 → 凍結 v1.0 → 正式測試」六步才算數，目前只是示意。</p>');
  }

  // =====================================================================
  // 8 存成版本
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
        (c.auto ? '<span class="auto-mk ' + (c.ok ? 'ok' : 'no') + '" aria-label="' + (c.ok ? '已通過' : '未通過') + '">' + (c.ok ? '✔' : '✘') + '</span>'
          : '<input type="checkbox" id="chk-' + c.key + '" ' + (c.ok ? 'checked ' : '') + 'data-check="' + c.key + '">') +
        '<label for="chk-' + c.key + '" style="margin:0"><b>' + esc(c.label) + '</b> ' + (c.auto ? '<span class="pill ' + (c.ok ? 'teal' : 'orange') + '">系統自動檢查</span>' : '<span class="pill">請你勾選</span>') +
        '<br><span class="small muted">' + esc(c.hint) + '</span></label></div>';
    }).join('');

    var rows = vers.map(function (v, i) {
      var prev = vers[i + 1];
      var conf = function (x) { return x ? x.reqs.filter(function (r) { return r.status === 'confirmed'; }).map(function (r) { return r.id; }) : []; };
      var ready = function (x) { return x ? x.rules.filter(function (r) { return r.complete; }).map(function (r) { return r.id; }) : []; };
      var diff = [];
      if (prev) {
        var reqName = function (x, id) { var q = x.reqs.filter(function (z) { return z.id === id; })[0]; return q ? short(q.text, 30) : id; };
        var ruleName = function (x, id) { var q = x.rules.filter(function (z) { return z.id === id; })[0]; return q ? q.title : id; };
        conf(v).filter(function (id) { return conf(prev).indexOf(id) < 0; }).forEach(function (id) { diff.push('多了已確認的需求：' + reqName(v, id)); });
        conf(prev).filter(function (id) { return conf(v).indexOf(id) < 0; }).forEach(function (id) { diff.push('少了已確認的需求：' + reqName(prev, id)); });
        ready(v).filter(function (id) { return ready(prev).indexOf(id) < 0; }).forEach(function (id) { diff.push('規則寫完整了：' + ruleName(v, id)); });
        ready(prev).filter(function (id) { return ready(v).indexOf(id) < 0; }).forEach(function (id) { diff.push('規則變得不完整：' + ruleName(prev, id)); });
        var tp = v.tests ? v.tests.pass : 0, pp = prev.tests ? prev.tests.pass : 0;
        if (tp !== pp) diff.push('通過的驗收 ' + pp + ' → ' + tp);
      }
      var ck = v.checklist.filter(function (c) { return c.ok; }).length;
      return '<tr><td class="mono"><b>' + esc(v.id) + '</b></td><td class="nowrap">' + fmtTime(v.at) + '</td><td>' + esc(v.note || '—') + '</td>' +
        '<td class="num">' + conf(v).length + '</td><td class="num">' + ready(v).length + '／' + v.rules.length + '</td>' +
        '<td>' + (v.tests ? '<span class="res ' + (v.tests.pass === v.tests.total ? 'pass' : 'fail') + '">' + v.tests.pass + '／' + v.tests.total + '</span>' : '<span class="muted">未測</span>') + '</td>' +
        '<td class="num">' + ck + '／9</td><td class="small">' + (prev ? (diff.length ? diff.map(function (d) { return '<div>' + esc(d) + '</div>'; }).join('') : '沒有變動') : '第一版') + '</td></tr>';
    }).join('');

    var logs = db.wb.log.slice(-12).reverse().map(function (l) {
      return '<tr><td class="nowrap">' + fmtTime(l.at) + '</td><td class="mono">' + esc(l.action) + '</td><td class="small">' + esc(l.detail) + '</td></tr>';
    }).join('');

    return head('8　存成版本', '完成一個階段，就存成一個版本。之後可以比較每一版改了什麼。',
        '<button type="button" class="btn ghost" data-act="export">匯出全部資料（備份用）</button>') +
      '<div class="grid-2">' +
        '<section class="card"><h2>存版本前的 9 項檢查 <span class="pill ' + (okCount === 9 ? 'teal' : 'orange') + '">' + okCount + '／9</span></h2>' + chk + '</section>' +
        '<section class="card"><h2>存成新版本</h2>' +
          '<p>這一版會叫做：<b class="mono">' + esc(next) + '</b></p>' +
          '<ul class="check-list">' +
            '<li class="' + (confirmed ? 'ok' : 'no') + '"><span class="mk">' + (confirmed ? '✔' : '✘') + '</span>已確認的需求：' + confirmed + ' 條</li>' +
            '<li class="' + (parts.ready.length ? 'ok' : 'no') + '"><span class="mk">' + (parts.ready.length ? '✔' : '✘') + '</span>寫完整、可以開發的規則：' + parts.ready.length + ' 條（先不做 ' + parts.blocked.length + ' 條）</li>' +
            '<li class="' + (run && run.pass === run.total ? 'ok' : 'no') + '"><span class="mk">' + (run && run.pass === run.total ? '✔' : '✘') + '</span>最近一次驗收：' + (run ? run.pass + '／' + run.total + ' 通過（' + fmtTime(run.at) + '）' : '還沒執行') + '</li>' +
          '</ul>' +
          '<form data-form="version"><label>這一版的說明<textarea name="note" rows="3" placeholder="例：第一版：查詢、叫貨、送出即預留、老闆審核"></textarea></label>' +
          (okCount < 9 ? '<div class="note orange small" style="margin-bottom:10px">還有 ' + (9 - okCount) + ' 項檢查沒完成；也可以先存，版本紀錄會記下哪些還沒做。</div>' : '') +
          '<button type="submit" class="btn primary big">存成 ' + esc(next) + '</button></form>' +
        '</section>' +
      '</div>' +
      '<section class="card"><h2>版本紀錄</h2>' +
        (rows ? '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>版本</th><th>時間</th><th>說明</th><th class="num">已確認需求</th><th class="num">可開發規則</th><th>驗收</th><th class="num">檢查</th><th>和上一版比</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
          : '<p class="muted">還沒有版本。</p>') +
      '</section>' +
      details('操作紀錄（最近 12 筆）', logs ? '<div class="tbl-wrap"><table class="tbl compact"><thead><tr><th>時間</th><th>動作</th><th>內容</th></tr></thead><tbody>' + logs + '</tbody></table></div>' : '<p class="muted">還沒有紀錄。</p>');
  }

  // =====================================================================
  // 示範導覽（8 分鐘）
  // =====================================================================
  function fmtClock(s) { var a = Math.abs(s); return (s < 0 ? '-' : '') + Math.floor(a / 60) + ':' + two(a % 60); }

  function renderDemo() {
    var el = $('#demo');
    el.hidden = !ui.demoOpen;
    if (!ui.demoOpen) return;
    var t = ui.timer;
    el.innerHTML = '<h2>8 分鐘示範 <button type="button" class="btn sm ghost" data-act="toggle-demo">關閉</button></h2>' +
      '<div class="timer ' + (t.left < 0 ? 'over' : '') + '" id="demoClock">' + fmtClock(t.left) + '</div>' +
      '<div class="row-actions center"><button type="button" class="btn sm primary" data-act="timer">' + (t.running ? '暫停' : '開始計時') + '</button><button type="button" class="btn sm ghost" data-act="timer-reset">歸零</button></div>' +
      '<ol>' + DEMO.map(function (d, i) {
        return '<li class="' + (i === ui.demoStep ? 'cur' : '') + '" data-act="demo-step" data-i="' + i + '"><span class="t">' + d.t + '</span><b>' + (i + 1) + '. ' + esc(d.title) + '</b>' + esc(d.say) + '</li>';
      }).join('') + '</ol>' +
      '<p class="hint">示範前，先按右上角「重設資料」回到初始狀態。</p>';
  }

  function tick() {
    ui.timer.left -= 1;
    var c = $('#demoClock');
    if (c) { c.textContent = fmtClock(ui.timer.left); c.className = 'timer' + (ui.timer.left < 0 ? ' over' : ''); }
  }

  // =====================================================================
  // 主畫面
  // =====================================================================
  var PAGES = { a: pageA, interview: pageInterview, confirm: pageConfirm, rules: pageRules, devpack: pageDevpack, erp: pageERP, verify: pageVerify, versions: pageVersions };

  function currentRoute() {
    var id = (location.hash || '').replace(/^#\/?/, '');
    return ROUTES.filter(function (r) { return r.id === id; })[0] || ROUTES[0];
  }

  // 留言框：重新整理畫面時保留打到一半的字，並依內容自動長高
  function fitChat(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function render() {
    var draftBox = document.getElementById('chatMsg');
    if (draftBox) ui.draft = draftBox.value;
    var r = currentRoute();
    ui.route = r.id;
    var done = ROUTES.filter(function (x) { return navDone(x.id); }).length;
    $('#nav').innerHTML = ROUTES.map(function (x) {
      return '<a href="#/' + x.id + '" class="' + (x.id === r.id ? 'active' : '') + '"' + (x.id === r.id ? ' aria-current="page"' : '') + '>' +
        '<span class="no">' + x.no + '</span><span class="lb">' + esc(x.nav) + '</span><span class="ck">' + (navDone(x.id) ? '✔' : '') + '</span></a>';
    }).join('');
    $('#crumb').textContent = '專案：' + db.wb.project.name + '　／　' + r.no + ' ' + r.title;
    $('#verBadge').textContent = db.wb.versions.length ? db.meta.version : '尚未存版本';
    $('#sideFoot').innerHTML = '<div class="side-progress"><div class="bar" style="width:' + Math.round(done / ROUTES.length * 100) + '%"></div></div>已完成 ' + done + '／' + ROUTES.length + ' 步<br>' +
      (Store.persistent() ? '資料存在這台電腦的瀏覽器' : '⚠ 瀏覽器不允許儲存，關閉後資料會消失') +
      '<br><span class="build" title="如果畫面和說明不一樣，請按 Ctrl + F5 重新載入">程式版本 ' + esc(SEED.meta.build) + '</span>';
    $('#main').innerHTML = nextBar() + PAGES[r.id]();
    var log = $('#chatLog');
    if (log) log.scrollTop = log.scrollHeight;
    var box = document.getElementById('chatMsg');
    if (box && ui.draft) { box.value = ui.draft; fitChat(box); }
    if (ui.focus) { var f = document.getElementById(ui.focus); if (f) f.focus(); ui.focus = ''; }
    renderDemo();
  }

  // =====================================================================
  // 事件
  // =====================================================================
  function sendChat(text, fromBox) {
    ui.focus = 'chatMsg';
    // 從輸入框送出的字要清掉；點「建議回答」送出時，保留你打到一半的字
    if (fromBox) {
      ui.draft = '';
      var b = document.getElementById('chatMsg');
      if (b) b.value = '';
    }
    act(function (cur) { return Store.wb.interviewSend(cur, text); });
  }

  function projectFields() {
    var f = document.querySelector('form[data-form="project"]');
    return f ? { name: f.elements.name.value, need: f.elements.need.value, owner: f.elements.owner.value } : {};
  }

  var ACTIONS = {
    go: function (el) { go(el.dataset.to); },
    reset: function () {
      if (!window.confirm('確定要重設嗎？\n\n所有問答、需求、規則、訂單、紀錄和版本，都會回到最初的範例資料。')) return;
      db = Store.reset();
      ui.erpQuery = ''; ui.ruleSel = '';
      toast('已重設回最初的範例資料', true);
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

    // 1 建立專案
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

    // 2 AI 問答
    chip: function (el) {
      var text = Rules.interviewChips(db.wb.interview.step, db.wb)[Number(el.dataset.i)];
      if (text) sendChat(text);
    },
    'restart-interview': function () {
      if (!window.confirm('重新問答會清除目前的問答紀錄、需求和規則（ERP 資料不受影響）。確定嗎？')) return;
      ui.chatMore = false; ui.draft = '';
      act(function (cur) { return Store.wb.restartInterview(cur); });
    },
    'chat-more': function () { ui.chatMore = true; ui.focus = 'chatMsg'; render(); },
    'resolve-q': function (el) { act(function (cur) { return Store.wb.resolveQuestion(cur, Number(el.dataset.i)); }); },

    // 3 確認需求
    req: function (el) {
      var id = el.dataset.id, op = el.dataset.op;
      if (op === 'edit') {
        var r = reqById(id);
        modal({
          title: '修改需求文字', ok: '儲存',
          html: '<label>需求內容<textarea id="mReq" rows="3">' + esc(r ? r.text : '') + '</textarea></label><p class="hint">修改後仍需要再按一次「確認」。</p>',
          onOk: function (w) { var res = act(function (cur) { return Store.wb.editReq(cur, id, w.querySelector('#mReq').value); }); return res.ok; }
        });
        return;
      }
      act(function (cur) { return Store.wb.setReqStatus(cur, id, op); });
    },
    'req-menu': function (el) {
      var r = reqById(el.dataset.id);
      if (!r) return;
      var moves = Rules.REQ_MOVES[r.status] || {};
      var opts = [
        { to: 'confirmed', label: r.status === 'ai' ? '採納（變成已確認）' : '已確認', cls: 'primary' },
        { to: 'pending', label: '待確認（撤回）', cls: '' },
        { to: 'deferred', label: '延後', cls: '' },
        { to: 'rejected', label: '拒絕', cls: 'danger' }
      ].filter(function (o) { return !!moves[o.to]; });
      modal({
        title: '修改需求狀態',
        html: '<p><b>' + esc(r.text) + '</b></p>' +
          '<p class="small muted" style="margin:8px 0">目前狀態：' + reqPill(r.status) + '　改成：</p>' +
          '<div class="row-actions">' + opts.map(function (o) {
            return '<button type="button" class="btn ' + o.cls + '" data-act="req-move" data-id="' + esc(r.id) + '" data-to="' + o.to + '">' + esc(o.label) + '</button>';
          }).join('') + '</div>' +
          (r.status === 'pending' ? '<div class="row-actions mt"><button type="button" class="btn ghost sm" data-act="req-edit" data-id="' + esc(r.id) + '">修改需求文字</button></div>' : '') +
          (r.group ? '<p class="hint">「送出就預留」與「核准才預留」只能二選一：確認其中一條，另一條會自動標成已拒絕。</p>' : '') +
          '<p class="hint">AI 只能提議；「已確認」一定是由你按下的。</p>'
      });
    },
    'req-move': function (el) {
      if (App._closeModal) App._closeModal();
      var id = el.dataset.id, to = el.dataset.to;
      act(function (cur) { return Store.wb.moveReq(cur, id, to); });
    },
    'req-edit': function (el) {
      if (App._closeModal) App._closeModal();
      ACTIONS.req({ dataset: { id: el.dataset.id, op: 'edit' } });
    },
    evidence: function (el) {
      var r = reqById(el.dataset.id);
      if (!r) return;
      var score = Rules.qualityScore(r.quality);
      modal({
        title: '這條需求的依據',
        html: '<p><b>' + esc(r.text) + '</b></p><p class="small muted">來源：' + esc(r.source) + '</p><div class="quote">' + esc(r.evidence) + '</div>' +
          (r.note ? '<p class="small"><b>備註：</b>' + esc(r.note) + '</p>' : '') +
          '<p class="small"><b>AI 評分（需求寫得夠不夠清楚）：' + score + '／14</b></p>' +
          '<p class="small muted">' + Rules.QUALITY.map(function (n, i) { return esc(n) + ' ' + r.quality[i] + '／2'; }).join('　') + '</p>' +
          '<h3 style="margin:12px 0 6px">狀態紀錄</h3><table class="tbl compact"><tbody>' + r.history.map(function (h) {
            return '<tr><td class="nowrap">' + fmtTime(h.at) + '</td><td>' + (h.by === 'AI' ? 'AI' : '你') + '</td><td>' + reqPill(h.to) + '</td><td class="small">' + esc(h.note) + '</td></tr>';
          }).join('') + '</tbody></table>'
      });
    },
    'build-rules': function () {
      var res = act(function (cur) { return Store.wb.buildRules(cur); });
      if (res.ok && ui.route !== 'rules') go('rules');
    },

    // 4 檢查規則、5 開發包
    'rule-sel': function (el) { ui.ruleSel = el.dataset.id; render(); },
    'gen-devpack': function () { act(function (cur) { return Store.wb.genDevpack(cur); }); },
    'dev-tab': function (el) { ui.devTab = el.dataset.tab; render(); },
    'dev-copy': function () { copyText(Rules.devpack(db).files[ui.devTab]); },
    'dev-copy-all': function () { copyText(allDevText()); },
    'dev-download': function () { download(ui.devTab, Rules.devpack(db).files[ui.devTab]); },
    'dev-download-all': function () { download('開發包_全部.md', allDevText()); },

    // 7 驗收、8 版本
    'run-tests': function () {
      var results = Tests.runAll();
      act(function (cur) { return Store.wb.recordTestRun(cur, results); });
    },
    export: function () {
      download('aiwb_state_v01_' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(db, null, 2), 'application/json;charset=utf-8');
    },

    // 6 試用 ERP
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
        html: '<label>退回原因<input id="mReason" value="數量請再確認"></label><p class="hint">退回後，這張單預留的庫存會還回去；業務修改後可以重新送出。只有「待審核」的訂單可以退回。</p>',
        onOk: function (w) { act(function (cur) { return ERP.returnOrder(cur, ui.erpUser, id, w.querySelector('#mReason').value); }); }
      });
    },
    'reject-order': function (el) {
      var id = el.dataset.id;
      modal({
        title: '拒絕 ' + id, ok: '拒絕',
        html: '<label>拒絕原因<input id="mReason" value="客戶取消"></label><p class="hint">拒絕後，這張單預留的庫存會還回去，業務不能再修改這張單。</p>',
        onOk: function (w) { act(function (cur) { return ERP.rejectOrder(cur, ui.erpUser, id, w.querySelector('#mReason').value); }); }
      });
    }
  };

  var FORMS = {
    project: function (f) {
      act(function (cur) { return Store.wb.updateProject(cur, { name: f.elements.name.value, need: f.elements.need.value, owner: f.elements.owner.value }); });
    },
    chat: function (f) { var v = f.elements.msg.value; if (v.trim()) sendChat(v, true); },
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
        act(function (cur) { return Store.wb.addSource(cur, { name: file.name, kind: kind, size: file.size, note: '你上傳的檔案（只記錄檔名與大小）' }); });
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
      // 留言框：Enter 換行（瀏覽器預設），Ctrl／Cmd + Enter 才送出
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target && e.target.id === 'chatMsg' && !e.isComposing) {
        e.preventDefault();
        var form = e.target.form;
        if (form) { if (form.requestSubmit) form.requestSubmit(); else form.querySelector('[type="submit"]').click(); }
      }
    });
    document.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'chatMsg') fitChat(e.target);
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
