-- ══════════════════════════════════════════════════════════════
--  CASCA Migration: v2.1 → v3 (server-v2.js compatibility)
--  
--  Run in: Supabase Dashboard → SQL Editor → New Query
--  
--  This migration adds everything server-v2.js (v3 billing) 
--  expects but casca-schema-v2.sql doesn't provide.
--  All statements are idempotent (safe to run multiple times).
--
--  Generated: 2026-03-30
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
--  1. subscription_plans table
--     Required by: requireApiKey() JOIN, checkBillingGate(),
--                  Stripe webhook, admin endpoints
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT          NOT NULL UNIQUE,
  monthly_fee_usd     NUMERIC(10,2) NOT NULL DEFAULT 0,
  included_m_tokens   NUMERIC(10,2) NOT NULL DEFAULT 0,
  overage_rate_per_1m NUMERIC(10,4) NOT NULL DEFAULT 1.00,
  features            JSONB         DEFAULT '{}'::jsonb,
  is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Seed a Free plan so existing clients don't break
INSERT INTO public.subscription_plans (name, monthly_fee_usd, included_m_tokens, overage_rate_per_1m)
VALUES ('Free', 0, 1, 0)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "plans_read" ON public.subscription_plans;
CREATE POLICY "plans_read" ON public.subscription_plans
  FOR SELECT TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
--  2. clients table — add missing v3 columns
--     Required by: requireApiKey() SELECT, billing gate,
--                  trial management, Stripe integration
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES public.subscription_plans(id);
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS cycle_used_tokens BIGINT NOT NULL DEFAULT 0;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS billing_cycle_start TIMESTAMPTZ;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS stripe_sub_id TEXT;

-- Index for hash-based auth lookup
CREATE INDEX IF NOT EXISTS clients_api_key_hash_idx ON public.clients(api_key_hash);

-- Back-fill api_key_hash for existing clients that have plaintext api_key
-- This makes existing csk_ keys work with the SHA-256 auth in server-v2.js
UPDATE public.clients
SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex')
WHERE api_key IS NOT NULL
  AND api_key_hash IS NULL;

-- Set default plan_id to Free for all existing clients
UPDATE public.clients
SET plan_id = (SELECT id FROM public.subscription_plans WHERE name = 'Free' LIMIT 1)
WHERE plan_id IS NULL;

