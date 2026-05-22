-- ══════════════════════════════════════════════════════════════
--  CASCA Path B — Multi-turn Context Schema Extension
--
--  Adds 4 columns to training_samples so that linguist JSONL multi-turn
--  fields are no longer silently dropped on ingest, and so that L2
--  MiniLM training + inference can use the previous turn as context.
--
--  Run in: Supabase Dashboard → SQL Editor → New Query
--
--  Idempotent. Safe to run multiple times.
--  Generated: 2026-05-19
--  Contract: contracts/2026-05-19_l2-multi-turn-context.md
-- ══════════════════════════════════════════════════════════════

ALTER TABLE public.training_samples
  ADD COLUMN IF NOT EXISTS context_prompt TEXT;

ALTER TABLE public.training_samples
  ADD COLUMN IF NOT EXISTS turn_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.training_samples
  ADD COLUMN IF NOT EXISTS conv_id TEXT;

ALTER TABLE public.training_samples
  ADD COLUMN IF NOT EXISTS last_tier TEXT
    CHECK (last_tier IS NULL OR last_tier IN ('HIGH','MED','LOW'));

-- Index to support per-turn-count slice queries during training analysis.
CREATE INDEX IF NOT EXISTS idx_ts_turn_count
  ON public.training_samples(turn_count)
  WHERE turn_count > 1;

-- Index to support conv-level analysis (multi-row queries by conv_id).
CREATE INDEX IF NOT EXISTS idx_ts_conv_id
  ON public.training_samples(conv_id)
  WHERE conv_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- Verification — run after migration to confirm:
-- ──────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public'
--    AND table_name='training_samples'
--    AND column_name IN ('context_prompt','turn_count','conv_id','last_tier')
--  ORDER BY column_name;
--
-- Expected: 4 rows
--   context_prompt | text    | YES | NULL
--   conv_id        | text    | YES | NULL
--   last_tier      | text    | YES | NULL
--   turn_count     | integer | NO  | 1
