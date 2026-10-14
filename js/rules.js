/* rules.js — 規則層
 * 全域物件：Rules
 * 1. ERP 領域規則（ERP 函式直接呼叫）：available、正整數、業務欄位白名單、可退回／核准／拒絕判斷
 * 2. IF 閉環 8 項檢查（開發閘門）：IF、True、False、資料效果、訊息、稽核、≥2 測試、最終狀態
 * 3. 需求目錄、規則範本（白話）、ERP 九大難點、訂單狀態機、RRB
 * 4. AI 需求訪談引擎（示範版：規則式追問，不連網、不呼叫大型語言模型）
 * 5. 開發包（SPEC／TASKS／TESTS／Coding Agent 指令）與版本前 9 項檢查
 * 畫面上的文字一律白話；REQ／RULE／TC 編號只當小字。
 */
var Rules = (function () {
  'use strict';

  // =====================================================================
  // 標籤（給畫面顯示的白話文字）
  // =====================================================================
  var ROLE = { admin: '管理員', boss: '老闆', sales: '業務', warehouse: '倉管', planner: '生管' };
  var ORDER_STATUS = {
    DRAFT: '購物車', SUBMITTED: '待審核（已預留）', APPROVED: '已核准', REJECTED: '已拒絕',
    RETURNED: '被退回', PARTIALLY_SHIPPED: '部分出貨', SHIPPED: '已出貨', CANCELLED: '已取消'
  };
  var REQ_STATUS = { pending: '待確認', ai: 'AI 建議', confirmed: '已確認', rejected: '已拒絕', deferred: '延後' };
  var PRIORITY_LABEL = { Must: '必要', Should: '建議', "Won't": '暫不做' };
  var ACTION_LABEL = {
    QUERY: '查詢庫存', QUERY_DENIED: '查詢被拒',
    ADD_LINE: '加入叫貨單', ADD_LINE_DENIED: '加入被拒', UPDATE_LINE: '修改數量', UPDATE_LINE_DENIED: '修改被拒',
    REMOVE_LINE: '移除品項', REMOVE_LINE_DENIED: '移除被拒', SET_CUSTOMER: '填寫客戶', SET_CUSTOMER_DENIED: '填寫被拒',
    SUBMITTED: '送出並預留', SUBMIT_DENIED: '送出被拒',
    APPROVED: '老闆核准', APPROVE_DENIED: '核准被拒',
    REJECTED: '老闆拒絕', REJECT_DENIED: '拒絕被拒',
    RETURNED: '老闆退回', RETURN_DENIED: '退回被拒', MIGRATED: '資料升級',
    SHIPPED: '出貨完成', SHIP_DENIED: '出貨被拒', RECEIVED: '進貨入庫', RECEIVE_DENIED: '進貨被拒',
    PRODUCT_ADDED: '新增商品', PRODUCT_UPDATED: '修改價格', PRODUCT_DENIED: '商品異動被拒',
    LOGIN: '登入', LOGIN_DENIED: '登入失敗', LOGOUT: '登出',
    SAFETY_SET: '設定安全庫存', SAFETY_DENIED: '安全庫存設定被拒', LOWRULE_CHANGED: '修改低庫存規則', LOWRULE_DENIED: '低庫存規則異動被拒'
  };

  // 需求狀態可由「人」改成哪些狀態；值是依序執行的單步操作（已確認／延後／拒絕要先撤回再改）
  // AI 建議的需求只能被人採納、延後或拒絕，不能退回待確認，更不能由 AI 自己確認
  var REQ_MOVES = {
    pending: { confirmed: ['confirm'], deferred: ['defer'], rejected: ['reject'] },
    ai: { confirmed: ['adopt'], deferred: ['defer'], rejected: ['reject'] },
    confirmed: { pending: ['revert'], deferred: ['revert', 'defer'], rejected: ['revert', 'reject'] },
    deferred: { pending: ['revert'], confirmed: ['revert', 'confirm'], rejected: ['revert', 'reject'] },
    rejected: { pending: ['revert'], confirmed: ['revert', 'confirm'], deferred: ['revert', 'defer'] }
  };

  // =====================================================================
  // 1. ERP 領域規則
  // =====================================================================
  // REQ-005：available = on_hand − reserved
  function available(p) { return p.on_hand - p.reserved; }

  // RULE-002：叫貨數量必須為正整數（數字字串可接受，其他一律 NaN）
  function parseQty(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return NaN;
  }
  function isPositiveInt(v) {
    var n = parseQty(v);
    return Number.isSafeInteger(n) && n > 0;
  }

  function isSales(user) { return !!user && user.role === 'sales'; }
  // 管理權限＝管理員或老闆（RULE-030：擁有全部權限）；沿用 isBoss 這個名字，舊程式與測試不用改
  function isManager(user) { return !!user && (user.role === 'boss' || user.role === 'admin'); }
  function isBoss(user) { return isManager(user); }
  // RULE-030 權限表（唯一來源）：ERP 函式用 can() 判斷，登入頁的「各角色能做什麼」表也從這裡產生
  var PERMS = [
    { key: 'stock', label: '查庫存（店家價、末端價、庫存、安全庫存）', roles: ['admin', 'boss', 'sales', 'warehouse', 'planner'] },
    { key: 'cost', label: '看成本與毛利', roles: ['admin', 'boss'] },
    { key: 'order', label: '叫貨、送出叫貨單', roles: ['sales'] },
    { key: 'approve', label: '核准、退回、拒絕叫貨單', roles: ['admin', 'boss'] },
    { key: 'ship', label: '出貨完成', roles: ['admin', 'boss'] },
    { key: 'receive', label: '進貨', roles: ['admin', 'boss'] },
    { key: 'product', label: '新增商品、改價（店家價、末端價、成本）', roles: ['admin', 'boss'] },
    { key: 'safety', label: '設定安全庫存', roles: ['admin', 'boss'] },
    { key: 'lowrule', label: '改低庫存的算法（要走「變更需求」）', roles: ['admin', 'boss'] }
  ];
  function can(user, key) {
    if (!user) return false;
    var p = PERMS.filter(function (x) { return x.key === key; })[0];
    return !!p && p.roles.indexOf(user.role) >= 0;
  }
  // 員工＝業務、倉管、生管：看不到成本與毛利（RULE-001、RULE-030）
  function isStaff(user) { return !!user && (user.role === 'sales' || user.role === 'warehouse' || user.role === 'planner'); }

  // RULE-001：業務看到的欄位白名單；用「重新組物件」而不是刪欄位
  // 員工可看的欄位：店家價（price）、末端價（retail）、庫存與安全庫存；沒有 cost、margin
  var SALES_FIELDS = ['sku', 'brand', 'name', 'spec', 'year', 'on_hand', 'reserved', 'available', 'safety', 'price', 'retail'];
  function viewFor(user, p) {
    var row = {};
    SALES_FIELDS.forEach(function (f) { row[f] = f === 'available' ? available(p) : f === 'safety' ? (p.safety || 0) : f === 'retail' ? (p.retail == null ? null : p.retail) : p[f]; });
    if (isBoss(user)) {
      row.cost = p.cost;
      row.margin = p.price - p.cost;
    }
    return row;
  }

  // 送出即預留（REQ-004B）：待審核與已核准的訂單都佔用庫存
  var RESERVING = ['SUBMITTED', 'APPROVED'];
  // RULE-005 退回、RULE-006 核准、RULE-007 拒絕：都只處理待審核（SUBMITTED）
  function canReturn(order) { return !!order && order.status === 'SUBMITTED'; }
  function canApprove(order) { return !!order && order.status === 'SUBMITTED'; }
  function canReject(order) { return !!order && order.status === 'SUBMITTED'; }
  // RULE-010 出貨完成：只處理已核准的訂單
  function canShip(order) { return !!order && order.status === 'APPROVED'; }
  function canEdit(order) { return !!order && (order.status === 'DRAFT' || order.status === 'RETURNED'); }

  // RULE-027 安全庫存：0 或正整數（0 代表不設警示）
  function isNonNegInt(v) {
    var n = parseQty(v);
    return Number.isSafeInteger(n) && n >= 0;
  }
  // RULE-026 低庫存警示：有設安全庫存（> 0），而且可用庫存「小於」（lt）或「小於或等於」（le）安全庫存
  var LOW_OPS = {
    lt: { sign: '<', label: '小於安全庫存才警示', short: '小於' },
    le: { sign: '≤', label: '小於或等於安全庫存就警示', short: '小於或等於' }
  };
  function isLowStock(p, op) {
    var safety = Number(p && p.safety) || 0;
    if (safety <= 0) return false;
    var a = available(p);
    return op === 'le' ? a <= safety : a < safety;
  }

  // =====================================================================
  // 2. IF 閉環 8 項檢查
  // =====================================================================
  function filled(v) { return typeof v === 'string' ? v.trim().length > 0 : !!v; }
  function list(v) { return Array.isArray(v) ? v.filter(filled) : []; }
  function parseTestIds(v) {
    if (Array.isArray(v)) return list(v);
    return String(v || '').split(/[\s,，、;；]+/).map(function (x) { return x.trim().toUpperCase(); }).filter(filled);
  }
  function testIds(rule) {
    var all = list(rule.t && rule.t.tests).concat(list(rule.f && rule.f.tests), list(rule.edge && rule.edge.tests));
    return all.filter(function (x, i) { return all.indexOf(x) === i; });
  }

  // label＝完整說法；short＝缺項時的短說法（畫面用白話）
  var CLOSURE = [
    { key: 'if', label: '寫了「條件」（IF）', short: '條件', ok: function (r) { return filled(r.if); } },
    { key: 'true', label: '寫了「條件成立時」要做什麼（True）', short: '成立時要做什麼', ok: function (r) { return filled(r.t.action); } },
    { key: 'false', label: '寫了「條件不成立時」要做什麼（False）', short: '不成立時要做什麼', ok: function (r) { return filled(r.f.action); } },
    { key: 'effect', label: '寫了資料會怎麼變（成立、不成立都要寫）', short: '資料怎麼變', ok: function (r) { return filled(r.t.effect) && filled(r.f.effect); } },
    { key: 'message', label: '寫了畫面要顯示什麼訊息', short: '畫面訊息', ok: function (r) { return filled(r.t.message) && filled(r.f.message); } },
    { key: 'audit', label: '寫了系統要留下什麼紀錄', short: '系統紀錄', ok: function (r) { return filled(r.t.audit) && filled(r.f.audit); } },
    { key: 'tests', label: '至少 2 個驗收案例（成立、不成立各至少 1 個）', short: '驗收案例', ok: function (r) { return testIds(r).length >= 2 && list(r.t.tests).length > 0 && list(r.f.tests).length > 0; } },
    { key: 'final', label: '寫了訂單最後會變成什麼狀態', short: '最後狀態', ok: function (r) { return filled(r.t.final) && filled(r.f.final); } }
  ];

  function check(rule) {
    var r = {
      if: rule.if, t: rule.t || {}, f: rule.f || {}, edge: rule.edge || {}
    };
    var items = CLOSURE.map(function (c) { return { key: c.key, label: c.label, short: c.short, ok: !!c.ok(r) }; });
    var score = items.filter(function (i) { return i.ok; }).length;
    var needsReview = !!(rule.ai_draft && !rule.ai_draft.reviewed);
    return {
      items: items, score: score, total: CLOSURE.length,
      needsReview: needsReview,
      complete: score === CLOSURE.length && !needsReview,
      missing: items.filter(function (i) { return !i.ok; }).map(function (i) { return i.short; }).concat(needsReview ? ['你確認 AI 的建議'] : [])
    };
  }

  // =====================================================================
  // 3. 需求目錄（AI 可提出的需求；清楚度 = 7 項 × 2 分 = 14）
  // =====================================================================
  var QUALITY = ['角色明確', '動作明確', '觸發條件', '資料欄位', '例外處理', '可驗收', '來源可追溯'];

  var REQ_CATALOG = {
    'REQ-001': { text: '業務可用手機查詢輪胎庫存（規格、品牌、可用量）', priority: 'Must', quality: [2, 2, 1, 2, 1, 2, 2] },
    'REQ-002': { text: '業務可把查到的輪胎加入叫貨單並送出審核', priority: 'Must', quality: [2, 2, 2, 1, 1, 2, 2] },
    'REQ-003': { text: '叫貨數量必須為正整數（0、負數、小數不可送出）', priority: 'Must', quality: [2, 2, 2, 2, 2, 2, 1] },
    'REQ-004': { text: '老闆核准時才檢查可用庫存並建立預留（替代決策）', priority: 'Must', quality: [2, 2, 2, 2, 1, 1, 1], group: 'reserve-timing',
      decision: '未採用：已決定第一版採「送出即預留」（與 REQ-004B 二選一）' },
    'REQ-004B': { text: '業務送出叫貨單時檢查可用庫存並立即預留，其他業務不可再使用這批額度', priority: 'Must', quality: [2, 2, 2, 2, 1, 2, 2], group: 'reserve-timing',
      decision: '已決定（2026-10-14）：第一版直接採用「送出即預留」（防止審核期間庫存被別人用掉），不需要再請教授確認' },
    'REQ-005': { text: '可用庫存＝在庫－預留；待審核與已核准的訂單都算預留', priority: 'Must', quality: [2, 2, 2, 2, 2, 2, 2] },
    'REQ-006': { text: '員工（業務、倉管、生管）不可看到成本與毛利，只看得到店家價、末端價、庫存與安全庫存', priority: 'Must', quality: [2, 2, 2, 2, 1, 2, 1] },
    'REQ-007': { text: '老闆可退回待審核訂單，業務修改後重送', priority: 'Must', quality: [2, 2, 2, 1, 1, 2, 1] },
    'REQ-008': { text: '已核准訂單取消時釋放預留', priority: 'Should', quality: [2, 1, 2, 1, 1, 1, 1] },
    'REQ-009': { text: '一鍵複製庫存資訊回覆 LINE', priority: 'Should', quality: [2, 2, 1, 1, 1, 2, 1] },
    'REQ-010': { text: '老闆可核准或拒絕待審核叫貨單；拒絕時釋放預留', priority: 'Must', quality: [2, 2, 2, 1, 1, 2, 1] },
    'REQ-011': {
      text: '寄庫：客戶買 10 條、當次只取 4 條，其餘 6 條寄放店裡；購買當下就從庫存扣掉全部 10 條，之後取貨不再扣庫存',
      priority: 'Should', quality: [2, 2, 2, 2, 1, 2, 2],
      decision: '已決定（2026-10-13）：採用旺盛輪業的做法，購買當下就從庫存扣掉'
    },
    'REQ-012': { text: '依生產日期碼顯示庫齡顏色（1 年內／1–2 年／2–3 年）', priority: 'Should', quality: [2, 2, 2, 2, 1, 1, 1] },
    'REQ-013': { text: '下班後業務仍可送出叫貨單，隔日由老闆審核', priority: 'Should', quality: [2, 2, 1, 1, 1, 2, 1] },
    'REQ-015': { text: '行動條碼掃描出貨', priority: "Won't", quality: [2, 1, 1, 1, 1, 2, 1] },
    // 參考 ERP 案例（旺盛輪業庫存管理系統）觀察到、本系統第一版還沒做的功能 → 只當「AI 建議」候選，由人決定
    'REQ-016': { text: '庫存依生產週碼批次分開記錄，並顯示庫齡', priority: 'Should', quality: [2, 2, 1, 2, 1, 1, 2] },
    'REQ-017': { text: '訂單每個品項分開記錄：訂購數、當次出貨數、客戶寄庫數', priority: 'Should', quality: [2, 2, 1, 2, 1, 2, 2] },
    'REQ-018': { text: '已出貨的訂單可取消出貨，庫存依原批次復原', priority: 'Should', quality: [2, 2, 2, 1, 1, 1, 2] },
    'REQ-019': { text: '進貨入庫：老闆選商品與數量，在庫增加並留下進貨單號（本版先不分倉別與批次）', priority: 'Should', quality: [2, 2, 2, 2, 1, 2, 2] },
    'REQ-020': { text: '庫存校正：以實際盤點數為準，留下校正紀錄，可取消並回復', priority: 'Should', quality: [2, 2, 1, 2, 1, 1, 2] },
    'REQ-021': { text: '可新增倉別，並在倉庫之間移動可用庫存（預留與寄庫的不可移）', priority: 'Should', quality: [2, 2, 1, 2, 2, 1, 2] },
    'REQ-022': { text: '實際售價預設為牌價打 9 折，業務可依該筆交易修改', priority: 'Should', quality: [2, 2, 2, 2, 1, 1, 2] },
    'REQ-023': { text: 'Excel 批次更新與備份還原：更新前先比對差異', priority: "Won't", quality: [2, 2, 1, 1, 2, 1, 2] },
    // Sprint 1 商品＋進出貨（簡報第 11 頁）：AI 流程走查提出，由人決定
    'REQ-024': { text: '老闆可對已核准的訂單按「出貨完成」：在庫與預留一起扣掉，訂單變「已出貨」', priority: 'Should', quality: [2, 2, 2, 2, 1, 2, 2] },
    'REQ-025': { text: '老闆可新增商品、修改售價與成本；業務看不到成本', priority: 'Should', quality: [2, 2, 2, 2, 1, 2, 1] },
    // Sprint 3 安全庫存警示與規則變更（簡報第 10、17 頁）
    // 登入與角色權限（2026-10-14 使用者指示）
    'REQ-027': { text: '登入與角色權限：管理員與老闆擁有全部權限；員工（業務、倉管、生管）看不到成本與毛利，只能查庫存與價格（店家價、末端價），其中業務可叫貨', priority: 'Should', quality: [2, 2, 2, 2, 1, 2, 2] },
    'REQ-026': { text: '商品可設「安全庫存」；可用庫存低於安全庫存時標示「低庫存」並列入提醒；老闆可設定安全庫存，也可變更「低於」的比較方式（小於或小於等於）', priority: 'Should', quality: [2, 2, 2, 2, 1, 2, 2] }
  };
  var REQ_ORDER = Object.keys(REQ_CATALOG);

  // 參考 ERP 案例的觀察依據（沒有使用者原話；畫面「看依據」會顯示這段）
  var REF_SOURCE = 'AI 參考 ERP 案例（旺盛輪業）';
  var REF_EVIDENCE = {
    'REQ-016': '旺盛輪業 ERP「庫存查詢」：每筆庫存顯示 倉別｜批次碼｜條數｜庫齡，算不出來時寫「無法計算庫齡」。',
    'REQ-017': '旺盛輪業 ERP「訂單管理」：每個品項顯示「訂購 N 條｜當次出貨 M 條｜客戶寄庫 K 條」，例如訂購 20、當次出貨 11、客戶寄庫 9。',
    'REQ-018': '旺盛輪業 ERP「訂單管理」：已完成的訂單有「取消出貨並退回庫存」按鈕，庫存依原批次復原。',
    'REQ-019': '旺盛輪業 ERP「進貨管理」：選商品、入庫倉別、生產日期碼／批次與進貨數量，完成後留下進貨單號。',
    'REQ-020': '旺盛輪業 ERP「庫存校正」：以管理員輸入的實際盤點數為準，列出校正前後差額與原因，並可「取消並回復」。',
    'REQ-021': '旺盛輪業 ERP「儲位管理」「輪胎移庫」：有台北倉、五股倉等多個倉別；移庫只移動可用庫存，預留與寄庫保留數量不會被調動。',
    'REQ-022': '旺盛輪業 ERP「叫貨購物車」：實際售價預設帶入牌價扣 10%，員工與管理員都可依本次交易修改。',
    'REQ-023': '旺盛輪業 ERP「資料匯入」「備份」：Excel 批次更新前先比對差異、商品 ID／批次 ID／已預留數量不可改；備份可還原。'
  };
  var REF_CANDIDATES = Object.keys(REF_EVIDENCE);
  function qualityScore(q) { return (q || []).reduce(function (a, b) { return a + b; }, 0); }

  // =====================================================================
  // 規則範本（需求確認後由 buildRules 建立；人可在「檢查規則」修改）——全部用白話
  // =====================================================================
  function tpl(o) {
    o.t = o.t || {}; o.f = o.f || {}; o.edge = o.edge || { text: '', tests: [] };
    ['action', 'effect', 'message', 'audit', 'final'].forEach(function (k) {
      if (o.t[k] == null) o.t[k] = '';
      if (o.f[k] == null) o.f[k] = '';
    });
    o.t.tests = o.t.tests || []; o.f.tests = o.f.tests || []; o.edge.tests = o.edge.tests || [];
    o.code = o.code || []; o.tasks = o.tasks || []; o.note = o.note || '';
    return o;
  }

  var RULE_TEMPLATES = [
    tpl({
      id: 'RULE-001', title: '員工查庫存，看不到成本與毛利', primary: 'REQ-006', reqs: ['REQ-006', 'REQ-001'], difficulty: '權限與敏感資料',
      if: '查詢的人是員工（業務、倉管、生管）',
      t: { action: '只顯示規格、品牌、年份、在庫、預留、可用、安全庫存、店家價、末端價；不顯示成本和毛利', effect: '只是查詢，庫存不會改變', message: '查到 N 筆', audit: '記下誰查了什麼、顯示了哪些欄位', tests: ['TC-001-01'], final: '查詢結果裡沒有成本' },
      f: { action: '查詢的人是老闆或管理員時，顯示完整欄位（含成本、毛利）', effect: '只是查詢，庫存不會改變', message: '查到 N 筆（含成本）', audit: '記下老闆或管理員查詢，並註明含成本', tests: ['TC-001-02'], final: '查詢結果有成本' },
      edge: { text: '用「白名單」只挑允許的欄位，而不是事後把成本刪掉；以後新增敏感欄位也不會外洩', tests: [] },
      code: ['ERP.queryStock', 'Rules.viewFor'],
      tasks: [
        '實作 ERP.queryStock(db, userId, keyword)：角色以 db 內的使用者資料為準，不信任畫面傳入的角色',
        '業務用 Rules.viewFor 白名單組出新物件，不可含 cost／margin',
        '寫入 QUERY 稽核（角色、關鍵字、回傳欄位）'
      ]
    }),
    tpl({
      id: 'RULE-002', title: '叫貨數量一定要是正整數', primary: 'REQ-003', reqs: ['REQ-003', 'REQ-002'], difficulty: '單據狀態與回滾',
      if: '輸入的叫貨數量是大於 0 的整數（1、2、3…）',
      t: { action: '加入叫貨單（購物車）', effect: '叫貨單多一行；此時不動庫存（要到「送出」才預留）', message: '已加入叫貨單', audit: '記下誰加了什麼、數量多少', tests: ['TC-002-02'], final: '購物車（尚未送出）' },
      f: { action: '拒絕加入，也不建立訂單', effect: '訂單和庫存完全不變', message: '叫貨數量必須為正整數', audit: '記下被拒絕的嘗試', tests: ['TC-002-01'], final: '沒有新訂單，原本的訂單不變' },
      edge: { text: '0、負數、小數、空白、文字，一律當作「條件不成立」', tests: [] },
      code: ['ERP.addLine', 'ERP.updateLine', 'Rules.isPositiveInt'],
      tasks: [
        '實作 ERP.addLine／updateLine：數量用 Rules.isPositiveInt 檢查，不通過就不建立訂單',
        '加入、修改、拒絕都寫稽核'
      ]
    }),
    tpl({
      id: 'RULE-003', title: '送出叫貨單時，先預留庫存', primary: 'REQ-004B', reqs: ['REQ-004B', 'REQ-005'], difficulty: '庫存時間差、超賣',
      if: '送出的當下重新查一次庫存：每一項的「可用庫存」都 ≥ 叫貨數量（可用庫存 = 在庫 − 預留）',
      t: { action: '預留這張單的數量；訂單變成「待審核」', effect: '「預留」增加，可用庫存立刻變少；其他業務不能再用這批額度', message: '已送出並預留，等待老闆核准', audit: '記下送出並預留了哪些品項、各多少', tests: ['TC-003-01'], final: '待審核（已預留）' },
      f: { action: '不能送出，訂單留在購物車', effect: '庫存與預留完全不變', message: '可用庫存不足（剩 N），不能送出', audit: '記下送出被拒絕與原因', tests: ['TC-003-02'], final: '維持原本狀態（購物車或被退回）' },
      edge: { text: '兩位業務同時送最後 1 條：送出時重新查庫存、一次只處理一個，只有 1 人成功', tests: ['TC-003-03'] },
      code: ['ERP.submitOrder', 'Rules.available', 'Store.transact'],
      tasks: [
        '實作 ERP.submitOrder(db, userId, orderId)：只處理購物車（DRAFT）或被退回（RETURNED）的訂單；送出當下重新讀取 on_hand／reserved',
        '每一項可用庫存足夠：reserved += qty、狀態 SUBMITTED、稽核 SUBMITTED、訊息「已送出並預留」',
        '只要有一項不足：整張單不送出、庫存完全不變、稽核 SUBMIT_DENIED、訊息「可用庫存不足（剩 N）」',
        '畫面送出一律經 Store.transact，執行當下重新讀取最新狀態'
      ]
    }),
    tpl({
      id: 'RULE-004', title: '老闆核准時才預留（替代方案，目前沒採用）', primary: 'REQ-004', reqs: ['REQ-004', 'REQ-005'], difficulty: '庫存時間差、超賣',
      if: '老闆按核准的當下重新查庫存：每一項的可用庫存都 ≥ 叫貨數量',
      t: { action: '建立預留；訂單變成「已核准」', effect: '「預留」增加，可用庫存減少', message: '核准成功', audit: '記下核准', tests: ['TC-004-01'], final: '已核准（已預留）' },
      f: { action: '不能核准；訂單變成「已拒絕」', effect: '庫存與預留完全不變', message: '可用庫存不足（剩 N）', audit: '記下拒絕與原因', tests: ['TC-004-02'], final: '已拒絕' },
      edge: { text: '兩位老闆同時核准最後 1 條：核准時重新查庫存，只有 1 張成功', tests: ['TC-004-03'] },
      code: [],
      note: '這是「核准才預留」的替代方案，和「送出即預留」只能二選一。目前系統採用送出即預留，所以這條還沒有程式與驗收案例；若改選它，要請 AI 工程師修改程式並補測試（改測試需要使用者同意）。',
      tasks: [
        '修改 ERP.submitOrder：送出時不預留',
        '修改 ERP.approveOrder：核准當下重新讀取庫存，足夠才預留、不足就拒絕',
        '退回、拒絕時不需釋放預留',
        '新增 TC-004-01～03（需使用者同意才可修改 tests.js）'
      ]
    }),
    tpl({
      id: 'RULE-005', title: '只有「待審核」的訂單可以退回', primary: 'REQ-007', reqs: ['REQ-007'], difficulty: '單據狀態與回滾',
      if: '訂單目前的狀態是「待審核」',
      t: { action: '退回，業務可以修改後重新送出', effect: '訂單變成「被退回」；釋放這張單預留的數量，可用庫存恢復', message: '已退回，預留已釋放，請業務修改後重送', audit: '記下退回與原因', tests: ['TC-005-01'], final: '被退回（未預留）；重送後回到待審核' },
      f: { action: '拒絕退回', effect: '訂單與庫存完全不變', message: '只有待審核的訂單可以退回', audit: '記下被拒絕的退回', tests: ['TC-005-02'], final: '維持原本的狀態（例如已核准）' },
      edge: { text: '已核准的訂單要用「取消」，不能用退回', tests: [] },
      code: ['ERP.returnOrder', 'Rules.canReturn', 'ERP.updateLine', 'ERP.submitOrder'],
      tasks: [
        '實作 ERP.returnOrder(db, userId, orderId, reason)：用 Rules.canReturn 判斷；退回時 reserved −= qty',
        '被退回的訂單可由建立的業務修改數量後重新送出（重新檢查並預留）',
        '退回、拒絕退回都寫稽核'
      ]
    }),
    tpl({
      id: 'RULE-006', title: '老闆核准待審核的訂單', primary: 'REQ-010', reqs: ['REQ-010'], difficulty: '單據狀態與回滾',
      if: '訂單目前是「待審核」，而且操作的人是老闆或管理員',
      t: { action: '核准；訂單變成「已核准」', effect: '只改訂單狀態；庫存不變（預留在送出時就建立好了）', message: '核准成功', audit: '記下誰核准了哪張單', tests: ['TC-006-01'], final: '已核准' },
      f: { action: '不能核准（操作的人不是老闆或管理員，或訂單不是待審核）', effect: '訂單與庫存完全不變', message: '只有老闆或管理員可以核准待審核的訂單', audit: '記下被拒絕的核准', tests: ['TC-006-02'], final: '維持原本的狀態' },
      edge: { text: '已核准的訂單不能重複核准，否則同一批庫存可能被重複計算', tests: [] },
      code: ['ERP.approveOrder', 'Rules.canApprove'],
      tasks: [
        '實作 ERP.approveOrder(db, userId, orderId)：只有老闆或管理員、只處理 SUBMITTED；只改狀態為 APPROVED，不動庫存',
        '不是老闆、或訂單不是待審核：拒絕並寫 APPROVE_DENIED 稽核，資料完全不變'
      ]
    }),
    tpl({
      id: 'RULE-007', title: '老闆拒絕待審核的訂單，並釋放預留', primary: 'REQ-010', reqs: ['REQ-010'], difficulty: '單據狀態與回滾',
      if: '訂單目前是「待審核」，而且操作的人是老闆或管理員',
      t: { action: '拒絕；訂單變成「已拒絕」', effect: '釋放這張單預留的數量，可用庫存恢復', message: '已拒絕，預留已釋放', audit: '記下拒絕與原因', tests: ['TC-007-01'], final: '已拒絕（未預留）' },
      f: { action: '不能拒絕（操作的人不是老闆或管理員，或訂單不是待審核）', effect: '訂單與庫存完全不變', message: '只有老闆或管理員可以拒絕待審核的訂單', audit: '記下被拒絕的操作', tests: ['TC-007-02'], final: '維持原本的狀態' },
      edge: { text: '拒絕後一定要把預留還回去，否則庫存會一直被卡住', tests: [] },
      code: ['ERP.rejectOrder', 'Rules.canReject'],
      tasks: [
        '實作 ERP.rejectOrder(db, userId, orderId, reason)：只有老闆或管理員、只處理 SUBMITTED；狀態改 REJECTED，reserved −= qty',
        '不是老闆、或訂單不是待審核：拒絕並寫 REJECT_DENIED 稽核，資料完全不變'
      ]
    }),
    tpl({
      id: 'RULE-008', title: '取消已核准的訂單（釋放預留）', primary: 'REQ-008', reqs: ['REQ-008'], difficulty: '單據狀態與回滾',
      if: '訂單目前是「已核准」，而且還沒出貨',
      t: { action: '取消；訂單變成「已取消」', effect: '釋放預留，可用庫存恢復', message: '已取消並釋放預留', audit: '記下取消', tests: [], final: '已取消' },
      f: { action: '', effect: '庫存與預留不變', message: '只有已核准且還沒出貨的訂單可以取消', audit: '記下被拒絕的取消', tests: [], final: '維持原本的狀態' },
      edge: { text: '部分出貨後取消：只釋放還沒出貨的那一部分', tests: [] },
      note: 'AI 草稿：缺「不成立時要做什麼」和「驗收案例」，所以先不交給 AI 開發。'
    }),
    tpl({
      id: 'RULE-009', title: '寄庫：購買當下就扣庫存，之後分次取貨', primary: 'REQ-011', reqs: ['REQ-011', 'REQ-017'], difficulty: '例外交易（部分出貨、寄庫）',
      if: '訂購數 ＞ 當次出貨數（多出來的條數要寄放在店裡）',
      t: { action: '全部訂購數都從庫存扣掉；當次出貨的條數交給客戶，其餘登記為「客戶寄庫」', effect: '庫存減少「訂購數」；這位客戶的寄庫餘額增加「訂購數 − 當次出貨數」', message: '已完成：當次出貨 M 條，寄庫 K 條', audit: '記下訂購、當次出貨、寄庫各多少條', tests: [], final: '訂單已完成；客戶寄庫餘額增加' },
      f: { action: '不產生寄庫，照一般訂單處理（全部當次出貨）', effect: '庫存減少「訂購數」；寄庫餘額不變', message: '已完成：全部當次出貨', audit: '記下訂購與當次出貨條數', tests: [], final: '訂單已完成；寄庫餘額不變' },
      edge: { text: '客戶之後來取寄庫：只扣寄庫餘額，不再扣庫存；同一客戶每次申請最多合併 5 項', tests: [] },
      note: '已決定採用旺盛輪業的做法（購買當下就扣庫存），規則內容已依此寫好；但還沒有驗收案例，所以先不能開發。'
    }),
    tpl({
      id: 'RULE-015', title: '一鍵複製庫存回覆 LINE', primary: 'REQ-009', reqs: ['REQ-009'], difficulty: '權限與敏感資料',
      if: '查詢結果至少選了一個品項', t: { action: '產生回覆文字並複製（不含成本）' }, note: 'AI 草稿：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-016', title: '依生產日期顯示庫齡顏色', primary: 'REQ-012', reqs: ['REQ-012'], difficulty: '報表口徑',
      if: '生產日期距今 ≤ 1 年／1–2 年／2–3 年', note: 'AI 草稿：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-017', title: '下班後也能叫貨', primary: 'REQ-013', reqs: ['REQ-013'], difficulty: '單據狀態與回滾',
      if: '送出的時間在營業時間之外', note: 'AI 草稿：只寫了條件，其餘要由人補齊'
    }),
    // ---- 參考 ERP 案例的候選規則（只寫了條件，示範「寫不完整就不能開發」）----
    tpl({
      id: 'RULE-018', title: '依批次扣庫存', primary: 'REQ-016', reqs: ['REQ-016'], difficulty: '庫存時間差、超賣',
      if: '要出貨的批次，可用數量 ≥ 要出的數量', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-019', title: '訂單明細：訂購數 ＝ 當次出貨 ＋ 客戶寄庫', primary: 'REQ-017', reqs: ['REQ-017'], difficulty: '例外交易（部分出貨、寄庫）',
      if: '每個品項：當次出貨數 ＋ 客戶寄庫數 ＝ 訂購數', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-020', title: '取消出貨並依原批次復原庫存', primary: 'REQ-018', reqs: ['REQ-018'], difficulty: '單據狀態與回滾',
      if: '訂單目前是「已出貨」', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-021', title: '進貨入庫', primary: 'REQ-019', reqs: ['REQ-019'], difficulty: '盤點與校正',
      if: '進貨數量是大於 0 的整數，操作的人是老闆或管理員，而且商品存在',
      t: { action: '進貨：在庫增加，並留下進貨單號', effect: '在庫增加進貨數量；預留不變，所以可用庫存跟著增加', message: '進貨完成：商品 ＋N 條（進貨單 RC-xxxx）', audit: '記下誰、哪個商品、進貨幾條、進貨單號', tests: ['TC-021-01'], final: '在庫已增加，進貨單已留存' },
      f: { action: '拒絕進貨', effect: '庫存與進貨單完全不變', message: '進貨數量必須為正整數／只有老闆或管理員可以進貨', audit: '記下被拒絕的進貨與原因', tests: ['TC-021-02'], final: '庫存不變、沒有進貨單' },
      edge: { text: '同一個商品連續進貨，在庫逐次累加，進貨單號依序不重複', tests: ['TC-021-03'] },
      code: ['ERP.receiveStock'],
      tasks: [
        '實作 ERP.receiveStock(db, userId, sku, qty, note)：只有老闆或管理員；數量用 Rules.isPositiveInt 檢查',
        '成功：on_hand += qty、寫進貨單（RC-0001 起依序編號）、稽核 RECEIVED；失敗：資料完全不變、稽核 RECEIVE_DENIED'
      ]
    }),
    tpl({
      id: 'RULE-010', title: '出貨完成：在庫與預留一起扣掉', primary: 'REQ-024', reqs: ['REQ-024'], difficulty: '單據狀態與回滾',
      if: '訂單目前是「已核准」，而且操作的人是老闆或管理員',
      t: { action: '出貨完成；訂單變成「已出貨」', effect: '在庫和預留各扣掉訂購條數（預留被用掉）；可用庫存不變', message: '出貨完成（在庫 130 → 128），預留已用掉', audit: '記下誰出貨了哪張單、各品項在庫變化', tests: ['TC-010-01'], final: '已出貨' },
      f: { action: '不能出貨（不是老闆或管理員，或訂單不是已核准）', effect: '訂單與庫存完全不變', message: '只有已核准的訂單可以出貨', audit: '記下被拒絕的出貨與原因', tests: ['TC-010-02'], final: '維持原本的狀態' },
      edge: { text: '同一張單不能重複出貨，否則在庫會被扣兩次', tests: ['TC-010-03'] },
      code: ['ERP.shipOrder', 'Rules.canShip'],
      tasks: [
        '實作 ERP.shipOrder(db, userId, orderId)：只有老闆或管理員、只處理 APPROVED；每個品項 on_hand −= qty 且 reserved −= qty',
        '狀態改 SHIPPED；稽核 SHIPPED；任何一項在庫或預留不足就整張不出貨（SHIP_DENIED），資料完全不變'
      ]
    }),
    tpl({
      id: 'RULE-011', title: '老闆新增商品、修改售價與成本', primary: 'REQ-025', reqs: ['REQ-025'], difficulty: '權限與敏感資料',
      if: '操作的人是老闆或管理員，品牌與規格有填，年份是 4 位數，售價大於 0、成本不是負數，而且不是已經有的商品',
      t: { action: '新增商品（在庫從 0 開始），或更新售價與成本', effect: '商品清單多一筆（或價格改變）；其他商品與庫存不變', message: '已新增商品 TR-009（在庫 0，要進貨才有庫存）', audit: '記下新增或改價的人、商品、改前改後的數字', tests: ['TC-011-01'], final: '商品已建立或價格已更新' },
      f: { action: '拒絕新增或修改', effect: '商品清單與價格完全不變', message: '只有老闆或管理員可以新增商品／品牌和規格一定要填／售價要大於 0', audit: '記下被拒絕的操作與原因', tests: ['TC-011-02'], final: '商品清單不變' },
      edge: { text: '品牌、型號、規格、年份都相同的商品不可重複新增；商品編號依序不跳號', tests: ['TC-011-03'] },
      code: ['ERP.addProduct', 'ERP.updateProduct'],
      tasks: [
        '實作 ERP.addProduct(db, userId, fields)：只有老闆或管理員；檢查必填、年份、價格、不重複；編號為現有最大編號 ＋ 1',
        '實作 ERP.updateProduct(db, userId, sku, { price, cost })：只有老闆或管理員；價格要大於 0；沒有變動也算拒絕',
        '業務查詢結果仍不可含 cost（RULE-001）'
      ]
    }),
    tpl({
      id: 'RULE-026', title: '低庫存警示：可用庫存低於安全庫存就提醒', primary: 'REQ-026', reqs: ['REQ-026'], difficulty: '報表口徑',
      if: '商品有設安全庫存（大於 0），而且「可用庫存」（在庫 − 預留）低於安全庫存；「低於」目前是「小於」，剛好等於不算（要改成「小於或等於」，要走「變更需求」）',
      t: { action: '標示「低庫存」，並列入老闆的提醒清單', effect: '只是顯示提醒，庫存、預留、訂單都不會改', message: '低庫存：可用 N，安全庫存 M', audit: '不用另外記錄（只是顯示，沒有改資料）', tests: ['TC-026-01'], final: '不影響任何訂單的狀態' },
      f: { action: '不標示、不提醒', effect: '什麼都不改', message: '（沒有提醒）', audit: '不用另外記錄（只是顯示，沒有改資料）', tests: ['TC-026-02'], final: '不影響任何訂單的狀態' },
      edge: { text: '可用「剛好等於」安全庫存：目前規則不提醒，改成「小於或等於」後就會提醒。規則一改，這個案例的預期也跟著變，所以一定要走變更流程並重跑測試', tests: ['TC-026-03', 'TC-026-04'] },
      code: ['ERP.view.lowStock', 'Rules.isLowStock'],
      tasks: [
        '實作 Rules.isLowStock(product, op)：安全庫存大於 0，且可用庫存小於（lt）或小於或等於（le）安全庫存',
        '實作 ERP.view.lowStock(db)：依 db.settings.low_stock_op 列出低庫存商品（唯讀，不寫稽核）',
        '畫面：庫存表標示「低庫存」，老闆看得到提醒清單與目前使用的規則'
      ]
    }),
    tpl({
      id: 'RULE-027', title: '老闆設定每個商品的安全庫存', primary: 'REQ-026', reqs: ['REQ-026'], difficulty: '權限與敏感資料',
      if: '操作的人是老闆或管理員，商品存在，安全庫存是 0 或正整數（0 代表不設警示）',
      t: { action: '更新這個商品的安全庫存', effect: '只改這個商品的安全庫存；在庫、預留、價格都不變', message: '已設定 205/55R16 的安全庫存：20 → 30', audit: '記下誰把哪個商品的安全庫存從幾改成幾', tests: ['TC-027-01'], final: '安全庫存已更新' },
      f: { action: '拒絕設定', effect: '安全庫存完全不變', message: '只有老闆或管理員可以設定安全庫存／安全庫存要填 0 或正整數', audit: '記下被拒絕的設定與原因', tests: ['TC-027-02'], final: '安全庫存維持原值' },
      edge: { text: '設成 0 代表不設警示：這個商品不會再出現在提醒清單', tests: ['TC-027-03'] },
      code: ['ERP.setSafetyStock', 'Rules.isNonNegInt'],
      tasks: [
        '實作 ERP.setSafetyStock(db, userId, sku, qty)：只有老闆或管理員；數量用 Rules.isNonNegInt 檢查',
        '成功：寫 product.safety、稽核 SAFETY_SET（記前後數字）；失敗：資料完全不變、稽核 SAFETY_DENIED'
      ]
    }),
    tpl({
      id: 'RULE-028', title: '修改低庫存的比較方式（要寫理由，留前後紀錄）', primary: 'REQ-026', reqs: ['REQ-026'], difficulty: '單據狀態與回滾',
      if: '操作的人是老闆或管理員，選的比較方式和目前不同，而且有寫理由',
      t: { action: '改成新的比較方式（小於 或 小於等於）', effect: '只改「低庫存的比較方式」這一個設定；提醒清單依新規則重算；庫存、預留都不變', message: '低庫存規則已改：小於 → 小於或等於', audit: '記下誰把規則從什麼改成什麼，以及理由', tests: ['TC-028-01'], final: '新規則生效，原規則留在紀錄裡，可以回復' },
      f: { action: '拒絕修改', effect: '設定完全不變', message: '只有老闆或管理員可以改／要寫理由／和目前的一樣', audit: '記下被拒絕的修改與原因', tests: ['TC-028-02'], final: '維持原本的規則' },
      edge: { text: '改過之後可以改回去（回復），回復同樣要寫理由並留下紀錄', tests: [] },
      code: ['ERP.setLowStockRule'],
      tasks: [
        '實作 ERP.setLowStockRule(db, userId, op, reason)：只有老闆或管理員；op 只能是 lt 或 le；理由不可空白；和目前相同要拒絕',
        '成功：寫 db.settings.low_stock_op、稽核 LOWRULE_CHANGED（記前後與理由）；失敗：設定完全不變、稽核 LOWRULE_DENIED'
      ]
    }),
    tpl({
      id: 'RULE-029', title: '登入：帳號與密碼正確才能進入', primary: 'REQ-027', reqs: ['REQ-027'], difficulty: '權限與敏感資料',
      if: '輸入的帳號存在，而且密碼正確',
      t: { action: '登入成功，進入系統；畫面依角色顯示', effect: '只多一筆登入紀錄；庫存、訂單都不變', message: '登入成功：王老闆（老闆）', audit: '記下誰登入了', tests: ['TC-029-01'], final: '已登入，權限依角色決定' },
      f: { action: '不登入，也不說明是帳號錯還是密碼錯', effect: '資料完全不變（只多一筆失敗紀錄）', message: '帳號或密碼不正確', audit: '記下失敗的登入（輸入的帳號、時間）', tests: ['TC-029-02'], final: '維持未登入' },
      edge: { text: '密碼不會出現在登入結果、查詢結果與稽核紀錄裡；空白的帳號或密碼一律當成失敗', tests: ['TC-029-03'] },
      code: ['ERP.login', 'ERP.logout'],
      tasks: [
        '實作 ERP.login(db, account, password)：帳號不分大小寫；密碼要完全相符；失敗時不透露是哪一個錯',
        '成功：稽核 LOGIN（記使用者）；失敗：資料完全不變、稽核 LOGIN_DENIED；回傳資料不含密碼',
        '實作 ERP.logout(db, userId)：稽核 LOGOUT',
        '提醒：這是前端示範用登入，不是真正的資安防護（沒有伺服器端驗證）'
      ]
    }),
    tpl({
      id: 'RULE-030', title: '角色權限：管理員與老闆全部，員工只能查詢（業務可叫貨）', primary: 'REQ-027', reqs: ['REQ-027', 'REQ-006'], difficulty: '權限與敏感資料',
      if: '操作的人是管理員或老闆（管理權限），或是員工（業務、倉管、生管），而且這個動作在他的權限內',
      t: { action: '照常執行：管理員與老闆全部都可以；員工只能查庫存，業務另外可以叫貨', effect: '依各項功能自己的規則改資料', message: '（依各項功能的成功訊息）', audit: '記下是誰做的', tests: ['TC-030-01'], final: '依各項功能的規則' },
      f: { action: '拒絕：沒有權限的動作（核准、出貨、進貨、新增商品、改價、設定安全庫存、倉管與生管叫貨）', effect: '資料完全不變', message: '只有老闆或管理員可以…／只有業務可以叫貨', audit: '記下被拒絕的操作與原因', tests: ['TC-030-03', 'TC-030-04'], final: '維持原本的狀態' },
      edge: { text: '員工看得到店家價、末端價、庫存與安全庫存，但看不到成本與毛利；這個限制由查詢函式負責，不是只靠畫面把欄位藏起來', tests: ['TC-030-02'] },
      code: ['Rules.isManager', 'Rules.isStaff', 'Rules.viewFor', 'ERP.queryStock'],
      tasks: [
        '角色以 db.users 為準，不信任畫面傳入的角色；管理權限＝admin 或 boss（Rules.isManager）',
        '員工的查詢結果用白名單欄位（Rules.SALES_FIELDS），不含 cost、margin',
        '管理動作（核准、拒絕、退回、出貨、進貨、新增商品、改價、設定安全庫存、改低庫存規則）只有管理權限可做；叫貨只有業務可做'
      ]
    }),
    tpl({
      id: 'RULE-022', title: '庫存校正（以實際盤點為準）', primary: 'REQ-020', reqs: ['REQ-020'], difficulty: '盤點與校正',
      if: '管理員輸入的實際盤點數是 0 或更大的整數', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-023', title: '倉庫之間移庫', primary: 'REQ-021', reqs: ['REQ-021'], difficulty: '庫存時間差、超賣',
      if: '移庫數量 ≤ 來源批次的可用數量（不含預留與寄庫）', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-024', title: '實際售價預設 9 折，可修改', primary: 'REQ-022', reqs: ['REQ-022'], difficulty: '金額計算',
      if: '業務輸入的實際售價是大於 0 的數字', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    }),
    tpl({
      id: 'RULE-025', title: 'Excel 匯入前先比對差異', primary: 'REQ-023', reqs: ['REQ-023'], difficulty: '舊資料匯入',
      if: '匯入的 Excel 與目前資料相比，沒有「不可修改的欄位」被改動', note: 'AI 草稿（參考旺盛輪業 ERP）：只寫了條件，其餘要由人補齊'
    })
  ];

  // =====================================================================
  // AI 建議草稿：只補「還是空白」的欄位；補完要由人按「我看過了」確認，規則才算寫完整
  // 驗收案例不在這裡寫死：由 deriveCases 依規則內容整理出來
  var AI_DRAFTS = {
    'RULE-008': {
      f: { action: '不取消，訂單維持原本的狀態' }
    },
    'RULE-015': {
      t: { effect: '只是產生文字，不改任何資料', message: '已複製回覆文字（規格、可用數量、店家價；不含成本）', audit: '記下誰複製了哪些品項', final: '資料不變' },
      f: { action: '不產生回覆文字，提醒先選品項', effect: '不改任何資料', message: '請先在查詢結果選至少一個品項', audit: '記下沒選品項的操作', final: '資料不變' }
    },
    'RULE-016': {
      t: { action: '依生產日期距今，在庫存表標上庫齡顏色：1 年內綠色、1–2 年黃色、2–3 年橘色', effect: '只改畫面顏色，不改任何庫存資料', message: '庫齡：N 個月（顏色）', audit: '只是顯示，不另留紀錄', final: '資料不變' },
      f: { action: '沒有生產日期或超過 3 年：標示「無法計算庫齡」', effect: '只改畫面顯示，不改任何庫存資料', message: '無法計算庫齡', audit: '只是顯示，不另留紀錄', final: '資料不變' }
    },
    'RULE-017': {
      t: { action: '照常接受送出並預留，訂單變成「待審核」，隔天由老闆審核', effect: '「預留」增加，可用庫存減少（和上班時間一樣）', message: '已送出並預留，老闆上班後會審核', audit: '記下送出的時間，並註明「營業時間外」', final: '待審核（已預留）' },
      f: { action: '營業時間內送出：照一般流程送出並預留', effect: '「預留」增加，可用庫存減少', message: '已送出並預留，等待老闆核准', audit: '記下送出', final: '待審核（已預留）' }
    },
    'RULE-018': {
      t: { action: '出貨時從這個批次扣庫存', effect: '這個批次的在庫與預留一起減少出貨的條數；其他批次不變', message: '已從批次 XXXX 出貨 N 條', audit: '記下哪個批次、出貨幾條', final: '已出貨' },
      f: { action: '不能從這個批次出貨，請改選其他批次或減少數量', effect: '所有批次的庫存完全不變', message: '這個批次可用數量不足（剩 N）', audit: '記下被拒絕的出貨與批次', final: '維持已核准' }
    },
    'RULE-019': {
      t: { action: '接受這筆明細，三個數字都記下來', effect: '訂單記下訂購數、當次出貨數、客戶寄庫數', message: '明細已記錄', audit: '記下三個數字', final: '明細完成' },
      f: { action: '不接受這筆明細，請修正數字', effect: '訂單與庫存完全不變', message: '當次出貨數 ＋ 客戶寄庫數必須等於訂購數', audit: '記下被拒絕的明細與原因', final: '維持原本的狀態' }
    },
    'RULE-020': {
      t: { action: '取消出貨；訂單變成「已取消」', effect: '依原批次把出貨的條數加回在庫', message: '已取消出貨，庫存已依原批次復原', audit: '記下誰取消、復原了哪些批次與條數', final: '已取消' },
      f: { action: '不是「已出貨」的訂單，不能取消出貨', effect: '庫存完全不變', message: '只有已出貨的訂單才能取消出貨', audit: '記下被拒絕的取消', final: '維持原本的狀態' }
    },
    'RULE-022': {
      t: { action: '把在庫改成實際盤點數，並留下校正紀錄', effect: '在庫＝盤點數（預留不變）；紀錄「校正前、校正後、差異」', message: '已校正：原 N 條 → 實際 M 條', audit: '記下誰、哪個商品、校正前後的數字與原因', final: '庫存已校正（可取消並回復）' },
      f: { action: '不校正', effect: '庫存與校正紀錄完全不變', message: '盤點數必須是 0 或更大的整數', audit: '記下被拒絕的校正', final: '庫存不變' },
      edge: '盤點數如果比已預留的數量還少，不能校正（要先處理預留的訂單）'
    },
    'RULE-023': {
      t: { action: '把這些條數從來源倉移到目的倉', effect: '來源倉在庫減少、目的倉在庫增加，總在庫不變；預留與寄庫的不動', message: '已移庫：來源倉 −N 條、目的倉 ＋N 條', audit: '記下誰、從哪個倉移到哪個倉、幾條', final: '移庫完成' },
      f: { action: '不移庫', effect: '兩邊倉庫的庫存完全不變', message: '移庫數量超過來源倉的可用數量（剩 N 條）', audit: '記下被拒絕的移庫', final: '庫存不變' }
    },
    'RULE-024': {
      t: { action: '接受這個實際售價，記在這一筆交易上', effect: '只改這一筆明細的成交價，不改商品的牌價', message: '已使用實際售價', audit: '記下牌價、實際售價、是誰改的', final: '明細已記錄實際售價' },
      f: { action: '不接受，維持預設的牌價 9 折', effect: '成交價維持預設，商品牌價不變', message: '實際售價必須是大於 0 的數字', audit: '記下被拒絕的售價', final: '維持預設 9 折' }
    },
    'RULE-025': {
      t: { action: '顯示差異清單，老闆確認後才套用匯入', effect: '確認前不改任何資料；確認後只更新有差異、而且允許修改的欄位', message: '找到 N 筆差異，請確認後再匯入', audit: '記下誰匯入、哪個檔案、改了哪幾筆', final: '匯入完成（可由備份還原）' },
      f: { action: '整份都不匯入，並列出被改動的「不可修改的欄位」', effect: '資料完全不變', message: '有不可修改的欄位被改動（例如商品編號），整份不匯入', audit: '記下被拒絕的匯入與原因', final: '資料不變' },
      edge: '匯入前先自動備份，出錯時可以還原'
    }
  };

  function stripEnd(s) { return String(s == null ? '' : s).replace(/[。；;，,\s]+$/, ''); }

  // 依規則內容整理驗收案例：成立、不成立各一個（那一邊已經有案例就跳過）
  function deriveCases(rule) {
    var out = [];
    if (!filled(rule.if)) return out;
    [['t', '成立'], ['f', '不成立']].forEach(function (p) {
      var s = rule[p[0]] || {};
      if (list(s.tests).length || !filled(s.action)) return;
      var given = (p[0] === 't' ? '下面這個情況成立時：' : '反過來，下面這個情況不成立時：') + stripEnd(rule.if);
      var expect = stripEnd(s.action) + (filled(s.effect) ? '；' + stripEnd(s.effect) : '') + (filled(s.message) ? '；畫面顯示「' + stripEnd(s.message) + '」' : '');
      out.push({ side: p[0], given: given, expect: expect });
    });
    return out;
  }

  // AI 還有沒有東西可以幫忙補（草稿裡有空白欄位，或有一邊可以整理驗收案例）
  function aiCanHelp(rule) {
    var d = AI_DRAFTS[rule.id] || {};
    var empty = false;
    ['t', 'f'].forEach(function (side) {
      Object.keys(d[side] || {}).forEach(function (k) { if (!filled((rule[side] || {})[k])) empty = true; });
    });
    if (d.edge && !filled((rule.edge || {}).text)) empty = true;
    return empty || deriveCases(rule).length > 0;
  }

  // =====================================================================
  // ERP 九大難點（AI 必問的問題）、訂單狀態機、RRB
  // =====================================================================
  var DIFFICULTIES = [
    { name: '庫存時間差、超賣', rule: 'RULE-003', v1: '做', ask: '出貨後庫存多久才扣？兩個人同時賣最後一條怎麼辦？' },
    { name: '權限與敏感資料', rule: 'RULE-001', v1: '做', ask: '哪些角色可以看到成本、毛利？' },
    { name: '單據狀態與回滾', rule: 'RULE-005／008', v1: '部分', ask: '送出後能不能改？退回、取消時庫存怎麼回復？' },
    { name: '例外交易（部分出貨、寄庫）', rule: 'RULE-009', v1: '候選', ask: '客戶會一次買多條、分次取貨嗎？' },
    { name: '盤點與校正', rule: 'RULE-022', v1: '候選', ask: '盤點差異由誰調整？要不要留紀錄？' },
    { name: '金額計算', rule: 'RULE-024', v1: '候選', ask: '折扣、稅、四捨五入在哪一步算？' },
    { name: '舊資料匯入', rule: 'RULE-025', v1: '候選', ask: '現有 Excel 庫存怎麼匯入？錯誤資料怎麼處理？' },
    { name: '與舊系統並存', rule: 'RULE-013', v1: '候選', ask: '上線期間舊系統還用嗎？以哪邊為準？' },
    { name: '報表口徑', rule: 'RULE-014', v1: '候選', ask: '「庫存」報表算在庫還是可用？' }
  ];

  var STATE_MACHINE = [
    { from: 'DRAFT', to: 'SUBMITTED', cond: '業務送出：數量正確、可用庫存足夠 → 立刻預留', rule: 'RULE-003', v1: true },
    { from: 'SUBMITTED', to: 'APPROVED', cond: '老闆核准（庫存不變，預留早就建立了）', rule: 'RULE-006', v1: true },
    { from: 'SUBMITTED', to: 'REJECTED', cond: '老闆拒絕 → 釋放預留', rule: 'RULE-007', v1: true },
    { from: 'SUBMITTED', to: 'RETURNED', cond: '老闆退回 → 釋放預留，業務可修改', rule: 'RULE-005', v1: true },
    { from: 'RETURNED', to: 'SUBMITTED', cond: '業務修改後重送（再檢查庫存並預留）', rule: 'RULE-003', v1: true },
    { from: 'APPROVED', to: 'SHIPPED', cond: '老闆按「出貨完成」→ 在庫與預留一起扣掉', rule: 'RULE-010', v1: true },
    { from: 'APPROVED', to: 'PARTIALLY_SHIPPED', cond: '部分出貨 → 只扣出貨的部分', rule: 'RULE-009', v1: false },
    { from: 'PARTIALLY_SHIPPED', to: 'SHIPPED', cond: '出完剩餘', rule: '—', v1: false },
    { from: 'APPROVED', to: 'CANCELLED', cond: '取消 → 釋放預留', rule: 'RULE-008', v1: false },
    { from: 'PARTIALLY_SHIPPED', to: 'CANCELLED', cond: '取消未出貨部分 → 釋放剩餘預留', rule: 'RULE-008', v1: false }
  ];

  // 參考需求基準 RRB（凍結前為示意）；AI 找到 = 訪談中出現對應需求（不論人是否採納）
  // ref：參考 ERP 案例（旺盛輪業）有沒有看到對應功能（2026-10-13 唯讀瀏覽；空字串＝沒看到）
  var RRB = [
    { name: '預留與可用庫存', reqs: ['REQ-004', 'REQ-004B', 'REQ-005'], v1: true, ref: '庫存卡有「預留」「寄庫」「可叫貨」欄位（預留何時建立未驗證）' },
    { name: '成本權限', reqs: ['REQ-006'], v1: true, ref: '' },
    { name: '複製回覆 LINE', reqs: ['REQ-009'], v1: false, ref: '庫存卡有「複製」按鈕' },
    { name: '叫貨審核', reqs: ['REQ-002', 'REQ-007', 'REQ-010'], v1: true, ref: '訂單有待審核、已完成、已退回、已取消' },
    { name: '寄庫', reqs: ['REQ-011'], v1: false, ref: '有「客戶寄庫」頁與寄庫出貨申請' },
    { name: '庫齡', reqs: ['REQ-012'], v1: false, ref: '每個批次顯示庫齡' },
    { name: '下班可叫貨', reqs: ['REQ-013'], v1: false, ref: '' }
  ];

  // =====================================================================
  // 4. AI 需求訪談引擎（示範版）
  // =====================================================================
  var STEP_SOURCE = ['初始需求', '訪談 Q1–2', '訪談 Q3–4', '訪談 Q5', '訪談 Q6–7', '訪談補充'];
  var DONE_STEP = 5;

  var PATTERNS = [
    { re: /庫存|有沒有貨|查/, req: 'REQ-001', status: 'pending' },
    { re: /開單|叫貨|下單|訂單/, req: 'REQ-002', status: 'pending' },
    { re: /超賣|銷帳|扣掉|扣庫存|延遲|搶走|叫走/, req: 'REQ-005', status: 'pending' },
    { re: /LINE|賴/i, req: 'REQ-009', status: 'ai' },
    { re: /寄庫|分次/, req: 'REQ-011', status: 'ai' },
    { re: /年份|年分|庫齡|太舊|生產日期/, req: 'REQ-012', status: 'ai' },
    { re: /退回|改完|修改後|重送|重新送/, req: 'REQ-007', status: 'pending' },
    { re: /整數|不能是 ?0|不可為 ?0|不能為 ?0|負/, req: 'REQ-003', status: 'pending' },
    { re: /下班|晚上|假日/, req: 'REQ-013', status: 'ai' },
    { re: /核准|審核|拒絕|同意/, req: 'REQ-010', status: 'pending' }
  ];
  var NEG_COST = /不(能|可|要|行|應|該|准|給)|看不到|禁止|只有老闆/;

  var CHIPS = [
    null, // step 0 用專案的一句話需求
    ['會回 LINE 給客戶，有時直接請內勤開單。出貨要等內勤銷帳，熱門規格可能超賣。'],
    ['送出時就先預留，免得其他業務把同一批庫存叫走。有些客戶會寄庫分次拿，年份太舊的要便宜賣。', '老闆核准時才預留。有些客戶會寄庫分次拿，年份太舊的要便宜賣。'],
    ['業務不能看到成本，只有老闆可以看。'],
    ['退回讓業務改完再送。數量一定是整數條，不能是 0 或負的。']
  ];
  var DEFAULT_NEED = '我想讓公司的業務在外面可以查到輪胎有沒有貨。';

  function interviewChips(step, wb) {
    if (step === 0) return [wb.project.need || DEFAULT_NEED];
    return CHIPS[step] ? CHIPS[step].slice() : [];
  }

  function detectTiming(t) {
    var approve = /(核准|審核|同意)[^，。,；;！!？?]{0,6}預留|核准(時|後)?才|核准時/.test(t);
    var submit = /(送出|下單|叫貨)[^，。,；;！!？?]{0,6}預留|送出(就|即)|一送出/.test(t);
    if (/不(要|是|用|必)[^，。,；;]{0,3}(送出|下單)/.test(t)) submit = false;
    if (/不(要|是|用|必)[^，。,；;]{0,3}(核准|審核)/.test(t)) approve = false;
    if (approve && !submit) return 'REQ-004';
    if (submit && !approve) return 'REQ-004B';
    return null;
  }

  // 回傳 { ai, adds:[{id,status,source,evidence,note}], questions:[], nextStep }
  function interviewRespond(wb, text) {
    var step = wb.interview.step;
    var have = {};
    wb.requirements.forEach(function (r) { have[r.id] = true; });
    var adds = [];
    var qs = [];
    var src = STEP_SOURCE[Math.min(step, DONE_STEP)];

    function exists(id) { return have[id] || adds.some(function (a) { return a.id === id; }); }
    function add(id, status, note, source, evidence) {
      if (exists(id)) return;
      adds.push({
        id: id, status: status,
        source: source || (status === 'ai' ? src + '（AI 建議）' : src),
        evidence: evidence || text, note: note || ''
      });
    }

    PATTERNS.forEach(function (p) { if (p.re.test(text)) add(p.req, p.status); });

    if (/成本|毛利/.test(text)) {
      if (NEG_COST.test(text)) add('REQ-006', 'pending');
      else {
        add('REQ-006', 'ai', '回答沒有說不能看；AI 依「權限與敏感資料」難點建議禁止');
        qs.push('業務能不能看到成本？（回答沒有明確禁止）');
      }
    }

    var timing = null;
    if (!have['REQ-004'] && !have['REQ-004B']) {
      timing = detectTiming(text);
      if (timing) {
        var other = timing === 'REQ-004' ? 'REQ-004B' : 'REQ-004';
        add(timing, 'pending', '預留時機（二選一）', src);
        add(other, 'ai', '替代方案：與 ' + timing + ' 二選一，兩者不可同時確認', 'AI 提出替代方案');
      } else if (step === 2) {
        add('REQ-004', 'ai', '預留時機還沒決定：與 REQ-004B 二選一', 'AI 提出替代方案');
        add('REQ-004B', 'ai', '預留時機還沒決定：與 REQ-004 二選一', 'AI 提出替代方案');
        qs.push('預留時機：送出就預留，還是核准才預留？（回答沒有說明確）');
      }
    }

    var ai;
    var next = Math.min(step + 1, DONE_STEP);
    switch (step) {
      case 0:
        if (!exists('REQ-001')) add('REQ-001', 'pending');
        ai = '了解。先確認幾件事：\n1. 業務查到庫存後，下一步通常做什麼？（回覆客戶？直接下單？）\n2. 出貨後，庫存多久才會在公司系統扣掉？';
        break;
      case 1:
        if (!exists('REQ-005')) add('REQ-005', 'ai', '扣帳有時間差 → AI 推論需要區分「在庫」與「可用」');
        ai = '這表示需要**預留機制**，並區分「庫存」與「可用庫存」。要在**送出時**就預留，還是**老闆核准時**才預留？\n另外想確認：\n3. 客戶會一次買多條、分次取貨（寄庫）嗎？\n4. 輪胎年份會影響售價嗎？';
        break;
      case 2:
        if (timing === 'REQ-004') ai = '記下了：**核准時才預留**。「送出就預留」列為二選一的替代方案，請在「確認需求」選一個。';
        else if (timing === 'REQ-004B') ai = '記下了：**送出就預留**。「核准才預留」列為二選一的替代方案，請在「確認需求」選一個。';
        else ai = '預留時機還沒有明確答案，我先把兩個方案都列為「AI 建議」，並放進「還有疑問」。';
        ai += '\n接著是權限與敏感資料：\n5. 業務在外面查詢時，可以看到進貨成本或毛利嗎？';
        break;
      case 3:
        if (!exists('REQ-006')) {
          add('REQ-006', 'ai', 'AI 依「權限與敏感資料」難點建議：業務不可看成本');
          qs.push('業務能不能看到成本？（尚未回答）');
        }
        ai = '最後兩個關於單據狀態的問題：\n6. 老闆審核時發現叫貨單有問題（例如數量打錯），要直接拒絕，還是退回讓業務修改後重送？\n7. 叫貨數量有沒有限制？（例如只能整數條、不可為 0）';
        break;
      case 4:
        if (!exists('REQ-003')) add('REQ-003', 'ai', 'AI 依「單據狀態」難點推論');
        if (!exists('REQ-007')) qs.push('老闆發現叫貨單有問題時：直接拒絕，還是退回修改？');
        var inferred = 'AI 依 ERP 難點檢核清單推論（沒有使用者原話）';
        add('REQ-010', 'ai', 'AI 依「單據狀態」難點推論：老闆要能核准或拒絕待審核單；送出即預留時，拒絕要釋放預留', 'AI 流程走查', inferred);
        add('REQ-008', 'ai', '', 'AI 流程走查', inferred);
        add('REQ-011', 'ai', '', 'AI 流程走查', inferred);
        add('REQ-012', 'ai', '', 'AI 角色推演（財務）', inferred);
        add('REQ-013', 'ai', '', 'AI 參考模型', inferred);
        add('REQ-015', 'ai', '', 'AI 參考模型', inferred);
        add('REQ-024', 'ai', '核准之後要有「出貨完成」這一步，在庫才會真正減少', 'AI 流程走查', inferred);
        add('REQ-025', 'ai', '', 'AI 流程走查', inferred);
        add('REQ-026', 'ai', '', 'AI 流程走查', inferred);
        add('REQ-027', 'ai', '', 'AI 流程走查', inferred);
        REF_CANDIDATES.forEach(function (id) { add(id, 'ai', '', REF_SOURCE, REF_EVIDENCE[id]); });
        var early = wb.requirements.some(function (r) { return r.id === 'REQ-004B' && r.status === 'pending'; });
        qs.push('老闆退回或拒絕時，預留要不要釋放？' + (early ? '（送出就預留 → AI 建議：要釋放，否則庫存會被卡住）' : '（核准才預留 → 退回時還沒預留，AI 建議：不用釋放）'));
        qs.push('低庫存是「小於」還是「小於或等於」安全庫存？（系統先用「小於」；之後想改，到「變更需求」走變更流程，系統會先列出影響範圍）');
        qs.push(early ? '兩位業務同時送出同一批最後庫存怎麼辦？（AI 建議：送出時重新查庫存，只讓 1 人成功）' : '兩位老闆同時核准同一批最後庫存怎麼辦？（AI 建議：核准時重新查庫存，只讓 1 張成功）');
        qs.push('庫存要不要分「生產週碼批次」記錄？（參考 ERP：每筆庫存都分批次，才算得出庫齡，取消出貨時也才能還原到原批次）');
        var total = wb.requirements.length + adds.length;
        ai = '整理完成，目前共 **' + total + ' 條需求草稿**。我另外依「ERP 難點檢核清單」，以及一套真實運作中的輪胎 ERP（旺盛輪業）的功能，想到幾項您沒有提到的需求（標示「AI 建議」），例如：已核准訂單取消時釋放預留、庫存分批次與庫齡、客戶寄庫、進貨與庫存校正。\n**AI 只能提議，不能把需求改成「已確認」**，請到「確認需求」逐條決定。';
        break;
      default:
        ai = '已記錄補充說明' + (adds.length ? '，並新增 ' + adds.map(function (a) { return a.id; }).join('、') : '') + '。訪談已完成，請到「確認需求」處理需求。';
        next = DONE_STEP;
    }
    return { ai: ai, adds: adds, questions: qs, nextStep: next };
  }

  // 「建立規則」前必須先決定的需求（白話原因）
  function buildBlockerItems(wb) {
    var out = [];
    wb.requirements.forEach(function (r) {
      if (r.status === 'pending') out.push({ id: r.id, text: r.text, why: '還沒確認' });
      else if (r.status === 'ai' && r.priority === 'Must') out.push({ id: r.id, text: r.text, why: 'AI 建議的必要需求，要由你決定' });
    });
    if (!wb.requirements.some(function (r) { return r.status === 'confirmed'; })) out.push({ id: '', text: '至少要確認一條需求', why: '目前沒有已確認的需求' });
    return out;
  }
  function buildBlockers(wb) {
    return buildBlockerItems(wb).map(function (b) { return (b.id ? b.id + '：' : '') + b.why; });
  }

  // =====================================================================
  // 5. 開發包、版本、完成前 9 項檢查
  // =====================================================================
  function nextVersion(versions) {
    if (!versions || !versions.length) return 'v0.1.0';
    var m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(versions[versions.length - 1].id);
    if (!m) return 'v0.1.' + versions.length;
    return 'v' + m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1);
  }

  // 使用者用白話寫的驗收案例（還沒有自動測試的那種）
  function draftOf(rule, id) { return ((rule && rule.drafts) || []).filter(function (d) { return d.id === id; })[0] || null; }
  function pendingDrafts(db) {
    var out = [];
    db.wb.rules.forEach(function (rule) { (rule.drafts || []).forEach(function (d) { if (!testCase(d.id)) out.push({ rule: rule, draft: d }); }); });
    return out;
  }
  function testCase(id) { return (typeof Tests !== 'undefined' && Tests.byId) ? Tests.byId(id) : null; }
  function implemented(rule) {
    var ids = testIds(rule);
    return ids.length > 0 && ids.every(function (id) { return !!testCase(id); });
  }

  function partition(wb) {
    var ready = [], blocked = [];
    wb.rules.forEach(function (r) {
      var c = check(r);
      if (c.complete && !r.orphan) ready.push(r); else blocked.push({ rule: r, check: c });
    });
    return { ready: ready, blocked: blocked };
  }

  function devpack(db) {
    var wb = db.wb;
    var parts = partition(wb);
    var ver = nextVersion(wb.versions);
    var today = new Date().toISOString().slice(0, 10);
    var confirmed = wb.requirements.filter(function (r) { return r.status === 'confirmed'; });
    var others = wb.requirements.filter(function (r) { return r.status !== 'confirmed'; });
    var early = confirmed.some(function (r) { return r.id === 'REQ-004B'; });
    var late = confirmed.some(function (r) { return r.id === 'REQ-004'; });

    // ---- SPEC.md
    var S = [];
    S.push('# SPEC — ' + wb.project.name + '（' + ver + '）', '');
    S.push('> 由 AI 可驗證開發工作台產生於 ' + today + '。只收錄「已確認需求」與「IF 閉環 8／8」的規則。', '');
    S.push('## 1. 一句話需求', '', wb.project.need || '（未填）', '');
    S.push('## 2. 範圍：一條垂直流程', '', '查庫存 → 叫貨 → 送出' + (early ? '（建立預留、更新可用庫存）→ 老闆核准' : late ? ' → 老闆核准 → 建立預留 → 更新可用庫存' : '') + '', '');
    S.push('## 3. 已確認需求', '', '| ID | 需求 | 優先 | 來源 |', '|---|---|---|---|');
    confirmed.forEach(function (r) { S.push('| ' + r.id + ' | ' + r.text + ' | ' + r.priority + ' | ' + r.source + ' |'); });
    if (!confirmed.length) S.push('| — | （尚無） | | |');
    S.push('', '## 4. 資料定義', '');
    S.push('- `available = on_hand − reserved`');
    S.push('- 預留時機：' + (early ? '業務送出時（REQ-004B）；退回、拒絕時釋放；核准不改庫存' : late ? '老闆核准時（REQ-004）；送出不預留' : '（尚未決定）'));
    S.push('- 訂單狀態：DRAFT → SUBMITTED → APPROVED／REJECTED；SUBMITTED → RETURNED → SUBMITTED' + (confirmed.some(function (r) { return r.id === 'REQ-024'; }) ? '；APPROVED → SHIPPED' : ''));
    if (confirmed.some(function (r) { return r.id === 'REQ-024'; })) S.push('- 出貨（RULE-010）：老闆按「出貨完成」時，在庫與預留各扣訂購數，可用庫存不變；不可重複出貨');
    if (confirmed.some(function (r) { return r.id === 'REQ-019'; })) S.push('- 進貨（RULE-021）：老闆進貨使在庫增加並留下進貨單號（RC-0001 起依序）');
    if (confirmed.some(function (r) { return r.id === 'REQ-026'; })) S.push('- 低庫存警示（RULE-026／027／028）：商品有安全庫存（> 0）且可用庫存「小於」（預設）或「小於或等於」安全庫存時標示低庫存；比較方式存在 settings.low_stock_op，只有老闆能改，要寫理由並留稽核');
    S.push('- 角色：admin（管理員）、boss（老闆）有全部權限；sales（業務）、warehouse（倉管）、planner（生管）是員工，看不到成本與毛利，只看得到店家價、末端價、庫存與安全庫存' + (confirmed.some(function (r) { return r.id === 'REQ-027'; }) ? '；需登入（RULE-029），權限依角色（RULE-030）' : ''), '');
    S.push('## 5. IF 閉環規則（可進入開發）', '');
    parts.ready.forEach(function (r) {
      S.push('### ' + r.id + ' ' + r.title + '（' + r.reqs.join('、') + '）', '');
      S.push('- **IF**：' + r.if);
      S.push('- **True**：' + r.t.action + '｜資料效果：' + r.t.effect + '｜訊息：「' + r.t.message + '」｜稽核：' + r.t.audit + '｜最終狀態：' + r.t.final + '｜測試：' + r.t.tests.join('、'));
      S.push('- **False**：' + r.f.action + '｜資料效果：' + r.f.effect + '｜訊息：「' + r.f.message + '」｜稽核：' + r.f.audit + '｜最終狀態：' + r.f.final + '｜測試：' + r.f.tests.join('、'));
      if (r.edge && r.edge.text) S.push('- **邊界**：' + r.edge.text + (r.edge.tests.length ? '（' + r.edge.tests.join('、') + '）' : ''));
      S.push('');
    });
    if (!parts.ready.length) S.push('（尚無閉環 8／8 的規則）', '');
    S.push('## 6. 不在本版範圍', '');
    parts.blocked.forEach(function (b) {
      S.push('- ' + b.rule.id + ' ' + b.rule.title + '：' + (b.rule.orphan ? '對應需求未確認' : '閉環 ' + b.check.score + '／8，缺 ' + b.check.missing.join('、')));
    });
    others.forEach(function (r) { S.push('- ' + r.id + ' ' + r.text + '（' + REQ_STATUS[r.status] + '）'); });
    if (!parts.blocked.length && !others.length) S.push('（無）');

    // ---- TASKS.md
    var T = [];
    T.push('# TASKS — ' + ver, '');
    T.push('每完成一個任務：跑對應驗收測試 PASS → 說明如何驗收 → 等使用者確認 → 才 commit（feat:／fix:／test:／docs: 前綴，中文描述）。', '');
    var n = 1;
    parts.ready.forEach(function (r) {
      T.push('## ' + r.id + ' ' + r.title, '');
      (r.tasks.length ? r.tasks : ['依 SPEC 實作 ' + r.id]).forEach(function (task) {
        T.push('- [ ] T-' + (n < 10 ? '0' + n : n) + '　' + task);
        n++;
      });
      T.push('- [ ] 驗收：' + testIds(r).join('、') + ' 全部 PASS', '');
    });
    if (parts.blocked.length) {
      T.push('## 閘門擋下（不可開發）', '');
      parts.blocked.forEach(function (b) { T.push('- ' + b.rule.id + ' ' + b.rule.title + '：缺 ' + (b.rule.orphan ? '已確認的需求' : b.check.missing.join('、'))); });
    }

    // ---- TESTS.md
    var X = [];
    X.push('# TESTS — ' + ver, '');
    X.push('| 測試 | 規則 | 分支 | 案例 | 前提 | 預期 | 狀態 |', '|---|---|---|---|---|---|---|');
    parts.ready.forEach(function (r) {
      testIds(r).forEach(function (id) {
        var c = testCase(id);
        var branch = r.t.tests.indexOf(id) >= 0 ? 'True' : r.f.tests.indexOf(id) >= 0 ? 'False' : '邊界';
        if (c) X.push('| ' + id + ' | ' + r.id + ' | ' + branch + ' | ' + c.title + ' | ' + c.given + ' | ' + c.expect + ' | 已實作 |');
        else if (draftOf(r, id)) { var d = draftOf(r, id); X.push('| ' + id + ' | ' + r.id + ' | ' + branch + ' | （使用者寫的例子） | ' + String(d.given).replace(/[|\n]/g, '／') + ' | ' + String(d.expect).replace(/[|\n]/g, '／') + ' | 待實作 |'); }
        else X.push('| ' + id + ' | ' + r.id + ' | ' + branch + ' | （待撰寫） | | | 待實作 |');
      });
    });
    X.push('', '執行方式：工作台「驗收測試」→ 執行全部驗收測試；或在主控台執行 `Tests.runAll()`。');

    // ---- Coding Agent 指令
    var A = [];
    A.push('# 給 Coding Agent（Codex／Claude Code）的指令', '');
    A.push('請依 SPEC.md、TASKS.md、TESTS.md 實作「' + wb.project.name + '」' + ver + '，遵守：', '');
    A.push('1. 純 HTML/CSS/JS，雙擊 index.html（file://）即可執行；禁止 ES modules、框架、建置工具、外部 CDN。');
    A.push('2. 每個 js 檔掛一個全域物件：SEED、Store、Rules、ERP、Tests、App；載入順序 data→store→rules→erp→tests→app。');
    A.push('3. 資料存 localStorage，key = aiwb_state_v01；可重設回 SEED。介面繁體中文，用白話，使用者不懂程式。');
    A.push('4. ERP 函式第一個參數為 db，回傳 { ok, message, state }，並寫 audit。畫面不可直接改資料。');
    A.push('5. 不可為了讓測試通過而修改 tests.js 裡既有的案例，除非使用者同意。TESTS.md 中狀態是「待實作」的案例，請新增到 tests.js（沿用同一個編號、照「前提」與「預期」寫），先寫測試再實作功能。');
    A.push('6. 只實作閉環 8／8 的規則：' + (parts.ready.map(function (r) { return r.id; }).join('、') || '（無）') + '。');
    if (parts.blocked.length) A.push('7. 下列規則被閘門擋下，不可實作：' + parts.blocked.map(function (b) { return b.rule.id; }).join('、') + '。');
    A.push((parts.blocked.length ? '8' : '7') + '. 每完成一步：說明如何驗收 → 等使用者確認 → 才 commit。', '');
    A.push('請從 TASKS.md 第一項開始。');

    return {
      version: ver,
      ready: parts.ready.map(function (r) { return r.id; }),
      blocked: parts.blocked.map(function (b) { return b.rule.id; }),
      files: {
        'SPEC.md': S.join('\n'),
        'TASKS.md': T.join('\n'),
        'TESTS.md': X.join('\n'),
        'AGENT_PROMPT.md': A.join('\n')
      }
    };
  }

  // =====================================================================
  // 6. 變更影響分析：需求 → 規則 → 驗收案例／程式 → 已存版本（簡報第 17 頁）
  // =====================================================================
  function impactOf(db, reqId) {
    var wb = db.wb;
    var req = wb.requirements.filter(function (r) { return r.id === reqId; })[0] || null;
    var pool = wb.rules.length ? wb.rules : RULE_TEMPLATES;
    var rules = pool.filter(function (r) { return r.primary === reqId || r.reqs.indexOf(reqId) >= 0; });
    var tests = [], code = [], others = [];
    rules.forEach(function (r) {
      testIds(r).forEach(function (t) { if (tests.indexOf(t) < 0) tests.push(t); });
      (r.code || []).forEach(function (c) { if (code.indexOf(c) < 0) code.push(c); });
      r.reqs.forEach(function (q) { if (q !== reqId && others.indexOf(q) < 0) others.push(q); });
    });
    var versions = wb.versions.filter(function (v) {
      return v.reqs.some(function (x) { return x.id === reqId && x.status === 'confirmed'; });
    }).map(function (v) { return v.id; });
    return {
      req: req ? { id: req.id, text: req.text, status: req.status } : null,
      rules: rules.map(function (r) { return { id: r.id, title: r.title }; }),
      tests: tests, code: code, otherReqs: others, versions: versions,
      fromTemplates: !wb.rules.length
    };
  }

  // =====================================================================
  // 7. 版本比較：任兩個版本（或「目前的內容」）之間改了什麼，用白話列出
  // =====================================================================
  function ruleSig(r) {
    var s = JSON.stringify([r.title, r.if, r.t, r.f, r.edge]), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

  // 「目前的內容」，格式和版本紀錄一樣，才能拿來和任一版比
  function snapshotView(db) {
    var run = lastRun(db);
    return {
      id: '目前',
      reqs: db.wb.requirements.map(function (r) { return { id: r.id, status: r.status, text: r.text }; }),
      rules: db.wb.rules.map(function (r) { var c = check(r); return { id: r.id, title: r.title, score: c.score, complete: c.complete, sig: ruleSig(r) }; }),
      settings: { low_stock_op: db.settings && db.settings.low_stock_op === 'le' ? 'le' : 'lt' },
      tests: run ? { pass: run.pass, total: run.total } : null
    };
  }

  // 回傳 [{ kind: 'req'|'rule'|'setting'|'test', text }]；kind 只是分類，text 是給人看的白話
  function diffVersions(a, b) {
    var out = [];
    var byId = function (list) { var m = {}; (list || []).forEach(function (x) { m[x.id] = x; }); return m; };
    var ra = byId(a.reqs), rb = byId(b.reqs);
    Object.keys(rb).forEach(function (id) {
      var y = rb[id], x = ra[id];
      if (!x) { out.push({ kind: 'req', text: '新增需求：' + clip(y.text, 30) + '（' + REQ_STATUS[y.status] + '）' }); return; }
      if (x.text !== y.text) out.push({ kind: 'req', text: '需求說法改了：「' + clip(x.text, 24) + '」→「' + clip(y.text, 24) + '」' });
      if (x.status !== y.status) out.push({ kind: 'req', text: '需求「' + clip(y.text, 22) + '」：' + REQ_STATUS[x.status] + ' → ' + REQ_STATUS[y.status] });
    });
    Object.keys(ra).forEach(function (id) { if (!rb[id]) out.push({ kind: 'req', text: '少了需求：' + clip(ra[id].text, 30) }); });
    var ua = byId(a.rules), ub = byId(b.rules);
    Object.keys(ub).forEach(function (id) {
      var y = ub[id], x = ua[id];
      if (!x) { out.push({ kind: 'rule', text: '新增規則：' + y.title }); return; }
      if (!x.complete && y.complete) out.push({ kind: 'rule', text: '規則寫完整了：' + y.title });
      else if (x.complete && !y.complete) out.push({ kind: 'rule', text: '規則變得不完整：' + y.title });
      if (x.sig && y.sig && x.sig !== y.sig) out.push({ kind: 'rule', text: '規則內容改了：' + y.title });
    });
    Object.keys(ua).forEach(function (id) { if (!ub[id]) out.push({ kind: 'rule', text: '少了規則：' + ua[id].title }); });
    if (a.settings && b.settings && a.settings.low_stock_op !== b.settings.low_stock_op) {
      out.push({ kind: 'setting', text: '低庫存提醒的算法：' + LOW_OPS[a.settings.low_stock_op].short + ' → ' + LOW_OPS[b.settings.low_stock_op].short });
    }
    var pa = a.tests ? a.tests.pass : null, pb = b.tests ? b.tests.pass : null;
    if (pa !== pb) out.push({ kind: 'test', text: '通過的驗收：' + (pa == null ? '還沒測' : pa + ' 項') + ' → ' + (pb == null ? '還沒測' : pb + ' 項') });
    return out;
  }

  function lastRun(db) { var r = db.wb.testRuns; return r.length ? r[r.length - 1] : null; }
  function passedIn(run, id) { return !!run && run.results.some(function (x) { return x.id === id && x.pass; }); }

  // 每個功能完成前 9 項檢查（auto = 系統自動判斷；其餘人工勾選）
  function checklist(db) {
    var wb = db.wb;
    var run = lastRun(db);
    var parts = partition(wb);
    var reqById = {};
    wb.requirements.forEach(function (r) { reqById[r.id] = r; });
    var mustRules = wb.rules.filter(function (r) { var q = reqById[r.primary]; return !r.orphan && q && q.priority === 'Must'; });
    var falseTests = [];
    parts.ready.forEach(function (r) { falseTests = falseTests.concat(r.f.tests, r.edge.tests); });
    var manual = function (k) { return !!wb.checklist[k]; };
    return [
      { key: 'spec', label: '需求都寫進規格，並有驗收條件', auto: true, ok: !!wb.devpack && parts.ready.length > 0, hint: '已經產生開發包，而且收進去的規則都有驗收案例' },
      { key: 'closure', label: '規則的 8 項檢查都完成', auto: true, ok: mustRules.length > 0 && mustRules.every(function (r) { return check(r).complete; }), hint: '所有「必要」需求的規則都寫完整' },
      { key: 'layers', label: '畫面、規則、資料三層都串通', auto: false, ok: manual('layers'), hint: '到「試用 ERP」實際操作過一次完整流程' },
      { key: 'exceptions', label: '例外情況都測過', auto: true, ok: falseTests.length > 0 && falseTests.every(function (id) { return passedIn(run, id); }), hint: '「條件不成立」與特殊情況的驗收案例，最近一次測試都通過' },
      { key: 'terms', label: '陌生名詞都查證過', auto: false, ok: manual('terms'), hint: '例：寄庫、銷帳、庫齡的意思已和業者確認' },
      { key: 'calc', label: '計算有用程式驗算', auto: true, ok: passedIn(run, 'TC-003-01'), hint: '「可用 = 在庫 − 預留」由驗收案例驗算' },
      { key: 'auth', label: '權限相關的程式由人看過', auto: false, ok: manual('auth'), hint: '人工確認員工看不到成本、只有老闆與管理員能核准' },
      { key: 'git', label: '程式已用 Git 存檔並寫了說明', auto: false, ok: manual('git'), hint: '存檔說明用 feat:／fix:／test:／docs: 開頭' },
      { key: 'agents', label: '交接說明（AGENTS.md）已更新', auto: false, ok: manual('agents'), hint: '寫給下一個 AI 工程師看的說明' }
    ];
  }

  return {
    ROLE: ROLE, ORDER_STATUS: ORDER_STATUS, REQ_STATUS: REQ_STATUS, REQ_MOVES: REQ_MOVES,
    PRIORITY_LABEL: PRIORITY_LABEL, ACTION_LABEL: ACTION_LABEL,
    available: available, parseQty: parseQty, isPositiveInt: isPositiveInt, isNonNegInt: isNonNegInt, LOW_OPS: LOW_OPS, isLowStock: isLowStock,
    isSales: isSales, isBoss: isBoss, isManager: isManager, isStaff: isStaff, PERMS: PERMS, can: can, SALES_FIELDS: SALES_FIELDS, viewFor: viewFor,
    RESERVING: RESERVING, canReturn: canReturn, canApprove: canApprove, canReject: canReject, canShip: canShip, canEdit: canEdit,
    CLOSURE: CLOSURE, AI_DRAFTS: AI_DRAFTS, deriveCases: deriveCases, aiCanHelp: aiCanHelp, draftOf: draftOf, pendingDrafts: pendingDrafts, check: check, testIds: testIds, parseTestIds: parseTestIds,
    QUALITY: QUALITY, REQ_CATALOG: REQ_CATALOG, REQ_ORDER: REQ_ORDER, qualityScore: qualityScore,
    REF_SOURCE: REF_SOURCE, REF_EVIDENCE: REF_EVIDENCE, REF_CANDIDATES: REF_CANDIDATES,
    RULE_TEMPLATES: RULE_TEMPLATES, DIFFICULTIES: DIFFICULTIES, STATE_MACHINE: STATE_MACHINE, RRB: RRB,
    DONE_STEP: DONE_STEP, DEFAULT_NEED: DEFAULT_NEED,
    interviewChips: interviewChips, interviewRespond: interviewRespond, buildBlockers: buildBlockers, buildBlockerItems: buildBlockerItems,
    nextVersion: nextVersion, implemented: implemented, partition: partition, devpack: devpack,
    lastRun: lastRun, checklist: checklist, impactOf: impactOf,
    ruleSig: ruleSig, snapshotView: snapshotView, diffVersions: diffVersions
  };
})();
