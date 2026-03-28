# CASCA: A Self-Improving Multi-Model LLM Router with Quality-Guaranteed Cost Optimization

**Published:** March 28, 2026  
**Author:** Vast Intelligence Limited  
**Contact:** Casca@vastitw.com  
**Repository:** github.com/jewanchen/casca  
**Version:** Engine v1.2 · 26 Rules · 1,000+ Labeled Samples  

---

## Abstract

We present **Casca**, a production LLM routing system that reduces enterprise AI API costs by **30–60%** while maintaining quality SLA guarantees. Unlike existing routers that apply static rules, Casca implements a closed-loop **Auto-Learn flywheel**: real customer traffic generates ambiguous cases, human annotators label them, and the classifier automatically updates — making routing accuracy improve continuously over time.

This article documents our system architecture, routing engine v1.2 (26 rules, 1,000+ labeled training samples), multimodal routing design, and the Auto-Learn pipeline, establishing a public record of our technical approach as of the publication date above.

---

## 1. Motivation

Most enterprises route all LLM requests to a single top-tier model (typically GPT-4o). This is a significant overpayment. Consider a customer service chatbot receiving 100,000 requests per day:

| Request Type | Actual % | Optimal Model | Cost / 1M tokens |
|---|---|---|---|
| Policy lookup ("What is our return policy?") | ~43% | Gemini 2.0 Flash | $0.10 |
| Content generation ("Draft this email") | ~42% | GPT-4o-mini | $0.15 |
| Complex reasoning ("Analyze Q3 root cause") | ~15% | GPT-4o | $5.00 |

If all requests go to GPT-4o, blended cost = $5.00/M tokens. With intelligent routing, blended cost drops to approximately $0.87/M — an **83% reduction in per-token cost**, translating to a real-world 38–42% reduction in total monthly spend.

---

## 2. System Architecture

### 2.1 Layer 0 — Semantic Cache

Before any model call, we check a semantic cache pool. A request hits the cache if it exceeds a 0.95 cosine similarity threshold against any cached query. Cache hits cost $0. At steady state with real customers, we observe ~14% cache hit rates.

The cache pool is cross-customer by default. Privacy-sensitive customers can opt into isolated per-tenant caches.

### 2.2 Layer 1 — Modal Detection

Before text classification, we detect the modality of the request. Text-only models cannot process images, and routing a medical image request to a cheap text model results in complete failure.

| Modal | Rule | Target Model | Rationale |
|---|---|---|---|
| video | R-MODAL-4 | Gemini 1.5 Pro | Only model with reliable video understanding |
| medical_image | R-MODAL-2 | GPT-4o Vision | Clinical error cost is too high |
| legal_doc | R-MODAL-1+R6 | Claude Sonnet | Legal compliance → forced HIGH |
| image (general) | R-MODAL-1 | Gemini Flash Vision | Min MED; HIGH if analysis required |
| chart | R-MODAL-5 | GPT-4o-mini | MED unless reasoning required |
| doc (scan) | R-MODAL-6 | Claude Haiku Vision | Depends on document type |

**Design decision:** All modal routing is silent. We do not interrupt the user flow with cost warnings. The user asked a question; we answer it with the appropriate model.

### 2.3 Layer 2 — Text Classifier v1.2

For text requests, we classify into four tiers:

- **LOW** — Query/lookup. Routed to Gemini 2.0 Flash ($0.10/M tokens)
- **MED** — Generate/organize. Routed to GPT-4o-mini ($0.15/M tokens)
- **HIGH** — Judge/analyze. Routed to GPT-4o ($5.00/M) or Claude Sonnet ($3.00/M)
- **AMBIGUOUS** — Confidence <80%. Conservative escalation to MED; flagged for annotation

The classifier applies 26 rules in priority order (P1 → P5):

| Priority | Rule(s) | Trigger | Output |
|---|---|---|---|
| P1 | R9 | Semantic similarity ≥ 0.95 | CACHE ($0) |
| P2 | R-MODAL-1–6 | Image / video / document detected | Modal-specific routing |
| P3 | R6 | legal / compliance / GDPR / HIPAA | Force HIGH |
| P4 | R5 | analyze / root cause / strategy | HIGH |
| P5 | R4, R8 | Token length fallback | LOW/MED/HIGH |

