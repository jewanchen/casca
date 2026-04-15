# Casca MiniLM — 訓練資料供應規格書

> **For: Language Experts / Data Providers**
> **Version**: 1.0 · 2026-04-15
> **Contact**: casca@vastitw.com

---

## 0. TL;DR — 給你的任務（一頁版）

你要為 Casca 的 MiniLM 分類器提供訓練資料。

- **格式**：JSONL（UTF-8，每行一個 JSON 物件）
- **標籤**：把每筆 prompt 分為 **HIGH / MED / LOW** 三類
- **語言**：你被指派的語言（見 §4）
- **數量目標**：每位大師 **300 筆** 起跳（理想 500 筆）
- **交付**：檔名 `{your_name}_{lang}_{batch_n}.jsonl`，Email 或批量上傳

分類規則（最重要）：

| 標籤 | 意義 | 典型例子 |
|---|---|---|
| **HIGH** | 需要深度推理、多步驟分析、專業領域知識、綜合性產出 | "為 GDPR 合規設計完整框架"、"分析半導體供應鏈風險" |
| **MED** | 中等生成、組織、格式化、情感支持 | "幫我寫道歉信"、"最近壓力很大"、"總結這段文字" |
| **LOW** | 簡單查詢、定義、翻譯、一句話回應 | "什麼是 API？"、"謝謝"、"把 hello 翻成日文" |

⚠️ **判斷依據是「任務複雜度」，不是「主題高低」。**
例：
- "什麼是 GDPR？" = **LOW**（定義查詢）
- "設計 GDPR 合規框架" = **HIGH**（產出複雜文件）

---

## 1. 為什麼需要你的協助

Casca 是一套 AI LLM 智慧路由引擎。它把每個用戶 prompt 分類為 HIGH/MED/LOW，然後路由到最適合的 LLM（GPT-4o 很貴但強、GPT-4o-mini 便宜快、Gemini Flash 最便宜），幫客戶降低 30-60% 的 AI 帳單。

分類錯誤的代價：
- **HIGH 誤判成 LOW** → 用錯模型 → 品質不足 → 客戶流失
- **LOW 誤判成 HIGH** → 浪費錢 → 失去賣點

我們的規則引擎（160 條 regex）已經達到 97% 準確率，但**邊界案例**（AMBIG）需要一個 ML 模型（MiniLM）補強。MiniLM 需要「**你母語的真實分類直覺**」來訓練。

---

## 2. 資料檔案格式

### 2.1 檔案結構

**JSONL 格式**（JSON Lines）：每一行是一個獨立的 JSON 物件，檔案整體**不是** JSON array。

**編碼**：UTF-8（**不要** BOM）
**副檔名**：`.jsonl`
**行尾**：`\n`（LF，不要 CRLF）

### 2.2 單筆資料欄位

```json
{
  "prompt": "為台灣中型製造業設計工業4.0轉型計畫，涵蓋現況評估、技術路線選擇、導入分期和投資回報率估算。",
  "label": "HIGH",
  "lang": "ZH",
  "domain": "tech",
  "conv_mode": "PROFESSIONAL",
  "last_tier": "",
  "turn_count": 1,
  "context_prompt": "",
  "noise_type": "",
  "confidence": 90,
  "annotator": "your_name",
  "region": "TW",
  "notes": ""
}
```

### 2.3 欄位詳細說明

