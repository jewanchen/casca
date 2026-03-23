-- ══════════════════════════════════════════════════════════════
--  CASCA v2.1  —  Supabase SQL Schema
--  Run in: Supabase Dashboard → SQL Editor → New Query
--
--  FIX LOG (v2.0 → v2.1):
--    1. llm_providers moved BEFORE api_logs (FK dependency fix)
--    2. api_keys table added (dashboard key management)
--    3. deduct_credits() function added
--    4. is_admin flag + helper added (JWT-based admin auth)
--    5. clients table: added status, providers, renewal_date, stripe_customer_id
--    6. llm_providers: added adapter column (openai/anthropic/google)
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── 1. CLIENTS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.clients (
  id               UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  company_name     TEXT,
  plan             TEXT        NOT NULL DEFAULT 'free',
  api_key          TEXT        UNIQUE,
  balance_credits  NUMERIC(14,6) NOT NULL DEFAULT 0,
  quota_limit      INTEGER     NOT NULL DEFAULT 1000,
  quota_used       INTEGER     NOT NULL DEFAULT 0,
  is_admin         BOOLEAN     NOT NULL DEFAULT FALSE,
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','trial','suspended','churned')),
  providers        JSONB       DEFAULT '[]'::jsonb,
  renewal_date     DATE,
  stripe_customer_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe migration: add new columns if table already exists from old schema
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS providers JSONB DEFAULT '[]'::jsonb;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS renewal_date DATE;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.clients (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.gen_client_api_key()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key IS NULL THEN
    NEW.api_key := 'csk_' || encode(gen_random_bytes(20), 'hex');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS before_client_insert ON public.clients;
CREATE TRIGGER before_client_insert
  BEFORE INSERT ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.gen_client_api_key();

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "clients_self" ON public.clients;
CREATE POLICY "clients_self" ON public.clients FOR ALL USING (auth.uid() = id);
CREATE INDEX IF NOT EXISTS clients_api_key_idx ON public.clients(api_key);

-- ─── 2. API KEYS (multi-key per client) ──────────────────────
CREATE TABLE IF NOT EXISTS public.api_keys (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id    UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  key_hash     TEXT        NOT NULL UNIQUE,
  key_prefix   TEXT        NOT NULL,
  label        TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_keys_client_idx ON public.api_keys(client_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx   ON public.api_keys(key_hash);
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_keys_own" ON public.api_keys;
CREATE POLICY "api_keys_own" ON public.api_keys FOR ALL USING (client_id = auth.uid());

-- ─── 3. LLM PROVIDERS (before api_logs — FK dependency) ──────
CREATE TABLE IF NOT EXISTS public.llm_providers (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider_name       TEXT          NOT NULL,
  model_name          TEXT          NOT NULL UNIQUE,
  display_name        TEXT,
  base_url            TEXT          NOT NULL,
  api_key_enc         TEXT,
  cost_per_1m_tokens  NUMERIC(10,4) NOT NULL DEFAULT 0,
  tier_capability     TEXT          NOT NULL
                      CHECK (tier_capability IN ('LOW','MED','HIGH','ANY')),
  context_window      INTEGER,
  supports_vision     BOOLEAN       NOT NULL DEFAULT FALSE,
  supports_streaming  BOOLEAN       NOT NULL DEFAULT TRUE,
  adapter             TEXT          NOT NULL DEFAULT 'openai'
                      CHECK (adapter IN ('openai','anthropic','google')),
  is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
  priority            SMALLINT      NOT NULL DEFAULT 0,
  avg_latency_ms      INTEGER,
  success_rate_pct    NUMERIC(5,2)  DEFAULT 100,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Safe migration: add adapter column if table already exists from old schema
ALTER TABLE public.llm_providers ADD COLUMN IF NOT EXISTS adapter TEXT NOT NULL DEFAULT 'openai';

INSERT INTO public.llm_providers
  (provider_name, model_name, display_name, base_url, cost_per_1m_tokens, tier_capability, priority, supports_vision, adapter)
VALUES
  ('OpenAI',    'gpt-4o',                          'GPT-4o',          'https://api.openai.com/v1',                                         5.00, 'HIGH', 10, TRUE,  'openai'),
  ('OpenAI',    'gpt-4o-mini',                     'GPT-4o-mini',     'https://api.openai.com/v1',                                         0.15, 'MED',  10, FALSE, 'openai'),
  ('Google',    'gemini-2.0-flash-exp',            'Gemini 2.0 Flash','https://generativelanguage.googleapis.com/v1beta/openai',            0.10, 'LOW',   5, FALSE, 'google'),
  ('Anthropic', 'claude-3-5-sonnet-20241022',      'Claude Sonnet',   'https://api.anthropic.com/v1',                                      3.00, 'HIGH', 20, TRUE,  'anthropic'),
  ('Anthropic', 'claude-3-haiku-20240307',         'Claude Haiku',    'https://api.anthropic.com/v1',                                      0.25, 'MED',  20, FALSE, 'anthropic'),
  ('Groq',      'llama3-70b-8192',                 'Llama3-70B (Groq)','https://api.groq.com/openai/v1',                                   0.59, 'MED',   3, FALSE, 'openai'),
  ('Together',  'mistralai/Mixtral-8x7B-Instruct-v0.1','Mixtral-8x7B','https://api.together.xyz/v1',                                      0.27, 'LOW',   3, FALSE, 'openai')
ON CONFLICT (model_name) DO NOTHING;

CREATE INDEX IF NOT EXISTS llm_prov_tier_idx   ON public.llm_providers(tier_capability, is_active);
CREATE INDEX IF NOT EXISTS llm_prov_active_idx ON public.llm_providers(is_active, priority);
ALTER TABLE public.llm_providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "llm_providers_read" ON public.llm_providers;
CREATE POLICY "llm_providers_read" ON public.llm_providers FOR SELECT TO authenticated USING (is_active = TRUE);

-- ─── 4. API LOGS (depends on llm_providers FK) ──────────────
CREATE TABLE IF NOT EXISTS public.api_logs (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id        UUID          NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  prompt_hash      TEXT,
  prompt_preview   TEXT,
  uc               TEXT,
  cx               TEXT          NOT NULL,
  original_cx      TEXT,
  rule             TEXT,
  lang             TEXT,
  modal            TEXT,
  auto_learn       BOOLEAN       NOT NULL DEFAULT FALSE,
  provider_id      UUID          REFERENCES public.llm_providers(id) ON DELETE SET NULL,
  model_name       TEXT,
  tokens_in        INTEGER       NOT NULL DEFAULT 0,
  tokens_out       INTEGER       NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(14,8) NOT NULL DEFAULT 0,
  savings_pct      INTEGER,
  is_cache_hit     BOOLEAN       NOT NULL DEFAULT FALSE,
  latency_ms       INTEGER,
  status_code      SMALLINT,
  error_message    TEXT,
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_logs_client_idx  ON public.api_logs(client_id);
CREATE INDEX IF NOT EXISTS api_logs_hash_idx    ON public.api_logs(prompt_hash);
CREATE INDEX IF NOT EXISTS api_logs_created_idx ON public.api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS api_logs_cache_idx   ON public.api_logs(is_cache_hit, client_id);
ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "api_logs_read_own" ON public.api_logs;
CREATE POLICY "api_logs_read_own" ON public.api_logs FOR SELECT USING (client_id = auth.uid());

-- ─── 5. ANNOTATION QUEUE ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.annotation_queue (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id        UUID        REFERENCES public.clients(id) ON DELETE SET NULL,
  api_log_id       UUID        REFERENCES public.api_logs(id) ON DELETE SET NULL,
  prompt           TEXT        NOT NULL,
  predicted_cx     TEXT        NOT NULL,
  triggered_rule   TEXT,
  lang             TEXT,
  uc               TEXT,
  confirmed_cx     TEXT,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','done','skipped')),
  annotated_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  annotated_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS aq_status_idx  ON public.annotation_queue(status);
CREATE INDEX IF NOT EXISTS aq_created_idx ON public.annotation_queue(created_at DESC);
ALTER TABLE public.annotation_queue ENABLE ROW LEVEL SECURITY;

-- ─── 6. TENANT CACHE POOL ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_cache_pool (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID          NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  prompt_hash         TEXT          NOT NULL,
  normalized_prompt   TEXT          NOT NULL,
  response_text       TEXT          NOT NULL,
  model_used          TEXT,
  cx                  TEXT,
  hit_count           INTEGER       NOT NULL DEFAULT 1,
  last_accessed_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  original_cost_usd   NUMERIC(14,8) NOT NULL DEFAULT 0,
  total_saved_usd     NUMERIC(14,8) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS tcp_client_hash_idx ON public.tenant_cache_pool(client_id, prompt_hash);
CREATE INDEX IF NOT EXISTS tcp_client_idx          ON public.tenant_cache_pool(client_id);
CREATE INDEX IF NOT EXISTS tcp_last_accessed_idx   ON public.tenant_cache_pool(last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS tcp_expires_idx         ON public.tenant_cache_pool(expires_at) WHERE expires_at IS NOT NULL;
ALTER TABLE public.tenant_cache_pool ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tcp_own_client" ON public.tenant_cache_pool;
CREATE POLICY "tcp_own_client" ON public.tenant_cache_pool FOR ALL USING (client_id = auth.uid());

-- ─── 7. PROMPT FREQUENCY LOG ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.prompt_frequency_log (
  id           BIGSERIAL   PRIMARY KEY,
  client_id    UUID        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  prompt_hash  TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pfl_lookup_idx ON public.prompt_frequency_log(client_id, prompt_hash, created_at DESC);
ALTER TABLE public.prompt_frequency_log ENABLE ROW LEVEL SECURITY;

-- ─── HELPER FUNCTIONS ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_cache_hit(p_client_id UUID, p_hash TEXT, p_saved_usd NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.tenant_cache_pool
  SET hit_count = hit_count + 1, last_accessed_at = NOW(), total_saved_usd = total_saved_usd + p_saved_usd
  WHERE client_id = p_client_id AND prompt_hash = p_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.should_promote_to_cache(p_client_id UUID, p_hash TEXT, p_threshold INT DEFAULT 3, p_window_hours INT DEFAULT 24)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE freq_count INT;
BEGIN
  SELECT COUNT(*) INTO freq_count FROM public.prompt_frequency_log
  WHERE client_id = p_client_id AND prompt_hash = p_hash AND created_at > NOW() - (p_window_hours || ' hours')::INTERVAL;
  RETURN freq_count >= p_threshold;
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_quota_used(p_client_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.clients SET quota_used = quota_used + 1, updated_at = NOW() WHERE id = p_client_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_client_id UUID, p_amount NUMERIC)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.clients SET balance_credits = GREATEST(balance_credits - p_amount, 0), updated_at = NOW() WHERE id = p_client_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin(p_user_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.clients WHERE id = p_user_id AND is_admin = TRUE);
END;
$$;
