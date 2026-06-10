# Casca — System Architecture

> **Domain**: cascaio.com · **API**: api.cascaio.com · **Admin**: casca-admin.cascaio.com
> **Version**: v3.2 · Engine v2.6.2 · Path B enabled
> **Last updated**: 2026-06-09

---

## 1. Product Overview

**Casca** = AI Routing Infrastructure for Salesforce + 通用 LLM 路由 API。

根據 prompt 的**複雜度**（LOW / MED / HIGH）自動把請求路由到成本最適的 LLM，**實際省下多少由客戶 Dashboard per-request 算給看**（不做 unverifiable 百分比 claim — 見 [[decisions/2026-06-04_brand-positioning]] §3 honesty rule）。

**核心賣點**：
- **一行改動**：`base_url` 改為 `https://api.cascaio.com/v1`，Bearer token 帶 `csk_...`
- **三種模式**：客戶用自己的 LLM Key (passthrough) 或用 Casca 管理 Key (managed)
- **自我改善**：Path B 訓練管線讓分類精準度持續提升
- **全球語言**：classifier 支援 14 種語言（繁/簡中、英、日、法、德、西、義、韓、印地、阿、泰、越、印尼）
- **不被 LLM 廠商鎖住**：Named Credential URL 一行改動即可切換 OpenAI / Anthropic / Google

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
│ + RLS   │                   │ L12 fine-tune│
└─────────┘                   │ (L6 base)    │
                              └──────────────┘
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
| `jewanchen/casca-apex-sdk` | **Salesforce Apex SDK**：6 Apex class + 3 LWC（AppExchange Managed Package 來源）|
| `jewanchen/casca-appexchange` | **AppExchange 提交 repo**：mirror prod 後端 + 送審 docs + listing copy + 視覺資產（auto-sync via [[decisions/2026-05-29_appex_sync-workflow]]）|
| `jewanchen/casca-zapier` | Zapier integration v1.0.2（published） |

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

### Cloudflare / Netlify

- **Domain**: cascaio.com（DNS + SSL via Cloudflare）
- **Static hosting**: **Netlify** (current — `netlify.toml` + `_redirects` at prod repo root); legacy Cloudflare Pages config (`functions/`) remains in repo for reference
- **Email Routing**: 收信（`smartroute@cascaio.com` 等，Cloudflare Email Routing）
- **API proxy**: Netlify `_redirects` proxies `/api/*` → Railway server-v2

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
| `leads` | Landing page lead capture（增 2026-05-26）|

### Path B Tables

| Table | Purpose |
|---|---|
| `training_samples` | 每筆請求的 L1 / L2 / LLM Judge 三方比對 |
| `rule_accuracy_stats` | per-rule 正確率統計（dynamic confidence 來源） |
| `minilm_versions` | MiniLM 訓練版本紀錄 |

### Multi-turn Tables (新增 2026-05 — 對應 [[invariants]] I-4 contextFloor 邏輯)

| Table | Purpose |
|---|---|
| `conversations` / `conversation_turns` | Server-side conversation state（opt-in），追蹤 lastTier、convMode |

### Billing v2 (新增 2026-05)

| Function | Purpose |
|---|---|
| `reset_weekly_credits()` | Free 方案每週額度重設 |
| `check_and_deduct_weekly_credit()` | 週額度扣減（per-request RPC）|

### Enterprise Tables (新增 2026-05 — Casca Vault 自建版)

| Table | Purpose |
|---|---|
| `enterprise_licenses` | 自建版授權 key 管理 |
| `enterprise_deployments` | 客戶端 deployment 狀態 + heartbeat |
| `enterprise_usage` | 自建版用量回報 |
| `enterprise_audit` | 自建版 audit log |
| `enterprise_releases` | OTA update 版本管理 |

### AppExchange Sync (新增 2026-05-29 — [[decisions/2026-05-29_appex_sync-workflow]])

| Table | Purpose |
|---|---|
| `appex_sync_commits` | Prod → casca-appexchange repo 同步紀錄；admin gate 在這 UI 操作 |

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

### SQL Migrations (applied order)