| 欄位 | 必填 | 型別 | 說明 | 範例 |
|---|---|---|---|---|
| `prompt` | ✅ | string | 使用者的提問/指令（≥3 字元，≤500 字元） | "設計微服務架構" |
| `label` | ✅ | enum | **HIGH / MED / LOW**（大寫，只能三選一） | "HIGH" |
| `lang` | ✅ | enum | 見 §4 語言清單 | "ZH" |
| `domain` | ⭕ | enum | business / legal / tech / finance / medical / lifestyle / creative / general | "tech" |
| `conv_mode` | ⭕ | enum | PROFESSIONAL / EMPATHY / SIMPLE / CODE_TASK / LEARNING / LIFESTYLE / CREATIVE | "PROFESSIONAL" |
| `last_tier` | ⭕ | string | 多輪對話時前一輪的分類（HIGH/MED/LOW），單輪留空 `""` | "" |
| `turn_count` | ⭕ | int | 對話輪次，單輪 prompt 填 1 | 1 |
| `context_prompt` | ⭕ | string | 多輪對話時的上一輪 prompt（單輪留空 `""`） | "" |
| `noise_type` | ⭕ | enum | FRAGMENT / ZH-VAGUE / J-POLY / 空字串 | "" |
| `confidence` | ⭕ | int (0-100) | 你對這筆標籤的信心（>80 高信心，40-80 中等，<40 是邊界案例） | 90 |
| `annotator` | ✅ | string | 你的識別代號（拉丁字母，無空格） | "sato_japan" |
| `region` | ⭕ | string | 地區碼（ISO，如 TW/CN/JP/US/FR/DE/...） | "TW" |
| `notes` | ⭕ | string | 選填，任何你想說明的分類理由 | "" |

### 2.4 完整範例（5 行 JSONL）

```jsonl
{"prompt":"什麼是 GDPR？","label":"LOW","lang":"ZH","domain":"legal","conv_mode":"LEARNING","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":90,"annotator":"wang_tw","region":"TW","notes":"定義查詢"}
{"prompt":"幫我擬一份 GDPR 合規檢查清單給我們歐盟子公司參考","label":"MED","lang":"ZH","domain":"legal","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":82,"annotator":"wang_tw","region":"TW","notes":"中等產出"}
{"prompt":"為我們在歐盟運營的台灣電商設計完整的 GDPR 合規框架，包含資料處理政策、隱私聲明、資安事件通報程序和員工培訓計畫","label":"HIGH","lang":"ZH","domain":"legal","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":92,"annotator":"wang_tw","region":"TW","notes":"綜合性產出"}
{"prompt":"再精簡一點","label":"MED","lang":"ZH","domain":"general","conv_mode":"PROFESSIONAL","last_tier":"HIGH","turn_count":2,"context_prompt":"為我們歐盟子公司設計 GDPR 合規框架","noise_type":"FRAGMENT","confidence":55,"annotator":"wang_tw","region":"TW","notes":"多輪上下文繼承"}
{"prompt":"謝謝","label":"LOW","lang":"ZH","domain":"general","conv_mode":"SIMPLE","last_tier":"MED","turn_count":3,"context_prompt":"再精簡一點","noise_type":"FRAGMENT","confidence":95,"annotator":"wang_tw","region":"TW","notes":"結束語"}
```

---

## 3. 分類判斷指南（核心！）

### 3.1 HIGH — 深度與廣度

勾到以下**任何一個**要素就是 HIGH：

- [ ] **綜合性產出**：要產出涵蓋多面向的完整文件（策略書、框架、計畫、合約）
- [ ] **多步驟推理**：需要先分析 A 再推導 B 再結合 C
- [ ] **專業領域判斷**：法律合規、醫療診斷、金融建模、資安審計
- [ ] **具名框架/合規**：GDPR, HIPAA, SOC2, ISO27001, PCI-DSS, RGPD
- [ ] **策略/路線圖**：Go-to-market、數位轉型、組織變革
- [ ] **複雜技術架構**：微服務、高可用、災難恢復、K8s 架構
- [ ] **深度分析**：財報分析、市場進入可行性、供應鏈風險
- [ ] **Debug/資安**：抓蟲、漏洞分析、程式碼審查

**HIGH 典型 prompt 長度：40-200+ 字**

### 3.2 MED — 中等生成與支持

- [ ] **中等文字產出**：寫一封 email、摘要、翻譯、改寫、補充
- [ ] **單面向生成**：寫一段文案、一則貼文、一個段落
- [ ] **情感支持**：「最近很累」、「好挫折」、「怎麼辦」
- [ ] **簡單程式碼**：寫一個函式、修一個 bug、解釋程式碼
- [ ] **比較 2 個項目**：A vs B
- [ ] **分類/提取**：判斷這是不是垃圾郵件、從這段抽出關鍵字

