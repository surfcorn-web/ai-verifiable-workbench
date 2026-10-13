/* tests.js — 第一版 9 個驗收測試（每條規則的 True 和 False 都要 PASS）
 * 全域物件：Tests
 * - 每個案例都從 SEED 的複本開始，不碰 localStorage。
 * - 不可為了讓測試通過而修改本檔，除非使用者同意。
 * 主控台：Tests.runAll()
 */
var Tests = (function () {
  'use strict';

  function fresh() { return Store.clone(SEED); }
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

  // 業務建立並送出一張叫貨單，回傳 { state, id }
  function submitted(db, userId, sku, qty) {
    var r1 = ERP.addLine(db, userId, sku, qty, '測試客戶');
    expect(r1.ok, '加入叫貨失敗：' + r1.message);
    var id = r1.data.order_id;
    var r2 = ERP.submitOrder(r1.state, userId, id);
    expect(r2.ok, '送出失敗：' + r2.message);
    return { state: r2.state, id: id };
  }

  var cases = [
    {
      id: 'TC-001-01', rule: 'RULE-001', req: 'REQ-006', branch: 'True',
      title: '業務查庫存 → 看不到成本',
      given: '業務 阿明 查詢全部庫存',
      expect: '每一筆結果物件都沒有 cost、margin 欄位',
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
        return '回傳 ' + r.data.length + ' 筆，欄位：' + Object.keys(r.data[0]).join(', ');
      }
    },
    {
      id: 'TC-001-02', rule: 'RULE-001', req: 'REQ-006', branch: 'False',
      title: '老闆查庫存 → 可以看到成本',
      given: '老闆 王老闆 查詢規格 205/55R16',
      expect: '結果含 cost（2650）與 margin；庫存資料不變',
      run: function () {
        var db = fresh();
        var r = ERP.queryStock(db, 'U03', '205/55R16');
        expect(r.ok, r.message);
        expect(r.data.length === 1, '筆數不對：' + r.data.length);
        expect(r.data[0].cost === 2650, 'cost 不對：' + r.data[0].cost);
        expect(r.data[0].margin === 650, 'margin 不對：' + r.data[0].margin);
        expect(stock(r.state) === stock(db), '查詢改到了庫存');
        return 'TR-001 cost = ' + r.data[0].cost + '，margin = ' + r.data[0].margin;
      }
    },
    {
      id: 'TC-002-01', rule: 'RULE-002', req: 'REQ-003', branch: 'False',
      title: '叫貨數量 0／負數／小數 → 不可送出',
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
      title: '叫貨數量 2 → 送出成功，尚未預留',
      given: '業務叫貨 TR-003 × 2 並送出',
      expect: '訂單 SUBMITTED；預留不變（核准才預留）',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-003', 2);
        var o = order(x.state, x.id);
        expect(o.status === 'SUBMITTED', '狀態不是 SUBMITTED：' + o.status);
        expect(o.lines[0].qty === 2, '數量不對');
        expect(stock(x.state) === stock(db), '送出就動到庫存（違反 REQ-004）');
        return x.id + ' SUBMITTED，TR-003 可用仍為 ' + avail(x.state, 'TR-003');
      }
    },
    {
      id: 'TC-004-01', rule: 'RULE-004', req: 'REQ-004', branch: 'True',
      title: '可用 124，核准 2 → APPROVED，可用 122',
      given: 'TR-001 在庫 130、預留 6（可用 124），叫貨 2 已送出',
      expect: '王老闆核准 → APPROVED；預留 8、可用 122；在庫不變；稽核 APPROVED',
      run: function () {
        var db = fresh();
        expect(avail(db, 'TR-001') === 124, '前提不符：可用 ' + avail(db, 'TR-001'));
        var x = submitted(db, 'U01', 'TR-001', 2);
        var r = ERP.approveOrder(x.state, 'U03', x.id);
        expect(r.ok, r.message);
        expect(order(r.state, x.id).status === 'APPROVED', '狀態不是 APPROVED');
        expect(product(r.state, 'TR-001').reserved === 8, '預留不是 8');
        expect(product(r.state, 'TR-001').on_hand === 130, '在庫被改動');
        expect(avail(r.state, 'TR-001') === 122, '可用不是 122：' + avail(r.state, 'TR-001'));
        expect(lastAudit(r.state).action === 'APPROVED', '沒有寫 APPROVED 稽核');
        expect(r.message.indexOf('核准成功') >= 0, '訊息不對：' + r.message);
        invariantsOk(r.state);
        return '可用 124 → ' + avail(r.state, 'TR-001') + '；' + r.message;
      }
    },
    {
      id: 'TC-004-02', rule: 'RULE-004', req: 'REQ-004', branch: 'False',
      title: '可用 1，核准 2 → REJECTED，資料不變',
      given: 'TR-002 在庫 3、預留 2（可用 1），叫貨 2 已送出',
      expect: '王老闆核准 → REJECTED；所有品項在庫、預留完全不變；稽核 REJECTED',
      run: function () {
        var db = fresh();
        expect(avail(db, 'TR-002') === 1, '前提不符：可用 ' + avail(db, 'TR-002'));
        var x = submitted(db, 'U01', 'TR-002', 2);
        var before = stock(x.state);
        var others = JSON.stringify(x.state.orders.filter(function (o) { return o.id !== x.id; }));
        var r = ERP.approveOrder(x.state, 'U03', x.id);
        expect(!r.ok, '庫存不足竟然核准成功');
        expect(order(r.state, x.id).status === 'REJECTED', '狀態不是 REJECTED');
        expect(stock(r.state) === before, '庫存資料被改動');
        expect(JSON.stringify(r.state.orders.filter(function (o) { return o.id !== x.id; })) === others, '其他訂單被改動');
        expect(lastAudit(r.state).action === 'REJECTED', '沒有寫 REJECTED 稽核');
        expect(r.message.indexOf('可用庫存不足') >= 0, '訊息不對：' + r.message);
        invariantsOk(r.state);
        return r.message;
      }
    },
    {
      id: 'TC-004-03', rule: 'RULE-004', req: 'REQ-004', branch: '邊界',
      title: '兩人同時核准最後 1 條 → 只有一張 APPROVED',
      given: 'TR-002 可用 1；阿明、小芳各送出 1 條；王老闆與王太太同時打開待審核畫面',
      expect: '兩人畫面都顯示可用 1；依序核准後只有一張 APPROVED、另一張 REJECTED；可用 0',
      run: function () {
        var db = fresh();
        var a = submitted(db, 'U01', 'TR-002', 1);
        var b = submitted(a.state, 'U02', 'TR-002', 1);
        var store = Store.memory(b.state);
        // 兩位老闆的畫面在同一時間載入，看到的可用量都是 1（舊畫面）
        var viewBoss = ERP.view.pending(store.load(), 'U03');
        var viewWife = ERP.view.pending(store.load(), 'U04');
        [viewBoss, viewWife].forEach(function (v) {
          v.filter(function (o) { return o.id === a.id || o.id === b.id; }).forEach(function (o) {
            expect(o.lines[0].available === 1, '前提不符：畫面可用 ' + o.lines[0].available);
          });
        });
        // 核准時以 transact 重新讀取最新狀態，不用畫面上的舊數字
        var r1 = store.transact(function (cur) { return ERP.approveOrder(cur, 'U03', a.id); });
        var r2 = store.transact(function (cur) { return ERP.approveOrder(cur, 'U04', b.id); });
        var fin = store.load();
        var statuses = [order(fin, a.id).status, order(fin, b.id).status];
        var approved = statuses.filter(function (s) { return s === 'APPROVED'; }).length;
        expect(approved === 1, '核准張數是 ' + approved + '（' + statuses.join('、') + '）');
        expect(statuses.indexOf('REJECTED') >= 0, '另一張沒有變成 REJECTED');
        expect(avail(fin, 'TR-002') === 0, '可用不是 0：' + avail(fin, 'TR-002'));
        expect(r1.ok !== r2.ok, '兩次核准結果相同');
        invariantsOk(fin);
        return a.id + ' ' + statuses[0] + '、' + b.id + ' ' + statuses[1] + '；TR-002 可用 ' + avail(fin, 'TR-002');
      }
    },
    {
      id: 'TC-005-01', rule: 'RULE-005', req: 'REQ-007', branch: 'True',
      title: '退回待審核訂單 → RETURNED，可修改重送',
      given: '阿明送出 TR-003 × 2；王老闆退回',
      expect: 'RETURNED；阿明改成 3 後重送 → SUBMITTED；過程中預留不變',
      run: function () {
        var db = fresh();
        var x = submitted(db, 'U01', 'TR-003', 2);
        var r = ERP.returnOrder(x.state, 'U03', x.id, '數量打錯');
        expect(r.ok, r.message);
        expect(order(r.state, x.id).status === 'RETURNED', '狀態不是 RETURNED');
        expect(lastAudit(r.state).action === 'RETURNED', '沒有寫 RETURNED 稽核');
        var r2 = ERP.updateLine(r.state, 'U01', x.id, 'TR-003', 3);
        expect(r2.ok, '退回後不能修改：' + r2.message);
        var r3 = ERP.submitOrder(r2.state, 'U01', x.id);
        expect(r3.ok, '不能重送：' + r3.message);
        var o = order(r3.state, x.id);
        expect(o.status === 'SUBMITTED' && o.lines[0].qty === 3, '重送後狀態或數量不對');
        expect(stock(r3.state) === stock(db), '退回／重送動到庫存');
        return x.id + '：SUBMITTED → RETURNED → 修改為 3 → SUBMITTED';
      }
    },
    {
      id: 'TC-005-02', rule: 'RULE-005', req: 'REQ-007', branch: 'False',
      title: '退回已核准訂單 → 拒絕，狀態不變',
      given: 'SO-0001 已核准；另有一張 DRAFT 購物車',
      expect: '兩者都不能退回，訊息「只有待審核…」；狀態、庫存不變；稽核 RETURN_DENIED',
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
        expect(!r2.ok && order(r2.state, d.data.order_id).status === 'DRAFT', 'DRAFT 竟然可以退回');
        return 'APPROVED、DRAFT 都被拒絕退回；' + r.message;
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

  function runAll() { return cases.map(run); }

  return { cases: cases, byId: byId, run: run, runAll: runAll };
})();
