-- ══════════════════════════════════════════════════════════════
--  CASCA Leads — Landing page CTA email capture
--  Run in: Supabase Dashboard → SQL Editor
--  Idempotent
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.leads (
  id          BIGSERIAL   PRIMARY KEY,
  email       TEXT        NOT NULL UNIQUE,
  source      TEXT        DEFAULT 'landing_cta',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON public.leads(created_at DESC);

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

-- Only service role can insert/read (server-side only)
CREATE POLICY "Service role full access" ON public.leads
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE public.leads IS 'Email leads captured from landing page CTA forms.';