**MED 典型長度：10-80 字**

### 3.3 LOW — 簡短與查詢

- [ ] **定義**：「什麼是 X」、「X 的意思」
- [ ] **單一事實查詢**：「台灣首都是哪裡」、「1+1」
- [ ] **短翻譯**：「hello 日文怎麼說」
- [ ] **結束語/問候**：「謝謝」、「好的」、「再見」、「thanks」
- [ ] **快取友善**：同一個問題全世界都會問，而且答案不變
- [ ] **格式化/驗證**：「把這個日期轉 ISO」、「檢查 email 格式」

**LOW 典型長度：2-15 字**

### 3.4 邊界案例 — 最有價值的資料

這些就是 MiniLM 最需要學的，請**刻意加入**：

#### 類型 1: 同主題、不同複雜度
```
"什麼是 NDA"          → LOW
"幫我寫一份 NDA"       → MED
"擬一份雙方條款詳盡的 NDA 涵蓋美台兩地法律" → HIGH
```

#### 類型 2: FRAGMENT（多輪對話片段）
```
context_prompt: "設計完整的 K8s 架構"  (last_tier=HIGH)
current prompt: "再簡化一點"           → MED（繼承上下文）
```

#### 類型 3: 語意模糊
- 中文：「幫我看一下這個」、「再研究一下」
- 日文：「先日の件」、「あれ」
- 英文：「do that again」、「check this」

#### 類型 4: 情緒優先但任務複雜
```
"最近工作好累，幫我寫一封辭職信，要有專業度但也要表達我的感謝"
→ MED（情感 + 中等產出，不是 HIGH）
```

### 3.5 判斷流程圖

```
收到一筆 prompt
   ↓
是結束語 / 單詞 / 問候？ → YES → LOW
   ↓ NO
是單一定義 / 簡單翻譯？ → YES → LOW
   ↓ NO
需要產出 >200 字 deliverable？ → YES → HIGH
   ↓ NO
是專業領域合規 / 策略 / 複雜架構？ → YES → HIGH
   ↓ NO
需要多步推理 / 複合分析？ → YES → HIGH
   ↓ NO
中等生成 / 情感支持 / 中短文產出？ → YES → MED
   ↓ NO
預設 → MED
```

---

## 4. 語言與指派

### 4.1 我們支援的 14 種語言

| 代碼 | 語言 | 區域碼範例 |
|---|---|---|
| `ZH` | 繁體中文 | TW, HK |
| `ZH_SC` | 簡體中文 | CN, SG |
| `EN` | English | US, UK, AU, CA |
| `JA` | 日本語 | JP |
| `KO` | 한국어 | KR |
| `FR` | Français | FR, CA, BE |
| `DE` | Deutsch | DE, AT, CH |
| `ES` | Español | ES, MX, AR, CL |
| `IT` | Italiano | IT |
| `PT` | Português | PT, BR |
| `HI` | हिन्दी | IN |
| `AR` | العربية | SA, AE, EG |
| `TH` | ไทย | TH |
| `VI` | Tiếng Việt | VN |
| `ID` | Bahasa Indonesia | ID |

### 4.2 Native 要求

**我們只接受母語者（Native Speaker）提供的資料。** 原因：

1. 文化語境：「很雷」、「踩雷」、「ngồi thiền」這類用法只有母語者能準確判斷
2. 邊界語感：「再想想」、「もう少し」、「verifica esto」在不同語言裡對應的複雜度不同
3. 錯誤語料太傷：非母語者的資料若被採用，會讓 MiniLM 學到錯的分布

---

## 5. 數量與配比

### 5.1 單位大師目標

| 等級 | 數量 | 預計時間 | 備註 |
|---|---|---|---|
| 基本交付 | **300 筆** | ~6-10 小時 | 合約門檻 |
| 理想交付 | **500 筆** | ~10-16 小時 | 推薦目標 |
| 卓越交付 | **800 筆** | ~18-25 小時 | 額外加給 |

### 5.2 Label 分布要求

你的 300 筆資料必須符合：

