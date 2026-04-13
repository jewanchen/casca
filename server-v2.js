/**
 * server-v2.js  —  Casca v3  ·  API Proxy + Billing Engine
 * ════════════════════════════════════════════════════════════════════
 * New in v3:
 *   • API Key auth via SHA-256 hash (api_key_hash in clients, or api_keys table)
 *   • Subscription plans + overage billing (account_usage_and_deduct RPC)
 *   • 402 Payment Required gate before LLM calls when quota exhausted
 *   • Stripe Checkout for subscribe + topup
 *   • Stripe webhook for invoice.paid + checkout.session.completed
 *   • Admin CRUD for subscription_plans (/api/admin/plans)
 * ════════════════════════════════════════════════════════════════════
 *
 * Env vars (.env):
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY / ADMIN_SECRET / PORT
 *   CORS_ORIGIN / LLM_TIMEOUT_MS
 *   CACHE_PROMOTE_THRESHOLD / CACHE_PROMOTE_WINDOW_H / CACHE_TTL_DAYS
 *   STRIPE_SECRET_KEY         — sk_live_… or sk_test_…
 *   STRIPE_WEBHOOK_SECRET     — whsec_… from Stripe Dashboard
 *   STRIPE_TOPUP_PRICE_ID     — one-time price ID for credit top-ups (or use ad-hoc)
 *   REDIS_URL                 — redis://... from Railway Redis service (optional, enables async postProcess)
 */

import 'dotenv/config';
import express          from 'express';
import cors             from 'cors';
import crypto           from 'crypto';
import Stripe           from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { createRequire }  from 'module';

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// ── Load CommonJS classifier (UMD) from ESM server ──────────────
// IMPORTANT: file MUST be .cjs so Node.js treats it as CommonJS
// despite package.json having "type": "module".
const _require    = createRequire(import.meta.url);
const _classifier = _require('./casca-classifier.cjs');
console.log('[casca] classifier v' + (_classifier.VERSION || '?') +
            ' loaded — ' + Object.keys(_classifier).length + ' exports');
const cascaRoute  = _classifier.route;
const setConfig   = typeof _classifier.setConfig === 'function'
                      ? _classifier.setConfig
                      : () => {};

// ════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════
const PORT              = process.env.PORT                    || 3001;
const PROMOTE_THRESHOLD = parseInt(process.env.CACHE_PROMOTE_THRESHOLD || '3',  10);
const PROMOTE_WINDOW_H  = parseInt(process.env.CACHE_PROMOTE_WINDOW_H  || '24', 10);
const CACHE_TTL_DAYS    = parseInt(process.env.CACHE_TTL_DAYS          || '7',  10);
const CORS_ORIGIN       = (() => {
  const raw = process.env.CORS_ORIGIN || '*';
  if (raw === '*') return '*';
  const list = raw.split(',').map(s => s.trim()).filter(Boolean);
  return list.length === 1 ? list[0] : list;
})();
const LLM_TIMEOUT_MS    = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);
const FRONTEND_URL      = process.env.FRONTEND_URL            || 'http://localhost:8080';


// ════════════════════════════════════════════════════════════════
//  PROMETHEUS METRICS
// ════════════════════════════════════════════════════════════════
const promRegistry = new Registry();
promRegistry.setDefaultLabels({ service: 'casca' });
collectDefaultMetrics({ register: promRegistry, prefix: 'casca_node_' });

const mRequestsTotal = new Counter({
  name: 'casca_requests_total',
  help: 'Total routed requests by tier, language, model and cache status',
  labelNames: ['cx', 'lang', 'model', 'is_cache', 'stage'],
  registers: [promRegistry],
});

const mRequestDurationMs = new Histogram({
  name: 'casca_request_duration_ms',
  help: 'End-to-end request latency in milliseconds',
  labelNames: ['cx', 'lang', 'stage'],
  buckets: [50, 100, 250, 500, 1000, 2000, 5000, 10000],
  registers: [promRegistry],
});

const mCostUsdTotal = new Counter({
  name: 'casca_cost_usd_total',
  help: 'Cumulative LLM cost in USD by tier and model',
  labelNames: ['cx', 'model'],
  registers: [promRegistry],
});

const mTokensTotal = new Counter({
  name: 'casca_tokens_total',
  help: 'Total tokens consumed, split by direction and model',
  labelNames: ['direction', 'model'],
  registers: [promRegistry],
});

const mCacheHitsTotal = new Counter({
  name: 'casca_cache_hits_total',
  help: 'Total L1 cache hits (free requests)',
  registers: [promRegistry],
});

const mSavingsUsdTotal = new Counter({
  name: 'casca_savings_usd_total',
  help: 'Estimated cumulative USD saved vs GPT-4o baseline',
  labelNames: ['cx'],
  registers: [promRegistry],
});

const mAmbigTotal = new Counter({
  name: 'casca_ambig_resolutions_total',
  help: 'Requests that triggered AMBIG auto-learn queue',
  labelNames: ['lang'],
  registers: [promRegistry],
});

const mQuotaExhaustedTotal = new Counter({
  name: 'casca_quota_exhausted_total',
  help: 'Requests rejected due to exhausted quota (402)',
  labelNames: ['plan_id'],
  registers: [promRegistry],
});

const mErrorsTotal = new Counter({
  name: 'casca_llm_errors_total',
  help: 'LLM call failures by model and HTTP status',
  labelNames: ['model', 'status_code'],
  registers: [promRegistry],
});

const mActiveProviders = new Gauge({
  name: 'casca_active_providers',
  help: 'Number of active LLM providers in registry',
  registers: [promRegistry],
});

// ════════════════════════════════════════════════════════════════
//  CLIENTS
// ════════════════════════════════════════════════════════════════
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' })
  : null;

// ════════════════════════════════════════════════════════════════
//  REDIS — async postProcess queue (optional)
//  If REDIS_URL is not set, postProcess runs synchronously (original behaviour).
//  With Redis: res.json() fires immediately, DB writes happen in background.
// ════════════════════════════════════════════════════════════════
const REDIS_URL = process.env.REDIS_URL || null;
let redisClient = null;

async function initRedis() {
  if (!REDIS_URL) {
    console.log('[redis] REDIS_URL not set — postProcess will run synchronously');
    return;
  }
  try {
    const { createClient: createRedisClient } = await import('redis');
    redisClient = createRedisClient({ url: REDIS_URL });
    redisClient.on('error', err => console.error('[redis] error:', err.message));
    await redisClient.connect();
    console.log('[redis] connected — async postProcess enabled');
    startPostProcessWorker();
  } catch (err) {
    console.error('[redis] init failed, falling back to sync:', err.message);
    redisClient = null;
  }
}

const POST_PROCESS_QUEUE = 'casca:post_process';

// Worker: runs in background, drains the queue continuously
async function startPostProcessWorker() {
  console.log('[redis] postProcess worker started');
  while (true) {
    try {
      // Block-pop: waits up to 5s for a job, then loops
      const item = await redisClient.brPop(POST_PROCESS_QUEUE, 5);
      if (!item) continue;
      const job = JSON.parse(item.element);
      // Re-hydrate classifyResult defaults
      job.classifyResult = job.classifyResult || {};
      await postProcess(job);
    } catch (err) {
      console.error('[redis] worker error:', err.message);
      await new Promise(r => setTimeout(r, 1000)); // backoff on error
    }
  }
}

// Helper: enqueue or run directly
async function enqueuePostProcess(job) {
  if (redisClient?.isReady) {
    // Serialize and push to Redis queue — fire and forget
    await redisClient.lPush(POST_PROCESS_QUEUE, JSON.stringify(job));
  } else {
    // No Redis: run synchronously (original behaviour)
    postProcess(job).catch(err => console.error('[casca] postProcess error:', err.message));
  }
}

// ════════════════════════════════════════════════════════════════
//  PROVIDER REGISTRY
// ════════════════════════════════════════════════════════════════
/** @type {Map<string, object>} */
const providerRegistry = new Map();

async function loadProviders() {
  const { data, error } = await supabase
    .from('llm_providers')
    .select('*')
    .eq('is_active', true)
    .order('priority', { ascending: true });

  if (error) { console.error('[casca] loadProviders:', error.message); return; }
  if (!data?.length) { console.warn('[casca] No active providers. Using built-in defaults.'); return; }

  providerRegistry.clear();
  const dynamicCosts = {};
  const tierBuckets  = { LOW: [], MED: [], HIGH: [], ANY: [] };

  for (const row of data) {
    providerRegistry.set(row.model_name, row);
    dynamicCosts[row.model_name] = row.cost_per_1m_tokens;
    const caps = row.tier_capability === 'ANY' ? ['LOW','MED','HIGH'] : [row.tier_capability];
    for (const cap of caps) { if (tierBuckets[cap]) tierBuckets[cap].push(row); }
  }

  const pick = (arr, i = 0) => arr?.[i]?.model_name ?? null;
  const dynamicTiers = {};
  for (const tier of ['LOW','MED','HIGH','AMBIG']) {
    const src = tier === 'AMBIG'
      ? [...(tierBuckets.MED || []), ...(tierBuckets.ANY || [])]
      : [...(tierBuckets[tier] || []), ...(tierBuckets.ANY || [])];
    if (!src.length) continue;
    const higherSrc = tier === 'LOW'
      ? [...(tierBuckets.MED || []), ...src]
      : tier === 'MED' ? [...(tierBuckets.HIGH || []), ...src] : src;
    dynamicTiers[tier] = { default: pick(src, 0), low_q: pick(src, 0), high_q: pick(higherSrc, 0) };
  }
  setConfig(dynamicCosts, dynamicTiers);
  console.log(`[casca] ${providerRegistry.size} providers. Tiers:`,
    Object.fromEntries(Object.entries(dynamicTiers).map(([t, v]) => [t, v.default])));
}

// ════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════
const normalizePrompt = t => t.toLowerCase().replace(/\s+/g, ' ').trim();
const sha256 = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const cacheExpiry = () => {
  if (CACHE_TTL_DAYS === 0) return null;
  const d = new Date(); d.setDate(d.getDate() + CACHE_TTL_DAYS);
  return d.toISOString();
};

// ════════════════════════════════════════════════════════════════
//  ATTACHMENT CONTEXT INJECTION
//  Handles the "Lazy Prompt" pattern: user uploads a file/image
//  with no text, or minimal text like "幫我看看這個".
//
//  Problem: OpenAI Vision API sends content as an array, not a string:
//    [{ type: 'image_url', image_url: { url: '...' } }, { type: 'text', text: '' }]
//  Without handling this, server-v2.js returns 400 (content must be string).
//
//  Solution: parse the content array → infer attachment type →
//  inject a classifier-recognisable modal tag into promptText.
//  The classifier's detectModal() already handles these tags perfectly;
//  no changes to casca-classifier.js are required.
//
//  Tag → modal mapping (matches classifier's detectModal rules):
//    [photo: ...]        → image  modal → MED  (Gemini Flash Vision)
//    [screenshot: ...]   → chart  modal → MED  (read) / HIGH (if analysis intent)
//    [scan: ...]         → doc    modal → MED  (Claude Haiku Vision)
//    [chart: ...]        → chart  modal → MED+ (GPT-4o-mini)
//    [x-ray: ...]        → medical_image → HIGH forced (GPT-4o Vision)
//    [contract scan: ...]→ legal_doc    → HIGH forced (Claude Sonnet)
// ════════════════════════════════════════════════════════════════

/**
 * injectAttachmentContext(messages)
 *
 * Extracts the last user message from the OpenAI-format messages array.
 * If content is a string (normal text), returns it unchanged.
 * If content is an array (Vision format), detects image/file parts and
 * prepends an appropriate modal tag so the classifier can route correctly.
 *
 * Returns: { promptText: string, hasAttachment: boolean }
 */