**English-Specific Rules (R-EN1–5)**

- **R-EN1 Modal softening:** "Could you / would you" → strip, re-classify the underlying verb
- **R-EN2 Pronoun without referent:** "Fix it" / "Help with this" → AMBIGUOUS if no context
- **R-EN3 Nominalization:** "Analysis of Q3" → treat as verb form "analyze Q3"
- **R-EN4 Jargon decomposition:** 3+ acronyms → decompose, take highest sub-task difficulty
- **R-EN5 Just/quick trap:** "just a quick analysis" → ignore "just/quick", classify the actual task

---

## 3. Training Data: 1,000 Labeled Samples Across 5 Batches

| Batch | Language | Samples | Domains / Coverage | Noise % | Rules Added | Accuracy |
|---|---|---|---|---|---|---|
| Batch 1 | Chinese | 120 | 5 domains | 0% | R1–R9 | 88.3% |
| Batch 2 | Chinese | 120 | 12 domains | 0% | R-NEW1–4 | 91.6% |
| Batch 3 | Chinese + noise | 260 | 16 domains | 68% | R-LANG/AMBIG/MULTI/EMOT | 94.1% |
| Batch 4 | English | 250 | 12 US industries | 82% | R-EN1–5 | 94.1%+ |
| Batch 5 | English | 250 | 9 US industries | 67% | R-MODAL-1–6 | 94.1%+ |

**Classifier Performance (500-sample validation)**

| Tier | Precision | Recall | F1 | Notes |
|---|---|---|---|---|
| LOW | 97.2% | 96.8% | 97.0% | Highest — query/lookup tasks are clear |
| MED | 78.4% | 79.1% | 78.7% | Lowest — boundary tier, expected |
| HIGH | 95.1% | 94.6% | 94.8% | Strong — legal/analysis keywords clear |
| Weighted avg | — | — | 93.3% | Zero LOW↔HIGH misclassifications |

---

## 4. The Auto-Learn Flywheel

This is Casca's primary technical moat. The flywheel operates as a closed loop:

1. Real customer traffic is routed with the classifier
2. Low-confidence decisions (< 80%) are pushed to annotation queue, sorted by ascending confidence score (active learning: most uncertain cases first)
3. Human annotators review each case in ~30 seconds using keyboard shortcuts: L=LOW, M=MED, H=HIGH, S=Skip
4. Every 10 confirmed labels automatically triggers a classifier update
5. Updated rules deploy to production with zero downtime
6. Better routing → more customer trust → more traffic → more edge cases → repeat

**Observed improvement rate:** +0.12% accuracy per 10 labels. At 30 annotations/day, this compounds to approximately +1% per week on edge cases.

### 4.1 The Data Moat

Competitors can read this article and replicate our 26 rules within weeks. What they cannot replicate:

- **Real traffic distribution:** Our training data reflects what enterprise customers actually ask. Synthetic data misses the long tail of edge cases.
- **Cross-industry label consistency:** "Quick analysis" in healthcare = HIGH (clinical judgment). Same phrase in retail = MED (sales report). Rules cannot distinguish — labeled examples can.
- **Temporal improvement:** Each week of customer traffic generates ~200 new AMBIGUOUS cases. A competitor starting from our public rules today begins at our Day 1 accuracy.

---

## 5. Quality SLA Architecture

1. **Customer-defined thresholds:** Each customer sets minimum quality scores per use case
2. **Continuous monitoring:** Every response is quality-scored against customer-uploaded golden examples
3. **Automatic escalation:** If quality drops below threshold, request is re-routed to a higher tier
4. **Contractual refund trigger:** Quality below threshold for 3 consecutive days → full monthly platform fee refunded. This is a contractual obligation, not a promise.

### 5.1 The Bypass Switch

Setting the following environment variable causes all traffic to bypass Casca and route directly to the customer's configured Provider. Activation takes effect within 5 seconds:

```bash
export CASCA_BYPASS=true
```

This design means Casca is architecturally not a single point of failure. The customer's system works identically with and without us. This is a deliberate trust-building mechanism.

---

## 6. Multi-Provider Support

Casca exposes a single OpenAI-compatible endpoint. Behind this endpoint, we support routing to 8 major providers:

| Provider | Models (selection) | Status |
|---|---|---|
| OpenAI | GPT-4o, GPT-4o-mini, GPT-4o Vision | Connected |
| Anthropic | Claude 3.5 Sonnet, Claude Haiku, Claude Opus | Connected |
| Google Vertex | Gemini 2.0 Flash, Gemini 1.5 Pro, Flash Vision | Connected |
| Azure OpenAI | Azure GPT-4o, Azure GPT-4o-mini | Connected |
| AWS Bedrock | Llama3-70B, Mistral-7B, Titan Express | Configured |
| Groq | Llama3-70B (ultra-low latency), Mixtral-8x7B | Configured |
| Cohere | Command R+, Command R | Configured |
| Mistral AI | Mistral Large, Mistral Small, 7B | Configured |

---

## 7. Comparison to Related Work

| Feature | Casca | LiteLLM | PortKey | DIY |
|---|---|---|---|---|
| Semantic complexity classification | ✓ 26 rules + ML | ✗ | ✗ | △ build it |
| Multimodal auto-routing | ✓ 6 types, silent | △ manual | △ basic | △ build it |
| Auto-Learn (traffic → update) | ✓ closed loop | ✗ | ✗ | ✗ never |
| Quality SLA + refund contract | ✓ contractual | ✗ | ✗ | ✗ |
| 8+ Provider support | ✓ 8 providers | ✓ 100+ | △ 30+ | △ manual |
| Cross-customer semantic cache | ✓ ~14% hit rate | △ basic | △ basic | ✗ |
| 1-line integration | ✓ base_url change | △ more setup | △ more | ✗ weeks |

---

## 8. Known Limitations

- **MED tier accuracy (78.4% F1):** The boundary between MED and HIGH is genuinely ambiguous for many real-world requests. Conservative escalation applied.
- **Language coverage:** Best performance on English and Mandarin Chinese. Other languages use token length fallback.
- **Novel domain bootstrap:** New customers in unseen industries use general rules. Domain-specific accuracy improves over 2–4 weeks of traffic.
- **Multimodal detection relies on prompt markers:** If image data is sent without text markers (e.g. "[X-ray]"), modal detection defaults to text routing.

---

## 9. Future Work

- **Layer 2 — Industry semantic model (3-month target):** Fine-tune a distilBERT classifier on our labeled corpus. Replaces rule-based classification with a learned model.
- **Layer 3 — Cross-customer vector DB (6-month target):** Aggregate anonymized routing signals across customers (Pinecone/pgvector). Enables semantic cache generalization.
- **Layer 4 — Conversational clarification (V2):** For ambiguous requests where the quality difference between MED and HIGH is large, ask a single clarifying question.
- **Auth Layer:** Multi-tenant authentication (Clerk / Auth0) with per-tenant API key isolation, SSO for Enterprise customers.

---

## 10. Implementation Notes for Researchers

The core routing classifier can be bootstrapped in approximately 120 labeled samples (Batch 1 performance: 88.3%). The jump from 88% to 94% requires noisy/real-world samples, not more clean samples.

**Most important annotation guideline:** "Judge how much reasoning is required, not how difficult the topic seems." "What is quantum entanglement?" is LOW (definition lookup). "Analyze whether our quantum computing patents are defensible" is HIGH (strategic legal judgment).

For the active learning annotation queue, sort by ascending confidence and apply the 30-second rule: if you cannot decide in 30 seconds, mark AMBIGUOUS and move on. A fast, consistent annotation process beats a slow, perfect one for classifier training.

---

## Citation

If you build on this work, please cite:

```
Vast Intelligence Limited. (2026).
Casca: A Self-Improving Multi-Model LLM Router
with Quality-Guaranteed Cost Optimization.
https://github.com/jewanchen/casca
Published: March 28, 2026.
```

---

## Contact

**Company:** Vast Intelligence Limited  
**Phone:** +886 2 2706 7590  
**Email:** Casca@vastitw.com  
**Website:** casca.vastitw.com  

---

*This document is published to establish a public record of the technical approaches described herein as of March 28, 2026. All architectural descriptions, training data methodologies, and system designs are the intellectual property of Vast Intelligence Limited.*