| Label | 比例 | 300 筆中的數量 |
|---|---|---|
| HIGH | 25-35% | 75-105 筆 |
| MED | 35-50% | 105-150 筆 |
| LOW | 20-30% | 60-90 筆 |

### 5.3 Domain 覆蓋要求

300 筆中請**至少涵蓋 6 個領域**，每個領域 ≥ 20 筆：

- `business` — 商業策略、行銷、組織、HR
- `legal` — 法律、合規、合約
- `tech` — 技術、程式、架構
- `finance` — 財務、投資、會計
- `medical` — 醫療、健康
- `lifestyle` — 生活、旅遊、烹飪、休閒
- `creative` — 創意寫作、藝術、文案
- `general` — 閒聊、問候、定義

### 5.4 邊界案例配額

300 筆中請包含：

- [ ] **50 筆 FRAGMENT**（多輪對話片段，要有 `context_prompt` + `last_tier`）
- [ ] **30 筆 ZH-VAGUE / J-POLY 類模糊指令**（只適用中日韓語言）
- [ ] **40 筆「同主題不同複雜度」三連組**（每組 3 筆：LOW/MED/HIGH 同一主題）

---

## 6. 嚴禁事項（會被退件）

### 6.1 品質紅線

- ❌ **複製既有的 prompt 只改幾個字** — 我們有去重機制
- ❌ **全部都是同一個領域/主題** — 必須多樣化
- ❌ **用 ChatGPT 批量產生** — 我們會用 similarity 檢測，每筆要有人類語感
- ❌ **label 全部是 HIGH 或 LOW** — 分布會被檢查
- ❌ **prompt 短於 3 字元** 或 **超過 500 字元**

### 6.2 個資與法律

- ❌ **不得包含真實 PII**：真實 email、電話、身分證、信用卡、姓名
- ❌ **不得含辱罵、仇恨、色情、暴力** 內容
- ❌ **不得抄襲有版權的小說/歌詞/新聞** — 可以引用風格但不能原文貼

如需人物姓名當例子，用 "Alice"、"陳先生"、"田中さん" 等通用代稱。

### 6.3 格式紅線

- ❌ JSON array（必須 JSONL）
- ❌ Windows CRLF 行尾（必須 LF）
- ❌ 有 BOM 的 UTF-8

---

## 7. 驗收流程

### 7.1 你的工作流

```
1. 先讀本文件（至少 §3 分類指南）
2. 下載我們的 seed 範例：seed_examples_{your_lang}.jsonl
3. 按 §5 配比寫 30-50 筆試交
4. 我們 24 小時內給 feedback（對 / 錯 / 需改進）
5. Feedback 對齊後，繼續產出到 300+ 筆
6. 批次交付 → 我們用品質檢查工具驗證
7. 驗收通過 → 匯款 + 下一批任務
```

### 7.2 自動驗證規則

上傳後系統會自動檢查：

```python
# 必須全部通過
assert len(prompt) >= 3 and len(prompt) <= 500
assert label in {'HIGH', 'MED', 'LOW'}
assert lang in {'ZH','ZH_SC','EN','JA','FR','DE','ES','IT','KO','HI','AR','TH','VI','ID','PT'}
assert confidence is None or 0 <= confidence <= 100
assert '@' not in prompt or '[EMAIL]' in prompt  # 禁 PII
# Similarity < 0.85 vs 既有資料（去重）
# Label 分布 25-35% / 35-50% / 20-30%
```

### 7.3 人工抽查

我們會隨機抽 10% 資料，由另一位母語者複核。若抽查不一致率 > 15%，整批退回修正。

---

## 8. 提交方式

### 8.1 檔案命名

```
{annotator}_{lang}_batch_{N}.jsonl

範例：
sato_yuki_JA_batch_1.jsonl
wang_minghua_ZH_batch_2.jsonl
johnson_EN_batch_1.jsonl
```

### 8.2 提交管道（三選一）

**A. Email 直傳**（最簡單）
- 寄到 `casca@vastitw.com`
- 主旨：`[MiniLM Data] {annotator}_{lang}_batch_{N}`
- 附件放 .jsonl 檔（< 10 MB）

