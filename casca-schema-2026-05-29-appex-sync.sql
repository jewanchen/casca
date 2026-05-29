-- ════════════════════════════════════════════════════════════════
--  2026-05-29 — AppExchange Sync Workflow
-- ════════════════════════════════════════════════════════════════
--
-- Per ADR project-architecture/decisions/2026-05-29_appex_sync-workflow.md
-- and contract contracts/2026-05-29_appex_sync-workflow.md.
--
-- Creates appex_sync_commits table to track prod→casca-appexchange syncs.
-- Includes baseline import of all 216 existing commits (status='baseline')
-- so admin UI doesn't get spammed with retroactive notifications.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.appex_sync_commits (
  commit_hash         TEXT PRIMARY KEY,       -- 7-char short hash
  full_hash           TEXT NOT NULL UNIQUE,   -- 40-char full hash
  author              TEXT,                   -- author email or name
  message             TEXT,                   -- commit subject line
  committed_at        TIMESTAMPTZ,            -- author date from git
  files_changed       JSONB DEFAULT '[]'::jsonb, -- files that matched relevant paths (NULL for baseline)
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','skipped','syncing','synced','failed','baseline')),
  decided_at          TIMESTAMPTZ,            -- when admin clicked skip/sync
  decided_by          TEXT,                   -- admin identifier
  decision_notes      TEXT,                   -- e.g. skip reason
  pr_url              TEXT,                   -- casca-appexchange PR link
  pr_merged_at        TIMESTAMPTZ,
  synced_at           TIMESTAMPTZ,
  sync_error          TEXT,                   -- if status='failed'
  notification_sent_at TIMESTAMPTZ,           -- digest email tracking
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS appex_sync_commits_status_idx
  ON public.appex_sync_commits (status, committed_at DESC);
CREATE INDEX IF NOT EXISTS appex_sync_commits_notif_idx
  ON public.appex_sync_commits (notification_sent_at, status)
  WHERE notification_sent_at IS NULL AND status = 'pending';

-- RLS: service role only (admin endpoints, cron, webhook). No client/anon.
ALTER TABLE public.appex_sync_commits ENABLE ROW LEVEL SECURITY;

-- ════════════════════════════════════════════════════════════════
-- Baseline import — all 216 prod commits at migration time.
-- status='baseline' = not synced via workflow, "assumed already in
-- casca-appexchange at time of migration". Will not trigger digest.
-- ════════════════════════════════════════════════════════════════

INSERT INTO public.appex_sync_commits
  (commit_hash, full_hash, author, message, committed_at, status, synced_at)
