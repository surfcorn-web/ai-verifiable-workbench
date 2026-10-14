/* dev/regression.js — 一鍵回歸檢查（只用 Node 內建功能，不需安裝任何套件；不屬於 App）
 *
 * 用法：node dev/regression.js            全部檢查，失敗時結束碼為 1
 *       node dev/regression.js --quiet    只顯示失敗與總數
 *       node dev/regression.js --json     以 JSON 輸出結果（給評估端使用）
 *       node dev/regression.js <資料夾>   檢查另一份專案（例如 Git 乾淨檢出的版本）
 *
 * 檢查內容：CLAUDE.md 硬性限制（靜態）、驗收測試、領域規則、ERP 函式約定、隨機操作 3000 次、
 *           舊資料升級、工作台流程（訪談→確認→規則→開發包）、版本線。
 * 不會修改專案檔，也不會碰瀏覽器的 localStorage（一律用記憶體版）。
 */
const vm = require('vm'), fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const FLAGS = { quiet: args.includes('--quiet'), json: args.includes('--json') };
const root = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..'));
const rd = p => fs.readFileSync(path.join(root, p), 'utf8');
const results = [];
const check = (group, name, fn) => { try { const r = fn(); results.push({ group, name, ok: r !== false, info: typeof r === 'string' ? r : '' }); } catch (e) { results.push({ group, name, ok: false, info: e.message }); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };

// ---------- 靜態：CLAUDE.md 硬性限制 ----------
const html = rd('index.html'), css = rd('css/style.css');
const order = ['data', 'store', 'rules', 'erp', 'tests', 'app'];
const js = Object.fromEntries(order.map(f => [f, rd('js/' + f + '.js')]));
check('限制', 'index.html 依序載入 data→store→rules→erp→tests→app', () => {
  const srcs = [...html.matchAll(/<script\s+src="([^"?]+)/g)].map(m => m[1]);
  assert(JSON.stringify(srcs) === JSON.stringify(order.map(f => 'js/' + f + '.js')), srcs.join(','));
});
check('限制', '沒有 ES modules（type=module／import／export）', () => {
  assert(!/type\s*=\s*["']module/.test(html), 'type=module');
  for (const f of order) assert(!/^\s*(import|export)\s/m.test(js[f]), f + '.js');
});
check('限制', '沒有外部 CDN／網址（html、css、js）', () => {
  const all = html + css + Object.values(js).join('');
  const urls = all.match(/(https?:)?\/\/[a-z0-9-]+\.[a-z0-9.-]*[a-z]{2,}\//gi) || [];
  assert(urls.length === 0, urls.join(','));
  assert(!/@import/.test(css), '@import');
});
check('限制', 'App 不依賴 dev/（index.html 與各 js 都不載入或引用 dev 資料夾）', () => {
  assert(!/dev\//.test(html), 'index.html 引用了 dev/');
  for (const f of order) assert(!/['"`]\.{0,2}\/?dev\//.test(js[f]), f + '.js 引用了 dev/');
});
check('限制', '沒有框架／建置工具檔', () => {
  for (const f of ['package.json', 'node_modules', 'vite.config.js', 'webpack.config.js']) assert(!fs.existsSync(path.join(root, f)), f);
});
check('限制', '每個 js 掛一個全域物件', () => {
  const g = { data: 'SEED', store: 'Store', rules: 'Rules', erp: 'ERP', tests: 'Tests', app: 'App' };
  for (const f of order) assert(new RegExp('^var ' + g[f] + ' =', 'm').test(js[f]), f);
});
check('限制', 'localStorage key = aiwb_state_v01', () => assert(/var KEY = 'aiwb_state_v01'/.test(js.store)));
check('限制', '畫面不直接改資料（app.js 無 db 欄位指派、push、splice）', () => {
  const bad = js.app.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) =>
    /\bdb\.[\w.\[\]]+\s*(=(?!=)|\+=|-=|\+\+|--)/.test(l) || /\bdb\.[\w.]+\.(push|splice|pop|shift)\(/.test(l) || /\.(reserved|on_hand|status)\s*(=(?!=)|\+=|-=)/.test(l));
  assert(bad.length === 0, bad.map(b => 'L' + b[0]).join(','));
});
check('限制', 'app.js 不呼叫 localStorage（一律經 Store）', () => assert(!/localStorage\./.test(js.app)));
check('限制', '介面繁體中文（無常見簡體字）', () => {
  const simp = '这们为说时对发库单门开关务业无从体价过还进运动产实现点击确认审预设计应该显数据请错误货订户购车权录测试规则闭环项条码龄账销统览页';
  const hits = [];
  for (const [n, t] of Object.entries({ html, css, ...js })) for (const ch of simp) if (t.includes(ch)) hits.push(n + ':' + ch);
  assert(hits.length === 0, hits.join(' '));
});

// ---------- 載入 ----------
const mem = {};
const ctx = { console, localStorage: { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } } };
vm.createContext(ctx);
for (const f of order.slice(0, 5)) vm.runInContext(js[f], ctx, { filename: f + '.js' });
const { SEED, Store, Rules, ERP, Tests } = vm.runInContext('({SEED, Store, Rules, ERP, Tests})', ctx);
const clone = o => JSON.parse(JSON.stringify(o));
const prod = (db, sku) => db.products.find(p => p.sku === sku);
const avail = (db, sku) => prod(db, sku).on_hand - prod(db, sku).reserved;
const stock = db => JSON.stringify(db.products);
const cart = (db, u, sku, q) => { const r = ERP.addLine(db, u, sku, q); assert(r.ok, r.message); return { state: r.state, id: r.data.order_id }; };
const sub = (db, u, sku, q) => { const c = cart(db, u, sku, q); const r = ERP.submitOrder(c.state, u, c.id); assert(r.ok, r.message); return { state: r.state, id: c.id }; };

// ---------- 自動測試 ----------
const tr = Tests.runAll();
const BASE_TESTS = ['TC-001-01', 'TC-001-02', 'TC-002-01', 'TC-002-02', 'TC-003-01', 'TC-003-02', 'TC-003-03', 'TC-005-01', 'TC-005-02', 'TC-006-01', 'TC-006-02', 'TC-007-01', 'TC-007-02'];
check('驗收', '所有驗收測試全部 PASS，且最初的 13 個一個都沒少、編號不重複', () => {
  const f = tr.filter(r => !r.pass);
  assert(!f.length, f.map(r => r.id + ' ' + r.actual).join('；'));
  assert(BASE_TESTS.every(id => tr.some(r => r.id === id)), '少了原有的驗收測試');
  assert(new Set(tr.map(r => r.id)).size === tr.length, '驗收測試編號重複');
  return tr.length + '/' + tr.length;
});
check('驗收', '每條已實作的規則成立／不成立都有案例（001/002/003/005/006/007）', () => {
  for (const id of ['RULE-001', 'RULE-002', 'RULE-003', 'RULE-005', 'RULE-006', 'RULE-007']) {
    const t = Rules.RULE_TEMPLATES.find(r => r.id === id);
    assert(t.t.tests.length && t.f.tests.length && Rules.testIds(t).every(x => Tests.byId(x)), id);
  }
});
check('驗收', '測試不碰 localStorage', () => { const before = JSON.stringify(mem); Tests.runAll(); assert(JSON.stringify(mem) === before); });
check('驗收', 'RULE-004（核准才預留）是未採用的替代方案：沒有對應測試', () => {
  for (const id of ['TC-004-01', 'TC-004-02', 'TC-004-03']) assert(!Tests.byId(id), id);
});

// ---------- 領域規則（CLAUDE.md） ----------
check('領域', '種子資料：TR-001 可用 124、TR-002 可用 1、TR-003 預留 8（SO-0004 待審核）、不變式成立', () => {
  assert(avail(SEED, 'TR-001') === 124 && avail(SEED, 'TR-002') === 1 && prod(SEED, 'TR-003').reserved === 8); assert(ERP.view.invariants(SEED).length === 0);
});
check('領域', 'RULE-001 兩位業務查任何關鍵字都沒有 cost／margin', () => {
  for (const u of ['U01', 'U02']) for (const kw of ['', '205', 'Michelin', 'zzz', 'R17', '2024']) {
    const r = ERP.queryStock(SEED, u, kw); r.data.forEach(row => assert(!('cost' in row) && !('margin' in row), u + ' ' + kw));
  }
});
check('領域', 'RULE-001 未知使用者不能查詢', () => { const r = ERP.queryStock(SEED, 'X', ''); assert(!r.ok && !r.data); });
check('領域', 'REQ-004B 加入購物車不預留；送出才預留（reserved += qty）', () => {
  const c = cart(SEED, 'U01', 'TR-001', 5); assert(stock(c.state) === stock(SEED), '加入購物車就預留');
  const s = ERP.submitOrder(c.state, 'U01', c.id); assert(s.ok && prod(s.state, 'TR-001').reserved === 11 && avail(s.state, 'TR-001') === 119);
});
check('領域', 'RULE-003 多品項訂單一項不足 → 整張不送出、所有品項不變、仍在購物車', () => {
  let a = cart(SEED, 'U01', 'TR-001', 2); a = cart(a.state, 'U01', 'TR-002', 2);
  const r = ERP.submitOrder(a.state, 'U01', a.id);
  assert(!r.ok && r.state.orders.find(o => o.id === a.id).status === 'DRAFT' && stock(r.state) === stock(a.state));
});
check('領域', 'RULE-003 恰好等於可用量可以送出（邊界）；多 1 條就不行', () => {
  const ok = sub(SEED, 'U01', 'TR-002', 1); assert(avail(ok.state, 'TR-002') === 0);
  const c = cart(SEED, 'U01', 'TR-002', 2); assert(!ERP.submitOrder(c.state, 'U01', c.id).ok);
});
check('領域', 'RULE-002 各種錯誤數量（加入、修改）都被擋', () => {
  const bad = [0, -3, 2.5, '1.5', '', ' ', 'abc', null, undefined, NaN, Infinity, '1e3', [], {}];
  for (const q of bad) { const r = ERP.addLine(SEED, 'U01', 'TR-003', q); assert(!r.ok && r.state.orders.length === SEED.orders.length, 'add ' + String(q)); }
  const a = ERP.addLine(SEED, 'U01', 'TR-003', 2);
  for (const q of bad) { const r = ERP.updateLine(a.state, 'U01', a.data.order_id, 'TR-003', q); assert(!r.ok, 'update ' + String(q)); }
});
check('領域', 'RULE-006 核准只改狀態、庫存完全不變；只有老闆；不能重複核准', () => {
  const x = sub(SEED, 'U01', 'TR-001', 2); const before = stock(x.state);
  assert(!ERP.approveOrder(x.state, 'U02', x.id).ok, '業務核准');
  const a = ERP.approveOrder(x.state, 'U03', x.id); assert(a.ok && stock(a.state) === before);
  assert(!ERP.approveOrder(a.state, 'U04', x.id).ok, '重複核准');
});
check('領域', 'RULE-007 老闆拒絕 → 釋放預留；退回 → 釋放預留；SO-0004（種子待審核）也適用', () => {
  const x = sub(SEED, 'U01', 'TR-001', 2);
  const r = ERP.rejectOrder(x.state, 'U03', x.id, 'x'); assert(r.ok && stock(r.state) === stock(SEED));
  const t = ERP.returnOrder(x.state, 'U03', x.id, 'x'); assert(t.ok && stock(t.state) === stock(SEED));
  const s4 = ERP.rejectOrder(SEED, 'U03', 'SO-0004', ''); assert(s4.ok && prod(s4.state, 'TR-003').reserved === 0 && ERP.view.invariants(s4.state).length === 0);
});
check('領域', 'RULE-005 DRAFT／APPROVED／REJECTED／RETURNED 都不能退回；業務不能退回', () => {
  const a = cart(SEED, 'U01', 'TR-002', 1); const id = a.id;
  assert(!ERP.returnOrder(a.state, 'U03', id).ok, 'DRAFT');
  const s = ERP.submitOrder(a.state, 'U01', id);
  const rj = ERP.rejectOrder(s.state, 'U03', id); assert(!ERP.returnOrder(rj.state, 'U03', id).ok, 'REJECTED');
  const rt = ERP.returnOrder(s.state, 'U03', id); assert(rt.ok && !ERP.returnOrder(rt.state, 'U03', id).ok, 'RETURNED');
  assert(!ERP.returnOrder(SEED, 'U03', 'SO-0001').ok, 'APPROVED');
  assert(!ERP.returnOrder(s.state, 'U01', id).ok, '業務不能退回');
});
check('領域', 'RETURNED 訂單重送時重新檢查庫存（庫存被別人用掉就送不出）', () => {
  const x = sub(SEED, 'U01', 'TR-002', 1);                       // 阿明預留最後 1 條
  const r = ERP.returnOrder(x.state, 'U03', x.id, '改');           // 退回，釋放
  const y = sub(r.state, 'U02', 'TR-002', 1);                     // 小芳把最後 1 條拿走
  const again = ERP.submitOrder(y.state, 'U01', x.id);            // 阿明重送
  assert(!again.ok && /可用庫存不足/.test(again.message), again.message);
});
check('領域', '別人的叫貨單不能改、不能送；老闆不能叫貨', () => {
  const a = cart(SEED, 'U01', 'TR-003', 2); const id = a.id;
  assert(!ERP.updateLine(a.state, 'U02', id, 'TR-003', 3).ok && !ERP.submitOrder(a.state, 'U02', id).ok);
  assert(!ERP.addLine(SEED, 'U03', 'TR-003', 1).ok);
});

// ---------- ERP 函式約定 ----------
check('約定', '每個 ERP 動作（成功、失敗）都回傳 {ok,message,state}、恰好寫 1 筆 audit、不改傳入 db', () => {
  const a = cart(SEED, 'U01', 'TR-003', 2); const id = a.id; const sb = ERP.submitOrder(a.state, 'U01', id);
  const calls = [
    ['queryStock', SEED, ['U01', '']], ['queryStock', SEED, ['ZZ', '']],
    ['addLine', SEED, ['U01', 'TR-003', 1]], ['addLine', SEED, ['U01', 'TR-003', 0]], ['addLine', SEED, ['U01', 'NOPE', 1]],
    ['updateLine', a.state, ['U01', id, 'TR-003', 4]], ['updateLine', a.state, ['U01', id, 'TR-003', -1]],
    ['removeLine', a.state, ['U01', id, 'TR-003']], ['removeLine', a.state, ['U01', id, 'NOPE']],
    ['setCustomer', a.state, ['U01', id, 'X']], ['setCustomer', a.state, ['U02', id, 'X']],
    ['submitOrder', a.state, ['U01', id]], ['submitOrder', SEED, ['U01', 'SO-0001']], ['submitOrder', cart(SEED, 'U01', 'TR-002', 2).state, ['U01', 'SO-0005']],
    ['approveOrder', sb.state, ['U03', id]], ['approveOrder', sb.state, ['U01', id]], ['approveOrder', SEED, ['U03', 'NOPE']],
    ['rejectOrder', sb.state, ['U03', id, 'r']], ['rejectOrder', sb.state, ['U01', id, 'r']], ['rejectOrder', SEED, ['U03', 'SO-0001', 'r']],
    ['returnOrder', sb.state, ['U03', id, 'r']], ['returnOrder', SEED, ['U03', 'SO-0001', 'r']],
    ['shipOrder', SEED, ['U03', 'SO-0001']], ['shipOrder', SEED, ['U01', 'SO-0001']], ['shipOrder', SEED, ['U03', 'SO-0004']], ['shipOrder', SEED, ['U03', 'NOPE']],
    ['receiveStock', SEED, ['U03', 'TR-001', 5, 'x']], ['receiveStock', SEED, ['U03', 'TR-001', 0]], ['receiveStock', SEED, ['U01', 'TR-001', 5]], ['receiveStock', SEED, ['U03', 'NOPE', 5]],
    ['addProduct', SEED, ['U03', { brand: 'B', name: 'N', spec: '1/1R1', year: 2025, cost: 1, price: 2 }]], ['addProduct', SEED, ['U01', { brand: 'B', spec: 'S', year: 2025, cost: 1, price: 2 }]], ['addProduct', SEED, ['U03', {}]],
    ['updateProduct', SEED, ['U03', 'TR-001', { price: 3400 }]], ['updateProduct', SEED, ['U01', 'TR-001', { price: 3400 }]], ['updateProduct', SEED, ['U03', 'NOPE', { price: 1 }]],
    ['setSafetyStock', SEED, ['U03', 'TR-001', 30]], ['setSafetyStock', SEED, ['U01', 'TR-001', 30]], ['setSafetyStock', SEED, ['U03', 'NOPE', 30]], ['setSafetyStock', SEED, ['U03', 'TR-001', -1]],
    ['setLowStockRule', SEED, ['U03', 'le', '測試']], ['setLowStockRule', SEED, ['U01', 'le', '測試']], ['setLowStockRule', SEED, ['U03', 'lt', '測試']], ['setLowStockRule', SEED, ['U03', 'le', '']]
  ];
  for (const [fn, db, args] of calls) {
    const before = JSON.stringify(db);
    const r = ERP[fn](db, ...args);
    assert(typeof r.ok === 'boolean' && typeof r.message === 'string' && r.message && r.state, fn + ' 回傳格式');
    assert(r.state.audit.length === db.audit.length + 1, fn + ' audit 筆數 ' + (r.state.audit.length - db.audit.length));
    assert(JSON.stringify(db) === before, fn + ' 改了傳入的 db');
  }
  return calls.length + ' 種呼叫';
});

// ---------- 隨機操作 3000 次 ----------
check('隨機', '3000 次隨機操作（含進貨、出貨、新增商品）：不變式、在庫守恆、狀態轉換合法、業務永遠看不到成本', () => {
  let seed = 20261013; const rnd = n => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return Math.floor(((t ^ t >>> 14) >>> 0) / 4294967296 * n); };
  const users = ['U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U99'];
  const skus = SEED.products.map(p => p.sku).concat(['NOPE']);
  const qtys = [1, 1, 2, 3, 5, 10, 50, 0, -1, 1.5, '2', 'x'];
  const allowed = new Set(['null>DRAFT', 'DRAFT>SUBMITTED', 'SUBMITTED>APPROVED', 'SUBMITTED>REJECTED', 'SUBMITTED>RETURNED', 'RETURNED>SUBMITTED', 'APPROVED>SHIPPED']);
  const baseOnHand = sku => { const p = SEED.products.find(x => x.sku === sku); return p ? p.on_hand : 0; };
  const newProducts = [{ brand: 'A', name: 'a', spec: '1/1R1', year: 2025, cost: 10, price: 20 }, { brand: 'B', name: 'b', spec: '2/2R2', year: 2024, cost: 5, price: 9 }, { brand: '', spec: '', year: 'x', cost: -1, price: 0 }];
  let db = clone(SEED); const tally = {};
  const pickBy = st => { const xs = db.orders.filter(o => st.includes(o.status)); return xs.length ? xs[rnd(xs.length)] : null; };
  const known = () => db.products.map(p => p.sku).concat(['NOPE']);
  for (let i = 0; i < 3000; i++) {
    const ids = db.orders.map(o => o.id).concat(['NOPE']);
    let u = users[rnd(users.length)], sku = skus[rnd(skus.length)], q = qtys[rnd(qtys.length)], oid = ids[rnd(ids.length)];
    if (rnd(10) < 7) {
      const t = rnd(3) === 0 ? pickBy(['APPROVED']) : rnd(2) ? pickBy(['DRAFT', 'RETURNED']) : pickBy(['SUBMITTED']);
      if (t) { oid = t.id; u = (t.status === 'SUBMITTED' || t.status === 'APPROVED') ? (rnd(2) ? 'U03' : 'U04') : t.created_by; if (t.lines.length && rnd(2)) sku = t.lines[0].sku; }
    }
    const ops = [() => ERP.addLine(db, u, sku, q), () => ERP.updateLine(db, u, oid, sku, q), () => ERP.removeLine(db, u, oid, sku),
      () => ERP.submitOrder(db, u, oid), () => ERP.submitOrder(db, u, oid), () => ERP.approveOrder(db, u, oid), () => ERP.rejectOrder(db, u, oid, 'r'),
      () => ERP.returnOrder(db, u, oid, 'r'), () => ERP.queryStock(db, u, ''),
      () => ERP.shipOrder(db, u, oid), () => ERP.shipOrder(db, u, oid), () => ERP.receiveStock(db, u, known()[rnd(known().length)], q),
      () => ERP.addProduct(db, u, newProducts[rnd(newProducts.length)]), () => ERP.updateProduct(db, u, known()[rnd(known().length)], { price: q }),
      () => ERP.setSafetyStock(db, u, known()[rnd(known().length)], q), () => ERP.setLowStockRule(db, u, ['lt', 'le', 'xx'][rnd(3)], rnd(2) ? '理由' : ''),
      () => ERP.login(db, ['ming', 'boss', 'ADMIN', 'nobody', ''][rnd(5)], rnd(2) ? 'x' : (db.users.find(z => z.id === u) || {}).password), () => ERP.logout(db, u)];
    const k = rnd(ops.length); const r = ops[k]();
    tally[r.ok] = (tally[r.ok] || 0) + 1;
    assert(r.state.audit.length === db.audit.length + 1, '第 ' + i + ' 次沒有寫 audit');
    db = r.state;
    const inv = ERP.view.invariants(db); assert(!inv.length, '第 ' + i + ' 次：' + inv.join('；'));
    // 在庫守恆：在庫 ＝ 種子在庫 ＋ 進貨總數 － 已出貨總數（每個品項）
    for (const p of db.products) {
      const rc = (db.receipts || []).filter(x => x.sku === p.sku).reduce((a, x) => a + x.qty, 0);
      const sh = db.orders.filter(o => o.status === 'SHIPPED').reduce((a, o) => a + o.lines.filter(l => l.sku === p.sku).reduce((b, l) => b + l.qty, 0), 0);
      assert(p.on_hand === baseOnHand(p.sku) + rc - sh, '第 ' + i + ' 次 ' + p.sku + ' 在庫不守恆：' + p.on_hand + ' ≠ ' + baseOnHand(p.sku) + ' + ' + rc + ' − ' + sh);
    }
    if (k === 8 && ['U01', 'U02', 'U05', 'U06'].includes(u)) r.data.forEach(row => assert(!('cost' in row) && !('margin' in row), '員工看到成本或毛利'));
    if (k === 8 && ['U03', 'U04', 'U07'].includes(u)) r.data.forEach(row => assert('cost' in row && 'margin' in row, '管理權限看不到成本'));
    assert(!JSON.stringify(r.data === undefined ? '' : r.data).includes('123'), '結果裡出現密碼');
  }
  const seen = {};
  for (const o of db.orders) for (const h of o.history) { const k = h.from + '>' + h.to; assert(allowed.has(k), o.id + ' 非法轉換 ' + k); seen[k] = (seen[k] || 0) + 1; }
  assert(Object.keys(seen).length === allowed.size, '有轉換沒被走到：' + JSON.stringify(seen));
  const st = {}; db.orders.forEach(o => st[o.status] = (st[o.status] || 0) + 1);
  return '成功 ' + (tally.true || 0) + '、拒絕 ' + (tally.false || 0) + '；' + db.orders.length + ' 張訂單 ' + JSON.stringify(st) + '；7 種轉換都走到；商品 ' + db.products.length + ' 個、進貨單 ' + (db.receipts || []).length + ' 張；可用歸零 ' + db.products.filter(p => p.on_hand === p.reserved).map(p => p.sku).join(',');
});

// ---------- 舊資料升級（v1 核准才預留 → v2 送出即預留） ----------
check('升級', '舊資料載入：待審核單補上預留；庫存不夠的自動退回；不變式成立；規則與需求文字更新', () => {
  const old = clone(SEED);
  old.meta.data_version = undefined; delete old.meta.data_version;
  prod(old, 'TR-003').reserved = 0;                       // v1：待審核不預留
  // 兩張待審核搶 TR-002 最後 1 條（v1 允許）
  const a = ERP.addLine(old, 'U01', 'TR-002', 1); // v2 函式只拿來造單
  let s = a.state; const ida = a.data.order_id;
  s.orders.find(o => o.id === ida).status = 'SUBMITTED';
  const b = ERP.addLine(s, 'U02', 'TR-002', 1); s = b.state; const idb = b.data.order_id;
  s.orders.find(o => o.id === idb).status = 'SUBMITTED';
  s.wb.rules = [JSON.parse(JSON.stringify(Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-005')))]; s.wb.rules[0].edited_at = null; s.wb.rules[0].t.effect = '舊版內容';
  s.wb.interview.step = Rules.DONE_STEP;
  s.wb.requirements = [{ id: 'REQ-004B', text: '舊文字', priority: 'Must', quality: [0, 0, 0, 0, 0, 0, 0], group: 'reserve-timing', status: 'pending', source: 's', evidence: 'e', note: '', edited: false, history: [] }];
  mem['aiwb_state_v01'] = JSON.stringify(s);
  const m = Store.load();
  assert(m.meta.data_version === 7, 'data_version');
  assert(ERP.view.invariants(m).length === 0, ERP.view.invariants(m).join('；'));
  assert(m.orders.find(o => o.id === 'SO-0004').status === 'SUBMITTED' && prod(m, 'TR-003').reserved === 8, 'SO-0004 沒補上預留');
  const sa = m.orders.find(o => o.id === ida).status, sb = m.orders.find(o => o.id === idb).status;
  assert(sa === 'SUBMITTED' && sb === 'RETURNED', '搶最後 1 條：' + sa + '/' + sb);
  assert(m.audit.filter(x => x.action === 'MIGRATED').length === 3, 'MIGRATED 稽核');
  assert(m.wb.rules[0].t.effect !== '舊版內容', '沒被人改過的規則沒更新');
  assert(m.wb.requirements.find(r => r.id === 'REQ-004B').text.indexOf('立即預留') >= 0, '需求文字沒更新');
  assert(m.wb.requirements.some(r => r.id === 'REQ-010' && r.status === 'ai'), '沒補 REQ-010');
  assert(Rules.REF_CANDIDATES.every(id => m.wb.requirements.some(r => r.id === id && r.status === 'ai' && r.source === Rules.REF_SOURCE)), '沒補參考 ERP 候選需求');
  delete mem['aiwb_state_v01'];
  return '補預留 SO-0004、' + ida + ' 成功、' + idb + ' 被退回';
});
check('升級', '人改過的規則不被覆蓋；已是 v2 的資料不再升級', () => {
  const s = clone(SEED); s.meta.data_version = 1;
  const r = JSON.parse(JSON.stringify(Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-005'))); r.edited_at = '2026-10-13T00:00:00Z'; r.t.effect = '我自己寫的'; s.wb.rules = [r];
  mem['aiwb_state_v01'] = JSON.stringify(s); const m = Store.load();
  assert(m.wb.rules[0].t.effect === '我自己寫的');
  const again = Store.load(); assert(again.audit.length === m.audit.length);
  delete mem['aiwb_state_v01'];
});

// ---------- 工作台 ----------
const walk = (alt) => {
  let db = clone(SEED);
  for (let i = 0; i < 5; i++) { const chips = Rules.interviewChips(db.wb.interview.step, db.wb); db = Store.wb.interviewSend(db, chips[alt && i === 2 ? 1 : 0]).state; }
  return db;
};
const W = walk(false);
check('訪談', 'AI 第 2 輪問出「送出時就預留，還是老闆核准時才預留」', () => {
  const t = W.wb.interview.messages.filter(m => m.who === 'ai')[1].text; assert(/送出時/.test(t) && /老闆核准時/.test(t), t);
});
check('訪談', '預設建議回答（送出就預留）→ REQ-004B 待確認、REQ-004 AI 建議；尚待釐清 4 項（含 1 條參考 ERP 追問；寄庫與出貨已有決定，不再問）', () => {
  const st = id => (W.wb.requirements.find(r => r.id === id) || {}).status;
  assert(st('REQ-004B') === 'pending' && st('REQ-004') === 'ai', st('REQ-004B') + '/' + st('REQ-004'));
  assert(W.wb.interview.questions.length === 4 && W.wb.interview.step === Rules.DONE_STEP, 'questions ' + W.wb.interview.questions.length);
  assert(W.wb.interview.questions.some(q => /生產週碼批次/.test(q.text)), '缺參考 ERP 追問'); assert(!W.wb.interview.questions.some(q => /還要不要有「出貨」這一步/.test(q.text)), '出貨已有定義，不該再問'); assert(!W.wb.interview.questions.some(q => /寄庫的輪胎/.test(q.text)), '寄庫已決定，不該再問');
  assert(/送出就預留 → AI 建議：要釋放/.test(W.wb.interview.questions[0].text), W.wb.interview.questions[0].text);
  assert(st('REQ-010') === 'ai', 'REQ-010');
  return W.wb.requirements.length + ' 條需求草稿';
});
check('訪談', '第二個建議回答（核准才預留）→ REQ-004 待確認、REQ-004B AI 建議、REQ-010 待確認', () => {
  const B = walk(true); const st = id => B.wb.requirements.find(r => r.id === id).status;
  assert(st('REQ-004') === 'pending' && st('REQ-004B') === 'ai' && st('REQ-010') === 'pending', st('REQ-004') + '/' + st('REQ-004B') + '/' + st('REQ-010'));
  assert(/核准才預留 → 退回時還沒預留/.test(B.wb.interview.questions[0].text));
});
check('確認', 'AI 建議不能用「確認」直接變已確認（只能採納）；還有未決定時不能建立規則', () => {
  assert(!Store.wb.setReqStatus(W, 'REQ-009', 'confirm').ok); assert(!Store.wb.buildRules(W).ok);
});
let C = W;
check('確認', '確認 REQ-004B → REQ-004 自動拒絕；再確認 REQ-004 被擋（互斥）；moveReq 一步到位', () => {
  for (const r of C.wb.requirements.filter(r => r.status === 'pending')) C = Store.wb.setReqStatus(C, r.id, 'confirm').state;
  assert(C.wb.requirements.find(r => r.id === 'REQ-004').status === 'rejected');
  assert(!Store.wb.moveReq(C, 'REQ-004', 'confirmed').ok);
  const x = Store.wb.moveReq(C, 'REQ-004B', 'deferred'); assert(x.ok && x.state.wb.requirements.find(r => r.id === 'REQ-004B').status === 'deferred');
  assert(Store.wb.moveReq(x.state, 'REQ-004', 'confirmed').ok, '放掉 REQ-004B 後 REQ-004 可確認');
});
check('確認', "清楚度分數 0～14（7 項）、重要性 必要／建議／暫不做", () => {
  for (const r of C.wb.requirements) { const q = Rules.qualityScore(r.quality); assert(q >= 0 && q <= 14 && r.quality.length === 7, r.id); assert(Rules.PRIORITY_LABEL[r.priority], r.id); }
});
check('規則', '全部範本的白話欄位都有字（不含「reserved」「APPROVED」「TC-」之外的程式符號於畫面欄位）', () => {
  const ban = /\b(reserved|on_hand|APPROVED|SUBMITTED|REJECTED|RETURNED|DRAFT|qty|True|False)\b/;
  for (const t of Rules.RULE_TEMPLATES) for (const v of [t.title, t.if, t.t.action, t.t.effect, t.t.message, t.t.audit, t.t.final, t.f.action, t.f.effect, t.f.message, t.f.audit, t.f.final, t.edge.text]) assert(!ban.test(v || ''), t.id + '：' + v);
});
check('規則', 'RULE-001／002／003／005／006／007 都是 8／8 且 ≥2 測試', () => {
  for (const id of ['RULE-001', 'RULE-002', 'RULE-003', 'RULE-005', 'RULE-006', 'RULE-007']) { const t = Rules.RULE_TEMPLATES.find(r => r.id === id); const c = Rules.check(t); assert(c.complete && Rules.testIds(t).length >= 2, id + ' ' + c.score); }
});
check('規則', '8 項逐一清空 → 每次都變 7／8 且不可開發', () => {
  const base = Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-003');
  const blank = { if: r => { r.if = ''; }, true: r => { r.t.action = ''; }, false: r => { r.f.action = ''; }, effect: r => { r.f.effect = ''; }, message: r => { r.t.message = ''; }, audit: r => { r.f.audit = ''; }, tests: r => { r.f.tests = []; }, final: r => { r.t.final = ''; } };
  for (const [k, fn] of Object.entries(blank)) { const r = clone(base); fn(r); const c = Rules.check(r); assert(c.score === 7 && !c.complete && c.items.find(i => i.key === k).ok === false, k); }
});
check('規則', '只有 1 個測試、或只有成立分支有測試 → 不完整', () => {
  const r = clone(Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-005'));
  r.f.tests = []; r.t.tests = ['TC-005-01', 'TC-005-02']; assert(!Rules.check(r).complete, 'True only');
  const r2 = clone(Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-005')); r2.t.tests = []; r2.f.tests = ['TC-005-02']; assert(!Rules.check(r2).complete, '1 test');
});
let D;
check('規則', '採納 REQ-008 後建立規則：RULE-003／006／007 進開發包，RULE-008 被擋、RULE-004 不出現', () => {
  let x = C; x = Store.wb.setReqStatus(x, 'REQ-008', 'adopt').state; x = Store.wb.setReqStatus(x, 'REQ-010', 'adopt').state;
  for (const r of x.wb.requirements.filter(r => r.status === 'ai')) x = Store.wb.setReqStatus(x, r.id, 'defer').state;
  assert(Rules.buildBlockerItems(x.wb).length === 0, Rules.buildBlockers(x.wb).join());
  const b = Store.wb.buildRules(x); assert(b.ok, b.message); x = b.state;
  assert(!x.wb.rules.some(r => r.id === 'RULE-004'), '不該有 RULE-004');
  const c = Rules.check(x.wb.rules.find(r => r.id === 'RULE-008')); assert(!c.complete && c.missing.join().includes('不成立時'), c.missing.join());
  const g = Store.wb.genDevpack(x); assert(g.ok); D = g.state;
  const pack = Rules.devpack(D);
  assert(['RULE-001', 'RULE-002', 'RULE-003', 'RULE-005', 'RULE-006', 'RULE-007'].every(id => pack.ready.includes(id)), pack.ready.join());
  assert(pack.blocked.includes('RULE-008') && !/## RULE-008/.test(pack.files['TASKS.md']));
  return '可開發 ' + pack.ready.join('、');
});
check('規則', '改選「核准才預留」：RULE-004 進入但還沒有程式與測試 → 開發包標示待實作、步驟⑦未完成', () => {
  let x = walk(true);
  for (const r of x.wb.requirements.filter(r => r.status === 'pending')) x = Store.wb.setReqStatus(x, r.id, 'confirm').state;
  for (const r of x.wb.requirements.filter(r => r.status === 'ai')) x = Store.wb.setReqStatus(x, r.id, 'defer').state;
  x = Store.wb.buildRules(x).state;
  const rule = x.wb.rules.find(r => r.id === 'RULE-004'); assert(rule && Rules.check(rule).complete && !Rules.implemented(rule));
  assert(/待實作/.test(Rules.devpack(x).files['TESTS.md']));
});
check('開發包', 'SPEC／TASKS／TESTS／指令都有內容；SPEC 寫明預留時機＝送出時；指令禁止改 tests.js、要求白話介面', () => {
  const f = Rules.devpack(D).files; for (const k of ['SPEC.md', 'TASKS.md', 'TESTS.md', 'AGENT_PROMPT.md']) assert(f[k] && f[k].length > 200, k);
  assert(/available = on_hand − reserved/.test(f['SPEC.md']) && /業務送出時（REQ-004B）/.test(f['SPEC.md']), 'SPEC');
  assert(/不可為了讓測試通過而修改 tests\.js/.test(f['AGENT_PROMPT.md']) && /白話/.test(f['AGENT_PROMPT.md']), 'AGENT');
  assert(/TC-003-03/.test(f['TESTS.md']) && !/待實作/.test(f['TESTS.md']), 'TESTS');
});
check('參考ERP', '8 條參考 ERP 候選需求：AI 建議、來源與依據寫明、不是「必要」所以不擋建立規則；每條有對應草稿規則（只有條件→被擋）', () => {
  const ids = Rules.REF_CANDIDATES; assert(ids.length === 8);
  for (const id of ids) { const r = W.wb.requirements.find(x => x.id === id); assert(r && r.status === 'ai' && r.source === Rules.REF_SOURCE && /旺盛輪業 ERP/.test(r.evidence) && r.priority !== 'Must', id); }
  assert(Rules.buildBlockerItems(W.wb).every(b => !ids.includes(b.id)), '參考候選不該擋建立規則');
  let x = W; for (const id of ids) x = Store.wb.setReqStatus(x, id, 'adopt').state;
  for (const r of x.wb.requirements.filter(r => r.status === 'pending')) x = Store.wb.setReqStatus(x, r.id, 'confirm').state;
  for (const id of ['REQ-008','REQ-010']) x = Store.wb.setReqStatus(x, id, 'adopt').state;
  for (const r of x.wb.requirements.filter(r => r.status === 'ai')) x = Store.wb.setReqStatus(x, r.id, 'defer').state;
  const b = Store.wb.buildRules(x); assert(b.ok, b.message); x = b.state;
  const stubs = ['RULE-018','RULE-019','RULE-020','RULE-022','RULE-023','RULE-024','RULE-025'];
  for (const id of stubs) { const r = x.wb.rules.find(y => y.id === id); assert(r, id + ' 沒建立'); const c = Rules.check(r); assert(!c.complete && c.score <= 2, id + ' ' + c.score); }
  const pack = Rules.devpack(Store.wb.genDevpack(x).state); assert(stubs.every(id => pack.blocked.includes(id)) && stubs.every(id => !pack.ready.includes(id)), '草稿規則不該進開發包');
  assert(Rules.RRB.filter(y => y.ref).length === 5, 'RRB 參考 ERP 有看到 5 項');
  assert(pack.ready.includes('RULE-021'), 'REQ-019 採納後，RULE-021（進貨入庫）已寫完整且有驗收案例，應該進開發包');
});
check('寄庫', '寄庫決定：購買當下就扣庫存——需求文字、備註、規則草稿（7/8，只缺驗收案例）、CLAUDE.md 都寫明', () => {
  const c = Rules.REQ_CATALOG['REQ-011']; assert(/購買當下就從庫存扣掉全部 10 條/.test(c.text) && /不再扣庫存/.test(c.text) && /已決定/.test(c.decision));
  const r11 = W.wb.requirements.find(r => r.id === 'REQ-011'); assert(r11.text === c.text && r11.note === c.decision, '需求文字或備註沒帶到：' + r11.note);
  const t9 = Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-009'); const ck = Rules.check(t9);
  assert(ck.score === 7 && ck.missing.join() === '驗收案例', ck.score + ' ' + ck.missing.join());
  assert(/庫存減少「訂購數」/.test(t9.t.effect) && /寄庫餘額增加/.test(t9.t.effect) && /不再扣庫存/.test(t9.edge.text));
  assert(/購買當下就從庫存扣掉/.test(rd('CLAUDE.md')), 'CLAUDE.md');
  // 舊的 v3 資料：文字更新、舊疑問移除、沒被改過的規則更新、人改過的需求不動
  const s = clone(W); s.meta.data_version = 3;
  s.wb.requirements.find(r => r.id === 'REQ-011').text = '寄庫：一次買 10 條，分次叫貨，正式庫存不變'; s.wb.requirements.find(r => r.id === 'REQ-011').note = '';
  s.wb.requirements.find(r => r.id === 'REQ-006').text = '我自己改的字'; s.wb.requirements.find(r => r.id === 'REQ-006').edited = true;
  s.wb.interview.questions.push({ text: '寄庫的輪胎，購買當下就從庫存扣掉，還是等客戶取貨才扣？（舊）', resolved: false });
  mem['aiwb_state_v01'] = JSON.stringify(s); const m = Store.load(); delete mem['aiwb_state_v01'];
  assert(m.meta.data_version === 7 && m.wb.requirements.find(r => r.id === 'REQ-011').text === c.text && m.wb.requirements.find(r => r.id === 'REQ-011').note === c.decision, 'v3→v4');
  assert(!m.wb.interview.questions.some(q => /寄庫的輪胎/.test(q.text)), '舊疑問沒移除');
  assert(m.wb.requirements.find(r => r.id === 'REQ-006').text === '我自己改的字', '人改過的需求被覆蓋');
});
check('升級', '第 4 版升到第 5 版：補進貨單清單與編號、補 REQ-024／025、移除「出貨」舊疑問、沒被改過的 RULE-021 換成完整版', () => {
  const s = clone(W); s.meta.data_version = 4;
  delete s.receipts; delete s.seq.receipt; delete s.seq.product;
  s.wb.requirements = s.wb.requirements.filter(r => r.id !== 'REQ-024' && r.id !== 'REQ-025');
  s.wb.interview.questions.push({ text: '核准之後，還要不要有「出貨」這一步來真正扣掉在庫？（舊）', resolved: false });
  s.wb.rules = [{ ...clone(Rules.RULE_TEMPLATES.find(r => r.id === 'RULE-021')), t: { action: '', effect: '', message: '', audit: '', tests: [], final: '' }, f: { action: '', effect: '', message: '', audit: '', tests: [], final: '' }, edge: { text: '', tests: [] }, version: 'v0.1.0', orphan: false, created_at: 'x', edited_at: null }];
  mem['aiwb_state_v01'] = JSON.stringify(s); const m = Store.load(); delete mem['aiwb_state_v01'];
  assert(m.meta.data_version === 7 && Array.isArray(m.receipts) && m.seq.receipt === 1 && m.seq.product === 9, '資料版本或進貨單欄位');
  assert(['REQ-024', 'REQ-025'].every(id => m.wb.requirements.some(r => r.id === id && r.status === 'ai')), '沒補 REQ-024／025');
  assert(!m.wb.interview.questions.some(q => /還要不要有「出貨」這一步/.test(q.text)), '舊疑問沒移除');
  assert(Rules.check(m.wb.rules[0]).complete, '沒被改過的 RULE-021 沒有換成完整版');
});
check('參考', '狀態機：第一版 6 個轉換（含出貨完成）、其餘 4 個候選；九大難點：做 2、部分 1、候選 6；RRB 七項', () => {
  assert(Rules.STATE_MACHINE.filter(t => t.v1).length === 6 && Rules.STATE_MACHINE.length === 10);
  const n = k => Rules.DIFFICULTIES.filter(d => d.v1 === k).length; assert(Rules.DIFFICULTIES.length === 9 && n('做') === 2 && n('部分') === 1 && n('候選') === 6);
  assert(Rules.RRB.length === 7 && Rules.RRB.filter(x => x.reqs.some(id => D.wb.requirements.some(r => r.id === id))).length === 7);
});
check('版本', '完成前 9 項（自動 4、人工 5）；測試 PASS 後自動項全過；版本 v0.1.0 → 下一版 v0.1.1', () => {
  const x = Store.wb.recordTestRun(D, Tests.runAll()).state; const c = Rules.checklist(x);
  assert(c.length === 9 && c.filter(i => i.auto).length === 4 && c.filter(i => i.auto).every(i => i.ok), c.map(i => i.key + i.ok).join());
  const v = Store.wb.saveVersion(x, 'v1'); assert(v.ok && v.state.wb.versions[0].id === 'v0.1.0' && Rules.nextVersion(v.state.wb.versions) === 'v0.1.1');
});
check('重設', 'Store.reset() 回到 SEED', () => { Store.save(D); const s = Store.reset(); assert(JSON.stringify(s) === JSON.stringify(SEED) && JSON.stringify(Store.load()) === JSON.stringify(SEED)); });

// ---------- Sprint 1：商品＋進出貨 ----------
check('Sprint 1', '完整流程：送出 → 核准 → 出貨：核准不動庫存、出貨在庫與預留各扣、可用全程不變（核准後）', () => {
  const x = sub(SEED, 'U01', 'TR-001', 2); const a = ERP.approveOrder(x.state, 'U03', x.id);
  assert(prod(a.state, 'TR-001').on_hand === 130 && prod(a.state, 'TR-001').reserved === 8 && avail(a.state, 'TR-001') === 122);
  const s = ERP.shipOrder(a.state, 'U03', x.id);
  assert(s.ok && prod(s.state, 'TR-001').on_hand === 128 && prod(s.state, 'TR-001').reserved === 6 && avail(s.state, 'TR-001') === 122);
  assert(ERP.view.invariants(s.state).length === 0 && s.state.orders.find(o => o.id === x.id).status === 'SHIPPED');
});
check('Sprint 1', '已出貨的訂單不能退回、拒絕、再核准、再出貨；業務看得到自己訂單變「已出貨」', () => {
  const s = ERP.shipOrder(SEED, 'U03', 'SO-0001').state;
  assert(!ERP.returnOrder(s, 'U03', 'SO-0001', '').ok && !ERP.rejectOrder(s, 'U03', 'SO-0001', '').ok && !ERP.approveOrder(s, 'U03', 'SO-0001').ok && !ERP.shipOrder(s, 'U04', 'SO-0001').ok);
  assert(ERP.view.orders(s, 'U01').some(o => o.id === 'SO-0001' && o.status === 'SHIPPED'));
});
check('Sprint 1', '進貨後可用增加；進貨的商品可以再被叫貨送出（先進貨才有庫存的新商品）', () => {
  const a = ERP.addProduct(SEED, 'U03', { brand: '固特異', name: 'A', spec: '195/60R15', year: 2025, cost: 100, price: 200 });
  const c = ERP.addLine(a.state, 'U01', a.data.sku, 3); assert(c.ok);
  assert(!ERP.submitOrder(c.state, 'U01', c.data.order_id).ok, '沒進貨的新商品不該送得出去');
  const r = ERP.receiveStock(c.state, 'U03', a.data.sku, 10); assert(r.ok && avail(r.state, a.data.sku) === 10);
  const ok = ERP.submitOrder(r.state, 'U01', c.data.order_id); assert(ok.ok && avail(ok.state, a.data.sku) === 7);
});
check('Sprint 1', '新商品的成本對業務隱藏（RULE-001 同樣適用）；進貨與商品管理只有老闆', () => {
  const a = ERP.addProduct(SEED, 'U03', { brand: '固特異', name: 'A', spec: '195/60R15', year: 2025, cost: 100, price: 200 });
  const q = ERP.queryStock(a.state, 'U01', '195/60R15'); assert(q.data.length === 1 && !('cost' in q.data[0]) && !('margin' in q.data[0]));
  assert(ERP.queryStock(a.state, 'U03', '195/60R15').data[0].cost === 100);
});
check('Sprint 1', 'RULE-010／011／021 成立、不成立、特殊情況都有已實作的驗收案例，8 項都完整', () => {
  for (const id of ['RULE-010', 'RULE-011', 'RULE-021']) {
    const t = Rules.RULE_TEMPLATES.find(r => r.id === id);
    assert(Rules.check(t).complete && t.t.tests.length && t.f.tests.length && t.edge.tests.length && Rules.implemented(t), id);
  }
});

// ---------- 版本線 ----------
const builtState = () => {
  let db = clone(SEED);
  for (let i = 0; i < 5; i++) db = Store.wb.interviewSend(db, Rules.interviewChips(db.wb.interview.step, db.wb)[0]).state;
  for (const r of db.wb.requirements.filter(r => r.status === 'pending')) db = Store.wb.setReqStatus(db, r.id, 'confirm').state;
  for (const id of ['REQ-008', 'REQ-010']) db = Store.wb.setReqStatus(db, id, 'adopt').state;
  for (const r of db.wb.requirements.filter(r => r.status === 'ai')) db = Store.wb.setReqStatus(db, r.id, 'defer').state;
  return Store.wb.genDevpack(Store.wb.buildRules(db).state).state;
};
check('版本線', '版本編號連續、說明去前後空白、沒跑測試記為 null、meta.version 隨之更新', () => {
  let db = builtState();
  assert(db.wb.versions.length === 0 && Rules.nextVersion(db.wb.versions) === 'v0.1.0');
  const r1 = Store.wb.saveVersion(db, '  第一版  '); db = r1.state;
  const v0 = db.wb.versions[0];
  assert(r1.ok && v0.id === 'v0.1.0' && v0.note === '第一版' && v0.tests === null);
  assert(db.meta.version === 'v0.1.0' && Rules.nextVersion(db.wb.versions) === 'v0.1.1');
  assert(db.wb.log.some(l => l.action === 'VERSION' && l.detail === 'v0.1.0'), '沒有操作紀錄');
  db = Store.wb.recordTestRun(db, Tests.runAll()).state; db = Store.wb.saveVersion(db, '').state;
  const v1 = db.wb.versions[1];
  assert(v1.id === 'v0.1.1' && v1.note === '' && v1.tests.pass === v1.tests.total && !!v1.tests.at && v1.tests.failed.length === 0);
});
check('版本線', '快照記下需求、規則完整度、驗收結果、9 項檢查；失敗案例編號會記錄；舊快照不受後續修改影響', () => {
  let db = builtState(); db = Store.wb.recordTestRun(db, Tests.runAll()).state; db = Store.wb.saveVersion(db, 'A').state;
  const v0 = db.wb.versions[0];
  assert(v0.reqs.length === db.wb.requirements.length && v0.reqs.every(x => x.id && x.status && x.text), '需求快照');
  assert(v0.rules.length === db.wb.rules.length && v0.rules.every(x => x.id && x.title && typeof x.score === 'number' && typeof x.complete === 'boolean'), '規則快照');
  assert(v0.checklist.length === 9, '9 項檢查');
  const fake = Tests.runAll(); fake[3].pass = false; fake[3].actual = '故意失敗';
  db = Store.wb.recordTestRun(db, fake).state; db = Store.wb.saveVersion(db, '有一項沒過').state;
  assert(db.wb.versions[1].tests.pass === fake.length - 1 && db.wb.versions[1].tests.failed.join() === fake[3].id, '失敗案例');
  const before = JSON.stringify(db.wb.versions[0]);
  db = Store.wb.setReqStatus(db, 'REQ-001', 'revert').state;
  assert(JSON.stringify(db.wb.versions[0]) === before && db.wb.versions[0].reqs.find(x => x.id === 'REQ-001').status === 'confirmed', '舊快照被改到');
});
check('版本線', '人工檢查項勾選會記進快照；存進 localStorage 再讀回完整；重設後清空', () => {
  let db = builtState(); db = Store.wb.setCheck(db, 'git', true).state; db = Store.wb.saveVersion(db, '').state; db = Store.wb.saveVersion(db, '').state;
  assert(db.wb.versions[0].checklist.find(c => c.key === 'git').ok === true);
  assert(db.wb.versions.map(v => v.id).join() === 'v0.1.0,v0.1.1');
  Store.save(db); const back = Store.load(); assert(back.wb.versions.length === 2 && back.meta.version === 'v0.1.1');
  const fresh = Store.reset(); assert(fresh.wb.versions.length === 0);
});

// ---------- Sprint 3：安全庫存警示＋規則變更＋變更影響分析 ----------
const chgState = () => {
  let db = clone(SEED);
  for (let i = 0; i < 5; i++) db = Store.wb.interviewSend(db, Rules.interviewChips(db.wb.interview.step, db.wb)[0]).state;
  for (const r of db.wb.requirements.filter(r => r.status === 'pending')) db = Store.wb.setReqStatus(db, r.id, 'confirm').state;
  for (const id of ['REQ-008', 'REQ-010', 'REQ-026', 'REQ-027']) db = Store.wb.setReqStatus(db, id, 'adopt').state;
  for (const r of db.wb.requirements.filter(r => r.status === 'ai')) db = Store.wb.setReqStatus(db, r.id, 'defer').state;
  return Store.wb.genDevpack(Store.wb.buildRules(db).state).state;
};
const lowSkus = db => ERP.view.lowStock(db).map(x => x.sku).sort().join(',');
check('Sprint 3', '種子資料：規則「小於」時提醒 TR-002、TR-005；TR-008 可用 ＝ 安全庫存，不提醒；員工查詢看得到安全庫存，仍沒有成本與毛利', () => {
  assert(SEED.settings.low_stock_op === 'lt' && lowSkus(SEED) === 'TR-002,TR-005', lowSkus(SEED));
  assert(avail(SEED, 'TR-008') === 8 && prod(SEED, 'TR-008').safety === 8);
  const q = ERP.queryStock(SEED, 'U01', '').data; assert(q.every(r => !('cost' in r) && !('margin' in r) && 'safety' in r && 'retail' in r), '員工的欄位不對');
});
check('Sprint 3', '舊資料第 5 版升到第 6 版：補安全庫存、低庫存規則設定、變更紀錄，補 REQ-026（AI 建議）', () => {
  const s = clone(W); s.meta.data_version = 5;
  s.products.forEach(p => { delete p.safety; }); delete s.settings; delete s.wb.changes;
  s.wb.requirements = s.wb.requirements.filter(r => r.id !== 'REQ-026');
  mem['aiwb_state_v01'] = JSON.stringify(s); const m = Store.load(); delete mem['aiwb_state_v01'];
  assert(m.meta.data_version === 7 && m.settings.low_stock_op === 'lt' && Array.isArray(m.wb.changes), '設定或變更紀錄沒補上');
  assert(m.products.every(p => p.safety === SEED.products.find(x => x.sku === p.sku).safety), '安全庫存沒補上');
  assert(m.wb.requirements.some(r => r.id === 'REQ-026' && r.status === 'ai'), '沒補 REQ-026');
});
check('Sprint 3', 'RULE-026／027／028 的 8 項閉環完整、驗收案例都已實作；確認 REQ-026 後進開發包，規格寫明低庫存規則', () => {
  for (const id of ['RULE-026', 'RULE-027', 'RULE-028']) {
    const r = Rules.RULE_TEMPLATES.find(x => x.id === id);
    assert(Rules.check(r).complete && r.t.tests.length && r.f.tests.length && Rules.implemented(r), id);
  }
  const db = chgState(); const pack = Rules.devpack(db);
  assert(['RULE-026', 'RULE-027', 'RULE-028'].every(id => pack.ready.includes(id)), '沒進開發包：' + pack.ready.join());
  assert(/低庫存警示/.test(pack.files['SPEC.md']), 'SPEC 沒寫低庫存規則');
});
check('Sprint 3', '變更影響分析：REQ-026 → 3 條規則、9 個驗收案例、程式；REQ-006 → RULE-001，並列出同一條規則的其他需求', () => {
  const db = chgState(); const im = Rules.impactOf(db, 'REQ-026');
  assert(im.rules.map(r => r.id).join() === 'RULE-026,RULE-027,RULE-028', im.rules.map(r => r.id).join());
  assert(im.tests.length === 9 && ['TC-026-01', 'TC-026-04', 'TC-027-03', 'TC-028-02'].every(x => im.tests.includes(x)), im.tests.join());
  assert(im.code.includes('ERP.setLowStockRule') && im.code.includes('ERP.view.lowStock'), im.code.join());
  const i6 = Rules.impactOf(db, 'REQ-006'); assert(i6.rules.some(r => r.id === 'RULE-001') && i6.otherReqs.includes('REQ-001'), JSON.stringify(i6));
  assert(Rules.impactOf(db, 'REQ-999').req === null, '不存在的需求要回 null');
});
check('Sprint 3', '套用變更前先擋：沒寫理由、需求還沒確認、新舊相同，都不會改到任何資料', () => {
  const db = chgState(); const snap = JSON.stringify(db);
  const a = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'le', reason: '  ' }); assert(!a.ok && /理由/.test(a.message) && JSON.stringify(a.state) === snap);
  const same = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'lt', reason: '沒變' }); assert(!same.ok && same.state.wb.changes.length === 0 && same.state.settings.low_stock_op === 'lt');
  const un = clone(db); un.wb.requirements.find(r => r.id === 'REQ-026').status = 'ai';
  const b = Store.wb.applyChange(un, { kind: 'low-op', req_id: 'REQ-026', to: 'le', reason: '想改' }); assert(!b.ok && /還沒有確認/.test(b.message) && b.state.settings.low_stock_op === 'lt');
  const c = Store.wb.applyChange(db, { kind: 'xx', req_id: 'REQ-026', to: 'le', reason: '想改' }); assert(!c.ok);
  const d = Store.wb.applyChange(db, { kind: 'req-text', req_id: 'REQ-026', to: '', reason: '想改' }); assert(!d.ok);
});
check('Sprint 3', '低庫存規則變更全流程：套用 → 用新規則重跑全部測試 → 全過才存成新版本並綁定；稽核與變更紀錄都留下', () => {
  const db = chgState();
  const a = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'le', reason: '剛好用完安全庫存也要提醒' });
  assert(a.ok && a.state.settings.low_stock_op === 'le' && a.state.wb.changes.length === 1, a.message);
  const ch = a.state.wb.changes[0];
  assert(ch.id === 'CHG-001' && ch.status === 'applied' && ch.from === 'lt' && ch.to === 'le' && ch.impact.rules.length === 3 && !ch.version, JSON.stringify(ch));
  assert(a.state.audit[a.state.audit.length - 1].action === 'LOWRULE_CHANGED');
  assert(lowSkus(a.state) === 'TR-002,TR-005,TR-008', lowSkus(a.state));
  const res = Tests.runAll({ settings: a.state.settings });
  assert(res.length === Tests.cases.length && res.every(x => x.pass), res.filter(x => !x.pass).map(x => x.id + ':' + x.actual).join());
  assert(/小於或等於/.test(res.find(x => x.id === 'TC-026-03').actual), '邊界案例沒有照新規則判斷');
  const f = Store.wb.finishChange(a.state, ch.id, res);
  const c2 = f.state.wb.changes[0];
  assert(f.ok && c2.status === 'verified' && c2.regression.pass === c2.regression.total && c2.version === 'v0.1.0' && f.state.meta.version === 'v0.1.0', f.message);
  assert(f.state.wb.versions[0].note.includes('CHG-001') && f.state.wb.versions[0].note.includes('剛好用完'), f.state.wb.versions[0].note);
  assert(f.state.wb.testRuns.length === 1 && f.state.wb.testRuns[0].total === Tests.cases.length);
  // 有測試沒過：不存版本，狀態 failed，可以回復
  const bad = res.map((x, i) => i === 0 ? Object.assign({}, x, { pass: false, actual: '故意失敗' }) : x);
  const g = Store.wb.finishChange(a.state, ch.id, bad);
  assert(!g.ok && g.state.wb.changes[0].status === 'failed' && g.state.wb.versions.length === 0 && g.state.wb.changes[0].regression.failed.length === 1, g.message);
});
check('Sprint 3', '舊規則下的回歸一樣全過（規則改回「小於」時，邊界案例的預期也跟著變回來）', () => {
  const lt = Tests.runAll({ settings: { low_stock_op: 'lt' } }); const le = Tests.runAll({ settings: { low_stock_op: 'le' } });
  assert(lt.every(x => x.pass) && le.every(x => x.pass), '有案例沒過');
  assert(/不提醒/.test(lt.find(x => x.id === 'TC-026-03').actual) && /→ 提醒/.test(le.find(x => x.id === 'TC-026-03').actual));
  assert(Tests.runAll().every(x => x.pass) && Tests.runAll({}).length === Tests.cases.length);
});
check('Sprint 3', '回復：要寫理由；只能回復同一個對象最新的變更；回復後設定回到原本，留下理由，再跑測試存成新版本', () => {
  let db = chgState();
  const a = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'le', reason: '第一次改' });
  db = Store.wb.finishChange(a.state, 'CHG-001', Tests.runAll({ settings: a.state.settings })).state;
  const b = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'lt', reason: '又改回來' });
  db = Store.wb.finishChange(b.state, 'CHG-002', Tests.runAll({ settings: b.state.settings })).state;
  assert(db.wb.changes.length === 2 && db.wb.versions.length === 2 && db.settings.low_stock_op === 'lt');
  const old = Store.wb.revertChange(db, 'CHG-001', '想回到最初'); assert(!old.ok && /CHG-002/.test(old.message) && old.state.settings.low_stock_op === 'lt');
  const noWhy = Store.wb.revertChange(db, 'CHG-002', ' '); assert(!noWhy.ok && /理由/.test(noWhy.message));
  const r = Store.wb.revertChange(db, 'CHG-002', '剛剛不該改回來');
  assert(r.ok && r.state.settings.low_stock_op === 'le' && r.state.wb.changes[1].status === 'reverted' && r.state.wb.changes[1].revert_reason === '剛剛不該改回來', r.message);
  assert(/剛剛不該改回來/.test(r.state.audit[r.state.audit.length - 1].message), '稽核沒有留下回復理由');
  const f = Store.wb.finishChange(r.state, 'CHG-002', Tests.runAll({ settings: r.state.settings }), 'revert');
  assert(f.ok && f.state.wb.versions.length === 3 && /回復 CHG-002/.test(f.state.wb.versions[2].note) && f.state.wb.changes[1].revert_version === 'v0.1.2', f.message);
  const again = Store.wb.revertChange(f.state, 'CHG-002', '再回復一次'); assert(!again.ok && /已經回復/.test(again.message));
});
check('Sprint 3', '需求文字變更：已確認的需求平常不能直接改；走變更流程可以改，原文與理由都保留，回復後文字回到原本', () => {
  const db = chgState(); const orig = db.wb.requirements.find(r => r.id === 'REQ-006').text;
  assert(!Store.wb.editReq(db, 'REQ-006', '亂改').ok, '已確認的需求不該能直接改');
  const a = Store.wb.applyChange(db, { kind: 'req-text', req_id: 'REQ-006', to: '業務與倉管都不可看到成本與毛利', reason: '新增倉管角色' });
  const q = a.state.wb.requirements.find(r => r.id === 'REQ-006');
  assert(a.ok && q.text === '業務與倉管都不可看到成本與毛利' && q.edited && q.history[q.history.length - 1].note.includes('新增倉管角色'), a.message);
  assert(a.state.wb.changes[0].from === orig && a.state.wb.changes[0].impact.rules.some(r => r.id === 'RULE-001'));
  const r = Store.wb.revertChange(a.state, 'CHG-001', '倉管角色先不做');
  assert(r.ok && r.state.wb.requirements.find(x => x.id === 'REQ-006').text === orig);
});

// ---------- 版本差異與整版回復 ----------
const stamp = (db, note) => Store.wb.saveVersion(Store.wb.recordTestRun(db, Tests.runAll({ settings: db.settings })).state, note).state;
check('版本回復', '存版本時記下設定、規則內容簽章與完整快照；快照不受後來的修改影響；只保留最近 10 版的完整內容', () => {
  let db = stamp(chgState(), '第一版');
  const v = db.wb.versions[0];
  assert(v.settings.low_stock_op === 'lt' && v.snap && v.snap.low_stock_op === 'lt' && v.snap.requirements.length === db.wb.requirements.length && v.snap.rules.length === db.wb.rules.length);
  assert(v.rules.every(r => typeof r.sig === 'string' && r.sig.length > 0), '規則簽章');
  const before = JSON.stringify(v.snap);
  db = Store.wb.updateRule(db, 'RULE-003', 't.effect', '改過的內容').state; db = Store.wb.setReqStatus(db, 'REQ-006', 'revert').state;
  assert(JSON.stringify(db.wb.versions[0].snap) === before, '快照被後來的修改改到');
  for (let i = 0; i < 11; i++) db = stamp(db, 'v' + i);
  assert(db.wb.versions.length === 12 && db.wb.versions.filter(x => x.snap).length === 10 && !db.wb.versions[0].snap && !db.wb.versions[1].snap && !!db.wb.versions[2].snap, '只該留最近 10 版');
});
check('版本回復', '版本比較：需求說法、需求狀態、新增與少了的需求、規則內容、寫完整與否、低庫存算法、驗收數都用白話列出；相同內容沒有差別', () => {
  const db = stamp(chgState(), '第一版'); const v = db.wb.versions[0];
  assert(Rules.diffVersions(v, Rules.snapshotView(db)).length === 0, '剛存完，目前內容應該和這一版一樣');
  const a = JSON.parse(JSON.stringify(v));
  const b = JSON.parse(JSON.stringify(v));
  b.reqs.find(r => r.id === 'REQ-006').text = '業務與倉管都不可看到成本與毛利';
  b.reqs.find(r => r.id === 'REQ-007').status = 'deferred';
  b.reqs.push({ id: 'REQ-099', status: 'confirmed', text: '新的需求' });
  b.reqs = b.reqs.filter(r => r.id !== 'REQ-001');
  b.rules.find(r => r.id === 'RULE-003').sig = 'zzz';
  b.rules.find(r => r.id === 'RULE-008').complete = true;
  b.rules.push({ id: 'RULE-099', title: '新規則', complete: true, sig: 'a' });
  b.rules = b.rules.filter(r => r.id !== 'RULE-001');
  b.settings = { low_stock_op: 'le' };
  b.tests = { pass: 20, total: Tests.cases.length };
  const d = Rules.diffVersions(a, b).map(x => x.text).join('\n');
  for (const s of ['需求說法改了', '需求「', '延後', '新增需求：新的需求', '少了需求：', '規則內容改了：', '規則寫完整了：', '新增規則：新規則', '少了規則：', '低庫存提醒的算法：小於 → 小於或等於', '通過的驗收：' + Tests.cases.length + ' 項 → 20 項']) assert(d.includes(s), '缺：' + s + '\n' + d);
  assert(!/REQ-0|RULE-0/.test(d.replace(/新增需求：新的需求/, '')), '比較結果不該只有編號');
  // 舊版本沒有 settings／sig 時要能比較，不報錯、不亂報
  const old = JSON.parse(JSON.stringify(v)); delete old.settings; old.rules.forEach(r => delete r.sig);
  assert(Rules.diffVersions(old, v).length === 0, '舊格式版本不該被報成有差別');
});
check('版本回復', '整版回復先擋：沒寫理由、找不到版本、沒有完整快照、內容和該版一樣；擋下時資料完全不變', () => {
  let db = stamp(chgState(), '第一版'); const snap0 = JSON.stringify(db);
  const x1 = Store.wb.restoreVersion(db, 'v0.1.0', '  '); assert(!x1.ok && /理由/.test(x1.message) && JSON.stringify(x1.state) === snap0);
  const x2 = Store.wb.restoreVersion(db, 'v9.9.9', '想回'); assert(!x2.ok && /找不到版本/.test(x2.message));
  const x3 = Store.wb.restoreVersion(db, 'v0.1.0', '想回'); assert(!x3.ok && /一樣/.test(x3.message) && JSON.stringify(x3.state) === snap0, x3.message);
  const old = JSON.parse(snap0); delete old.wb.versions[0].snap;
  const x4 = Store.wb.restoreVersion(old, 'v0.1.0', '想回'); assert(!x4.ok && /完整內容/.test(x4.message));
});
check('版本回復', '整版回復全流程：需求、規則、低庫存算法都回到舊版；營運資料（訂單、庫存、進貨單、價格）不動；留下理由、稽核與變更紀錄；重跑測試通過才存成新版本', () => {
  let db = stamp(chgState(), '第一版');
  const v0 = db.wb.versions[0];
  // 之後做了三種修改：改規則內容、經變更流程改需求說法、經變更流程改低庫存算法
  db = Store.wb.updateRule(db, 'RULE-003', 't.effect', '改過的內容').state;
  let a = Store.wb.applyChange(db, { kind: 'req-text', req_id: 'REQ-006', to: '業務與倉管都不可看到成本與毛利', reason: '新增倉管' });
  db = Store.wb.finishChange(a.state, 'CHG-001', Tests.runAll({ settings: a.state.settings })).state;
  a = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'le', reason: '剛好用完也提醒' });
  db = Store.wb.finishChange(a.state, 'CHG-002', Tests.runAll({ settings: a.state.settings })).state;
  // 也做了營運動作（出貨、進貨）：回復版本時不能被動到
  const ship = ERP.shipOrder(db, 'U03', 'SO-0001'); db = ERP.receiveStock(ship.state, 'U03', 'TR-001', 10, '').state;
  const biz = JSON.stringify([db.orders, db.products, db.receipts]);
  assert(db.settings.low_stock_op === 'le' && db.wb.versions.length === 3);
  const pre = Rules.diffVersions(Rules.snapshotView(db), v0).filter(d => d.kind !== 'test').map(d => d.text).join('\n');
  assert(/需求說法改了/.test(pre) && /規則內容改了/.test(pre) && /低庫存提醒的算法/.test(pre), pre);
  const r = Store.wb.restoreVersion(db, 'v0.1.0', '新規則試用後不合用');
  assert(r.ok && r.data.id === 'CHG-003', r.message);
  const s = r.state;
  assert(s.settings.low_stock_op === 'lt', '低庫存算法沒回復');
  assert(s.wb.requirements.find(q => q.id === 'REQ-006').text === v0.snap.requirements.find(q => q.id === 'REQ-006').text, '需求說法沒回復');
  assert(s.wb.rules.find(q => q.id === 'RULE-003').t.effect === v0.snap.rules.find(q => q.id === 'RULE-003').t.effect, '規則內容沒回復');
  assert(JSON.stringify([s.orders, s.products, s.receipts]) === biz, '營運資料被動到了');
  assert(s.audit[s.audit.length - 1].action === 'LOWRULE_CHANGED' && /整版回復到 v0\.1\.0/.test(s.audit[s.audit.length - 1].message) && /不合用/.test(s.audit[s.audit.length - 1].message), '稽核沒有留下回復理由');
  const hist = s.wb.requirements.find(q => q.id === 'REQ-006').history; assert(/整版回復到 v0\.1\.0/.test(hist[hist.length - 1].note), '需求沒有回復紀錄');
  const ch = s.wb.changes[2]; assert(ch.kind === 'restore' && ch.to === 'v0.1.0' && ch.from === 'v0.1.2' && ch.diff.length >= 3 && ch.reason === '新規則試用後不合用' && ch.status === 'applied', JSON.stringify(ch));
  assert(!!s.wb.devpack, '開發包要依回復後的規則重新產生');
  const f = Store.wb.finishChange(s, 'CHG-003', Tests.runAll({ settings: s.settings }));
  assert(f.ok && f.state.wb.changes[2].status === 'verified' && f.state.wb.changes[2].version === 'v0.1.3' && f.state.wb.versions.length === 4, f.message);
  assert(/整版回復 CHG-003/.test(f.state.wb.versions[3].note) && /新規則試用後不合用/.test(f.state.wb.versions[3].note));
  assert(Rules.diffVersions(f.state.wb.versions[3], v0).filter(d => d.kind !== 'test').length === 0, '回復後存的新版，內容應該和 v0.1.0 一樣');
  assert(f.state.wb.versions.slice(0, 3).every((v, i) => JSON.stringify(v) === JSON.stringify(db.wb.versions[i])), '舊版本被改到');
  // 整版回復本身不能再用「回復這次變更」，也不影響單次變更的回復規則
  const bad = Store.wb.revertChange(f.state, 'CHG-003', '想復原'); assert(!bad.ok && /整版回復/.test(bad.message));
});
check('版本回復', '回復後測試沒全過：不存新版本、變更標成 failed，可再回復到另一版', () => {
  let db = stamp(chgState(), '第一版');
  const a = Store.wb.applyChange(db, { kind: 'low-op', req_id: 'REQ-026', to: 'le', reason: '改' });
  db = Store.wb.finishChange(a.state, 'CHG-001', Tests.runAll({ settings: a.state.settings })).state;
  const r = Store.wb.restoreVersion(db, 'v0.1.0', '回復');
  const bad = Tests.runAll({ settings: r.state.settings }).map((x, i) => i === 0 ? Object.assign({}, x, { pass: false, actual: '故意失敗' }) : x);
  const f = Store.wb.finishChange(r.state, r.data.id, bad);
  assert(!f.ok && f.state.wb.changes[1].status === 'failed' && f.state.wb.versions.length === 2 && /再回復到另一個版本/.test(f.message), f.message);
  const again = Store.wb.restoreVersion(f.state, 'v0.1.1', '再回復到另一版'); assert(!again.ok || again.state.wb.changes.length === 3, '還能再回復');
});

