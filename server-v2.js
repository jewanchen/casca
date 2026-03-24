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
 *   FRONTEND_URL              — https://app.cascaio.com (redirect after checkout)
 */

import 'dotenv/config';
import express          from 'express';
import cors             from 'cors';
import crypto           from 'crypto';
import Stripe           from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { route as cascaRoute, setConfig } from './casca-classifier.js';

// ════════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════════
const PORT              = process.env.PORT                    || 3001;
const PROMOTE_THRESHOLD = parseInt(process.env.CACHE_PROMOTE_THRESHOLD || '3',  10);
const PROMOTE_WINDOW_H  = parseInt(process.env.CACHE_PROMOTE_WINDOW_H  || '24', 10);
const CACHE_TTL_DAYS    = parseInt(process.env.CACHE_TTL_DAYS          || '7',  10);
const CORS_ORIGIN       = process.env.CORS_ORIGIN             || '*';
const LLM_TIMEOUT_MS    = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);
const FRONTEND_URL      = process.env.FRONTEND_URL            || 'http://localhost:8080';

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
  isCache, latencyMs, statusCode, errorMessage, uc,
}) {
  try {
    const totalTokens = tokensIn + tokensOut;

    // ── 1. api_logs ──────────────────────────────────────────────
    const { data: logRow } = await supabase.from('api_logs').insert({
      client_id:     clientId,
      prompt_hash:   promptHash,
      prompt_preview: normalizedPrompt.slice(0, 200),
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

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok', providers: providerRegistry.size,
  stripe:  !!stripe, ts: new Date().toISOString(),
}));

// ════════════════════════════════════════════════════════════════
//  CORE ENDPOINT: POST /api/v1/chat/completions
// ════════════════════════════════════════════════════════════════
app.post('/api/v1/chat/completions', requireApiKey, async (req, res) => {
  const t0 = Date.now();
  const { messages, uc, qualityTier, conversationContext } = req.body;
  const client   = req.client;
  const plan     = req.plan;
  const clientId = client.id ?? 'passthrough-anonymous';

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
    return res.json(payload);
  }
  // ── End bypass ───────────────────────────────────────────────

  const lastUser   = [...messages].reverse().find(m => m.role === 'user');
  const promptText = lastUser?.content ?? '';
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
    res.json(payload);

    postProcess({
      clientId, planId: plan?.id, overageRate: plan?.overage_rate_per_1m,
      promptHash, normalizedPrompt: normalized,
      classifyResult: { cx: cacheRow.cx ?? 'LOW', originalCx: cacheRow.cx ?? 'LOW',
        rule: 'L1-CACHE-HIT', lang: 'UNK', modal: 'text', autoLearn: false },
      provider: null, responseText: null, tokensIn: 0, tokensOut: 0,
      costUsd: 0, savingsPct: 100, isCache: true, latencyMs, statusCode: 200,
      errorMessage: null, uc,
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

  const targetModel = classifyResult.model;

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
    // Casca pays LLM cost, charges client via billing gate.
    provider = providerRegistry.get(targetModel)
      ?? [...providerRegistry.values()].find(p =>
           p.tier_capability === classifyResult.cx || p.tier_capability === 'ANY')
      ?? null;
    providerSource = 'casca';

    if (!provider) {
      return res.status(503).json({
        error: `No active provider for tier ${classifyResult.cx}.`,
        cx:    classifyResult.cx,
      });
    }

    console.log(`[casca] managed → ${targetModel} via Casca ${provider.provider_name} key`);
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
    postProcess({
      clientId, planId: plan?.id, overageRate: plan?.overage_rate_per_1m,
      promptHash, normalizedPrompt: normalized,
      classifyResult, provider, responseText: null, tokensIn, tokensOut,
      costUsd, savingsPct, isCache: false, latencyMs: Date.now() - t0,
      statusCode, errorMessage: llmErr, uc,
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

  res.json(payload);

  postProcess({
    clientId, planId: plan?.id, overageRate: plan?.overage_rate_per_1m,
    promptHash, normalizedPrompt: normalized,
    classifyResult, provider, responseText, tokensIn, tokensOut,
    costUsd, savingsPct, isCache: false, latencyMs: Date.now() - t0,
    statusCode, errorMessage: null, uc,
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
    .select('id, key_prefix, label, is_active, last_used_at, created_at')
    .eq('client_id', req.client.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ keys: data || [] });
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
  if (!stripe) console.warn('[casca] STRIPE_SECRET_KEY not set — billing endpoints disabled.');
  scheduleTrialExpiry();
  app.listen(PORT, () => {
    console.log(`🚀 Casca v3 API Proxy → http://localhost:${PORT}`);
    console.log(`   Providers: ${providerRegistry.size}  |  Stripe: ${!!stripe}  |  Cache TTL: ${CACHE_TTL_DAYS}d`);
  });
}
start();
