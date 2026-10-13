/* tests.js — 第一版 13 個驗收測試（每條規則的「成立」和「不成立」都要 PASS）
 * 全域物件：Tests
 * - 每個案例都從 SEED 的複本開始，不碰 localStorage。
 * - 2026-10-13 使用者決定改為「送出即預留」（REQ-004B），本檔依新規則改寫（使用者已同意修改 tests.js）。
 * - 之後不可為了讓測試通過而修改本檔，除非使用者同意。
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
