# Casca — System Architecture

> **Domain**: cascaio.com · **API**: api.cascaio.com · **Admin**: casca-admin.cascaio.com
> **Version**: v3.2 · Engine v2.6.2 · Path B enabled
> **Last updated**: 2026-04-14

---

## 1. Product Overview

**Casca** 是一套 AI LLM 智慧路由引擎 + API Proxy 聚合器。

根據 prompt 的**複雜度**（LOW / MED / HIGH）自動把請求路由到成本最適的 LLM，聲稱可降低 LLM 帳單 **30–60%**，同時維持品質 SLA。

**核心賣點**：
- **一行改動**：`base_url` 改為 `https://api.cascaio.com/v1`，Bearer token 帶 `csk_...`
- **三種模式**：客戶用自己的 LLM Key (passthrough) 或用 Casca 管理 Key (managed)
- **自我改善**：Path B 訓練管線讓分類精準度持續提升
- **全球語言**：classifier 支援 14 種語言（繁/簡中、英、日、法、德、西、義、韓、印地、阿、泰、越、印尼）

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          Client App                                   │
│         (OpenAI SDK with base_url = api.cascaio.com/v1)              │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  POST /api/v1/chat/completions
                                │  Authorization: Bearer csk_xxx
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│   Cloudflare Pages — cascaio.com (landing / dashboard / docs)        │
│   Cloudflare Workers Function — /api/* proxy → Railway server-v2     │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│   Railway — server-v2 (Express 5 ESM, Node.js 20+)                   │
│                                                                       │
│   1. requireApiKey / requireApiKeyOrJWT (SHA-256 hash lookup)        │
│   2. L1 Cache check (tenant_cache_pool) ──→ HIT: return 0 cost       │
│   3. Billing gate (quota + overage)                                  │
│   4. L1 Classifier (casca-classifier.cjs, 160 rules, 14 langs)       │
│   5. Path B — Dynamic Confidence + L2 MiniLM (if L1 conf < 80)       │
│   6. callLLM(provider, messages) → OpenAI/Anthropic/Google adapter   │
│   7. Response JSON with _casca metadata                              │
│   8. Async post-process:                                             │
│        • api_logs insert                                             │
│        • account_usage_and_deduct (billing RPC)                      │
│        • prompt_frequency_log + cache promotion                      │
│        • Path B training pipeline (PII mask → LLM Judge → training)  │
└───┬─────────────────────────────────┬─────────────────────┬──────────┘
    │                                 │                     │
    ▼                                 ▼                     ▼
┌─────────┐                   ┌──────────────┐     ┌────────────────┐
│ Supabase│                   │ Railway —    │     │ Railway — Redis│
│ Postgres│                   │ casca-minilm │     │ (async queue)  │
│ + Auth  │                   │ FastAPI      │     └────────────────┘
│ + RLS   │                   │ MiniLM-L6-v2 │
└─────────┘                   └──────────────┘
```

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Static HTML + Chart.js + Supabase JS SDK |
| API Gateway | Express 5 (ESM), Node.js 20+ |
| Classifier L1 | Pure JS CommonJS (`casca-classifier.cjs`), 160 regex rules |
| Classifier L2 | MiniLM-L6-v2 (PyTorch + Transformers) via FastAPI |
| Database | PostgreSQL 15 (Supabase) + Row-Level Security |
| Auth | Supabase Auth (Email/Password) + JWT |
| Cache | In-memory + `tenant_cache_pool` (Postgres) + Redis (optional) |
| Payments | Stripe Checkout + Webhooks |
| Email | Resend (via Supabase custom SMTP) |
| Metrics | prom-client (Prometheus) |
| CDN / DNS | Cloudflare Pages + Cloudflare Workers Functions |
| Container | Docker (MiniLM service) |

---

## 4. Infrastructure

### GitHub Repos

| Repo | Purpose |
|---|---|
| `jewanchen/casca` | **主專案**：server-v2.js, classifier, landing, dashboard, MiniLM service |
| `jewanchen/casca-admin` | Admin 後台（private，`casca-admin.cascaio.com`） |

### Railway Services (project: casca)

| Service | Source | Purpose |
|---|---|---|
| **server-v2** | `jewanchen/casca` root | Express API gateway, `api.cascaio.com` |
| **casca-minilm** | `jewanchen/casca/casca-minilm` | MiniLM L2 classifier (internal only) |
| **Redis** | Railway addon | Async postProcess queue |

Internal networking：
```
server-v2 ──HTTP──→ http://loyal-illumination.railway.internal:8000 (casca-minilm)
server-v2 ──Redis──→ redis://...railway.internal:6379
```

### Supabase (project: casca-V2, id: azxutenowfoamphdjwya)

- PostgreSQL + pgcrypto + uuid-ossp
- Auth: Email/password with verification
- Custom SMTP via Resend (`smtp.resend.com:465`)
- RLS enabled on all public tables
- Service key 用於 server-v2 繞過 RLS

### Cloudflare

- **Domain**: cascaio.com（DNS + SSL）
- **Pages**: `cascaio.com` 主站 + `casca-admin.cascaio.com`
- **Email Routing**: 收信（`smartroute@cascaio.com` 等）
- **Workers Function**: `functions/api/[[path]].js` proxy → Railway

### Third-party

- **OpenAI** / **Anthropic** / **Google AI** — LLM providers
- **Stripe** — billing (訂閱 + 儲值)
- **Resend** — transactional email (`noreply@cascaio.com`)

---

## 5. Request Flow (Serving Path)

```
Client POST /api/v1/chat/completions
│
├─ 1. requireApiKey
│     • Parse Bearer token → detect key stage
│     • csk_...     → managed mode (SHA-256 lookup in clients/api_keys)
│     • sk-...      → passthrough OpenAI
│     • sk-ant-...  → passthrough Anthropic
│     • AIza...     → passthrough Google
│
├─ 2. L1 Cache check
│     SELECT * FROM tenant_cache_pool WHERE client_id=? AND prompt_hash=?
│     HIT → return cached response, cost=0, post-process async
│     MISS ↓
│
├─ 3. Billing gate (managed only)
│     if cycle_used_tokens ≥ plan.included_m_tokens × 1M
│        && balance_credits < min_overage
│        → 402 Payment Required
│
├─ 4. Attachment context injection
│     Vision/file parts → inject modal tag ([photo:...], [x-ray:...])
│
├─ 5. L1 Classifier
│     cascaRoute(prompt, uc, qualityTier, context)
│     → { cx: HIGH|MED|LOW|AMBIG, rule, confidence, lang, modal, model }
│
├─ 6. Path B override (if enabled)
│     dynConf = static_confidence × rule_accuracy_rate
│     if dynConf < THRESHOLD (80):
│         l2 = predictMiniLM(prompt)  ← 5-15ms
│         if l2: cx = l2.label
│
├─ 7. Intent override (for attachments)
│     debug/security/financial-analysis intent → force HIGH
│
├─ 8. Provider selection
│     managed: exact model → tier → ANY → upgrade chain
│     passthrough: map cx → compatible model for client's provider
│
├─ 9. callLLM(provider, messages)
│     OpenAI/Anthropic/Google adapter with timeout + abort signal
│
├─ 10. Response
│      Inject _casca metadata: cx, model, cacheHit, costUsd, savingsPct,
│                              latencyMs, rule, billing
│      res.json(payload)
│
└─ 11. Async post-process (enqueuePostProcess)
       • api_logs insert
       • Redis queue if available, sync otherwise
       • account_usage_and_deduct (billing RPC)
       • prompt_frequency_log + should_promote_to_cache
       • if promoted: upsert tenant_cache_pool
       • Path B: runTrainingPipeline(...) [independent, see §7]
```

---

## 6. Database Schema (Supabase)

### Core Tables

| Table | Purpose |
|---|---|
| `clients` | 客戶帳號 + 計費狀態 + `path_b_judge_enabled` flag |
| `api_keys` | 多 API Key per client (SHA-256 hashed) |
| `llm_providers` | Admin 管理的 LLM 清單 (adapter, cost, tier) |
| `api_logs` | 每筆請求紀錄（prompt_preview REDACTED） |
| `tenant_cache_pool` | L1 cache (per-tenant) with hit_count + savings |
| `prompt_frequency_log` | 頻率計數 → cache promotion trigger |
| `annotation_queue` | AMBIG 案例人工標注（舊 Path A） |
| `subscription_plans` | Stripe plan 定義 |
| `transactions` | Stripe 交易紀錄 |
| `client_llm_keys` | 客戶自帶 LLM Key（passthrough mode） |

### Path B Tables

| Table | Purpose |
|---|---|
| `training_samples` | 每筆請求的 L1 / L2 / LLM Judge 三方比對 |
| `rule_accuracy_stats` | per-rule 正確率統計（dynamic confidence 來源） |
| `minilm_versions` | MiniLM 訓練版本紀錄 |

### Key RPC Functions

| Function | Purpose |
|---|---|
| `handle_new_user()` | Trigger: auth.users insert → upsert clients |
| `gen_client_api_key()` | Trigger: generate csk_ key + SHA-256 hash |
| `account_usage_and_deduct()` | 每次 LLM call 後扣 token + 超額餘額 |
| `record_cache_hit()` / `should_promote_to_cache()` | Cache 邏輯 |
| `upsert_rule_accuracy()` | Path B: 更新 rule_accuracy_stats |
| `get_rule_accuracy()` | Path B: 查詢某 rule 正確率 |
| `expire_trials()` / `extend_trial()` | 試用期管理 |
| `topup_balance()` / `reset_billing_cycle()` | Stripe webhook RPC |

### SQL Migrations

```
casca-schema-v2.sql                  → 7 核心表 + 5 函式
casca-migration-v2-to-v3.sql         → subscription + billing + trial
casca-schema-v5-client-keys.sql      → client_llm_keys + routing_mode
casca-schema-path-b.sql              → Path B 3 表 + 2 函式
casca-schema-path-b-client-flag.sql  → clients.path_b_judge_enabled
```

---

## 7. Path B — Self-Improving Classification

### 設計原則

1. **L1 快（0.5ms）、L2 準（~10ms）、LLM Judge 出真相**
2. **Serving path 不等 Judge** — 訓練管線完全 async
3. **L1 用 dynamic confidence 自動浮動** — 判錯多了，下次就讓 L2 接手
4. **每個客戶可獨立開關 LLM Judge** — 節省成本

### 三層推理

```
Prompt
  │
  ▼
L1 Classifier (casca-classifier.cjs, 0.5ms)
  │  → { cx, rule, static_confidence }
  │
  ▼
Dynamic Confidence
  dyn_conf = static_conf × rule_accuracy_rate(rule)
  │
  ├─ dyn_conf ≥ 80  → 用 L1
  └─ dyn_conf < 80  → L2 MiniLM (~10ms)
                          │
                          ▼
                     If success: use L2 result
                     If service down: fallback to L1
```

### 訓練管線 (async, per request)

```
(after res.json())
  │
  ├─ 1. PII mask (email/phone/CC/SSN/Taiwan-ID/IP)
  │
  ├─ 2. LLM Judge (GPT-4o-mini, ~500ms)
  │        System prompt: classify into HIGH/MED/LOW
  │
  ├─ 3. Write training_samples:
  │        { prompt_masked, l1_label, l1_rule, l1_conf,
  │          l2_label, judge_label, l1_correct, l2_correct,
  │          serving_label, serving_correct, lang, client_id }
  │
  └─ 4. upsert_rule_accuracy(rule, l1_correct)
           → rule_accuracy_stats table
           → next request: dynamic confidence self-adjusts
```

### MiniLM Service (`casca-minilm/`)

| Endpoint | Purpose |
|---|---|
| `POST /predict` | Inference: { prompt } → { label, confidence, probabilities } |
| `POST /train/trigger` | Incremental fine-tune on untrained training_samples |
| `POST /train/import` | Upload JSONL → train new version |
| `POST /train/cold-start` | Fine-tune from `data/train.jsonl` (485 seed) |
| `GET /model/status` | Active version + training state |
| `GET /report/rule-health` | Rule health stats |
| `GET /health` | Health check |

### Rule Health States

| Accuracy Rate | Status | Effect |
|---|---|---|
| `< 0.70` | **BROKEN** | Dynamic conf ≪ threshold → L2 always takes over |
| `0.70 – 0.85` | **DEGRADING** | Often falls back to L2 |
| `≥ 0.85` | **HEALTHY** | L1 confidence stays high |
| `< 10 samples` | **NEW** | Use static confidence (no data yet) |

---

## 8. Server Source Layout

```
server-v2.js (~2900 lines)
├── Config + Prometheus metrics
├── Supabase / Stripe / Redis clients
├── Provider registry (loadProviders + hot reload)
├── Utilities (sha256, normalizePrompt, cacheExpiry)
├── Attachment context injection (Vision/file → modal tag)
├── Auth middleware
│    • requireApiKey         (csk_ + passthrough sk-/sk-ant-/AIza)
│    • requireSupabaseJWT    (Supabase JWT only)
│    • requireApiKeyOrJWT    (either — for dashboard endpoints)
│    • requireAdmin          (x-admin-secret header)
├── Billing gate + LLM call adapter
├── Async post-process + Redis worker
├── Endpoints:
│    • POST /api/v1/chat/completions       ← core
│    • POST /api/route                      ← legacy alias
│    • POST /api/auth/register              ← signUp flow
│    • POST /api/trial/apply
│    • GET  /api/trial/status
│    • /api/zapier/*                        ← Zapier integration
│    • /api/dashboard/me|keys|logs|cache    ← client dashboard
│    • /api/billing/subscribe|topup|webhook ← Stripe
│    • /api/admin/*                         ← admin CRUD
│    • /api/admin/pathb/*                   ← Path B (mismatches, stats,
│                                            minilm, upload, clients)
└── Boot: loadProviders + initRedis + loadRuleAccuracyCache + scheduleTrialExpiry

casca-path-b.js (~360 lines)
├── piiMask(text)
├── llmJudge(prompt, providerRegistry, model)
├── loadRuleAccuracyCache(supabase)
├── getDynamicConfidence(rule, staticConf, supabase)
├── predictMiniLM(prompt)                   ← calls FastAPI service
└── runTrainingPipeline(...)                ← async orchestration

casca-classifier.cjs (~2800 lines, CommonJS UMD)
├── 14 language detection + preprocessing pipelines
├── 160 regex rules across tiers LOW/MED/HIGH/AMBIG
├── Modal detection (video/image/chart/doc/medical/legal)
├── Conversation mode detection (15 modes)
├── AMBIG resolution via context + noise type
└── Exports: route(), classify(), detectLanguage(), setConfig()
```

---

## 9. Frontend Pages

### Public (cascaio.com)

| URL | File | Purpose |
|---|---|---|
| `/` | `index.html` | Landing (English) |
| `/tw` | `tw.html` | Landing (Traditional Chinese) |
| `/dashboard` | `casca-dashboard.html` | Client portal (login, keys, logs, cache, playground) |
| `/admin` | `casca-admin.html` | Admin (redirects to casca-admin.cascaio.com) |
| `/terminal` | `terminal.html` | Interactive Playground |
| `/annotator` | `casca-annotator.html` | Path A 人工標注工具 |
| `/reset-password` | `reset-password.html` | 密碼重設頁 |

### Admin (casca-admin.cascaio.com)

Single-page app (`index.html`). Sidebar sections:

| Section | Pages |
|---|---|
| Overview | Cockpit (MRR, customers, requests) |
| Customers | All Customers, Billing |
| Intelligence | Annotations, Training Data |
| Config | System, LLM Providers, API Keys |
| **Path B** | Training Pipeline (Mismatches / MiniLM / Upload / Client Control) |

### Path B Admin UI

| Sub-tab | Features |
|---|---|
| **L1 vs LLM 差異** | 篩選語言/規則，分頁瀏覽，時間排序 |
| **MiniLM 狀態** | Service online/offline, 版本清單, 觸發訓練, Cold Start |
| **批量上傳** | Drag-drop JSONL, 預覽分布, 確認訓練 |
| **客戶學習控制** | Per-client toggle for LLM Judge |

---

## 10. Environment Variables

### Railway: server-v2

```
# Supabase
SUPABASE_URL=https://azxutenowfoamphdjwya.supabase.co
SUPABASE_SERVICE_KEY=...
SUPABASE_ANON_KEY=...

# Admin
ADMIN_SECRET=...

# Server
PORT=3001
CORS_ORIGIN=https://cascaio.com,https://www.cascaio.com,https://casca-admin.cascaio.com
FRONTEND_URL=https://cascaio.com

# LLM proxy
LLM_TIMEOUT_MS=30000

# Cache
CACHE_PROMOTE_THRESHOLD=3
CACHE_PROMOTE_WINDOW_H=24
CACHE_TTL_DAYS=7

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Redis (optional — enables async postProcess)
REDIS_URL=redis://...railway.internal:6379

# Path B
PATH_B_ENABLED=true
PATH_B_JUDGE_MODEL=gpt-4o-mini
PATH_B_SAMPLE_RATE=1.0
PATH_B_CONFIDENCE_THRESHOLD=80
MINILM_SERVICE_URL=http://loyal-illumination.railway.internal:8000
```

### Railway: casca-minilm

```
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...
PORT=8000
MODEL_NAME=sentence-transformers/all-MiniLM-L6-v2
NUM_LABELS=3
```

---

## 11. Deployment Workflow

### Frontend (Cloudflare Pages)

```
Push to jewanchen/casca (main) or jewanchen/casca-admin (main)
  ↓
Cloudflare Pages auto-build
  ↓
Deploy to cascaio.com / casca-admin.cascaio.com (~30-60s)
```

### Backend (Railway)

```
Push to jewanchen/casca (main)
  ↓
Railway auto-build per service:
  • server-v2           (Nixpacks, npm start)
  • casca-minilm         (Dockerfile, uvicorn)
  ↓
Rolling restart (~1-2 min)
```

### Database Migration

Manual via Supabase SQL Editor:
```
1. casca-schema-v2.sql           (one-time, done)
2. casca-migration-v2-to-v3.sql  (one-time, done)
3. casca-schema-v5-client-keys.sql (one-time, done)
4. casca-schema-path-b.sql        (one-time, done)
5. casca-schema-path-b-client-flag.sql (one-time, done)
```

---

## 12. Billing Model

### Modes (detected from API key prefix)

| Mode | Key prefix | LLM cost | Casca cost |
|---|---|---|---|
| **Managed** (Stage 3) | `csk_...` | Paid by Casca | Token-based via subscription + overage |
| **Passthrough OpenAI** | `sk-...` | Paid by client | Classification fee only |
| **Passthrough Anthropic** | `sk-ant-...` | Paid by client | Classification fee only |
| **Passthrough Google** | `AIza...` | Paid by client | Classification fee only |

### Plans

- **Free / Trial** — 30-day, 1M tokens included
- **Paid** (defined in `subscription_plans`): monthly fee + included tokens + overage rate per 1M
- **Top-up**: $5–$10,000 one-time credit for overage coverage

### Stripe Flow

```
/api/billing/subscribe → Stripe Checkout Session (mode: subscription)
/api/billing/topup     → Stripe Checkout Session (mode: payment)
Webhook → Supabase RPC:
  • checkout.session.completed + type=topup → topup_balance()
  • checkout.session.completed + type=subscription → update stripe_sub_id
  • invoice.paid → reset_billing_cycle()
  • customer.subscription.deleted → downgrade to Free
```

---

## 13. Integrations

### Zapier (published app v1.0.2)

- **3 triggers**: newApiLog, newAnnotation, usageAlert
- **6 actions**: aiChat, summarize, translate, classifyText, extractData, generateSoql
- **1 search**: findUsage
- Endpoints under `/api/zapier/*`

### Salesforce Apex SDK (AppExchange-ready)

- `CascaClient.cls` — chat / SOQL-gen / summarizeCase / enrichField
- `CascaAsync.cls` — Queueable for trigger/batch
- `CascaFlowActions.cls` — Flow Builder invocable
- `CascaPiiMasker.cls` — Apex-side PII masking
- `CascaLwcController.cls` + 3 LWC components (Playground, CaseSummary, FieldEnrich)

---

## 14. Observability

### Prometheus Metrics

Exposed at `/metrics` (protected by `x-admin-secret`):

- `casca_requests_total{cx,lang,model,is_cache,stage}`
- `casca_request_duration_ms{cx,lang,stage}` (histogram)
- `casca_cost_usd_total{cx,model}`
- `casca_tokens_total{direction,model}`
- `casca_cache_hits_total`
- `casca_savings_usd_total{cx}`
- `casca_ambig_resolutions_total{lang}`
- `casca_quota_exhausted_total{plan_id}`
- `casca_llm_errors_total{model,status_code}`
- `casca_active_providers`

### Logs

- Railway service logs per deploy
- Supabase Auth logs (signup, login, email errors)
- api_logs table (每筆請求的 cx/model/tokens/cost/latency/status)

---

## 15. Known Path B TODOs

(Maintained in `memory/casca_pathb_todo.md`)

- Path B Dashboard 總覽面板（L1/L2/serving accuracy 整合圖）
- L1 Rule Health 詳細表格（per-rule accuracy/status/sample trends）
- LLM Judge 呼叫統計（每日成本、per-client 圖表）
- 規則建議自動產生（根據 mismatch pattern 產出 regex 候選）

---

## 16. Security Notes

- **API keys** stored as SHA-256 hash only (raw key shown once to user)
- **PII masking** before any data leaves the org (client-side Apex + server-side `piiMask()`)
- **prompt_preview** in `api_logs` is always `[REDACTED]` — never store raw prompts unmasked
- **Training samples** use PII-masked prompts only
- **RLS** on all tenant data (`clients`, `api_logs`, `tenant_cache_pool`, `transactions`, `api_keys`)
- **Service role key** only used server-side (never exposed to client)
- **CSP headers** + **X-Frame-Options: DENY** on all frontend pages
- **Zero data retention** promise: no response caching across tenants; opt-in shared semantic cache only

---

## Appendix: File Inventory

```
casca/
├── ARCHITECTURE.md           ← this file
├── README.md
├── MIGRATION-GUIDE.md
├── .env.example
│
├── server-v2.js              ← Express API gateway
├── casca-path-b.js           ← Path B training pipeline
├── casca-classifier.cjs      ← L1 classifier engine v2.6.2
├── package.json
│
├── index.html                ← Landing (EN)
├── tw.html                   ← Landing (ZH-TW)
├── casca-dashboard.html
├── casca-annotator.html
├── casca-api-docs.html
├── terminal.html
├── reset-password.html
│
├── casca-schema-v2.sql
├── casca-migration-v2-to-v3.sql
├── casca-schema-v5-client-keys.sql
├── casca-schema-path-b.sql
├── casca-schema-path-b-client-flag.sql
│
├── functions/                ← Cloudflare Pages Workers
│   ├── api/[[path]].js       ← API proxy to Railway
│   └── health.js
│
├── casca-minilm/             ← MiniLM Python service
│   ├── app.py                ← FastAPI
│   ├── Dockerfile
│   ├── railway.toml
│   ├── requirements.txt
│   ├── model/
│   │   ├── serve.py          ← inference
│   │   ├── train.py          ← fine-tune
│   │   └── checkpoints/
│   └── data/
│       ├── train.jsonl       ← 386 samples
│       ├── val.jsonl         ← 59 samples
│       └── test.jsonl        ← 40 samples
│
├── casca-zapier/             ← Zapier integration
│   ├── index.js
│   ├── authentication.js
│   ├── actions/   (6 files)
│   ├── triggers/  (3 files)
│   └── searches/  (1 file)
│
└── _headers, _redirects, netlify.toml, robots.txt, sitemap.xml
```
