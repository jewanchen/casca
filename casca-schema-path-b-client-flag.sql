-- ══════════════════════════════════════════════════════════════
--  CASCA Path B — Per-client LLM Judge control
--  Run in: Supabase Dashboard → SQL Editor
--  Idempotent (safe to run multiple times)
-- ══════════════════════════════════════════════════════════════

-- Add flag to control whether a client's prompts are sent to LLM Judge
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS path_b_judge_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.clients.path_b_judge_enabled IS
  'When FALSE, this client''s prompts are NOT sent to LLM Judge for training. Used to save cost once a client''s patterns are well-learned.';

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'clients'
  AND column_name = 'path_b_judge_enabled';