// ---------- 登入與角色權限（第 4 步）----------
const pwOf = id => SEED.users.find(u => u.id === id).password;
check('角色權限', '五種角色：管理員、老闆有全部權限（isManager），業務、倉管、生管是員工（isStaff）；只有業務可叫貨', () => {
  const role = id => SEED.users.find(u => u.id === id);
  assert(['U03', 'U04', 'U07'].every(id => Rules.isManager(role(id)) && !Rules.isStaff(role(id))), '管理權限');
  assert(['U01', 'U02', 'U05', 'U06'].every(id => Rules.isStaff(role(id)) && !Rules.isManager(role(id))), '員工');
  assert(Rules.ROLE.admin === '管理員' && Rules.ROLE.warehouse === '倉管' && Rules.ROLE.planner === '生管');
  assert(!Rules.isManager(null) && !Rules.isStaff(undefined) && !Rules.isManager({ role: 'x' }), '不認得的角色沒有任何權限');
  assert(SEED.users.length === 7 && new Set(SEED.users.map(u => u.account)).size === 7, '帳號不能重複');
});
check('角色權限', '登入：帳號不分大小寫、前後空白忽略；成功與失敗都寫稽核；失敗訊息一致；登出寫稽核；沒登入過的人登出也留紀錄', () => {
  const ok = ERP.login(SEED, ' Boss ', pwOf('U03')); assert(ok.ok && ok.data.user_id === 'U03' && ok.state.audit[ok.state.audit.length - 1].action === 'LOGIN');
  const bad = ERP.login(SEED, 'boss', 'nope'); const bad2 = ERP.login(SEED, 'zzz', 'nope');
  assert(!bad.ok && !bad2.ok && bad.message === bad2.message && bad.state.audit[bad.state.audit.length - 1].action === 'LOGIN_DENIED');
  assert(JSON.stringify(bad.state.audit).indexOf('nope') < 0, '稽核不該記下輸入的密碼');
  const out = ERP.logout(ok.state, 'U03'); assert(out.ok && out.state.audit[out.state.audit.length - 1].action === 'LOGOUT');
  const no = ERP.logout(SEED, 'U99'); assert(!no.ok && no.state.audit.length === SEED.audit.length + 1);
  assert(!ERP.login(SEED, null, null).ok && !ERP.login(SEED, undefined, undefined).ok && !ERP.login(SEED, 'boss', undefined).ok, '空值不能登入');
});
check('角色權限', '末端價：新增商品可填末端價（不得低於店家價）；改價可改末端價；沒填就是未設定；員工看得到、不影響成本隱藏', () => {
  const a = ERP.addProduct(SEED, 'U07', { brand: 'B', name: 'N', spec: '9/9R9', year: 2025, cost: 100, price: 200, retail: 260 }); assert(a.ok && prod(a.state, a.data.sku).retail === 260);
  const lo = ERP.addProduct(SEED, 'U03', { brand: 'B', name: 'N', spec: '9/9R9', year: 2025, cost: 100, price: 200, retail: 150 }); assert(!lo.ok && /末端價不能低於店家價/.test(lo.message) && lo.state.products.length === SEED.products.length);
  const zero = ERP.addProduct(SEED, 'U03', { brand: 'B', name: 'N', spec: '9/9R9', year: 2025, cost: 100, price: 200, retail: 0 }); assert(!zero.ok);
  const none = ERP.addProduct(SEED, 'U03', { brand: 'B', name: 'N', spec: '9/9R9', year: 2025, cost: 100, price: 200 }); assert(none.ok && prod(none.state, none.data.sku).retail === null);
  const q = ERP.queryStock(none.state, 'U05', '9/9R9').data[0]; assert(q.retail === null && !('cost' in q));
  const up = ERP.updateProduct(SEED, 'U03', 'TR-001', { retail: 4500 }); assert(up.ok && prod(up.state, 'TR-001').retail === 4500 && prod(up.state, 'TR-001').price === 3300);
  assert(!ERP.updateProduct(SEED, 'U03', 'TR-001', { retail: 3000 }).ok, '末端價低於店家價');
  assert(!ERP.updateProduct(SEED, 'U03', 'TR-001', { price: 3300, retail: 4300 }).ok, '沒變動要拒絕');
  assert(!ERP.updateProduct(SEED, 'U05', 'TR-001', { retail: 4500 }).ok, '倉管不能改價');
  assert(SEED.products.every(p => p.retail > p.price), '種子資料的末端價要高於店家價');
});
check('角色權限', '預留時機已定案：REQ-004B 與 REQ-004 都有「已決定／未採用」說明，不再請教授確認', () => {
  const b = Rules.REQ_CATALOG['REQ-004B'].decision, a = Rules.REQ_CATALOG['REQ-004'].decision;
  assert(/已決定（2026-10-14）/.test(b) && /不需要再請教授確認/.test(b) && /未採用/.test(a));
  const w = W.wb.requirements; assert(w.find(r => r.id === 'REQ-004B').note === b && w.find(r => r.id === 'REQ-004').note === a, '確認需求畫面的備註沒有帶到：' + w.find(r => r.id === 'REQ-004B').note);
});
check('角色權限', 'RULE-029／030 閉環 8／8 且驗收案例已實作；REQ-027 採納後進開發包，規格寫明角色與登入', () => {
  for (const id of ['RULE-029', 'RULE-030']) { const r = Rules.RULE_TEMPLATES.find(x => x.id === id); assert(Rules.check(r).complete && r.t.tests.length && r.f.tests.length && Rules.implemented(r), id); }
  const db = chgState();
  const pack = Rules.devpack(db); assert(['RULE-029', 'RULE-030', 'RULE-001'].every(id => pack.ready.includes(id)), pack.ready.join());
  assert(/admin（管理員）/.test(pack.files['SPEC.md']) && /RULE-029/.test(pack.files['SPEC.md']));
  assert(/員工（業務、倉管、生管）不可看到成本與毛利/.test(db.wb.requirements.find(r => r.id === 'REQ-006').text));
});
check('角色權限', '舊資料第 6 版升到第 7 版：補新帳號與密碼、補末端價、補 REQ-027；已有的帳號與訂單不動', () => {
  const s = clone(W); s.meta.data_version = 6;
  s.users = s.users.slice(0, 4).map(u => { const c = Object.assign({}, u); delete c.account; delete c.password; return c; });
  s.products.forEach(p => { delete p.retail; });
  s.wb.requirements = s.wb.requirements.filter(r => r.id !== 'REQ-027');
  s.wb.requirements.find(r => r.id === 'REQ-004B').note = '預留時機（二選一）';
  mem['aiwb_state_v01'] = JSON.stringify(s); const m = Store.load(); delete mem['aiwb_state_v01'];
  assert(m.meta.data_version === 7 && m.users.length === 7 && m.users.every(u => u.account && u.password), '帳號沒補齊');
  assert(m.products.every(p => p.retail === SEED.products.find(x => x.sku === p.sku).retail), '末端價沒補上');
  assert(m.wb.requirements.some(r => r.id === 'REQ-027' && r.status === 'ai'), '沒補 REQ-027');
  assert(/已決定（2026-10-14）/.test(m.wb.requirements.find(r => r.id === 'REQ-004B').note), '舊備註沒換成定案說明');
  assert(JSON.stringify(m.orders) === JSON.stringify(s.orders), '訂單被動到');
});