```
casca-schema-v2.sql                       → 7 核心表 + 5 函式
casca-migration-v2-to-v3.sql              → subscription + billing + trial
casca-schema-v5-client-keys.sql           → client_llm_keys + routing_mode
casca-schema-path-b.sql                   → Path B 3 表 + 2 函式
casca-schema-path-b-client-flag.sql       → clients.path_b_judge_enabled
casca-schema-billing-v2.sql               → 週額度 RPC (reset_weekly_credits + check_and_deduct)
casca-schema-enterprise.sql               → Casca Vault 5 表 + 2 函式
casca-schema-leads.sql                    → leads 表（landing capture）
casca-schema-multi-turn.sql               → conversations / conversation_turns
casca-schema-pause.sql                    → pause_subscription / resume / archive RPC
casca-schema-2026-05-26-bugfixes.sql      → 5 endpoint bug fix (register / leads / plans schema / route alias / uuid)
casca-schema-2026-05-29-appex-sync.sql    → appex_sync_commits + RLS
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

- **Base model**: `microsoft/MiniLM-L6-H384-uncased`（fallback default）
- **Active fine-tune**: **MiniLM-L12-v2**（per [[domains/classifier]] §L2）— 訓練後跑 inference 用的版本
- **單 replica，CPU only**（Railway 8 vCPU 配額）

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
server-v2.js (~4,567 lines as of 2026-06-05)
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
│    • POST /api/classify                   ← real-routing cx (no LLM call, ~50ms p50)
│                                            via computeClassificationBaselines helper
│                                            (L1+L2+floor; ADR 2026-06-10)
│    • POST /api/auth/register              ← signUp flow
│    • POST /api/trial/apply
│    • GET  /api/trial/status
│    • /api/zapier/*                        ← Zapier integration (incl. zapier/classify)
│    • /api/dashboard/me|keys|logs|cache    ← client dashboard
│    • /api/billing/subscribe|topup|webhook ← Stripe
│    • /api/enterprise/*                    ← Casca Vault license + audit
│    • /api/admin/*                         ← admin CRUD
│    • /api/admin/pathb/*                   ← Path B (mismatches, stats,
│                                            minilm, upload, clients)
│    • /api/admin/appex/*                   ← AppExchange sync gate + webhook + callback
└── Boot: loadProviders + initRedis + loadRuleAccuracyCache + scheduleTrialExpiry
         + scheduleAppexDigest (weekly Mon 09:00 UTC)

casca-path-b.js (~412 lines)
├── piiMask(text)
├── llmJudge(prompt, providerRegistry, model)
├── loadRuleAccuracyCache(supabase)
├── getDynamicConfidence(rule, staticConf, supabase)
├── predictMiniLM(prompt)                   ← calls FastAPI service
└── runTrainingPipeline(...)                ← async orchestration

casca-classifier.cjs (~3,011 lines, CommonJS UMD)
├── 14 language detection + preprocessing pipelines
├── 160 regex rules across tiers LOW/MED/HIGH/AMBIG
├── Modal detection (video/image/chart/doc/medical/legal)
├── Conversation mode detection (15 modes)
├── AMBIG resolution via context + noise type
├── contextFloor multi-turn protection ([[invariants]] I-4)
└── Exports: route(), classify(), detectLanguage(), setConfig()

casca-enterprise-api.js
├── License key generation + verification
├── Heartbeat + usage reporting endpoints
├── OTA release management
└── Audit log writers
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
MODEL_NAME=microsoft/MiniLM-L6-H384-uncased   # base / fallback only (app.py:default)
ACTIVE_CHECKPOINT=v_L12_20260518_042247        # 實際載入的 fine-tune (read from minilm_versions.is_active)
NUM_LABELS=3
```

> `MODEL_NAME` 只在 ACTIVE_CHECKPOINT / minilm_versions.is_active 都讀不到時當 cold-start fallback。production serving 跑的是 L12 fine-tune（見 [[domains/classifier]] §L2）。

---

## 11. Deployment Workflow

### Frontend (Netlify)

```
Push to jewanchen/casca (main) or jewanchen/casca-admin (main)
  ↓
Netlify auto-build (per netlify.toml + _redirects)
  ↓
Deploy to cascaio.com / casca-admin.cascaio.com (~30-60s)
```

