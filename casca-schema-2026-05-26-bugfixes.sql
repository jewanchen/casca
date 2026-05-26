-- ════════════════════════════════════════════════════════════════
--  2026-05-26 — endpoint bug fixes
-- ════════════════════════════════════════════════════════════════
--
-- Run this in Supabase SQL Editor (project: casca-V2, id: azxutenowfoamphdjwya).
-- Idempotent: safe to re-run.
--
-- Bug #2 — /api/lead 500
--   Symptom: POST /api/lead returns 500. Root cause: server-v2.js writes
--   to `public.leads` table but the table doesn't exist. PostgREST
--   returns PGRST205 "Could not find the table 'public.leads'".
--   Source: server-v2.js::POST /api/lead (~line 2491).
--   Fix: CREATE TABLE.
--
-- Bug #3 — /api/admin/plans PATCH/DELETE 500
--   Symptom: Either endpoint returns 500 with error "Could not find the
--   'updated_at' column of 'subscription_plans' in the schema cache".
--   Source: server-v2.js::PATCH /api/admin/plans/:id (~line 2977),
--           server-v2.js::DELETE /api/admin/plans/:id (~line 2990).
--   Both handlers set `updates.updated_at = new Date().toISOString()`,
--   but the column was never added when the table was created.
--   Fix: ALTER TABLE ADD COLUMN.
-- ════════════════════════════════════════════════════════════════

-- ── Bug #2: create public.leads ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leads (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       TEXT NOT NULL UNIQUE,
  source      TEXT,                                        -- e.g. 'landing_cta', 'enterprise_form'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for source-based lookup (admin reports)
CREATE INDEX IF NOT EXISTS leads_source_idx ON public.leads (source);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON public.leads (created_at DESC);

-- RLS: server writes via service role (bypasses RLS); no client/anon access
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies — service role only. Admin dashboard reads
-- via /api/admin/* which uses service role.

-- ── Bug #3: add updated_at to subscription_plans ─────────────────
ALTER TABLE public.subscription_plans
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill existing rows to the current time (DEFAULT now() applied at
-- ALTER time, so this is effectively a no-op if column was just added).
-- Explicit UPDATE makes intent clear.
UPDATE public.subscription_plans
  SET updated_at = COALESCE(updated_at, now())
  WHERE updated_at IS NULL;