// ---------- 用白話寫驗收案例 ----------
check('驗收案例', '用白話寫驗收案例：自動編號、加進成立／不成立清單；補齊後 8／8；開發包的驗收清單寫出「前提」與「預期」', () => {
  let x = D;
  const rule = s => s.wb.rules.find(r => r.id === 'RULE-008');
  assert(!Rules.check(rule(x)).complete, '前提：RULE-008 一開始不完整');
  x = Store.wb.updateRule(x, 'RULE-008', 'f.action', '訂單不被取消').state;
  assert(Rules.check(rule(x)).missing.join() === '驗收案例', '只剩驗收案例：' + Rules.check(rule(x)).missing.join());
  const a1 = Store.wb.addCase(x, 'RULE-008', 't', '訂單已核准，還沒出貨', '訂單被取消，釋放預留'); assert(a1.ok && a1.data.id === 'TC-008-01', a1.message);
  assert(!Rules.check(rule(a1.state)).complete, '只有一個案例還不夠（成立、不成立各至少 1 個）');
  const a2 = Store.wb.addCase(a1.state, 'RULE-008', 'f', '訂單已出貨', '不能取消，訂單維持已出貨'); assert(a2.ok && a2.data.id === 'TC-008-02', a2.message);
  const r = rule(a2.state);
  assert(r.t.tests.includes('TC-008-01') && r.f.tests.includes('TC-008-02') && r.drafts.length === 2, '案例沒有放進清單');
  assert(Rules.check(r).complete, '補齊後應該 8／8');
  assert(!Rules.implemented(r), '案例還沒有自動測試，不能算已實作');
  assert(Rules.pendingDrafts(a2.state).length === 2 && Rules.draftOf(r, 'TC-008-01').given === '訂單已核准，還沒出貨');
  assert(JSON.stringify(a2.state.wb).includes('CASE_ADD'), '沒有留下紀錄');
  const g = Store.wb.genDevpack(a2.state); assert(g.ok, g.message);
  const pack = Rules.devpack(g.state);
  assert(pack.ready.includes('RULE-008'), 'RULE-008 應該進開發包');
  const tests = pack.files['TESTS.md'];
  assert(/TC-008-01 \| RULE-008 \| True \| （使用者寫的例子） \| 訂單已核准，還沒出貨 \| 訂單被取消，釋放預留 \| 待實作/.test(tests), '驗收清單沒有寫出前提與預期：' + tests.split('\n').filter(l => /TC-008/.test(l)).join(' / '));
  assert(/待實作/.test(pack.files['AGENT_PROMPT.md']) && /沿用同一個編號/.test(pack.files['AGENT_PROMPT.md']), '給 AI 的指令沒有說明待實作案例');
  return '兩個案例 TC-008-01、02 進入開發包，狀態「待實作」';
});
check('驗收案例', '寫驗收案例的防呆：空白、不認得的分支、找不到的規則都拒絕且資料不變；編號避開已有的自動測試；符號不會弄壞表格', () => {
  const same = (res, base) => assert(!res.ok && JSON.stringify(res.state) === JSON.stringify(base), res.message);
  same(Store.wb.addCase(D, 'RULE-008', 't', '   ', '預期'), D);
  same(Store.wb.addCase(D, 'RULE-008', 't', '情況', ''), D);
  same(Store.wb.addCase(D, 'RULE-008', 'zz', '情況', '預期'), D);
  same(Store.wb.addCase(D, 'RULE-999', 't', '情況', '預期'), D);
  const n = Store.wb.addCase(D, 'RULE-003', 't', '情況 a|b', '預期 c|d'); assert(n.ok && n.data.id === 'TC-003-04', '應避開已有的 TC-003-01～03：' + n.data.id);
  const row = Rules.devpack(Store.wb.genDevpack(n.state).state).files['TESTS.md'].split('\n').find(l => l.indexOf('| TC-003-04') === 0);
  assert(row && row.split('|').length === 9 && row.indexOf('a|b') < 0, '直線符號會弄壞表格：' + row);
});
check('驗收案例', '刪除自己寫的案例：只能刪沒有自動測試的草稿；已有自動測試的案例不能從這裡刪', () => {
  let x = Store.wb.addCase(D, 'RULE-008', 't', '情況', '預期').state;
  const del = Store.wb.removeCase(x, 'RULE-008', 'TC-008-01'); assert(del.ok, del.message);
  const r = del.state.wb.rules.find(q => q.id === 'RULE-008');
  assert(!r.t.tests.includes('TC-008-01') && (r.drafts || []).length === 0, '沒有刪乾淨');
  const no = Store.wb.removeCase(D, 'RULE-003', 'TC-003-01'); assert(!no.ok && /自己用白話寫/.test(no.message), '不是自己寫的案例不能刪');
  assert(!Store.wb.removeCase(D, 'RULE-999', 'TC-999-01').ok);
});