> 註：`functions/api/[[path]].js` (Cloudflare Pages Workers) 為 legacy 設定保留在 repo，當前不 active。API proxy 透過 Netlify `_redirects` 轉發到 Railway。

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
1.  casca-schema-v2.sql                       (one-time, done)
2.  casca-migration-v2-to-v3.sql              (one-time, done)
3.  casca-schema-v5-client-keys.sql           (one-time, done)
4.  casca-schema-path-b.sql                   (one-time, done)
5.  casca-schema-path-b-client-flag.sql       (one-time, done)
6.  casca-schema-billing-v2.sql               (one-time, done)
7.  casca-schema-enterprise.sql               (one-time, done)
8.  casca-schema-leads.sql                    (one-time, done)
9.  casca-schema-multi-turn.sql               (one-time, done)
10. casca-schema-pause.sql                    (one-time, done)
11. casca-schema-2026-05-26-bugfixes.sql      (2026-05-26)
12. casca-schema-2026-05-29-appex-sync.sql    (2026-05-29)
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

- Source: `jewanchen/casca-apex-sdk` repo (separate from prod `casca`)
- Submission artifact: `jewanchen/casca-appexchange` repo (auto-synced via [[decisions/2026-05-29_appex_sync-workflow]])
- Current submission status: see `C:\casca\casca-appexchange-target\STATUS.md`
- Brand positioning for AppExchange listing: [[decisions/2026-06-04_brand-positioning]]

Components:
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

## 15. Known TODOs / open status

(See current memory: `project_casca_minilm`, `project_classifier_todo`, `project_casca_l2_capacity`, `project_casca_endpoint_bugs`)

### Path B / Classifier （未完成）
- ⏳ Path B Dashboard 總覽面板（L1/L2/serving accuracy 整合圖）
- ⏳ L1 Rule Health 詳細表格（per-rule accuracy/status/sample trends）
- ⏳ LLM Judge 呼叫統計（每日成本、per-client 圖表）
- ⏳ 規則建議自動產生（根據 mismatch pattern 產出 regex 候選）
- ⏳ L1 R1/R4 token fallback fix（61.9% stress test accuracy — see `project_classifier_todo`）

### L2 / casca-minilm capacity 待修 — 仍未 land
| Priority | Item | Status |
|---|---|---|
| **P0** | server-v2 `/predict_batch` fetch 加 AbortController + timeout | ⏳ pending |
| **P0** | server-v2 對 minilm 加 circuit breaker（minilm 真掛掉 fail-fast）| ⏳ pending |
| P1 | `PATH_B_SAMPLE_RATE` 從 1.0 降到 0.05-0.1（量起來才痛） | ⏳ pending — gate: 客戶量 >50 時做 |
| P1 | casca-minilm 升 2-3 replicas + LB（避免單點故障）| ⏳ pending — gate: enterprise PoC 前必做 |

### L2 corpus augmentation — pre-condition done 2026-06-09
| Item | Status |
|---|---|
| Cold-start corpus augmentation (150 JSONL samples JA/AR/IT) | ✅ delivered 2026-06-09, awaiting Salesforce approval to trigger retrain. See memory `project_l2_retrain_pending`. |
| Target post-retrain accuracy | JA 72% → ≥85% · AR 74% → ≥85% · IT 88% → ≥92% |
| Files | `/c/casca/stress_test_results/lm_2026_06/augmentation_2026_06_{JA,AR,IT}.jsonl` |

### L1 HIGH-marker augmentation — pre-condition done 2026-06-09
| Item | Status |
|---|---|
| L1 keyword dictionary v2 (119 keywords for JA/AR/IT) | ✅ delivered 2026-06-09, 100% cross-check vs HIGH samples. See ADR `2026-06-08_l1-high-marker-augmentation.md`. |
| Implementation Wave 1 (5 new HIGH-COMP rules) | ⏳ pending until Salesforce approval. Contract `contracts/2026-06-08_l1-high-marker-augmentation.md` |
| Files | `/c/casca/stress_test_results/l1_keywords_2026_06.yml` |

> 容量重估（2026-05-26 thread fix 後）：理論 ~100-150 req/sec sustained，當前流量遠低於此，**死亡螺旋風險基本解除**。P0 仍要修為了 fail-fast 行為。

### Endpoint bugs 待修
5 個 pre-existing bug pending（per `project_casca_endpoint_bugs`）：
- ⏳ register flow / leads endpoint / plans schema / route alias / uuid validation

### Multi-turn continuity gap — RESOLVED 2026-05-28
- ✅ Server-layer safety-net contextFloor 已 ship（commit `33d938d`，per [[decisions/2026-05-27_classifier_serving-tier-floor]]）
- Floor policy：max-drop-1-tier (HIGH→MED)。嚴格 HIGH→HIGH 繼承明示拒絕
- 仍未處理（不在 α 範圍）：`conversationContext` opt-in fragility、L2 retrain 帶 tier history、`_casca.tierFloored` metadata、Railway logs 跨日觸發率觀察

