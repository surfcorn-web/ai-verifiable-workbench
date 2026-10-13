/* data.js — SEED：系統初始資料（「重設資料」會回到這裡）
 * 全域物件：SEED
 * 庫存規則：available = on_hand − reserved；reserved 只在老闆「核准時」增加（REQ-004）。
 * 種子資料的不變式：每個品項 reserved = 所有 APPROVED 訂單該品項數量合計。
 */
var SEED = {
  meta: {
    schema: 'aiwb_state_v01',
    app: 'AI 可驗證開發工作台',
    version: 'v0.1.0'
  },

  // ---------- ERP：輪胎批發 ----------
  users: [
    { id: 'U01', name: '阿明', role: 'sales' },
    { id: 'U02', name: '小芳', role: 'sales' },
    { id: 'U03', name: '王老闆', role: 'boss' },
    { id: 'U04', name: '王太太', role: 'boss' }
  ],

  products: [
    { sku: 'TR-001', brand: '米其林 Michelin', name: 'Primacy 4', spec: '205/55R16', year: 2025, on_hand: 130, reserved: 6, cost: 2650, price: 3300 },
    { sku: 'TR-002', brand: '普利司通 Bridgestone', name: 'Turanza T005', spec: '225/45R17', year: 2024, on_hand: 3, reserved: 2, cost: 3150, price: 3950 },
    { sku: 'TR-003', brand: '馬牌 Continental', name: 'UltraContact UC7', spec: '215/55R17', year: 2025, on_hand: 48, reserved: 0, cost: 2900, price: 3600 },
    { sku: 'TR-004', brand: '橫濱 Yokohama', name: 'BluEarth-GT AE51', spec: '195/65R15', year: 2023, on_hand: 60, reserved: 12, cost: 1850, price: 2300 },
    { sku: 'TR-005', brand: '瑪吉斯 Maxxis', name: 'Victra Sport 5', spec: '235/45R18', year: 2025, on_hand: 20, reserved: 20, cost: 2700, price: 3400 },
    { sku: 'TR-006', brand: '固特異 Goodyear', name: 'EfficientGrip Performance 2', spec: '205/60R16', year: 2024, on_hand: 36, reserved: 4, cost: 2350, price: 2900 },
    { sku: 'TR-007', brand: '建大 Kenda', name: 'KR201', spec: '185/65R15', year: 2025, on_hand: 80, reserved: 0, cost: 1250, price: 1650 },
    { sku: 'TR-008', brand: '米其林 Michelin', name: 'Pilot Sport 4', spec: '225/40R18', year: 2024, on_hand: 8, reserved: 0, cost: 4300, price: 5300 }
  ],

  orders: [
    {
      id: 'SO-0001', customer: '大發輪胎行', created_by: 'U01', status: 'APPROVED',
      lines: [{ sku: 'TR-001', qty: 6 }, { sku: 'TR-004', qty: 12 }],
      created_at: '2026-10-12T01:10:00.000Z', submitted_at: '2026-10-12T01:15:00.000Z',
      decided_at: '2026-10-12T02:02:00.000Z', decided_by: 'U03', return_reason: '',
      history: [
        { at: '2026-10-12T01:10:00.000Z', by: 'U01', from: null, to: 'DRAFT', note: '' },
        { at: '2026-10-12T01:15:00.000Z', by: 'U01', from: 'DRAFT', to: 'SUBMITTED', note: '' },
        { at: '2026-10-12T02:02:00.000Z', by: 'U03', from: 'SUBMITTED', to: 'APPROVED', note: '核准成功' }
      ]
    },
    {
      id: 'SO-0002', customer: '順安汽車', created_by: 'U02', status: 'APPROVED',
      lines: [{ sku: 'TR-002', qty: 2 }, { sku: 'TR-006', qty: 4 }],
      created_at: '2026-10-12T03:20:00.000Z', submitted_at: '2026-10-12T03:22:00.000Z',
      decided_at: '2026-10-12T04:05:00.000Z', decided_by: 'U04', return_reason: '',
      history: [
        { at: '2026-10-12T03:20:00.000Z', by: 'U02', from: null, to: 'DRAFT', note: '' },
        { at: '2026-10-12T03:22:00.000Z', by: 'U02', from: 'DRAFT', to: 'SUBMITTED', note: '' },
        { at: '2026-10-12T04:05:00.000Z', by: 'U04', from: 'SUBMITTED', to: 'APPROVED', note: '核准成功' }
      ]
    },
    {
      id: 'SO-0003', customer: '國道車隊', created_by: 'U02', status: 'APPROVED',
      lines: [{ sku: 'TR-005', qty: 20 }],
      created_at: '2026-10-12T05:00:00.000Z', submitted_at: '2026-10-12T05:01:00.000Z',
      decided_at: '2026-10-12T05:30:00.000Z', decided_by: 'U03', return_reason: '',
      history: [
        { at: '2026-10-12T05:00:00.000Z', by: 'U02', from: null, to: 'DRAFT', note: '' },
        { at: '2026-10-12T05:01:00.000Z', by: 'U02', from: 'DRAFT', to: 'SUBMITTED', note: '' },
        { at: '2026-10-12T05:30:00.000Z', by: 'U03', from: 'SUBMITTED', to: 'APPROVED', note: '核准成功' }
      ]
    },
    {
      id: 'SO-0004', customer: '建成車業', created_by: 'U01', status: 'SUBMITTED',
      lines: [{ sku: 'TR-003', qty: 8 }],
      created_at: '2026-10-13T00:40:00.000Z', submitted_at: '2026-10-13T00:42:00.000Z',
      decided_at: null, decided_by: null, return_reason: '',
      history: [
        { at: '2026-10-13T00:40:00.000Z', by: 'U01', from: null, to: 'DRAFT', note: '' },
        { at: '2026-10-13T00:42:00.000Z', by: 'U01', from: 'DRAFT', to: 'SUBMITTED', note: '' }
      ]
    }
  ],

  audit: [],
  seq: { order: 5, audit: 1, source: 3 },

  // ---------- 工作台 ----------
  wb: {
    project: {
      name: '輪胎批發 ERP（示範）',
      need: '',
      owner: '',
      created_at: '2026-10-13'
    },
    sources: [
      { id: 'SRC-01', name: '庫存表_2026-10.xlsx', kind: 'Excel', size: 48213, note: '老闆提供的庫存試算表（示範登記）', added_at: '2026-10-13T01:00:00.000Z' },
      { id: 'SRC-02', name: '手寫叫貨單_範例.jpg', kind: '單據', size: 512330, note: '業務手寫叫貨單照片（示範登記）', added_at: '2026-10-13T01:02:00.000Z' }
    ],
    interview: { step: 0, messages: [], questions: [] },
    requirements: [],
    rules: [],
    devpack: null,
    testRuns: [],
    versions: [],
    checklist: {},
    log: []
  }
};
