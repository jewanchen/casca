/**
 * casca-path-b.js  —  Path B Training Pipeline + Dynamic Confidence
 * ════════════════════════════════════════════════════════════════════
 *
 * This module provides:
 *   1. piiMask(text)             — Server-side PII masking
 *   2. llmJudge(prompt, supabase, providerRegistry)
 *                                — Call GPT-4o-mini to get ground truth label
 *   3. runTrainingPipeline(...)  — Async: mask → judge → write sample → update rule stats
 *   4. getDynamicConfidence(...) — Calculate dynamic_confidence for a rule
 *   5. loadRuleAccuracyCache()   — Pre-load rule accuracy rates from DB
 *
 * Imported by server-v2.js. All functions are async-safe and never block
 * the client response.
 *
 * Env vars:
 *   PATH_B_ENABLED          — 'true' to enable training pipeline (default: false)
 *   PATH_B_JUDGE_MODEL      — model name for LLM Judge (default: 'gpt-4o-mini')
 *   PATH_B_SAMPLE_RATE      — fraction of requests to judge (default: 1.0 = all)
 *   PATH_B_CONFIDENCE_THRESHOLD — below this → invoke L2 MiniLM (default: 80)
 *   MINILM_SERVICE_URL      — URL of MiniLM Python service (default: http://localhost:8000)
 * ════════════════════════════════════════════════════════════════════
 */

// ════════════════════════════════════════════════════════════════
//  1. PII MASKER
//  Ported from CascaPiiMasker.cls (Salesforce Apex)
//  Masks: email, credit card, SSN, Taiwan ID, IP, phone numbers
// ════════════════════════════════════════════════════════════════

const PII_PATTERNS = [
  // Email
  { name: 'EMAIL',       re: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g },
  // Credit card (13-19 digits, with optional separators)
  { name: 'CREDIT_CARD', re: /\b(?:\d[ \-]?){13,19}\b/g,
    validate: s => luhnCheck(s.replace(/[\s\-]/g, '')) },
  // SSN (US)
  { name: 'SSN',         re: /\b\d{3}[\-\s]\d{2}[\-\s]\d{4}\b/g },
  // Taiwan National ID
  { name: 'TW_ID',       re: /\b[A-Z][12]\d{8}\b/g },
  // IPv4
  { name: 'IP',          re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g },
  // International phone (+country code)
  { name: 'PHONE_INTL',  re: /\+\d{1,3}[\-\s]?\d{2,4}[\-\s]?\d{3,4}[\-\s]?\d{3,4}/g },
  // Taiwan mobile (09XX-XXX-XXX)
  { name: 'PHONE_TW',    re: /\b09\d{2}[\-\s]?\d{3}[\-\s]?\d{3}\b/g },
  // Japan phone (0X0-XXXX-XXXX)
  { name: 'PHONE_JP',    re: /\b0[789]0[\-\s]?\d{4}[\-\s]?\d{4}\b/g },
  // US phone ((XXX) XXX-XXXX or XXX-XXX-XXXX)
  { name: 'PHONE_US',    re: /(?:\(\d{3}\)\s?|\b\d{3}[\-\s])\d{3}[\-\s]\d{4}\b/g },
];