function injectAttachmentContext(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return { promptText: '', hasAttachment: false };

  // ── Normal string content — no change needed ─────────────────
  if (typeof lastUser.content === 'string') {
    return { promptText: lastUser.content, hasAttachment: false };
  }

  // ── Vision / multipart content (array format) ─────────────────
  if (!Array.isArray(lastUser.content)) {
    return { promptText: '', hasAttachment: false };
  }

  const textPart  = lastUser.content.find(c => c.type === 'text');
  const imagePart = lastUser.content.find(c => c.type === 'image_url');
  const filePart  = lastUser.content.find(c => c.type === 'file' || c.type === 'input_file');

  const userText = textPart?.text?.trim() ?? '';
  let tag = '';

  // ── Image attachment ──────────────────────────────────────────
  if (imagePart) {
    const url = imagePart.image_url?.url ?? '';
    const detail = imagePart.image_url?.detail ?? '';

    // Medical imaging keywords in the URL or base64 MIME hint
    if (/x-ray|xray|mri|ct[\-_]scan|ct_|ultrasound|ecg|ekg|pathology|retinal|dental.x|dicom/i.test(url)) {
      tag = '[x-ray: uploaded]';              // → medical_image → HIGH forced
    }
    // Legal document scan
    else if (/contract|agreement|nda|lease|kyc|court|legal|deed|notari/i.test(url)) {
      tag = '[contract scan: uploaded]';      // → legal_doc → HIGH forced
    }
    // Screenshot (UI, terminal, code, dashboard)
    else if (/screenshot|screen_shot|screencap|terminal|console|dashboard|monitor/i.test(url) || detail === 'high') {
      tag = '[screenshot: uploaded]';         // → chart modal → MED
    }
    // Default: treat as generic photo
    else {
      tag = '[photo: uploaded]';              // → image modal → MED
    }
  }

  // ── File attachment ───────────────────────────────────────────
  if (filePart && !tag) {
    const mime     = filePart.file?.mime_type ?? filePart.mime_type ?? '';
    const filename = filePart.file?.filename  ?? filePart.filename  ?? '';

    if (/pdf|msword|officedocument\.wordprocessing/i.test(mime) ||
        /\.pdf$|\.doc$|\.docx$/i.test(filename)) {
      // Check if it looks like a legal document
      if (/contract|agreement|nda|lease|legal|deed|compli/i.test(filename)) {
        tag = '[contract scan: uploaded]';    // → legal_doc → HIGH forced
      } else {
        tag = '[scan: document]';             // → doc modal → MED
      }
    }
    else if (/csv|spreadsheet|excel|officedocument\.spreadsheet/i.test(mime) ||
             /\.csv$|\.xlsx$|\.xls$/i.test(filename)) {
      tag = '[chart: data]';                  // → chart modal → MED
    }
    else if (/image\//.test(mime)) {
      tag = '[photo: uploaded]';              // → image modal → MED
    }
    else {
      tag = '[scan: document]';              // → doc modal → MED (safe default)
    }
  }

  // ── Compose final promptText ──────────────────────────────────
  const promptText = tag
    ? (userText ? `${tag} ${userText}` : tag)
    : userText;

  return { promptText, hasAttachment: !!tag };
}

/**
 * overrideByIntent(promptText, classifyResult)
 *
 * Second-pass intent check for 4 edge cases where the modal tag
 * routes to MED but the user's clear intent warrants HIGH:
 *   - Debug / bug hunt      幫我抓蟲 / debug / 報錯
 *   - Security analysis     漏洞 / vulnerability / security audit
 *   - Financial highlight   財報亮點 / highlights in this report
 *   - Why does it error     為什麼會報錯 / why is it failing
 *
 * These trigger HIGH only when an attachment is present (modal ≠ text),
 * so they don't affect normal text-only prompts.
 *
 * Returns the corrected cx string, or the original if no override needed.
 */
function overrideByIntent(promptText, classifyResult) {
  if (classifyResult.modal === 'text') return classifyResult.cx;
  if (classifyResult.cx === 'HIGH')    return classifyResult.cx; // already high

  const tl = promptText.toLowerCase();
  const isDebugIntent =
    /抓蟲|抓bug|debug|debugg|為什麼.*報錯|为什么.*报错|報錯|报错|error.*why|why.*error|why.*fail|why.*crash/i.test(tl);
  const isSecurityIntent =
    /漏洞|弱點|vulnerability|vulnerabilit|security audit|資安|安全.*分析|找出.*漏洞|code.*security|secure.*review/i.test(tl);
  const isFinancialAnalysis =
    /財報.*亮點|亮點.*財報|highlights?.*report|report.*highlights?|financial.*analysis|分析.*財報|audit.*report/i.test(tl);

  if (isDebugIntent || isSecurityIntent || isFinancialAnalysis) {
    return 'HIGH';
  }
  return classifyResult.cx;
}

// ════════════════════════════════════════════════════════════════
//  MIDDLEWARE — API Key Auth (SHA-256 hash-based)
//
//  Lookup order:
//    1. clients.api_key_hash  (primary single key per account)
//    2. api_keys.key_hash     (additional keys generated via dashboard)
//
//  Attaches req.client = { id, plan_id, cycle_used_tokens,
//                           balance_credits, quota_limit, quota_used }
//  Attaches req.plan   = { included_m_tokens, overage_rate_per_1m, ... }
// ════════════════════════════════════════════════════════════════
// ── Key type detection ────────────────────────────────────────
//
//  Stage 1/2 — PASSTHROUGH  (client's own LLM key)
//    OpenAI:     sk-...  or  sk-proj-...
//    Anthropic:  sk-ant-...
//    Google:     AIza...
//    → Casca classifies + substitutes model, forwards with client's key
//    → LLM cost hits client's own OpenAI/Google/Anthropic bill
//    → Casca bills classification fee only (via Casca Key in X-Casca-Key header)
//
//  Stage 3 / Demo — MANAGED  (Casca's own LLM key)
//    Casca Key:  csk_...
//    → Full proxy: Casca classifies + routes + calls LLM with Admin key
//    → Client pays Casca one bill (LLM + classification)
//
function detectKeyStage(raw) {
  if (!raw) return null;
  if (raw.startsWith('csk_'))                    return 'managed';
  if (raw.startsWith('sk-ant-'))                 return 'passthrough_anthropic';
  if (raw.startsWith('AIza'))                    return 'passthrough_google';
  if (raw.startsWith('sk-proj-') ||
      raw.startsWith('sk-'))                     return 'passthrough_openai';
  return null; // unknown
}

function passthroughProviderConfig(raw, stage, targetModel) {
  // Build an ad-hoc provider object using the client's own key
  // No DB lookup needed — key comes straight from Authorization header
  const configs = {
    passthrough_openai: {
      provider_name: 'OpenAI',
      base_url:      'https://api.openai.com/v1',
      key_in_query:  false,
    },
    passthrough_anthropic: {
      provider_name: 'Anthropic',
      base_url:      'https://api.anthropic.com',
      key_in_query:  false,
    },
    passthrough_google: {
      provider_name: 'Google',
      base_url:      'https://generativelanguage.googleapis.com/v1beta/openai',
      key_in_query:  true,
    },
  };
  const cfg = configs[stage];
  if (!cfg) return null;
  return {
    ...cfg,
    model_name:         targetModel,
    api_key_enc:        raw,          // client's own key, used once and not stored
    cost_per_1m_tokens: 0,            // client pays LLM directly — Casca doesn't track this cost
  };
}

async function requireApiKey(req, res, next) {
  const raw = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return res.status(401).json({ error: 'Missing Authorization header.' });

  const stage = detectKeyStage(raw);

  // ── Stage 1/2: PASSTHROUGH — client's own LLM key ────────────
  // No Casca account lookup needed for the primary key.
  // Optionally accept X-Casca-Key header for classification billing.
  if (stage && stage !== 'managed') {
    req.isPassthrough    = true;
    req.passthroughKey   = raw;
    req.passthroughStage = stage;

    // Optional: X-Casca-Key header → track classification usage on a Casca account
    const cascaKey = (req.headers['x-casca-key'] || '').trim();
    if (cascaKey && cascaKey.startsWith('csk_')) {
      const hash = sha256(cascaKey);
      const { data: keyRow } = await supabase
        .from('api_keys')
        .select('client_id, is_active')
        .eq('key_hash', hash)
        .maybeSingle();
      if (keyRow?.is_active) {
        const { data: client } = await supabase
          .from('clients')
          .select(`id, email, company_name, plan_id, balance_credits,
                   quota_limit, quota_used, cycle_used_tokens, billing_cycle_start,
                   stripe_customer_id, stripe_sub_id, trial_ends_at,
                   subscription_plans (
                     id, name, monthly_fee_usd, included_m_tokens, overage_rate_per_1m
                   )`)
          .eq('id', keyRow.client_id)
          .single();
        if (client) {
          req.client = client;
          req.plan   = client.subscription_plans ?? null;
        }
      }
    }

    // If no Casca account linked, attach a minimal anonymous context
    if (!req.client) {
      req.client = { id: null, email: 'passthrough', company_name: null,
                     plan_id: null, balance_credits: 0,
                     quota_used: 0, cycle_used_tokens: 0 };
      req.plan = null;
    }

    return next();
  }

  // ── Stage 3 / Demo: MANAGED — Casca key (csk_...) ────────────
  if (stage !== 'managed') {
    return res.status(401).json({
      error:  'Unrecognized API key format.',
      action: 'Use a Casca key (csk_...) for managed mode, or your own OpenAI/Google/Anthropic key for passthrough mode.',
    });
  }

  const hash = sha256(raw);

  // Try clients.api_key_hash first
  let clientId = null;
  {
    const { data } = await supabase
      .from('clients').select('id').eq('api_key_hash', hash).maybeSingle();
    if (data) clientId = data.id;
  }

  // Fall back to api_keys table
  if (!clientId) {
    const { data: keyRow } = await supabase
      .from('api_keys').select('client_id, is_active').eq('key_hash', hash).maybeSingle();
    if (!keyRow || !keyRow.is_active)
      return res.status(401).json({ error: 'Invalid API key.' });
    clientId = keyRow.client_id;
    supabase.from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('key_hash', hash).then(() => {});
  }

  const { data: client, error } = await supabase
    .from('clients')
    .select(`
      id, email, company_name, plan_id, balance_credits,
      quota_limit, quota_used, cycle_used_tokens, billing_cycle_start,
      stripe_customer_id, stripe_sub_id, trial_ends_at,
      subscription_plans (
        id, name, monthly_fee_usd, included_m_tokens, overage_rate_per_1m
      )
    `)
    .eq('id', clientId)
    .single();

  if (error || !client) return res.status(401).json({ error: 'Client not found.' });

  // Trial expiry check
  if (client.trial_ends_at) {
    const trialEnd = new Date(client.trial_ends_at);
    if (trialEnd < new Date()) {
      supabase.rpc('expire_trials').then(() => {});
      return res.status(403).json({
        error:      'Trial period has expired.',
        code:       'TRIAL_EXPIRED',
        expired_at: client.trial_ends_at,
        action:     'Subscribe to a paid plan at /api/billing/subscribe, or contact your administrator to extend the trial.',
      });
    }
  }

  req.isPassthrough = false;
  req.client = client;
  req.plan   = client.subscription_plans ?? null;
  next();
}

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_SECRET || req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Admin access required.' });
  next();
}

/**
 * Middleware: verify Supabase JWT (Bearer token from sb.auth.getSession)
 * Used for self-service endpoints where user has no csk_ key yet.
 */
