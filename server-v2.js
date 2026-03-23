/**
 * server-v2.js  —  Casca v2.1  ·  API Proxy & Aggregator
 *
 * FIX LOG (v2.0 → v2.1):
 *   1. requireAdmin: supports both Supabase JWT + x-admin-secret fallback
 *   2. callLLM: Anthropic adapter (different endpoint + body format)
 *   3. callLLM: Google adapter (API key as query param)
 *   4. /api/route: replaced app._router.handle() with direct handler call
 *   5. postProcess: deducts balance_credits via deduct_credits()
 *   6. CORS: supports comma-separated origins
 *   7. Added: /api/admin/customers GET + POST + PATCH
 *   8. Express: pinned to 4.x (v5 is still beta)
 *   9. adapter field read from llm_providers row
 *  10. callLLM: model-specific max_tokens defaults
 */

import 'dotenv/config';
import express         from 'express';
import cors            from 'cors';
import crypto          from 'crypto';
import { createClient } from '@supabase/supabase-js';

import {
  route    as cascaRoute,
  setConfig,
} from './casca-classifier.js';

// ── Config ────────────────────────────────────────────────────────
const PORT             = process.env.PORT                    || 3001;
const PROMOTE_THRESHOLD= parseInt(process.env.CACHE_PROMOTE_THRESHOLD || '3',  10);
const PROMOTE_WINDOW_H = parseInt(process.env.CACHE_PROMOTE_WINDOW_H  || '24', 10);
const CACHE_TTL_DAYS   = parseInt(process.env.CACHE_TTL_DAYS          || '7',  10);

// CORS: supports comma-separated origins  e.g. "https://cascaio.com,https://admin.cascaio.com"
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim());
const corsOpts = CORS_ORIGINS.includes('*')
  ? { origin: true, credentials: true }
  : { origin: CORS_ORIGINS, credentials: true };

// ── Supabase (service_role — bypasses RLS) ──────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

// ── In-memory provider registry  ────────────────────────────────
/** @type {Map<string, object>}  model_name → llm_providers row */
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
      : tier === 'MED'
        ? [...(tierBuckets.HIGH || []), ...src]
        : src;

    dynamicTiers[tier] = { default: pick(src, 0), low_q: pick(src, 0), high_q: pick(higherSrc, 0) };
  }

  setConfig(dynamicCosts, dynamicTiers);
  console.log(`[casca] ${providerRegistry.size} providers loaded. Tiers:`,
    Object.fromEntries(Object.entries(dynamicTiers).map(([t, v]) => [t, v.default])));
}

// ── Utilities ─────────────────────────────────────────────────────
const normalizePrompt = t => t.toLowerCase().replace(/\s+/g, ' ').trim();
const sha256 = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const cacheExpiry = () => {
  if (CACHE_TTL_DAYS === 0) return null;
  const d = new Date();
  d.setDate(d.getDate() + CACHE_TTL_DAYS);
  return d.toISOString();
};

// ── Auth middleware ───────────────────────────────────────────────
async function requireApiKey(req, res, next) {
  const raw = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) return res.status(401).json({ error: 'Missing Authorization header.' });

  const { data: client, error } = await supabase
    .from('clients')
    .select('id, plan, quota_limit, quota_used, balance_credits')
    .eq('api_key', raw)
    .single();

  if (error || !client) return res.status(401).json({ error: 'Invalid API key.' });
  if (client.quota_used >= client.quota_limit)
    return res.status(429).json({ error: 'Monthly quota exceeded.' });

  req.client = client;
  next();
}

/**
 * requireAdmin — dual auth:
 *   1. Supabase JWT (Authorization: Bearer <jwt>) → verify via Supabase, check is_admin
 *   2. x-admin-secret header (legacy/CLI fallback)
 */
async function requireAdmin(req, res, next) {
  // Path 1: x-admin-secret (legacy)
  if (process.env.ADMIN_SECRET && req.headers['x-admin-secret'] === process.env.ADMIN_SECRET) {
    return next();
  }

  // Path 2: Supabase JWT
  const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ error: 'Admin auth required (JWT or x-admin-secret).' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token.' });

    // Check admin flag in clients table
    const { data: isAdmin } = await supabase.rpc('is_admin', { p_user_id: user.id });
    if (!isAdmin) return res.status(403).json({ error: 'Admin role required.' });

    req.adminUser = user;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Auth verification failed: ' + err.message });
  }
}