**B. Web 上傳**（登入 Admin 後台）
1. 登入 https://casca-admin.cascaio.com
2. Path B → 批量上傳 → 拖拉 JSONL → 預覽 → 確認

**C. API 上傳**（大師/自動化用）
```bash
curl -X POST https://api.cascaio.com/api/admin/pathb/upload \
  -H "x-admin-secret: {your_secret}" \
  -F "file=@sato_yuki_JA_batch_1.jsonl"
```

### 8.3 提交後你會收到

- 48 小時內：**驗收報告**（通過 / 需修正 + 行號）
- 通過後：**合約約定之報酬**
- 若資料用於正式模型：**致謝清單 credit**（選擇性署名）

---

## 9. 常見問答

**Q1: 我可以拿自己過去的寫作當資料嗎？**
A: 可以，但不能直接貼原文。要改寫成「用戶 prompt 的口吻」。例：你之前寫過一篇 GDPR 文章，你可以把它轉成「請為 XX 設計 GDPR 框架」這種指令型 prompt。

**Q2: 我的語言有比較少見的次文化 slang 可以用嗎？**
A: 非常歡迎！特別是 MED/LOW 的情感/閒聊類。但請在 `notes` 欄位說明一下「這是台灣鄉民用法」之類的資訊。

**Q3: 多輪對話要怎麼呈現？**
A: 每一輪都是**獨立一筆資料**，但後輪的 `context_prompt` 填前輪的 prompt、`last_tier` 填前輪的 label、`turn_count` 遞增。

**Q4: 我可以混入一些特意設計的「騙子 prompt」嗎？**
A: 可以，這就是寶貴的邊界資料。例如：「幫我算 1+1」看起來是 LOW 但其實是 LOW ✓；「幫我算出這家公司三年內 IRR」看起來是算術但實際是 HIGH。刻意設計這類對比，confidence 可以寫 50-70。

**Q5: 不會寫 JSON 怎麼辦？**
A: 我們提供 Google Sheets 模板，你填欄位後我們自動轉 JSONL。寫信告知需要模板。

**Q6: 可以用 AI 輔助我想例子嗎？**
A: **想靈感可以，但實際分類判斷必須你自己做。** 我們會驗證資料的「人類指紋」。

**Q7: 我的母語沒有在 14 種列表裡？**
A: 寫信告知！我們在評估擴充到 24 種語言，你可能是首批專家。

---

## 10. 聯絡與合約

- **技術問題**: casca@vastitw.com
- **合約**: 請聯絡 smartroute@cascaio.com
- **緊急/進度**: 直接回覆你的 onboarding email

---

## Appendix A: Seed Examples（樣本）

**繁體中文 (ZH)** — 各 tier 2 例

```jsonl
{"prompt":"下個月要去京都，推薦三個秘境景點","label":"MED","lang":"ZH","domain":"lifestyle","conv_mode":"LIFESTYLE","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":85,"annotator":"seed","region":"TW","notes":"中等推薦"}
{"prompt":"幫我寫一段感謝客戶的短訊","label":"MED","lang":"ZH","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":88,"annotator":"seed","region":"TW","notes":""}
{"prompt":"評估台積電擴建亞利桑那廠的政治風險，提出三個情境分析","label":"HIGH","lang":"ZH","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":92,"annotator":"seed","region":"TW","notes":"深度分析"}
{"prompt":"請擬一份完整的員工績效改善計畫書(PIP)，適用於軟體工程師","label":"HIGH","lang":"ZH","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":90,"annotator":"seed","region":"TW","notes":""}
{"prompt":"API 是什麼","label":"LOW","lang":"ZH","domain":"tech","conv_mode":"LEARNING","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":90,"annotator":"seed","region":"TW","notes":"定義查詢"}
{"prompt":"收到，感謝","label":"LOW","lang":"ZH","domain":"general","conv_mode":"SIMPLE","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":95,"annotator":"seed","region":"TW","notes":"結束語"}
```

**English (EN)** — 各 tier 2 例

