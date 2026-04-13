-- ═══════════════════════════════════════════════════════════════
--  casca-schema-v5-client-keys.sql
--  Client LLM Key Management (Stage 1 & 2 support)
--
--  變更內容：
--    1. client_llm_keys 表 — 每個客戶可以儲存自己的 LLM Key
--    2. clients.routing_mode 欄位 — passthrough / managed
--    3. Helper function: get_client_provider
--
--  三個模式：
--    managed     → 用 Admin 設定的 Casca LLM Key（Stage 3 / Demo）
--    passthrough → 用客戶自己的 LLM Key（Stage 1 / Stage 2）
--    auto        → 有客戶 Key 就用客戶的，沒有就用 Casca 的
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
--  1. routing_mode 欄位加到 clients 表
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS routing_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (routing_mode IN ('managed', 'passthrough', 'auto'));

COMMENT ON COLUMN public.clients.routing_mode IS
  'managed = use Casca LLM keys (Stage 3/Demo) | passthrough = use client own keys (Stage 1/2) | auto = client keys first, Casca keys fallback';

-- ─────────────────────────────────────────────────────────────
--  2. client_llm_keys 表
--     每個客戶可以登記自己的 LLM Key，按 provider 分開存
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_llm_keys (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID          NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,

  -- Which LLM provider this key is for
  provider_name   TEXT          NOT NULL,  -- 'OpenAI' | 'Google' | 'Anthropic' | 'Azure' | 'Groq'

  -- Which models this key can serve (comma-separated or '*' for all)
  -- e.g. 'gpt-4o,gpt-4o-mini' or '*'
  models          TEXT          NOT NULL DEFAULT '*',

  -- The actual API key (stored as-is; encrypt at rest via Supabase vault in prod)
  api_key_enc     TEXT          NOT NULL,

  -- Base URL for this provider (OpenAI-compatible format)
  base_url        TEXT          NOT NULL DEFAULT 'https://api.openai.com/v1',

  -- For Google Gemini: key goes in query param instead of header
  key_in_query    BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Active flag — client can disable without deleting
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,

  -- Metadata
  label           TEXT,                   -- friendly name, e.g. "Production OpenAI"
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS clk_client_idx   ON public.client_llm_keys(client_id);
CREATE INDEX IF NOT EXISTS clk_provider_idx ON public.client_llm_keys(client_id, provider_name);

ALTER TABLE public.client_llm_keys ENABLE ROW LEVEL SECURITY;

-- Clients can only see/manage their own keys
CREATE POLICY "clk_self" ON public.client_llm_keys
  FOR ALL USING (client_id = auth.uid());

-- Service role bypass (for server-side lookups)
CREATE POLICY "clk_service" ON public.client_llm_keys
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  3. Function: resolve_llm_provider
--     Given client_id + model_name + routing_mode,
--     returns the provider config to use.
--
--     Priority:
--       passthrough → client key only (error if not found)
--       managed     → Casca admin key only
--       auto        → client key first, Casca key fallback
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_llm_provider(
  p_client_id   UUID,
  p_model_name  TEXT
)
RETURNS TABLE (
  source        TEXT,   -- 'client' | 'casca'
  provider_name TEXT,
  api_key_enc   TEXT,
  base_url      TEXT,
  key_in_query  BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_mode TEXT;
BEGIN
  -- Get client's routing mode
  SELECT routing_mode INTO v_mode
  FROM public.clients WHERE id = p_client_id;

  -- Try client key first (for auto/passthrough)
  IF v_mode IN ('auto', 'passthrough') THEN
    RETURN QUERY
      SELECT
        'client'::TEXT,
        k.provider_name,
        k.api_key_enc,
        k.base_url,
        k.key_in_query
      FROM public.client_llm_keys k
      WHERE k.client_id  = p_client_id
        AND k.is_active  = TRUE
        AND (k.models = '*' OR k.models ILIKE '%' || p_model_name || '%')
      ORDER BY k.created_at
      LIMIT 1;

    IF FOUND THEN RETURN; END IF;

    -- passthrough but no client key found → error (caller handles)
    IF v_mode = 'passthrough' THEN RETURN; END IF;
  END IF;

  -- Fall back to Casca admin provider (managed / auto fallback)
  RETURN QUERY
    SELECT
      'casca'::TEXT,
      p.provider_name,
      p.api_key_enc,
      p.base_url,
      (p.provider_name = 'Google')::BOOLEAN
    FROM public.llm_providers p
    WHERE p.is_active    = TRUE
      AND p.model_name   = p_model_name
    ORDER BY p.priority
    LIMIT 1;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  Verify
-- ─────────────────────────────────────────────────────────────
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name   = 'clients'
  AND column_name  = 'routing_mode';

SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'client_llm_keys';