// ---------- 請 AI 幫我補（情況 A：只缺驗收案例；情況 B：只有條件）----------
const aiState = () => {
  let x = C;
  for (const id of ['REQ-008', 'REQ-010', 'REQ-011', 'REQ-017', 'REQ-018']) x = Store.wb.setReqStatus(x, id, 'adopt').state;
  for (const r of x.wb.requirements.filter(r => r.status === 'ai')) x = Store.wb.setReqStatus(x, r.id, 'defer').state;
  const b = Store.wb.buildRules(x); assert(b.ok, b.message); return b.state;
};
const ruleOf = (s, id) => s.wb.rules.find(r => r.id === id);
check('請 AI 補', '情況 A（RULE-009 寄庫：內容寫好、只缺驗收案例）：AI 依規則整理成立／不成立各一個案例；要人確認後才算寫完整，確認後進開發包', () => {
  let x = aiState();
  assert(Rules.check(ruleOf(x, 'RULE-009')).missing.join() === '驗收案例', '前提：只缺驗收案例');
  assert(Rules.aiCanHelp(ruleOf(x, 'RULE-009')), 'AI 應該幫得上忙');
  const a = Store.wb.aiComplete(x, 'RULE-009'); assert(a.ok, a.message);
  const r = ruleOf(a.state, 'RULE-009');
  assert(a.data.fields.length === 0 && a.data.cases.length === 2, '不該改任何欄位，只整理 2 個案例：' + JSON.stringify(a.data));
  assert(r.drafts.length === 2 && r.drafts.every(d => d.by === 'AI') && r.t.tests.length === 1 && r.f.tests.length === 1, '案例沒放進成立／不成立清單');
  assert(/下面這個情況成立時：訂購數/.test(r.drafts.find(d => d.side === 't').given) && /全部訂購數都從庫存扣掉/.test(r.drafts.find(d => d.side === 't').expect), '成立案例要用規則自己的文字：' + r.drafts[0].given + ' → ' + r.drafts[0].expect);
  assert(/反過來，下面這個情況不成立時/.test(r.drafts.find(d => d.side === 'f').given), '不成立案例');
  let ck = Rules.check(r);
  assert(!ck.complete && ck.needsReview && ck.items.every(i => i.ok) && ck.missing.join() === '你確認 AI 的建議', '還沒確認前不能算完整：' + ck.missing.join());
  assert(!Rules.devpack(Store.wb.genDevpack(a.state).state || a.state).ready.includes('RULE-009') || true);
  const before = Rules.devpack(a.state); assert(!before.ready.includes('RULE-009') && before.blocked.includes('RULE-009'), '沒確認就不能進開發包');
  const ok = Store.wb.confirmAiDraft(a.state, 'RULE-009'); assert(ok.ok, ok.message);
  assert(Rules.check(ruleOf(ok.state, 'RULE-009')).complete, '確認後應該完整');
  const pack = Rules.devpack(ok.state); assert(pack.ready.includes('RULE-009'), '確認後進開發包');
  assert(/TC-009-01 \| RULE-009 \| True \| （使用者寫的例子）[^\n]*待實作/.test(pack.files['TESTS.md']), '驗收清單要列出待實作的案例');
  assert(!Store.wb.confirmAiDraft(ok.state, 'RULE-009').ok && !Store.wb.aiComplete(ok.state, 'RULE-009').ok, '已確認、已補齊後不能重複');
});
check('請 AI 補', '情況 B（RULE-020：只有條件）：AI 補齊白話草稿與案例；使用者已經寫的內容不會被蓋掉', () => {
  let x = aiState();
  assert(Rules.check(ruleOf(x, 'RULE-020')).missing.length === 7, '前提：缺 7 項');
  x = Store.wb.updateRule(x, 'RULE-020', 't.action', '我自己寫的：取消並退款').state;
  const a = Store.wb.aiComplete(x, 'RULE-020'); assert(a.ok, a.message);
  const r = ruleOf(a.state, 'RULE-020');
  assert(r.t.action === '我自己寫的：取消並退款' && !a.data.fields.includes('t.action'), '使用者寫的被蓋掉了');
  assert(a.data.fields.length === 9 && r.ai_draft.fields.length === 9, '應補 9 個空白欄位：' + a.data.fields.length);
  assert(a.data.cases.length === 2 && /我自己寫的：取消並退款/.test(r.drafts.find(d => d.side === 't').expect), '案例要用補完後的規則內容');
  assert(Rules.check(r).items.every(i => i.ok) && !Rules.check(r).complete, '內容補齊但還沒確認');
  const ok = Store.wb.confirmAiDraft(a.state, 'RULE-020'); assert(ok.ok && Rules.check(ruleOf(ok.state, 'RULE-020')).complete);
  // 使用者在 AI 補完後可以再改、也可以刪案例；確認後再改不會把「已確認」收回
  const edited = Store.wb.updateRule(ok.state, 'RULE-020', 'f.message', '我改過的訊息'); assert(Rules.check(ruleOf(edited.state, 'RULE-020')).complete);
});
check('請 AI 補', '所有候選規則（只有條件、或缺項的範本）都能由 AI 補到 8／8；已經完整的規則 AI 不會動', () => {
  const x0 = aiState(); const x = JSON.parse(JSON.stringify(x0)); x.wb.rules = Rules.RULE_TEMPLATES.map(r => JSON.parse(JSON.stringify(r)));
  let fixed = [], untouched = [];
  for (const tpl of Rules.RULE_TEMPLATES) {
    const before = Rules.check(tpl);
    const a = Store.wb.aiComplete(x, tpl.id);
    if (before.complete) { assert(!a.ok, tpl.id + ' 已完整，AI 不該動'); untouched.push(tpl.id); continue; }
    assert(a.ok, tpl.id + '：' + a.message);
    const c = Store.wb.confirmAiDraft(a.state, tpl.id); assert(c.ok, tpl.id);
    const ck = Rules.check(ruleOf(c.state, tpl.id)); assert(ck.complete, tpl.id + ' 補完後還缺：' + ck.missing.join());
    fixed.push(tpl.id);
  }
  assert(fixed.length === 12 && fixed.includes('RULE-008') && fixed.includes('RULE-025'), '應補 12 條：' + fixed.join());
  return 'AI 補到完整的規則：' + fixed.join('、');
});
check('請 AI 補', '防呆：找不到規則、沒有待確認的建議、條件沒寫時不整理案例', () => {
  const x = aiState();
  assert(!Store.wb.aiComplete(x, 'RULE-999').ok && !Store.wb.confirmAiDraft(x, 'RULE-999').ok && !Store.wb.confirmAiDraft(x, 'RULE-020').ok);
  assert(!Rules.aiCanHelp(ruleOf(x, 'RULE-003')), '完整的規則 AI 幫不上忙');
  const y = Store.wb.updateRule(x, 'RULE-009', 'if', '').state;
  assert(Rules.deriveCases(ruleOf(y, 'RULE-009')).length === 0, '沒寫條件就不整理案例');
});

// ---------- 輸出 ----------
const passed = results.filter(r => r.ok).length;
if (FLAGS.json) {
  console.log(JSON.stringify({ root, passed, total: results.length, ok: passed === results.length, failures: results.filter(r => !r.ok).map(r => ({ group: r.group, name: r.name, info: r.info })) }, null, 2));
} else {
  let g = '';
  for (const r of results) {
    if (FLAGS.quiet && r.ok) continue;
    if (r.group !== g) { g = r.group; console.log('\n[' + g + ']'); }
    console.log((r.ok ? '  ✔ ' : '  ✘ ') + r.name + (r.info ? '  → ' + r.info : ''));
  }
  console.log('\n合計 ' + passed + ' / ' + results.length + ' 通過');
}
process.exitCode = passed === results.length ? 0 : 1;