// ── LLM Proxy ────────────────────────────────────────────────────
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);

/**
 * callLLM — adapter-aware proxy
 * Reads provider.adapter ('openai' | 'anthropic' | 'google') to choose
 * the correct endpoint URL and request body format.
 */
async function callLLM(provider, messages) {
  const adapter = provider.adapter || 'openai';
  let url, headers, body;

  if (adapter === 'anthropic') {
    // ── Anthropic Messages API ──────────────────────────────
    url = `${provider.base_url.replace(/\/$/, '')}/messages`;
    headers = {
      'Content-Type':      'application/json',
      'x-api-key':         provider.api_key_enc,
      'anthropic-version':  '2023-06-01',
    };
    // Anthropic: system message must be separate from messages array
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystem = messages.filter(m => m.role !== 'system');
    body = {
      model:      provider.model_name,
      max_tokens: 1024,
      messages:   nonSystem,
    };
    if (systemMsg) body.system = systemMsg.content;

  } else if (adapter === 'google') {
    // ── Google Gemini (OpenAI-compat shim) ───────────────────
    url = `${provider.base_url.replace(/\/$/, '')}/chat/completions?key=${provider.api_key_enc}`;
    headers = { 'Content-Type': 'application/json' };
    body = { model: provider.model_name, messages, max_tokens: 1024 };

  } else {
    // ── OpenAI / Groq / Together / default ───────────────────
    url = `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
    headers = {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${provider.api_key_enc}`,
    };
    body = { model: provider.model_name, messages, max_tokens: 1024 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const txt = await res.text();
      return { responseText: null, tokensIn: 0, tokensOut: 0, statusCode: res.status, latencyMs,
               error: `LLM ${res.status}: ${txt.slice(0, 200)}` };
    }

    const json = await res.json();

    // Normalize Anthropic response → OpenAI shape
    if (adapter === 'anthropic') {
      const text = json.content?.[0]?.text ?? '';
      const normalized = {
        choices: [{ message: { role: 'assistant', content: text } }],
        usage: {
          prompt_tokens:     json.usage?.input_tokens  ?? 0,
          completion_tokens: json.usage?.output_tokens ?? 0,
        },
      };
      return {
        responseText: JSON.stringify(normalized),
        tokensIn:     normalized.usage.prompt_tokens,
        tokensOut:    normalized.usage.completion_tokens,
        statusCode:   res.status, latencyMs, error: null,
      };
    }

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

// ── Async post-processor ─────────────────────────────────────────
async function postProcess({
  clientId, promptHash, normalizedPrompt,
  classifyResult, provider, responseText,
  tokensIn, tokensOut, costUsd, savingsPct,
  isCache, latencyMs, statusCode, errorMessage, uc,
}) {
  try {
    // 1. api_logs
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

    // Atomic quota increment
    supabase.rpc('increment_quota_used', { p_client_id: clientId }).then(({ error }) => {
      if (error) console.error('[casca] quota increment error:', error.message);
    });

    // Deduct credits (pay-per-use)
    if (costUsd > 0) {
      supabase.rpc('deduct_credits', { p_client_id: clientId, p_amount: costUsd }).then(({ error }) => {
        if (error) console.error('[casca] deduct_credits error:', error.message);
      });
    }

    // 2. annotation_queue
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

    // 3. frequency log
    await supabase.from('prompt_frequency_log').insert({ client_id: clientId, prompt_hash: promptHash });

    // 4. cache promotion check
    const { data: shouldPromote } = await supabase.rpc('should_promote_to_cache', {
      p_client_id:    clientId,
      p_hash:         promptHash,
      p_threshold:    PROMOTE_THRESHOLD,
      p_window_hours: PROMOTE_WINDOW_H,
    });

    if (shouldPromote && responseText) {
      const { error: uErr } = await supabase.from('tenant_cache_pool').upsert(
        {
          client_id:         clientId,
          prompt_hash:       promptHash,
          normalized_prompt: normalizedPrompt,
          response_text:     responseText,
          model_used:        provider?.model_name ?? null,
          cx:                classifyResult.cx,
          original_cost_usd: costUsd,
          expires_at:        cacheExpiry(),
        },
        { onConflict: 'client_id,prompt_hash' }
      );
      if (!uErr) {
        console.log(`[casca] Cache promoted: client=${clientId.slice(0,8)} hash=${promptHash.slice(0,10)}…`);
      } else if (uErr.code !== '23505') {
        console.error('[casca] cache upsert:', uErr.message);
      }
    }
  } catch (err) {
    console.error('[casca] postProcess error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  EXPRESS APP
// ════════════════════════════════════════════════════════════════
const app = express();
app.use(cors(corsOpts));
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_req, res) => res.json({
  status: 'ok', providers: providerRegistry.size, ts: new Date().toISOString(),
}));

// ── Main proxy handler (reused by both routes) ───────────────────
async function handleChatCompletions(req, res) {
  const t0 = Date.now();
  const { messages, uc, qualityTier, conversationContext } = req.body;
  const clientId = req.client.id;

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: '`messages` array is required.' });

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const promptText = lastUser?.content ?? '';
  if (!promptText || typeof promptText !== 'string')
    return res.status(400).json({ error: 'No user message content.' });

  const normalized = normalizePrompt(promptText);
  const promptHash = sha256(normalized);

  // ── L1 Cache Check ─────────────────────────────────────────
  const now = new Date().toISOString();
  const { data: cacheRow } = await supabase
    .from('tenant_cache_pool')
    .select('id, response_text, model_used, cx, original_cost_usd, hit_count')
    .eq('client_id', clientId)
    .eq('prompt_hash', promptHash)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .maybeSingle();

  if (cacheRow) {
    const latencyMs = Date.now() - t0;
    supabase.rpc('record_cache_hit', {
      p_client_id: clientId, p_hash: promptHash, p_saved_usd: cacheRow.original_cost_usd || 0,
    }).then(() => {});

    let payload;
    try { payload = JSON.parse(cacheRow.response_text); }
    catch { payload = { choices: [{ message: { role: 'assistant', content: cacheRow.response_text } }] }; }

    payload._casca = { cx: cacheRow.cx ?? 'LOW', model: cacheRow.model_used ?? 'cache',
      cacheHit: true, hitCount: (cacheRow.hit_count || 0) + 1, costUsd: 0, savingsPct: 100, latencyMs };

    res.json(payload);
    postProcess({
      clientId, promptHash, normalizedPrompt: normalized,
      classifyResult: { cx: cacheRow.cx ?? 'LOW', originalCx: cacheRow.cx ?? 'LOW',
        rule: 'L1-CACHE-HIT', lang: 'UNK', modal: 'text', autoLearn: false },
      provider: null, responseText: null, tokensIn: 0, tokensOut: 0,
      costUsd: 0, savingsPct: 100, isCache: true, latencyMs, statusCode: 200,
      errorMessage: null, uc,
    });
    return;
  }

  // ── Classify → Route ───────────────────────────────────────
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
  const provider    = providerRegistry.get(targetModel)
    ?? [...providerRegistry.values()].find(p => p.tier_capability === classifyResult.cx)
    ?? null;

  if (!provider)
    return res.status(503).json({
      error: `No active provider for tier ${classifyResult.cx}.`, cx: classifyResult.cx,
    });

  const { responseText, tokensIn, tokensOut, statusCode, latencyMs, error: llmErr }
    = await callLLM(provider, messages);

  const totalTokens = tokensIn + tokensOut;
  const costUsd     = (totalTokens / 1_000_000) * (provider.cost_per_1m_tokens || 0);
  const baseCost    = (totalTokens / 1_000_000) * 5.0;
  const savingsPct  = baseCost > 0 ? Math.max(0, Math.round(((baseCost - costUsd) / baseCost) * 100)) : 0;

  if (llmErr || !responseText) {
    res.status(statusCode >= 400 ? statusCode : 502).json({ error: llmErr ?? 'Empty LLM response.' });
    postProcess({
      clientId, promptHash, normalizedPrompt: normalized,
      classifyResult, provider, responseText: null, tokensIn, tokensOut,
      costUsd, savingsPct, isCache: false, latencyMs: Date.now() - t0,
      statusCode, errorMessage: llmErr, uc,
    });
    return;
  }

  let payload;
  try { payload = JSON.parse(responseText); }
  catch { payload = { choices: [{ message: { role: 'assistant', content: responseText } }] }; }

  payload._casca = {
    cx: classifyResult.cx, model: provider.model_name, cacheHit: false,
    costUsd, savingsPct, latencyMs: Date.now() - t0,
    rule: classifyResult.rule, lang: classifyResult.lang,
    autoLearn: classifyResult.autoLearn, tokensIn, tokensOut,
  };

  res.json(payload);
  postProcess({
    clientId, promptHash, normalizedPrompt: normalized,
    classifyResult, provider, responseText, tokensIn, tokensOut,
    costUsd, savingsPct, isCache: false, latencyMs: Date.now() - t0,
    statusCode, errorMessage: null, uc,
  });
}

