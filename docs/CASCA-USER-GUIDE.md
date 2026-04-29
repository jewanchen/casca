# Casca — 產品介紹與使用手冊

> **一行改動，降低 30-60% AI 帳單。品質不打折。**

---

## 目錄

1. [Casca 是什麼](#1-casca-是什麼)
2. [兩種使用模式](#2-兩種使用模式)
3. [註冊帳號](#3-註冊帳號)
4. [取得 API Key](#4-取得-api-key)
5. [快速整合](#5-快速整合)
6. [Dashboard 功能](#6-dashboard-功能)
7. [方案與計費](#7-方案與計費)
8. [API 端點速查](#8-api-端點速查)
9. [Zapier 整合](#9-zapier-整合)
10. [Salesforce 整合](#10-salesforce-整合)
11. [企業自建版（Casca Vault）](#11-企業自建版casca-vault)
12. [常見問題 FAQ](#12-常見問題-faq)

---

## 1. Casca 是什麼

你的團隊每天送出大量 AI 請求。但並非每個問題都需要最貴的模型來回答。

**「什麼是 API？」** — 用 Gemini Flash（$0.075/百萬 token）就能完美回答。
**「設計一套 GDPR 合規框架」** — 這才需要 GPT-4o（$5.00/百萬 token）。

Casca 是一個 **AI 智慧路由引擎**，自動判斷每筆請求的複雜度，然後路由到**成本最適合**的模型：

```
你的 App
    ↓  改一行 base_url
Casca（自動判斷複雜度）
    ├─ 簡單查詢 → Gemini Flash（最便宜）
    ├─ 中等任務 → GPT-4o-mini（平衡）
    └─ 複雜分析 → GPT-4o / Claude（最強）
    ↓
回應你的 App（格式完全相同）
```

### 核心數據

| 指標 | 數值 |
|---|---|
| 省費比例 | 30-60% |
| 分類準確率 | 95%+ |
| 增加的延遲 | < 15 毫秒 |
| 支援語言 | 14 種 |
| 支援 LLM | OpenAI、Anthropic、Google、Groq 等 |

### 支援語言

繁體中文 · 简体中文 · English · 日本語 · 한국어 · Français · Deutsch · Español · Italiano · العربية · हिन्दी · ไทย · Tiếng Việt · Bahasa Indonesia

---

## 2. 兩種使用模式

| | Passthrough | Managed |
|---|---|---|
| **你需要** | 自己的 LLM API Key | 只需 Casca Key |
| **LLM 帳單** | 你自付（OpenAI 寄給你） | Casca 幫你付（一張帳單） |
| **Casca 收費** | 路由費 | All-in token 費 |
| **適合** | 已有 LLM 帳號的開發者 | 不想管 LLM 的團隊 |
| **整合難度** | 一行改動 + 一個 header | 一行改動 |

### Passthrough — 用你自己的 LLM Key

```
你的 App → Casca（分類 + 選模型）→ 用你的 Key 呼叫 OpenAI → 回應
帳單：OpenAI 寄給你（降低 30-60%）+ Casca 路由費
```

### Managed — 讓 Casca 管理 LLM

```
你的 App → Casca（分類 + 選模型 + 呼叫 LLM）→ 回應
帳單：只有 Casca 一張（比 GPT-4o 便宜 60-70%）
```

---

## 3. 註冊帳號

### Step 1: 到官網

打開 **https://cascaio.com** → 點 **「Start Free」** 或 **「免費註冊」**

### Step 2: 填寫資料

| 欄位 | 必填 | 說明 |
|---|---|---|
| Email | ✅ | 用來收驗證信 |
| 密碼 | ✅ | 至少 8 個字元 |
| 公司名稱 | 選填 | 出現在 Dashboard |

### Step 3: 驗證 Email

收到來自 **noreply@cascaio.com** 的驗證信 → 點擊連結 → 完成

> 💡 **沒收到？** 檢查垃圾郵件夾。驗證信由 Resend 寄出，有時會被歸類為促銷郵件。

### Step 4: 登入

回到 **https://cascaio.com/dashboard** → 輸入 Email + 密碼 → 登入

---

## 4. 取得 API Key

登入 Dashboard 後，會自動跳出「啟用試用」彈窗。

### Step 1: 點「取得 API Key」

系統會產生一組 **csk_** 開頭的 Key，例如：
```
csk_4cc84b49879042e7f7cc5a80a3098b0a92b9a3da
```

### Step 2: 立即複製

> ⚠️ **API Key 只會顯示一次。** 請立即複製並安全保存。

### Step 3: 完成

你的 30 天試用已經開始。可以開始整合了。

---

## 5. 快速整合

### Passthrough 模式（用你自己的 LLM Key）

#### Python（OpenAI SDK）

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-你的OpenAI_Key",
    base_url="https://api.cascaio.com/v1",        # ← 改這行
    default_headers={"X-Casca-Key": "csk_你的Key"}  # ← 加這行
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What is an API?"}]
)
print(response.choices[0].message.content)
```

#### Node.js

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-你的OpenAI_Key',
  baseURL: 'https://api.cascaio.com/v1',
  defaultHeaders: { 'X-Casca-Key': 'csk_你的Key' },
});

const res = await client.chat.completions.create({
  model: 'auto',
  messages: [{ role: 'user', content: 'What is machine learning?' }],
});
```

#### cURL

```bash
curl -X POST https://api.cascaio.com/api/v1/chat/completions \
  -H "Authorization: Bearer sk-你的OpenAI_Key" \
  -H "X-Casca-Key: csk_你的Key" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello!"}]}'
```

### Managed 模式（用 Casca 的 LLM）

更簡單 — 只需要 Casca Key：

```python
client = OpenAI(
    api_key="csk_你的Key",                        # ← Casca Key 當 API Key
    base_url="https://api.cascaio.com/v1",
)
```

不需要 OpenAI 帳號。Casca 幫你管所有 LLM。

### 重點

- `base_url` 指向 `https://api.cascaio.com/v1`
- `model` 設 `"auto"` → Casca 自動選最佳模型
- 回應格式 100% 跟 OpenAI 相容，不用改任何解析邏輯
- `_casca` 額外欄位告訴你路由決策（tier、模型、省多少）

---

## 6. Dashboard 功能

登入 **https://cascaio.com/dashboard** 後可以看到：

### Overview（總覽）

- 本月節省費用
- 平均節省率
- 快取命中率
- 路由請求數
- 複雜度分配圖（HIGH / MED / LOW / Cache）
- 每日費用估算圖（GPT-4o vs GPT-4o-mini vs Gemini Flash）

### Live Router（路由模擬）

- 輸入 prompt → 即時看分類結果 + 模型選擇
- 「Casca Engine ON/OFF」比較
- Bypass 模式（緊急時繞過 Casca）

### Cost Audit（費用稽核）

- 推算年化節省
- 各用途費用明細
- 基準 vs 實際費用趨勢

### 使用紀錄

- 每筆 API 請求的詳細紀錄
- 複雜度、模型、token 數、費用、節省率、延遲

### 快取池

- 語意快取內容
- 命中次數、節省金額

### 品質保證

- 送到 HIGH 的對話清單
- 觸發規則、語言、模型
- 證明 Casca 不會把所有請求都送到便宜模型

### 可用性 SLA

- Server 即時健康狀態
- Provider 數量、Stripe 狀態

### Available Providers

- 可用的 LLM Provider 清單
- Managed 方案可勾選偏好 Provider

### Billing

- 帳號模式（Passthrough / Managed）
- 用量、餘額、方案
- 超額控制、Top-up

### API Keys

- 管理多組 API Key
- 啟用 / 停用

---

## 7. 方案與計費

### Passthrough（用你自己的 LLM Key）

| 方案 | 月費 | 路由配額 | 超額路由費 |
|---|---|---|---|
| **Free** | $0 | 10M tokens/月 | $0.20/1M |
| **Growth** | $499 | 500M tokens/月 | $0.10/1M |
| **Scale** | $1,999 | 5B tokens/月 | $0.05/1M |
| **Enterprise** | 年約客制 | 無上限 | 合約定價 |

> LLM 費用由你自付（OpenAI/Anthropic/Google 帳單）。Casca 只收路由費。

### Managed（Casca 幫你管 LLM）

| 方案 | 月費 | 內含額度 | 超額費率 |
|---|---|---|---|
| **Free** | $0 | 每週額度自動重設 | — |
| **Growth** | $499 | ~400M tokens | $1.50/1M |
| **Scale** | $1,999 | ~1.6B tokens | $1.20/1M |
| **Enterprise** | 年約客制 | 從 $0.80/1M 起 | 合約 |

> 一張帳單，不用自己管 OpenAI 帳號。

### Token 怎麼算？

- 以 **LLM 實際消耗的 token** 計算（從 LLM 回應的 `usage.total_tokens` 取得）
- 不是 Casca 估算的，是 LLM Provider 回報的真實數字
- Dashboard 上顯示的就是真實計費用量

### 到量暫停

- 用量達到額度上限 → 服務暫停
- Dashboard 會顯示提示
- 你可以選擇「同意超額計費」繼續使用，或等下次重設

---

## 8. API 端點速查

Base URL: `https://api.cascaio.com`

### 核心端點

| Method | Path | Auth | 說明 |
|---|---|---|---|
| POST | `/api/v1/chat/completions` | API Key | **主端點**（OpenAI 相容） |
| POST | `/api/classify` | 無 | 分類-only（不呼叫 LLM，<20ms） |
| POST | `/api/route` | API Key | 向後相容 alias |

### Dashboard 端點

| Method | Path | Auth | 說明 |
|---|---|---|---|
| GET | `/api/dashboard/me` | API Key / JWT | 帳戶資訊 |
| GET | `/api/dashboard/keys` | API Key / JWT | 列出 API Keys |
| POST | `/api/dashboard/keys` | API Key | 新建 Key |
| GET | `/api/dashboard/logs` | API Key / JWT | 使用紀錄 |
| GET | `/api/dashboard/cache` | API Key | 快取池 |
| GET | `/api/dashboard/audit` | API Key / JWT | 費用稽核 |
| GET | `/api/dashboard/health` | API Key / JWT | 健康狀態 |
| GET | `/api/dashboard/providers` | API Key / JWT | Provider 清單 |

### 計費端點

| Method | Path | Auth | 說明 |
|---|---|---|---|
| POST | `/api/billing/subscribe` | API Key | Stripe 訂閱 |
| POST | `/api/billing/topup` | API Key | 餘額儲值 |
| POST | `/api/billing/approve-overage` | API Key / JWT | 同意超額 |
| GET | `/api/billing/transactions` | API Key | 交易紀錄 |

### 認證端點

| Method | Path | Auth | 說明 |
|---|---|---|---|
| POST | `/api/auth/register` | 無 | 註冊 |
| POST | `/api/trial/apply` | JWT | 啟用試用 |
| GET | `/api/trial/status` | JWT | 試用狀態 |

### 回應格式

每筆回應都包含 `_casca` 額外欄位：

```json
{
  "choices": [{ "message": { "content": "..." } }],
  "_casca": {
    "cx": "LOW",
    "model": "gpt-4o-mini",
    "cacheHit": false,
    "costUsd": 0.000025,
    "savingsPct": 97,
    "latencyMs": 12,
    "rule": "R1: 查詢/定義 → LOW",
    "lang": "EN",
    "billing": {
      "tokensCharged": 170,
      "isOverage": false
    }
  }
}
```

---

## 9. Zapier 整合

Casca 已上架 Zapier（審核中），讓你不寫程式就能用 AI。

### 連接

1. 在 Zapier 搜尋 **「Casca AI Route」**
2. 輸入你的 Casca API Key（`csk_...`）
3. 完成

### 可用功能

**Triggers（觸發器）**：
- New API Request — 有新請求時觸發
- New Annotation — 有新標注時觸發
- Usage Alert — 用量超標時觸發

**Actions（動作）**：
- AI Chat — 送 prompt 給 AI
- Summarize — 摘要文字
- Translate — 翻譯（13 種語言）
- Generate SOQL — 自然語言轉 Salesforce 查詢
- Extract Data — 從非結構化文字抽取資料
- Classify Text — 文字分類

**Search（搜尋）**：
- Find Usage Stats — 查用量

### 範例 Zap

```
Gmail 新郵件 → Casca Summarize → Slack 發摘要到頻道
```

---

## 10. Salesforce 整合

Casca 提供完整的 Salesforce Apex SDK。

### 安裝

1. 在 Salesforce Setup → Named Credential 建立 `Casca_API`
2. 部署 `CascaClient.cls` 到你的 org
3. 一行程式碼開始用

### 程式碼範例

```apex
// AI Chat
CascaClient.ChatResponse res = CascaClient.chat(
    'Summarize this case',
    'You are a helpful customer service agent.'
);
System.debug(res.content);

// SOQL Generation
String soql = CascaClient.generateSOQL(
    'Find all high-priority cases from last week',
    'Case, Account'
);

// Case Summary
String summary = CascaClient.summarizeCase(caseId);
```

### LWC 元件

- **AI Playground** — 在 Salesforce 裡測試 AI
- **Case Summary** — 一鍵摘要客服案件
- **Field Enrichment** — 翻譯、修正、摘要欄位

### PII 保護

Apex SDK 內建 PII Masking — email、電話、身分證號碼在離開 Salesforce 前自動遮蔽。

---

## 11. 企業自建版（Casca Vault）

適合需要資料不出境的企業客戶。

### 特色

- 完整運行在你的伺服器（Docker Compose 一鍵部署）
- 你的 Prompt 永遠不離開你的網路
- 支援完全斷網（離線授權）
- 自動 OTA 更新
- 專屬管理後台

### 最低需求

4 CPU · 8GB RAM · 50GB SSD · Docker

### 部署

```bash
cp .env.example .env
# 填入 License Key
docker compose up -d
```

5 分鐘部署完成。詳見 **Casca Vault 部署手冊**。

---

## 12. 常見問題 FAQ

### 整合

**Q: 需要改多少程式碼？**
A: 一行。把 `base_url` 改成 `https://api.cascaio.com/v1`，其他完全不改。

**Q: 回應格式跟 OpenAI 一樣嗎？**
A: 100% 相容。多一個 `_casca` 欄位告訴你路由決策，不影響原本的解析。

**Q: 可以指定用哪個模型嗎？**
A: 可以。`model` 設 `"auto"` 讓 Casca 自動選，或指定 `"gpt-4o"` 等強制使用。

### 品質

**Q: 會不會把複雜問題送到便宜模型？**
A: 機率極低（<5%）。即使發生，影響是回答品質不夠好，不會造成錯誤資料。Dashboard 的「品質保證」頁面顯示所有送到 HIGH 的請求，證明 Casca 重視品質。

**Q: 分類準確率多少？**
A: 三層架構（L1 規則 + L2 MiniLM + Calibrator）組合準確率 95%+。

**Q: 如果出問題可以馬上關掉嗎？**
A: 可以。把 `base_url` 改回 OpenAI 的就好。或在 Dashboard 啟用 Bypass 模式，60 秒生效。

### 安全

**Q: Casca 會看到我的 Prompt 嗎？**
A: Passthrough 模式：Prompt 經過 Casca 但不儲存（即用即丟）。api_logs 只記錄 token 數和分類結果，不記錄 Prompt 原文。

**Q: 我的 LLM Key 安全嗎？**
A: Passthrough 模式：你的 Key 在每次請求中帶入，Casca 用完即丟，不儲存在任何地方。

**Q: 有 SOC 2 嗎？**
A: 進行中，預計 Q3 完成。

### 計費

**Q: Token 怎麼算的？**
A: 以 LLM Provider 實際回報的 `usage.total_tokens` 為準，不是 Casca 估算的。

**Q: 試用到期後怎麼辦？**
A: Managed 模式降為 Free（每週額度重設）。Passthrough 模式維持 Free（10M/月）。不會突然斷線。

**Q: 可以同時用 Passthrough 和 Managed 嗎？**
A: 可以。同一個帳號，不同請求用不同模式，各自計費。

---

## 聯繫我們

- **官網**：https://cascaio.com
- **繁中版**：https://cascaio.com/tw
- **Email**：casca@vastitw.com
- **業務洽談**：sales@cascaio.com
- **Terminal 體驗**：https://cascaio.com/terminal

---

*Casca — AI 省錢，品質不打折。*
*© 2026 Vast Intelligence Limited*