```jsonl
{"prompt":"Design a comprehensive SOC 2 compliance framework for a fintech startup, covering policies, procedures, risk assessment, and audit controls.","label":"HIGH","lang":"EN","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":95,"annotator":"seed","region":"US","notes":""}
{"prompt":"Summarize the key points of attached employment contract and highlight clauses that may be unfavorable to the employee.","label":"HIGH","lang":"EN","domain":"legal","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":90,"annotator":"seed","region":"US","notes":""}
{"prompt":"Draft a polite follow-up email asking for a status update on my job application.","label":"MED","lang":"EN","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":86,"annotator":"seed","region":"US","notes":""}
{"prompt":"Rewrite this paragraph in a more casual tone.","label":"MED","lang":"EN","domain":"creative","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":84,"annotator":"seed","region":"US","notes":""}
{"prompt":"What does NDA stand for?","label":"LOW","lang":"EN","domain":"legal","conv_mode":"LEARNING","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":92,"annotator":"seed","region":"US","notes":"definition"}
{"prompt":"thx!","label":"LOW","lang":"EN","domain":"general","conv_mode":"SIMPLE","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":96,"annotator":"seed","region":"US","notes":""}
```

**日本語 (JA)** — 各 tier 2 例

```jsonl
{"prompt":"日本のSaaS市場向けGo-To-Market戦略を策定してください。競合分析、価格戦略、チャネル戦略、90日間アクションプランを含めてください。","label":"HIGH","lang":"JA","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":90,"annotator":"seed","region":"JP","notes":""}
{"prompt":"当社のESG報告書を作成してください。環境、社会、ガバナンスの観点から日本の企業文化に合わせて。","label":"HIGH","lang":"JA","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":88,"annotator":"seed","region":"JP","notes":""}
{"prompt":"クライアントへの謝罪メールのドラフトを作ってください","label":"MED","lang":"JA","domain":"business","conv_mode":"PROFESSIONAL","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":85,"annotator":"seed","region":"JP","notes":""}
{"prompt":"最近仕事がつらくて、上司に有給取りたいと言いたい。どう切り出せばいい？","label":"MED","lang":"JA","domain":"lifestyle","conv_mode":"EMPATHY","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":82,"annotator":"seed","region":"JP","notes":"情感+中等"}
{"prompt":"APIとは何ですか","label":"LOW","lang":"JA","domain":"tech","conv_mode":"LEARNING","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":90,"annotator":"seed","region":"JP","notes":""}
{"prompt":"了解です","label":"LOW","lang":"JA","domain":"general","conv_mode":"SIMPLE","last_tier":"","turn_count":1,"context_prompt":"","noise_type":"","confidence":94,"annotator":"seed","region":"JP","notes":""}
```

（完整 14 語言的 seed 範例檔案請聯絡索取 `seed_examples_all_langs.zip`）

---

## Appendix B: 驗收範例輸出

你上傳後會收到類似報告：

```
═══════════════════════════════════════
 Validation Report — wang_minghua_ZH_batch_1.jsonl
═══════════════════════════════════════

Total rows: 312
✓ UTF-8 encoding: OK
✓ JSONL format: OK
✓ Prompt length (3-500): OK
✓ Labels in {HIGH,MED,LOW}: OK
✗ Label distribution:
    HIGH: 42% (target 25-35%) ⚠ too high
    MED:  38% (target 35-50%) ✓
    LOW:  20% (target 20-30%) ✓
  → 請刪掉 20 筆 HIGH 並補 20 筆 LOW

✓ Domain coverage: 7/8 domains (missing: medical)
✗ Duplicates vs existing pool: 3 rows similar > 0.85
  → Row 47, 128, 201 需改寫

✓ PII check: 0 rows flagged
✓ Toxicity check: 0 rows flagged

Status: PENDING REVISION
Next step: 修正上述問題後重新上傳。
═══════════════════════════════════════
```

---

**版本**: 1.0
**最後更新**: 2026-04-15
**文件所有權**: Vast Intelligence Limited · https://cascaio.com

> 你的貢獻將幫助全球開發者以更低成本、更高品質地使用 AI。
> 感謝你成為 Casca 的一份子。
