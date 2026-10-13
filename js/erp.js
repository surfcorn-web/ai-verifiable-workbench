/* erp.js — 輪胎批發 ERP 垂直切片：查庫存 → 叫貨 → 送出（建立預留、更新可用庫存）→ 老闆核准
 * 全域物件：ERP
 * 預留規則（REQ-004B 送出即預留）：
 *   送出時重新讀取庫存，足夠才預留（reserved += qty）；退回、老闆拒絕時釋放（reserved −= qty）；核准只改狀態。
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

  // 一張訂單每個品項要用的數量（同品項合併）
  function need(o) {
    var n = {};
    o.lines.forEach(function (l) { n[l.sku] = (n[l.sku] || 0) + l.qty; });
    return n;
  }

  // 此刻每個品項的可用庫存是否足夠（送出時重新讀取）
  function checkStock(s, o) {
    var n = need(o);
    return Object.keys(n).map(function (sku) {
      var p = findProduct(s, sku);
      var avail = p ? Rules.available(p) : 0;
      return { sku: sku, spec: p ? p.spec : sku, label: label(p), need: n[sku], available: avail, enough: !!p && avail >= n[sku] };
    });
  }

  // 釋放這張單預留的數量（退回、拒絕）
  function release(s, o) {
    var n = need(o);
    return Object.keys(n).map(function (sku) {
      var p = findProduct(s, sku);
      var before = Rules.available(p);
      p.reserved -= n[sku];
      return { sku: sku, spec: p.spec, qty: n[sku], before: before, after: Rules.available(p) };
    });
  }

  function changeText(rows) {
    return rows.map(function (c) { return c.spec + ' 可用 ' + c.before + ' → ' + c.after; }).join('；');
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
  // RULE-002 叫貨：數量必須為正整數（加入購物車不預留，送出才預留）
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
    var msg = '已加入叫貨單 ' + o.id + '：' + p.spec + ' × ' + n + '（送出後才會預留庫存）';
    audit(s, u, 'ADD_LINE', 'RULE-002', o.id, true, msg, { sku: sku, qty: n });
    return result(true, msg, s, { order_id: o.id });
  }

  function editable(s, u, orderId) {
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

  // ---------------------------------------------------------------------
  // RULE-003 送出即預留：送出當下重新讀取庫存；足夠 → 預留並變成待審核；不足 → 不可送出且資料不變
  // ---------------------------------------------------------------------
  function submitOrder(db, userId, orderId) {
    var s = clone(db);
    var u = findUser(s, userId);
    var e = editable(s, u, orderId);
    if (e.err) return deny(s, u, 'SUBMIT_DENIED', '', orderId, e.err);
    var o = e.o;
    if (!o.lines.length) return deny(s, u, 'SUBMIT_DENIED', '', orderId, '叫貨單沒有品項，不能送出');
    var bad = o.lines.filter(function (l) { return !Rules.isPositiveInt(l.qty); });
    if (bad.length) return deny(s, u, 'SUBMIT_DENIED', 'RULE-002', orderId, '叫貨數量必須為正整數', { skus: bad.map(function (l) { return l.sku; }) });

    var checks = checkStock(s, o);
    var short = checks.filter(function (c) { return !c.enough; });
    if (short.length) {
      var why = short.map(function (c) { return c.spec + ' 剩 ' + c.available; }).join('；');
      return deny(s, u, 'SUBMIT_DENIED', 'RULE-003', o.id, o.id + ' 不能送出：可用庫存不足（' + why + '）', { checks: checks });
    }

    var rows = checks.map(function (c) {
      var p = findProduct(s, c.sku);
      var before = Rules.available(p);
      p.reserved += c.need;
      return { sku: c.sku, spec: c.spec, qty: c.need, before: before, after: Rules.available(p) };
    });
    var from = o.status;
    setStatus(o, 'SUBMITTED', u, from === 'RETURNED' ? '修改後重新送出，並重新預留' : '送出並預留');
    o.submitted_at = now();
    var msg = o.id + (from === 'RETURNED' ? ' 已重新送出' : ' 已送出') + '並預留（' + changeText(rows) + '），等待老闆核准';
    audit(s, u, 'SUBMITTED', 'RULE-003', o.id, true, msg, { from: from, reserved: rows });
    return result(true, msg, s, { reserved: rows });
  }

  // ---------------------------------------------------------------------
  // RULE-006 老闆核准：只改狀態，庫存不變（預留在送出時已建立）
  // ---------------------------------------------------------------------
  function approveOrder(db, userId, orderId) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!Rules.isBoss(u)) return deny(s, u, 'APPROVE_DENIED', 'RULE-006', orderId, '只有老闆可以核准');
    var o = findOrder(s, orderId);
    if (!o) return deny(s, u, 'APPROVE_DENIED', 'RULE-006', orderId, '找不到訂單 ' + orderId);
    if (!Rules.canApprove(o)) {
      return deny(s, u, 'APPROVE_DENIED', 'RULE-006', o.id, '只有待審核的訂單可以核准；' + o.id + ' 目前是「' + statusLabel(o.status) + '」');
    }
    setStatus(o, 'APPROVED', u, '核准成功');
    o.decided_at = now();
    o.decided_by = u.id;
    var msg = o.id + ' 核准成功（預留在送出時就建立了，庫存不變）';
    audit(s, u, 'APPROVED', 'RULE-006', o.id, true, msg);
    return result(true, msg, s, { status: 'APPROVED' });
  }

  // ---------------------------------------------------------------------
  // RULE-007 老闆拒絕：待審核 → 已拒絕，並釋放預留
  // ---------------------------------------------------------------------
  function rejectOrder(db, userId, orderId, reason) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!Rules.isBoss(u)) return deny(s, u, 'REJECT_DENIED', 'RULE-007', orderId, '只有老闆可以拒絕');
    var o = findOrder(s, orderId);
    if (!o) return deny(s, u, 'REJECT_DENIED', 'RULE-007', orderId, '找不到訂單 ' + orderId);
    if (!Rules.canReject(o)) {
      return deny(s, u, 'REJECT_DENIED', 'RULE-007', o.id, '只有待審核的訂單可以拒絕；' + o.id + ' 目前是「' + statusLabel(o.status) + '」');
    }
    var r = String(reason || '').trim() || '老闆拒絕';
    var rows = release(s, o);
    setStatus(o, 'REJECTED', u, r);
    o.decided_at = now();
    o.decided_by = u.id;
    var msg = o.id + ' 已拒絕，預留已釋放（' + changeText(rows) + '）';
    audit(s, u, 'REJECTED', 'RULE-007', o.id, true, msg, { reason: r, released: rows });
    return result(true, msg, s, { status: 'REJECTED', released: rows });
  }

  // ---------------------------------------------------------------------
  // RULE-005 退回：只有待審核可退回，並釋放預留
  // ---------------------------------------------------------------------
  function returnOrder(db, userId, orderId, reason) {
    var s = clone(db);
    var u = findUser(s, userId);
    if (!Rules.isBoss(u)) return deny(s, u, 'RETURN_DENIED', 'RULE-005', orderId, '只有老闆可以退回');
    var o = findOrder(s, orderId);
    if (!o) return deny(s, u, 'RETURN_DENIED', 'RULE-005', orderId, '找不到訂單 ' + orderId);
    if (!Rules.canReturn(o)) {
      return deny(s, u, 'RETURN_DENIED', 'RULE-005', o.id, '只有待審核的訂單可以退回；' + o.id + ' 目前是「' + statusLabel(o.status) + '」');
    }
    var r = String(reason || '').trim() || '請修改後重送';
    var rows = release(s, o);
    setStatus(o, 'RETURNED', u, r);
    o.return_reason = r;
    var msg = o.id + ' 已退回，預留已釋放，請業務修改後重送（' + r + '）';
    audit(s, u, 'RETURNED', 'RULE-005', o.id, true, msg, { reason: r, released: rows });
    return result(true, msg, s, { released: rows });
  }

  // ---------------------------------------------------------------------
  // 唯讀查詢（不寫 audit）
  // ---------------------------------------------------------------------
  var view = {
    user: function (db, id) { return findUser(db, id); },
    label: function (db, sku) { return label(findProduct(db, sku)); },
    spec: function (db, sku) { var p = findProduct(db, sku); return p ? p.spec : sku; },
    availableOf: function (db, sku) { var p = findProduct(db, sku); return p ? Rules.available(p) : 0; },
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
    // 老闆待審核（預留都已建立）
    pending: function (db, userId) {
      if (!Rules.isBoss(findUser(db, userId))) return [];
      return db.orders.filter(function (o) { return o.status === 'SUBMITTED'; }).map(function (o) {
        var c = clone(o);
        c.lines.forEach(function (l) { l.label = label(findProduct(db, l.sku)); });
        return c;
      });
    },
    // 不變式：0 ≤ reserved ≤ on_hand，且 reserved = 待審核與已核准訂單的數量合計
    invariants: function (db) {
      var sum = {};
      db.orders.forEach(function (o) {
        if (Rules.RESERVING.indexOf(o.status) < 0) return;
        o.lines.forEach(function (l) { sum[l.sku] = (sum[l.sku] || 0) + l.qty; });
      });
      var bad = [];
      db.products.forEach(function (p) {
        if (p.reserved < 0 || p.reserved > p.on_hand) bad.push(p.sku + '：預留 ' + p.reserved + ' 超出在庫 ' + p.on_hand);
        if ((sum[p.sku] || 0) !== p.reserved) bad.push(p.sku + '：預留 ' + p.reserved + ' ≠ 待審核與已核准合計 ' + (sum[p.sku] || 0));
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
    rejectOrder: rejectOrder,
    returnOrder: returnOrder,
    view: view
  };
})();