VALUES
  ('d4b966a', 'd4b966aa8ef08913abfd5db5b3480ebbfb7905dd', 'jewanchen <jewanchen@gmail.com>', 'Initial commit', '2026-03-21T05:31:26+08:00', 'baseline', now()),
  ('6b691e1', '6b691e1e2808fdf3759bf960f94181cb11aef58d', 'jewanchen <jewanchen@gmail.com>', 'Update README.md', '2026-03-21T05:32:03+08:00', 'baseline', now()),
  ('0302dde', '0302ddeaead9953ebafe270d3ed606b89d3bd7a0', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-21T06:01:32+08:00', 'baseline', now()),
  ('5edbf44', '5edbf44e63d38924bc81f391dc00e5bac578aed6', 'jewanchen <jewanchen@gmail.com>', 'Delete index.html', '2026-03-23T09:39:48+08:00', 'baseline', now()),
  ('d46f30a', 'd46f30a288e546b8a5d4d4c8dd53f40bd2ed3d94', 'jewanchen <jewanchen@gmail.com>', 'initial backend upload', '2026-03-23T09:42:52+08:00', 'baseline', now()),
  ('924173b', '924173b5d24dc3790f771d3f658bc1f2d29bdd9e', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-classifier.js', '2026-03-23T10:06:33+08:00', 'baseline', now()),
  ('824de25', '824de2539f5959ed39c10c4bd831e9955ab68e3f', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-23T10:06:49+08:00', 'baseline', now()),
  ('24aa0f1', '24aa0f1af8437bab499ae75e447bdea311767f8b', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-classifier.js', '2026-03-23T17:42:02+08:00', 'baseline', now()),
  ('00b3bd9', '00b3bd9de8e557841ec4b857a6fffac9af9aaed9', 'jewanchen <jewanchen@gmail.com>', 'Delete package.json', '2026-03-23T17:42:12+08:00', 'baseline', now()),
  ('e485ab1', 'e485ab1051f820278f993298d99f25a7e57b01eb', 'jewanchen <jewanchen@gmail.com>', 'Delete server-v2.js', '2026-03-23T17:42:21+08:00', 'baseline', now()),
  ('293c64a', '293c64a7bd877f34029b6ba0daf4fca4e248945f', 'jewanchen <jewanchen@gmail.com>', 'Delete README.md', '2026-03-23T17:42:32+08:00', 'baseline', now()),
  ('4065f4b', '4065f4b6a6ca947b24e0abc131cbdadb6f6fbd2f', 'jewanchen <jewanchen@gmail.com>', 'V2.1 Deploy', '2026-03-23T20:14:00+08:00', 'baseline', now()),
  ('eac0ca8', 'eac0ca861f71c747fb347df4462368913f3b71b4', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-03-23T23:29:15+08:00', 'baseline', now()),
  ('b866ef1', 'b866ef1e1a08b5f0031ecf2906affb90976a1574', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-23T23:32:28+08:00', 'baseline', now()),
  ('c0e3275', 'c0e327576945c0f2d087f446f480ca049ba92d4d', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-24T11:13:16+08:00', 'baseline', now()),
  ('5a52908', '5a52908efec628adb26fb05c7c0931a36355f955', 'jewanchen <jewanchen@gmail.com>', 'Delete reset-password.html', '2026-03-24T11:28:30+08:00', 'baseline', now()),
  ('31a1b01', '31a1b015f99d121e29a40bd30bd84c85e8b8af27', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-24T11:28:46+08:00', 'baseline', now()),
  ('acc3294', 'acc3294c927469f17f8544fd465be01e24cf3b23', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-admin.html', '2026-03-24T13:23:38+08:00', 'baseline', now()),
  ('9c0429a', '9c0429a2749aa40b20f977e3382b8fb7dc64c04c', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-24T13:23:53+08:00', 'baseline', now()),
  ('47257f3', '47257f39a3fefabace446da6573235981bde3f5f', 'jewanchen <jewanchen@gmail.com>', 'Delete server-v2.js', '2026-03-24T14:30:20+08:00', 'baseline', now()),
  ('a066823', 'a066823ba1ae5354e327a277b2e99fe4e8f3b269', 'jewanchen <jewanchen@gmail.com>', 'add terminal function', '2026-03-24T14:30:56+08:00', 'baseline', now()),
  ('7200b90', '7200b90e234619d259a86d3a55ba6a3bc9871454', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-admin.html', '2026-03-24T15:18:53+08:00', 'baseline', now()),
  ('a404e45', 'a404e4511817841a9e509baa9481aa4af8fbda2a', 'jewanchen <jewanchen@gmail.com>', 'Delete reset-password.html', '2026-03-24T15:19:18+08:00', 'baseline', now()),
  ('fd7a633', 'fd7a633f682f90ce78d3d6964d4fe9b4a73049df', 'jewanchen <jewanchen@gmail.com>', 'update anon key', '2026-03-24T15:19:56+08:00', 'baseline', now()),
  ('d6140e6', 'd6140e6208147a7d06ef5135aaef636f03345f71', 'jewanchen <jewanchen@gmail.com>', 'Update stripe to package.json', '2026-03-24T15:30:22+08:00', 'baseline', now()),
  ('a7e3e48', 'a7e3e48fc74b22ccbf72d8e75599d64a4e976c06', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-admin.html', '2026-03-24T15:38:13+08:00', 'baseline', now()),
  ('9a54d7b', '9a54d7bece222a7e4505d47d08eab12820f03fcb', 'jewanchen <jewanchen@gmail.com>', 'solve AI provider issue', '2026-03-24T15:38:46+08:00', 'baseline', now()),
  ('7086838', '708683870fa2083872e653cf2613df9dcd605efd', 'jewanchen <jewanchen@gmail.com>', 'Delete server-v2.js', '2026-03-24T17:56:31+08:00', 'baseline', now()),
  ('aaf6c88', 'aaf6c8800e607ebba38dd71bfa4f9a906c70310f', 'jewanchen <jewanchen@gmail.com>', 'LLM key rule update', '2026-03-24T17:57:10+08:00', 'baseline', now()),
  ('728606e', '728606e5b376ec892352b780835217bfe5ee1e2b', 'jewanchen <jewanchen@gmail.com>', 'Delete server-v2 (3).js', '2026-03-24T17:58:05+08:00', 'baseline', now()),
  ('37e43e6', '37e43e65fdafef633dedd9274ba695e4ad821f83', 'jewanchen <jewanchen@gmail.com>', 'LLM Key rules update', '2026-03-24T17:58:44+08:00', 'baseline', now()),
  ('d6e555c', 'd6e555c719850bb6fe5781c02225ac455355f0e5', 'jewanchen <jewanchen@gmail.com>', 'Update netlify.toml', '2026-03-24T18:27:12+08:00', 'baseline', now()),
  ('c7bc62f', 'c7bc62f46437b9714c394ab9fcc1c72a09c2c583', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-24T18:38:28+08:00', 'baseline', now()),
  ('1bda9e2', '1bda9e25477ae0fb4a325296b6a97bcf8d7434df', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-admin.html', '2026-03-24T18:55:34+08:00', 'baseline', now()),
  ('acb258a', 'acb258a1d9a20484c8e87af9558304cb68ab0c7e', 'jewanchen <jewanchen@gmail.com>', 'Delete server-v2.js', '2026-03-24T18:55:45+08:00', 'baseline', now()),
  ('0c84972', '0c84972451b1f367b37438267bca53d022a23dcd', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-24T18:56:43+08:00', 'baseline', now()),
  ('5f4685c', '5f4685c093ab46fc6172282541879dc62de6c930', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-24T18:56:59+08:00', 'baseline', now()),
  ('0a7209a', '0a7209a1ddfa01f35478b19c9c977aa3294572e9', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-24T21:10:39+08:00', 'baseline', now()),
  ('e98a18d', 'e98a18d0ce83cec604aba20be40ba93845ed90e2', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-24T21:14:50+08:00', 'baseline', now()),
  ('1e4a42a', '1e4a42a4981088b6ff8aea68a018d5441a27ffbe', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-03-24T21:59:58+08:00', 'baseline', now()),
  ('60d01ee', '60d01ee5cac02f4bb844efa1c5d8b4f9f7355d55', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-24T22:09:50+08:00', 'baseline', now()),
  ('48e9dda', '48e9dda63e2bbdbafaa78995000a26d803ba7245', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-03-25T08:55:05+08:00', 'baseline', now()),
  ('91800b1', '91800b1e55ac7475ca8867e0f5eaa43e008fe931', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-25T09:59:07+08:00', 'baseline', now()),
  ('99f85d9', '99f85d9d7e7130989094e5082c3877eb01eebf40', 'jewanchen <jewanchen@gmail.com>', 'Update package.json', '2026-03-25T10:00:09+08:00', 'baseline', now()),
  ('98dfa24', '98dfa2485449ee7c06651fb1f23d72f79a588365', 'jewanchen <jewanchen@gmail.com>', 'Update index.html', '2026-03-25T22:52:32+08:00', 'baseline', now()),
  ('572014d', '572014d2bd75ef405e59d32b33182292aa9b014b', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-25T22:53:16+08:00', 'baseline', now()),
  ('80e0435', '80e043566b27c6d06b7fcf2aa9543dc9f3934f8d', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-27T09:22:23+08:00', 'baseline', now()),
  ('6f3cc98', '6f3cc9856373717d92fb35a3cc7b16718a76e473', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-27T09:23:24+08:00', 'baseline', now()),
  ('a51b481', 'a51b481d228d8a2a21094676218ead95112dd020', 'jewanchen <jewanchen@gmail.com>', 'Update package.json', '2026-03-27T09:24:07+08:00', 'baseline', now()),
  ('0fa9c04', '0fa9c0416771f21c8d2b3d6a6316553e30ce8b31', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-27T10:07:33+08:00', 'baseline', now()),
  ('94002f9', '94002f99305d7f333fb361a1e0dab7a17d12e481', 'jewanchen <jewanchen@gmail.com>', 'Update netlify.toml', '2026-03-27T10:12:22+08:00', 'baseline', now()),
  ('92b3166', '92b3166ccf2506926ef4a5773d3d491505d63135', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-27T10:24:54+08:00', 'baseline', now()),
  ('5df0b85', '5df0b85e96fd8cd46f3d778215dae60901d2b550', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-03-27T10:25:37+08:00', 'baseline', now()),
  ('2ab3c30', '2ab3c3064414b3953589d6e7fda253c1c04a8bdb', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-27T10:34:00+08:00', 'baseline', now()),
  ('deb329c', 'deb329ca4b6ce9c0ce8dfcfa45b66730266ab153', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-27T10:44:00+08:00', 'baseline', now()),
  ('cf3481b', 'cf3481b6ab151525284e1caa1cc6b2ffafde2cc3', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-27T11:46:01+08:00', 'baseline', now()),
  ('bc99271', 'bc9927153430f4bf85a1543101353d6cdaa7e45b', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-27T12:00:13+08:00', 'baseline', now()),
  ('f302ae7', 'f302ae7a3fd32d2b91876c06776fbd9c74c14060', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-27T12:05:10+08:00', 'baseline', now()),
  ('79d9b12', '79d9b1263f2dcc732119ef930ddf17b9fa39e3cf', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-27T12:14:19+08:00', 'baseline', now()),
  ('048ff89', '048ff89d18f31ea2ebc5a02f8109f52bbca16bac', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-27T12:15:52+08:00', 'baseline', now()),
  ('2db32e7', '2db32e79daf4c616769497aec54a82989da0952c', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-27T12:21:46+08:00', 'baseline', now()),
  ('5a2140f', '5a2140f662a09c06195723dfe03793c2f5f2cb31', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-03-27T12:41:15+08:00', 'baseline', now()),
  ('f521ff0', 'f521ff0505fb667d17d2215a105b83c4cb540803', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-03-27T12:57:25+08:00', 'baseline', now()),
  ('2c6a251', '2c6a251da99bf0dc2462f0230161d25486272a30', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-03-27T13:02:25+08:00', 'baseline', now()),
  ('5cabd80', '5cabd80772a494f761593e90bf36373bf53d49b8', 'jewanchen <jewanchen@gmail.com>', 'Update tw.html', '2026-03-28T07:56:46+08:00', 'baseline', now()),
  ('049db2c', '049db2c783d86769bdffcaaefa8387fd82f10eaf', 'jewanchen <jewanchen@gmail.com>', 'Add technical article for prior art record (March 28, 2026)', '2026-03-28T12:27:26+08:00', 'baseline', now()),
  ('a9100fc', 'a9100fc45d126160f19da2437f87ed43adab46dc', 'jewanchen <jewanchen@gmail.com>', 'Add link to technical article in README', '2026-03-28T12:29:32+08:00', 'baseline', now()),
  ('92fb59e', '92fb59e5a8390342b1187f7970e8c0aa3591991a', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-30T16:46:40+08:00', 'baseline', now()),
  ('8676574', '86765749dca0f1c9dde58d4579fb25b923786ce7', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-30T20:33:12+08:00', 'baseline', now()),
  ('c4bec99', 'c4bec99ae9057e6aa2ab121f8bdc3b3f63f96fd3', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.js', '2026-03-31T00:01:14+08:00', 'baseline', now()),
  ('040d07a', '040d07aec2562b0212d745d5ff600377b288f2a3', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-31T00:10:36+08:00', 'baseline', now()),
  ('cec835c', 'cec835cf28dd07ed1f1be9a85eb7b972142c70e1', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-31T00:19:46+08:00', 'baseline', now()),
  ('3246a71', '3246a7112d61de2ec4165da7e63457de66eea8e0', 'jewanchen <jewanchen@gmail.com>', 'Delete casca-classifier.js', '2026-03-31T00:20:14+08:00', 'baseline', now()),
  ('eb09f8c', 'eb09f8cf5f7ebe7dac50920d7ac2b1bbbc24fe00', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-31T00:21:17+08:00', 'baseline', now()),
  ('4a12cf0', '4a12cf0fa06a786c02c23da2b025b161bffb18db', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-31T00:33:17+08:00', 'baseline', now()),
  ('ec3ed52', 'ec3ed522c7c5369b1ec110ce10f29b9fcabc4e4a', 'jewanchen <jewanchen@gmail.com>', 'Update netlify.toml', '2026-03-31T00:33:49+08:00', 'baseline', now()),
  ('5653ed9', '5653ed914cbe51ac4179b88e25cd07395745a353', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-03-31T00:34:17+08:00', 'baseline', now()),
  ('3877ea1', '3877ea1f72f797cdeba5b82aaa3e05b631fe9151', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-31T00:34:53+08:00', 'baseline', now()),
  ('0886fdf', '0886fdfdd94d490f9f59f2a661a8987b195a7953', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-03-31T09:03:23+08:00', 'baseline', now()),
  ('4bcf975', '4bcf975f339235eecefc47470184b3712a29750b', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-03-31T09:05:29+08:00', 'baseline', now()),
  ('48f2a32', '48f2a32c39ea02138990a5c20faef8b8295cf5ac', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-31T11:35:50+08:00', 'baseline', now()),
  ('0f76c5f', '0f76c5f16a903e458b71ffbe43b6aac0d400c216', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-03-31T11:36:36+08:00', 'baseline', now()),
  ('dee11e2', 'dee11e223fb5fecc360a03a0c53717b31d1c0dc7', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-03-31T22:14:07+08:00', 'baseline', now()),
  ('f4fb58d', 'f4fb58de8befcbdba86fd367b4b247fb66c4555c', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-31T22:14:47+08:00', 'baseline', now()),
  ('ea3a60c', 'ea3a60c6b1d767572b7014cddd0379e90bd1b0f8', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-03-31T22:15:26+08:00', 'baseline', now()),
  ('3fbe409', '3fbe40931658fe6ed5252351187fff67b60ab499', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-31T22:27:18+08:00', 'baseline', now()),
  ('5762b78', '5762b787f2d907e4871a3c96b41733a1a0f0cd3d', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-31T22:47:09+08:00', 'baseline', now()),
  ('c29854c', 'c29854cffdd774de7ebf8c94181db3f18130ab55', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-03-31T23:04:04+08:00', 'baseline', now()),
  ('f3a04d5', 'f3a04d567733a86b03dffcc6228aacb8cf10f491', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-01T15:26:45+08:00', 'baseline', now()),
  ('47d8bc8', '47d8bc83d99593c28cdbe33d345966954d4afc43', 'jewanchen <jewanchen@gmail.com>', 'Delete reset-password.html', '2026-04-01T15:29:34+08:00', 'baseline', now()),
  ('5ad18ef', '5ad18ef44185d9f99b9309d5fdbe9bfbe8f55308', 'jewanchen <jewanchen@gmail.com>', 'Create [[path]].js', '2026-04-01T16:15:51+08:00', 'baseline', now()),
  ('71e9c79', '71e9c79092369c39f758aaa7c69869838d0d0475', 'jewanchen <jewanchen@gmail.com>', 'Create health.js', '2026-04-01T16:16:38+08:00', 'baseline', now()),
  ('536a4ba', '536a4ba8f3537636c5f2432adafe1e53436a35f0', 'jewanchen <jewanchen@gmail.com>', 'Update _redirects', '2026-04-01T16:39:33+08:00', 'baseline', now()),
  ('8a89db4', '8a89db4ef142a922df9ef26e356a5bcc867afd0e', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-04-01T17:19:09+08:00', 'baseline', now()),
  ('243b5d8', '243b5d8fc72ca3f55b021c8e94e4f43318a2278c', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-01T17:19:39+08:00', 'baseline', now()),
  ('6fd47ca', '6fd47caa15947ed41da58d8abf39adabe18a694f', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-04-03T08:09:54+08:00', 'baseline', now()),
  ('46936b9', '46936b9b22e559c8d140607314a8166e06c48d08', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-03T08:11:09+08:00', 'baseline', now()),
  ('65bde9f', '65bde9f1364097c016dce7db6a8ee06a7969fea3', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-04-03T08:11:57+08:00', 'baseline', now()),
  ('c9153b6', 'c9153b604c5c9f4c8ae54185cc541be71c16a76f', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-04-03T08:13:44+08:00', 'baseline', now()),
  ('c645023', 'c645023fd0eea6646c4efda191a0832ae3a6f5e5', 'jewanchen <jewanchen@gmail.com>', 'Update index.html', '2026-04-03T08:15:18+08:00', 'baseline', now()),
  ('9055e0e', '9055e0e6a3d16330410198ce1b3365e792622b86', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-04-03T08:16:03+08:00', 'baseline', now()),
  ('4009f8b', '4009f8bb32a79fd1d51b4285cd7def1159932970', 'jewanchen <jewanchen@gmail.com>', 'Update tw.html', '2026-04-03T08:16:39+08:00', 'baseline', now()),
  ('3d2fa3b', '3d2fa3be2afe73b225b2b3d9494f8368d01714b1', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-03T08:19:13+08:00', 'baseline', now()),
  ('de2397b', 'de2397b99c539619b2e7d1325bf55b725a5fedd9', 'jewanchen <jewanchen@gmail.com>', 'Update index.html', '2026-04-03T08:36:08+08:00', 'baseline', now()),
  ('4e2d4f9', '4e2d4f9e80ff20f07cbccdb647f72bc7ceca077d', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-03T08:38:05+08:00', 'baseline', now()),
  ('2b3381b', '2b3381bc865cd50ab47ca0d3bf509c15c9251bce', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-04-03T08:38:46+08:00', 'baseline', now()),
  ('5f13b9e', '5f13b9e70793ea0da14bfcab9e6f98806d08c1ca', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-04-03T08:40:06+08:00', 'baseline', now()),
  ('c6e0342', 'c6e03426714a9d14d8c91fabd91577a59fb26c80', 'jewanchen <jewanchen@gmail.com>', 'Update tw.html', '2026-04-03T08:40:56+08:00', 'baseline', now()),
  ('8cdd9f2', '8cdd9f24beaab94c693aa3b42fa0d14e8bfd55e5', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-03T09:00:31+08:00', 'baseline', now()),
  ('74993fe', '74993fe4f237d9965e0a6f7f1f2b36cfbf5deaac', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-03T09:04:31+08:00', 'baseline', now()),
  ('c00c564', 'c00c564ce49a0f61ae69aeb60ecbfe5ebcb82ea8', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-03T09:05:38+08:00', 'baseline', now()),
  ('af0570b', 'af0570b296e1358b30ec1401de77cd244dbb4917', 'jewanchen <jewanchen@gmail.com>', 'Delete FullLogo_Transparent_NoBuffer.png', '2026-04-03T09:14:57+08:00', 'baseline', now()),
  ('db246f6', 'db246f6102dd6fba099fad0df4a00a2f19a47d41', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-03T09:15:19+08:00', 'baseline', now()),
  ('07b7e93', '07b7e934b3da6c06b13d5a94677794d2c5dd9eb1', 'jewanchen <jewanchen@gmail.com>', 'Update casca-admin.html', '2026-04-03T09:25:17+08:00', 'baseline', now()),
  ('d25d7c8', 'd25d7c8e6abd3b71239189c3094074d3f2b83f04', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-04-03T09:31:55+08:00', 'baseline', now()),
  ('7ae4fb6', '7ae4fb6d7b2f4ab3f065cf8ec4417753328633df', 'jewanchen <jewanchen@gmail.com>', 'Update terminal.html', '2026-04-03T09:46:14+08:00', 'baseline', now()),
  ('b7af8cf', 'b7af8cf530d909bfc7c52288dcfa674e35ce4edd', 'jewanchen <jewanchen@gmail.com>', 'Update tw.html', '2026-04-03T10:08:55+08:00', 'baseline', now()),
  ('69ae61e', '69ae61e304405e054225b3cb32659c44bd60ae21', 'jewanchen <jewanchen@gmail.com>', 'Update index.html', '2026-04-03T10:09:18+08:00', 'baseline', now()),
  ('8ecbdb1', '8ecbdb1e854dfaf7d988b340c40fc3cd1ce2a771', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-04-03T10:28:28+08:00', 'baseline', now()),
  ('05c787b', '05c787b0fbfb00fb786f7161896f207b87c302c5', 'jewanchen <jewanchen@gmail.com>', 'Update casca-annotator.html', '2026-04-03T12:10:01+08:00', 'baseline', now()),
  ('50494ff', '50494ff55c032a625aee520f42d133a7b6e3ef8a', 'jewanchen <jewanchen@gmail.com>', 'remove admin panel from public repo', '2026-04-07T10:19:11+08:00', 'baseline', now()),
  ('0735150', '073515087c05760f9f0d66cd661f51b0e8122708', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-07T10:30:50+08:00', 'baseline', now()),
  ('37f9cb6', '37f9cb65b0a00ac61d44ab7b93bb6dda1a25bcbb', 'jewanchen <jewanchen@gmail.com>', 'Update _redirects', '2026-04-07T10:39:15+08:00', 'baseline', now()),
  ('0e924e3', '0e924e34ca5fa87c702ddb21d2d37218d7ad8020', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-09T09:48:01+08:00', 'baseline', now()),
  ('b787d14', 'b787d142cd40741039bdc8236a409f18918d17b4', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-09T17:21:38+08:00', 'baseline', now()),
  ('211b3ea', '211b3ea7e4b0c3d959810e15341295aad7915f49', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.cjs', '2026-04-10T10:46:00+08:00', 'baseline', now()),
  ('1b9f13d', '1b9f13d704e35d989cab49f127b013447a4697ca', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-04-10T10:54:46+08:00', 'baseline', now()),
  ('e89e7f6', 'e89e7f6f19ab911f26fc866e5bd9d991b1702860', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.cjs', '2026-04-10T10:58:16+08:00', 'baseline', now()),
  ('4c4d7dc', '4c4d7dc6a694f592652335b4868b219ad161ed02', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.cjs', '2026-04-10T17:30:07+08:00', 'baseline', now()),
  ('510eb56', '510eb56eb49a28d3314aedbe8e5f39d2f357250a', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-04-10T17:31:39+08:00', 'baseline', now()),
  ('d10086a', 'd10086a639fad7b6079c198bec564690161d4c62', 'jewanchen <jewanchen@gmail.com>', 'Add files via upload', '2026-04-10T17:53:56+08:00', 'baseline', now()),
  ('4dfbe9c', '4dfbe9c53bd49b869541ab3c3b44a27850be82d1', 'jewanchen <jewanchen@gmail.com>', 'feat: add casca-zapier integration folder (v1.0.2)', '2026-04-10T18:04:18+08:00', 'baseline', now()),
  ('dfb3de2', 'dfb3de2f7ff4ff23c1a970cbec7ad044adff0411', 'jewanchen <jewanchen@gmail.com>', 'fix: remove important/helpText for v18 schema, add search field to findUsage (v1.0.2)', '2026-04-10T23:35:35+08:00', 'baseline', now()),
  ('644a233', '644a2339c5e391a79103d1d960a78d4e929891c1', 'jewanchen <jewanchen@gmail.com>', 'Update casca-classifier.cjs', '2026-04-13T13:58:42+08:00', 'baseline', now()),
  ('a988d2c', 'a988d2cf5dc80d3323818fa20148b3990ec1cd03', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-04-13T17:17:28+08:00', 'baseline', now()),
  ('c0cb4c5', 'c0cb4c584f441d285c68d8cedd6d99c485c04f16', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-04-13T17:18:09+08:00', 'baseline', now()),
  ('f4d5faa', 'f4d5faa58977a7adbe7134473b86c41a309f8144', 'jewanchen <jewanchen@gmail.com>', 'Update casca-dashboard.html', '2026-04-13T17:37:23+08:00', 'baseline', now()),
  ('36448ba', '36448baf90f813588d0dcde19000aacf158466fb', 'jewanchen <jewanchen@gmail.com>', 'Update index.html', '2026-04-13T17:38:00+08:00', 'baseline', now()),
  ('20b2897', '20b289714683f277b01c9da3d3ffe2fa015702c9', 'jewanchen <jewanchen@gmail.com>', 'Update server-v2.js', '2026-04-13T17:38:42+08:00', 'baseline', now()),
  ('b189783', 'b1897834442a70c6b7ed815187523fa328b8e0cb', 'jewanchen <jewanchen@gmail.com>', 'feat: add Path B training pipeline + MiniLM service + sync latest files', '2026-04-13T23:05:25+08:00', 'baseline', now()),
  ('4c0985e', '4c0985edbddf283ce55a36b5506532ea8099f418', 'jewanchen <jewanchen@gmail.com>', 'merge: resolve index.html trivial conflict', '2026-04-13T23:06:36+08:00', 'baseline', now()),
  ('99628e8', '99628e8573923c7c779bf9a1e6646217c12cc069', 'jewanchen <jewanchen@gmail.com>', 'feat: add Path B admin API endpoints + per-client judge control', '2026-04-13T23:48:40+08:00', 'baseline', now()),
  ('1795cf5', '1795cf547bef535e8c36870c6bea23b5b1b05478', 'jewanchen <jewanchen@gmail.com>', 'fix: hardcode port 8000 in railway.toml startCommand', '2026-04-14T11:35:48+08:00', 'baseline', now()),
  ('8eca15f', '8eca15f88c38ed5a72dcc0d22d852d5704b9279a', 'jewanchen <jewanchen@gmail.com>', 'fix: use signUp() instead of admin.createUser() to trigger verification email', '2026-04-14T22:35:33+08:00', 'baseline', now()),
  ('65ffa70', '65ffa70767458498d308e56b21ae82f9751f34d2', 'jewanchen <jewanchen@gmail.com>', 'fix: trial/apply blocks on existing API key, not existing trial', '2026-04-14T22:48:25+08:00', 'baseline', now()),
  ('4be39c6', '4be39c62de72def899d7482d048e0452217db2c4', 'jewanchen <jewanchen@gmail.com>', 'fix: dashboard loads account data after login even without API key', '2026-04-14T23:13:45+08:00', 'baseline', now()),
  ('b5f37a4', 'b5f37a4a210d38c85e3aa10a58d963ee2bf9647f', 'jewanchen <jewanchen@gmail.com>', 'fix: overview page shows real user data instead of hardcoded mockup', '2026-04-14T23:28:52+08:00', 'baseline', now()),
  ('86aebba', '86aebba0c5d2b91bbc4c434a227363ccde64e4ef', 'jewanchen <jewanchen@gmail.com>', 'refactor: overview pie + cost charts driven by real data, hide mockup tables', '2026-04-14T23:42:10+08:00', 'baseline', now()),
  ('6709b6f', '6709b6f6f195aed8e9b0bbb70d0acb37985ef342', 'jewanchen <jewanchen@gmail.com>', 'docs: add comprehensive architecture document', '2026-04-14T23:47:40+08:00', 'baseline', now()),
  ('be9ff27', 'be9ff274567c416d161b00727ad2b6120cf0b972', 'jewanchen <jewanchen@gmail.com>', 'feat: rebuild dashboard tabs — real data driven + Available Providers', '2026-04-15T08:49:41+08:00', 'baseline', now()),
  ('ae8e935', 'ae8e93542f010d317447d9a4530247264f191895', 'jewanchen <jewanchen@gmail.com>', 'fix(minilm): graceful fallback when checkpoint missing on disk', '2026-04-15T13:24:54+08:00', 'baseline', now()),
  ('161342d', '161342da5f64ca3cdaf9980eabbbb6299ffe31dc', 'jewanchen <jewanchen@gmail.com>', 'feat(minilm): persist checkpoints to Supabase Storage', '2026-04-15T13:39:34+08:00', 'baseline', now()),
  ('b02baa0', 'b02baa0ee3282d731c5caa1a7c1fa5571e09c6af', 'jewanchen <jewanchen@gmail.com>', 'docs: add comprehensive data provider guide for language experts', '2026-04-15T16:34:03+08:00', 'baseline', now()),
  ('d14fbab', 'd14fbab9207964cbab1d825ce5b788d4875c831d', 'jewanchen <jewanchen@gmail.com>', 'feat(pathb): upload-only mode + training readiness endpoint', '2026-04-15T17:16:31+08:00', 'baseline', now()),
  ('d3c0ebd', 'd3c0ebd00438dbc826d6ca200c200c11dc39bd1d', 'jewanchen <jewanchen@gmail.com>', 'feat(minilm): add real-time training progress tracking', '2026-04-16T09:56:58+08:00', 'baseline', now()),
  ('0f7e8c7', '0f7e8c7a5565a655b0e193adef84833d5c34c2f1', 'jewanchen <jewanchen@gmail.com>', 'feat(minilm): add version activation API with hot-reload', '2026-04-16T11:38:32+08:00', 'baseline', now()),
  ('e815880', 'e815880ceebf0d9b12f7cce2a29388e3d7926f1e', 'jewanchen <jewanchen@gmail.com>', 'fix(minilm): robust activation query + detailed error messages', '2026-04-16T11:41:55+08:00', 'baseline', now()),
  ('77290b6', '77290b66ee6f77ba81fe072ff6027c92cc959a3c', 'jewanchen <jewanchen@gmail.com>', 'fix(minilm): replace PEP-604 ''X | None'' with typing.Optional', '2026-04-16T20:39:14+08:00', 'baseline', now()),
  ('c15a942', 'c15a94289074d2a7050b59a6a5000aed171409e7', 'jewanchen <jewanchen@gmail.com>', 'feat(classifier): add 22 rules for TH/VI/ID + creative form detection', '2026-04-17T10:46:53+08:00', 'baseline', now()),
  ('3da21d9', '3da21d9f78468b1b194747afcfdee818afa2be28', 'jewanchen <jewanchen@gmail.com>', 'feat(classifier): add definition & lifestyle rules for FR/ES/IT/KO/HI/AR', '2026-04-17T10:57:24+08:00', 'baseline', now()),
  ('5b800e9', '5b800e924b5868b3ef2a89d2c1b5c73b5503760d', 'jewanchen <jewanchen@gmail.com>', 'fix(pathb): paginate training-readiness lang query to avoid 1000-row limit', '2026-04-17T12:41:17+08:00', 'baseline', now()),
  ('bb6f906', 'bb6f9068a5c66f2fbad34193def85bc24d52d1ff', 'jewanchen <jewanchen@gmail.com>', 'feat(classifier): 6 improvements from batch 2 training data analysis', '2026-04-17T14:52:35+08:00', 'baseline', now()),
  ('7f9cf6a', '7f9cf6a0ce641495148f21632b0df481d4127b76', 'jewanchen <jewanchen@gmail.com>', 'fix(minilm): paginate load_from_supabase to fetch all untrained samples', '2026-04-17T16:40:19+08:00', 'baseline', now()),
  ('89f4d81', '89f4d813290c0fa620e6edcf5e6d57d2e8c46572', 'jewanchen <jewanchen@gmail.com>', 'feat: update landing pricing — Managed Free weekly quota + Passthrough registration required', '2026-04-17T17:00:55+08:00', 'baseline', now()),
  ('a9413c2', 'a9413c2428cbd63e150b7f32b1c7e7c8e2f61e86', 'jewanchen <jewanchen@gmail.com>', 'feat: Phase B — billing v2 (weekly quota, forced registration, trial system)', '2026-04-17T17:09:25+08:00', 'baseline', now()),
  ('31b265a', '31b265a68bdd0b1e72cf0b521c7ba755ce1b60e0', 'jewanchen <jewanchen@gmail.com>', 'feat: Phase C — Dashboard billing page with account mode + quota status', '2026-04-17T17:15:55+08:00', 'baseline', now()),
  ('f3f4b91', 'f3f4b9183e2b4ebffd346459e9ebd37175823a6d', 'jewanchen <jewanchen@gmail.com>', 'feat(classifier): add Confidence Calibration Layer for L1→L2 handoff', '2026-04-17T17:16:45+08:00', 'baseline', now()),
  ('0433795', '043379552a132bbf7c77eade56a4a87734f8653c', 'jewanchen <jewanchen@gmail.com>', 'fix(minilm): async training to prevent Railway timeout on large datasets', '2026-04-17T17:28:27+08:00', 'baseline', now()),
  ('3fc9b96', '3fc9b96c101a1a037ec81b1eac22db6999c42413', 'jewanchen <jewanchen@gmail.com>', 'fix(pathb): restore missing /api/admin/pathb/minilm/activate endpoint', '2026-04-20T09:10:42+08:00', 'baseline', now()),
  ('d52072b', 'd52072bb395d42736f10f10ec2dadab46d2f049c', 'jewanchen <jewanchen@gmail.com>', 'fix: restore truncated index.html ending (missing </script></body></html>)', '2026-04-20T09:46:04+08:00', 'baseline', now()),
  ('d577201', 'd577201c6e5fa944cb55aeed4aa53991106f25af', 'jewanchen <jewanchen@gmail.com>', 'feat(calibrator): add S6 signal for short-token-long-text R1 conflicts', '2026-04-20T09:46:15+08:00', 'baseline', now()),
  ('3aac29d', '3aac29d942b4a85ef6d1a8144680ff246bf80eb5', 'jewanchen <jewanchen@gmail.com>', 'feat(route): context floor for short refinement fragments', '2026-04-20T10:10:46+08:00', 'baseline', now()),
  ('3fdeba4', '3fdeba4c783d30ca19c7c4b6250c556295d2b940', 'jewanchen <jewanchen@gmail.com>', 'refactor: code audit cleanup — 3 critical + 2 high + 3 medium fixes', '2026-04-20T10:26:39+08:00', 'baseline', now()),
  ('17aa381', '17aa38126dd8349a2a225cc592c70fd8f0f1880c', 'jewanchen <jewanchen@gmail.com>', 'refactor: landing pricing — stacked layout + remove Chinese from EN version', '2026-04-20T10:31:54+08:00', 'baseline', now()),
  ('eb8cbb1', 'eb8cbb1286ccc3d7f3c16a350fabd8af829fa6f7', 'jewanchen <jewanchen@gmail.com>', 'feat(pathb): raise L2 confidence threshold from 80 to 86', '2026-04-20T10:52:42+08:00', 'baseline', now()),
  ('b1cf486', 'b1cf486b22d496d61219a93135bc2d3d093f5d66', 'jewanchen <jewanchen@gmail.com>', 'feat(E1): Enterprise self-hosted — DB schema + License API + offline auth', '2026-04-24T09:03:55+08:00', 'baseline', now()),
  ('9a11a0b', '9a11a0b6ce373ec9f494ccae38eef83f7e073cec', 'jewanchen <jewanchen@gmail.com>', 'feat(E2): Casca Enterprise Agent — license, heartbeat, usage, updates', '2026-04-24T09:21:12+08:00', 'baseline', now()),
  ('7f90620', '7f9062012fbf64694af022cfd4b069efb2aec455', 'jewanchen <jewanchen@gmail.com>', 'feat(terminal): show classification badge before AI response', '2026-04-24T09:25:56+08:00', 'baseline', now()),
  ('bde4b8d', 'bde4b8ddb8c96075eb6f43acf1c94cc5f1c75780', 'jewanchen <jewanchen@gmail.com>', 'feat(E3): Enterprise binary compilation + Docker packaging', '2026-04-24T09:35:59+08:00', 'baseline', now()),
  ('09699a6', '09699a68953e7df18833f664cf8ba05534bce2fb', 'jewanchen <jewanchen@gmail.com>', 'feat(E6): Update push + rollback endpoints', '2026-04-24T09:55:42+08:00', 'baseline', now()),
  ('a252c5c', 'a252c5c2d9fe7429e94281c93b27ff18e925cc18', 'jewanchen <jewanchen@gmail.com>', 'feat(E8): Security specification + RSA key generation', '2026-04-24T10:10:27+08:00', 'baseline', now()),
  ('5798150', '5798150559cafcf6156fe0516b27643dbdfc3fa7', 'jewanchen <jewanchen@gmail.com>', 'fix(security): CTO audit — 8 critical fixes for enterprise deployment', '2026-04-24T10:34:27+08:00', 'baseline', now()),
  ('20a21da', '20a21da75f2fdaa6e3f8d09c0a9fcb06bf6e6e7b', 'jewanchen <jewanchen@gmail.com>', 'fix: Week 2 High priority — 13 items (Casca Vault hardening)', '2026-04-24T11:26:16+08:00', 'baseline', now()),
  ('7133866', '7133866be03d147280baa6f33bbb294084e7166d', 'jewanchen <jewanchen@gmail.com>', 'docs: Casca Vault product brief + deployment guide', '2026-04-24T11:31:23+08:00', 'baseline', now()),
  ('2bf0ecc', '2bf0ecc6eee915fa376afea468ec686a22c2f1aa', 'jewanchen <jewanchen@gmail.com>', 'feat(terminal): instant classification badge via parallel API calls', '2026-04-24T12:24:06+08:00', 'baseline', now()),
  ('fdff1a2', 'fdff1a2844c9b907219c0c30b3c021a61e1062b6', 'jewanchen <jewanchen@gmail.com>', 'feat(terminal): classification appears inside AI chat bubble instantly', '2026-04-24T15:40:42+08:00', 'baseline', now()),
  ('3c57c6f', '3c57c6f1c5e842dc96bf58e1eb41568dbe339b1e', 'jewanchen <jewanchen@gmail.com>', 'fix(terminal): add missing formatMarkdown function', '2026-04-27T09:34:32+08:00', 'baseline', now()),
  ('5ec579a', '5ec579aa6e1b26380414694bfa1686985eb4ada1', 'jewanchen <jewanchen@gmail.com>', 'fix(classifier): R5 exclude 比較好/比較多 as degree adverbs', '2026-04-27T09:44:11+08:00', 'baseline', now()),
  ('b7bf5a7', 'b7bf5a7a433c2c104eec50b7a5d0e21a9e2fafca', 'jewanchen <jewanchen@gmail.com>', 'fix(terminal): add CONFIG.API_BASE — classify endpoint was calling undefined/api/classify', '2026-04-27T10:01:19+08:00', 'baseline', now()),
  ('ae39e67', 'ae39e67d7e37a8d004acda5960f673dc7c40b5cf', 'jewanchen <jewanchen@gmail.com>', 'docs: Casca User Guide — product intro + user manual (12 chapters, Traditional Chinese)', '2026-04-29T21:49:01+08:00', 'baseline', now()),
  ('e2fd12d', 'e2fd12d75d70db84800e824651a282392889b1de', 'jewanchen <jewanchen@gmail.com>', 'docs: update Vault product brief classification flow diagram', '2026-05-05T16:30:02+08:00', 'baseline', now()),
  ('9b181f1', '9b181f1099dcb9d5707e5631f3804bf7e58f4ae7', 'jewanchen <jewanchen@gmail.com>', 'fix(pathb): L2 must have >=50% confidence to override L1', '2026-05-05T16:47:54+08:00', 'baseline', now()),
  ('4b15948', '4b15948b00c06a2614f3f94eb9dba07991f134ee', 'jewanchen <jewanchen@gmail.com>', 'feat(calibrator): S7 boost confidence for reliable short LOW prompts', '2026-05-05T16:52:24+08:00', 'baseline', now()),
  ('f670217', 'f67021792160110770442516bab4dc311a42a9c3', 'jewanchen <jewanchen@gmail.com>', 'feat(classifier): fix greetings/closures across JA/KO/VI being sent to L2', '2026-05-05T16:59:42+08:00', 'baseline', now()),
  ('e11be1b', 'e11be1b24a5bb19366983e4f17f8aa57ff3ee74c', 'jewanchen <jewanchen@gmail.com>', 'docs: regenerate Vault product brief PDF with styled flow diagram', '2026-05-05T17:50:57+08:00', 'baseline', now()),
  ('620aa05', '620aa05e7d0a281c065154c75510375837e3480c', 'jewanchen <jewanchen@gmail.com>', 'docs: update contact email to casca@vastitw.com in Vault product brief', '2026-05-05T18:00:28+08:00', 'baseline', now()),
  ('9f35ba5', '9f35ba5a6adcf22ea8f099472416ec8b68927b0b', 'jewanchen <jewanchen@gmail.com>', 'docs: fix Vault product brief — unify L2 latency to 10ms, clarify cache and SLA', '2026-05-05T19:27:44+08:00', 'baseline', now()),
  ('6398659', '6398659e0772381810401d9646db26fac1aeaccd', 'jewanchen <jewanchen@gmail.com>', 'feat: pause subscription system + ws fix + landing page rewrite', '2026-05-08T12:59:57+08:00', 'baseline', now()),
  ('7a9bff9', '7a9bff9a8a4e09bfbdc7884b17fc3ebe58a98b5a', 'jewanchen <jewanchen@gmail.com>', 'feat: add /api/lead endpoint + fix landing page issues', '2026-05-08T13:46:54+08:00', 'baseline', now()),
  ('9fc98a5', '9fc98a53522668a1b6328ec4a8ea404cb1935dd8', 'jewanchen <jewanchen@gmail.com>', 'feat: add /api/admin/pathb/minilm/activate endpoint', '2026-05-18T14:56:14+08:00', 'baseline', now()),
  ('9b7f959', '9b7f959e019ccc7536ebea26564dffce7ad11c76', 'jewanchen <jewanchen@gmail.com>', 'chore: add .gitignore to exclude CREDENTIALS-DO-NOT-SHARE.md from tracking', '2026-05-18T15:05:49+08:00', 'baseline', now()),
  ('51fc51a', '51fc51a51ad0818956d57466a206c42b0ed002df', 'jewanchen <jewanchen@gmail.com>', 'docs: refresh README + remove stale Netlify migration guide', '2026-05-20T23:27:01+08:00', 'baseline', now()),
  ('2ec3617', '2ec361756a348b13701a4cd169fe8b2e42a24b81', 'jewanchen <jewanchen@gmail.com>', 'feat: multi-turn context fix — L2 + Path B + training pipeline', '2026-05-22T09:51:22+08:00', 'baseline', now()),
  ('4895561', '489556120779dc2f22395ebd78f1e05aeebf6b85', 'jewanchen <jewanchen@gmail.com>', 'feat(jobs): add predict_replay.py for offline L1 evaluation', '2026-05-22T11:03:03+08:00', 'baseline', now()),
  ('ee2f66e', 'ee2f66e8bae32f8f111e09d526288f05e3eaaf98', 'jewanchen <jewanchen@gmail.com>', 'feat(jobs): track linguist-data utility scripts', '2026-05-22T11:12:57+08:00', 'baseline', now()),
  ('8cc2a0d', '8cc2a0da77a66f24caa9872a780d566f5d4c48dc', 'jewanchen <jewanchen@gmail.com>', 'feat(admin): add /api/admin/pathb/minilm/predict_batch endpoint', '2026-05-22T12:47:01+08:00', 'baseline', now()),
  ('9333252', '93332522a67a55b4b7ff2812215343193c3df9b3', 'jewanchen <jewanchen@gmail.com>', 'security: rotate frontend to publishable key + remove hardcoded service_role from notebook', '2026-05-22T13:25:58+08:00', 'baseline', now()),
  ('226c294', '226c2948fff2a453c9e5a756d4a95519fd8a2e17', 'jewanchen <jewanchen@gmail.com>', 'fix(minilm/storage): support Colab 4-part checkpoint layout', '2026-05-25T10:41:48+08:00', 'baseline', now()),
  ('b843e5c', 'b843e5c2b5516cb54502d4a396e67ab24cbccb77', 'jewanchen <jewanchen@gmail.com>', 'chore(minilm): add latency instrumentation for /predict diagnostics', '2026-05-26T08:54:57+08:00', 'baseline', now()),
  ('3c697a1', '3c697a13c2dfe8cca873fca1f6ed594aed83e9f7', 'jewanchen <jewanchen@gmail.com>', 'perf(minilm): match torch threads to cgroup CPU quota (fixes 12s /predict)', '2026-05-26T09:22:45+08:00', 'baseline', now()),
  ('efb26b6', 'efb26b6d5be28674b22d3dc691ae419763ecce6b', 'jewanchen <jewanchen@gmail.com>', 'perf(minilm): force BertTokenizerFast + shorten L2 timeout 5s → 2s', '2026-05-26T09:42:59+08:00', 'baseline', now()),
  ('22b17c0', '22b17c02ee5cd84b5bae9453328e6c988c2693f4', 'jewanchen <jewanchen@gmail.com>', 'fix(api): extract chatCompletionHandler so /api/route alias works on Express 5', '2026-05-26T13:55:08+08:00', 'baseline', now()),
  ('b90baaf', 'b90baafb80b0c74c64c1732470b0e1547ec9d175', 'jewanchen <jewanchen@gmail.com>', 'chore: untrack casca-zapier/node_modules and add proper .gitignore', '2026-05-26T16:15:11+08:00', 'baseline', now()),
  ('b220d69', 'b220d69035020bc544e156c9360295892b890038', 'jewanchen <jewanchen@gmail.com>', 'fix(auth): use admin.createUser + Resend send for /api/auth/register', '2026-05-26T16:35:14+08:00', 'baseline', now()),
  ('e70b8b8', 'e70b8b8415a6db5c1d4653699dfe5e1d2b485c0a', 'jewanchen <jewanchen@gmail.com>', 'fix(api): bug #5 UUID validation + add SQL migration for #2 #3', '2026-05-26T16:46:16+08:00', 'baseline', now()),
  ('33d938d', '33d938d5a726168af77fc9e6c464166b45cb9d05', 'jewanchen <jewanchen@gmail.com>', 'feat(api): serving-layer safety-net contextFloor (covers L2 override path)', '2026-05-27T17:27:32+08:00', 'baseline', now())
ON CONFLICT (commit_hash) DO NOTHING;

-- Verification
SELECT status, COUNT(*) FROM public.appex_sync_commits GROUP BY status;
