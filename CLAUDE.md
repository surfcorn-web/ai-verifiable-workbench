# CLAUDE.md — AI 可驗證開發工作台｜ERP 試做

## 專案目的
碩士論文雛形系統。工作台＝品質控制層（需求→IF 閉環規則→驗收測試→追蹤版本），
Coding Agent＝開發引擎。以輪胎批發 ERP 做垂直切片：查庫存→叫貨→送出（建立預留、更新可用庫存）→老闆核准。
使用者是不懂程式的業務、老闆與研究者：介面用白話中文，少用術語。

## 硬性限制
- 純 HTML/CSS/JS，雙擊 index.html（file://）即可執行；禁止 ES modules、框架、建置工具、外部 CDN。
- 每個 js 檔掛一個全域物件：SEED、Store、Rules、ERP、Tests、App；載入順序 data→store→rules→erp→tests→app。
- 資料存 localStorage，key = aiwb_state_v01；可重設回 SEED。
- 介面繁體中文。

## 領域規則（不可擅自更改）
- available = on_hand − reserved。
- 業務「送出時」即預留（REQ-004B，2026-10-13 使用者決定），避免其他業務在老闆審核期間用掉同一批庫存；
  「核准才預留」（REQ-004）是未採用的替代決策，兩者不可同時確認，RULE-004 不實作。
- RULE-001 業務的查詢結果物件不可含 cost 欄位。
- RULE-002 叫貨數量必須為正整數。
- RULE-003 送出時重新讀取庫存，可用不足 → 不可送出且資料完全不變；足夠 → reserved += qty、狀態 SUBMITTED。
- RULE-005 只有 SUBMITTED 可退回；退回時釋放預留（reserved −= qty）。
- RULE-006 老闆核准只改狀態（SUBMITTED → APPROVED），庫存不變。
- RULE-007 老闆拒絕 SUBMITTED 訂單 → REJECTED，釋放預留。
- 寄庫（REQ-011，候選、尚未實作）：採旺盛輪業的做法（2026-10-13 使用者決定）——購買當下就從庫存扣掉全部訂購數，
  當次只出貨一部分，其餘登記為客戶寄庫；之後客戶取貨只扣寄庫餘額，不再扣庫存。訂單明細要分開記錄：訂購數＝當次出貨數＋客戶寄庫數。
- 不變式：每個品項 reserved ＝ 所有 SUBMITTED 與 APPROVED 訂單該品項數量合計，且 0 ≤ reserved ≤ on_hand。
- 每條規則必須有：IF、True、False、資料效果、訊息、稽核、≥2 測試、最終狀態（8 項），缺一不可進入開發。

## 寫程式的規則
- ERP 函式第一個參數為 db，回傳 { ok, message, state }，並寫 audit。
- 畫面不可直接改資料，一律透過 ERP／Store 函式。
- 畫面給不懂程式的人看：用白話；REQ／RULE／TC 編號與英文狀態碼只能當小字，程式細節放在「技術細節」摺疊區。
- 每一頁都要說明「這一頁在做什麼」與「建議下一步」。
- 不可為了讓測試通過而修改 tests.js，除非使用者同意。
- 每完成一步：說明如何驗收 → 等使用者確認 → 才 commit。
- commit 訊息用 feat:/fix:/test:/docs: 前綴，中文描述。