// ── POST /api/v1/chat/completions ────────────────────────────────
app.post('/api/v1/chat/completions', requireApiKey, handleChatCompletions);

// ── /api/route — backward-compatible (accepts { prompt } or { messages })
app.post('/api/route', requireApiKey, (req, res, next) => {
  if (!req.body.messages && req.body.prompt) {
    req.body.messages = [{ role: 'user', content: req.body.prompt }];
  }
  handleChatCompletions(req, res, next);
});

// ── API Key management ───────────────────────────────────────────
function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

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
  const rawKey  = 'csk_' + crypto.randomBytes(20).toString('hex');
  const hash    = hashKey(rawKey);
  const prefix  = rawKey.slice(0, 12);

  const { error } = await supabase.from('api_keys').insert({
    client_id:  req.client.id,
    key_hash:   hash,
    key_prefix: prefix,
    label:      label || null,
    is_active:  true,
  });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({
    message: 'API key created. Save it now — it will not be shown again.',
    key: rawKey, prefix, label: label || null,
  });
});

// ── Dashboard endpoints ──────────────────────────────────────────
app.get('/api/dashboard/me', requireApiKey, async (req, res) => {
  const { data, error } = await supabase.from('clients')
    .select('id,email,company_name,plan,api_key,balance_credits,quota_limit,quota_used,created_at')
    .eq('id', req.client.id).single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
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
  return res.json({ logs: data, total: count, cacheHits, totalCost });
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
  const { error } = await supabase.from('tenant_cache_pool')
    .delete().eq('client_id', req.client.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true, message: 'All cache entries flushed.' });
});

