-- ══════════════════════════════════════════════════════════════
--  CASCA Path B — Training Pipeline Schema
--
--  Run in: Supabase Dashboard → SQL Editor → New Query
--
--  Tables:
--    1. training_samples     — 每筆請求的 L1/L2/Judge 分類對照
--    2. rule_accuracy_stats  — per-rule 正確率統計（動態 confidence 來源）
--    3. minilm_versions      — MiniLM 模型版本紀錄
--
--  All statements are idempotent (safe to run multiple times).
--  Generated: 2026-04-13
-- ══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────
--  1. training_samples
--     每筆 API 請求經 PII masking 後的分類對照紀錄
--     LLM Judge (GPT-4o-mini) 提供 ground truth
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.training_samples (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  prompt_masked     TEXT          NOT NULL,

  -- L1: Casca Classifier (規則引擎)
  l1_label          TEXT          NOT NULL CHECK (l1_label IN ('HIGH','MED','LOW','AMBIG')),
  l1_rule           TEXT,
  l1_static_conf    INTEGER,                    -- 規則寫死的 confidence (25-95)
  l1_dynamic_conf   NUMERIC(5,1),               -- static_conf × rule_accuracy_rate

  -- L2: MiniLM (若有觸發)
  l2_label          TEXT          CHECK (l2_label IN ('HIGH','MED','LOW') OR l2_label IS NULL),
  l2_confidence     NUMERIC(5,3),               -- softmax 機率
  l2_invoked        BOOLEAN       NOT NULL DEFAULT FALSE,

  -- LLM Judge (ground truth)
  judge_label       TEXT          NOT NULL CHECK (judge_label IN ('HIGH','MED','LOW')),
  judge_model       TEXT          NOT NULL DEFAULT 'gpt-4o-mini',

  -- 比對結果
  l1_correct        BOOLEAN       NOT NULL,     -- l1_label = judge_label
  l2_correct        BOOLEAN,                    -- l2_label = judge_label (NULL if L2 not invoked)
  serving_label     TEXT          NOT NULL CHECK (serving_label IN ('HIGH','MED','LOW')),
  serving_correct   BOOLEAN       NOT NULL,     -- serving_label = judge_label

  -- 元資訊
  lang              TEXT,
  domain            TEXT,
  source            TEXT          NOT NULL DEFAULT 'live'
                    CHECK (source IN ('live','batch','cold_start')),
  client_id         UUID,                       -- optional, for per-tenant analysis
  used_for_training BOOLEAN       NOT NULL DEFAULT FALSE,
  model_version     TEXT,                       -- 被哪版 MiniLM 訓練過
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ts_created
  ON public.training_samples(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ts_rule
  ON public.training_samples(l1_rule);
CREATE INDEX IF NOT EXISTS idx_ts_untrained
  ON public.training_samples(used_for_training)
  WHERE used_for_training = FALSE;
CREATE INDEX IF NOT EXISTS idx_ts_l1_correct
  ON public.training_samples(l1_correct, l1_rule);
CREATE INDEX IF NOT EXISTS idx_ts_source
  ON public.training_samples(source);

ALTER TABLE public.training_samples ENABLE ROW LEVEL SECURITY;

-- Service role full access (server writes all samples)
CREATE POLICY "ts_service" ON public.training_samples
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  2. rule_accuracy_stats
--     Per-rule 正確率統計，用來計算 dynamic_confidence
--     定期由 training pipeline 聚合更新
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.rule_accuracy_stats (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  rule_name       TEXT          NOT NULL UNIQUE,
  total_samples   INTEGER       NOT NULL DEFAULT 0,
  correct_samples INTEGER       NOT NULL DEFAULT 0,
  accuracy_rate   NUMERIC(5,3)  NOT NULL DEFAULT 1.000,  -- correct / total
  status          TEXT          NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('HEALTHY','DEGRADING','BROKEN','NEW')),
  last_updated    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ras_status
  ON public.rule_accuracy_stats(status);

ALTER TABLE public.rule_accuracy_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ras_service" ON public.rule_accuracy_stats
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  3. RPC: upsert_rule_accuracy
--     每次寫入 training_sample 後呼叫，更新該 rule 的統計
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_rule_accuracy(
  p_rule_name   TEXT,
  p_is_correct  BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total   INTEGER;
  v_correct INTEGER;
  v_rate    NUMERIC(5,3);
  v_status  TEXT;
BEGIN
  -- Upsert: insert or update
  INSERT INTO public.rule_accuracy_stats (rule_name, total_samples, correct_samples)
  VALUES (p_rule_name, 1, CASE WHEN p_is_correct THEN 1 ELSE 0 END)
  ON CONFLICT (rule_name) DO UPDATE SET
    total_samples   = rule_accuracy_stats.total_samples + 1,
    correct_samples = rule_accuracy_stats.correct_samples + (CASE WHEN p_is_correct THEN 1 ELSE 0 END),
    last_updated    = NOW();

  -- Recalculate rate and status
  SELECT total_samples, correct_samples INTO v_total, v_correct
  FROM public.rule_accuracy_stats WHERE rule_name = p_rule_name;

  v_rate := CASE WHEN v_total > 0 THEN v_correct::NUMERIC / v_total ELSE 1.0 END;

  -- Status thresholds (only meaningful after enough samples)
  IF v_total < 10 THEN
    v_status := 'NEW';
  ELSIF v_rate < 0.70 THEN
    v_status := 'BROKEN';
  ELSIF v_rate < 0.85 THEN
    v_status := 'DEGRADING';
  ELSE
    v_status := 'HEALTHY';
  END IF;

  UPDATE public.rule_accuracy_stats
  SET accuracy_rate = v_rate, status = v_status
  WHERE rule_name = p_rule_name;
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  4. RPC: get_rule_accuracy
--     查詢某 rule 的正確率（供 dynamic_confidence 計算）
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_rule_accuracy(p_rule_name TEXT)
RETURNS NUMERIC LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_rate NUMERIC(5,3);
BEGIN
  SELECT accuracy_rate INTO v_rate
  FROM public.rule_accuracy_stats
  WHERE rule_name = p_rule_name;

  -- 沒有紀錄 = 假設 100% (新規則尚無資料)
  RETURN COALESCE(v_rate, 1.0);
END;
$$;

-- ─────────────────────────────────────────────────────────────
--  5. minilm_versions
--     MiniLM 模型版本紀錄（訓練履歷 + 線上部署追蹤）
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.minilm_versions (
  id                      UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  version                 TEXT          NOT NULL UNIQUE,
  base_model              TEXT          NOT NULL DEFAULT 'MiniLM-L6-v2',
  training_samples_count  INTEGER       NOT NULL DEFAULT 0,
  val_accuracy            NUMERIC(5,2),
  test_accuracy           NUMERIC(5,2),
  val_f1                  NUMERIC(5,3),
  is_active               BOOLEAN       NOT NULL DEFAULT FALSE,
  checkpoint_path         TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE public.minilm_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "mv_service" ON public.minilm_versions
  FOR ALL USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
--  6. Verify
-- ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_tables INTEGER;
  v_funcs  INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_tables
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('training_samples','rule_accuracy_stats','minilm_versions');

  SELECT COUNT(*) INTO v_funcs
  FROM information_schema.routines
  WHERE routine_schema = 'public'
    AND routine_name IN ('upsert_rule_accuracy','get_rule_accuracy');

  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  CASCA Path B Schema Verification';
  RAISE NOTICE '══════════════════════════════════════';
  RAISE NOTICE '  Tables created:   %/3', v_tables;
  RAISE NOTICE '  Functions created: %/2', v_funcs;

  IF v_tables = 3 AND v_funcs >= 2 THEN
    RAISE NOTICE '  ✓ Path B Schema PASSED';
  ELSE
    RAISE WARNING '  ✗ Path B Schema INCOMPLETE';
  END IF;
  RAISE NOTICE '══════════════════════════════════════';
END;
$$;
