# Casca v2.1 — AI Routing Engine + API Proxy Aggregator
> cascaio.com · github.com/jewanchen/casca

## Stack

| Layer | Service |
|-------|---------|
| Frontend | **Netlify** — `index.html` (landing), `casca-admin.html`, `casca-dashboard.html` |
| Backend | **Railway** — `server-v2.js` (Express 4) |
| Database | **Supabase** — PostgreSQL + Auth + RLS |
| Domain | `cascaio.com` (landing), `api.cascaio.com` (API proxy via Railway) |
| Payments | **Stripe** (Phase 2) |
| Classifier | `casca-classifier.js` v2.2.0 — 97 rules · 3,509 samples · 11 languages |

## 架構總覽

```
Client App
    │
    ▼  POST /api/v1/chat/completions  (OpenAI-compatible)
┌─────────────────────────────────────────────────────┐
│  Casca API Gateway  (server-v2.js · Express 4 ESM)  │
│                                                     │
│  1. API Key Auth  ────────────────── clients table  │
│  2. L1 Cache Hit? ──────── tenant_cache_pool table  │
│         │ HIT → return instantly (0ms, $0.00)       │
│         │ MISS ↓                                    │
│  3. Casca Classify ──────── casca-classifier.js     │
│         │ cx = LOW / MED / HIGH                     │
│  4. Route to LLM ─────────── llm_providers table    │
│         │ Adapter: openai / anthropic / google      │
│         │ fetch() → provider endpoint               │
│  5. Return to client                                │
│  6. Async post-process (background):                │
│       • api_logs insert                             │
│       • deduct_credits (balance)                    │
│       • annotation_queue (if AMBIG)                 │
│       • prompt_frequency_log                        │
│       • cache promotion (if freq ≥ 3 / 24h)        │
└─────────────────────────────────────────────────────┘
         │
    Supabase (PostgreSQL + Auth + RLS)
```

## 檔案說明

| 檔案 | 用途 |
|------|------|
| `casca-classifier.js` | 核心分類引擎 v2.2.0 (Pure ESM, 97 rules, 11 langs) |
| `casca-schema-v2.sql` | Supabase DB schema (7 張表 + 5 個 DB 函式) |
| `server-v2.js` | Express API Gateway (adapter-aware LLM proxy) |
| `casca-dashboard.html` | 客戶 Portal (Auth + Keys + Playground + Logs + Cache) |
| `casca-admin.html` | 管理後台 (Supabase Auth + Customers CRUD + LLM Providers + Annotations) |
| `index.html` | Landing page (cascaio.com) |
| `netlify.toml` | Netlify 設定 (API proxy + SPA fallback + CSP headers) |
| `package.json` | Node.js 依賴 (v2.1.0, Express 4) |
| `.env.example` | 環境變數模板 |

## 部署步驟

### 1. Supabase 設定

在 Supabase Dashboard → SQL Editor，貼上並執行 `casca-schema-v2.sql`。

執行後確認以下表格存在：
- `clients`, `api_keys`, `api_logs`, `annotation_queue`
- `llm_providers` (已含 7 個 seed 模型，含 adapter 欄位)
- `tenant_cache_pool`, `prompt_frequency_log`

設定第一位 Admin：
```sql
UPDATE public.clients SET is_admin = TRUE WHERE email = 'your-admin@vastitw.com';
```

### 2. Railway 後端

```bash
npm install
cp .env.example .env
# 編輯 .env，填入 SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET
# CORS_ORIGIN 設為你的前端 domain（逗號分隔多個）

npm run dev   # 開發
npm start     # 生產
```

### 3. Netlify 前端

將以下檔案放在 repo 根目錄，push 到 GitHub，Netlify 會自動部署：
```
├── netlify.toml        ← API proxy /api/* → api.cascaio.com
├── index.html          ← Landing (/)
├── casca-admin.html    ← Admin (/admin)
├── casca-dashboard.html← Dashboard (/dashboard)
├── casca-classifier.js ← 分類引擎
```

### 4. DNS 設定

| 記錄 | 值 | 用途 |
|------|-----|------|
| `cascaio.com` → Netlify | — | Landing + Admin + Dashboard |
| `api.cascaio.com` → Railway | CNAME | API Gateway |

## API 端點

### 客戶端

