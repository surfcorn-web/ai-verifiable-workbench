/* erp.js — 輪胎批發 ERP 垂直切片：查庫存 → 叫貨 → 送出 → 老闆核准 → 建立預留 → 更新可用庫存
 * 全域物件：ERP
 * 寫法約定：
 * - 第一個參數為 db；函式內先 clone，不改動傳入的 db。
 * - 回傳 { ok, message, state, data }；state 是新的完整資料（失敗時也帶回，內含稽核紀錄）。
 * - 每個動作都寫 audit（成功與被拒絕都寫）。
 * - 角色一律以 db 裡的使用者資料判斷，不信任畫面傳入的角色。
 * ERP.view.* 是唯讀查詢（給畫面顯示用），不寫 audit、不改資料。
 */
var ERP = (function () {
  'use strict';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function now() { return new Date().toISOString(); }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function result(ok, message, state, data) { return { ok: ok, message: message, state: state, data: data }; }

  function findUser(db, id) { return db.users.filter(function (u) { return u.id === id; })[0] || null; }
  function findProduct(db, sku) { return db.products.filter(function (p) { return p.sku === sku; })[0] || null; }
  function findOrder(db, id) { return db.orders.filter(function (o) { return o.id === id; })[0] || null; }
  function label(p) { return p ? p.spec + ' ' + p.brand + ' ' + p.name : '?'; }
  function statusLabel(s) { return Rules.ORDER_STATUS[s] || s; }

  function audit(db, user, action, rule, target, ok, message, detail) {
    db.audit.push({
      id: 'AU-' + pad(db.seq.audit++, 4),
      at: now(),
      actor: user ? user.id : '-',
      actor_name: user ? user.name : '未知使用者',
      role: user ? user.role : '-',
      action: action, rule: rule || '', target: target || '',
      ok: !!ok, message: message, detail: detail || {}
    });
  }

  function setStatus(order, to, user, note) {
    order.history.push({ at: now(), by: user.id, from: order.status, to: to, note: note || '' });
    order.status = to;
  }

  // 共同的拒絕：只寫稽核，其他資料不變
  function deny(s, user, action, rule, target, message, detail) {
    audit(s, user, action, rule, target, false, message, detail);
    return result(false, message, s);
  }

  // ---------------------------------------------------------------------
  // RULE-001 查庫存：業務的結果物件不含 cost
  // ---------------------------------------------------------------------
  function queryStock(db, userId, keyword) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!u) return deny(s, null, 'QUERY_DENIED', 'RULE-001', userId, '找不到使用者，不能查詢');
    var kw = String(keyword || '').trim().toLowerCase();
    var rows = s.products.filter(function (p) {
      if (!kw) return true;
      return [p.sku, p.spec, p.brand, p.name, String(p.year)].join(' ').toLowerCase().indexOf(kw) >= 0;
    }).map(function (p) { return Rules.viewFor(u, p); });
    var withCost = rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], 'cost');
    var msg = '查到 ' + rows.length + ' 筆' + (withCost ? '（含成本）' : '');
    audit(s, u, 'QUERY', 'RULE-001', kw || '（全部）', true, msg, {
      count: rows.length,
      fields: rows.length ? Object.keys(rows[0]) : Rules.SALES_FIELDS.slice()
    });
    return result(true, msg, s, rows);
  }

  // ---------------------------------------------------------------------
  // RULE-002 叫貨：數量必須為正整數
  // ---------------------------------------------------------------------
  function addLine(db, userId, sku, qty, customer) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!Rules.isSales(u)) return deny(s, u, 'ADD_LINE_DENIED', '', sku, '只有業務可以叫貨');
    var p = findProduct(s, sku);
    if (!p) return deny(s, u, 'ADD_LINE_DENIED', '', sku, '找不到品項 ' + sku);
    if (!Rules.isPositiveInt(qty)) {
      return deny(s, u, 'ADD_LINE_DENIED', 'RULE-002', sku, '叫貨數量必須為正整數', { qty: String(qty) });
    }
    var n = Rules.parseQty(qty);
    var o = s.orders.filter(function (x) { return x.created_by === u.id && x.status === 'DRAFT'; })[0];
    if (!o) {
      o = {
        id: 'SO-' + pad(s.seq.order++, 4), customer: String(customer || '').trim(), created_by: u.id,
        status: 'DRAFT', lines: [], created_at: now(), submitted_at: null,
        decided_at: null, decided_by: null, return_reason: '',
        history: [{ at: now(), by: u.id, from: null, to: 'DRAFT', note: '' }]
      };
      s.orders.push(o);
    } else if (customer && !o.customer) {
      o.customer = String(customer).trim();
    }
    var line = o.lines.filter(function (l) { return l.sku === sku; })[0];
    if (line) line.qty += n; else o.lines.push({ sku: sku, qty: n });
    var msg = '已加入叫貨單 ' + o.id + '：' + p.spec + ' × ' + n;
    audit(s, u, 'ADD_LINE', 'RULE-002', o.id, true, msg, { sku: sku, qty: n });
    return result(true, msg, s, { order_id: o.id });
  }

  function editable(s, u, orderId, action) {
    var o = findOrder(s, orderId);
    if (!o) return { err: '找不到訂單 ' + orderId };
    if (!u || o.created_by !== u.id) return { err: '只有建立這張叫貨單的業務可以修改' };
    if (!Rules.canEdit(o)) return { err: o.id + ' 目前是「' + statusLabel(o.status) + '」，不能修改' };
    return { o: o };
  }

  function updateLine(db, userId, orderId, sku, qty) {
    var s = clone(db);
    var u = findUser(s, userId);
    var e = editable(s, u, orderId);
    if (e.err) return deny(s, u, 'UPDATE_LINE_DENIED', '', orderId, e.err);
    var line = e.o.lines.filter(function (l) { return l.sku === sku; })[0];
    if (!line) return deny(s, u, 'UPDATE_LINE_DENIED', '', orderId, '這張叫貨單沒有 ' + sku);
    if (!Rules.isPositiveInt(qty)) {
      return deny(s, u, 'UPDATE_LINE_DENIED', 'RULE-002', orderId, '叫貨數量必須為正整數', { sku: sku, qty: String(qty) });
    }
    var n = Rules.parseQty(qty);
    var old = line.qty;
    line.qty = n;
    var msg = e.o.id + ' 已修改 ' + sku + '：' + old + ' → ' + n;
    audit(s, u, 'UPDATE_LINE', 'RULE-002', e.o.id, true, msg, { sku: sku, from: old, to: n });
    return result(true, msg, s);
  }

  function removeLine(db, userId, orderId, sku) {
    var s = clone(db);
    var u = findUser(s, userId);
    var e = editable(s, u, orderId);
    if (e.err) return deny(s, u, 'REMOVE_LINE_DENIED', '', orderId, e.err);
    var before = e.o.lines.length;
    e.o.lines = e.o.lines.filter(function (l) { return l.sku !== sku; });
    if (e.o.lines.length === before) return deny(s, u, 'REMOVE_LINE_DENIED', '', orderId, '這張叫貨單沒有 ' + sku);
    var msg = e.o.id + ' 已移除 ' + sku;
    audit(s, u, 'REMOVE_LINE', '', e.o.id, true, msg, { sku: sku });
    return result(true, msg, s);
  }

  function setCustomer(db, userId, orderId, customer) {
    var s = clone(db);
    var u = findUser(s, userId);
    var e = editable(s, u, orderId);
    if (e.err) return deny(s, u, 'SET_CUSTOMER_DENIED', '', orderId, e.err);
    e.o.customer = String(customer || '').trim();
    var msg = e.o.id + ' 客戶：' + (e.o.customer || '（未填）');
    audit(s, u, 'SET_CUSTOMER', '', e.o.id, true, msg);
    return result(true, msg, s);
  }

  // 送出：DRAFT／RETURNED → SUBMITTED；REQ-004 核准才預留，所以送出不動庫存
  function submitOrder(db, userId, orderId) {
    var s = clone(db);
    var u = findUser(s, userId);
    var e = editable(s, u, orderId);
    if (e.err) return deny(s, u, 'SUBMIT_DENIED', '', orderId, e.err);
    if (!e.o.lines.length) return deny(s, u, 'SUBMIT_DENIED', '', orderId, '叫貨單沒有品項，不能送出');
    var bad = e.o.lines.filter(function (l) { return !Rules.isPositiveInt(l.qty); });
    if (bad.length) return deny(s, u, 'SUBMIT_DENIED', 'RULE-002', orderId, '叫貨數量必須為正整數', { skus: bad.map(function (l) { return l.sku; }) });
    var from = e.o.status;
    setStatus(e.o, 'SUBMITTED', u, from === 'RETURNED' ? '修改後重新送出' : '');
    e.o.submitted_at = now();
    var msg = e.o.id + (from === 'RETURNED' ? ' 已重新送出' : ' 已送出') + '，等待老闆核准（核准時才預留）';
    audit(s, u, 'SUBMITTED', 'RULE-002', e.o.id, true, msg, { from: from, lines: clone(e.o.lines) });
    return result(true, msg, s);
  }

  // ---------------------------------------------------------------------
  // RULE-004 老闆核准：核准當下重新讀取庫存；不足 → REJECTED 且庫存完全不變
  // ---------------------------------------------------------------------
  function approveOrder(db, userId, orderId) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!Rules.isBoss(u)) return deny(s, u, 'APPROVE_DENIED', 'RULE-004', orderId, '只有老闆可以核准');
    var o = findOrder(s, orderId);
    if (!o) return deny(s, u, 'APPROVE_DENIED', 'RULE-004', orderId, '找不到訂單 ' + orderId);
    if (!Rules.canApprove(o)) {
      return deny(s, u, 'APPROVE_DENIED', 'RULE-004', o.id, o.id + ' 目前是「' + statusLabel(o.status) + '」，只有待審核訂單可以核准');
    }

    // 合併同品項數量後，逐項讀取「此刻」的 on_hand／reserved
    var need = {};
    o.lines.forEach(function (l) { need[l.sku] = (need[l.sku] || 0) + l.qty; });
    var checks = Object.keys(need).map(function (sku) {
      var p = findProduct(s, sku);
      var avail = p ? Rules.available(p) : 0;
      return { sku: sku, label: label(p), need: need[sku], available: avail, enough: !!p && avail >= need[sku] };
    });
    var short = checks.filter(function (c) { return !c.enough; });

    if (short.length) {
      // False 分支：只改訂單狀態並寫稽核，products 一個欄位都不動
      var why = short.map(function (c) { return c.label.split(' ')[0] + ' 剩 ' + c.available; }).join('；');
      var msgF = '可用庫存不足（' + why + '）';
      setStatus(o, 'REJECTED', u, msgF);
      o.decided_at = now();
      o.decided_by = u.id;
      audit(s, u, 'REJECTED', 'RULE-004', o.id, false, o.id + ' ' + msgF, { checks: checks });
      return result(false, o.id + ' 已拒絕：' + msgF, s, { status: 'REJECTED', checks: checks });
    }

    // True 分支：建立預留
    checks.forEach(function (c) {
      var p = findProduct(s, c.sku);
      c.before = Rules.available(p);
      p.reserved += c.need;
      c.after = Rules.available(p);
    });
    setStatus(o, 'APPROVED', u, '核准成功');
    o.decided_at = now();
    o.decided_by = u.id;
    var change = checks.map(function (c) { return c.label.split(' ')[0] + ' 可用 ' + c.before + ' → ' + c.after; }).join('；');
    audit(s, u, 'APPROVED', 'RULE-004', o.id, true, o.id + ' 核准成功（' + change + '）', { checks: checks });
    return result(true, o.id + ' 核准成功（' + change + '）', s, { status: 'APPROVED', checks: checks });
  }

  // ---------------------------------------------------------------------
  // RULE-005 退回：只有 SUBMITTED 可退回
  // ---------------------------------------------------------------------
  function returnOrder(db, userId, orderId, reason) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!Rules.isBoss(u)) return deny(s, u, 'RETURN_DENIED', 'RULE-005', orderId, '只有老闆可以退回');
    var o = findOrder(s, orderId);
    if (!o) return deny(s, u, 'RETURN_DENIED', 'RULE-005', orderId, '找不到訂單 ' + orderId);
    if (!Rules.canReturn(o)) {
      return deny(s, u, 'RETURN_DENIED', 'RULE-005', o.id, '只有待審核（SUBMITTED）的訂單可以退回；' + o.id + ' 目前是「' + statusLabel(o.status) + '」');
    }
    var r = String(reason || '').trim() || '請修改後重送';
    setStatus(o, 'RETURNED', u, r);
    o.return_reason = r;
    var msg = o.id + ' 已退回，請業務修改後重送（' + r + '）';
    audit(s, u, 'RETURNED', 'RULE-005', o.id, true, msg, { reason: r });
    return result(true, msg, s);
  }

  // ---------------------------------------------------------------------
  // 唯讀查詢（不寫 audit）
  // ---------------------------------------------------------------------
  var view = {
    user: function (db, id) { return findUser(db, id); },
    label: function (db, sku) { return label(findProduct(db, sku)); },
    draft: function (db, userId) {
      return db.orders.filter(function (o) { return o.created_by === userId && o.status === 'DRAFT'; })[0] || null;
    },
    orders: function (db, userId) {
      var u = findUser(db, userId);
      if (!u) return [];
      return db.orders.filter(function (o) {
        return o.status !== 'DRAFT' && (Rules.isBoss(u) || o.created_by === u.id);
      }).slice().reverse();
    },
    // 老闆待審核：附上「此刻」每一行的可用量（畫面參考用；真正判斷在 approveOrder 內重新讀取）
    pending: function (db, userId) {
      if (!Rules.isBoss(findUser(db, userId))) return [];
      return db.orders.filter(function (o) { return o.status === 'SUBMITTED'; }).map(function (o) {
        var c = clone(o);
        c.lines.forEach(function (l) {
          var p = findProduct(db, l.sku);
          l.label = label(p);
          l.available = p ? Rules.available(p) : 0;
          l.enough = !!p && l.available >= l.qty;
        });
        c.enough = c.lines.every(function (l) { return l.enough; });
        return c;
      });
    },
    // 不變式：0 ≤ reserved ≤ on_hand，且 reserved = APPROVED 訂單數量合計
    invariants: function (db) {
      var sum = {};
      db.orders.forEach(function (o) {
        if (o.status !== 'APPROVED') return;
        o.lines.forEach(function (l) { sum[l.sku] = (sum[l.sku] || 0) + l.qty; });
      });
      var bad = [];
      db.products.forEach(function (p) {
        if (p.reserved < 0 || p.reserved > p.on_hand) bad.push(p.sku + '：預留 ' + p.reserved + ' 超出在庫 ' + p.on_hand);
        if ((sum[p.sku] || 0) !== p.reserved) bad.push(p.sku + '：預留 ' + p.reserved + ' ≠ 已核准合計 ' + (sum[p.sku] || 0));
      });
      return bad;
    }
  };

  return {
    queryStock: queryStock,
    addLine: addLine,
    updateLine: updateLine,
    removeLine: removeLine,
    setCustomer: setCustomer,
    submitOrder: submitOrder,
    approveOrder: approveOrder,
    returnOrder: returnOrder,
    view: view
  };
})();
