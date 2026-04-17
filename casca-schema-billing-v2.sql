-- ══════════════════════════════════════════════════════════════
--  CASCA Billing v2 — Weekly Quota + Account Type + Overage Control
--
--  Run in: Supabase Dashboard → SQL Editor
--  Idempotent (safe to run multiple times)
--  Generated: 2026-04-17
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
--  1. Account type + billing mode
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'passthrough'
    CHECK (account_type IN ('passthrough', 'managed', 'both'));

COMMENT ON COLUMN public.clients.account_type IS
  'passthrough = uses own LLM keys | managed = uses Casca LLM keys | both = switches per-request';

-- ─────────────────────────────────────────────────────────────
--  2. Weekly credit system (for Managed Free)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS weekly_credit_usd NUMERIC(10,4) NOT NULL DEFAULT 3.00;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS weekly_credit_used_usd NUMERIC(10,4) NOT NULL DEFAULT 0;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS weekly_reset_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

COMMENT ON COLUMN public.clients.weekly_credit_usd IS
  'Weekly LLM credit for Managed Free users. Default $3/week. Paid plans override with monthly quota.';

-- ─────────────────────────────────────────────────────────────
--  3. Quota pause + overage control
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS quota_paused BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS overage_approved BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.clients.quota_paused IS
  'TRUE when weekly/monthly quota exhausted. Service paused until reset or overage approval.';
COMMENT ON COLUMN public.clients.overage_approved IS
  'TRUE = client has approved overage billing beyond quota. Resets each billing cycle.';

-- ─────────────────────────────────────────────────────────────
--  4. Trial tracking
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_type TEXT
    CHECK (trial_type IN ('passthrough', 'managed') OR trial_type IS NULL);

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_extended_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_token_limit BIGINT NOT NULL DEFAULT 0;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_tokens_used BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.clients.trial_type IS
  'Which mode is on trial. NULL = not on trial.';
COMMENT ON COLUMN public.clients.trial_extended_count IS
  'How many times trial has been extended. Passthrough max=admin-decided. Managed: N/A (weekly reset).';
COMMENT ON COLUMN public.clients.trial_token_limit IS
  'Passthrough trial: 5B tokens. 0 = unlimited (paid plan).';

-- ─────────────────────────────────────────────────────────────
--  5. RPC: reset_weekly_credits
--     Called by server cron every Monday
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reset_weekly_credits()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH reset AS (
    UPDATE public.clients
    SET weekly_credit_used_usd = 0,
        weekly_reset_at = NOW(),
        quota_paused = FALSE,
        overage_approved = FALSE,
        updated_at = NOW()
    WHERE account_type IN ('managed', 'both')
      AND plan_id IS NULL                    -- only Free plan users (no paid subscription)
      AND weekly_credit_used_usd > 0         -- only those who used credit
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM reset;
  RETURN v_count;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  6. RPC: check_and_deduct_weekly_credit
--     Called before each Managed LLM call for Free users
--     Returns: TRUE = allowed, FALSE = quota paused
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_and_deduct_weekly_credit(
  p_client_id UUID,
  p_cost_usd NUMERIC
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_credit NUMERIC;
  v_used NUMERIC;
  v_paused BOOLEAN;
  v_approved BOOLEAN;
BEGIN
  SELECT weekly_credit_usd, weekly_credit_used_usd, quota_paused, overage_approved
  INTO v_credit, v_used, v_paused, v_approved
  FROM public.clients WHERE id = p_client_id;

  -- Already paused and not approved overage
  IF v_paused AND NOT v_approved THEN
    RETURN FALSE;
  END IF;

  -- Check if this request would exceed quota
  IF (v_used + p_cost_usd) > v_credit AND NOT v_approved THEN
    -- Pause the account
    UPDATE public.clients
    SET quota_paused = TRUE, updated_at = NOW()
    WHERE id = p_client_id;
    RETURN FALSE;
  END IF;

  -- Deduct
  UPDATE public.clients
  SET weekly_credit_used_usd = weekly_credit_used_usd + p_cost_usd,
      updated_at = NOW()
  WHERE id = p_client_id;

  RETURN TRUE;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  7. Verify
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cols INTEGER;
  v_funcs INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'clients'
    AND column_name IN ('account_type','weekly_credit_usd','weekly_credit_used_usd',
                        'weekly_reset_at','quota_paused','overage_approved',
                        'trial_type','trial_extended_count','trial_token_limit','trial_tokens_used');

  SELECT COUNT(*) INTO v_funcs
  FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN ('reset_weekly_credits','check_and_deduct_weekly_credit');

  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  Billing v2 Schema Verification';
  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  New columns on clients: %/10', v_cols;
  RAISE NOTICE '  New functions:          %/2', v_funcs;
  IF v_cols = 10 AND v_funcs >= 2 THEN
    RAISE NOTICE '  ✓ Billing v2 PASSED';
  ELSE
    RAISE WARNING '  ✗ Billing v2 INCOMPLETE';
  END IF;
  RAISE NOTICE '══════════════════════════════════════';
END;
$$;