| Method | Path | Auth | 說明 |
|--------|------|------|------|
| POST | `/api/v1/chat/completions` | API Key | 主代理端點 (OpenAI 相容) |
| POST | `/api/route` | API Key | 向後相容 alias |
| GET  | `/api/dashboard/me` | API Key | 帳戶資訊 |
| GET  | `/api/dashboard/keys` | API Key | 列出 API Keys |
| POST | `/api/dashboard/keys` | API Key | 生成新 Key |
| GET  | `/api/dashboard/logs` | API Key | 使用紀錄 |
| GET  | `/api/dashboard/cache` | API Key | 快取池清單 |
| DELETE | `/api/dashboard/cache/:id` | API Key | 清除單筆快取 |
| DELETE | `/api/dashboard/cache` | API Key | 清除全部快取 |
| GET  | `/health` | — | 健康檢查 |

### 管理端 (Supabase JWT + is_admin=true，或 x-admin-secret header)

| Method | Path | 說明 |
|--------|------|------|
| GET    | `/api/admin/providers` | 列出所有 LLM Provider |
| POST   | `/api/admin/providers` | 新增 Provider (自動熱載入) |
| PATCH  | `/api/admin/providers/:id` | 更新 Provider |
| POST   | `/api/admin/reload-providers` | 手動熱載入引擎 |
| GET    | `/api/admin/customers` | 列出所有客戶 (含 30d 統計) |
| POST   | `/api/admin/customers` | 新增客戶 (建立 Supabase Auth user) |
| PATCH  | `/api/admin/customers/:id` | 更新客戶資料 |
| GET    | `/api/admin/queue` | 待標注 AMBIG 案例 |
| POST   | `/api/admin/annotate` | 寫入人工標注 |
| GET    | `/api/admin/export` | 匯出訓練資料 CSV |
| GET    | `/api/admin/stats` | 系統全域統計 |

## LLM Provider Adapters

`llm_providers.adapter` 欄位決定 `callLLM()` 如何呼叫該 provider：

| Adapter | 端點 | Auth 方式 | Body 格式 |
|---------|------|-----------|-----------|
| `openai` | `{base_url}/chat/completions` | `Authorization: Bearer` | OpenAI standard |
| `anthropic` | `{base_url}/messages` | `x-api-key` + `anthropic-version` | Anthropic Messages API (system 獨立) |
| `google` | `{base_url}/chat/completions?key=` | API key as query param | OpenAI-compat shim |

Anthropic 回應會自動轉換為 OpenAI 格式再回傳給客戶端。

## 環境變數說明

| 變數 | 必填 | 說明 |
|------|------|------|
| `SUPABASE_URL` | ✅ | Supabase 專案 URL |
| `SUPABASE_SERVICE_KEY` | ✅ | service_role 密鑰（繞過 RLS） |
| `ADMIN_SECRET` | ✅ | CLI/script 用的 admin 密鑰 |
| `PORT` | | 監聽埠，預設 3001 |
| `CORS_ORIGIN` | | 逗號分隔 origin 白名單，預設 `*` |
| `LLM_TIMEOUT_MS` | | LLM 超時毫秒，預設 30000 |
| `CACHE_PROMOTE_THRESHOLD` | | 晉升門檻次數，預設 3 |
| `CACHE_PROMOTE_WINDOW_H` | | 晉升視窗小時，預設 24 |
| `CACHE_TTL_DAYS` | | 快取有效天數，0=永不過期，預設 7 |

## v2.0 → v2.1 修改摘要

| # | 問題 | 修復 |
|---|------|------|
| 1 | SQL: `api_logs` FK 引用尚未建立的 `llm_providers` | 調整建表順序 |
| 2 | SQL: `api_keys` 表不存在 | 新增表 + RLS |
| 3 | Server: `requireAdmin` 只支援靜態 secret | 新增 Supabase JWT + is_admin 驗證 |
| 4 | Server: 缺少 `/api/admin/customers` | 新增 GET + POST + PATCH |
| 5 | Server: Anthropic 呼叫 `/chat/completions` → 404 | 新增 adapter 機制 (openai/anthropic/google) |
| 6 | Server: `app._router.handle()` (Express 5 內部 API) | 抽取 `handleChatCompletions()` 共用 |
| 7 | Server: `balance_credits` 只記不扣 | 新增 `deduct_credits()` 呼叫 |
| 8 | Express 5.0.1 (beta) | 降級至 Express 4.21.0 (stable) |
| 9 | CORS: 單一 origin 字串 | 支援逗號分隔多 origin |
| 10 | Admin Portal: `prompt()` auth | Supabase Auth 登入覆蓋層 |
