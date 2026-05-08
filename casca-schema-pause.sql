-- ══════════════════════════════════════════════════════════════
--  CASCA Pause Subscription — Schema Migration
--
--  Run in: Supabase Dashboard → SQL Editor
--  Idempotent (safe to run multiple times)
--  Generated: 2026-05-07
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
--  1. Expand status CHECK constraint to include 'paused' and 'archived'
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients DROP CONSTRAINT IF EXISTS clients_status_check;
ALTER TABLE public.clients ADD CONSTRAINT clients_status_check
  CHECK (status IN ('active', 'trial', 'suspended', 'churned', 'paused', 'archived'));

-- ─────────────────────────────────────────────────────────────
--  2. Add pause-related columns
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS pause_expires_at TIMESTAMPTZ;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS pause_reason TEXT;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.clients.paused_at IS
  'Timestamp when subscription was paused. NULL if not paused.';
COMMENT ON COLUMN public.clients.pause_expires_at IS
  'Auto-archive deadline (paused_at + 90 days). NULL if not paused.';
COMMENT ON COLUMN public.clients.pause_reason IS
  'Optional reason provided by customer when pausing.';
COMMENT ON COLUMN public.clients.archived_at IS
  'Timestamp when account was auto-archived (90 days after pause without resume).';

-- ─────────────────────────────────────────────────────────────
--  3. Index for cron job (find accounts to auto-archive)
-- ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_clients_pause_expires
  ON public.clients(pause_expires_at)
  WHERE status = 'paused';

-- ─────────────────────────────────────────────────────────────
--  4. RPC: pause_subscription
--     Called from server endpoint
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pause_subscription(
  p_client_id UUID,
  p_duration_months INTEGER DEFAULT 3,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_client RECORD;
  v_paused_at TIMESTAMPTZ;
  v_expires_at TIMESTAMPTZ;
BEGIN
  -- Validate duration
  IF p_duration_months < 1 OR p_duration_months > 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Duration must be 1-3 months');
  END IF;

  -- Get current client
  SELECT id, status, plan_id INTO v_client
  FROM public.clients WHERE id = p_client_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Client not found');
  END IF;

  -- Only active accounts can be paused
  IF v_client.status != 'active' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'Only active accounts can be paused. Current status: ' || v_client.status);
  END IF;

  v_paused_at := NOW();
  v_expires_at := v_paused_at + (p_duration_months || ' months')::INTERVAL;

  -- Cap at 90 days max
  IF v_expires_at > v_paused_at + INTERVAL '90 days' THEN
    v_expires_at := v_paused_at + INTERVAL '90 days';
  END IF;

  UPDATE public.clients
  SET status = 'paused',
      paused_at = v_paused_at,
      pause_expires_at = v_expires_at,
      pause_reason = p_reason,
      updated_at = NOW()
  WHERE id = p_client_id;

  RETURN jsonb_build_object(
    'ok', true,
    'paused_at', v_paused_at,
    'pause_expires_at', v_expires_at
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  5. RPC: resume_subscription
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resume_subscription(p_client_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_client RECORD;
BEGIN
  SELECT id, status, pause_expires_at INTO v_client
  FROM public.clients WHERE id = p_client_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Client not found');
  END IF;

  IF v_client.status != 'paused' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      'Account is not paused. Current status: ' || v_client.status);
  END IF;

  UPDATE public.clients
  SET status = 'active',
      paused_at = NULL,
      pause_expires_at = NULL,
      pause_reason = NULL,
      updated_at = NOW()
  WHERE id = p_client_id;

  RETURN jsonb_build_object('ok', true, 'resumed_at', NOW());
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  6. RPC: archive_expired_pauses
--     Called by server cron hourly
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_expired_pauses()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH archived AS (
    UPDATE public.clients
    SET status = 'archived',
        archived_at = NOW(),
        updated_at = NOW()
    WHERE status = 'paused'
      AND pause_expires_at <= NOW()
    RETURNING id
  )
  SELECT COUNT(*) INTO v_count FROM archived;
  RETURN v_count;
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
    AND column_name IN ('paused_at', 'pause_expires_at', 'pause_reason', 'archived_at');

  SELECT COUNT(*) INTO v_funcs
  FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN ('pause_subscription', 'resume_subscription', 'archive_expired_pauses');

  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  Pause Subscription Schema Verification';
  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  New columns on clients: %/4', v_cols;
  RAISE NOTICE '  New functions:          %/3', v_funcs;
  IF v_cols = 4 AND v_funcs >= 3 THEN
    RAISE NOTICE '  ✓ Pause Subscription PASSED';
  ELSE
    RAISE WARNING '  ✗ Pause Subscription INCOMPLETE';
  END IF;
  RAISE NOTICE '══════════════════════════════════════';
END;
$$;
