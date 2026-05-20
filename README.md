# Casca

> **AI LLM smart-routing engine + API proxy aggregator.**
> One line of code reduces your LLM bill 30–60% by routing each prompt
> to the cost-optimal model while preserving quality.
>
> Live: [cascaio.com](https://cascaio.com) · API: `api.cascaio.com`
> Admin: [casca-admin.cascaio.com](https://casca-admin.cascaio.com)
> Technical paper: [Zenodo DOI — TBD](https://zenodo.org/) / [casca-technical-article.md](./casca-technical-article.md)

## How it works

Three-layer classification decides where each prompt goes:

```
Prompt
  │
  ▼
L1 — casca-classifier.cjs (0.5 ms)
  │  160 regex rules, 14 languages, dynamic confidence
  │
  ├─ confidence ≥ 80  → use L1 label (HIGH / MED / LOW)
  └─ confidence < 80  → L2 MiniLM (~10 ms)
                          │
                          ▼
                     PyTorch transformer, fine-tuned per batch
                          │
                          ▼
LLM provider selected by tier (OpenAI / Anthropic / Google / Mistral / …)
```

L1 + Calibrator + L2 combined accuracy is currently ~95%. Behind the
scenes, a self-improving **Path B** training pipeline asynchronously
judges every response with `gpt-4o-mini` and updates per-rule accuracy
so routing improves continuously.

For the full request flow, schemas, and design rationale see
**[ARCHITECTURE.md](./ARCHITECTURE.md)**.

## Stack

| Layer | Technology |
|---|---|
| Frontend | Cloudflare Pages (landing / dashboard / admin / playground) |
| API Gateway | Railway · Express 5 (ESM) · Node 20+ |
| L1 Classifier | `casca-classifier.cjs` v2.6.2 — 160 rules, 14 languages (CJK + EN + FR/DE/ES/IT + KO/HI/AR/TH/VI/ID; L2 supports 20 langs) |
| L2 Classifier | Railway · FastAPI + PyTorch · MiniLM-L12-v2 |
| Database | Supabase (PostgreSQL 15 + RLS + Auth + Storage) |
| Cache | In-memory + `tenant_cache_pool` + optional Redis |
| Payments | Stripe (subscription + top-up) |
| Email | Resend |
| Edge / DNS | Cloudflare Workers Function proxy |

## Quick start (client side)

Drop-in OpenAI-compatible — just change `base_url` and use a Casca key.

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://api.cascaio.com/v1",
    api_key="csk_..."   # get yours at https://cascaio.com/dashboard
)

resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello, world"}],
)
print(resp.choices[0].message.content)
# resp._casca contains routing metadata: cx, model, savingsPct, etc.
```

Three modes detected from key prefix:
- `csk_...` — **Managed**: Casca pays the LLM bill, you pay a flat subscription + overage
- `sk-...` / `sk-ant-...` / `AIza...` — **Passthrough**: you keep your OpenAI / Anthropic / Google key, Casca only classifies and routes

## Repo layout (key files)

```
casca/
├── ARCHITECTURE.md             ← detailed system architecture
├── README.md                   ← this file
│
├── server-v2.js                ← Express 5 API gateway
├── casca-path-b.js             ← Path B training pipeline (PII mask, LLM Judge, MiniLM client)
├── casca-classifier.cjs        ← L1 classifier engine v2.6.2
├── package.json
│
├── index.html · tw.html        ← Landing (EN / 繁中)
├── casca-dashboard.html
├── terminal.html               ← Interactive playground
│
├── casca-schema-*.sql          ← Supabase migrations
│
├── functions/                  ← Cloudflare Pages Workers
│   └── api/[[path]].js         ← API proxy → Railway
│
├── casca-minilm/               ← FastAPI MiniLM service
│   ├── app.py · Dockerfile · railway.toml
│   ├── model/serve.py · model/train.py
│   ├── colab_train_L12.ipynb   ← training notebook
│   ├── jobs/                   ← data ingest / validation utilities
│   └── data/                   ← linguist-delivered training batches (JSONL)
│
├── casca-zapier-v1.0.2/        ← Zapier integration (3 triggers, 6 actions, 1 search)
├── casca-apex-sdk/             ← Salesforce Apex SDK
├── casca-enterprise-build/     ← Casca Vault (on-prem deploy package)
└── contracts/                  ← MTM contracts (work-in-progress + COMPLETED/)
```

## Self-improving Path B

| Layer | Latency | Purpose |
|---|---|---|
| L1 rule engine | 0.5 ms | Fast first pass; emits `static_confidence` |
| Dynamic confidence | — | `static × rule_accuracy_rate` from `rule_accuracy_stats` |
| L2 MiniLM | ~10 ms | Neural fallback when dynamic confidence < 80 |
| LLM Judge | async | `gpt-4o-mini` labels every request after response, updating accuracy stats |

Rule health categories:

| `accuracy_rate` | Status | Effect |
|---|---|---|
| `≥ 0.85` | HEALTHY | L1 confident, no fallback |
| `0.70–0.85` | DEGRADING | Often falls to L2 |
| `< 0.70` | BROKEN | L2 always takes over |
| `< 10 samples` | NEW | Static confidence used |

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — full system architecture, schemas, env vars
- **[casca-technical-article.md](./casca-technical-article.md)** — published technical paper (Zenodo)
- **[casca-minilm/DATA_PROVIDER_GUIDE.md](./casca-minilm/DATA_PROVIDER_GUIDE.md)** — for language masters providing training data
- **[casca-minilm/TRAINING_STATUS.md](./casca-minilm/TRAINING_STATUS.md)** — current MiniLM training milestones
- **[docs/CASCA-USER-GUIDE.md](./docs/CASCA-USER-GUIDE.md)** — customer-facing user guide
- **[casca-enterprise-build/docs/](./casca-enterprise-build/docs/)** — Casca Vault enterprise deployment

## Status & versioning

| Component | Current |
|---|---|
| Product | v3.2 |
| L1 Engine | v2.6.2 (160 rules, 14 langs) |
| L2 Active | `v_L12_20260505` (90.96% val) |
| L2 Latest trained | `v_L12_20260518_042247` (94.98% val, 20 langs) |
| Zapier app | v1.0.2 (submitted for review) |
| Last architecture update | 2026-04-14 |

## License

Source available under [LICENSE](./LICENSE) — see file for terms.

Published by **Vast Intelligence Limited**.
For enterprise contact: `casca@vastitw.com`