---

## 16. Infra Migration Plan — Railway → Hetzner + R2

> Status: **P0** — triggered by 5-day Railway incident streak 2026-05-18→05-20 (4 separate incidents, 24+ hours of lost ship capability). See memory `project_infra_migration`.
>
> ⚠️ **未 executed**（截至 2026-06-05）。當前 prod 仍全部跑在 Railway。

### 為何 P0

單 provider 失效已驗證為實際風險（不是理論）。Railway 跑在 GCP 上 → Google 鎖 Railway 的 GCP 帳號 = Casca 100% blast radius。Migration 後 Hetzner（獨立 datacenter）+ R2（Cloudflare）= 獨立 failure domains。

### Target Architecture（migration 後）

| 元件 | 從 | 到 | 預期月費 |
|---|---|---|---|
| `server-v2` | Railway | 留 Railway 或遷 Fly.io | ~$5/mo (Fly.io) |
| `casca-minilm` | Railway | **Hetzner VPS CX22**（2vCPU/4GB，persistent disk）| €4.5/mo |
| Checkpoint storage | Supabase Storage (50MB cap，逼出 4-part split bug) | **Cloudflare R2** (free 10GB, no per-file limit) | free |
| DB | Supabase | Supabase（不動）| 不變 |
| Training | Colab | Colab（不動）| 不變 |

### Migration steps（執行時用）

1. Hetzner VPS provisioned, casca-minilm deployed（~2hr）
2. Cloudflare R2 set up, swap checkpoint upload/download paths（~half day）— 同時解掉 `storage.py` 4-part split bug
3. server-v2 `MINILM_SERVICE_URL` 切到 VPS（5min）
4. Verify `/predict`, `/model/status`, `/model/reload` round-trip（1hr）
5. Shut down Railway casca-minilm（1min）

預估 2 天 window（1 天執行 + 1 天 soak）。

### What blocks execution

排隊在 training items 之後（per `project_railway_backup_plan` §status，user 2026-05-20 priority：「等 railway 恢復，我要先把之前訓練的事搞定」）：
- Item #1 ✅ activate `v_L12_20260518_042247`（已 done）
- Item #2 ✅ multi-turn fix（commit `33d938d` done）
- Item #3 ⏳ L1 v2.6.3 improvement

---

## 17. Backup / Redundancy Plan — 三階段

> Status: **待排期** — 排在 Item #3 ship 之後啟動。See memory `project_railway_backup_plan`.
> 跟 §16 互補：§16 = 換 vendor（避開 Railway-specific 風險）；§17 = 加第二 vendor（撐住任何 single-vendor outage，包括 Hetzner 本身）

### Phase A（~1 個週末，+$0）

1. **R2 取代 Supabase Storage** for checkpoints — 跟 §16 migration step 2 重疊；做為 Phase A 把 storage 從 single-vendor decouple
2. **`C:\casca\DISASTER_RECOVERY.md`** 手寫 playbook：env vars 清單 + credentials cross-ref + 手動重建步驟（Railway → Fly.io / Hetzner）+ 每步 RTO + DNS cutover sequence
3. **Cloudflare Workers Function** 加 `BACKUP_BACKEND_URL` env var + primary→fallback retry logic 在 `functions/api/[[path]].js`（initial: undefined）

### Phase B（~1 週，+$5-10/mo）

1. **Fly.io warm spare for server-v2** — 同 GitHub repo 加 `fly.toml`，最小規格（shared-cpu-1x, 256MB），default stopped (~$0.15/mo storage only)，`fly machine start` ~10s 喚醒。同 Supabase URL，無需 DB duplication
2. **casca-minilm → Hetzner CX22**（per §16 migration）
3. **Activate Cloudflare Workers Function fallback** — `BACKUP_BACKEND_URL=https://casca.fly.dev`，monthly DR drill（手動 Railway pause → 量 RTO）

> MiniLM warm spare 不在 Phase B（L2 失效已 graceful-degrade 到 L1-only via `predictMiniLM` returns null — `casca-path-b.js:283-286`）。L2 redundancy = Phase C。

### Phase C（customer SLA 要求才做）