-- ─────────────────────────────────────────────────────────────
--  3. transactions table
--     Required by: Stripe webhook (checkout, invoice.paid)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.transactions (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID          NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  stripe_session_id   TEXT,
  stripe_invoice_id   TEXT,
  amount_usd          NUMERIC(10,2) NOT NULL DEFAULT 0,
  type                TEXT          NOT NULL DEFAULT 'topup'
                      CHECK (type IN ('topup', 'subscription', 'overage', 'refund')),
  status              TEXT          NOT NULL DEFAULT 'completed'
                      CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  description         TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS txn_client_idx ON public.transactions(client_id);
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "txn_own" ON public.transactions;
CREATE POLICY "txn_own" ON public.transactions
  FOR SELECT USING (client_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
--  4. RPC functions required by server-v2.js
-- ─────────────────────────────────────────────────────────────

-- 4a. account_usage_and_deduct — called after every LLM call
CREATE OR REPLACE FUNCTION public.account_usage_and_deduct(
  p_client_id       UUID,
  p_plan_id         UUID,
  p_tokens_used     BIGINT,
  p_overage_rate    NUMERIC DEFAULT 0
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_included  BIGINT;
  v_used      BIGINT;
  v_overage   NUMERIC;
BEGIN
  -- Get included tokens from plan
  SELECT COALESCE(included_m_tokens, 0) * 1000000 INTO v_included
  FROM public.subscription_plans WHERE id = p_plan_id;

  -- Get current cycle usage
  SELECT COALESCE(cycle_used_tokens, 0) INTO v_used
  FROM public.clients WHERE id = p_client_id;

  -- Update cycle usage
  UPDATE public.clients
  SET cycle_used_tokens = COALESCE(cycle_used_tokens, 0) + p_tokens_used,
      updated_at = NOW()
  WHERE id = p_client_id;

  -- If over included quota, deduct from balance
  IF (v_used + p_tokens_used) > v_included AND p_overage_rate > 0 THEN
    v_overage := (p_tokens_used::NUMERIC / 1000000) * p_overage_rate;
    UPDATE public.clients
    SET balance_credits = GREATEST(balance_credits - v_overage, 0)
    WHERE id = p_client_id;
  END IF;
END;
$$;

-- 4b. topup_balance — called by Stripe checkout webhook
CREATE OR REPLACE FUNCTION public.topup_balance(
  p_client_id       UUID,
  p_amount_usd      NUMERIC,
  p_stripe_session   TEXT DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.clients
  SET balance_credits = balance_credits + p_amount_usd,
      updated_at = NOW()
  WHERE id = p_client_id;

  INSERT INTO public.transactions (client_id, stripe_session_id, amount_usd, type, status, description)
  VALUES (p_client_id, p_stripe_session, p_amount_usd, 'topup', 'completed', 'Balance top-up');
END;
$$;

-- 4c. reset_billing_cycle — called by Stripe invoice.paid webhook
CREATE OR REPLACE FUNCTION public.reset_billing_cycle(p_client_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE public.clients
  SET cycle_used_tokens = 0,
      billing_cycle_start = NOW(),
      updated_at = NOW()
  WHERE id = p_client_id;
END;
$$;

-- 4d. expire_trials — called on server boot + hourly cron
CREATE OR REPLACE FUNCTION public.expire_trials()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
  v_free_plan_id UUID;
BEGIN
  SELECT id INTO v_free_plan_id
  FROM public.subscription_plans WHERE name = 'Free' LIMIT 1;

  WITH expired AS (
    UPDATE public.clients
    SET plan_id = v_free_plan_id,
        trial_ends_at = NULL,
        status = 'active',
        updated_at = NOW()
    WHERE trial_ends_at IS NOT NULL
      AND trial_ends_at < NOW()
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM expired;

  RETURN v_count;
END;
$$;

-- 4e. extend_trial — called by POST /api/admin/trial/extend
CREATE OR REPLACE FUNCTION public.extend_trial(
  p_client_id UUID,
  p_extra_days INTEGER DEFAULT 7
)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_current TIMESTAMPTZ;
  v_new     TIMESTAMPTZ;
BEGIN
  SELECT trial_ends_at INTO v_current
  FROM public.clients WHERE id = p_client_id;

  -- If trial already expired or not set, extend from now
  IF v_current IS NULL OR v_current < NOW() THEN
    v_new := NOW() + (p_extra_days || ' days')::INTERVAL;
  ELSE
    v_new := v_current + (p_extra_days || ' days')::INTERVAL;
  END IF;

  UPDATE public.clients
  SET trial_ends_at = v_new, status = 'trial', updated_at = NOW()
  WHERE id = p_client_id;

  RETURN v_new;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  5. Auto-hash trigger for new api_key generation
--     When gen_client_api_key() creates a plaintext key,
--     also store the SHA-256 hash for server-v2.js auth lookup
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.gen_client_api_key()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.api_key IS NULL THEN
    NEW.api_key := 'csk_' || encode(gen_random_bytes(20), 'hex');
  END IF;
  -- Also store hash for server-v2.js SHA-256 auth
  NEW.api_key_hash := encode(digest(NEW.api_key, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  6. Verify — run these to confirm migration succeeded
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_plans   INTEGER;
  v_cols    INTEGER;
  v_funcs   INTEGER;
BEGIN
  -- Check subscription_plans exists and has data
  SELECT COUNT(*) INTO v_plans FROM public.subscription_plans;
  
  -- Check all required columns exist on clients
  SELECT COUNT(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'clients'
    AND column_name IN ('api_key_hash','plan_id','cycle_used_tokens',
                        'billing_cycle_start','trial_ends_at','stripe_sub_id');
  
  -- Check required functions exist
  SELECT COUNT(*) INTO v_funcs
  FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN ('expire_trials','account_usage_and_deduct',
                         'topup_balance','reset_billing_cycle','extend_trial');

  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  CASCA v3 Migration Verification';
  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  subscription_plans rows: %', v_plans;
  RAISE NOTICE '  clients v3 columns:      %/6', v_cols;
  RAISE NOTICE '  v3 RPC functions:        %/5', v_funcs;
  
  IF v_cols = 6 AND v_funcs >= 5 THEN
    RAISE NOTICE '  ✓ Migration PASSED';
  ELSE
    RAISE WARNING '  ✗ Migration INCOMPLETE — check above counts';
  END IF;
  RAISE NOTICE '══════════════════════════════════════';
END;
$$;
