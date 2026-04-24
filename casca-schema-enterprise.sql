-- ══════════════════════════════════════════════════════════════
--  CASCA Enterprise — Self-Hosted Management Schema
--
--  Tables:
--    1. enterprise_licenses      — 授權管理
--    2. enterprise_deployments   — 部署狀態（Agent heartbeat）
--    3. enterprise_usage         — 用量回報（計費用）
--    4. enterprise_audit         — 稽核紀錄
--    5. enterprise_releases      — 軟體版本管理
--
--  Run in: Supabase Dashboard → SQL Editor
--  Idempotent (safe to run multiple times)
--  Generated: 2026-04-24
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
--  1. Enterprise Licenses
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enterprise_licenses (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_name     TEXT          NOT NULL,
  client_contact  TEXT,                                -- email / phone
  license_key     TEXT          NOT NULL UNIQUE,        -- ent_xxx format
  license_type    TEXT          NOT NULL DEFAULT 'online'
                  CHECK (license_type IN ('online', 'offline')),
  machine_id      TEXT,                                -- bound to specific hardware
  features        JSONB         NOT NULL DEFAULT '["L1","L2","cache"]'::jsonb,
  token_limit_monthly BIGINT   NOT NULL DEFAULT 0,     -- 0 = unlimited (online metered)
  max_qps         INTEGER       DEFAULT 100,
  expires_at      TIMESTAMPTZ   NOT NULL,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_el_key ON public.enterprise_licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_el_active ON public.enterprise_licenses(is_active);

ALTER TABLE public.enterprise_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "el_service" ON public.enterprise_licenses
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  2. Enterprise Deployments (Agent heartbeat state)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enterprise_deployments (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  license_id       UUID         NOT NULL REFERENCES public.enterprise_licenses(id) ON DELETE CASCADE,
  machine_id       TEXT,
  engine_version   TEXT,
  minilm_version   TEXT,
  agent_version    TEXT,
  os_info          TEXT,
  cpu_cores        INTEGER,
  ram_gb           NUMERIC(6,1),
  last_heartbeat   TIMESTAMPTZ,
  status           TEXT         NOT NULL DEFAULT 'unknown'
                   CHECK (status IN ('online', 'offline', 'warning', 'air-gapped', 'unknown')),
  metadata         JSONB        DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ed_license ON public.enterprise_deployments(license_id);

ALTER TABLE public.enterprise_deployments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ed_service" ON public.enterprise_deployments
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  3. Enterprise Usage Reports (hourly from Agent)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enterprise_usage (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  license_id      UUID          NOT NULL REFERENCES public.enterprise_licenses(id) ON DELETE CASCADE,
  period_start    TIMESTAMPTZ   NOT NULL,
  period_end      TIMESTAMPTZ   NOT NULL,
  total_tokens    BIGINT        NOT NULL DEFAULT 0,
  request_count   INTEGER       NOT NULL DEFAULT 0,
  breakdown       JSONB         DEFAULT '{}'::jsonb,
  -- breakdown: { "HIGH": { "count": N, "tokens": N },
  --              "MED": ..., "LOW": ..., "CACHE": ... }
  reported_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_eu_license ON public.enterprise_usage(license_id);
CREATE INDEX IF NOT EXISTS idx_eu_period ON public.enterprise_usage(period_start DESC);

ALTER TABLE public.enterprise_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "eu_service" ON public.enterprise_usage
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  4. Enterprise Audit Log
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enterprise_audit (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  license_id      UUID          REFERENCES public.enterprise_licenses(id) ON DELETE SET NULL,
  event_type      TEXT          NOT NULL,
  -- Event types: HEARTBEAT, USAGE_REPORT, LICENSE_OK, LICENSE_WARN,
  -- LICENSE_EXPIRED, LICENSE_GEN, LICENSE_REVOKE, UPDATE_OK,
  -- UPDATE_FAIL, UPDATE_ROLLBACK, ALERT, ADMIN_ACTION
  detail          JSONB         DEFAULT '{}'::jsonb,
  ip_address      TEXT,
  actor           TEXT,          -- 'agent' | 'admin' | admin email
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ea_license ON public.enterprise_audit(license_id);
CREATE INDEX IF NOT EXISTS idx_ea_type ON public.enterprise_audit(event_type);
CREATE INDEX IF NOT EXISTS idx_ea_created ON public.enterprise_audit(created_at DESC);

ALTER TABLE public.enterprise_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ea_service" ON public.enterprise_audit
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  5. Enterprise Releases (version management)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.enterprise_releases (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  version         TEXT          NOT NULL UNIQUE,
  release_type    TEXT          NOT NULL DEFAULT 'patch'
                  CHECK (release_type IN ('major', 'minor', 'patch', 'hotfix')),
  changelog       TEXT,
  download_url    TEXT,          -- signed URL or internal path
  checksum_sha256 TEXT,
  size_mb         NUMERIC(10,2),
  engine_version  TEXT,          -- e.g. "3.3.1"
  minilm_version  TEXT,          -- e.g. "v20260421_083303"
  is_current      BOOLEAN       NOT NULL DEFAULT FALSE,
  published_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.enterprise_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "er_service" ON public.enterprise_releases
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  6. Helper: generate enterprise license key
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gen_enterprise_license_key()
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'ent_' || encode(gen_random_bytes(16), 'hex');
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  7. Helper: monthly usage summary per license
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enterprise_monthly_summary(
  p_year INTEGER DEFAULT EXTRACT(YEAR FROM NOW())::INTEGER,
  p_month INTEGER DEFAULT EXTRACT(MONTH FROM NOW())::INTEGER
)
RETURNS TABLE (
  license_id UUID,
  client_name TEXT,
  total_tokens BIGINT,
  total_requests BIGINT,
  period TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    SELECT
      u.license_id,
      l.client_name,
      COALESCE(SUM(u.total_tokens), 0)::BIGINT AS total_tokens,
      COALESCE(SUM(u.request_count), 0)::BIGINT AS total_requests,
      (p_year || '-' || LPAD(p_month::TEXT, 2, '0'))::TEXT AS period
    FROM public.enterprise_usage u
    JOIN public.enterprise_licenses l ON l.id = u.license_id
    WHERE EXTRACT(YEAR FROM u.period_start) = p_year
      AND EXTRACT(MONTH FROM u.period_start) = p_month
    GROUP BY u.license_id, l.client_name;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  8. Verify
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tables INTEGER;
  v_funcs INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('enterprise_licenses', 'enterprise_deployments',
                       'enterprise_usage', 'enterprise_audit', 'enterprise_releases');

  SELECT COUNT(*) INTO v_funcs
  FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN ('gen_enterprise_license_key', 'enterprise_monthly_summary');

  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  Enterprise Schema Verification';
  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  Tables:    %/5', v_tables;
  RAISE NOTICE '  Functions: %/2', v_funcs;
  IF v_tables = 5 AND v_funcs >= 2 THEN
    RAISE NOTICE '  ✓ Enterprise Schema PASSED';
  ELSE
    RAISE WARNING '  ✗ Enterprise Schema INCOMPLETE';
  END IF;
  RAISE NOTICE '══════════════════════════════════════';
END;
$$;
