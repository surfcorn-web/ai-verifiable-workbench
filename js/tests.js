/* tests.js — 驗收測試（每條規則的「成立」和「不成立」都要 PASS）：第一版 13 個＋Sprint 1 進出貨與商品管理 9 個＋Sprint 3 安全庫存警示與規則變更 9 個＋登入與角色權限 7 個
 * 全域物件：Tests
 * - 每個案例都從 SEED 的複本開始，不碰 localStorage。
 * - 2026-10-13 使用者決定改為「送出即預留」（REQ-004B），本檔依新規則改寫（使用者已同意修改 tests.js）。
 * - 之後不可為了讓測試通過而修改本檔，除非使用者同意。
 * 主控台：Tests.runAll()
 */
var Tests = (function () {
  'use strict';

  // 驗收案例都從 SEED 的複本開始；runAll(config) 可以帶入「目前的規則設定」（config.settings），讓回歸測試用新規則重跑
  var config = {};
  function fresh() {
    var db = Store.clone(SEED);
    if (config.settings) db.settings = Store.clone(config.settings);
    return db;
  }
  function product(db, sku) { return db.products.filter(function (p) { return p.sku === sku; })[0]; }
  function order(db, id) { return db.orders.filter(function (o) { return o.id === id; })[0]; }
  function avail(db, sku) { return Rules.available(product(db, sku)); }
  function stock(db) { return JSON.stringify(db.products.map(function (p) { return [p.sku, p.on_hand, p.reserved, p.cost, p.price]; })); }
  function lastAudit(db) { return db.audit[db.audit.length - 1]; }
  function expect(cond, msg) { if (!cond) throw new Error(msg); }
  function invariantsOk(db) {
    var bad = ERP.view.invariants(db);
    expect(bad.length === 0, '庫存不變式被破壞：' + bad.join('；'));
  }

  // 業務把品項放進購物車（不預留），回傳 { state, id }
  function cart(db, userId, sku, qty) {
    var r = ERP.addLine(db, userId, sku, qty, '測試客戶');
    expect(r.ok, '加入叫貨失敗：' + r.message);
    return { state: r.state, id: r.data.order_id };
  }
  // 放進購物車並送出（送出時預留），回傳 { state, id }
  function submitted(db, userId, sku, qty) {
    var c = cart(db, userId, sku, qty);
    var r = ERP.submitOrder(c.state, userId, c.id);
    expect(r.ok, '送出失敗：' + r.message);
    return { state: r.state, id: c.id };
  }

  var cases = [
    {
      id: 'TC-001-01', rule: 'RULE-001', req: 'REQ-006', branch: 'True',
      title: '業務查庫存 → 看不到成本',
      given: '業務 阿明 查詢全部庫存',
      expect: '每一筆結果都沒有成本、毛利欄位',
      run: function () {
        var db = fresh();
        var r = ERP.queryStock(db, 'U01', '');
        expect(r.ok, r.message);
        expect(r.data.length === db.products.length, '筆數不對：' + r.data.length);
        r.data.forEach(function (row) {
          expect(!('cost' in row), row.sku + ' 含 cost 欄位');
          expect(!('margin' in row), row.sku + ' 含 margin 欄位');
        });
        expect(lastAudit(r.state).action === 'QUERY', '沒有寫查詢稽核');
        return '回傳 ' + r.data.length + ' 筆，每一筆都沒有成本、毛利欄位';
      }
    },
    {
      id: 'TC-001-02', rule: 'RULE-001', req: 'REQ-006', branch: 'False',
      title: '老闆查庫存 → 看得到成本',
      given: '老闆 王老闆 查詢規格 205/55R16',
      expect: '結果有成本 2650 與毛利 650；庫存不變',
      run: function () {
        var db = fresh();
        var r = ERP.queryStock(db, 'U03', '205/55R16');
        expect(r.ok, r.message);
        expect(r.data.length === 1, '筆數不對：' + r.data.length);
        expect(r.data[0].cost === 2650, 'cost 不對：' + r.data[0].cost);
        expect(r.data[0].margin === 650, 'margin 不對：' + r.data[0].margin);
        expect(stock(r.state) === stock(db), '查詢改到了庫存');
        return 'TR-001 成本 ' + r.data[0].cost + '，毛利 ' + r.data[0].margin;
      }
    },
    {
      id: 'TC-002-01', rule: 'RULE-002', req: 'REQ-003', branch: 'False',
      title: '叫貨數量填 0、負數、小數、文字 → 不能加入',
      given: '業務叫貨 TR-003，數量 0、-1、1.5、"2.5"、""、"abc"、null',
      expect: '全部被拒，訊息「叫貨數量必須為正整數」，不建立訂單，庫存不變',
      run: function () {
        var db = fresh();
        var bad = [0, -1, 1.5, '2.5', '', 'abc', null];
        bad.forEach(function (q) {
          var r = ERP.addLine(db, 'U01', 'TR-003', q);
          expect(!r.ok, '數量 ' + JSON.stringify(q) + ' 竟然可以加入');
          expect(r.message === '叫貨數量必須為正整數', '訊息不對：' + r.message);
          expect(r.state.orders.length === db.orders.length, '數量 ' + JSON.stringify(q) + ' 建立了訂單');
          expect(stock(r.state) === stock(db), '庫存被改動');
          expect(lastAudit(r.state).action === 'ADD_LINE_DENIED', '沒有寫拒絕稽核');
        });
        return bad.length + ' 種錯誤數量全部被拒，訂單數維持 ' + db.orders.length;
      }
    },
    {
      id: 'TC-002-02', rule: 'RULE-002', req: 'REQ-003', branch: 'True',
      title: '叫貨數量填 2 → 成功加入購物車（還沒預留）',
      given: '業務叫貨 TR-003 × 2（只加入，還沒送出）',
      expect: '訂單是「購物車」；庫存和預留都不變',
      run: function () {
        var db = fresh();
        var c = cart(db, 'U01', 'TR-003', 2);
        var o = order(c.state, c.id);
        expect(o.status === 'DRAFT', '狀態不是 DRAFT：' + o.status);
        expect(o.lines[0].qty === 2, '數量不對');
        expect(stock(c.state) === stock(db), '加入購物車就動到庫存');
        expect(lastAudit(c.state).action === 'ADD_LINE', '沒有寫加入稽核');
        return c.id + ' 購物車，TR-003 可用仍為 ' + avail(c.state, 'TR-003');
      }
    },
    {
      id: 'TC-003-01', rule: 'RULE-003', req: 'REQ-004B', branch: 'True',
      title: '可用 124，送出 2 → 成功，可用變 122',
      given: 'TR-001 在庫 130、預留 6（可用 124），業務送出 2 條',
      expect: '訂單變「待審核」；預留 8、可用 122；在庫不變；稽核「送出並預留」',
      run: function () {
        var db = fresh();
        expect(avail(db, 'TR-001') === 124, '前提不符：可用 ' + avail(db, 'TR-001'));
        var c = cart(db, 'U01', 'TR-001', 2);
        var r = ERP.submitOrder(c.state, 'U01', c.id);
        expect(r.ok, r.message);
        expect(order(r.state, c.id).status === 'SUBMITTED', '狀態不是 SUBMITTED');
        expect(product(r.state, 'TR-001').reserved === 8, '預留不是 8');
        expect(product(r.state, 'TR-001').on_hand === 130, '在庫被改動');
        expect(avail(r.state, 'TR-001') === 122, '可用不是 122：' + avail(r.state, 'TR-001'));
        expect(lastAudit(r.state).action === 'SUBMITTED', '沒有寫 SUBMITTED 稽核');
        expect(r.message.indexOf('已送出') >= 0 && r.message.indexOf('預留') >= 0, '訊息不對：' + r.message);
        invariantsOk(r.state);
        return '可用 124 → ' + avail(r.state, 'TR-001') + '；' + r.message;
      }
    },
    {
      id: 'TC-003-02', rule: 'RULE-003', req: 'REQ-004B', branch: 'False',
      title: '可用 1，送出 2 → 不能送出，資料不變',
      given: 'TR-002 在庫 3、預留 2（可用 1），業務想送出 2 條',
      expect: '被拒絕；訂單留在購物車；所有品項在庫、預留完全不變；稽核「送出被拒」',
      run: function () {
        var db = fresh();
        expect(avail(db, 'TR-002') === 1, '前提不符：可用 ' + avail(db, 'TR-002'));
        var c = cart(db, 'U01', 'TR-002', 2);
        var before = stock(c.state);
        var r = ERP.submitOrder(c.state, 'U01', c.id);
        expect(!r.ok, '庫存不足竟然送出成功');
        expect(order(r.state, c.id).status === 'DRAFT', '訂單不在購物車：' + order(r.state, c.id).status);
        expect(stock(r.state) === before, '庫存資料被改動');
        expect(lastAudit(r.state).action === 'SUBMIT_DENIED', '沒有寫 SUBMIT_DENIED 稽核');
        expect(r.message.indexOf('可用庫存不足') >= 0, '訊息不對：' + r.message);
        invariantsOk(r.state);
        return r.message;
      }
    },
    {
      id: 'TC-003-03', rule: 'RULE-003', req: 'REQ-004B', branch: '邊界',
      title: '兩位業務同時送最後 1 條 → 只有 1 人成功',
      given: 'TR-002 可用 1；阿明、小芳各把 1 條放進購物車，兩人的畫面都顯示可用 1，然後先後按送出',
      expect: '只有 1 張變「待審核」，另 1 張留在購物車並被告知庫存不足；可用 0',
      run: function () {
        var db = fresh();
        var a = cart(db, 'U01', 'TR-002', 1);
        var b = cart(a.state, 'U02', 'TR-002', 1);
        var store = Store.memory(b.state);
        // 兩位業務的畫面在同一時間載入，看到的可用量都是 1（舊畫面）
        expect(ERP.view.availableOf(store.load(), 'TR-002') === 1, '前提不符');
        // 送出時以 transact 重新讀取最新狀態，不用畫面上的舊數字
        var r1 = store.transact(function (cur) { return ERP.submitOrder(cur, 'U01', a.id); });
        var r2 = store.transact(function (cur) { return ERP.submitOrder(cur, 'U02', b.id); });
        var fin = store.load();
        var statuses = [order(fin, a.id).status, order(fin, b.id).status];
        var ok = statuses.filter(function (s) { return s === 'SUBMITTED'; }).length;
        expect(ok === 1, '送出成功的張數是 ' + ok + '（' + statuses.join('、') + '）');
        expect(statuses.indexOf('DRAFT') >= 0, '另一張沒有留在購物車');
        expect(avail(fin, 'TR-002') === 0, '可用不是 0：' + avail(fin, 'TR-002'));
        expect(r1.ok !== r2.ok, '兩次送出結果相同');
        invariantsOk(fin);
        return a.id + '「' + Rules.ORDER_STATUS[statuses[0]] + '」、' + b.id + '「' + Rules.ORDER_STATUS[statuses[1]] + '」；TR-002 可用 ' + avail(fin, 'TR-002');
      }
    },
    {
      id: 'TC-005-01', rule: 'RULE-005', req: 'REQ-007', branch: 'True',
      title: '退回待審核訂單 → 釋放預留，可修改重送',
      given: '阿明送出 TR-003 × 2（已預留）；王老闆退回；阿明改成 3 後重送',
      expect: '退回後預留還給庫存（和一開始一樣）；重送後待審核、預留 3 條',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-003', 2);
        expect(avail(x.state, 'TR-003') === avail(db, 'TR-003') - 2, '送出沒有預留');
        var r = ERP.returnOrder(x.state, 'U03', x.id, '數量打錯');
        expect(r.ok, r.message);
        expect(order(r.state, x.id).status === 'RETURNED', '狀態不是 RETURNED');
        expect(stock(r.state) === stock(db), '退回後預留沒有釋放');
        expect(lastAudit(r.state).action === 'RETURNED', '沒有寫 RETURNED 稽核');
        var r2 = ERP.updateLine(r.state, 'U01', x.id, 'TR-003', 3);
        expect(r2.ok, '退回後不能修改：' + r2.message);
        var r3 = ERP.submitOrder(r2.state, 'U01', x.id);
        expect(r3.ok, '不能重送：' + r3.message);
        var o = order(r3.state, x.id);
        expect(o.status === 'SUBMITTED' && o.lines[0].qty === 3, '重送後狀態或數量不對');
        expect(avail(r3.state, 'TR-003') === avail(db, 'TR-003') - 3, '重送後預留不是 3');
        invariantsOk(r3.state);
        return x.id + '：待審核 → 被退回（預留釋放）→ 修改為 3 → 待審核（預留 3）';
      }
    },
    {
      id: 'TC-005-02', rule: 'RULE-005', req: 'REQ-007', branch: 'False',
      title: '退回已核准訂單 → 被拒絕，狀態不變',
      given: 'SO-0001 已核准；另有一張購物車',
      expect: '兩者都不能退回，訊息「只有待審核…」；狀態、庫存不變；稽核「退回被拒」',
      run: function () {
        var db = fresh();
        var r = ERP.returnOrder(db, 'U03', 'SO-0001', '想退回');
        expect(!r.ok, '已核准訂單竟然可以退回');
        expect(order(r.state, 'SO-0001').status === 'APPROVED', '狀態被改動');
        expect(stock(r.state) === stock(db), '庫存被改動');
        expect(r.message.indexOf('只有待審核') === 0, '訊息不對：' + r.message);
        expect(lastAudit(r.state).action === 'RETURN_DENIED', '沒有寫 RETURN_DENIED 稽核');
        var d = ERP.addLine(db, 'U01', 'TR-007', 1);
        var r2 = ERP.returnOrder(d.state, 'U03', d.data.order_id, '');
        expect(!r2.ok && order(r2.state, d.data.order_id).status === 'DRAFT', '購物車竟然可以退回');
        return '已核准、購物車都被拒絕退回；' + r.message;
      }
    },
    {
      id: 'TC-006-01', rule: 'RULE-006', req: 'REQ-010', branch: 'True',
      title: '老闆核准待審核訂單 → 已核准，庫存不變',
      given: '阿明送出 TR-001 × 2（可用 122）；王老闆核准',
      expect: '訂單變「已核准」；預留與可用都和核准前一樣（預留早就建立了）；稽核「老闆核准」',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-001', 2);
        var before = stock(x.state);
        var r = ERP.approveOrder(x.state, 'U03', x.id);
        expect(r.ok, r.message);
        expect(order(r.state, x.id).status === 'APPROVED', '狀態不是 APPROVED');
        expect(stock(r.state) === before, '核准改動了庫存');
        expect(avail(r.state, 'TR-001') === 122, '可用不是 122：' + avail(r.state, 'TR-001'));
        expect(lastAudit(r.state).action === 'APPROVED', '沒有寫 APPROVED 稽核');
        expect(r.message.indexOf('核准成功') >= 0, '訊息不對：' + r.message);
        invariantsOk(r.state);
        return r.message;
      }
    },
    {
      id: 'TC-006-02', rule: 'RULE-006', req: 'REQ-010', branch: 'False',
      title: '業務核准、重複核准、核准購物車 → 都被拒絕',
      given: '一張待審核訂單；業務想核准；老闆核准兩次；老闆想核准購物車',
      expect: '只有老闆第一次核准成功，其餘都被拒絕，狀態與庫存不變，稽核「核准被拒」',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-001', 2);
        var before = stock(x.state);
        var r1 = ERP.approveOrder(x.state, 'U02', x.id);
        expect(!r1.ok && order(r1.state, x.id).status === 'SUBMITTED' && stock(r1.state) === before, '業務竟然能核准');
        expect(lastAudit(r1.state).action === 'APPROVE_DENIED', '沒有寫 APPROVE_DENIED 稽核');
        var d = cart(db, 'U01', 'TR-007', 1);
        var r2 = ERP.approveOrder(d.state, 'U03', d.id);
        expect(!r2.ok && order(r2.state, d.id).status === 'DRAFT', '購物車竟然能核准');
        var a = ERP.approveOrder(x.state, 'U03', x.id);
        expect(a.ok, '老闆第一次核准失敗：' + a.message);
        var b = ERP.approveOrder(a.state, 'U04', x.id);
        expect(!b.ok && stock(b.state) === stock(a.state), '重複核准竟然成功或改動了庫存');
        invariantsOk(b.state);
        return '業務核准、核准購物車、重複核准都被拒絕';
      }
    },
    {
      id: 'TC-007-01', rule: 'RULE-007', req: 'REQ-010', branch: 'True',
      title: '老闆拒絕待審核訂單 → 釋放預留，可用恢復',
      given: '阿明送出 TR-001 × 2（可用 122）；王老闆拒絕',
      expect: '訂單變「已拒絕」；可用回到 124，庫存和一開始一模一樣；稽核「老闆拒絕」',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-001', 2);
        expect(avail(x.state, 'TR-001') === 122, '前提不符');
        var r = ERP.rejectOrder(x.state, 'U03', x.id, '客戶取消');
        expect(r.ok, r.message);
        expect(order(r.state, x.id).status === 'REJECTED', '狀態不是 REJECTED');
        expect(stock(r.state) === stock(db), '拒絕後預留沒有釋放');
        expect(avail(r.state, 'TR-001') === 124, '可用不是 124');
        expect(lastAudit(r.state).action === 'REJECTED', '沒有寫 REJECTED 稽核');
        invariantsOk(r.state);
        return r.message;
      }
    },
    {
      id: 'TC-007-02', rule: 'RULE-007', req: 'REQ-010', branch: 'False',
      title: '業務拒絕、拒絕已核准或購物車 → 都被拒絕',
      given: '一張待審核訂單；業務想拒絕；老闆想拒絕已核准的 SO-0001；老闆想拒絕購物車',
      expect: '全部被拒絕，狀態與庫存不變，稽核「拒絕被拒」',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-001', 2);
        var before = stock(x.state);
        var r1 = ERP.rejectOrder(x.state, 'U02', x.id, '');
        expect(!r1.ok && order(r1.state, x.id).status === 'SUBMITTED' && stock(r1.state) === before, '業務竟然能拒絕');
        expect(lastAudit(r1.state).action === 'REJECT_DENIED', '沒有寫 REJECT_DENIED 稽核');
        var r2 = ERP.rejectOrder(x.state, 'U03', 'SO-0001', '');
        expect(!r2.ok && order(r2.state, 'SO-0001').status === 'APPROVED' && stock(r2.state) === before, '已核准訂單竟然能拒絕');
        var d = cart(db, 'U01', 'TR-007', 1);
        var r3 = ERP.rejectOrder(d.state, 'U03', d.id, '');
        expect(!r3.ok && order(r3.state, d.id).status === 'DRAFT', '購物車竟然能拒絕');
        invariantsOk(r3.state);
        return '業務拒絕、拒絕已核准、拒絕購物車都被拒絕';
      }
    },
    // ---------- Sprint 1：商品＋進出貨（新增；上面原有的案例沒有改動）----------
    {
      id: 'TC-021-01', rule: 'RULE-021', req: 'REQ-019', branch: 'True',
      title: '老闆進貨 10 條 → 在庫增加，留下進貨單',
      given: '老闆 王老闆 對 TR-001 進貨 10 條（在庫 130、預留 6）',
      expect: '在庫變 140、預留不變、可用變 134；產生進貨單 RC-0001；稽核「進貨入庫」；其他商品不變',
      run: function () {
        var db = fresh();
        var r = ERP.receiveStock(db, 'U03', 'TR-001', 10, '供應商到貨');
        expect(r.ok, r.message);
        expect(product(r.state, 'TR-001').on_hand === 140, '在庫不是 140：' + product(r.state, 'TR-001').on_hand);
        expect(product(r.state, 'TR-001').reserved === 6, '預留被改動');
        expect(avail(r.state, 'TR-001') === 134, '可用不是 134');
        var rc = r.state.receipts || [];
        expect(rc.length === 1 && rc[0].id === 'RC-0001' && rc[0].qty === 10 && rc[0].sku === 'TR-001', '進貨單不對');
        expect(lastAudit(r.state).action === 'RECEIVED', '沒有寫 RECEIVED 稽核');
        var others = function (d) { return JSON.stringify(d.products.filter(function (p) { return p.sku !== 'TR-001'; })); };
        expect(others(r.state) === others(db), '其他商品被改動');
        invariantsOk(r.state);
        return r.message;
      }
    },
    {
      id: 'TC-021-02', rule: 'RULE-021', req: 'REQ-019', branch: 'False',
      title: '進貨數量填 0、負數、小數，或業務進貨 → 被拒絕',
      given: '老闆進貨 TR-001，數量 0、-1、1.5、"2.5"、""、"abc"、null；另外業務想進貨、老闆想進不存在的商品',
      expect: '全部被拒絕，庫存與進貨單完全不變，稽核「進貨被拒」',
      run: function () {
        var db = fresh();
        var bad = [0, -1, 1.5, '2.5', '', 'abc', null];
        bad.forEach(function (q) {
          var r = ERP.receiveStock(db, 'U03', 'TR-001', q);
          expect(!r.ok && r.message === '進貨數量必須為正整數', '數量 ' + JSON.stringify(q) + ' 竟然可以進貨：' + r.message);
          expect(stock(r.state) === stock(db) && (r.state.receipts || []).length === 0, '資料被改動');
          expect(lastAudit(r.state).action === 'RECEIVE_DENIED', '沒有寫拒絕稽核');
        });
        var s = ERP.receiveStock(db, 'U01', 'TR-001', 5);
        expect(!s.ok && stock(s.state) === stock(db) && s.message.indexOf('只有老闆') === 0, '業務竟然能進貨');
        var n = ERP.receiveStock(db, 'U03', 'TR-999', 5);
        expect(!n.ok && stock(n.state) === stock(db), '不存在的商品竟然能進貨');
        return bad.length + ' 種錯誤數量、業務進貨、不存在的商品，全部被拒絕';
      }
    },
    {
      id: 'TC-021-03', rule: 'RULE-021', req: 'REQ-019', branch: '邊界',
      title: '同一商品連續進貨 → 在庫累加，進貨單號依序',
      given: '王老闆對 TR-003 進貨 5 條，王太太再進貨 7 條（在庫原本 48）',
      expect: '在庫變 60；進貨單 RC-0001、RC-0002 不重複，各自記下進貨前後的在庫',
      run: function () {
        var db = fresh();
        var a = ERP.receiveStock(db, 'U03', 'TR-003', 5);
        var b = ERP.receiveStock(a.state, 'U04', 'TR-003', 7);
        expect(a.ok && b.ok, '連續進貨失敗');
        expect(product(b.state, 'TR-003').on_hand === 60, '在庫不是 60：' + product(b.state, 'TR-003').on_hand);
        var ids = b.state.receipts.map(function (x) { return x.id; });
        expect(ids.join() === 'RC-0001,RC-0002', '進貨單號不對：' + ids.join());
        expect(b.state.receipts[1].before === 53 && b.state.receipts[1].after === 60, '進貨前後的在庫沒記對');
        invariantsOk(b.state);
        return '在庫 48 → 53 → 60；進貨單 ' + ids.join('、');
      }
    },
    {
      id: 'TC-010-01', rule: 'RULE-010', req: 'REQ-024', branch: 'True',
      title: '老闆對已核准的訂單按出貨完成 → 在庫與預留一起扣，可用不變',
      given: '阿明送出 TR-001 × 2 並經老闆核准（在庫 130、預留 8、可用 122）；老闆按出貨完成。另外出貨種子訂單 SO-0001（兩個品項）',
      expect: '訂單變「已出貨」；在庫 128、預留 6、可用仍是 122；SO-0001 兩個品項的預留都變 0、可用不變；稽核「出貨完成」',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-001', 2);
        var ap = ERP.approveOrder(x.state, 'U03', x.id);
        expect(ap.ok, ap.message);
        expect(product(ap.state, 'TR-001').on_hand === 130 && product(ap.state, 'TR-001').reserved === 8, '核准就動到庫存');
        var r = ERP.shipOrder(ap.state, 'U03', x.id);
        expect(r.ok, r.message);
        expect(order(r.state, x.id).status === 'SHIPPED', '狀態不是 SHIPPED');
        var p = product(r.state, 'TR-001');
        expect(p.on_hand === 128 && p.reserved === 6, '在庫或預留不對：' + p.on_hand + '／' + p.reserved);
        expect(avail(r.state, 'TR-001') === 122, '可用變了：' + avail(r.state, 'TR-001'));
        expect(lastAudit(r.state).action === 'SHIPPED' && r.message.indexOf('出貨完成') >= 0, '稽核或訊息不對');
        invariantsOk(r.state);
        var m = ERP.shipOrder(db, 'U03', 'SO-0001');
        expect(m.ok, m.message);
        expect(product(m.state, 'TR-001').on_hand === 124 && product(m.state, 'TR-001').reserved === 0, 'TR-001 沒扣對');
        expect(product(m.state, 'TR-004').on_hand === 48 && product(m.state, 'TR-004').reserved === 0, 'TR-004 沒扣對');
        expect(avail(m.state, 'TR-001') === 124 && avail(m.state, 'TR-004') === 48, '可用變了');
        invariantsOk(m.state);
        return '在庫 130 → 128、預留 8 → 6、可用維持 122；SO-0001 兩個品項一併出貨';
      }
    },
    {
      id: 'TC-010-02', rule: 'RULE-010', req: 'REQ-024', branch: 'False',
      title: '業務出貨、出貨待審核或購物車的訂單 → 被拒絕',
      given: '業務想出貨已核准的 SO-0001；老闆想出貨待審核的 SO-0004、購物車、不存在的訂單',
      expect: '全部被拒絕；訂單狀態與庫存完全不變；稽核「出貨被拒」',
      run: function () {
        var db = fresh(); var before = stock(db);
        var a = ERP.shipOrder(db, 'U01', 'SO-0001');
        expect(!a.ok && a.message.indexOf('只有老闆') === 0 && stock(a.state) === before && order(a.state, 'SO-0001').status === 'APPROVED', '業務竟然能出貨');
        expect(lastAudit(a.state).action === 'SHIP_DENIED', '沒有寫 SHIP_DENIED 稽核');
        var b = ERP.shipOrder(db, 'U03', 'SO-0004');
        expect(!b.ok && b.message.indexOf('只有已核准') === 0 && order(b.state, 'SO-0004').status === 'SUBMITTED' && stock(b.state) === before, '待審核的訂單竟然能出貨：' + b.message);
        var c = cart(db, 'U01', 'TR-007', 1);
        var d = ERP.shipOrder(c.state, 'U03', c.id);
        expect(!d.ok && order(d.state, c.id).status === 'DRAFT' && stock(d.state) === stock(c.state), '購物車竟然能出貨');
        var e = ERP.shipOrder(db, 'U03', 'SO-9999');
        expect(!e.ok && stock(e.state) === before, '不存在的訂單竟然能出貨');
        return '業務、待審核、購物車、不存在的訂單都不能出貨';
      }
    },
    {
      id: 'TC-010-03', rule: 'RULE-010', req: 'REQ-024', branch: '邊界',
      title: '同一張單出貨兩次 → 第二次被拒絕，在庫只扣一次',
      given: '老闆出貨 SO-0001，王太太再按一次出貨',
      expect: '第二次被拒絕；TR-001 在庫只從 130 扣到 124（不是 118）；出貨紀錄只有一筆',
      run: function () {
        var db = fresh();
        var a = ERP.shipOrder(db, 'U03', 'SO-0001');
        var b = ERP.shipOrder(a.state, 'U04', 'SO-0001');
        expect(a.ok && !b.ok, '第二次出貨沒被拒絕');
        expect(stock(b.state) === stock(a.state), '重複出貨改動了庫存');
        expect(product(b.state, 'TR-001').on_hand === 124, '在庫被扣了兩次：' + product(b.state, 'TR-001').on_hand);
        expect(order(b.state, 'SO-0001').history.filter(function (h) { return h.to === 'SHIPPED'; }).length === 1, '出貨紀錄不只一筆');
        invariantsOk(b.state);
        return '在庫 130 → 124，只扣一次';
      }
    },
    {
      id: 'TC-011-01', rule: 'RULE-011', req: 'REQ-025', branch: 'True',
      title: '老闆新增商品並改價 → 商品出現，業務看不到成本',
      given: '王老闆新增 195/60R15 固特異（成本 1900、售價 2400），再把售價改成 2500、成本改成 2000',
      expect: '新商品編號 TR-009、在庫 0；業務查得到但沒有成本欄位；改價後售價 2500；其他商品不變；稽核「新增商品」「修改價格」',
      run: function () {
        var db = fresh();
        var f = { brand: '固特異 Goodyear', name: 'Assurance', spec: '195/60R15', year: 2025, cost: 1900, price: 2400 };
        var a = ERP.addProduct(db, 'U03', f);
        expect(a.ok && a.data.sku === 'TR-009', '新增失敗：' + a.message);
        var p = product(a.state, 'TR-009');
        expect(p.on_hand === 0 && p.reserved === 0 && p.price === 2400 && p.cost === 1900, '新商品資料不對');
        expect(a.state.products.length === db.products.length + 1, '商品數量不對');
        expect(lastAudit(a.state).action === 'PRODUCT_ADDED', '沒有寫 PRODUCT_ADDED 稽核');
        var q = ERP.queryStock(a.state, 'U01', '195/60R15');
        expect(q.data.length === 1 && !('cost' in q.data[0]) && q.data[0].price === 2400, '業務查得到商品，但不可看到成本');
        var u = ERP.updateProduct(a.state, 'U03', 'TR-009', { price: 2500, cost: 2000 });
        expect(u.ok && product(u.state, 'TR-009').price === 2500 && product(u.state, 'TR-009').cost === 2000, '改價失敗：' + u.message);
        expect(lastAudit(u.state).action === 'PRODUCT_UPDATED', '沒有寫 PRODUCT_UPDATED 稽核');
        var others = function (d) { return JSON.stringify(d.products.filter(function (x) { return x.sku !== 'TR-009'; })); };
        expect(others(u.state) === others(db), '其他商品被改動');
        invariantsOk(u.state);
        return a.message;
      }
    },
    {
      id: 'TC-011-02', rule: 'RULE-011', req: 'REQ-025', branch: 'False',
      title: '業務新增、缺資料、價格不合理 → 被拒絕',
      given: '業務想新增商品或改價；老闆新增時缺品牌、缺規格、年份亂填、售價 0 或負數、成本負數；改價填 0、改不存在的商品、價格沒變動',
      expect: '全部被拒絕；商品清單與價格完全不變；稽核「商品異動被拒」',
      run: function () {
        var db = fresh();
        var ext = function (a, b) { var o = {}; Object.keys(a).forEach(function (k) { o[k] = a[k]; }); Object.keys(b).forEach(function (k) { o[k] = b[k]; }); return o; };
        var good = { brand: '固特異 Goodyear', name: 'Assurance', spec: '195/60R15', year: 2025, cost: 1900, price: 2400 };
        var tries = [
          ['業務新增商品', function () { return ERP.addProduct(db, 'U01', good); }],
          ['缺品牌', function () { return ERP.addProduct(db, 'U03', ext(good, { brand: '' })); }],
          ['缺規格', function () { return ERP.addProduct(db, 'U03', ext(good, { spec: '  ' })); }],
          ['年份亂填', function () { return ERP.addProduct(db, 'U03', ext(good, { year: 'abc' })); }],
          ['年份太早', function () { return ERP.addProduct(db, 'U03', ext(good, { year: 1800 })); }],
          ['售價 0', function () { return ERP.addProduct(db, 'U03', ext(good, { price: 0 })); }],
          ['售價負數', function () { return ERP.addProduct(db, 'U03', ext(good, { price: -5 })); }],
          ['售價不是數字', function () { return ERP.addProduct(db, 'U03', ext(good, { price: 'abc' })); }],
          ['成本負數', function () { return ERP.addProduct(db, 'U03', ext(good, { cost: -1 })); }],
          ['業務改價', function () { return ERP.updateProduct(db, 'U01', 'TR-001', { price: 3500 }); }],
          ['改價填 0', function () { return ERP.updateProduct(db, 'U03', 'TR-001', { price: 0 }); }],
          ['改不存在的商品', function () { return ERP.updateProduct(db, 'U03', 'TR-999', { price: 100 }); }],
          ['價格沒有變動', function () { return ERP.updateProduct(db, 'U03', 'TR-001', { price: 3300, cost: 2650 }); }]
        ];
        tries.forEach(function (t) {
          var r = t[1]();
          expect(!r.ok, t[0] + ' 竟然成功：' + r.message);
          expect(JSON.stringify(r.state.products) === JSON.stringify(db.products), t[0] + ' 改動了商品');
          expect(lastAudit(r.state).action === 'PRODUCT_DENIED', t[0] + ' 沒有寫 PRODUCT_DENIED 稽核');
        });
        return tries.length + ' 種不合理的新增或改價，全部被拒絕';
      }
    },
    {
      id: 'TC-011-03', rule: 'RULE-011', req: 'REQ-025', branch: '邊界',
      title: '重複新增同一個商品 → 被拒絕，編號不跳號',
      given: '老闆新增 195/60R15 固特異；再新增一次相同的；再新增另一個商品',
      expect: '重複的那次被拒絕且不消耗編號；新商品依序是 TR-009、TR-010',
      run: function () {
        var db = fresh();
        var f = { brand: '固特異 Goodyear', name: 'Assurance', spec: '195/60R15', year: 2025, cost: 1900, price: 2400 };
        var a = ERP.addProduct(db, 'U03', f);
        var dup = ERP.addProduct(a.state, 'U04', { brand: '固特異 goodyear', name: 'assurance', spec: '195/60r15', year: 2025, cost: 1800, price: 2300 });
        expect(a.ok && !dup.ok && dup.message.indexOf('已經有這個商品') === 0, '重複新增沒被拒絕：' + dup.message);
        expect(dup.state.products.length === a.state.products.length, '重複新增多了一筆商品');
        var b = ERP.addProduct(dup.state, 'U03', { brand: '建大 Kenda', name: 'KR202', spec: '195/60R15', year: 2025, cost: 1500, price: 1900 });
        expect(b.ok && b.data.sku === 'TR-010', '編號跳號了：' + b.data.sku);
        invariantsOk(b.state);
        return '編號 TR-009、TR-010，沒有跳號';
      }
    },
    {
      id: 'TC-026-01', rule: 'RULE-026', req: 'REQ-026', branch: 'True',
      title: '可用庫存低於安全庫存 → 標示低庫存',
      given: '225/45R17 可用只有 1、安全庫存 5；235/45R18 可用 0、安全庫存 5',
      expect: '這兩個品項都出現在低庫存提醒清單，清單帶有可用與安全庫存的數字；庫存本身不變',
      run: function () {
        var db = fresh();
        var before = stock(db);
        var low = ERP.view.lowStock(db);
        var skus = low.map(function (x) { return x.sku; });
        expect(skus.indexOf('TR-002') >= 0 && skus.indexOf('TR-005') >= 0, '應該提醒 TR-002、TR-005，實際：' + skus.join(','));
        var r = low.filter(function (x) { return x.sku === 'TR-002'; })[0];
        expect(r.available === 1 && r.safety === 5, '清單上的數字不對：' + JSON.stringify(r));
        expect(stock(db) === before, '查看提醒不應該改動庫存');
        return '提醒清單：' + low.map(function (x) { return x.spec + ' 可用 ' + x.available + '／安全 ' + x.safety; }).join('；');
      }
    },
    {
      id: 'TC-026-02', rule: 'RULE-026', req: 'REQ-026', branch: 'False',
      title: '可用庫存夠多、或沒設安全庫存 → 不提醒',
      given: '205/55R16 可用 124（安全庫存 20）；185/65R15 可用 80（安全庫存 30）；新增一個沒設安全庫存的商品',
      expect: '這三個都不在提醒清單；沒設安全庫存（0）的商品就算可用是 0 也不提醒',
      run: function () {
        var db = fresh();
        var skus = ERP.view.lowStock(db).map(function (x) { return x.sku; });
        expect(skus.indexOf('TR-001') < 0 && skus.indexOf('TR-007') < 0, '庫存夠多卻被提醒：' + skus.join(','));
        var a = ERP.addProduct(db, 'U03', { brand: '固特異 Goodyear', name: 'Assurance', spec: '195/60R15', year: 2025, cost: 1900, price: 2400 });
        expect(a.ok && a.state.products[a.state.products.length - 1].safety === 0, '新商品的安全庫存應該是 0');
        expect(ERP.view.lowStock(a.state).every(function (x) { return x.sku !== a.data.sku; }), '沒設安全庫存的商品不該被提醒');
        return '205/55R16、185/65R15 與沒設安全庫存的新商品都沒有被提醒';
      }
    },
    {
      id: 'TC-026-03', rule: 'RULE-026', req: 'REQ-026', branch: '邊界',
      title: '可用剛好等於安全庫存 → 依「目前規則」決定要不要提醒',
      given: '225/40R18 可用 8、安全庫存 8（剛好相等）',
      expect: '規則是「小於」→ 不提醒；規則是「小於或等於」→ 提醒（預期會跟著規則變）',
      run: function () {
        var db = fresh();
        var op = ERP.view.lowRule(db);
        var inList = ERP.view.lowStock(db).some(function (x) { return x.sku === 'TR-008'; });
        expect(inList === (op === 'le'), '目前規則是「' + Rules.LOW_OPS[op].short + '」，剛好相等時' + (inList ? '提醒了' : '沒提醒') + '，和規則不符');
        return '目前規則「' + Rules.LOW_OPS[op].short + '」：可用 8 ＝ 安全庫存 8 → ' + (inList ? '提醒' : '不提醒');
      }
    },
    {
      id: 'TC-026-04', rule: 'RULE-026', req: 'REQ-026', branch: '邊界',
      title: '規則從「小於」改成「小於或等於」→ 剛好相等的品項才開始被提醒',
      given: '規則是「小於」；老闆把規則改成「小於或等於」並寫理由',
      expect: '225/40R18（可用 8 ＝ 安全 8）改規則前不提醒、改後提醒；原本就會提醒的品項前後都在；稽核記下前後與理由',
      run: function () {
        var db = fresh();
        db.settings = { low_stock_op: 'lt' };
        var inList = function (d, sku) { return ERP.view.lowStock(d).some(function (x) { return x.sku === sku; }); };
        expect(!inList(db, 'TR-008') && inList(db, 'TR-002') && inList(db, 'TR-005'), '改規則前的清單不對');
        var r = ERP.setLowStockRule(db, 'U03', 'le', '剛好用完安全庫存也要提醒');
        expect(r.ok, '改規則失敗：' + r.message);
        expect(inList(r.state, 'TR-008') && inList(r.state, 'TR-002') && inList(r.state, 'TR-005'), '改規則後的清單不對');
        var a = lastAudit(r.state);
        expect(a.action === 'LOWRULE_CHANGED' && a.detail.before === 'lt' && a.detail.after === 'le' && a.detail.reason.indexOf('用完安全庫存') >= 0, '稽核沒有記下前後與理由');
        invariantsOk(r.state);
        return '改規則前 2 項提醒、改後 3 項（多了 225/40R18）；稽核：' + a.message;
      }
    },
    {
      id: 'TC-027-01', rule: 'RULE-027', req: 'REQ-026', branch: 'True',
      title: '老闆設定安全庫存 → 更新並留下紀錄',
      given: '老闆把 205/55R16 的安全庫存從 20 改成 130（可用 124）',
      expect: '安全庫存變 130、205/55R16 開始被提醒；在庫與預留不變；稽核記下 20 → 130',
      run: function () {
        var db = fresh();
        var before = stock(db);
        var r = ERP.setSafetyStock(db, 'U03', 'TR-001', 130);
        expect(r.ok, '設定失敗：' + r.message);
        expect(product(r.state, 'TR-001').safety === 130, '安全庫存沒有更新');
        expect(ERP.view.lowStock(r.state).some(function (x) { return x.sku === 'TR-001'; }), '設到比可用還高，應該開始提醒');
        expect(stock(r.state) === before, '設定安全庫存不應該動到在庫、預留');
        var a = lastAudit(r.state);
        expect(a.action === 'SAFETY_SET' && a.detail.before === 20 && a.detail.after === 130, '稽核沒有記下前後');
        invariantsOk(r.state);
        return r.message;
      }
    },
    {
      id: 'TC-027-02', rule: 'RULE-027', req: 'REQ-026', branch: 'False',
      title: '業務設定、或填 -1、1.5、文字 → 被拒絕',
      given: '業務阿明想設定；老闆填 -1、1.5、"abc"、空的',
      expect: '全部被拒絕，安全庫存完全不變，每次都留下被拒絕的稽核',
      run: function () {
        var db = fresh();
        var snap = JSON.stringify(db.products);
        var a = ERP.setSafetyStock(db, 'U01', 'TR-001', 50);
        expect(!a.ok && a.message.indexOf('只有老闆') === 0 && JSON.stringify(a.state.products) === snap, '業務竟然能設定：' + a.message);
        var cur = a.state;
        [-1, 1.5, 'abc', null, ''].forEach(function (bad) {
          var r = ERP.setSafetyStock(cur, 'U03', 'TR-001', bad);
          expect(!r.ok && r.message.indexOf('0 或正整數') >= 0, '不合理的數字竟然通過：' + JSON.stringify(bad));
          expect(JSON.stringify(r.state.products) === snap, '被拒絕後資料還是變了');
          cur = r.state;
        });
        var none = ERP.setSafetyStock(cur, 'U03', 'NOPE', 5);
        expect(!none.ok, '不存在的品項竟然通過');
        expect(lastAudit(none.state).action === 'SAFETY_DENIED', '沒有留下被拒絕的稽核');
        return '業務與 5 種不合理的數字都被拒絕，安全庫存不變';
      }
    },
    {
      id: 'TC-027-03', rule: 'RULE-027', req: 'REQ-026', branch: '邊界',
      title: '安全庫存設成 0 → 不再提醒',
      given: '225/45R17（可用 1，原本會提醒）的安全庫存設成 0',
      expect: '設定成功；225/45R17 從提醒清單消失；訊息說明 0 代表不設警示',
      run: function () {
        var db = fresh();
        expect(ERP.view.lowStock(db).some(function (x) { return x.sku === 'TR-002'; }), '設定前 TR-002 應該在提醒清單');
        var r = ERP.setSafetyStock(db, 'U04', 'TR-002', 0);
        expect(r.ok && r.message.indexOf('不設警示') >= 0, '設成 0 失敗：' + r.message);
        expect(!ERP.view.lowStock(r.state).some(function (x) { return x.sku === 'TR-002'; }), '設成 0 之後還在提醒');
        return r.message;
      }
    },
    {
      id: 'TC-028-01', rule: 'RULE-028', req: 'REQ-026', branch: 'True',
      title: '老闆修改低庫存規則並寫理由 → 設定改變並留下前後紀錄',
      given: '規則是「小於」；老闆改成「小於或等於」，理由「剛好用完也要提醒」',
      expect: '設定變成「小於或等於」；稽核記下前後與理由；庫存不變',
      run: function () {
        var db = fresh();
        db.settings = { low_stock_op: 'lt' };
        var before = stock(db);
        var r = ERP.setLowStockRule(db, 'U03', 'le', '剛好用完也要提醒');
        expect(r.ok && r.state.settings.low_stock_op === 'le', '設定沒有改成「小於或等於」：' + r.message);
        var a = lastAudit(r.state);
        expect(a.action === 'LOWRULE_CHANGED' && a.detail.before === 'lt' && a.detail.after === 'le' && a.detail.reason === '剛好用完也要提醒', '稽核內容不對');
        expect(stock(r.state) === before, '改規則不應該動到庫存');
        var back = ERP.setLowStockRule(r.state, 'U03', 'lt', '回復：先維持原本的規則');
        expect(back.ok && back.state.settings.low_stock_op === 'lt', '改回去失敗：' + back.message);
        return r.message;
      }
    },
    {
      id: 'TC-028-02', rule: 'RULE-028', req: 'REQ-026', branch: 'False',
      title: '業務修改、沒寫理由、和目前相同、亂填 → 被拒絕',
      given: '業務阿明想改；老闆沒寫理由；老闆選和目前一樣的；老闆填不存在的比較方式',
      expect: '全部被拒絕，規則設定完全不變，每次都留下被拒絕的稽核',
      run: function () {
        var db = fresh();
        db.settings = { low_stock_op: 'lt' };
        var tries = [
          ['U01', 'le', '想改', '只有老闆'],
          ['U03', 'le', '   ', '為什麼要改'],
          ['U03', 'lt', '沒變', '沒有需要修改'],
          ['U03', 'xx', '亂填', '只能選']
        ];
        var cur = db;
        tries.forEach(function (t) {
          var r = ERP.setLowStockRule(cur, t[0], t[1], t[2]);
          expect(!r.ok && r.message.indexOf(t[3]) >= 0, '應該被拒絕（' + t[3] + '）但是：' + r.message);
          expect(r.state.settings.low_stock_op === 'lt', '被拒絕後設定還是變了');
          expect(lastAudit(r.state).action === 'LOWRULE_DENIED', '沒有留下被拒絕的稽核');
          cur = r.state;
        });
        return '4 種不該改的情況都被拒絕，設定維持「小於」';
      }
    },
    {
      id: 'TC-029-01', rule: 'RULE-029', req: 'REQ-027', branch: 'True',
      title: '帳號與密碼正確 → 登入成功並留下紀錄',
      given: '老闆、管理員、業務、倉管、生管各用自己的帳號與正確密碼登入（帳號大小寫不影響）',
      expect: '每個人都登入成功，拿到自己的角色；稽核記下「登入」與是誰；庫存與訂單都不變',
      run: function () {
        var db = fresh();
        var before = stock(db), orders = JSON.stringify(db.orders);
        var roles = [];
        ['U03', 'U07', 'U01', 'U05', 'U06'].forEach(function (id) {
          var u = db.users.filter(function (x) { return x.id === id; })[0];
          var r = ERP.login(db, id === 'U03' ? u.account.toUpperCase() : ' ' + u.account + ' ', u.password);
          expect(r.ok && r.data.user_id === id && r.data.role === u.role, id + ' 登入失敗：' + r.message);
          var a = lastAudit(r.state);
          expect(a.action === 'LOGIN' && a.actor === id && a.ok === true, '稽核沒有記下登入');
          expect(stock(r.state) === before && JSON.stringify(r.state.orders) === orders, '登入不應該改動庫存與訂單');
          roles.push(Rules.ROLE[u.role]);
        });
        return '五種角色都能登入：' + roles.join('、');
      }
    },
    {
      id: 'TC-029-02', rule: 'RULE-029', req: 'REQ-027', branch: 'False',
      title: '密碼錯、帳號不存在、帳號或密碼空白 → 不登入，也不說是哪個錯',
      given: '老闆帳號配錯密碼；不存在的帳號；空白帳號；空白密碼；密碼多一個空格',
      expect: '全部登入失敗，訊息一模一樣「帳號或密碼不正確」；資料不變，只多一筆「登入失敗」稽核',
      run: function () {
        var db = fresh();
        var boss = db.users.filter(function (x) { return x.id === 'U03'; })[0];
        var tries = [[boss.account, 'wrong'], ['nobody', boss.password], ['', boss.password], [boss.account, ''], [boss.account, boss.password + ' ']];
        var cur = db, msgs = {};
        tries.forEach(function (t, i) {
          var r = ERP.login(cur, t[0], t[1]);
          expect(!r.ok && !r.data, '第 ' + (i + 1) + ' 種不該登入成功');
          msgs[r.message] = true;
          var a = lastAudit(r.state);
          expect(a.action === 'LOGIN_DENIED' && a.ok === false, '沒有留下登入失敗的稽核');
          expect(r.state.audit.length === cur.audit.length + 1 && stock(r.state) === stock(db) && JSON.stringify(r.state.orders) === JSON.stringify(db.orders), '資料被動到了');
          cur = r.state;
        });
        expect(Object.keys(msgs).length === 1 && msgs['帳號或密碼不正確'], '失敗訊息不一致，會洩漏哪個是錯的：' + Object.keys(msgs).join('｜'));
        return '5 種失敗都是同一句「帳號或密碼不正確」，各留一筆稽核';
      }
    },
    {
      id: 'TC-029-03', rule: 'RULE-029', req: 'REQ-027', branch: '邊界',
      title: '密碼不會出現在登入結果、查詢結果與稽核紀錄',
      given: '用每個帳號登入，並查詢庫存；登入失敗也記錄',
      expect: '所有登入結果、查詢結果、稽核紀錄的文字裡，都找不到任何人的密碼',
      run: function () {
        var db = fresh();
        var pws = db.users.map(function (u) { return u.password; });
        var cur = db, text = '';
        db.users.forEach(function (u) {
          var r = ERP.login(cur, u.account, u.password);
          text += JSON.stringify(r.data) + r.message;
          cur = r.state;
          var q = ERP.queryStock(cur, u.id, '');
          text += JSON.stringify(q.data);
          cur = q.state;
        });
        cur = ERP.login(cur, 'ming', 'wrong').state;
        text += JSON.stringify(cur.audit);
        pws.forEach(function (p) { expect(text.indexOf(p) < 0, '輸出裡出現了密碼：' + p.slice(0, 2) + '…'); });
        expect(JSON.stringify(cur.audit).indexOf('wrong') < 0, '稽核紀錄不該記下輸入的密碼');
        return '7 個帳號登入與查詢後，結果與稽核都沒有密碼';
      }
    },
    {
      id: 'TC-030-01', rule: 'RULE-030', req: 'REQ-027', branch: 'True',
      title: '管理員與老闆擁有全部權限',
      given: '老闆與管理員各做一輪：看成本與毛利、核准、出貨、進貨、新增商品、改價、設定安全庫存',
      expect: '每一項都成功；查詢結果有成本與毛利',
      run: function () {
        var out = [];
        ['U03', 'U07'].forEach(function (id, k) {
          var db = fresh();
          var q = ERP.queryStock(db, id, '205/55R16');
          expect(q.data.length === 1 && q.data[0].cost === 2650 && q.data[0].margin === 650, id + ' 應該看得到成本與毛利');
          var sub = submitted(db, 'U01', 'TR-001', 1);
          var ap = ERP.approveOrder(sub.state, id, sub.id); expect(ap.ok, id + ' 核准：' + ap.message);
          var sh = ERP.shipOrder(ap.state, id, sub.id); expect(sh.ok, id + ' 出貨：' + sh.message);
          var rc = ERP.receiveStock(sh.state, id, 'TR-001', 5, ''); expect(rc.ok, id + ' 進貨：' + rc.message);
          var np = ERP.addProduct(rc.state, id, { brand: '固特異 Goodyear', name: 'Assurance', spec: '195/60R15', year: 2025, cost: 1900, price: 2400, retail: 3100 }); expect(np.ok, id + ' 新增商品：' + np.message);
          var up = ERP.updateProduct(np.state, id, 'TR-001', { price: 3400, retail: 4400 }); expect(up.ok, id + ' 改價：' + up.message);
          var sf = ERP.setSafetyStock(up.state, id, 'TR-001', 25); expect(sf.ok, id + ' 設安全庫存：' + sf.message);
          var lr = ERP.setLowStockRule(sf.state, id, ERP.view.lowRule(sf.state) === 'lt' ? 'le' : 'lt', '測試'); expect(lr.ok, id + ' 改低庫存規則：' + lr.message);
          invariantsOk(lr.state);
          out.push(Rules.ROLE[db.users.filter(function (u) { return u.id === id; })[0].role]);
        });
        return out.join('、') + '都能看成本，並完成核准、出貨、進貨、新增商品、改價、設安全庫存、改低庫存規則';
      }
    },
    {
      id: 'TC-030-02', rule: 'RULE-030', req: 'REQ-027', branch: '邊界',
      title: '員工（業務、倉管、生管）看不到成本與毛利，看得到店家價、末端價、庫存與安全庫存',
      given: '業務、倉管、生管各查全部庫存；老闆先新增一個有成本的新商品再查',
      expect: '每一筆結果都有店家價、末端價、在庫、預留、可用、安全庫存，沒有成本和毛利（新商品也一樣）',
      run: function () {
        var db = fresh();
        var np = ERP.addProduct(db, 'U07', { brand: '固特異 Goodyear', name: 'Assurance', spec: '195/60R15', year: 2025, cost: 1900, price: 2400, retail: 3100 });
        expect(np.ok, '新增商品失敗：' + np.message);
        var must = ['price', 'retail', 'on_hand', 'reserved', 'available', 'safety'];
        ['U01', 'U05', 'U06'].forEach(function (id) {
          var q = ERP.queryStock(np.state, id, '');
          expect(q.ok && q.data.length === 9, id + ' 應查到 9 筆');
          q.data.forEach(function (row) {
            must.forEach(function (k) { expect(Object.prototype.hasOwnProperty.call(row, k), id + ' 缺欄位 ' + k); });
            expect(!('cost' in row) && !('margin' in row), id + ' 竟然看到成本或毛利');
          });
          var tr1 = q.data.filter(function (r) { return r.sku === 'TR-001'; })[0];
          expect(tr1.price === 3300 && tr1.retail === 4300 && tr1.safety === 20, id + ' 的價格或安全庫存不對');
          var a = lastAudit(q.state);
          expect(a.detail.fields.indexOf('cost') < 0 && a.detail.fields.indexOf('safety') >= 0, '稽核記下的欄位不對');
        });
        return '業務、倉管、生管都看得到店家價、末端價與安全庫存，看不到成本與毛利';
      }
    },
    {
      id: 'TC-030-03', rule: 'RULE-030', req: 'REQ-027', branch: 'False',
      title: '員工做管理動作 → 全部被拒絕，資料不變',
      given: '業務、倉管、生管各嘗試：核准、拒絕、退回、出貨、進貨、新增商品、改價、設定安全庫存、改低庫存規則',
      expect: '27 次嘗試全部被拒絕，訊息都以「只有老闆」開頭；庫存、訂單、商品、設定完全不變；每次都留下被拒絕的稽核',
      run: function () {
        var base = fresh();
        var snap = JSON.stringify([base.products, base.orders, base.receipts, base.settings]);
        var n = 0;
        ['U01', 'U05', 'U06'].forEach(function (id) {
          var cur = base;
          var tries = [
            function () { return ERP.approveOrder(cur, id, 'SO-0004'); },
            function () { return ERP.rejectOrder(cur, id, 'SO-0004', 'x'); },
            function () { return ERP.returnOrder(cur, id, 'SO-0004', 'x'); },
            function () { return ERP.shipOrder(cur, id, 'SO-0001'); },
            function () { return ERP.receiveStock(cur, id, 'TR-001', 5, ''); },
            function () { return ERP.addProduct(cur, id, { brand: 'A', name: 'a', spec: '1/1R1', year: 2025, cost: 1, price: 2, retail: 3 }); },
            function () { return ERP.updateProduct(cur, id, 'TR-001', { price: 3400 }); },
            function () { return ERP.setSafetyStock(cur, id, 'TR-001', 30); },
            function () { return ERP.setLowStockRule(cur, id, 'le', '想改'); }
          ];
          tries.forEach(function (go, i) {
            var r = go();
            expect(!r.ok && r.message.indexOf('只有老闆') === 0, id + ' 第 ' + (i + 1) + ' 項竟然沒被擋下：' + r.message);
            expect(JSON.stringify([r.state.products, r.state.orders, r.state.receipts, r.state.settings]) === snap, id + ' 第 ' + (i + 1) + ' 項被擋下後資料還是變了');
            expect(r.state.audit.length === cur.audit.length + 1 && lastAudit(r.state).ok === false, '沒有留下被拒絕的稽核');
            cur = r.state;
            n++;
          });
        });
        return n + ' 次嘗試全部被拒絕，資料不變';
      }
    },
    {
      id: 'TC-030-04', rule: 'RULE-030', req: 'REQ-027', branch: 'False',
      title: '只有業務可以叫貨：倉管、生管、老闆、管理員叫貨 → 被拒絕',
      given: '倉管、生管、老闆、管理員各想把 205/55R16 ×1 加入叫貨單；業務阿明做同樣的事',
      expect: '前四者被拒絕（訊息「只有業務可以叫貨」）、沒有建立訂單；阿明成功',
      run: function () {
        var db = fresh();
        ['U05', 'U06', 'U03', 'U07'].forEach(function (id) {
          var r = ERP.addLine(db, id, 'TR-001', 1);
          expect(!r.ok && r.message === '只有業務可以叫貨' && r.state.orders.length === db.orders.length, id + ' 竟然能叫貨：' + r.message);
        });
        var ok = ERP.addLine(db, 'U01', 'TR-001', 1);
        expect(ok.ok && ok.state.orders.length === db.orders.length + 1, '業務應該能叫貨：' + ok.message);
        return '倉管、生管、老闆、管理員都不能叫貨；業務可以';
      }
    }
  ];

  function byId(id) { return cases.filter(function (c) { return c.id === id; })[0] || null; }

  function run(c) {
    var t0 = Date.now();
    try {
      var actual = c.run();
      return { id: c.id, rule: c.rule, pass: true, actual: actual, ms: Date.now() - t0 };
    } catch (e) {
      return { id: c.id, rule: c.rule, pass: false, actual: e && e.message ? e.message : String(e), ms: Date.now() - t0 };
    }
  }

  function runAll(cfg) {
    config = cfg || {};
    try { return cases.map(run); } finally { config = {}; }
  }

  return { cases: cases, byId: byId, run: run, runAll: runAll };
})();