1. **Cloudflare Load Balancer** health-check 自動 Railway↔Fly.io failover（$5/mo, RTO ~60s）
2. **Second Hetzner VPS** for casca-minilm 不同 region（Falkenstein + Helsinki, +€4.5/mo）
3. **Provider failover strengthening** — 加 Anthropic + Google managed keys + priority ranking

### Cost trajectory

| Stage | Monthly cost |
|---|---|
| Today (Railway only) | $10-20 |
| Phase A done | +$0 |
| Phase B done | $20-30 |
| Phase C done | $35-50 |

### What stays SPOF after the plan

- Supabase（DB + Auth + Storage for non-checkpoint）— managed service 自有 redundancy，本計畫不處理
- Cloudflare（DNS + Pages + Workers）— 同上

如要 eliminate 這兩個，是另一個「data tier redundancy」計畫，不是現在的優先。

### Already-in-place graceful degradation

- L2 down → L1 only（`predictMiniLM` returns null）
- LLM provider down → other provider in registry（managed mode）
- Cache hit serves response even if backend brief issues

§17 plan **layers on top** these existing safeguards。

---

## 18. Security Notes

- **API keys** stored as SHA-256 hash only (raw key shown once to user)
- **PII masking** before any data leaves the org (client-side Apex + server-side `piiMask()`)
- **prompt_preview** in `api_logs` is always `[REDACTED]` — never store raw prompts unmasked
- **Training samples** use PII-masked prompts only
- **RLS** on all tenant data (`clients`, `api_logs`, `tenant_cache_pool`, `transactions`, `api_keys`)
- **Service role key** only used server-side (never exposed to client)
- **Frontend security headers** (Netlify `_headers`): CSP + X-Frame-Options: DENY + X-Content-Type-Options + Referrer-Policy + Permissions-Policy. Scope: `cascaio.com` static pages.
- **API security headers** (server-v2.js Express middleware, since 2026-06-08): `Strict-Transport-Security` + `X-Content-Type-Options: nosniff` + `X-Frame-Options: DENY` + `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; form-action 'none'`. Scope: `api.cascaio.com` JSON-only responses. `X-Powered-By` disabled.
  - ⚠️ Previously the doc claimed HSTS was auto-set by Cloudflare for api subdomain — 2026-06-08 ZAP scan disproved this; HSTS is now explicit in Express layer.
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
├── server-v2.js              ← Express API gateway (4,567 lines)
├── casca-path-b.js           ← Path B training pipeline (412 lines)
├── casca-classifier.cjs      ← L1 classifier engine v2.6.2 (3,011 lines)
├── casca-enterprise-api.js   ← Casca Vault license + audit endpoints
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
├── casca-schema-billing-v2.sql                  ← weekly credits RPC
├── casca-schema-enterprise.sql                  ← Casca Vault (5 tables + 2 funcs)
├── casca-schema-leads.sql                       ← landing capture
├── casca-schema-multi-turn.sql                  ← conversations + turns
├── casca-schema-pause.sql                       ← subscription pause RPC
├── casca-schema-2026-05-26-bugfixes.sql         ← 5 endpoint bug fixes
├── casca-schema-2026-05-29-appex-sync.sql       ← appex_sync_commits
│
├── functions/                ← (legacy Cloudflare Pages Workers)
│   ├── api/[[path]].js       ← legacy API proxy
│   └── health.js
│
├── casca-minilm/             ← MiniLM Python service
│   ├── app.py                ← FastAPI
│   ├── Dockerfile
│   ├── railway.toml
│   ├── requirements.txt
│   ├── storage.py            ← Supabase Storage checkpoint loader (2-format support)
│   ├── model/
│   │   ├── serve.py          ← inference
│   │   ├── train.py          ← fine-tune
│   │   └── checkpoints/
│   └── data/
│       ├── train.jsonl       ← cold-start seed (485 samples)
│       ├── val.jsonl
│       └── test.jsonl
│
├── casca-zapier/             ← Zapier integration v1.0.2 (published)
│   ├── index.js
│   ├── authentication.js
│   ├── actions/   (6 files)
│   ├── triggers/  (3 files)
│   └── searches/  (1 file)
│
├── docs/
│   └── CASCA-USER-GUIDE.md   ← user-facing product guide
│
└── _headers, _redirects, netlify.toml, robots.txt, sitemap.xml
```