// ── Admin: LLM Providers ─────────────────────────────────────────
app.get('/api/admin/providers', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('llm_providers')
    .select('*').order('tier_capability').order('priority');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ providers: data });
});

app.post('/api/admin/providers', requireAdmin, async (req, res) => {
  const { provider_name, model_name, display_name, base_url,
          api_key_enc, cost_per_1m_tokens, tier_capability,
          context_window, supports_vision, priority, adapter } = req.body;
  if (!provider_name || !model_name || !base_url || !tier_capability)
    return res.status(400).json({ error: 'provider_name, model_name, base_url, tier_capability required.' });

  const { data, error } = await supabase.from('llm_providers')
    .insert({ provider_name, model_name, display_name, base_url, api_key_enc,
              cost_per_1m_tokens: cost_per_1m_tokens || 0, tier_capability,
              context_window, supports_vision: !!supports_vision,
              adapter: adapter || 'openai',
              priority: priority ?? 50, is_active: true })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  await loadProviders();
  return res.status(201).json({ provider: data, message: 'Provider added, engine reloaded.' });
});

app.patch('/api/admin/providers/:id', requireAdmin, async (req, res) => {
  const allowed = ['api_key_enc','cost_per_1m_tokens','tier_capability',
                   'is_active','priority','display_name','supports_vision','adapter'];
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

// ── Admin: Customers CRUD ────────────────────────────────────────
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('clients')
    .select('id,email,company_name,plan,status,providers,quota_limit,quota_used,balance_credits,renewal_date,stripe_customer_id,api_key,created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Enrich with aggregate stats from api_logs (last 30 days)
  const since = new Date(); since.setDate(since.getDate() - 30);
  const { data: logStats } = await supabase
    .from('api_logs')
    .select('client_id, cost_usd, savings_pct, is_cache_hit')
    .gte('created_at', since.toISOString());

  const statsMap = {};
  for (const log of (logStats || [])) {
    if (!statsMap[log.client_id]) statsMap[log.client_id] = { count: 0, cost: 0, savings: 0 };
    const s = statsMap[log.client_id];
    s.count++;
    s.cost += log.cost_usd || 0;
    // Estimate savings: cost * (savings_pct / (100 - savings_pct)) when savings_pct < 100
    if (log.savings_pct > 0 && log.savings_pct < 100) {
      s.savings += (log.cost_usd || 0) * (log.savings_pct / (100 - log.savings_pct));
    }
  }

  const customers = (data || []).map(c => ({
    ...c,
    api_key_prefix: c.api_key ? c.api_key.slice(0, 12) + '…' : '—',
    api_key: undefined,  // never expose full key
    requests_count: statsMap[c.id]?.count || 0,
    total_cost_usd: statsMap[c.id]?.cost || 0,
    total_savings_usd: statsMap[c.id]?.savings || 0,
    platform_fee_usd: (statsMap[c.id]?.savings || 0) * 0.2,
  }));

  return res.json({ customers });
});

app.post('/api/admin/customers', requireAdmin, async (req, res) => {
  const { company_name, plan, email, providers } = req.body;
  if (!company_name) return res.status(400).json({ error: 'company_name required.' });

  // Create Supabase auth user first (if email provided)
  let userId;
  if (email) {
    const tempPw = crypto.randomBytes(16).toString('hex');
    const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
      email, password: tempPw, email_confirm: true,
    });
    if (authErr) return res.status(400).json({ error: 'Auth user creation failed: ' + authErr.message });
    userId = authData.user.id;

    // Update the auto-created client row
    const { error: updateErr } = await supabase.from('clients')
      .update({
        company_name,
        plan: plan || 'starter',
        status: 'trial',
        providers: providers ? JSON.stringify(providers) : '["OpenAI"]',
      })
      .eq('id', userId);
    if (updateErr) return res.status(500).json({ error: updateErr.message });

    // Fetch the created client (includes auto-generated api_key)
    const { data: client } = await supabase.from('clients')
      .select('id,email,company_name,plan,api_key,status')
      .eq('id', userId).single();

    return res.status(201).json({
      message: 'Customer created.',
      customer: client,
      apikey: client?.api_key,
      tempPassword: tempPw,  // Admin should share this securely
    });
  }

  return res.status(400).json({ error: 'email is required to create auth user.' });
});

