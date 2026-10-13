# CLAUDE.md — AI 可驗證開發工作台｜ERP 試做

## 專案目的
碩士論文雛形系統。工作台＝品質控制層（需求→IF 閉環規則→驗收測試→追蹤版本），
Coding Agent＝開發引擎。以輪胎批發 ERP 做垂直切片：查庫存→叫貨→送出→老闆核准→建立預留→更新可用庫存。

## 硬性限制
- 純 HTML/CSS/JS，雙擊 index.html（file://）即可執行；禁止 ES modules、框架、建置工具、外部 CDN。
- 每個 js 檔掛一個全域物件：SEED、Store、Rules、ERP、Tests、App；載入順序 data→store→rules→erp→tests→app。
- 資料存 localStorage，key = aiwb_state_v01；可重設回 SEED。
- 介面繁體中文。

## 領域規則（不可擅自更改）
- available = on_hand − reserved。
- 老闆「核准時」才預留（REQ-004）；「送出即預留」（REQ-004B）是替代決策，兩者不可同時確認。
- RULE-001 業務的查詢結果物件不可含 cost 欄位。
- RULE-002 叫貨數量必須為正整數。
- RULE-004 核准時重新讀取庫存，可用不足 → REJECTED 且資料完全不變。
- RULE-005 只有 SUBMITTED 可退回。
- 每條規則必須有：IF、True、False、資料效果、訊息、稽核、≥2 測試、最終狀態（8 項），缺一不可進入開發。

## 寫程式的規則
- ERP 函式第一個參數為 db，回傳 { ok, message, state }，並寫 audit。
- 畫面不可直接改資料，一律透過 ERP／Store 函式。
- 不可為了讓測試通過而修改 tests.js，除非使用者同意。
- 每完成一步：說明如何驗收 → 等使用者確認 → 才 commit。
- commit 訊息用 feat:/fix:/test:/docs: 前綴，中文描述。
