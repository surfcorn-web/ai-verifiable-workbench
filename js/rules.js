/* rules.js — 規則層
 * 全域物件：Rules
 * 1. ERP 領域規則（ERP 函式直接呼叫）：available、正整數、業務欄位白名單、可退回判斷
 * 2. IF 閉環 8 項檢查（開發閘門）：IF、True、False、資料效果、訊息、稽核、≥2 測試、最終狀態
 * 3. 需求目錄、規則範本、ERP 九大難點、訂單狀態機、RRB
 * 4. AI 需求訪談引擎（示範版：規則式追問，不連網、不呼叫大型語言模型）
 * 5. 開發包（SPEC／TASKS／TESTS／Coding Agent 指令）與版本前 9 項檢查
 */
var Rules = (function () {
  'use strict';

  // =====================================================================
  // 標籤
  // =====================================================================
  var ROLE = { sales: '業務', boss: '老闆' };
  var ORDER_STATUS = {
    DRAFT: '購物車', SUBMITTED: '待審核', APPROVED: '已核准（已預留）', REJECTED: '已拒絕',
    RETURNED: '退回修改', PARTIALLY_SHIPPED: '部分出貨', SHIPPED: '已出貨', CANCELLED: '已取消'
  };
  var REQ_STATUS = { pending: '待確認', ai: 'AI 推論', confirmed: '已確認', rejected: '已拒絕', deferred: '延後' };

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
  function isBoss(user) { return !!user && user.role === 'boss'; }

  // RULE-001：業務看到的欄位白名單；用「重新組物件」而不是刪欄位
  var SALES_FIELDS = ['sku', 'brand', 'name', 'spec', 'year', 'on_hand', 'reserved', 'available', 'price'];
  function viewFor(user, p) {
    var row = {};
    SALES_FIELDS.forEach(function (f) { row[f] = f === 'available' ? available(p) : p[f]; });
    if (isBoss(user)) {
      row.cost = p.cost;
      row.margin = p.price - p.cost;
    }
    return row;
  }

  // RULE-005：只有 SUBMITTED 可退回
  function canReturn(order) { return !!order && order.status === 'SUBMITTED'; }
  function canApprove(order) { return !!order && order.status === 'SUBMITTED'; }
  function canEdit(order) { return !!order && (order.status === 'DRAFT' || order.status === 'RETURNED'); }

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

  var CLOSURE = [
    { key: 'if', label: '有 IF 條件', ok: function (r) { return filled(r.if); } },
    { key: 'true', label: '有 True 分支', ok: function (r) { return filled(r.t.action); } },
    { key: 'false', label: '有 False 分支', ok: function (r) { return filled(r.f.action); } },
    { key: 'effect', label: '有資料變動結果', ok: function (r) { return filled(r.t.effect) && filled(r.f.effect); } },
    { key: 'message', label: '有使用者回饋', ok: function (r) { return filled(r.t.message) && filled(r.f.message); } },
    { key: 'audit', label: '有稽核紀錄', ok: function (r) { return filled(r.t.audit) && filled(r.f.audit); } },
    { key: 'tests', label: '有測試案例（≥2，True／False 各至少 1）', ok: function (r) { return testIds(r).length >= 2 && list(r.t.tests).length > 0 && list(r.f.tests).length > 0; } },
    { key: 'final', label: '有最終狀態', ok: function (r) { return filled(r.t.final) && filled(r.f.final); } }
  ];

  function check(rule) {
    var r = {
      if: rule.if, t: rule.t || {}, f: rule.f || {}, edge: rule.edge || {}
    };
    var items = CLOSURE.map(function (c) { return { key: c.key, label: c.label, ok: !!c.ok(r) }; });
    var score = items.filter(function (i) { return i.ok; }).length;
    return {
      items: items, score: score, total: CLOSURE.length,
      complete: score === CLOSURE.length,
      missing: items.filter(function (i) { return !i.ok; }).map(function (i) { return i.label.replace(/^有/, '').replace(/（.*）/, ''); })
    };
  }

  // =====================================================================
  // 3. 需求目錄（AI 可提出的需求；品質 = 7 項 × 2 分 = 14）
  // =====================================================================
  var QUALITY = ['角色明確', '動作明確', '觸發條件', '資料欄位', '例外處理', '可驗收', '來源可追溯'];

  var REQ_CATALOG = {
    'REQ-001': { text: '業務可用手機查詢輪胎庫存（規格、品牌、可用量）', priority: 'Must', quality: [2, 2, 1, 2, 1, 2, 2] },
    'REQ-002': { text: '業務可把查到的輪胎加入叫貨單並送出審核', priority: 'Must', quality: [2, 2, 2, 1, 1, 2, 2] },
    'REQ-003': { text: '叫貨數量必須為正整數（0、負數、小數不可送出）', priority: 'Must', quality: [2, 2, 2, 2, 2, 2, 1] },
    'REQ-004': { text: '老闆核准時檢查可用庫存，足夠才建立預留', priority: 'Must', quality: [2, 2, 2, 2, 1, 2, 2], group: 'reserve-timing' },
    'REQ-004B': { text: '業務送出叫貨單時即建立預留（替代決策）', priority: 'Must', quality: [2, 2, 2, 2, 1, 1, 1], group: 'reserve-timing' },
    'REQ-005': { text: '可用庫存＝在庫（on_hand）－預留（reserved）', priority: 'Must', quality: [2, 2, 2, 2, 2, 2, 2] },
    'REQ-006': { text: '業務角色不可看到成本與毛利', priority: 'Must', quality: [2, 2, 2, 2, 1, 2, 1] },
    'REQ-007': { text: '老闆可退回待審核訂單，業務修改後重送', priority: 'Must', quality: [2, 2, 2, 1, 1, 2, 1] },
    'REQ-008': { text: '已核准訂單取消時釋放預留', priority: 'Should', quality: [2, 1, 2, 1, 1, 1, 1] },
    'REQ-009': { text: '一鍵複製庫存資訊回覆 LINE', priority: 'Should', quality: [2, 2, 1, 1, 1, 2, 1] },
    'REQ-011': { text: '寄庫：一次買 10 條，分次叫貨，正式庫存不變', priority: 'Should', quality: [2, 2, 1, 1, 1, 2, 1] },
    'REQ-012': { text: '依生產日期碼顯示庫齡顏色（1 年內／1–2 年／2–3 年）', priority: 'Should', quality: [2, 2, 2, 2, 1, 1, 1] },
    'REQ-013': { text: '下班後業務仍可送出叫貨單，隔日由老闆審核', priority: 'Should', quality: [2, 2, 1, 1, 1, 2, 1] },
    'REQ-015': { text: '行動條碼掃描出貨', priority: "Won't", quality: [2, 1, 1, 1, 1, 2, 1] }
  };
  var REQ_ORDER = Object.keys(REQ_CATALOG);
  function qualityScore(q) { return (q || []).reduce(function (a, b) { return a + b; }, 0); }

  // =====================================================================
  // 規則範本（需求確認後由 buildRules 建立；人可在 C 區修改）
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
      id: 'RULE-001', title: '業務查詢不含成本', primary: 'REQ-006', reqs: ['REQ-006', 'REQ-001'], difficulty: '權限與敏感資料',
      if: '查詢者角色 = 業務（sales）',
      t: { action: '只回傳白名單欄位（規格、品牌、年份、在庫、預留、可用、售價）', effect: '唯讀查詢，庫存不變；新增一筆查詢稽核', message: '查到 N 筆', audit: 'QUERY（角色 sales，回傳欄位不含 cost）', tests: ['TC-001-01'], final: '查詢結果物件沒有 cost／margin 欄位' },
      f: { action: '老闆角色回傳完整欄位（含成本、毛利）', effect: '唯讀查詢，庫存不變；新增一筆查詢稽核', message: '查到 N 筆（含成本）', audit: 'QUERY（角色 boss，含 cost）', tests: ['TC-001-02'], final: '查詢結果物件含 cost 欄位' },
      edge: { text: '用白名單「重新組物件」而不是刪除 cost，日後新增敏感欄位也不會外洩', tests: [] },
      code: ['ERP.queryStock', 'Rules.viewFor'],
      tasks: [
        '實作 ERP.queryStock(db, userId, keyword)：角色以 db 內的使用者資料為準，不信任畫面傳入的角色',
        '業務用 Rules.viewFor 白名單組出新物件，不可含 cost／margin',
        '寫入 QUERY 稽核（角色、關鍵字、回傳欄位）'
      ]
    }),
    tpl({
      id: 'RULE-002', title: '叫貨數量須為正整數', primary: 'REQ-003', reqs: ['REQ-003', 'REQ-002'], difficulty: '單據狀態與回滾',
      if: '叫貨數量為正整數（整數且 > 0）',
      t: { action: '加入叫貨單（DRAFT），可送出 → SUBMITTED', effect: '訂單行寫入 qty；送出時不建立預留（核准才預留）', message: '已加入叫貨單／已送出，等待老闆核准', audit: 'ADD_LINE／SUBMITTED', tests: ['TC-002-02'], final: 'DRAFT → SUBMITTED' },
      f: { action: '拒絕加入或送出', effect: '訂單與庫存完全不變（不建立訂單）', message: '叫貨數量必須為正整數', audit: 'ADD_LINE_DENIED', tests: ['TC-002-01'], final: '沒有新訂單；原訂單狀態不變' },
      edge: { text: '0、負數、小數、空白、文字一律走 False 分支', tests: [] },
      code: ['ERP.addLine', 'ERP.updateLine', 'ERP.submitOrder', 'Rules.isPositiveInt'],
      tasks: [
        '實作 ERP.addLine／updateLine：數量用 Rules.isPositiveInt 檢查，不通過就不建立訂單',
        '實作 ERP.submitOrder：DRAFT／RETURNED → SUBMITTED，送出前再檢查每一行數量；送出不建立預留',
        '加入、送出、拒絕都寫稽核'
      ]
    }),
    tpl({
      id: 'RULE-003', title: '送出即預留（替代決策）', primary: 'REQ-004B', reqs: ['REQ-004B', 'REQ-005'], difficulty: '庫存時間差、超賣',
      if: '送出當下：每一行 可用庫存（on_hand − reserved）≥ 叫貨數量',
      t: { action: '送出並建立預留；訂單 → SUBMITTED', effect: 'reserved += qty', message: '已送出並預留', audit: 'SUBMITTED_RESERVED', tests: ['TC-003-01'], final: 'SUBMITTED（已預留）' },
      f: { action: '不可送出', effect: '庫存與預留不變', message: '可用庫存不足（剩 N），不可送出', audit: 'SUBMIT_DENIED', tests: ['TC-003-02'], final: '維持 DRAFT' },
      edge: { text: '老闆退回或拒絕時必須釋放預留（reserved −= qty），否則預留會卡住', tests: [] },
      code: [],
      tasks: [
        '修改 ERP.submitOrder：送出時檢查可用並建立預留',
        '修改 ERP.returnOrder／approveOrder：退回、拒絕時釋放預留',
        '新增 TC-003-01、TC-003-02（需使用者同意才可修改 tests.js）'
      ]
    }),
    tpl({
      id: 'RULE-004', title: '老闆核准叫貨單', primary: 'REQ-004', reqs: ['REQ-004', 'REQ-005'], difficulty: '庫存時間差、超賣',
      if: '核准當下重新讀取庫存：每一行 可用庫存（on_hand − reserved）≥ 叫貨數量',
      t: { action: '建立預留；訂單 → APPROVED', effect: 'reserved += qty（可用庫存即時減少）', message: '核准成功', audit: 'APPROVED', tests: ['TC-004-01'], final: 'APPROVED（已預留）' },
      f: { action: '拒絕核准；訂單 → REJECTED', effect: '庫存與預留完全不變', message: '可用庫存不足（剩 N）', audit: 'REJECTED', tests: ['TC-004-02'], final: 'REJECTED（已拒絕）' },
      edge: { text: '兩位老闆同時核准最後庫存 → 交易＋重新讀取，只能一筆 True', tests: ['TC-004-03'] },
      code: ['ERP.approveOrder', 'Rules.available', 'Store.transact'],
      tasks: [
        '實作 ERP.approveOrder(db, userId, orderId)：只處理 SUBMITTED；核准當下重新讀取 on_hand／reserved',
        '可用足夠：reserved += qty、狀態 APPROVED、稽核 APPROVED、訊息「核准成功」',
        '可用不足：狀態 REJECTED、庫存完全不變、稽核 REJECTED、訊息「可用庫存不足（剩 N）」',
        '畫面核准一律經 Store.transact，執行當下重新讀取最新狀態'
      ]
    }),
    tpl({
      id: 'RULE-005', title: '只有待審核訂單可退回', primary: 'REQ-007', reqs: ['REQ-007'], difficulty: '單據狀態與回滾',
      if: '訂單狀態 = SUBMITTED（待審核）',
      t: { action: '退回；訂單 → RETURNED，業務可修改後重送', effect: '只改訂單狀態與退回原因；核准前沒有預留，不需釋放', message: '已退回，請業務修改後重送', audit: 'RETURNED', tests: ['TC-005-01'], final: 'RETURNED → 重送後 SUBMITTED' },
      f: { action: '拒絕退回', effect: '訂單與庫存完全不變', message: '只有待審核（SUBMITTED）的訂單可以退回', audit: 'RETURN_DENIED', tests: ['TC-005-02'], final: '維持原狀態（例如 APPROVED）' },
      edge: { text: '已核准訂單要用「取消」而不是退回（RULE-008，候選）', tests: [] },
      code: ['ERP.returnOrder', 'Rules.canReturn', 'ERP.updateLine', 'ERP.submitOrder'],
      tasks: [
        '實作 ERP.returnOrder(db, userId, orderId, reason)：用 Rules.canReturn 判斷',
        'RETURNED 訂單可由建立的業務修改數量後重新送出',
        '退回、拒絕退回都寫稽核'
      ]
    }),
    tpl({
      id: 'RULE-008', title: '取消已核准訂單（釋放預留）', primary: 'REQ-008', reqs: ['REQ-008'], difficulty: '單據狀態與回滾',
      if: '訂單狀態 = APPROVED 且尚未出貨',
      t: { action: '取消；訂單 → CANCELLED', effect: 'reserved −= qty（釋放預留）', message: '已取消並釋放預留', audit: 'CANCELLED', tests: [], final: 'CANCELLED' },
      f: { action: '', effect: '庫存與預留不變', message: '只有已核准且未出貨的訂單可以取消', audit: 'CANCEL_DENIED', tests: [], final: '維持原狀態' },
      edge: { text: '部分出貨後取消：只釋放未出貨部分（PARTIALLY_SHIPPED）', tests: [] },
      note: 'AI 草稿：缺 False 分支與測試，示範閘門會擋下'
    }),
    tpl({
      id: 'RULE-009', title: '寄庫分次叫貨', primary: 'REQ-011', reqs: ['REQ-011'], difficulty: '例外交易（部分出貨、寄庫）',
      if: '客戶寄庫餘量 ≥ 本次取貨數量', note: 'AI 草稿：只起草 IF，其餘由人補齊'
    }),
    tpl({
      id: 'RULE-015', title: '一鍵複製 LINE 回覆', primary: 'REQ-009', reqs: ['REQ-009'], difficulty: '權限與敏感資料',
      if: '查詢結果已選取至少一個品項', t: { action: '產生回覆文字並複製（不含成本）' }, note: 'AI 草稿：只起草 IF，其餘由人補齊'
    }),
    tpl({
      id: 'RULE-016', title: '庫齡顏色', primary: 'REQ-012', reqs: ['REQ-012'], difficulty: '報表口徑',
      if: '生產日期碼距今 ≤ 1 年／1–2 年／2–3 年', note: 'AI 草稿：只起草 IF，其餘由人補齊'
    }),
    tpl({
      id: 'RULE-017', title: '下班後叫貨', primary: 'REQ-013', reqs: ['REQ-013'], difficulty: '單據狀態與回滾',
      if: '送出時間在營業時間外', note: 'AI 草稿：只起草 IF，其餘由人補齊'
    })
  ];

  // =====================================================================
  // ERP 九大難點（AI 必問的問題）、訂單狀態機、RRB
  // =====================================================================
  var DIFFICULTIES = [
    { name: '庫存時間差、超賣', rule: 'RULE-004', v1: '做', ask: '出貨後庫存多久才扣？兩個人同時賣最後一條怎麼辦？' },
    { name: '權限與敏感資料', rule: 'RULE-001', v1: '做', ask: '哪些角色可以看到成本、毛利？' },
    { name: '單據狀態與回滾', rule: 'RULE-005／008', v1: '部分', ask: '送出後能不能改？退回、取消時庫存怎麼回復？' },
    { name: '例外交易（部分出貨、寄庫）', rule: 'RULE-009', v1: '候選', ask: '客戶會一次買多條、分次取貨嗎？' },
    { name: '盤點與校正', rule: 'RULE-010', v1: '候選', ask: '盤點差異由誰調整？要不要留紀錄？' },
    { name: '金額計算', rule: 'RULE-011', v1: '候選', ask: '折扣、稅、四捨五入在哪一步算？' },
    { name: '舊資料匯入', rule: 'RULE-012', v1: '候選', ask: '現有 Excel 庫存怎麼匯入？錯誤資料怎麼處理？' },
    { name: '與舊系統並存', rule: 'RULE-013', v1: '候選', ask: '上線期間舊系統還用嗎？以哪邊為準？' },
    { name: '報表口徑', rule: 'RULE-014', v1: '候選', ask: '「庫存」報表算在庫還是可用？' }
  ];

  var STATE_MACHINE = [
    { from: 'DRAFT', to: 'SUBMITTED', cond: '送出：IF 數量為正整數', rule: 'RULE-002', v1: true },
    { from: 'SUBMITTED', to: 'APPROVED', cond: '核准：IF 可用 ≥ 數量 → reserved += qty', rule: 'RULE-004', v1: true },
    { from: 'SUBMITTED', to: 'REJECTED', cond: '核准失敗：ELSE 資料不變', rule: 'RULE-004', v1: true },
    { from: 'SUBMITTED', to: 'RETURNED', cond: '退回 → 可修改再送出', rule: 'RULE-005', v1: true },
    { from: 'RETURNED', to: 'SUBMITTED', cond: '重新送出（再檢查數量）', rule: 'RULE-002', v1: true },
    { from: 'APPROVED', to: 'SHIPPED', cond: '全部出貨：reserved −= qty、on_hand −= qty', rule: '—', v1: false },
    { from: 'APPROVED', to: 'PARTIALLY_SHIPPED', cond: '部分出貨：reserved、on_hand −= 出貨量', rule: 'RULE-009', v1: false },
    { from: 'PARTIALLY_SHIPPED', to: 'SHIPPED', cond: '出完剩餘', rule: '—', v1: false },
    { from: 'APPROVED', to: 'CANCELLED', cond: '取消 → reserved −= qty', rule: 'RULE-008', v1: false },
    { from: 'PARTIALLY_SHIPPED', to: 'CANCELLED', cond: '取消未出部分 → 釋放剩餘預留', rule: 'RULE-008', v1: false }
  ];

  // 參考需求基準 RRB（凍結前為示意）；AI 找到 = 訪談中出現對應需求（不論人是否採納）
  var RRB = [
    { name: '預留與可用庫存', reqs: ['REQ-004', 'REQ-004B', 'REQ-005'], v1: true },
    { name: '成本權限', reqs: ['REQ-006'], v1: true },
    { name: '複製回覆 LINE', reqs: ['REQ-009'], v1: false },
    { name: '叫貨審核', reqs: ['REQ-002', 'REQ-007'], v1: true },
    { name: '寄庫', reqs: ['REQ-011'], v1: false },
    { name: '庫齡', reqs: ['REQ-012'], v1: false },
    { name: '下班可叫貨', reqs: ['REQ-013'], v1: false }
  ];

  // =====================================================================
  // 4. AI 需求訪談引擎（示範版）
  // =====================================================================
  var STEP_SOURCE = ['初始需求', '訪談 Q1–2', '訪談 Q3–4', '訪談 Q5', '訪談 Q6–7', '訪談補充'];
  var DONE_STEP = 5;

  var PATTERNS = [
    { re: /庫存|有沒有貨|查/, req: 'REQ-001', status: 'pending' },
    { re: /開單|叫貨|下單|訂單/, req: 'REQ-002', status: 'pending' },
    { re: /超賣|銷帳|扣掉|扣庫存|延遲/, req: 'REQ-005', status: 'pending' },
    { re: /LINE|賴/i, req: 'REQ-009', status: 'ai' },
    { re: /寄庫|分次/, req: 'REQ-011', status: 'ai' },
    { re: /年份|年分|庫齡|太舊|生產日期/, req: 'REQ-012', status: 'ai' },
    { re: /退回|改完|修改後|重送|重新送/, req: 'REQ-007', status: 'pending' },
    { re: /整數|不能是 ?0|不可為 ?0|不能為 ?0|負/, req: 'REQ-003', status: 'pending' },
    { re: /下班|晚上|假日/, req: 'REQ-013', status: 'ai' }
  ];
  var NEG_COST = /不(能|可|要|行|應|該|准|給)|看不到|禁止|只有老闆/;

  var CHIPS = [
    null, // step 0 用專案的一句話需求
    ['會回 LINE 給客戶，有時直接請內勤開單。出貨要等內勤銷帳，熱門規格可能超賣。'],
    ['老闆核准時才預留。有些客戶會寄庫分次拿，年份太舊的要便宜賣。', '送出時就先預留，免得被別人搶走。'],
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
        source: source || (status === 'ai' ? src + '（AI 推論）' : src),
        evidence: evidence || text, note: note || ''
      });
    }

    PATTERNS.forEach(function (p) { if (p.re.test(text)) add(p.req, p.status); });

    if (/成本|毛利/.test(text)) {
      if (NEG_COST.test(text)) add('REQ-006', 'pending');
      else {
        add('REQ-006', 'ai', '回答未禁止業務看成本；AI 依「權限與敏感資料」難點建議禁止');
        qs.push('業務能否看到成本？（回答未明確禁止）');
      }
    }

    var timing = null;
    if (!have['REQ-004'] && !have['REQ-004B']) {
      timing = detectTiming(text);
      if (timing) {
        var other = timing === 'REQ-004' ? 'REQ-004B' : 'REQ-004';
        add(timing, 'pending', '預留時機（互斥決策）', src);
        add(other, 'ai', '替代決策：與 ' + timing + ' 互斥，兩者不可同時確認', 'AI 提出替代方案');
      } else if (step === 2) {
        add('REQ-004', 'ai', '預留時機未決定：與 REQ-004B 互斥，請二選一', 'AI 提出替代方案');
        add('REQ-004B', 'ai', '預留時機未決定：與 REQ-004 互斥，請二選一', 'AI 提出替代方案');
        qs.push('預留時機：送出就預留，還是核准才預留？（回答未明確）');
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
        if (!exists('REQ-005')) add('REQ-005', 'ai', '扣帳有時間差 → AI 推論需要區分在庫與可用');
        ai = '這表示需要**預留機制**，並區分「庫存」與「可用庫存」。要在**送出時**就預留，還是**老闆核准時**才預留？\n另外想確認：\n3. 客戶會一次買多條、分次取貨（寄庫）嗎？\n4. 輪胎年份會影響售價嗎？';
        break;
      case 2:
        if (timing === 'REQ-004') ai = '記下了：**核准時才預留**（REQ-004）。「送出即預留」列為互斥的替代決策 REQ-004B，請在需求確認時二選一。';
        else if (timing === 'REQ-004B') ai = '記下了：**送出即預留**（REQ-004B）。「核准才預留」列為互斥的替代決策 REQ-004，請在需求確認時二選一。';
        else ai = '預留時機還沒有明確答案，我先把兩個方案都列為 AI 推論，並放進「尚待釐清」。';
        ai += '\n接著是權限與敏感資料：\n5. 業務在外面查詢時，可以看到進貨成本或毛利嗎？';
        break;
      case 3:
        if (!exists('REQ-006')) {
          add('REQ-006', 'ai', 'AI 依「權限與敏感資料」難點建議：業務不可看成本');
          qs.push('業務能否看到成本？（尚未回答）');
        }
        ai = '最後兩個關於單據狀態的問題：\n6. 老闆審核時發現叫貨單有問題（例如數量打錯），要直接拒絕，還是退回讓業務修改後重送？\n7. 叫貨數量有沒有限制？（例如只能整數條、不可為 0）';
        break;
      case 4:
        if (!exists('REQ-003')) add('REQ-003', 'ai', 'AI 依「單據狀態」難點推論');
        if (!exists('REQ-007')) qs.push('老闆發現叫貨單有問題時：直接拒絕，還是退回修改？');
        var inferred = 'AI 依 ERP 難點檢核清單推論（沒有使用者原話）';
        add('REQ-008', 'ai', '', 'AI 流程走查', inferred);
        add('REQ-011', 'ai', '', 'AI 流程走查', inferred);
        add('REQ-012', 'ai', '', 'AI 角色推演（財務）', inferred);
        add('REQ-013', 'ai', '', 'AI 參考模型', inferred);
        add('REQ-015', 'ai', '', 'AI 參考模型', inferred);
        var approveFirst = have['REQ-004'] && wb.requirements.some(function (r) { return r.id === 'REQ-004' && r.status === 'pending'; });
        qs.push('審核退回時預留是否釋放？' + (approveFirst ? '（核准才預留 → 退回時尚未預留，AI 建議：不需釋放）' : ''));
        qs.push('低庫存是 < 或 ≤ 安全庫存？');
        qs.push('兩位老闆同時核准同一批最後庫存怎麼辦？（AI 建議：核准時重新讀取＋交易，只能一筆成功）');
        var total = wb.requirements.length + adds.length;
        ai = '整理完成，目前共 **' + total + ' 條需求草稿**。我另外依「ERP 難點檢核清單」推論出幾項您沒有提到、但同類 ERP 常見的需求（標示 AI 推論），例如 REQ-008 已核准訂單取消時釋放預留、REQ-013 下班後可叫貨、REQ-015 行動條碼掃描出貨。\n**AI 只能提出與評分，不能把需求改成「已確認」**，請到「需求確認」逐條確認、採納、延後或拒絕。';
        break;
      default:
        ai = '已記錄補充說明' + (adds.length ? '，並新增 ' + adds.map(function (a) { return a.id; }).join('、') : '') + '。訪談已完成，請到「需求確認」處理需求。';
        next = DONE_STEP;
    }
    return { ai: ai, adds: adds, questions: qs, nextStep: next };
  }

  // 「全部確認後建立 IF 規則」前必須決定的需求
  function buildBlockers(wb) {
    var out = [];
    wb.requirements.forEach(function (r) {
      if (r.status === 'pending') out.push(r.id + '（待確認）');
      else if (r.status === 'ai' && r.priority === 'Must') out.push(r.id + '（AI 推論的 Must 需求要人決定）');
    });
    if (!wb.requirements.some(function (r) { return r.status === 'confirmed'; })) out.push('尚無已確認需求');
    return out;
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

    // ---- SPEC.md
    var S = [];
    S.push('# SPEC — ' + wb.project.name + '（' + ver + '）', '');
    S.push('> 由 AI 可驗證開發工作台產生於 ' + today + '。只收錄「已確認需求」與「IF 閉環 8／8」的規則。', '');
    S.push('## 1. 一句話需求', '', wb.project.need || '（未填）', '');
    S.push('## 2. 範圍：一條垂直流程', '', '查庫存 → 加入叫貨 → 送出 → 老闆核准 → 建立預留 → 更新可用庫存', '');
    S.push('## 3. 已確認需求', '', '| ID | 需求 | 優先 | 來源 |', '|---|---|---|---|');
    confirmed.forEach(function (r) { S.push('| ' + r.id + ' | ' + r.text + ' | ' + r.priority + ' | ' + r.source + ' |'); });
    if (!confirmed.length) S.push('| — | （尚無） | | |');
    S.push('', '## 4. 資料定義', '');
    S.push('- `available = on_hand − reserved`');
    S.push('- 訂單狀態：DRAFT → SUBMITTED → APPROVED／REJECTED；SUBMITTED → RETURNED → SUBMITTED');
    S.push('- 角色：sales（業務）、boss（老闆）', '');
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
      S.push('- ' + b.rule.id + ' ' + b.rule.title + '：' + (b.rule.orphan ? '對應需求已撤回' : '閉環 ' + b.check.score + '／8，缺 ' + b.check.missing.join('、')));
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
      parts.blocked.forEach(function (b) { T.push('- ' + b.rule.id + ' ' + b.rule.title + '：缺 ' + (b.rule.orphan ? '已確認需求' : b.check.missing.join('、'))); });
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
        else X.push('| ' + id + ' | ' + r.id + ' | ' + branch + ' | （待撰寫） | | | 待實作 |');
      });
    });
    X.push('', '執行方式：工作台「D 驗收與追蹤」→ 執行全部驗收測試；或在主控台執行 `Tests.runAll()`。');

    // ---- Coding Agent 指令
    var A = [];
    A.push('# 給 Coding Agent（Codex／Claude Code）的指令', '');
    A.push('請依 SPEC.md、TASKS.md、TESTS.md 實作「' + wb.project.name + '」' + ver + '，遵守：', '');
    A.push('1. 純 HTML/CSS/JS，雙擊 index.html（file://）即可執行；禁止 ES modules、框架、建置工具、外部 CDN。');
    A.push('2. 每個 js 檔掛一個全域物件：SEED、Store、Rules、ERP、Tests、App；載入順序 data→store→rules→erp→tests→app。');
    A.push('3. 資料存 localStorage，key = aiwb_state_v01；可重設回 SEED。介面繁體中文。');
    A.push('4. ERP 函式第一個參數為 db，回傳 { ok, message, state }，並寫 audit。畫面不可直接改資料。');
    A.push('5. 不可為了讓測試通過而修改 tests.js，除非使用者同意。');
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
      { key: 'spec', label: '寫在 SPEC，有驗收條件', auto: true, ok: !!wb.devpack && parts.ready.length > 0, hint: '已產生開發包，且收錄的規則都有測試' },
      { key: 'closure', label: 'IF 閉環 8／8', auto: true, ok: mustRules.length > 0 && mustRules.every(function (r) { return check(r).complete; }), hint: '所有 Must 需求的規則都是 8／8' },
      { key: 'layers', label: '畫面→資料三層串通', auto: false, ok: manual('layers'), hint: '在 ERP 預覽實際操作一次完整流程' },
      { key: 'exceptions', label: '例外都測過', auto: true, ok: falseTests.length > 0 && falseTests.every(function (id) { return passedIn(run, id); }), hint: '所有 False 分支與邊界測試在最近一次執行 PASS' },
      { key: 'terms', label: '陌生名詞已查證', auto: false, ok: manual('terms'), hint: '例：寄庫、銷帳、庫齡的意思已和業者確認' },
      { key: 'calc', label: '計算用程式驗算', auto: true, ok: passedIn(run, 'TC-004-01'), hint: 'available = on_hand − reserved 由 TC-004-01 驗算' },
      { key: 'auth', label: '權限程式人工審查', auto: false, ok: manual('auth'), hint: '人工看過 Rules.viewFor 與 ERP 角色檢查' },
      { key: 'git', label: 'Git 存檔並說明', auto: false, ok: manual('git'), hint: 'commit 訊息用 feat:／fix:／test:／docs: 前綴' },
      { key: 'agents', label: 'AGENTS.md 已更新', auto: false, ok: manual('agents'), hint: '交接給下一個 Coding Agent 的說明' }
    ];
  }

  return {
    ROLE: ROLE, ORDER_STATUS: ORDER_STATUS, REQ_STATUS: REQ_STATUS,
    available: available, parseQty: parseQty, isPositiveInt: isPositiveInt,
    isSales: isSales, isBoss: isBoss, SALES_FIELDS: SALES_FIELDS, viewFor: viewFor,
    canReturn: canReturn, canApprove: canApprove, canEdit: canEdit,
    CLOSURE: CLOSURE, check: check, testIds: testIds, parseTestIds: parseTestIds,
    QUALITY: QUALITY, REQ_CATALOG: REQ_CATALOG, REQ_ORDER: REQ_ORDER, qualityScore: qualityScore,
    RULE_TEMPLATES: RULE_TEMPLATES, DIFFICULTIES: DIFFICULTIES, STATE_MACHINE: STATE_MACHINE, RRB: RRB,
    DONE_STEP: DONE_STEP, DEFAULT_NEED: DEFAULT_NEED,
    interviewChips: interviewChips, interviewRespond: interviewRespond, buildBlockers: buildBlockers,
    nextVersion: nextVersion, implemented: implemented, partition: partition, devpack: devpack,
    lastRun: lastRun, checklist: checklist
  };
})();