app.patch('/api/admin/customers/:id', requireAdmin, async (req, res) => {
  const allowed = ['company_name','plan','status','providers','quota_limit','renewal_date','balance_credits','is_admin'];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  updates.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('clients')
    .update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ customer: data, message: 'Customer updated.' });
});

// ── Admin: Annotation queue ──────────────────────────────────────
app.get('/api/admin/queue', requireAdmin, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 500);
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
  const [logsRes, queueRes, cacheRes, clientsRes] = await Promise.all([
    supabase.from('api_logs').select('is_cache_hit,cost_usd,status_code', { count: 'exact' }).gte('created_at', since.toISOString()),
    supabase.from('annotation_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('tenant_cache_pool').select('hit_count,total_saved_usd', { count: 'exact' }),
    supabase.from('clients').select('id', { count: 'exact' }),
  ]);
  const logs     = logsRes.data || [];
  const total    = logsRes.count || 0;
  const hits     = logs.filter(l => l.is_cache_hit).length;
  const success  = logs.filter(l => l.is_cache_hit || (l.status_code >= 200 && l.status_code < 300)).length;
  const totalSaved = (cacheRes.data || []).reduce((s, r) => s + (r.total_saved_usd || 0), 0);
  return res.json({
    period: '30d', totalRequests: total,
    totalClients: clientsRes.count || 0,
    cacheHitRate:     total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '0%',
    successRate:      total > 0 ? ((success / total) * 100).toFixed(1) + '%' : '—',
    totalCostUsd:     (logs.reduce((s, l) => s + (l.cost_usd || 0), 0)).toFixed(4),
    totalSavedUsd:    totalSaved.toFixed(4),
    pendingAnnotations: queueRes.count || 0,
    activeCacheEntries: cacheRes.count || 0,
    activeProviders:  providerRegistry.size,
  });
});

// ── Boot ─────────────────────────────────────────────────────────
async function start() {
  console.log('[casca] Loading providers from DB…');
  await loadProviders();
  app.listen(PORT, () => {
    console.log(`🚀 Casca v2.1 API Proxy → http://localhost:${PORT}`);
    console.log(`   Providers: ${providerRegistry.size}  |  Cache: ${PROMOTE_THRESHOLD} hits/${PROMOTE_WINDOW_H}h  |  TTL: ${CACHE_TTL_DAYS === 0 ? '∞' : CACHE_TTL_DAYS + 'd'}`);
  });
}
start();
