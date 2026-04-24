-- ══════════════════════════════════════════════════════════════
-- Casca Enterprise — Local Database Schema
-- Auto-executed by PostgreSQL on first startup
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- API Logs (local tracking for usage reporting)
CREATE TABLE IF NOT EXISTS public.api_logs (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prompt_hash      TEXT,
  cx               TEXT NOT NULL,
  model_name       TEXT,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  cost_usd         NUMERIC(14,8) NOT NULL DEFAULT 0,
  savings_pct      INTEGER,
  is_cache_hit     BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms       INTEGER,
  status_code      SMALLINT,
  reported         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON public.api_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_reported ON public.api_logs(reported) WHERE reported = FALSE;

-- Semantic Cache Pool
CREATE TABLE IF NOT EXISTS public.tenant_cache_pool (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prompt_hash         TEXT NOT NULL UNIQUE,
  normalized_prompt   TEXT NOT NULL,
  response_text       TEXT NOT NULL,
  model_used          TEXT,
  cx                  TEXT,
  hit_count           INTEGER NOT NULL DEFAULT 1,
  last_accessed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ,
  original_cost_usd   NUMERIC(14,8) NOT NULL DEFAULT 0,
  total_saved_usd     NUMERIC(14,8) NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Prompt Frequency Log (for cache promotion)
CREATE TABLE IF NOT EXISTS public.prompt_frequency_log (
  id           BIGSERIAL PRIMARY KEY,
  prompt_hash  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pfl ON public.prompt_frequency_log(prompt_hash, created_at DESC);

-- Helper functions
CREATE OR REPLACE FUNCTION public.record_cache_hit(p_hash TEXT, p_saved_usd NUMERIC)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.tenant_cache_pool
  SET hit_count = hit_count + 1, last_accessed_at = NOW(), total_saved_usd = total_saved_usd + p_saved_usd
  WHERE prompt_hash = p_hash;
END;
$$;

CREATE OR REPLACE FUNCTION public.should_promote_to_cache(p_hash TEXT, p_threshold INT DEFAULT 3, p_window_hours INT DEFAULT 24)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE freq_count INT;
BEGIN
  SELECT COUNT(*) INTO freq_count FROM public.prompt_frequency_log
  WHERE prompt_hash = p_hash AND created_at > NOW() - (p_window_hours || ' hours')::INTERVAL;
  RETURN freq_count >= p_threshold;
END;
$$;

-- Mark logs as reported (for Agent usage reporting)
CREATE OR REPLACE FUNCTION public.get_unreported_usage()
RETURNS TABLE (total_tokens BIGINT, request_count BIGINT, breakdown JSONB) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
    SELECT
      COALESCE(SUM(tokens_in + tokens_out), 0)::BIGINT,
      COUNT(*)::BIGINT,
      jsonb_build_object(
        'HIGH', jsonb_build_object('count', COUNT(*) FILTER (WHERE cx = 'HIGH'), 'tokens', COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE cx = 'HIGH'), 0)),
        'MED',  jsonb_build_object('count', COUNT(*) FILTER (WHERE cx = 'MED'),  'tokens', COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE cx = 'MED'), 0)),
        'LOW',  jsonb_build_object('count', COUNT(*) FILTER (WHERE cx = 'LOW'),  'tokens', COALESCE(SUM(tokens_in + tokens_out) FILTER (WHERE cx = 'LOW'), 0)),
        'CACHE',jsonb_build_object('count', COUNT(*) FILTER (WHERE is_cache_hit), 'tokens', 0)
      )
    FROM public.api_logs WHERE reported = FALSE;

  UPDATE public.api_logs SET reported = TRUE WHERE reported = FALSE;
END;
$$;