async function requireSupabaseJWT(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Authorization header required.' });

  // csk_ keys are not JWT — reject them here (use requireApiKey instead)
  if (token.startsWith('csk_')) {
    return res.status(401).json({ error: 'Use csk_ key with /api/v1 endpoints.' });
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session.' });
  req.supabaseUser = data.user;
  next();
}

// ════════════════════════════════════════════════════════════════
//  BILLING GATE  (pre-LLM call check)
//
//  Returns { allowed: true } or { allowed: false, status, body }
//  Cache hits bypass this entirely — called only before real LLM calls.
// ════════════════════════════════════════════════════════════════
function checkBillingGate(client, plan) {
  // No plan = unmetered (internal / dev accounts)
  if (!plan) return { allowed: true };

  const includedTokens = (plan.included_m_tokens || 0) * 1_000_000;
  const usedTokens     = client.cycle_used_tokens || 0;

  // Within included quota → proceed
  if (usedTokens < includedTokens) return { allowed: true };

  // Over quota → check overage wallet
  // Minimum viable check: can the balance cover at least 1K tokens of overage?
  const minViableCharge = (1000 / 1_000_000) * (plan.overage_rate_per_1m || 1.00);
  if ((client.balance_credits || 0) >= minViableCharge) {
    return { allowed: true, isOverage: true };
  }

  mQuotaExhaustedTotal.inc({ plan_id: String(plan.id ?? 'unknown') });
  return {
    allowed: false,
    status:  402,
    body: {
      error:    'Token quota exhausted and insufficient overage balance.',
      code:     'PAYMENT_REQUIRED',
      quota:    { included: plan.included_m_tokens, used_millions: (usedTokens / 1_000_000).toFixed(2) },
      balance:  client.balance_credits,
      action:   'Top up your balance at /api/billing/topup to continue.',
    },
  };
}

// ════════════════════════════════════════════════════════════════
//  LLM PROXY CALL
// ════════════════════════════════════════════════════════════════
async function callLLM(provider, messages) {
  const baseUrl = provider.base_url.replace(/\/$/, '');
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${provider.api_key_enc}`,
  };
  if (provider.provider_name === 'Anthropic') {
    headers['anthropic-version'] = '2023-06-01';
  }

  // Google Gemini OpenAI-compat: key goes in query param
  let finalUrl = `${baseUrl}/chat/completions`;
  if (provider.provider_name === 'Google') {
    finalUrl = `${finalUrl}?key=${provider.api_key_enc}`;
    delete headers['Authorization'];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const res = await fetch(finalUrl, {
      method:  'POST',
      headers,
      body:    JSON.stringify({ model: provider.model_name, messages, max_tokens: 1024 }),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const txt = await res.text();
      return { responseText: null, tokensIn: 0, tokensOut: 0,
               statusCode: res.status, latencyMs, error: `LLM ${res.status}: ${txt.slice(0, 200)}` };
    }
    const json = await res.json();
    return {
      responseText: JSON.stringify(json),
      tokensIn:     json.usage?.prompt_tokens     ?? 0,
      tokensOut:    json.usage?.completion_tokens ?? 0,
      statusCode:   res.status, latencyMs, error: null,
    };
  } catch (err) {
    clearTimeout(timer);
    const isTimeout = err.name === 'AbortError';
    return { responseText: null, tokensIn: 0, tokensOut: 0,
             statusCode: isTimeout ? 504 : 0, latencyMs: Date.now() - t0,
             error: isTimeout ? `LLM timeout after ${LLM_TIMEOUT_MS}ms` : err.message };
  }
}

// ════════════════════════════════════════════════════════════════
//  ASYNC POST-PROCESS
//  Fires after res.json() — never blocks the client response.
// ════════════════════════════════════════════════════════════════
async function postProcess({
  clientId, planId, overageRate,
  promptHash, normalizedPrompt,
  classifyResult, provider, responseText,
  tokensIn, tokensOut, costUsd, savingsPct,
  isCache, latencyMs, statusCode, errorMessage, uc, noLog,
}) {
  try {
    const totalTokens = tokensIn + tokensOut;

    // ── 0. Prometheus metrics (always, even in zero-log mode) ────
    const _cx    = classifyResult.cx    || 'UNK';
    const _lang  = classifyResult.lang  || 'UNK';
    const _model = provider?.model_name ?? (isCache ? 'cache-hit' : 'none');
    const _stage = isCache ? 'cache' : (costUsd === 0 && !isCache ? 'passthrough' : 'managed');
    mRequestsTotal.inc({ cx: _cx, lang: _lang, model: _model, is_cache: String(isCache), stage: _stage });
    mRequestDurationMs.observe({ cx: _cx, lang: _lang, stage: _stage }, latencyMs);
    if (isCache) {
      mCacheHitsTotal.inc();
    } else {
      if (costUsd > 0) mCostUsdTotal.inc({ cx: _cx, model: _model }, costUsd);
      if (tokensIn  > 0) mTokensTotal.inc({ direction: 'in',  model: _model }, tokensIn);
      if (tokensOut > 0) mTokensTotal.inc({ direction: 'out', model: _model }, tokensOut);
      if (statusCode >= 400) mErrorsTotal.inc({ model: _model, status_code: String(statusCode) });
    }
    if (savingsPct > 0 && costUsd >= 0) {
      const baseline = (totalTokens / 1_000_000) * 5.0;
      mSavingsUsdTotal.inc({ cx: _cx }, Math.max(0, baseline - costUsd));
    }
    if (classifyResult.autoLearn) mAmbigTotal.inc({ lang: _lang });

    // ── Zero-log mode: skip all DB writes (billing still runs) ──
    if (noLog) {
      if (!isCache && totalTokens > 0) {
        await supabase.rpc('account_usage_and_deduct', {
          p_client_id: clientId, p_tokens: totalTokens,
          p_overage_rate: overageRate ?? 1.00,
        });
      }
      return;  // Skip api_logs, annotation_queue, frequency_log
    }

    // ── 1. api_logs (prompt_preview REDACTED for security) ───────
    const { data: logRow } = await supabase.from('api_logs').insert({
      client_id:     clientId,
      prompt_hash:   promptHash,
      prompt_preview: '[REDACTED]',
      uc,
      cx:            classifyResult.cx,
      original_cx:   classifyResult.originalCx,
      rule:          classifyResult.rule,
      lang:          classifyResult.lang,
      modal:         classifyResult.modal,
      auto_learn:    classifyResult.autoLearn,
      provider_id:   provider?.id        ?? null,
      model_name:    provider?.model_name ?? (isCache ? 'cache-hit' : null),
      tokens_in:     tokensIn,
      tokens_out:    tokensOut,
      cost_usd:      costUsd,
      savings_pct:   savingsPct,
      is_cache_hit:  isCache,
      latency_ms:    latencyMs,
      status_code:   statusCode,
      error_message: errorMessage ?? null,
    }).select('id').single();

    // ── 2. Token accounting + billing deduction ─────────────────
    if (!isCache && totalTokens > 0) {
      // Atomic: increment cycle tokens + deduct overage credits
      const { error: billingErr } = await supabase.rpc('account_usage_and_deduct', {
        p_client_id:    clientId,
        p_tokens:       totalTokens,
        p_overage_rate: overageRate ?? 1.00,
      });
      if (billingErr) console.error('[casca] billing deduct error:', billingErr.message);
    } else {
      // Cache hit or 0-token: just increment quota count (no billing)
      supabase.rpc('increment_quota_used', { p_client_id: clientId }).then(() => {});
    }

    // ── 3. Annotation queue (AMBIG → auto-learn) ────────────────
    if (classifyResult.autoLearn && !isCache) {
      supabase.from('annotation_queue').insert({
        client_id:      clientId,
        api_log_id:     logRow?.id ?? null,
        prompt:         normalizedPrompt,
        predicted_cx:   classifyResult.originalCx || classifyResult.cx,
        triggered_rule: classifyResult.rule,
        lang:           classifyResult.lang,
        uc,
        status: 'pending',
      }).then(() => {});
    }

    if (isCache) return;

    // ── 4. Frequency log + cache promotion ──────────────────────
    await supabase.from('prompt_frequency_log').insert({ client_id: clientId, prompt_hash: promptHash });

    const { data: shouldPromote } = await supabase.rpc('should_promote_to_cache', {
      p_client_id:    clientId,
      p_hash:         promptHash,
      p_threshold:    PROMOTE_THRESHOLD,
      p_window_hours: PROMOTE_WINDOW_H,
    });

    if (shouldPromote && responseText) {
      await supabase.from('tenant_cache_pool').upsert(
        { client_id: clientId, prompt_hash: promptHash, normalized_prompt: normalizedPrompt,
          response_text: responseText, model_used: provider?.model_name ?? null,
          cx: classifyResult.cx, original_cost_usd: costUsd, expires_at: cacheExpiry() },
        { onConflict: 'client_id,prompt_hash' }
      );
    }
  } catch (err) {
    console.error('[casca] postProcess error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  EXPRESS APP
//  NOTE: Stripe webhook MUST be registered before express.json()
//        to receive raw body for signature verification.
// ════════════════════════════════════════════════════════════════
const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

// ── Stripe webhook (raw body) — BEFORE express.json() ────────────
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured.' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe] webhook sig error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      // ── Checkout completed: subscription purchase OR topup ────
      case 'checkout.session.completed': {
        const session  = event.data.object;
        const clientId = session.metadata?.client_id;
        const type     = session.metadata?.type; // 'subscription' | 'topup'

        if (!clientId) break;

        if (type === 'topup') {
          // Credit the wallet
          const amountUsd = (session.amount_total || 0) / 100;
          await supabase.rpc('topup_balance', {
            p_client_id:      clientId,
            p_amount_usd:     amountUsd,
            p_stripe_session: session.id,
          });
          console.log(`[stripe] topup $${amountUsd} → client ${clientId.slice(0,8)}`);

        } else if (type === 'subscription') {
          // Update stripe_sub_id and subscription_id on client
          await supabase.from('clients').update({
            stripe_sub_id:        session.subscription,
            stripe_customer_id:   session.customer,
            billing_cycle_start:  new Date().toISOString().slice(0, 10),
            updated_at:           new Date().toISOString(),
          }).eq('id', clientId);

          // Log transaction
          await supabase.from('transactions').insert({
            client_id:        clientId,
            stripe_session_id: session.id,
            amount_usd:       (session.amount_total || 0) / 100,
            type:             'subscription',
            status:           'completed',
            description:      `Subscription started`,
          });
          console.log(`[stripe] subscription started → client ${clientId.slice(0,8)}`);
        }
        break;
      }

      // ── Invoice paid: recurring subscription renewal ──────────
      case 'invoice.paid': {
        const invoice  = event.data.object;
        const subId    = invoice.subscription;
        if (!subId) break;

        // Find client by stripe subscription id
        const { data: client } = await supabase
          .from('clients')
          .select('id, plan_id')
          .eq('stripe_sub_id', subId)
          .single();

        if (!client) break;

        // Reset billing cycle
        await supabase.rpc('reset_billing_cycle', { p_client_id: client.id });

        // Log renewal transaction
        await supabase.from('transactions').insert({
          client_id:        client.id,
          stripe_invoice_id: invoice.id,
          amount_usd:       (invoice.amount_paid || 0) / 100,
          type:             'subscription',
          status:           'completed',
          description:      `Monthly renewal`,
        });
        console.log(`[stripe] invoice.paid → cycle reset for client ${client.id.slice(0,8)}`);
        break;
      }

      // ── Subscription cancelled / payment failed ───────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase.from('clients').update({
          stripe_sub_id: null,
          // Downgrade to Free plan
          plan_id: (await supabase.from('subscription_plans')
            .select('id').eq('name','Free').single()).data?.id ?? null,
          updated_at: new Date().toISOString(),
        }).eq('stripe_sub_id', sub.id);
        console.log(`[stripe] subscription deleted → downgraded to Free`);
        break;
      }

      default:
        // Ignore unhandled event types
        break;
    }
  } catch (err) {
    console.error('[stripe] webhook handler error:', err.message);
  }

  res.json({ received: true });
});

// ── JSON body parser (after webhook route) ─────────────────────
app.use(express.json({ limit: '4mb' }));

// ── Rate limiting (in-memory, per API key) ─────────────────────
const RATE_MAX_CHAT  = 120;   // 120 chat requests/min per key
const RATE_MAX_ADMIN = 60;    // 60 admin requests/min
const rateLimitMap = new Map();
setInterval(() => rateLimitMap.clear(), 60_000); // Reset every minute

function rateLimit(keyPrefix, max) {
  return (req, _res, next) => {
    const key = `${keyPrefix}:${req.client?.id || req.ip}`;
    const count = (rateLimitMap.get(key) || 0) + 1;
    rateLimitMap.set(key, count);
    if (count > max) {
      return _res.status(429).json({ error: 'Rate limit exceeded. Try again in 1 minute.', limit: max, window: '60s' });
    }
    _res.setHeader('X-RateLimit-Limit', max);
    _res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
    next();
  };
}

// ════════════════════════════════════════════════════════════════
//  ZAPIER INTEGRATION ENDPOINTS
//  Simplified API surface for Zapier triggers, actions, and auth test.
//  All endpoints use standard requireApiKey (Bearer csk_...)
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/zapier/auth-test
 * Zapier calls this to verify API key is valid during connection setup.
 * Returns minimal account info for the connection label.
 */
app.get('/api/zapier/auth-test', requireApiKey, (req, res) => {
  const c = req.client;
  res.json({
    id:    c.id,
    email: c.email,
    company_name: c.company_name || '',
    plan:  req.plan?.name || 'Free',
    label: c.company_name || c.email,  // Zapier uses this as connection label
  });
});

/**
 * GET /api/zapier/logs
 * Polling trigger: returns recent API logs (newest first).
 * Zapier polls this every 1-15 min to detect new logs.
 * Must return array of objects with unique `id` field.
 */
app.get('/api/zapier/logs', requireApiKey, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);
  const { data, error } = await supabase
    .from('api_logs')
    .select('id, prompt_hash, cx, model_name, tokens_in, tokens_out, cost_usd, savings_pct, is_cache_hit, latency_ms, status_code, created_at')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  // Zapier requires array at top level, each item must have `id`
  return res.json(data || []);
});

/**
 * GET /api/zapier/annotations
 * Polling trigger: returns pending annotation queue items (newest first).
 */
app.get('/api/zapier/annotations', requireApiKey, async (req, res) => {
  const { data, error } = await supabase
    .from('annotation_queue')
    .select('id, prompt, predicted_cx, triggered_rule, lang, uc, status, created_at')
    .eq('client_id', req.client.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(25);
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data || []);
});

/**
 * GET /api/zapier/usage
 * Polling trigger: returns usage summary. Triggers when quota exceeds threshold.
 * Zapier deduplicates by `id` — we use a date-based id so it triggers once per day.
 */
app.get('/api/zapier/usage', requireApiKey, async (req, res) => {
  const c = req.client;
  const plan = req.plan;
  const included = (plan?.included_m_tokens || 0) * 1_000_000;
  const used = c.cycle_used_tokens || 0;
  const pct = included > 0 ? Math.round((used / included) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);

  // Only emit a record if usage > 80% (acts as alert trigger)
  if (pct >= 0) { // TEMP: lowered for Zapier validation, restore to 80 after
    return res.json([{
      id: `usage-${c.id}-${today}`,  // unique per day so Zapier triggers once daily
      email: c.email,
      plan: plan?.name || 'Free',
      used_tokens: used,
      included_tokens: included,
      usage_pct: pct,
      balance_credits: c.balance_credits || 0,
      alert_level: pct >= 100 ? 'OVER_QUOTA' : 'WARNING',
      date: today,
    }]);
  }
  return res.json([]);  // empty = no trigger
});

/**
 * POST /api/zapier/chat
 * Action: simplified AI chat. Returns plain text content (not full OpenAI object).
 * Zapier users can map the `content` field directly to other steps.
 */
app.post('/api/zapier/chat', requireApiKey, async (req, res) => {
  const { prompt, system_prompt, use_case, temperature, max_tokens } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required.' });

  // Build messages array
  const messages = [];
  if (system_prompt) messages.push({ role: 'system', content: system_prompt });
  messages.push({ role: 'user', content: prompt });

  // Forward to internal chat handler via direct function call
  const body = {
    messages,
    model: 'auto',
    max_tokens: max_tokens || 2048,
    temperature: temperature || 0.7,
  };
  if (use_case) body.casca_uc = use_case;

  // Build internal request to reuse existing chat logic
  const internalReq = new Request(`${req.protocol}://${req.get('host')}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
    body: JSON.stringify(body),
  });

  try {
    // Call the Casca API internally via fetch to localhost
    const internalRes = await fetch(`http://localhost:${PORT}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': req.headers.authorization,
      },
      body: JSON.stringify(body),
    });
    const data = await internalRes.json();

    if (!internalRes.ok) {
      return res.status(internalRes.status).json({ error: data.error || 'AI request failed.' });
    }

    // Extract content from OpenAI-format response
    const content = data?.choices?.[0]?.message?.content || '';
    const casca = data?._casca || {};

    return res.json({
      id: data?.id || `casca-${Date.now()}`,
      content,
      model: casca.model || data?.model || 'unknown',
      classification: casca.cx || 'UNK',
      tokens_used: (data?.usage?.total_tokens) || 0,
      cost_usd: casca.costUsd || 0,
      savings_pct: casca.savingsPct || 0,
      cache_hit: casca.cacheHit || false,
      latency_ms: casca.latencyMs || 0,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Internal routing failed: ' + err.message });
  }
});

/**
 * POST /api/zapier/summarize
 * Action: summarize text (simplified wrapper).
 */
app.post('/api/zapier/summarize', requireApiKey, async (req, res) => {
  const { text, language, bullet_points } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required.' });

  const lang = language || 'English';
  const points = bullet_points || 5;
  const system = `Summarize the following text in ${points} bullet points in ${lang}. Be concise and accurate.`;

  // Reuse /api/zapier/chat internally
  try {
    const chatRes = await fetch(`http://localhost:${PORT}/api/zapier/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({ prompt: text, system_prompt: system, use_case: 'SUMMARIZE' }),
    });
    const data = await chatRes.json();
    return res.status(chatRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/zapier/translate
 * Action: translate text to target language.
 */
app.post('/api/zapier/translate', requireApiKey, async (req, res) => {
  const { text, target_language } = req.body;
  if (!text || !target_language) return res.status(400).json({ error: 'text and target_language are required.' });

  const system = `Translate the following text to ${target_language}. Output only the translation, no explanation.`;
  try {
    const chatRes = await fetch(`http://localhost:${PORT}/api/zapier/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({ prompt: text, system_prompt: system, use_case: 'TRANSLATION', temperature: 0.3 }),
    });
    const data = await chatRes.json();
    return res.status(chatRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/zapier/generate-soql
 * Action: natural language → SOQL query.
 */
app.post('/api/zapier/generate-soql', requireApiKey, async (req, res) => {
  const { query, objects } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required.' });

  const system = `You are a Salesforce SOQL expert. Generate only the SOQL query, no explanation. Available objects: ${objects || 'Standard Objects'}`;
  try {
    const chatRes = await fetch(`http://localhost:${PORT}/api/zapier/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({ prompt: query, system_prompt: system, use_case: 'SOQL_GEN', temperature: 0.1, max_tokens: 500 }),
    });
    const data = await chatRes.json();
    return res.status(chatRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/zapier/extract
 * Action: extract structured data from unstructured text.
 * Input:  { text, schema_description, example_output? }
 * Output: { content (JSON string), extracted (parsed object), model, ... }
 *
 * Uses json_object response_format for models that support it.
 * Classifier will route to HIGH complexity (strong model) automatically.
 */
app.post('/api/zapier/extract', requireApiKey, async (req, res) => {
  const { text, schema_description, example_output } = req.body;
  if (!text)              return res.status(400).json({ error: 'text is required.' });
  if (!schema_description) return res.status(400).json({ error: 'schema_description is required.' });

  let system = `You are a precise data extraction engine. Extract structured data from the provided text and return ONLY valid JSON — no markdown, no explanation, no extra text.\n\nExtract the following fields:\n${schema_description}`;
  if (example_output) {
    system += `\n\nExample output format:\n${example_output}`;
  }
  system += '\n\nIf a field cannot be found in the text, set its value to null.';

  try {
    const chatRes = await fetch(`http://localhost:${PORT}/api/zapier/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({
        prompt:        text,
        system_prompt: system,
        use_case:      'DATA_EXTRACT',
        temperature:   0.1,
        max_tokens:    2048,
      }),
    });
    const data = await chatRes.json();
    if (!chatRes.ok) return res.status(chatRes.status).json(data);

    // Attempt to parse the JSON content for convenience
    let extracted = null;
    try { extracted = JSON.parse(data.content); } catch (_) { /* non-fatal */ }

    return res.json({ ...data, extracted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/zapier/classify
 * Action: classify text into one of the user-defined categories.
 * Input:  { text, categories, multi_label? }
 * Output: { content (label string), category, confidence_hint, model, ... }
 *
 * categories: comma-separated string  e.g. "refund, technical, billing, general"
 * multi_label: boolean — if true, allow multiple labels separated by commas
 */
app.post('/api/zapier/classify', requireApiKey, async (req, res) => {
  const { text, categories, multi_label } = req.body;
  if (!text)       return res.status(400).json({ error: 'text is required.' });
  if (!categories) return res.status(400).json({ error: 'categories is required.' });

  const labelList = categories.split(',').map(c => c.trim()).filter(Boolean);
  const multiMode = multi_label === true || multi_label === 'true';

  const system = multiMode
    ? `You are a text classifier. Classify the text into one or more of these categories: ${labelList.join(', ')}.\nReturn ONLY the matching category labels separated by commas. No explanation, no punctuation, no extra text.`
    : `You are a text classifier. Classify the text into exactly ONE of these categories: ${labelList.join(', ')}.\nReturn ONLY the single category label. No explanation, no punctuation, no extra text.`;

  try {
    const chatRes = await fetch(`http://localhost:${PORT}/api/zapier/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization },
      body: JSON.stringify({
        prompt:        text,
        system_prompt: system,
        use_case:      'CLASSIFY',
        temperature:   0.0,
        max_tokens:    64,
      }),
    });
    const data = await chatRes.json();
    if (!chatRes.ok) return res.status(chatRes.status).json(data);

    // Normalise: trim + validate against known labels
    const raw = (data.content || '').trim();
    const matched = multiMode
      ? raw.split(',').map(l => l.trim()).filter(l => labelList.includes(l))
      : (labelList.includes(raw) ? raw : raw);

    return res.json({
      ...data,
      category: multiMode ? matched.join(', ') : matched,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── Public config endpoint ────────────────────────────────────────
// Returns Supabase public credentials for frontend tools (annotator, dashboard).
// Only exposes ANON key (safe for browser) — never SERVICE key.
app.get('/api/public/config', (_req, res) => {
  const url  = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return res.status(503).json({ error: 'SUPABASE_ANON_KEY not configured in Railway env vars.' });
  }
  res.json({ supabase_url: url, supabase_anon_key: anon });
});

// ════════════════════════════════════════════════════════════════
//  SELF-SERVICE REGISTRATION & TRIAL
// ════════════════════════════════════════════════════════════════

/**
 * POST /api/auth/register
 * Public endpoint — no auth required.
 * Creates Supabase auth user + clients record + 30-day trial + API key.
 * Body: { email, password, company_name? }
 * Returns: { ok, key, trial_ends_at, message }
 */
app.post('/api/auth/register', async (req, res) => {
  const { email, password, company_name } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email and password are required.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  try {
    // Create Supabase auth user (email_confirm: false → sends verification email)
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: false,  // user must verify email before logging in
    });
    if (authErr) {
      if (authErr.message.includes('already registered') || authErr.message.includes('already exists')) {
        return res.status(409).json({ error: 'This email is already registered. Please log in.' });
      }
      return res.status(400).json({ error: authErr.message });
    }

    const userId = authData.user.id;
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 30);
    const trialEndIso = trialEnd.toISOString();

    // Upsert clients record with trial
    await supabase.from('clients').upsert({
      id:             userId,
      email,
      company_name:   company_name || null,
      trial_ends_at:  trialEndIso,
      status:         'active',
      updated_at:     new Date().toISOString(),
    }, { onConflict: 'id' });

    console.log(`[register] new user ${email.replace(/(.{2}).+(@.+)/, '$1***$2')} → ${userId.slice(0, 8)}, trial until ${trialEndIso}`);

    return res.status(201).json({
      ok:            true,
      user_id:       userId,
      trial_ends_at: trialEndIso,
      message:       'Account created. Please check your email to verify your account, then log in to activate your trial and get your API key.',
    });
  } catch (err) {
    console.error('[register] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/trial/apply
 * Requires: Supabase JWT (Bearer token from session).
 * Called after email verification + first login.
 * If user has no active trial: sets trial_ends_at = now + 30 days and generates API key.
 * Returns: { ok, key (shown once only), trial_ends_at, days_remaining }
 */
app.post('/api/trial/apply', requireSupabaseJWT, async (req, res) => {
  const user = req.supabaseUser;

  try {
    // Check if client record exists
    const { data: existing } = await supabase
      .from('clients')
      .select('id, email, trial_ends_at, status')
      .eq('id', user.id)
      .maybeSingle();

    // Block if already has an active (non-expired) trial or paid plan
    if (existing?.trial_ends_at) {
      const trialEnd = new Date(existing.trial_ends_at);
      if (trialEnd > new Date()) {
        return res.status(409).json({
          error: 'You already have an active trial.',
          trial_ends_at: existing.trial_ends_at,
        });
      }
    }

    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 30);
    const trialEndIso = trialEnd.toISOString();

    // Upsert clients record
    const { data: client } = await supabase.from('clients').upsert({
      id:            user.id,
      email:         user.email,
      trial_ends_at: trialEndIso,
      status:        'active',
      updated_at:    new Date().toISOString(),
    }, { onConflict: 'id' }).select('id').single();

    // Generate API key
    const rawKey  = 'csk_' + crypto.randomBytes(20).toString('hex');
    const hash    = hashKey(rawKey);
    const prefix  = rawKey.slice(0, 12);

    const { error: keyErr } = await supabase.from('api_keys').insert({
      client_id:  user.id,
      key_hash:   hash,
      key_prefix: prefix,
      label:      'Trial Key',
      is_active:  true,
    });

    if (keyErr) {
      console.error('[trial/apply] key insert error:', keyErr.message);
      return res.status(500).json({ error: 'Failed to generate API key.' });
    }

    const daysRemaining = Math.ceil((trialEnd - new Date()) / 86_400_000);
    console.log(`[trial/apply] ${user.email.replace(/(.{2}).+(@.+)/, '$1***$2')} → trial until ${trialEndIso}`);

    return res.status(201).json({
      ok:             true,
      key:            rawKey,   // shown once only — client must save it
      prefix,
      trial_ends_at:  trialEndIso,
      days_remaining: daysRemaining,
      message:        'Trial activated. Save your API key now — it will not be shown again.',
    });
  } catch (err) {
    console.error('[trial/apply] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/trial/status
 * Requires: Supabase JWT.
 * Returns current trial status for the logged-in user.
 */
app.get('/api/trial/status', requireSupabaseJWT, async (req, res) => {
  const user = req.supabaseUser;
  const { data: client } = await supabase
    .from('clients')
    .select('id, email, company_name, trial_ends_at, status')
    .eq('id', user.id)
    .maybeSingle();

  // Check existing API keys
  const { data: keys } = await supabase
    .from('api_keys')
    .select('id, key_prefix, label, is_active, created_at')
    .eq('client_id', user.id)
    .eq('is_active', true);

  if (!client) {
    return res.json({ has_account: false, has_trial: false, has_keys: false });
  }

  const now = new Date();
  const trialActive = client.trial_ends_at && new Date(client.trial_ends_at) > now;
  const daysRemaining = client.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(client.trial_ends_at) - now) / 86_400_000))
    : 0;

  return res.json({
    has_account:    true,
    has_trial:      !!client.trial_ends_at,
    trial_active:   trialActive,
    trial_ends_at:  client.trial_ends_at,
    days_remaining: daysRemaining,
    has_keys:       (keys?.length ?? 0) > 0,
    key_count:      keys?.length ?? 0,
    keys:           (keys || []).map(k => ({ id: k.id, prefix: k.key_prefix, label: k.label, created_at: k.created_at })),
  });
});

app.get('/health', (_req, res) => res.json({
  status: 'ok', providers: providerRegistry.size,
  stripe:  !!stripe, ts: new Date().toISOString(),
}));

// ── Prometheus metrics scrape endpoint ───────────────────────────
// Protected: requires x-admin-secret header (same as all admin endpoints)
// Grafana config: add custom header  x-admin-secret: <ADMIN_SECRET>
app.get('/metrics', (req, res, next) => {
  const secret   = process.env.ADMIN_SECRET;
  const provided = req.headers['x-admin-secret'] || req.query.secret;
  if (!secret || provided !== secret)
    return res.status(403).json({ error: 'Forbidden. Provide x-admin-secret header.' });
  next();
}, async (_req, res) => {
  try {
    res.set('Content-Type', promRegistry.contentType);
    res.end(await promRegistry.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ════════════════════════════════════════════════════════════════
//  CORE ENDPOINT: POST /api/v1/chat/completions
// ════════════════════════════════════════════════════════════════
app.post('/api/v1/chat/completions', requireApiKey, rateLimit('chat', RATE_MAX_CHAT), async (req, res) => {
  const t0 = Date.now();
  const { messages, uc, qualityTier, conversationContext } = req.body;
  const client   = req.client;
  const plan     = req.plan;
  const clientId = client.id ?? 'passthrough-anonymous';

  // ── Zero-log mode: X-Casca-Log: false → skip all DB logging ──
  const noLog = (req.headers['x-casca-log'] || '').toLowerCase() === 'false';

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: '`messages` array is required.' });

  // ── Bypass mode: skip classification, route direct to default OpenAI provider ──
  // Used by the Demo Terminal when "Casca Engine OFF" to keep API keys server-side.
  if (req.body.bypass === true) {
    // Find best OpenAI/GPT-4o provider
    const bypassProvider =
      providerRegistry.get('gpt-4o') ??
      [...providerRegistry.values()].find(p => p.model_name?.includes('gpt-4o')) ??
      [...providerRegistry.values()][0] ??
      null;

    if (!bypassProvider)
      return res.status(503).json({ error: 'No provider available for bypass mode.' });

    const { responseText, tokensIn, tokensOut, statusCode, latencyMs, error: llmErr }
      = await callLLM(bypassProvider, messages);

    if (llmErr || !responseText)
      return res.status(statusCode >= 400 ? statusCode : 502).json({ error: llmErr ?? 'Empty response.' });

    let payload;
    try { payload = JSON.parse(responseText); }
    catch { payload = { choices: [{ message: { role: 'assistant', content: responseText } }] }; }

    payload._casca = {
      bypass:    true,
      cx:        null,
      model:     bypassProvider.model_name ?? 'gpt-4o',
      cacheHit:  false,
      costUsd:   ((tokensIn + tokensOut) / 1_000_000) * (bypassProvider.cost_per_1m_tokens || 5.0),
      savingsPct: 0,
      latencyMs,
      rule:      'BYPASS — Casca Engine OFF',
    };
    // SDK compatibility: top-level fields for CascaClient.cls
    payload.casca_cx = payload._casca?.cx ?? null;
    payload.casca_cache_hit = payload._casca?.cacheHit ?? false;
    return res.json(payload);
  }
  // ── End bypass ───────────────────────────────────────────────

  const lastUser   = [...messages].reverse().find(m => m.role === 'user');
  const { promptText, hasAttachment } = injectAttachmentContext(messages);
  if (!promptText || typeof promptText !== 'string')
    return res.status(400).json({ error: 'No user message content.' });

  const normalized = normalizePrompt(promptText);
  const promptHash = sha256(normalized);

  // ── Step 2: L1 Cache Check ──────────────────────────────────
  const now = new Date().toISOString();
  const { data: cacheRow } = await supabase
    .from('tenant_cache_pool')
    .select('id, response_text, model_used, cx, original_cost_usd, hit_count')
    .eq('client_id', clientId)
    .eq('prompt_hash', promptHash)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .maybeSingle();

  if (cacheRow) {
    // ── CACHE HIT → free, skip billing ────────────────────────
    const latencyMs = Date.now() - t0;
    supabase.rpc('record_cache_hit', {
      p_client_id: clientId, p_hash: promptHash, p_saved_usd: cacheRow.original_cost_usd || 0,
    }).then(() => {});

    let payload;
    try { payload = JSON.parse(cacheRow.response_text); }
    catch { payload = { choices: [{ message: { role: 'assistant', content: cacheRow.response_text } }] }; }

    payload._casca = {
      cx: cacheRow.cx ?? 'LOW', model: cacheRow.model_used ?? 'cache',
      cacheHit: true, hitCount: (cacheRow.hit_count || 0) + 1,
      costUsd: 0, savingsPct: 100, latencyMs,
      billing: { tokensCharged: 0, overageDeducted: 0 },
    };
    // SDK compatibility: top-level fields for CascaClient.cls
    payload.casca_cx = payload._casca?.cx ?? null;
    payload.casca_cache_hit = payload._casca?.cacheHit ?? false;
    res.json(payload);

    enqueuePostProcess({
      clientId, planId: plan?.id, overageRate: plan?.overage_rate_per_1m,
      promptHash, normalizedPrompt: normalized,
      classifyResult: { cx: cacheRow.cx ?? 'LOW', originalCx: cacheRow.cx ?? 'LOW',
        rule: 'L1-CACHE-HIT', lang: 'UNK', modal: 'text', autoLearn: false },
      provider: null, responseText: null, tokensIn: 0, tokensOut: 0,
      costUsd: 0, savingsPct: 100, isCache: true, latencyMs, statusCode: 200,
      errorMessage: null, uc, noLog,
    });
    return;
  }

  // ── Step 2.5: Billing Gate (pre-LLM) ────────────────────────
  // Passthrough mode: client pays LLM directly → skip Casca billing gate.
  // Casca only charges classification fee (future: separate quota counter).
  const gate = req.isPassthrough
    ? { allowed: true, isOverage: false }
    : checkBillingGate(client, plan);
  if (!gate.allowed) {
    return res.status(gate.status).json(gate.body);
  }

  // ── Step 3: Classify → Route ─────────────────────────────────
  let classifyResult;
  try {
    classifyResult = cascaRoute(
      promptText, uc || 'general', qualityTier || 'default', conversationContext || null,
    );
  } catch (err) {
    console.error('[casca] classify:', err);
    return res.status(500).json({ error: 'Classification engine error.' });
  }

  // ── Step 3.5: Attachment intent override ─────────────────────
  // For lazy prompts with attachments (e.g. "幫我抓蟲" + screenshot),
  // the modal tag routes to MED but the intent clearly warrants HIGH.
  // overrideByIntent() catches debug / security / financial analysis cases.
  if (hasAttachment) {
    const overrideCx = overrideByIntent(promptText, classifyResult);
    if (overrideCx !== classifyResult.cx) {
      console.log(`[casca] intent override: ${classifyResult.cx}→${overrideCx} (${classifyResult.rule})`);
      classifyResult = { ...classifyResult, cx: overrideCx, originalCx: classifyResult.cx,
                         rule: classifyResult.rule + ' [intent-override→HIGH]' };
    }
  }

  // ── Map cx → compatible model for passthrough key type ───────
  // classifyResult.model may point to Gemini/Mixtral which OpenAI can't serve.
  // Override with a model compatible with the client's key provider.
  const PASSTHROUGH_MODEL_MAP = {
    passthrough_openai: {
      LOW:   'gpt-4o-mini',
      MED:   'gpt-4o-mini',
      HIGH:  'gpt-4o',
      AMBIG: 'gpt-4o-mini',
    },
    passthrough_anthropic: {
      LOW:   'claude-3-haiku-20240307',
      MED:   'claude-3-haiku-20240307',
      HIGH:  'claude-3-5-sonnet-20241022',
      AMBIG: 'claude-3-haiku-20240307',
    },
    passthrough_google: {
      LOW:   'gemini-2.0-flash-exp',
      MED:   'gemini-2.0-flash-exp',
      HIGH:  'gemini-1.5-pro',
      AMBIG: 'gemini-2.0-flash-exp',
    },
  };

  const targetModel = req.isPassthrough
    ? (PASSTHROUGH_MODEL_MAP[req.passthroughStage]?.[classifyResult.cx] ?? classifyResult.model)
    : classifyResult.model;

  // ════════════════════════════════════════════════════════════
  //  PROVIDER SELECTION — Stage 1/2 vs Stage 3
  // ════════════════════════════════════════════════════════════

  let provider = null;
  let providerSource = 'casca';

  if (req.isPassthrough) {
    // ── Stage 1/2: PASSTHROUGH ──────────────────────────────────
    // Use client's own LLM key (from Authorization header).
    // Casca classifies + substitutes model name.
    // LLM request goes to client's own OpenAI/Google/Anthropic account.
    // Client sees the cost on their own LLM bill, not Casca's.
    provider = passthroughProviderConfig(req.passthroughKey, req.passthroughStage, targetModel);
    providerSource = 'client';

    if (!provider) {
      return res.status(503).json({
        error:  `Unsupported passthrough provider for stage: ${req.passthroughStage}`,
        cx:     classifyResult.cx,
      });
    }

    console.log(`[casca] passthrough → ${targetModel} via client's ${provider.provider_name} key`);

  } else {
    // ── Stage 3 / Demo: MANAGED ─────────────────────────────────
    // Use Casca Admin-configured LLM key from providerRegistry.
    // Fallback order:
    //   1. Exact model name match
    //   2. Exact tier match
    //   3. ANY tier provider
    //   4. Upgrade: LOW→MED→HIGH (never downgrade quality)
    //   5. Any active provider (last resort)
    const allProviders = [...providerRegistry.values()];
    const cx = classifyResult.cx;

    const tierUpgrade = { LOW: ['LOW','MED','HIGH'], MED: ['MED','HIGH'], HIGH: ['HIGH'], AMBIG: ['MED','HIGH','LOW'] };
    const upgradeOrder = tierUpgrade[cx] || ['LOW','MED','HIGH'];

    provider =
      // 1. Exact model name
      providerRegistry.get(targetModel) ??
      // 2. Exact tier
      allProviders.find(p => p.tier_capability === cx) ??
      // 3. ANY tier
      allProviders.find(p => p.tier_capability === 'ANY') ??
      // 4. Upgrade through tiers
      upgradeOrder.reduce((found, t) =>
        found ?? allProviders.find(p => p.tier_capability === t), null) ??
      // 5. Absolute last resort
      allProviders[0] ??
      null;

    providerSource = 'casca';

    if (!provider) {
      return res.status(503).json({
        error: 'No active providers available. Please enable at least one LLM Provider in Admin.',
        cx,
      });
    }

    if (provider.tier_capability !== cx && provider.tier_capability !== 'ANY') {
      console.log(`[casca] managed → tier ${cx} unavailable, upgraded to ${provider.tier_capability} (${provider.model_name})`);
    } else {
      console.log(`[casca] managed → ${targetModel} via Casca ${provider.provider_name} key`);
    }
  }

  const { responseText, tokensIn, tokensOut, statusCode, latencyMs, error: llmErr }
    = await callLLM(provider, messages);

  const totalTokens = tokensIn + tokensOut;
  // Passthrough: client pays LLM directly → Casca cost = 0
  // Managed:     Casca pays LLM → cost tracked for billing
  const costUsd    = req.isPassthrough
    ? 0
    : (totalTokens / 1_000_000) * (provider.cost_per_1m_tokens || 0);
  const baseCost   = (totalTokens / 1_000_000) * 5.0; // GPT-4o baseline for savings display
  const savingsPct = baseCost > 0 ? Math.max(0, Math.round(((baseCost - costUsd) / baseCost) * 100)) : 0;

  if (llmErr || !responseText) {
    res.status(statusCode >= 400 ? statusCode : 502).json({ error: llmErr ?? 'Empty LLM response.' });
    enqueuePostProcess({
      clientId, planId: plan?.id, overageRate: plan?.overage_rate_per_1m,
      promptHash, normalizedPrompt: normalized,
      classifyResult, provider, responseText: null, tokensIn, tokensOut,
      costUsd, savingsPct, isCache: false, latencyMs: Date.now() - t0,
      statusCode, errorMessage: llmErr, uc, noLog,
    });
    return;
  }

  let payload;
  try { payload = JSON.parse(responseText); }
  catch { payload = { choices: [{ message: { role: 'assistant', content: responseText } }] }; }

  // Compute expected billing info for response transparency
  const includedTokens = (plan?.included_m_tokens || 0) * 1_000_000;
  const usedAfter      = (client.cycle_used_tokens || 0) + totalTokens;
  const overageTokens  = Math.max(0, usedAfter - includedTokens);
  const overageCost    = (overageTokens / 1_000_000) * (plan?.overage_rate_per_1m || 0);

  payload._casca = {
    cx:          classifyResult.cx,
    model:       provider.model_name,
    cacheHit:    false,
    stage:       req.isPassthrough ? 'passthrough' : 'managed',
    providerSource,
    costUsd,
    savingsPct,
    latencyMs:   Date.now() - t0,
    rule:        classifyResult.rule,
    lang:        classifyResult.lang,
    autoLearn:   classifyResult.autoLearn,
    tokensIn,
    tokensOut,
    billing: req.isPassthrough
      ? { note: 'LLM cost billed directly by your provider. Casca charges classification fee only.' }
      : {
          tokensCharged:   totalTokens,
          isOverage:       gate.isOverage || false,
          overageTokens,
          overageDeducted: parseFloat(overageCost.toFixed(6)),
        },
  };

  // SDK compatibility: top-level fields for CascaClient.cls
  payload.casca_cx = payload._casca?.cx ?? null;
  payload.casca_cache_hit = payload._casca?.cacheHit ?? false;

  res.json(payload);

  enqueuePostProcess({
    clientId, planId: plan?.id, overageRate: plan?.overage_rate_per_1m,
    promptHash, normalizedPrompt: normalized,
    classifyResult, provider, responseText, tokensIn, tokensOut,
    costUsd, savingsPct, isCache: false, latencyMs: Date.now() - t0,
    statusCode, errorMessage: null, uc, noLog,
  });
});

// ── /api/route — backward-compatible alias ────────────────────────
app.post('/api/route', requireApiKey, async (req, res, next) => {
  if (!req.body.messages && req.body.prompt)
    req.body.messages = [{ role: 'user', content: req.body.prompt }];
  req.url = '/api/v1/chat/completions';
  app._router.handle(req, res, next);
});

// ════════════════════════════════════════════════════════════════
//  BILLING ENDPOINTS
// ════════════════════════════════════════════════════════════════

/** POST /api/billing/subscribe — Stripe Checkout for plan subscription */
app.post('/api/billing/subscribe', requireApiKey, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured.' });

  const { plan_id } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'plan_id is required.' });

  const { data: plan, error: planErr } = await supabase
    .from('subscription_plans')
    .select('id, name, monthly_fee_usd, included_m_tokens, stripe_price_id')
    .eq('id', plan_id)
    .eq('is_active', true)
    .single();

  if (planErr || !plan) return res.status(404).json({ error: 'Plan not found.' });

  const client = req.client;

  // Create or retrieve Stripe customer
  let stripeCustomerId = client.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email:    client.email,
      metadata: { casca_client_id: client.id },
    });
    stripeCustomerId = customer.id;
    await supabase.from('clients').update({ stripe_customer_id: stripeCustomerId })
      .eq('id', client.id);
  }

  // Build line items:
  // If plan has a stripe_price_id (pre-created in Stripe Dashboard), use it.
  // Otherwise create a one-time ad-hoc price.
  let lineItems;
  if (plan.stripe_price_id) {
    lineItems = [{ price: plan.stripe_price_id, quantity: 1 }];
  } else {
    lineItems = [{
      price_data: {
        currency:    'usd',
        unit_amount: Math.round(plan.monthly_fee_usd * 100),
        recurring:   { interval: 'month' },
        product_data: { name: `Casca ${plan.name} Plan` },
      },
      quantity: 1,
    }];
  }

  const session = await stripe.checkout.sessions.create({
    mode:               'subscription',
    customer:           stripeCustomerId,
    line_items:         lineItems,
    success_url:        `${FRONTEND_URL}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:         `${FRONTEND_URL}/dashboard?billing=cancelled`,
    metadata: {
      client_id: client.id,
      plan_id,
      type:      'subscription',
    },
  });

  return res.json({ url: session.url, sessionId: session.id });
});

/** POST /api/billing/topup — Stripe Checkout for balance top-up */
app.post('/api/billing/topup', requireApiKey, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured.' });

  const amountUsd = parseFloat(req.body.amount_usd || '50');
  if (isNaN(amountUsd) || amountUsd < 5 || amountUsd > 10000)
    return res.status(400).json({ error: 'amount_usd must be between 5 and 10000.' });

  const client = req.client;

  // Create or retrieve Stripe customer
  let stripeCustomerId = client.stripe_customer_id;
  if (!stripeCustomerId) {
    const customer = await stripe.customers.create({
      email:    client.email,
      metadata: { casca_client_id: client.id },
    });
    stripeCustomerId = customer.id;
    await supabase.from('clients').update({ stripe_customer_id: stripeCustomerId })
      .eq('id', client.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode:     'payment',
    customer: stripeCustomerId,
    line_items: [{
      price_data: {
        currency:    'usd',
        unit_amount: Math.round(amountUsd * 100),
        product_data: {
          name:        'Casca Credit Top-up',
          description: `$${amountUsd.toFixed(2)} overage balance`,
        },
      },
      quantity: 1,
    }],
    success_url: `${FRONTEND_URL}/dashboard?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${FRONTEND_URL}/dashboard?topup=cancelled`,
    metadata: {
      client_id: client.id,
      type:      'topup',
      amount_usd: amountUsd.toString(),
    },
  });

  return res.json({ url: session.url, sessionId: session.id });
});

/** GET /api/billing/transactions — client's payment history */
app.get('/api/billing/transactions', requireApiKey, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '20', 10), 100);
  const { data, error } = await supabase
    .from('transactions')
    .select('id, amount_usd, type, status, description, created_at')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ transactions: data });
});

// ════════════════════════════════════════════════════════════════
//  API KEY MANAGEMENT
// ════════════════════════════════════════════════════════════════
function hashKey(raw) { return sha256(raw); }

app.get('/api/dashboard/keys', requireApiKey, async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_prefix, label, is_active, last_used_at, created_at, client_id, clients(email)')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const keys = (data || []).map(k => ({ ...k, email: k.clients?.email || null, clients: undefined }));
  return res.json({ keys });
});

app.post('/api/dashboard/keys', requireApiKey, async (req, res) => {
  const { label } = req.body;
  const rawKey = 'csk_' + crypto.randomBytes(20).toString('hex');
  const hash   = hashKey(rawKey);
  const prefix = rawKey.slice(0, 12);

  const { error } = await supabase.from('api_keys').insert({
    client_id: req.client.id,
    key_hash:  hash,
    key_prefix: prefix,
    label:     label || null,
    is_active: true,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({
    message: 'API key created. Save it now — it will not be shown again.',
    key: rawKey, prefix, label: label || null,
  });
});

/** PATCH /api/dashboard/keys/:id — enable/disable a key */
app.patch('/api/dashboard/keys/:id', requireApiKey, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be boolean.' });
  const { error } = await supabase
    .from('api_keys')
    .update({ is_active })
    .eq('id', id)
    .eq('client_id', req.client.id);  // ensure ownership
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id, is_active });
});

// ════════════════════════════════════════════════════════════════
//  DASHBOARD ENDPOINTS
// ════════════════════════════════════════════════════════════════

/** GET /api/dashboard/me — account info with plan and billing state */
app.get('/api/dashboard/me', requireApiKey, async (req, res) => {
  const client = req.client;
  const plan   = req.plan;

  // Compute billing metrics
  const includedTokens = (plan?.included_m_tokens || 0) * 1_000_000;
  const usedTokens     = client.cycle_used_tokens || 0;
  const remainingTokens = Math.max(0, includedTokens - usedTokens);
  const quotaPct        = includedTokens > 0
    ? Math.min(100, (usedTokens / includedTokens * 100)).toFixed(1)
    : 100;

  return res.json({
    id:                  client.id,
    email:               client.email,
    company_name:        client.company_name,
    // ── Flat convenience fields (for Dashboard billing page) ──
    plan_id:             plan?.id ?? null,
    plan_name:           plan?.name ?? 'Free',
    monthly_fee_usd:     plan?.monthly_fee_usd ?? 0,
    included_m_tokens:   plan?.included_m_tokens ?? 0,
    overage_rate_per_1m: plan?.overage_rate_per_1m ?? 0,
    cycle_used_tokens:   usedTokens,
    balance_credits:     client.balance_credits ?? 0,
    // ── Nested (backward compat) ──
    plan: plan ? {
      id:                  plan.id,
      name:                plan.name,
      monthly_fee_usd:     plan.monthly_fee_usd,
      included_m_tokens:   plan.included_m_tokens,
      overage_rate_per_1m: plan.overage_rate_per_1m,
    } : null,
    billing: {
      cycle_used_tokens:  usedTokens,
      cycle_remaining:    remainingTokens,
      quota_pct:          parseFloat(quotaPct),
      balance_credits:    client.balance_credits,
      billing_cycle_start: client.billing_cycle_start,
      is_overquota:       usedTokens >= includedTokens,
    },
    stripe: {
      customer_id: client.stripe_customer_id,
      sub_id:      client.stripe_sub_id,
    },
    trial: client.trial_ends_at ? {
      is_trial:       true,
      trial_ends_at:  client.trial_ends_at,
      days_remaining: Math.max(0, Math.ceil((new Date(client.trial_ends_at) - Date.now()) / 86_400_000)),
      hours_remaining:Math.max(0, Math.ceil((new Date(client.trial_ends_at) - Date.now()) / 3_600_000)),
      expired:        new Date(client.trial_ends_at) < new Date(),
    } : { is_trial: false },
  });
});

app.get('/api/dashboard/logs', requireApiKey, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const { data, count, error } = await supabase.from('api_logs')
    .select('id,cx,model_name,tokens_in,tokens_out,cost_usd,savings_pct,is_cache_hit,lang,rule,auto_learn,latency_ms,status_code,created_at', { count: 'exact' })
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  const cacheHits = (data || []).filter(l => l.is_cache_hit).length;
  const totalCost = (data || []).reduce((s, l) => s + (l.cost_usd || 0), 0);
  const totalTokensSaved = (data || [])
    .filter(l => l.is_cache_hit)
    .reduce((s, l) => s + ((l.tokens_in || 0) + (l.tokens_out || 0)), 0);
  return res.json({ logs: data, total: count, cacheHits, totalCost, totalTokensSaved });
});

app.get('/api/dashboard/cache', requireApiKey, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const { data, count, error } = await supabase.from('tenant_cache_pool')
    .select('id,normalized_prompt,model_used,cx,hit_count,original_cost_usd,total_saved_usd,last_accessed_at,expires_at,created_at', { count: 'exact' })
    .eq('client_id', req.client.id)
    .order('hit_count', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ entries: data, total: count });
});

app.delete('/api/dashboard/cache/:id', requireApiKey, async (req, res) => {
  const { error } = await supabase.from('tenant_cache_pool')
    .delete().eq('id', req.params.id).eq('client_id', req.client.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

app.delete('/api/dashboard/cache', requireApiKey, async (req, res) => {
  const { error } = await supabase.from('tenant_cache_pool').delete().eq('client_id', req.client.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: 'All cache entries flushed.' });
});

// ════════════════════════════════════════════════════════════════
//  ADMIN: SUBSCRIPTION PLANS CRUD
// ════════════════════════════════════════════════════════════════

/** GET /api/admin/plans */
app.get('/api/admin/plans', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('subscription_plans')
    .select('*').order('monthly_fee_usd');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ plans: data });
});

/** POST /api/admin/plans — create a new plan */
app.post('/api/admin/plans', requireAdmin, async (req, res) => {
  const { name, monthly_fee_usd, included_m_tokens, overage_rate_per_1m, stripe_price_id } = req.body;
  if (!name || monthly_fee_usd == null || !included_m_tokens)
    return res.status(400).json({ error: 'name, monthly_fee_usd, included_m_tokens required.' });

  const { data, error } = await supabase.from('subscription_plans')
    .insert({ name, monthly_fee_usd, included_m_tokens,
              overage_rate_per_1m: overage_rate_per_1m || 1.00,
              stripe_price_id: stripe_price_id || null,
              is_active: true })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ plan: data });
});

/** PATCH /api/admin/plans/:id — update pricing (effective immediately for new billing cycles) */
app.patch('/api/admin/plans/:id', requireAdmin, async (req, res) => {
  const allowed = ['name','monthly_fee_usd','included_m_tokens',
                   'overage_rate_per_1m','stripe_price_id','is_active'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase.from('subscription_plans')
    .update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ plan: data });
});

/** DELETE /api/admin/plans/:id — soft-delete (set is_active=false) */
app.delete('/api/admin/plans/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('subscription_plans')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: 'Plan deactivated (existing subscribers unaffected).' });
});

// ════════════════════════════════════════════════════════════════
//  ADMIN: LLM PROVIDERS
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/providers', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('llm_providers')
    .select('*').order('tier_capability').order('priority');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ providers: data });
});

app.post('/api/admin/providers', requireAdmin, async (req, res) => {
  const { provider_name, model_name, display_name, base_url,
          api_key_enc, cost_per_1m_tokens, tier_capability,
          context_window, supports_vision, priority } = req.body;
  if (!provider_name || !model_name || !base_url || !tier_capability)
    return res.status(400).json({ error: 'provider_name, model_name, base_url, tier_capability required.' });
  const { data, error } = await supabase.from('llm_providers')
    .insert({ provider_name, model_name, display_name, base_url, api_key_enc,
              cost_per_1m_tokens: cost_per_1m_tokens || 0, tier_capability,
              context_window, supports_vision: !!supports_vision,
              priority: priority ?? 50, is_active: true })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await loadProviders();
  return res.status(201).json({ provider: data, message: 'Provider added, engine reloaded.' });
});

app.patch('/api/admin/providers/:id', requireAdmin, async (req, res) => {
  const allowed = ['api_key_enc','cost_per_1m_tokens','tier_capability',
                   'is_active','priority','display_name','supports_vision'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('llm_providers')
    .update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  await loadProviders();
  return res.json({ provider: data, message: 'Provider updated, engine reloaded.' });
});

app.post('/api/admin/reload-providers', requireAdmin, async (req, res) => {
  await loadProviders();
  return res.json({ message: 'Reloaded.', count: providerRegistry.size, models: [...providerRegistry.keys()] });
});

// ════════════════════════════════════════════════════════════════
//  ADMIN: ANNOTATION & STATS
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/queue', requireAdmin, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const { data, count, error } = await supabase.from('annotation_queue')
    .select('id,prompt,predicted_cx,triggered_rule,lang,uc,created_at', { count: 'exact' })
    .eq('status', 'pending').order('created_at').range(offset, offset + limit - 1);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data, total: count });
});

app.post('/api/admin/annotate', requireAdmin, async (req, res) => {
  const { id, confirmedCx } = req.body;
  if (!id || !['LOW','MED','HIGH','AMBIG'].includes(confirmedCx))
    return res.status(400).json({ error: 'id and confirmedCx required.' });
  const { error } = await supabase.from('annotation_queue')
    .update({ confirmed_cx: confirmedCx, status: 'done', annotated_at: new Date().toISOString() })
    .eq('id', id).eq('status', 'pending');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

app.get('/api/admin/export', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('annotation_queue')
    .select('id,prompt,predicted_cx,confirmed_cx,triggered_rule,lang,uc,annotated_at')
    .eq('status', 'done').order('annotated_at');
  if (error) return res.status(500).json({ error: error.message });
  if (!data?.length) return res.status(404).json({ error: 'No labelled data yet.' });
  const esc = v => { if (!v) return ''; const s = String(v).replace(/"/g,'""'); return /[,"\n]/.test(s)?`"${s}"`:s; };
  const cols = ['id','prompt','predicted_cx','confirmed_cx','triggered_rule','lang','uc','annotated_at'];
  const csv  = [cols.join(','), ...data.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="casca_training_${new Date().toISOString().slice(0,10)}.csv"`);
  return res.send(csv);
});

// ════════════════════════════════════════════════════════════════
//  ADMIN — CUSTOMERS CRUD
// ════════════════════════════════════════════════════════════════

app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const { data: clients, error } = await supabase
      .from('clients')
      .select(`id, email, company_name, plan_id, status, is_admin,
        balance_credits, quota_limit, quota_used, cycle_used_tokens,
        api_key, stripe_customer_id, trial_ends_at, renewal_date,
        created_at, updated_at,
        subscription_plans ( name, monthly_fee_usd, included_m_tokens )`)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const { data: logs } = await supabase
      .from('api_logs')
      .select('client_id, cost_usd, is_cache_hit')
      .gte('created_at', since.toISOString());

    const statsMap = {};
    for (const log of (logs || [])) {
      if (!statsMap[log.client_id]) statsMap[log.client_id] = { requests_count: 0, total_cost_usd: 0, cache_hits: 0 };
      statsMap[log.client_id].requests_count++;
      statsMap[log.client_id].total_cost_usd += parseFloat(log.cost_usd || 0);
      if (log.is_cache_hit) statsMap[log.client_id].cache_hits++;
    }

    const customers = (clients || []).map(c => {
      const s = statsMap[c.id] || { requests_count: 0, total_cost_usd: 0, cache_hits: 0 };
      const baselineCost = s.total_cost_usd * 1.8;
      return {
        id: c.id, email: c.email, company_name: c.company_name,
        name: c.company_name || c.email?.split('@')[0] || '—',
        plan: c.subscription_plans?.name || 'Free',
        status: c.status || 'active', is_admin: c.is_admin,
        balance_credits: c.balance_credits, quota_limit: c.quota_limit,
        quota_used: c.quota_used, cycle_used_tokens: c.cycle_used_tokens,
        api_key_prefix: c.api_key ? c.api_key.slice(0, 12) + '…' : '—',
        stripe_customer_id: c.stripe_customer_id,
        trial_ends_at: c.trial_ends_at, renewal_date: c.renewal_date, created_at: c.created_at,
        requests_count: s.requests_count,
        total_cost_usd: +s.total_cost_usd.toFixed(4),
        total_savings_usd: +(Math.max(0, baselineCost - s.total_cost_usd)).toFixed(4),
        cache_hits: s.cache_hits,
        platform_fee_usd: c.subscription_plans?.monthly_fee_usd || 0,
        providers: [],
      };
    });
    return res.json({ customers, total: customers.length });
  } catch (err) {
    console.error('[admin] customers error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/customers', requireAdmin, async (req, res) => {
  const { email, password, company_name, plan } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required.' });
  try {
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (authErr) return res.status(400).json({ error: authErr.message });
    const userId = authData.user.id;
    const updates = {};
    if (company_name) updates.company_name = company_name;
    if (plan) updates.plan = plan;
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      await supabase.from('clients').update(updates).eq('id', userId);
    }
    const { data: client } = await supabase.from('clients')
      .select('id, email, company_name, api_key, status, created_at').eq('id', userId).single();
    console.log(`[admin] customer created: ${email.replace(/(.{2}).+(@.+)/, '$1***$2')} → ${userId.slice(0, 8)}`);
    return res.status(201).json({ ok: true, customer: client });
  } catch (err) {
    console.error('[admin] create customer error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const allowed = ['company_name', 'status', 'plan_id', 'is_admin', 'balance_credits', 'quota_limit'];
  const updates = {};
  for (const key of allowed) { if (req.body[key] !== undefined) updates[key] = req.body[key]; }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update.' });
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('clients').update(updates).eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  console.log(`[admin] customer ${id.slice(0, 8)} updated:`, Object.keys(updates).join(', '));
  return res.json({ ok: true, id, updated: Object.keys(updates) });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const since = new Date(); since.setDate(since.getDate() - 30);
  const [logsRes, queueRes, cacheRes, txRes] = await Promise.all([
    supabase.from('api_logs').select('is_cache_hit,cost_usd,status_code', { count: 'exact' }).gte('created_at', since.toISOString()),
    supabase.from('annotation_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('tenant_cache_pool').select('hit_count,total_saved_usd', { count: 'exact' }),
    supabase.from('transactions').select('amount_usd,type').eq('status','completed').gte('created_at', since.toISOString()),
  ]);
  const logs    = logsRes.data || [];
  const total   = logsRes.count || 0;
  const hits    = logs.filter(l => l.is_cache_hit).length;
  const success = logs.filter(l => l.is_cache_hit || (l.status_code >= 200 && l.status_code < 300)).length;
  const totalSaved   = (cacheRes.data || []).reduce((s, r) => s + (r.total_saved_usd || 0), 0);
  const mrrFromSubs  = (txRes.data || []).filter(t => t.type === 'subscription').reduce((s, t) => s + t.amount_usd, 0);
  const creditsSold  = (txRes.data || []).filter(t => t.type === 'topup').reduce((s, t) => s + t.amount_usd, 0);
  return res.json({
    period: '30d', totalRequests: total,
    cacheHitRate:      total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '0%',
    successRate:       total > 0 ? ((success / total) * 100).toFixed(1) + '%' : '—',
    totalCostUsd:      (logs.reduce((s, l) => s + (l.cost_usd || 0), 0)).toFixed(4),
    totalSavedUsd:     totalSaved.toFixed(4),
    pendingAnnotations: queueRes.count || 0,
    activeCacheEntries: cacheRes.count || 0,
    activeProviders:   providerRegistry.size,
    revenue:           { subscriptions: mrrFromSubs.toFixed(2), credits: creditsSold.toFixed(2) },
  });
});

// ════════════════════════════════════════════════════════════════
//  ADMIN — TRIAL MANAGEMENT
// ════════════════════════════════════════════════════════════════

/**
 * POST /api/admin/trial/extend
 * Body: { client_id }   — extend trial by 1 month (same API key continues working)
 * - If still in trial: trial_ends_at + 1 month
 * - If expired or no trial: from NOW() + 1 month, plan reset to Pro
 */
app.post('/api/admin/trial/extend', requireAdmin, async (req, res) => {
  const { client_id } = req.body;
  if (!client_id) return res.status(400).json({ error: 'client_id is required.' });

  const { data: newEnd, error } = await supabase.rpc('extend_trial', {
    p_client_id: client_id,
  });

  if (error) {
    console.error('[trial] extend error:', error);
    return res.status(500).json({ error: error.message });
  }

  // Fetch updated client for confirmation
  const { data: client } = await supabase
    .from('clients')
    .select('id, email, company_name, trial_ends_at, plan_id, subscription_plans(name)')
    .eq('id', client_id)
    .single();

  console.log(`[trial] extended → client ${client_id.slice(0,8)} until ${newEnd}`);

  return res.json({
    ok: true,
    client_id,
    email:         client?.email,
    company_name:  client?.company_name,
    trial_ends_at: newEnd,
    plan:          client?.subscription_plans?.name ?? 'Pro',
    message:       `Trial extended until ${new Date(newEnd).toISOString()}`,
  });
});

/**
 * GET /api/admin/trial/list
 * Returns all active trial accounts with time remaining
 */
app.get('/api/admin/trial/list', requireAdmin, async (req, res) => {
  const now = new Date().toISOString();

  const { data: active, error: e1 } = await supabase
    .from('clients')
    .select('id, email, company_name, trial_ends_at, created_at, cycle_used_tokens, subscription_plans(name)')
    .not('trial_ends_at', 'is', null)
    .gt('trial_ends_at', now)
    .order('trial_ends_at', { ascending: true });

  const { data: expired, error: e2 } = await supabase
    .from('clients')
    .select('id, email, company_name, trial_ends_at, created_at, subscription_plans(name)')
    .not('trial_ends_at', 'is', null)
    .lte('trial_ends_at', now)
    .order('trial_ends_at', { ascending: false })
    .limit(20);

  if (e1) return res.status(500).json({ error: e1.message });

  const nowMs = Date.now();
  const withRemaining = (active || []).map(c => ({
    ...c,
    plan:               c.subscription_plans?.name ?? '—',
    days_remaining:     Math.max(0, Math.ceil((new Date(c.trial_ends_at) - nowMs) / 86_400_000)),
    hours_remaining:    Math.max(0, Math.ceil((new Date(c.trial_ends_at) - nowMs) / 3_600_000)),
  }));

  return res.json({
    active_trials:  withRemaining,
    expired_trials: (expired || []).map(c => ({ ...c, plan: c.subscription_plans?.name ?? '—' })),
    active_count:   withRemaining.length,
    expired_count:  (expired || []).length,
    server_time_utc: now,
  });
});

/**
 * POST /api/admin/trial/expire-now
 * Manually trigger expire_trials() — useful before pg_cron is set up
 */
app.post('/api/admin/trial/expire-now', requireAdmin, async (req, res) => {
  const { data: count, error } = await supabase.rpc('expire_trials');
  if (error) return res.status(500).json({ error: error.message });
  console.log(`[trial] manual expire run → ${count} accounts downgraded`);
  return res.json({ ok: true, expired_count: count, server_time_utc: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════════
//  SERVER-SIDE TRIAL EXPIRY CRON
//  Runs every hour as a fallback when pg_cron is not available.
//  If pg_cron IS configured in Supabase, this is harmless redundancy.
// ════════════════════════════════════════════════════════════════
const TRIAL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ════════════════════════════════════════════════════════════════
//  ADMIN — API KEY MANAGEMENT
//  Used by casca-admin.html (Supabase JWT + x-admin-secret auth)
// ════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/keys
 * List all API keys (optionally filter by client_id or email)
 */
app.get('/api/admin/keys', requireAdmin, async (req, res) => {
  const { client_id, email } = req.query;

  let query = supabase
    .from('api_keys')
    .select('id, key_prefix, label, is_active, last_used_at, created_at, client_id, clients(email, company_name)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (client_id) query = query.eq('client_id', client_id);

  if (email) {
    // Look up client_id by email first
    const { data: cl } = await supabase
      .from('clients').select('id').eq('email', email).maybeSingle();
    if (!cl) return res.json({ keys: [] });
    query = query.eq('client_id', cl.id);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const keys = (data || []).map(k => ({
    ...k,
    email:        k.clients?.email        ?? null,
    company_name: k.clients?.company_name ?? null,
    clients: undefined,
  }));
  return res.json({ keys, total: keys.length });
});

/**
 * POST /api/admin/keys
 * Generate a new API key for a client (identified by email or client_id)
 * Body: { email?, client_id?, label? }
 */
app.post('/api/admin/keys', requireAdmin, async (req, res) => {
  const { email, client_id, label } = req.body;

  let targetClientId = client_id;

  // Resolve by email if client_id not given
  if (!targetClientId && email) {
    const { data: cl } = await supabase
      .from('clients').select('id').eq('email', email).maybeSingle();
    if (!cl) return res.status(404).json({ error: `No client found for email: ${email}` });
    targetClientId = cl.id;
  }

  if (!targetClientId) {
    return res.status(400).json({ error: 'Provide either client_id or email.' });
  }

  const rawKey = 'csk_' + crypto.randomBytes(20).toString('hex');
  const hash   = hashKey(rawKey);
  const prefix = rawKey.slice(0, 12);

  const { error } = await supabase.from('api_keys').insert({
    client_id:  targetClientId,
    key_hash:   hash,
    key_prefix: prefix,
    label:      label || null,
    is_active:  true,
  });

  if (error) return res.status(500).json({ error: error.message });

  console.log(`[admin] API key generated for client ${targetClientId.slice(0,8)} — label: ${label || '—'}`);

  return res.status(201).json({
    ok:      true,
    key:     rawKey,  // shown once only
    prefix,
    label:   label || null,
    client_id: targetClientId,
    message: 'Save this key now — it will not be shown again.',
  });
});

/**
 * PATCH /api/admin/keys/:id
 * Enable or disable a key
 * Body: { is_active: boolean }
 */
app.patch('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;
  if (typeof is_active !== 'boolean')
    return res.status(400).json({ error: 'is_active must be boolean.' });

  const { error } = await supabase
    .from('api_keys')
    .update({ is_active })
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id, is_active });
});

/**
 * DELETE /api/admin/keys/:id
 * Permanently delete a key
 */
app.delete('/api/admin/keys/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('api_keys').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, id });
});


function scheduleTrialExpiry() {
  const runExpiry = async () => {
    try {
      const { data: count, error } = await supabase.rpc('expire_trials');
      if (error) {
        console.error('[trial-cron] expire_trials error:', error.message);
      } else if (count > 0) {
        console.log(`[trial-cron] ${count} trial(s) expired and downgraded to Free`);
      }
    } catch (err) {
      console.error('[trial-cron] unexpected error:', err.message);
    }
  };

  // Run once on startup (catches any missed expirations during downtime)
  runExpiry();

  // Then run every hour
  setInterval(runExpiry, TRIAL_CHECK_INTERVAL_MS);
  console.log(`[trial-cron] scheduled — checks every ${TRIAL_CHECK_INTERVAL_MS / 60000} minutes`);
}

// ════════════════════════════════════════════════════════════════
//  BOOT
// ════════════════════════════════════════════════════════════════
async function start() {
  console.log('[casca] Loading providers from DB…');
  await loadProviders();
  await initRedis();
  mActiveProviders.set(providerRegistry.size);
  if (!stripe) console.warn('[casca] STRIPE_SECRET_KEY not set — billing endpoints disabled.');
  scheduleTrialExpiry();
  app.listen(PORT, () => {
    console.log(`🚀 Casca v3 API Proxy → http://localhost:${PORT}`);
    console.log(`   Providers: ${providerRegistry.size}  |  Stripe: ${!!stripe}  |  Cache TTL: ${CACHE_TTL_DAYS}d`);
  });
}
start();