function luhnCheck(num) {
  if (!/^\d{13,19}$/.test(num)) return false;
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Mask PII in text. Returns { masked, piiCount }.
 * Each PII match is replaced with [TYPE_N] (e.g. [EMAIL_1], [PHONE_TW_2]).
 */
export function piiMask(text) {
  if (!text || typeof text !== 'string') return { masked: text || '', piiCount: 0 };

  let masked = text;
  let counter = 0;

  for (const pattern of PII_PATTERNS) {
    masked = masked.replace(pattern.re, (match) => {
      // For credit cards, validate with Luhn before masking
      if (pattern.validate && !pattern.validate(match)) return match;
      counter++;
      return `[${pattern.name}_${counter}]`;
    });
  }

  return { masked, piiCount: counter };
}

// ════════════════════════════════════════════════════════════════
//  2. LLM JUDGE
//  Calls GPT-4o-mini (or configured model) to classify a prompt
//  Returns: { label: 'HIGH'|'MED'|'LOW', raw: string }
// ════════════════════════════════════════════════════════════════

const JUDGE_SYSTEM_PROMPT = `You are a prompt complexity classifier for an LLM routing system.

Classify the user's prompt into exactly one category:

HIGH — Requires deep reasoning, multi-step analysis, professional domain expertise, comprehensive deliverables, complex code architecture, legal/compliance documents, or strategic planning.

MED — Requires moderate generation, content organization, formatting, summarization, translation, code writing for specific tasks, or emotional support.

LOW — Simple factual lookup, single definition, short translation, basic calculation, greeting, confirmation, or one-sentence answer.

Rules:
- Respond with ONLY one word: HIGH, MED, or LOW
- Do not explain. Do not add punctuation.
- Judge by the TASK complexity, not the topic. "What is GDPR?" = LOW (definition). "Design a GDPR framework" = HIGH (deliverable).
- Fragments like "ok", "thanks", "繼續" = LOW
- Emotional distress expressions = MED (needs empathetic response, not simple)`;

/**
 * Call LLM to judge prompt complexity.
 * Uses the first available OpenAI-compatible provider, or falls back to hardcoded endpoint.
 */
export async function llmJudge(promptMasked, providerRegistry, judgeModel = 'gpt-4o-mini') {
  // Find a provider that can serve the judge model
  const provider = providerRegistry?.get(judgeModel)
    ?? [...(providerRegistry?.values() || [])].find(p =>
         p.model_name?.includes('gpt-4o-mini') || p.model_name?.includes('gpt-4o'))
    ?? null;

  if (!provider) {
    console.warn('[path-b] No provider available for LLM Judge');
    return null;
  }

  const baseUrl = provider.base_url.replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${provider.api_key_enc}`,
  };

  // Google: key in query param
  let url = `${baseUrl}/chat/completions`;
  if (provider.provider_name === 'Google') {
    url = `${url}?key=${provider.api_key_enc}`;
    delete headers['Authorization'];
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: judgeModel,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user',   content: promptMasked },
        ],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const txt = await res.text();
      console.error(`[path-b] LLM Judge error ${res.status}: ${txt.slice(0, 100)}`);
      return null;
    }

    const json = await res.json();
    const raw = (json.choices?.[0]?.message?.content || '').trim().toUpperCase();

    // Normalize: accept only HIGH/MED/LOW
    const label = ['HIGH', 'MED', 'LOW'].includes(raw) ? raw : null;
    if (!label) {
      console.warn(`[path-b] LLM Judge returned unexpected: "${raw}"`);
      return null;
    }

    return { label, raw, tokensUsed: json.usage?.total_tokens || 0 };
  } catch (err) {
    console.error('[path-b] LLM Judge fetch error:', err.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  3. RULE ACCURACY CACHE
//  In-memory cache of rule → accuracy_rate, refreshed periodically.
//  Avoids a DB call on every request for dynamic_confidence.
// ════════════════════════════════════════════════════════════════

/** @type {Map<string, number>} rule_name → accuracy_rate (0.0 ~ 1.0) */
const ruleAccuracyCache = new Map();
let cacheLastRefresh = 0;
const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export async function loadRuleAccuracyCache(supabase) {
  try {
    const { data, error } = await supabase
      .from('rule_accuracy_stats')
      .select('rule_name, accuracy_rate, total_samples');
    if (error) {
      console.error('[path-b] loadRuleAccuracyCache error:', error.message);
      return;
    }
    ruleAccuracyCache.clear();
    for (const row of (data || [])) {
      ruleAccuracyCache.set(row.rule_name, {
        rate: parseFloat(row.accuracy_rate),
        samples: row.total_samples,
      });
    }
    cacheLastRefresh = Date.now();
    console.log(`[path-b] rule accuracy cache loaded: ${ruleAccuracyCache.size} rules`);
  } catch (err) {
    console.error('[path-b] loadRuleAccuracyCache error:', err.message);
  }
}

// ════════════════════════════════════════════════════════════════
//  4. DYNAMIC CONFIDENCE
// ════════════════════════════════════════════════════════════════

/**
 * Calculate dynamic confidence for a classifier result.
 *
 *   dynamic_confidence = static_confidence × rule_accuracy_rate
 *
 * If the rule has < 10 samples, use static_confidence as-is
 * (not enough data to adjust).
 *
 * @param {string} ruleName   — e.g. "R6: 法律/合規強制 HIGH"
 * @param {number} staticConf — e.g. 95
 * @param {object} supabase   — Supabase client (for lazy refresh)
 * @returns {number} dynamic confidence (0-100)
 */
export async function getDynamicConfidence(ruleName, staticConf, supabase) {
  // Lazy refresh cache if stale
  if (Date.now() - cacheLastRefresh > CACHE_REFRESH_INTERVAL_MS) {
    // Non-blocking refresh
    loadRuleAccuracyCache(supabase).catch(() => {});
    cacheLastRefresh = Date.now(); // prevent stampede
  }

  const cached = ruleAccuracyCache.get(ruleName);
  if (!cached || cached.samples < 10) {
    // Not enough data → trust static confidence
    return staticConf;
  }

  return Math.round(staticConf * cached.rate * 10) / 10;
}

// ════════════════════════════════════════════════════════════════
//  5. L2 MiniLM CLIENT
//  Calls the MiniLM Python service for inference.
// ════════════════════════════════════════════════════════════════

// Railway internal networking: casca-minilm.railway.internal:8000
// Falls back to localhost:8000 for local development
const MINILM_URL = process.env.MINILM_SERVICE_URL || 'http://casca-minilm.railway.internal:8000';

/**
 * Call MiniLM service for classification.
 * Returns: { label: 'HIGH'|'MED'|'LOW', confidence: 0.0-1.0 } or null on error.
 */
export async function predictMiniLM(prompt) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const res = await fetch(`${MINILM_URL}/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const json = await res.json();
    return {
      label: json.label,           // HIGH / MED / LOW
      confidence: json.confidence,  // softmax probability
    };
  } catch (err) {
    // MiniLM service down → gracefully degrade to L1 only
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
//  6. TRAINING PIPELINE
//  Async function called after postProcess. Never blocks response.
// ════════════════════════════════════════════════════════════════

/**
 * Run the full Path B training pipeline for one request.
 *
 * @param {object} params
 * @param {string} params.promptText     — raw prompt text
 * @param {object} params.classifyResult — L1 result { cx, rule, confidence, lang }
 * @param {object} params.l2Result       — L2 result { label, confidence } or null
 * @param {string} params.servingLabel   — final label actually used for routing
 * @param {string} params.clientId       — client UUID (optional)
 * @param {boolean} params.judgeEnabled  — per-client flag (default: true)
 * @param {object} params.supabase       — Supabase client
 * @param {object} params.providerRegistry — provider map (for LLM Judge)
 */
export async function runTrainingPipeline({
  promptText, classifyResult, l2Result, servingLabel,
  clientId, judgeEnabled = true, supabase, providerRegistry,
}) {
  const enabled = (process.env.PATH_B_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return;

  // Per-client control: skip LLM Judge if disabled for this client
  if (!judgeEnabled) return;

  // Sample rate control (default: 100%)
  const sampleRate = parseFloat(process.env.PATH_B_SAMPLE_RATE || '1.0');
  if (sampleRate < 1.0 && Math.random() > sampleRate) return;

  try {
    // ── 1. PII Masking ──────────────────────────────────────────
    const { masked: promptMasked, piiCount } = piiMask(promptText);

    // ── 2. LLM Judge ────────────────────────────────────────────
    const judgeModel = process.env.PATH_B_JUDGE_MODEL || 'gpt-4o-mini';
    const judgeResult = await llmJudge(promptMasked, providerRegistry, judgeModel);
    if (!judgeResult) return; // Judge failed → skip this sample

    // ── 3. Compare ──────────────────────────────────────────────
    const l1Label = classifyResult.cx === 'AMBIG' ? 'MED' : classifyResult.cx;
    const l1Correct = l1Label === judgeResult.label;
    const l2Correct = l2Result ? (l2Result.label === judgeResult.label) : null;
    const servingCorrect = servingLabel === judgeResult.label;

    // ── 4. Write training_samples ───────────────────────────────
    const { error: insertErr } = await supabase.from('training_samples').insert({
      prompt_masked:   promptMasked,
      l1_label:        classifyResult.cx,
      l1_rule:         classifyResult.rule || null,
      l1_static_conf:  classifyResult.confidence || null,
      l1_dynamic_conf: null, // filled by getDynamicConfidence at serving time
      l2_label:        l2Result?.label || null,
      l2_confidence:   l2Result?.confidence || null,
      l2_invoked:      !!l2Result,
      judge_label:     judgeResult.label,
      judge_model:     judgeModel,
      l1_correct:      l1Correct,
      l2_correct:      l2Correct,
      serving_label:   servingLabel,
      serving_correct: servingCorrect,
      lang:            classifyResult.lang || null,
      source:          'live',
      client_id:       clientId || null,
    });

    if (insertErr) {
      console.error('[path-b] training_samples insert error:', insertErr.message);
      return;
    }

    // ── 5. Update rule_accuracy_stats ───────────────────────────
    if (classifyResult.rule) {
      const { error: rpcErr } = await supabase.rpc('upsert_rule_accuracy', {
        p_rule_name:  classifyResult.rule,
        p_is_correct: l1Correct,
      });
      if (rpcErr) console.error('[path-b] upsert_rule_accuracy error:', rpcErr.message);
    }

    // Log boundary cases
    if (!l1Correct) {
      console.log(`[path-b] BOUNDARY: L1="${classifyResult.cx}" Judge="${judgeResult.label}" rule="${classifyResult.rule}" lang=${classifyResult.lang}`);
    }
  } catch (err) {
    console.error('[path-b] training pipeline error:', err.message);
  }
}
