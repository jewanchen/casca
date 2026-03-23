  'use strict';

  // ── VERSION ────────────────────────────────────────────────────
  const VERSION = '2.2.0';
  const STATS = {
    totalRules: 97,
    trainingsamples: 3509,
    batches: 7,
    languages: ['ZH','ZH_SC','EN','JA','FR','DE','ES','IT','KO','HI','AR'],
    accuracy: 94.1,
    target: 98.5,
  };

  // ── MODEL COSTS (USD per 1M tokens) ────────────────────────────
  // Note: declared as `let` so setConfig() can inject DB-driven values at runtime.
  let MODEL_COSTS = {
    'GPT-4o':            5.00,
    'GPT-4o-mini':       0.15,
    'GPT-4o Vision':     5.00,
    'Gemini 2.0 Flash':  0.10,
    'Gemini Flash Vision': 0.10,
    'Gemini 1.5 Pro':    3.50,
    'Claude Sonnet':     3.00,
    'Claude Haiku':      0.25,
    'Claude Haiku Vision': 0.25,
    'Azure GPT-4o':      5.00,
    'Azure GPT-4o-mini': 0.15,
    'Command R+':        2.50,
    'Command R':         0.50,
    'Llama3-70B-Groq':   0.59,
    'Mixtral-8x7B':      0.27,
    'Mistral Large':     8.00,
    'Mistral Small':     2.00,
    'Llama3-70B':        0.99,
    'Mistral-7B':        0.15,
    'Titan Express':     0.20,
    'Cache hit':         0.00,
  };

  // ── MODAL → MODEL MAP ──────────────────────────────────────────
  const MODAL_MODELS = {
    video:         'Gemini 1.5 Pro',
    medical_image: 'GPT-4o Vision',
    legal_doc:     'Claude Sonnet',
    image:         'Gemini Flash Vision',
    chart:         'GPT-4o-mini',
    doc:           'Claude Haiku Vision',
  };

  // ── TIER → MODEL MAP ───────────────────────────────────────────
  // Note: declared as `let` so setConfig() can inject DB-driven values at runtime.
  let TIER_MODELS = {
    LOW:   { default: 'Gemini 2.0 Flash', high_q: 'GPT-4o-mini',  low_q: 'Gemini 2.0 Flash' },
    MED:   { default: 'GPT-4o-mini',      high_q: 'GPT-4o-mini',  low_q: 'Gemini 2.0 Flash' },
    HIGH:  { default: 'GPT-4o',           high_q: 'GPT-4o',       low_q: 'Claude Sonnet'    },
    AMBIG: { default: 'GPT-4o-mini',      high_q: 'GPT-4o',       low_q: 'GPT-4o-mini'      },
  };

  // ── SEMANTIC CACHE POOL ────────────────────────────────────────
  const CACHE_POOL = [
    // ── GLOBAL KNOWLEDGE CACHE (Layer B only) ─────────────────
    // 原則：只收錄「客觀定義、不依賴客戶資料、不會隨時間改變」的知識型問題
    // 已移除：所有客戶私有資料查詢（退貨政策、庫存、DAU、轉換率、休假規定等）
    //         這些依賴客戶的業務資料，答案會變動，不適合全域快取

    // ZH — 通用定義
    '什麼是 api', '什麼是 mvp', '什麼是 token',
    '什麼是 roas', '什麼是 rfm 分析', '什麼是 mau',
    '什麼是 dau', '什麼是 kpi', '什麼是 roi',
    '什麼是個資法', '什麼是 gdpr', '什麼是 okr',
    '什麼是 nda', '什麼是 sla', '什麼是 llm',
    '什麼是向量資料庫', '什麼是語意搜尋', '什麼是微服務',
    '什麼是 ci/cd', '什麼是 devops', '什麼是 agile',
    '什麼是精實生產', '什麼是數位孿生', '什麼是物聯網',

    // EN — universal definitions
    'what is an api', 'what is a token', 'what is machine learning',
    'what is llm', 'what is rag', 'what is a vector database',
    'what is gdpr', 'what is an nda', 'what is sla',
    'what is kpi', 'what is roi', 'what is roas',
    'what is mau', 'what is dau', 'what is okr',
    'what is agile', 'what is scrum', 'what is devops',
    'what is microservices', 'what is docker', 'what is kubernetes',
    'what is lean manufacturing', 'what is digital twin',

    // JA — 通用定義
    'apiとは何ですか', 'llmとは何ですか', 'gdprとは',
    '機械学習とは', 'アジャイルとは', 'スクラムとは',
  ];

  // ══════════════════════════════════════════════════════════════
  //  LAYER 0 ── UTILITIES
  // ══════════════════════════════════════════════════════════════

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const d = [];
    for (let i = 0; i <= m; i++) {
      d[i] = [i];
      for (let j = 1; j <= n; j++) {
        d[i][j] = i === 0 ? j :
          a[i-1] === b[j-1] ? d[i-1][j-1] :
          1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]);
      }
    }
    return d[m][n];
  }

  /**
   * Detect primary language of prompt.
   * Returns 'JA' | 'ZH' | 'EN'
   */
  function detectLanguage(text) {
    // Arabic (U+0600-06FF) — RTL script
    if (/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) return 'AR';
    // Devanagari — Hindi
    if (/[\u0900-\u097F]/.test(text)) return 'HI';
    // Korean Hangul
    if (/[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(text)) return 'KO';
    // Japanese: Hiragana or Katakana
    if (/[\u3040-\u309F\u30A0-\u30FF\uFF65-\uFF9F]/.test(text)) return 'JA';
    // Chinese: Simplified vs Traditional
    if (/[\u4E00-\u9FFF]/.test(text) && !/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) {
      const SC=/[\u4E48\u4EEC\u7231\u8FD9\u6765\u65F6\u6CA1\u8BF4\u5BF9\u4E3A\u8BA4\u8FD8\u5417\u987A\u5E2E\u5199\u8BA9\u7ED9\u6837]/;
      const TC=/[\u9EBC\u5011\u611B\u9019\u4F86\u6642\u6C92\u8AAA\u5C0D\u70BA\u8A8D\u9084\u55CE\u9806\u5E6B\u5BEB\u8B93\u7D66\u6A23]/;
      if (SC.test(text) && !TC.test(text)) return 'ZH_SC';
      return 'ZH';
    }
    // German: ß or ä/ö/ü + structural words
    if (/[\xDF\xE4\xF6\xFC\xC4\xD6\xDC]/.test(text) ||
        /\b(analysieren|evaluieren|erstellen|vergleichen|bitte\s|das\s|die\s|der\s|und\s|f\xFCr\s|von\s|mit\s|ist\s|sie\s|k\xF6nnen)\b/i.test(text)) return 'DE';
    // French: verb-start or accent structure
    const FR_VERB=/^(analysez|proposez|identifiez|comparez|optimisez|r\xE9digez|r\xE9sumez|cr\xE9ez|expliquez|d\xE9finissez|\xE9valuez|pr\xE9parez|comment\b|quelles?\s+sont)/i;
    const FR_STRUCT=/[\xE0\xE2\xE6\xE7\xE9\xE8\xEA\xEB\xEE\xEF\xF4\x9C\xF9\xFB\xFC\xFF]/.test(text)&&/\b(notre|votre|nous|vous|les|des|une|est\s|pas\s|pour\s|dans\s|avec\s|au\s|du\s|qu'|c'est)\b/i.test(text);
    if (FR_VERB.test(text)||FR_STRUCT) return 'FR';
    // French structural words (short fragments)
    if (/\b(que dois|pourquoi pas|au fait|de plus|ensuite|enfin|il faut|par contre)\b/i.test(text)) return 'FR';
    // Spanish: accent chars or structural words
    if (/[\xBF\xA1\xF1\xD1\xE1\xE9\xED\xF3\xFA]/.test(text)||
        /\b(redacta|redacte|analiza|analice|explica|explique|crea\s+un|basándome|también|además|por\s+cierto|sin\s+embargo|mientras|entonces|es\s+decir|por\s+lo\s+tanto|al\s+mismo\s+tiempo)\b/i.test(text)) return 'ES';
    // Italian structural words
    if (/\b(a\s+proposito|inoltre|anche\s+se|comunque|dunque|quindi|perch[eé]|tuttavia|invece|oppure|cio[eè]|eppure|allora|per\s+esempio|nel\s+frattempo)\b/i.test(text)) return 'IT';
    return 'EN';
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).length;
  }

  function estTokens(text) {
    const lang = detectLanguage(text);
    if (lang === 'JA' || lang === 'ZH') {
      return Math.ceil(text.length * 1.5); // CJK: ~1.5 tokens per char
    }
    return Math.ceil(wordCount(text) * 1.3);
  }

  // ══════════════════════════════════════════════════════════════
  //  LAYER 1 ── P0-JA: JAPANESE PRE-PROCESSING
  //  Rules: JR-1, JR-2, JR-3, JR-4, JR-5, JR-6, JR-7
  // ══════════════════════════════════════════════════════════════

  /**
   * JR-1: Remove excessive keigo / kenjōgo
   * Returns normalized text with honorific phrases stripped.
   */
  function removeKeigo(text) {
    return text
      .replace(/お(忙し|手すき|時間|手数|世話|体|気持ち|願い|声がけ)[^。、\n]*/g, '')
      .replace(/ご?(多忙|高覧|英断|不便|迷惑|連絡|相談|支援|確認|対応|判断)[^、。\n]*/g, '')
      .replace(/(誠に|大変|たいへん)?(恐れ入りますが|恐縮ですが|申し訳[なあ]いのですが|恐れながら)/g, '')
      .replace(/(もし)?よろしければ|お手すきの際に?|いただければ幸いです|いただけますでしょうか/g, '')
      .replace(/たまわりたく存じます|ご英断を|いただければと存じます/g, '')
      .replace(/突然のご連絡(にて|で)失礼いたします(が)?/g, '')
      .replace(/いつも大変お世話になっております。?/g, '')
      .replace(/折り入って|勝手ながら|誠に勝手[なが]+ら/g, '')
      .replace(/何卒よろしくお願い(申し上げます|いたします|します)。?/g, '')
      .replace(/よろしくお願い(いたし|し)ます。?/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * JR-2: After keigo removal, detect if only vague referents remain.
   * "先日の件" / "例の案件" / "あの問題" / "当該書類" → J-POLY AMBIG
   */
  const VAGUE_REFERENTS_JA = [
    /^(先日|先般|先ほど|以前|例|あの|この|その|当該|いつもの)(の件|の案件|の問題|の資料|のメール|のやつ|のもの)?$/,
    /^(先日の件|例の案件|あの問題|当該書類|例のアレ|あれ|これ|それ)$/i,
    /^(何か|なにか|いろいろ|もろもろ|いくつか)(お願いし?ます)?$/,
    /^$/,
  ];

  function detectJPolyAmbig(normalizedText) {
    const t = normalizedText.replace(/[をにはがもでのへと]/g, '').trim();
    if (t.length < 15) {
      for (const re of VAGUE_REFERENTS_JA) {
        if (re.test(t)) return true;
      }
      // Only contains demonstratives + vague nouns
      if (/^[先例あのこのそのいつも当該]/.test(t) && t.length < 20) return true;
    }
    return false;
  }

  /**
   * JR-3: Katakana English / mixed English term difficulty mapping
   * Returns {cx, rule} if a strong signal is found, else null.
   */
  const JR3_HIGH = [
    // Finance & Strategy
    /バランスドスコアカード|BSC\b/i,
    /WBS\b|作業分解構造/,
    /ナーチャリング|nurturing/i,
    /リランク|re.?rank/i,
    /アーキテクチャ設計|architect/i,
    /デプロイ|deploy/i,
    /バックログ.*優先|backlog.*prior/i,
    /アナリシス|analysis/i,
    /コンバージョン.*戦略|conversion.*strateg/i,
    /ターゲット.*設定.*最適|target.*optim/i,
    /PDCAサイクル.*設計|PDCA.*framework/i,
    /LTV.*分析|lifetime.*value.*anal/i,
    /KGI|KPI.*設定/,
    /PM.*検討|project.*manager.*select/i,
    // Legal / Compliance
    /NDA\b|機密保持契約/,
    /SLA\b.*違反|service.*level.*agree/i,
    /RFP\b|提案依頼書/,
    /稟議書/,
    /コンプラ.*リスク|compliance.*risk/i,
  ];
  const JR3_MED = [
    /KPI\b(?!.*設定)/i,  // KPI without "設定" = MED
    /ROI\b/i,
    /レビュー|review/i,
    /ドラフト|draft/i,
    /アジェンダ|agenda/i,
    /CTA\b/i,
    /リライト|rewrite/i,
    /QCサークル|QC\b/,
    /ISO\b/,
    /MOM\b|MTG\b/,
    /ほうれんそう/,
    /5S\b/,
    /フォーマット|format/i,
  ];

  function classifyJaEngTerms(text) {
    for (const re of JR3_HIGH) {
      if (re.test(text)) return { cx: 'HIGH', rule: 'JR-3: Katakana/Abbr → HIGH (' + re.source.slice(0, 30) + ')' };
    }
    for (const re of JR3_MED) {
      if (re.test(text)) return { cx: 'MED', rule: 'JR-3: Katakana/Abbr → MED (' + re.source.slice(0, 30) + ')' };
    }
    return null;
  }

  /**
   * JR-4: Japanese multi-task connectors
   */
  const JA_MULTI_CONNECTORS = /ついでに|それから|しつつ.*も|と、?あと|〜も.*〜も|同時に|両方|それと|かつ|また、.*してください|ほか.*もお願い/;

  function detectJaMultiTask(text) {
    return JA_MULTI_CONNECTORS.test(text);
  }

  /**
   * JR-5: Normalize colloquial / typo Japanese
   */
  function normalizeJaTypo(text) {
    return text
      .replace(/おちて(る|い)/g, 'クラッシュして')
      .replace(/よわった/g, '困った')
      .replace(/なんかへん/g, 'おかしい')
      .replace(/ちょっとみて/g, '確認してください')
      .replace(/なんとかして/g, '対応してください')
      .replace(/いい感じ(に|の|で)/g, '適切に')
      .replace(/ざっくり(した|で)/g, '概略の')
      .replace(/かっこ(いい|よく)/g, '良い')
      .replace(/やばい/g, '問題がある')
      .replace(/まずい/g, '問題がある')
      .trim();
  }

  /**
   * JR-6: Strip emotional language; return cleaned text.
   */
  function removeJaEmotion(text) {
    return text
      .replace(/もう(嫌だ|限界|無理|わかりません|全然わかりません)/g, '')
      .replace (/困り(果て|はて)(た|ています)/g, '')
      .replace(/上司に怒られ(た|ました)/g, '')
      .replace(/頭を抱えて(います|いる)/g, '')
      .replace(/参って(います|いる)/g, '')
      .replace(/本当に困って(います|いる)/g, '')
      .replace(/(本当に|全然|全く)(嫌|嫌だ|無理|わからない|わかりません)/g, '')
      .replace(/心配して(います|いる)/g, '')
      .replace(/なんか(最近|うまく|ちょっと)/g, '')
      .replace(/えっと|あのう|まあその/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * JR-7: Expand Japanese business abbreviations.
   * Returns { text: expanded, forcedCx: 'HIGH'|'MED'|'LOW'|null }
   */
  const JA_ABR_HIGH = {
    '稟議書':         '意思決定承認文書',
    'WBS':            '作業分解構造',
    'NDA':            '機密保持契約',
    'SLA':            'サービス水準合意',
    'RFP':            '提案依頼書',
    'BSC':            'バランスドスコアカード',
    'PDCAサイクル':   'PDCA制度設計',
    'ToBe':           '将来の業務フロー設計',
    'AsIs':           '現状の業務フロー設計',
    'リスク管理.*フレームワーク': 'リスク管理フレームワーク策定',
  };
  const JA_ABR_MED = {
    '5S':             '整理整頓清掃清潔躾の説明',
    'QC':             '品質管理',
    'MOM':            '議事録',
    'MTG':            '会議',
    'ISO':            'ISO認証要件',
    'KPI':            '業績評価指標',
    'ROI':            '投資対効果',
    'ほうれんそう':   '報告・連絡・相談の説明',
    'PDCA(?!サイクル)': 'PDCAサイクルの実施',
    'CTA':            '行動喚起',
  };

  function expandJaAbbr(text) {
    let expanded = text;
    let forcedCx = null;
    // Check HIGH abbreviations
    for (const [abbr, full] of Object.entries(JA_ABR_HIGH)) {
      const re = new RegExp(abbr, 'g');
      if (re.test(expanded)) {
        expanded = expanded.replace(re, full);
        forcedCx = 'HIGH';
      }
    }
    if (!forcedCx) {
      for (const [abbr, full] of Object.entries(JA_ABR_MED)) {
        const re = new RegExp(abbr, 'g');
        if (re.test(expanded)) {
          expanded = expanded.replace(re, full);
          if (!forcedCx) forcedCx = 'MED';
        }
      }
    }
    return { text: expanded, forcedCx };
  }

  /**
   * P0-JA: Full Japanese pre-processing pipeline.
   * Returns { normalizedText, earlyResult } where earlyResult may
   * short-circuit the rest of the pipeline.
   */
  function processJapanese(originalText) {
    // JR-5: normalize typo / colloquial first
    let t = normalizeJaTypo(originalText);
    // JR-6: remove emotional language
    t = removeJaEmotion(t);
    // JR-1: remove keigo
    const stripped = removeKeigo(t);

    // JR-2: after keigo removal, check for J-POLY ambiguity
    if (detectJPolyAmbig(stripped)) {
      return {
        normalizedText: stripped,
        earlyResult: {
          cx: 'AMBIG',
          rule: 'JR-2: J-POLY — 敬語除去後タスク不明 → AMBIG → MED',
          noiseType: 'J-POLY',
          confidence: 35,
        },
      };
    }

    // JR-7: expand abbreviations (may force cx)
    const { text: expanded, forcedCx: abbrCx } = expandJaAbbr(stripped);

    // JR-3: katakana/English term classification
    const engResult = classifyJaEngTerms(expanded);
    if (engResult && (!abbrCx || abbrCx === 'MED')) {
      // Eng terms override MED abbr, but not HIGH abbr
      if (engResult.cx === 'HIGH' || !abbrCx) {
        return {
          normalizedText: expanded,
          earlyResult: {
            cx: engResult.cx,
            rule: engResult.rule,
            noiseType: 'J-ENG',
            confidence: 85,
          },
        };
      }
    }

    // JR-7 forced HIGH takes priority
    if (abbrCx === 'HIGH') {
      return {
        normalizedText: expanded,
        earlyResult: {
          cx: 'HIGH',
          rule: 'JR-7: J-ABR 略語展開 → HIGH',
          noiseType: 'J-ABR',
          confidence: 90,
        },
      };
    }

    // JR-4: multi-task connectors → decompose, take highest (handled in main flow)
    // Return the normalized text for further processing
    return {
      normalizedText: expanded,
      earlyResult: null,
      abbrCx,       // 'MED' | null
      isMultiTask: detectJaMultiTask(expanded),
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  P0-FR: FRENCH PRE-PROCESSING + CLASSIFICATION
  //  Rules: FR-1~5  |  Source: 499 questions, 30 sectors
  //  Distribution: HIGH 47% · MED 52% · LOW 1%
  //  Token correction: French avg 1.6 tok/word (vs EN 1.3)
  // ══════════════════════════════════════════════════════════════

  // FR-1a: Verbs that unconditionally → HIGH
  const FR1a = /^(\xE9valuez|simulez|pr\xE9voyez|d\xE9terminez|\xE9laborez|d\xE9buggez|r\xE9alisez)\b/i;

  // FR-1b: analysez + analytical object → HIGH
  const FR1b = /^analysez\b.*(impact|risque|vuln\xE9rabilit|efficacit\xE9|conformit\xE9|cause|viabilit\xE9|donn\xE9es|flux|cin\xE9tique|r\xE9sistance|anomalie|solvabilit\xE9|rentabilit\xE9|performance|strat\xE9gie|bilan|tendance|adoption|comportement|s\xE9curit\xE9|erreur|d\xE9faut)/i;

  // FR-1c: proposez + strategic object → HIGH
  const FR1c = /^proposez\b.*(strat\xE9gie|architecture|plan de|plan d'|mod\xE8le de|protocole de r\xE9ponse|restructuration|d\xE9carbonation|automatisation|solution.*(s\xE9cur|migr|optim|r\xE9duire)|nouveau mod\xE8le|plan de gestion)/i;

  // FR-1d: optimisez + complex system → HIGH
  const FR1d = /^optimisez\b.*(r\xE9partition|capital|sql|requ\xEAte|r\xE9seau|processus interne|pipeline|cha\xEEne de montage|rendement.*(synth\xE8se|mol\xE9cule)|purification)/i;

  // FR-1e: identifiez + risk/vulnerability → HIGH
  const FR1e = /^identifiez\b.*(risque|vuln\xE9rabilit|anomalie|fraude|conflit|fuite|mutation|d\xE9bris|obstacle|biais)/i;

  // FR-1f: comparez + complex comparison → HIGH
  const FR1f = /^comparez\b.*(avantages|co\xFBts de|performance|mod\xE8le|algorithme|propri\xE9t\xE9|m\xE9thode|r\xE9gime|offre)/i;

  // FR-1g: comment + security/integration action → HIGH
  const FR1g = /^comment\b.*(prot\xE9ger|s\xE9curiser|int\xE9grer|pr\xE9parer.*(contr\xF4le fiscal|dossier)|r\xE9duire.*(d\xE9lai.*assemblage|d\xE9lai.*fabrication))/i;

  // FR-1h: vérifiez + conformité → HIGH
  const FR1h = /^v\xE9rifiez\b.*conformit\xE9/i;

  // FR-1i: calculez + complex financial → HIGH
  const FR1i = /^calculez\b.*(rendement|point mort|roi.*complex)/i;

  // FR-1j: quelles sont + legal/fiscal implications → HIGH
  const FR1j = /^quelles\s+sont\b.*(implications fiscales|obligations l\xE9gales)/i;

  // FR-2: Abbreviation tables
  const FR2_HIGH = /\b(RGPD|NDA|HIPAA|OWASP|Solvabilit\xE9\s+II|REACH|ANSM|EASA|ISO\s*27001|MiCA|ACPR|CSRD|Zero\s+Trust|EDR|IAM|CRISPR)\b/i;
  const FR2_MED  = /\b(RSE|KPI|SEO|CI\/CD|KYC|BNPL|DeFi|ZFE|FDS|SWOT|NFT|JEI|BCE|CPA|DPE)\b/i;

  // FR-3: F-POLY strip (over-polite French)
  const FR3_POLY = /^(pourriez-vous\s+|auriez-vous l'amabilit\xE9 de\s+|serait-il possible de\s+|il serait utile de\s+)/i;

  // FR-4: F-MULTI connectors
  const FR4_MULTI = /\b(et proposez|et identifiez|et r\xE9digez|ainsi que|de plus,|en plus,|\xE9galement,|par ailleurs,)\b/i;

  const FR_TOKEN_FACTOR = 1.6;

  // FR-MED verbs (always MED unless overridden above)
  const FR_MED_VERBS = /^(r\xE9digez|cr\xE9ez|r\xE9sumez|expliquez|pr\xE9parez|d\xE9finissez|proposez|analysez|identifiez|comparez|optimisez|comment|quelles?\s+sont|v\xE9rifiez|calculez|d\xE9finissez)\b/i;

  /**
   * P0-FR: French pre-processing pipeline
   * Returns { cx, rule, noiseType, confidence } or null (fall through to core)
   */
  function processFrench(text, tok) {
    const tl = text.toLowerCase();

    // FR-3: F-POLY strip
    const stripped = text.replace(FR3_POLY, '').trim();
    if (stripped.length < 10 && FR3_POLY.test(text)) {
      return { cx: 'AMBIG', rule: 'FR-3: F-POLY — t\xE2che non identifiable \u2192 AMBIG \u2192 MED',
               noiseType: 'F-POLY', confidence: 35 };
    }

    // FR-2: HIGH abbreviations (check early)
    if (FR2_HIGH.test(text)) {
      const abbr = (text.match(FR2_HIGH) || [''])[0];
      return { cx: 'HIGH', rule: 'FR-2: Abr\xE9viation FR \u2192 HIGH (' + abbr + ')',
               noiseType: 'F-ABR', confidence: 92 };
    }

    // FR-1a: Always-HIGH verbs
    if (FR1a.test(tl)) {
      const v = (tl.match(/^\w+/) || [''])[0];
      return { cx: 'HIGH', rule: 'FR-1a: Verbe HIGH \u2192 ' + v,
               noiseType: null, confidence: 90 };
    }

    // FR-1b–1j: Context-dependent HIGH patterns
    const highChecks = [
      [FR1b, 'FR-1b: Analysez + objet complexe \u2192 HIGH'],
      [FR1c, 'FR-1c: Proposez strat\xE9gie/architecture \u2192 HIGH'],
      [FR1d, 'FR-1d: Optimisez processus complexe \u2192 HIGH'],
      [FR1e, 'FR-1e: Identifiez risque/vuln\xE9rabilit\xE9 \u2192 HIGH'],
      [FR1f, 'FR-1f: Comparez items complexes \u2192 HIGH'],
      [FR1g, 'FR-1g: Comment + action complexe \u2192 HIGH'],
      [FR1h, 'FR-1h: V\xE9rifiez conformit\xE9 \u2192 HIGH'],
      [FR1i, 'FR-1i: Calculez rendement \u2192 HIGH'],
      [FR1j, 'FR-1j: Quelles sont implications \u2192 HIGH'],
    ];
    for (const [pattern, rule] of highChecks) {
      if (pattern.test(tl)) return { cx: 'HIGH', rule, noiseType: null, confidence: 87 };
    }

    // FR-2: MED abbreviations
    if (FR2_MED.test(text)) {
      const abbr = (text.match(FR2_MED) || [''])[0];
      return { cx: 'MED', rule: 'FR-2: Abr\xE9viation FR \u2192 MED (' + abbr + ')',
               noiseType: 'F-ABR', confidence: 82 };
    }

    // FR-4: Multi-task connectors → escalate to HIGH
    if (FR4_MULTI.test(tl)) {
      return { cx: 'HIGH', rule: 'FR-4: F-MULTI \u2192 t\xE2ches multiples \u2192 HIGH',
               noiseType: 'F-MULTI', confidence: 78 };
    }

    // FR MED verbs (catch-all for known MED verbs)
    if (FR_MED_VERBS.test(tl)) {
      const v = (tl.match(/^\w+/) || [''])[0];
      return { cx: 'MED', rule: 'FR-1: Verbe MED \u2192 ' + v,
               noiseType: null, confidence: 80 };
    }

    return null; // fall through to core classifier
  }

  // ══════════════════════════════════════════════════════════════

  // ═══ P0-DE: German classification ════════════════════════════
  const DE_HIGH_P = /^(analysieren|evaluieren|optimieren|identifizieren|beurteilen)|\b(gdpr|dsgvo|compliance|strategie|architektur|root\s+cause|prognose|risikoanalyse|sicherheitsanalyse)\b/i;
  const DE_MED_P  = /^(erstellen|schreiben|zusammenfassen|erkl[äa]ren|beschreiben|vorbereiten|definieren|wie\s+kann|wie\s+k[öo]nnen)/i;

  // ═══ P0-ES: Spanish classification ════════════════════════════
  const ES_HIGH_P = /^(analice|eval[úu]e|simule|prevea|determine|identifique)|\b(riesgo|vulnerabilidad|cumplimiento|gdpr|estrategia|arquitectura|diagn[óo]stico|pron[óo]stico)\b/i;
  const ES_MED_P  = /^(redacte|cree|resuma|explique|prepare|defina|proponga|c[óo]mo\s+(?:mejorar|reducir|aumentar|implementar|automatizar))/i;

  const EU_TOK = 1.6;

  function processGerman(text) {
    const tl = text.toLowerCase();
    if (DE_HIGH_P.test(tl)) return { cx: 'HIGH', rule: 'DE-1: Deutsch HIGH', confidence: 82 };
    if (DE_MED_P.test(tl))  return { cx: 'MED',  rule: 'DE-2: Deutsch MED',  confidence: 78 };
    return null;
  }
  function processSpanish(text) {
    const tl = text.toLowerCase();
    if (ES_HIGH_P.test(tl)) return { cx: 'HIGH', rule: 'ES-1: Español HIGH', confidence: 82 };
    if (ES_MED_P.test(tl))  return { cx: 'MED',  rule: 'ES-2: Español MED',  confidence: 78 };
    return null;
  }

    //  LAYER 2 ── P1: GLOBAL KNOWLEDGE CACHE (Layer B only)
  //  Tenant-specific cache removed by CTO decision 2026-03
  //  Only objective, immutable definitions cached here
  // ══════════════════════════════════════════════════════════════

  /**
   * checkCache(text)
   * Layer B — Global Knowledge Cache only.
   * Contains ONLY objective definitions that never change and are
   * independent of any customer's business data.
   *
   * Per CTO decision (2026-03): Tenant-specific cache removed.
   * Rationale: customer data changes over time, wrong cached answers
   * create liability, maintenance cost exceeds benefit.
   *
   * Future: If per-tenant cache is re-introduced, it must live in
   * Supabase (user_id-scoped) with TTL and customer-managed invalidation,
   * NOT in this engine file.
   */
  function checkCache(text) {
    const tl = text.toLowerCase().trim();
    return CACHE_POOL.some(p =>
      tl.includes(p.toLowerCase()) ||
      levenshtein(tl, p.toLowerCase()) < 5
    );
  }

  // ══════════════════════════════════════════════════════════════
  //  LAYER 3 ── P2: MODAL DETECTION (R-MODAL-1~6)
  // ══════════════════════════════════════════════════════════════

  function detectModal(text) {
    if (/\[video:|video attached|\bvideo\b.*\battached\b|\.mp4|\.mov|screen recording|footage|clip/i.test(text)) return 'video';
    if (/\[x-ray|\[mri|\[ct scan|\[ultrasound|\[ecg|\[ekg|\[pathology|\[retinal|\[dental x|\[wound|\[lesion|\[skin |\[lab report|\[medication photo|\[pill |\[medical image/i.test(text)) return 'medical_image';
    if (/\[contract scan|\[nda scan|\[lease agreement|\[loan application|\[audit doc|\[kyc doc|\[employment agreement|\[court doc|\[inspection report/i.test(text)) return 'legal_doc';
    if (/\[screenshot:|\[dashboard|\[chart:|\[graph:|\[heatmap|\[flamegraph|\[spc chart|\[vibration|\[network traffic|\[options chain|\[bloomberg|\[portfolio/i.test(text)) return 'chart';
    if (/\[photo:|\[image:|\[product photo|\[store photo|\[competitor|\[floor plan|\[aerial photo|\[property photo|\[brand|\[ad creative|\[thumbnail|\[logo|\[defect|\[weld|\[pcb|\[thermal|\[surface|\[part |\[equipment|\[machine|\[worker|\[blueprint|\[ui screenshot|\[architecture diagram|\[whiteboard|\[before.after/i.test(text)) return 'image';
    if (/\[scan:|\[document|\[report scan|\[statement scan|\[invoice|\[receipt/i.test(text)) return 'doc';
    return 'text';
  }

  // ══════════════════════════════════════════════════════════════
  //  LAYER 4 ── P3-P7: MAIN CLASSIFICATION (ZH/EN)
  //  Rules: R1-R9, R-NEW1-4, R-LANG, R-AMBIG, R-MULTI,
  //         R-EMOT, R-EN1-5
  // ══════════════════════════════════════════════════════════════

  function classifyCore(text, uc, originalTok) {
    const tl = text.toLowerCase();
    const tok = originalTok || estTokens(text);

    // R-EN1: strip modal softening before any classification
    const stripped = tl
      .replace(/\b(could you|would you|might you|can you|i was wondering if|just|quick(ly)?)\b/g, '')
      .trim();

    // ── P3: Legal / Compliance force HIGH (R6) ────────────────
    if (
      ['legal', 'law'].includes(uc) ||
      /法律|合規|compliance|訴訟|liability|法規|gdpr|個資法|勞基法|著作權|商標|專利|侵權|契約審查|dpia|cease and desist|\bndas?\b|malpractice|hipaa|osha|dodd.frank/i.test(tl)
    ) {
      if ((/what is|definition|how many|幾年|幾天|多久|statute of limitations|boilerplate/i.test(tl) ||
           /^(define|what is|what are|what's)\s/i.test(tl)) && tok < 30) {
        return { cx: 'LOW', rule: 'R6排除: 法律/定義查詢 → LOW', confidence: 88 };
      
      if (/^write\s+(a|an)\s+(recommendation letter|reference letter|cover letter)\b/i.test(tl) && tok < 17) {
        return { cx: 'LOW', rule: 'R6排除: 短推薦信 → LOW', confidence: 82 };
      }}
      // 「進行說明 / 計算規則說明」→ 解釋任務 MED，不是 HIGH
      if (/計算規則.*說明|進行說明$|說明.*計算規則|加班費.*計算.*說明/.test(tl)) {
        return { cx: 'MED', rule: 'R6排除: 法律規則說明 → MED', confidence: 82 };
      }
      // EN: "Summarize/explain the key differences between X and Y" = comparison → MED
      if (/^(summarize|explain|describe)\b.{0,30}(key |main |primary )?(differences?|comparison|contrast)\b/i.test(tl) ||
          /^explain\b.{0,30}differences? between/i.test(tl)) {
        return { cx: 'MED', rule: 'R6排除: Summarize differences → MED', confidence: 84 };
      }
      // 中文「什麼是 X」「解釋 X」→ 定義查詢，降為 LOW
      if (/^(解釋|說明|介紹)?什麼是[^，。]{0,30}[？?]?$/.test(tl) ||
          /^什麼是.{0,20}(縮寫|定義|全名|意思)[？?]?$/.test(tl)) {
        return { cx: 'LOW', rule: 'R6排除: 中文法律定義查詢 → LOW', confidence: 88 };
      }
      return { cx: 'HIGH', rule: 'R6: 法律/合規強制 HIGH', confidence: 95 };
    }

    // ── P4: Complex analysis / product / strategy (R5, R-NEW2) ─
    if (/prd|product requirements|user stor|功能規格|feature spec|competitive analysis|market entry/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-NEW2: 產品需求文件 → HIGH', confidence: 90 };
    }
    if (/analysis of |assessment of |evaluation of /i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-EN3: Nominalization → HIGH', confidence: 88 };
    }

    // ── P5: EN Pronoun without referent (R-EN2) ────────────────
    // Short single-action technical commands with "this" → LOW (not AMBIG)
    // "Debug this React hook." / "Optimize this SQL query." / "Summarize this paper."
    // R-EN-THIS-CMD: Short single-action tech commands → LOW
    if (/^(debug|optimize|fix|refactor|check|review)\s+(this|the)\b/i.test(stripped) && tok < 12) {
      return { cx: 'LOW', rule: 'R-EN-THIS-CMD: Single action + this → LOW', confidence: 82 };
    }
    // R-EN-SHORT-GEN: Short single copy tasks → LOW
    // "Write a regex / meta description / product description / bio for X" = one-shot copy
    if (tok < 16 && /^(write|generate|create|give me)\s+(a|an|\d+)\s+(\d+-question|\d+-item|short|quick|simple|basic|sample)/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-SHORT-GEN: Short structured task → LOW', confidence: 80 };
    }
    if (tok < 14 && /^(write|create|draft)\s+(a|an)\s+(quiz|template|checklist|outline|sample)\b/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-SHORT-GEN: Short template/quiz → LOW', confidence: 80 };
    }
    if (tok < 10 && /^(write|generate|create)\s+(a|an|\d+)\s/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-SHORT-GEN: Very short generation → LOW', confidence: 80 };
    }
    // "Write a [copy artifact] for [target]" → LOW (single short copy task)
    if (tok < 17 &&
        /^write\s+(a|an|\d+)\s+(meta description|product description|product title|bio|tagline|headline|caption|tweet|blurb|slogan|summary|property description|linkedin headline|welcome message|maintenance log template|recommendation letter|job post)\b/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-COPY-TASK: Short copy task → LOW', confidence: 82 };
    }
    if (tok < 17 && /^draft\s+(a|an)\s+(welcome message|job post|memo|note|notice)\b/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-COPY-TASK: Short draft task → LOW', confidence: 80 };
    }

    // ── P4.5: EN Multi-deliverable / Comprehensive tasks (R-EN-COMPLEX) ──
    // Signals: explicit multi-part deliverables, comprehensive/end-to-end,
    //          large-scale generation with sequential steps
    const enComplexA = /\b(comprehensive|end-to-end|full[\s-]scale|complete guide|step-by-step guide)\b/i.test(tl);
    const enComplexB = /\b(design (the|a|our) (schema|architecture|system|database|infrastructure|api)|system design)\b/i.test(tl);
    const enComplexC = /\b(migrate|migration|refactor|translate).{5,50}(ensure|explain|provide|include)/i.test(tl);
    const enComplexD = /\bgenerate (\d{2,}|twenty|thirty|fifty) (test cases|scenarios|creatives|examples)\b/i.test(tl);
    const enComplexE = /\b(m&a|merger|acquisition|due diligence).{5,50}(review|draft|identify|list)/i.test(tl);
    const enComplexF = /\b(swot analysis).{5,80}(marketing plan|roadmap|strategy|campaign)/i.test(tl);
    const enComplexG = /\bdrip campaign\b.{0,80}(draft|write).{0,30}\d+.{0,15}(email|message)/i.test(tl);
    const enComplexH = /\b(sensitivity analysis|scenario[- ]based (model|analysis)|rpO|rto\b|burn rate.runway)/i.test(tl);
    const enComplexI = /\b(we are migrating|migrating from.{3,20}to).{10,80}(design|explain|provide)/i.test(tl);
    const enComplexK = /\b(i want to build|build a real.?time|build a.{5,30}dashboard).{10,80}(data model|suggest the|write a|draft the)/i.test(tl);
    const enComplexL = /\b(anomaly detection|fraud detection).{5,80}(flag|cross.reference|output|suspicious)/i.test(tl);
    // Group A: Marketing/content multi-deliverables
    const enComplexM = /\b(tiktok|reels|short[- ]?form).{5,80}(visual cues?|hook|cta|hashtag|script)/i.test(tl);
    const enComplexN = /\b(\d{1,2}|ten|five|eight|twelve)\s+(ad creatives?|email[s]?|posts?|variations?).{5,50}(each|provide|headline|subject line)/i.test(tl);
    const enComplexZ1 = /\b(competitor analysis|competitive analysis).{5,80}(summarize|identify|write|script|propose)/i.test(tl);
    const enComplexZ2 = /\b(cart abandonment|checkout.{3,20}friction).{5,80}(propose|suggest|re.?engagement|a.?b test)/i.test(tl) ||
      /\b(ctr|click.through rate).{5,80}(conversion|friction|audit|landing page).{5,80}(identify|suggest|a.?b test)/i.test(tl) ||
      /\b(audit the landing page).{5,80}(friction|identify|suggest|a.?b)/i.test(tl);
    const enComplexZ3 = /\b(360.degree feedback|performance review).{5,80}(draft|design|suggest|framework)/i.test(tl);
    const enComplexZ4 = /\b(grievance|workplace bullying|harassment investigation).{5,80}(outline|draft|write|memo)/i.test(tl);
    const enComplexZ5 = /\b(sourcing|supply chain|shipment delay).{5,80}(identify|calculate|draft)/i.test(tl);
    const enComplexZ6 = /\b(property manager|tenant.{3,20}(behind|default|restructuring)).{5,80}(draft|analyze|write)/i.test(tl);
    const enComplexZ7 = /\b(mixed.use development|market feasibility|green building certif).{5,80}(conduct|identify|draft|pitch)/i.test(tl);
    const enComplexZ8 = /\b(pisa results?|teaching strateg).{5,80}(identify|propose|draft)/i.test(tl);
    const enComplexZ9 = /\b(grant proposal|literature review|apa.{1,5}edition).{5,80}(draft|suggest|ensure|milestone)/i.test(tl);
    const enComplexZ10 = /\b(hybrid learning|blended learning).{5,80}(specify|draft|create|rubric)/i.test(tl);
    const enComplexO = /\b(webinar|campaign).{5,80}(landing page|email invitation|teaser|follow.?up)/i.test(tl);
    const enComplexP = /\b(review this|analyze this|assess this).{5,60}(ctr|bounce rate|conversion rate|engagement rate).{5,60}(identify|suggest|propose)/i.test(tl);
    // Group B: Medical/research multi-step
    const enComplexQ = /\b(summarize|review|analyze).{5,50}(top \d|\d papers?|\d studies?|papers?.{3,20}published|clinical trial data)/i.test(tl);
    const enComplexR = /\b(design|create|draft).{3,30}(\d[- ]week|\d[- ]month).{5,50}(plan|program|schedule).{5,80}(include|suggest|with)/i.test(tl);
    const enComplexS = /\b(research|investigate).{5,80}(list|both sides|arguments|court cases?|landmark cases?)/i.test(tl);
    const enComplexT = /\b(review this draft|check if.{5,30}(sound|logical|valid)|suggest.{5,30}ways to strengthen)/i.test(tl);
    const enComplexU = /\b(focus on|respiratory|endocrine|microplastic).{5,80}(write|draft|summary for|advisory)/i.test(tl);
    // Group C: Legal multi-part
    const enComplexV = /\b(terms of service|privacy policy|consumer guarantees?|employee monitoring|data scraping|open.source|copyleft).{5,80}(review.{0,30}(section|document|policy|clause)|ensure.{0,20}compli|identify|draft new|update)/i.test(tl);
    const enComplexW = /\b(internal investigation|sexual harassment|subpoena|privilege log|attorney.client privilege)/i.test(tl);
    const enComplexX = /\b(create a.{3,20}summary).{5,80}(laws?|regulations?|rights?|employer.{3,20}right)/i.test(tl);
    // Group D: Program creation
    const enComplexY = /\b(\d{1,2}[- ]month|annual|year[- ]long).{5,50}(program|plan|calendar|roadmap).{5,80}(include|monthly|weekly|measure)/i.test(tl);
    const enComplexJ = /,\s*(then|and then),?\s+(write|draft|provide|suggest|explain|create)/i.test(tl);
    if (enComplexA||enComplexB||enComplexC||enComplexD||enComplexE||enComplexF||
        enComplexG||enComplexH||enComplexI||enComplexJ||enComplexK||enComplexL||
        enComplexM||enComplexN||enComplexO||enComplexP||enComplexQ||enComplexR||
        enComplexS||enComplexT||enComplexU||enComplexV||enComplexW||enComplexX||enComplexY||
        enComplexZ1||enComplexZ2||enComplexZ3||enComplexZ4||enComplexZ5||
        enComplexZ6||enComplexZ7||enComplexZ8||enComplexZ9||enComplexZ10) {
      return { cx: 'HIGH', rule: 'R-EN-COMPLEX: EN multi-part/comprehensive task → HIGH', confidence: 88 };
    }

    // R-EN-IMPACT-SINGLE: "Analyze the impact of X on Y" as a single article task → MED
    // (only if no multi-deliverable markers)
    if (/^analyze (the )?impact of .{5,60} on .{5,50}\.?$/i.test(tl) &&
        !/\b(and|also|then|plus|provide|draft|suggest|calculate|compare|list the top)\b/i.test(tl)) {
      return { cx: 'MED', rule: 'R-EN-IMPACT-SINGLE: Single impact analysis article → MED', confidence: 78 };
    }

    // ── P5: Complex analysis keywords (R5) ──────────────────────
    // Strip negated verbs: "do not analyze / don't evaluate"
    const r5Strip = tl.replace(/\b(do\s+not|don't|cannot|can't|never)\s+(analyze|evaluate|assess|compare|forecast|recommend)\b/g, '').trim();
    // Explain/define opener → following verb doesn't set complexity
    const r5Explain = /^(explain|describe|define|tell\s+me\s+(about|what)|what\s+(does|is|are))\b/i.test(stripped) ||
      /^(什麼是|解釋(一下)?什麼是|說明一下什麼是)/.test(tl);
    if (
      !r5Explain &&
      /分析|analyze|evaluate|評估|比較|root cause|風險|risk assessment|預測|forecast|scenario|strategy|should we|recommend|why (is|are|did|does)|採用.*困|どうすれ.*(?:採用|売上|業績|効率|改善)/i.test(r5Strip) &&
      !(/^(what|how many|幾天|幾點|是多少)/i.test(stripped) && tok < 25)
    ) {
      return { cx: 'HIGH', rule: 'R5: 複雜分析/評估 → HIGH', confidence: 87 };
    }
    // ── P5: Engineering / financial complexity (R7, R-EN4) ─────
    if (/implement|refactor|architect|optimize.*query|migrate|design.*system|security vuln|memory leak|dcf|sensitivity analysis|three.statement|cap structure/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R7/R-EN4: 工程/財務複雜任務 → HIGH', confidence: 89 };
    }
    if (!r5Explain && /框架設計|strategy|roadmap|pricing strategy|crisis|talent|supply chain|業務効率化|組織改善|採用戦略|業績改善|コスト削減|生産性向上|エンゲージメント向上|クレーム対策|チームマネジメント|売上回復/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R5-EXT: 策略框架 → HIGH', confidence: 85 };
    }

    // ── P6: Token >200 fallback (R8) ───────────────────────────
    if (tok > 200) {
      return { cx: 'HIGH', rule: 'R8: Token>200 → HIGH', confidence: 75 };
    }

    // ── P6: Generation / MED keywords (R3) ────────────────────
    if (
      /summarize|draft|translate|rewrite|list|explain|摘要|草擬|整理|翻譯|改寫|說明|review.*format|format.*review/i.test(tl) &&
      tok <= 200
    ) {
      // Exception: short "Explain X" / "List N X" single-concept → LOW
      // Conditions: short tok + starts with explain/list+number + no complexity markers
      const isShortConcept = tok < 12 &&
        /^(explain|list\s+\d+)/i.test(tl) &&
        !/\b(impact|difference|comparison|implications|pros and cons|vs\.|versus|how|why|mechanism|implementation|process|pros|cons)\b/i.test(tl);
      if (!isShortConcept) {
        return { cx: 'MED', rule: 'R3: 中等任務關鍵字 → MED', confidence: 82 };
      }
    }

    // ── P6: Calculate (R-NEW1) ─────────────────────────────────
    if (/calculate|計算/i.test(tl)) {
      if (/scenario|forecast|model|sensitivity/i.test(tl)) {
        return { cx: 'HIGH', rule: 'R-NEW1b: 財務情境計算 → HIGH', confidence: 86 };
      }
      if (/不同.*下|不同.*情況|各種.*方案|不同利率|多種利率|各期還款/i.test(tl)) {
        return { cx: 'MED', rule: 'R-NEW1d: 多方案計算 → MED', confidence: 82 };
      }
      if (/\b(IRR|NPV|WACC|ROE|ROA|EBITDA|DCF|LTV|CAC|ARPU|ROAS)\b/.test(text.toUpperCase())) {
        // "How to calculate X" or "What is X" = definition lookup → LOW
        // Actual calculation with data context → MED
        if (tok < 15 && /^(how to calculate|what is|define|explain|what does)\b/i.test(tl)) {
          return { cx: 'LOW', rule: 'R-NEW1c-DEF: 財務指標定義查詢 → LOW', confidence: 86 };
        }
        return { cx: 'MED', rule: 'R-NEW1c: 財務指標縮寫計算 → MED', confidence: 84 };
      }
      // "Create/write a spreadsheet formula..." = MED (formula design task)
      if (/\b(spreadsheet formula|excel formula|google sheets formula|formula.{3,20}calculate)\b/i.test(tl)) {
        return { cx: 'MED', rule: 'R-NEW1e: Spreadsheet formula design → MED', confidence: 83 };
      }
      if (tok < 40) return { cx: 'LOW', rule: 'R-NEW1a: 直接算術 → LOW', confidence: 88 };
      return { cx: 'MED', rule: 'R-NEW1: 財務計算 → MED', confidence: 80 };
    }

    // ── P6: Emotional intensity (R-EMOT) — emotion ≠ complexity ─
    if (/really urgent|asap|escalate|火急|緊急|非常緊急/i.test(tl) && tok < 20) {
      return { cx: 'MED', rule: 'R-EMOT: 情緒/緊急 不影響複雜度 → MED', confidence: 72 };
    }

    // ── P6.5: ZH short generation verbs (R-ZH-GEN) ─────────────
    // R-JA-HIGH: CJK high-complexity terms — fire before ALL token checks
    // R-ZH-HOW: 「如何 + 操作型動詞」 → MED (防止短 token 落 LOW)
    if (/^如何(優化|降低|提升|改善|縮短|提高|建立|制定|建設|管理|處理|防止|應對|應用|建構|設計|規劃|強化|加速|評估|選擇|推動)/i.test(tl)) {
      if (/(公關危機|品牌危機|自動化.*生產線|生產線.*自動化|系統.*設計.*架構|生產線.*優化|優化.*生產線|財務詐欺|防止.*詐欺|內部.*舞弊|績效考核.*標準|制定.*考核.*標準|更公平.*考核)/i.test(tl)) {
        return { cx: 'HIGH', rule: 'R-ZH-HOW-HIGH: 如何+複雜策略 → HIGH', confidence: 86 };
      }
      return { cx: 'MED', rule: 'R-ZH-HOW: 如何+操作動詞 → MED', confidence: 82 };
    }

    if (/(審査|稽核|査核|監査|リスク評価|脆弱性診断|コンプライアンス審査|法務審査|合規審查|盡職調查)/.test(tl)) {
      return { cx: 'HIGH', rule: 'R-JA-HIGH: 高複雜度語彙 → HIGH', confidence: 88 };
    }
    // Legal documents — must precede R-ZH-GEN (which catches 撰寫 as MED)
    if (/(合約書|合夥.*合約|勞動契約|供應商合約.*條款|合約.*不利|撰寫.*合約書|起草.*合約|擬定.*合約|律師函|訴狀)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-LEGAL-DOC: 法律文件起草 → HIGH', confidence: 90 };
    }
    // R-ZH-RECOMMEND: 推薦+數量+對象 → MED (content generation)
    if (/^推薦(一?[下些個本款項]|幾[個本款項種]|[一二三四五六七八九十百\d]+[本個款項])/i.test(tl)) {
      return { cx: 'MED', rule: 'R-ZH-RECOMMEND: 推薦+數量 → MED', confidence: 82 };
    }
    if (/^(幫我|帮我|請幫我?|请帮我?|協助我?|协助我?|請|请)[\s]*(寫|写|翻譯|翻译|翻成|改寫|改写|草擬|草拟|起草|整理|製作|制作|編寫|编写|撰寫|撰写|修改|潤飾|润饰|改一下|調整|调整|生成|產出|产出)|幫我[^，。]{0,15}(翻成|翻譯成|改成|改寫成)/i.test(tl)) {
      return { cx: 'MED', rule: 'R-ZH-GEN: 中文生成動詞 → MED', confidence: 85 };
    }

    // R-ZH-VAGUE-ACT: 有動作動詞+修飾詞但無明確對象 → AMBIG（路由MED）
    // 例: 幫我弄得專業一點 / 再給我多一點建議 / 幫我改得更像我一點
    if (/(幫我|請幫我?)(弄|改|做|想|說|寫|排|選)(得|成|得更?)?(更|再)?.{0,8}(一點|一些|更好|更像|更多|更清楚|更專業|更完整)$/.test(tl) ||
        /^再給我(多)?(一點|一些|更多)/.test(tl) ||
        /^幫我(弄好|弄完|搞定|處理)(一下)?$/.test(tl)) {
      return { cx: 'AMBIG', rule: 'R-ZH-VAGUE-ACT: 模糊動作指令 → AMBIG → MED', confidence: 40, noiseType: 'ZH-VAGUE' };
    }

    // R-EN-GEN: Short EN generation/explanation verbs before R1 kills them
    // R-EN-EXPLAIN-TERM: "Explain X" where X is a single quoted/named term → LOW
    if (/^explain\b.{1,50}[.?]?$/i.test(tl) && tok < 12 &&
        !/\b(impact|how|why|pros|cons|difference|vs\.?|versus|mechanism|implication|importance|role|benefits)\b/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-EXPLAIN-TERM: Explain single term → LOW', confidence: 84 };
    }

    // R-EN-BRAND: Brand/voice/tone guide = MED generation task (not LOW)
    if (/\b(brand voice|tone guide|style guide|brand guide|voice and tone)\b/i.test(tl)) {
      return { cx: 'MED', rule: 'R-EN-BRAND: Brand/voice guide → MED', confidence: 82 };
    }

    // R-EN-SHORT-EXPLAIN: Short "Explain X" / "List N X" → LOW
    // "Explain 'big O' notation." / "List 5 Git best practices." / "Explain diversification."
    if (tok < 15 && /^(explain|list\s+\d+|list\s+[a-z]+\s+\d+|give\s+me\s+\d+|give\s+\d+)\b/i.test(tl) &&
        !/\b(impact|difference|comparison|implications|pros and cons|vs\.|versus)\b/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-SHORT-EXPLAIN: Short explain/list → LOW', confidence: 85 };
    }

    // R-EN-DEFINE: "Define X" / "What is X?" → LOW (single concept lookup)
    if (/^define\b.{1,40}[.?]?$/i.test(tl) ||
        (/^(what is|what are|what's) (a |an |the )?["']?\w[\w\s.&()'-]{1,35}["']?[?.]?$/i.test(tl) &&
         !/what.{0,3}s going on/i.test(tl))) {
      return { cx: 'LOW', rule: 'R-EN-DEFINE: Define/What-is single concept → LOW', confidence: 88 };
    }
    if (tok < 20 && /\b(write|draft|summarize|compose|translate|rewrite|create|explain|describe)\b/i.test(tl)) {
      return { cx: 'MED', rule: 'R-EN-GEN: EN generation verb → MED', confidence: 80 };
    }
    // Short sentences with negation + generation verb
    if (tok < 15) {
      const stripped5 = tl.replace(/\b(don't|do not|just|please|simply|only)\b/g, '').trim();
      if (/\b(write|draft|summarize|evaluate|analyze|describe|define|explain|list)\b/.test(stripped5)) {
        return { cx: 'MED', rule: 'R-EN-GEN: negation+gen → MED', confidence: 78 };
      }
    }


        // ── P7: Query / lookup (R1) ────────────────────────────────
    // 「什麼是...的最佳/重要/關鍵指標/方法/策略」→ MED（有實質內容要求）
    if (/什麼是.{0,30}(最佳|最重要|關鍵|主要|有效)(指標|方法|策略|方式|做法|評估)/i.test(tl)) {
      return { cx: 'MED', rule: 'R-ZH-WHAT-BEST: 什麼是+最佳方法/指標 → MED', confidence: 80 };
    }

    // R-FRAGMENT: Universal Naked Fragment Detection (ZH/EN/JA/FR all languages)
    // Short utterances that only make sense WITH prior conversation context.
    // noiseType='FRAGMENT':
    //   WITH ctx  → inherit lastTier (session continues uninterrupted)
    //   WITHOUT ctx → AMBIG → MED (conservative fallback)

    // P1: Ends with "..." or "…" = explicit continuation marker
    const isFrag_ellipsis = /[.…]{2,}\s*$/.test(text) || text.trim().endsWith('…');

    // P2: ZH vague phrases (demonstratives, acknowledgments, minimal sentences)
    const isFrag_ZH =
      // AMBIG: vague pronouns/confirmations
      /^(好了嗎|做好了嗎|完成了嗎|差不多就好|隨便弄?[一下]?|隨便弄一下|幫我搞定|什麼情況|怎麼辦|換一個|就照之前的?|懂我意思吧?|你確定嗎?|為什麼不行|還有其他的?嗎?|那是哪一個|那個呢|然後勒|你覺得呢|這樣行嗎|幫我看一下|這個?怎麼弄|這怎麼弄|這是什麼意思|就這樣吧?)[？?！!。]?$/.test(tl) ||
      // MULTI: bare-word ZH continuation connectors
      /^(順便|還有|另外|接著下去|接著|然後呢|再幫我|承上|根據剛剛的|把上面的|最後|以及|同時|對了[，,]?|另一方面|除此之外|基於上述|繼續|幫我把它|再補充一點|還有就是)[，,。！!？?]?$/.test(tl);

    // P3: JA vague phrases
    const isFrag_JA =
      // AMBIG: vague JA phrases + これ... forms
      /^(終わった|できた|どれのこと|どう思う|なんでダメなの|他には|どうしよう|適当にやっといて|大体でいいよ|あれは|確かなの|本当に|それで|言いたいことわかる|前のと同じで|別のやつにして|なんとかして|どうなってるの|ちょっと見て|ちょっと確認して|これでいい|これどういう意味|これどうやるの)[？?！!。]?$/.test(tl) ||
      // MULTI: bare-word JA continuation connectors
      /^(ついでに|あと|ほかに|続いて|それから|さらに|承前ですが|続きですが|さっきの|上記の内容を|最後に|および|ならびに|同時に|ところで|一方で|それ以外に|以上を踏まえて|続けて|それを|補足として|それと)[、。！!？?]?$/.test(tl);

    // P4: EN pure conversational vague phrases
    const isFrag_EN =
      // AMBIG: pure vague EN phrases (including slash variants)
      /^(how do i do this|done yet|is it done|which one is it|take a look at this|what do you think|is this okay|does this work|why not|anything else|what should i do|what does this mean|just do whatever|close enough|that.{0,4}ll do|what about that one|are you sure|and then|you know what i mean|just like before|same as before|pick another one|get it done|fix it|what.{0,3}s going on)[？?！!。. /a-z'.]*$/i.test(tl) ||
      // MULTI: bare-word EN continuation connectors
      /^(also|and|plus|then|next|finally|can you also|following up on that|based on what you (just )?said|take the above and|as well as|at the same time|by the way|on the other hand|besides that|given the above|keep going|can you make it|one more thing|and another thing)[!?.,]?$/i.test(tl);

    // P5: FR pure vague phrases
    // FR fragments: short FR utterances — accent chars OR explicit phrase list
    const _frTlNorm = tl.replace(/['']/g, "'");  // normalize apostrophes
    const isFrag_FR = (tok <= 8 &&
      /[çàâéèêëîïôùûüœæ]/i.test(text) &&
      !/\b(analysez|proposez|[eé]valuez|r[eé]digez|comparez|identifiez)\b/i.test(tl)) ||
      /^(pourquoi pas|autre chose|fais.le vite fait|comme avant|prends.en un autre|tu (es s[uû]r|vois ce que)|r[eè]gle|c.{0,2}est (lequel|fini|pr[eê]t|assez)|[çca] (va|ira|veut dire quoi)|et (apr[eè]s|[çca])|jette un .{1,5}il|jette un oeil|qu.est.ce que tu en penses|tu vois ce que je veux dire|qu'est.ce qui se passe|que dois.je faire)\s*[？?！!。.]?$/i.test(_frTlNorm) ||
      // FR MULTI bare connectors (no trailing "...") — no tok limit for explicit phrases
      /^(au fait|et aussi|de plus|en outre|ensuite|puis|tu peux aussi|d'apr[eè]s ce que (tu|vous) (viens|venez) de (dire|mentionner)?|d'apr[eè]s ce que|prends ce qui pr[eé]c[eè]de( et)?|enfin|ainsi que|en m[eê]me temps|[àa] propos|d'un autre c[oô]t[eé]|en dehors de [çca]|compte tenu de ce qui pr[eé]c[eè]de|continue|rends.le|fais.en|encore une chose|et autre chose)[？?！!.,]?$/i.test(_frTlNorm);

    const isFrag_ZH_SC=/^(好了吗|那是哪一个|帮我看一下|你觉得呢|这样行吗|为什么不行|还有其他的吗|怎么办|这是什么意思|随便弄一下|差不多就好|那个呢|然后呢|懂我意思吧|就照之前的|换一个|帮我搞定|什么情况|这个怎么弄)[？?!!。]?$/.test(tl)||/^(顺便|还有|另外|接着|然后|再帮我|承上|根据刚刚的|把上面的|最后|以及|同时|对了[，,]?|另一方面|除此之外|基于上述|继续|帮我把它|再补充一点|还有就是)[，,。!!？?]?$/.test(tl);
    const isFrag_KO=/^(어떻게 해|다 됐어|어느 거야|한번 봐줘|이거 괜찮아|왜 안 돼|다른 건 없어|어떡하지|이게 무슨 뜻이야|대충 해줘|이 정도면 돼|그건|확실해|무슨 상황이야|해결해줘)[?？!！.。]?$/.test(tl)||/^(그리고|또한|게다가|다음으로|이어서|마지막으로|동시에|그런데|반면에|계속해서|추가로)[?？!！.,]?$/.test(tl);
    const isFrag_HI=/^(यह कैसे करें|हो गया|कौन सा है|इसे देखो|यह ठीक है|क्यों नहीं|और कुछ|क्या हो रहा है)[??！!।]?$/.test(tl)||/^(वैसे|इसके अलावा|साथ ही|इसके बाद|फिर|और भी|आगे|अंत में|तथा|जारी रखें)[??！!.,।]?$/.test(tl);
    const isFrag_AR=/^(كيف أفعل هذا|هل انتهيت|أيهما|ما رأيك|هل هذا جيد|لماذا لا|ماذا أفعل|ما معنى هذا|هل أنت متأكد|وبعدين|كما قبل|ما الوضع)[?;؟!،]?$/.test(tl)||/^(بالمناسبة|بالإضافة|كذلك|ثم|بعد ذلك|وأيضاً|أخيراً|في نفس الوقت|من ناحية أخرى|واصل|نقطة أخرى)[?;؟!،.]?$/.test(tl);
    const isFrag_ES=/^(c[oó]mo se hace esto|ya terminaste|ya est[aá]|qu[eé] te parece|est[aá] bien|por qu[eé] no|algo m[aá]s|qu[eé] debo hacer|est[aá]s seguro|como antes|elige otro|resu[eé]lvelo)[?!., /]*$/i.test(tl)||/^(por cierto|adem[aá]s|tambi[eé]n|luego|finalmente|asimismo|al mismo tiempo|por otro lado|aparte de eso|contin[uú]a)[?!.,]?$/i.test(tl);
    const isFrag_DE=/^(wie macht man das|fertig|bist du fertig|was denkst du|ist das okay|warum nicht|bist du sicher|und dann|wie vorher|erledige das|was ist los)[?!., /]*$/i.test(tl)||/^([üu]brigens|au[ßs]erdem|auch|dann|danach|gleichzeitig|andererseits|weiter|noch eine sache)[?!.,]?$/i.test(tl);
    const isFrag_IT=/^(come si fa|hai finito|qual [eè]|cosa ne pensi|va bene cos[ií]|perch[eé] no|altro|cosa devo fare|fallo velocemente|pi[uù] o meno|sei sicuro|e poi|sai cosa intendo|come prima|scegline un altro|risolvilo)[?!., /]*$/i.test(tl)||/^(a proposito|inoltre|anche|poi|dopo|infine|allo stesso (modo|tempo)|d.altra parte|oltre a|continua)[?!.,]?$/i.test(tl);
    if (isFrag_ellipsis||isFrag_ZH||isFrag_ZH_SC||isFrag_JA||isFrag_EN||isFrag_FR||
        isFrag_ES||isFrag_DE||isFrag_IT||isFrag_KO||isFrag_HI||isFrag_AR) {
      return { cx: 'AMBIG', rule: 'R-FRAGMENT: 裸片段/模糊脈絡句 → AMBIG', confidence: 25, noiseType: 'FRAGMENT' };
    }

    if (
      /what is|definition|how many|status|track|faq|什麼是|查詢|是多少|幾天|幾點/i.test(tl) ||
      tok < 20
    ) {
      return { cx: 'LOW', rule: 'R1: 查詢/定義/短 token → LOW', confidence: 85 };
    }

    // ── P6.8: ZH multi-task connectors (R-ZH-MULTI-V2) ─────────────
    // 「順便/還有/並且/最後」= Chinese multi-task markers
    // Split into segments, classify each, return highest
    const ZH_MULTI_RE = /[，。]?\s*(順便|還有[，,]|並且|再幫我|最後[，,]?幫?我|接著|另外[，,])/;
    if (ZH_MULTI_RE.test(tl) && tl.length > 15) {
      const segs = tl.split(ZH_MULTI_RE)
        .filter(s => s && s.length > 3 && !ZH_MULTI_RE.test(s))
        .map(s => s.trim());
      if (segs.length >= 2) {
        const ord = { HIGH:3, MED:2, LOW:1, AMBIG:2 };
        let top = 'LOW';
        segs.forEach(seg => {
          // Re-use core logic inline for each segment
          const sr = classifyCore(seg, uc, Math.ceil(seg.length * 1.5));
          const scx = sr.cx === 'AMBIG' ? 'MED' : sr.cx;
          if ((ord[scx]||0) > (ord[top]||0)) top = scx;
        });
        if (top !== 'LOW') {
          return { cx: top, rule: 'R-ZH-MULTI-V2: 中文多任務連接詞 → ' + top + ' (' + segs.length + 'segs)', confidence: 78 };
        }
      }
    }

    // ── P6.9: ZH-specific HIGH patterns ──────────────────────────
    if (/(合約書|合夥.*合約|勞動契約|供應商合約.*條款|合約.*不利.*條款|撰寫.*合約|起草.*合約|擬定.*合約)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-CONTRACT: 合約起草/審查 → HIGH', confidence: 88 };
    }
    if (/(公關危機|品牌危機|財務詐欺|防止.*詐欺|內部.*舞弊|反舞弊)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-CRISIS: 危機/防詐 → HIGH', confidence: 87 };
    }
    if (/(重構.*(?:solid|原則|設計模式|架構)|refactor.*(?:solid|principle|pattern))/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-REFACTOR: 重構+設計原則 → HIGH', confidence: 87 };
    }
    if (/(分庫分表|分片策略|資料庫.*規模.*建議|sharding strategy)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-DBARCH: 資料庫架構策略 → HIGH', confidence: 88 };
    }
    if (/(制定.*(?:績效|考核|薪酬|評核).*標準|更公平.*考核|績效考核.*制定)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-POLICY: 考核制度設計 → HIGH', confidence: 85 };
    }
    // R-ZH-COMPARE-MULTI: 3個以上選項的排序/比較 → HIGH
    if (/([^和跟與]+[、,，][^和跟與]+)(和|跟|與|、)[^、,，]+.{0,15}(怎麼排|順序|排列|先後|哪個先|哪種好|比較好|哪一個最|哪個最)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-COMPARE-MULTI: 多選項排序/比較 → HIGH', confidence: 85 };
    }

    // ── P7: Token length fallback (R4) ────────────────────────
    if (tok >= 20 && tok <= 200) {
      return { cx: 'MED', rule: 'R4: Token 20–200 → MED', confidence: 65 };
    }

    return { cx: 'MED', rule: 'R4-兜底: Default → MED', confidence: 60 };
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC: classify(prompt, uc)
  //  Returns: { cx, rule, tok, modal, lang, confidence, noiseType }
  // ══════════════════════════════════════════════════════════════

  // ═══ P0-IT: Italian ════════════════════════════════════════
  const IT_HIGH_W=/(analisi|valutazione|progettazione|sviluppo|strategia|migrazione|architettura|ottimizzazione|conformit[aà]|sicurezza|vulnerabilit[aà])/i;
  const IT_MED_W=/^(scrivi|crea|analizza|spiega|riassumi|traduci|progetta|descrivi|sviluppa|elabora|prepara|presenta)\s/i;
  const IT_COMP_W=/(guida completa|analisi completa|piano completo|passo per passo|esaustivo|approfondito)/i;
  function processItalian(text){
    const tl=text.toLowerCase();
    if(/^(cos[\u2019'][\xE8e]|cosa significa|cosa vuol dire)[^,;]{0,40}[?.]?$/i.test(tl))return{cx:'LOW',rule:'IT-DEF: definizione \u2192 LOW',confidence:86};
    if(IT_COMP_W.test(text)||(IT_HIGH_W.test(text)&&text.length>25))return{cx:'HIGH',rule:'IT-HIGH: compito complesso \u2192 HIGH',confidence:83};
    if(IT_MED_W.test(tl))return{cx:'MED',rule:'IT-MED: verbo generazione \u2192 MED',confidence:81};
    return null;
  }

  // ═══ P0-KO: Korean ═════════════════════════════════════════
  const KO_HIGH_W=/(분석|평가|설계|전략|아키텍처|마이그레이션|보안|감사|진단|최적화|로드맵|취약점|컴플라이언스)/;
  const KO_MED_W=/(작성해(줘|주세요)?|써(줘|주세요)|만들어(줘|주세요)|분석해(줘|주세요)|설명해(줘|주세요)|요약해(줘|주세요)|번역해(줘|주세요)|정리해(줘|주세요))[.。]?$|^(작성|요약|설명|번역)\s+/;
  const KO_COMP_W=/(종합|전반적인|상세한|체계적인|완전한|단계별|전략적)/;
  function processKorean(text){
    const tl=text.toLowerCase();
    if(/^(이란 무엇인가|뜻이 뭐야|무엇인가|무슨 뜻)[^,;]{0,40}[?？]?$/.test(tl))return{cx:'LOW',rule:'KO-DEF: 정의 쿼리 \u2192 LOW',confidence:86};
    if(KO_COMP_W.test(text)||(KO_HIGH_W.test(text)&&text.length>25)||(KO_MED_W.test(text)&&KO_HIGH_W.test(text)))return{cx:'HIGH',rule:'KO-HIGH: 복합 고난도 작업 \u2192 HIGH',confidence:84};
    if(KO_MED_W.test(text))return{cx:'MED',rule:'KO-MED: 생성 동사 \u2192 MED',confidence:82};
    return null;
  }

  // ═══ P0-HI: Hindi ══════════════════════════════════════════
  const HI_HIGH_W=/(विश्लेषण|रणनीति|विकास|डिज़ाइन|मूल्यांकन|ऑडिट|माइग्रेशन|आर्किटेक्चर|व्यापक|योजना|रिपोर्ट)/;
  const HI_MED_W=/(लिखो|बनाओ|विश्लेषण करो|समझाओ|संक्षेप करो|अनुवाद करो|विकसित करो|तैयार करो|लिखिए|बनाइए)[।.]?$|^(लिखो|बनाओ|समझाओ)\s+/;
  function processHindi(text){
    const tl=text.toLowerCase();
    if(/^(क्या है|का अर्थ|परिभाषा|यह क्या है)[^,;।]{0,40}[?।]?$/.test(tl))return{cx:'LOW',rule:'HI-DEF: परिभाषा \u2192 LOW',confidence:84};
    if(HI_HIGH_W.test(text)&&text.length>25)return{cx:'HIGH',rule:'HI-HIGH: जटिल कार्य \u2192 HIGH',confidence:82};
    if(HI_MED_W.test(text))return{cx:'MED',rule:'HI-MED: उत्पादन क्रिया \u2192 MED',confidence:80};
    return null;
  }

  // ═══ P0-AR: Arabic ═════════════════════════════════════════
  const AR_HIGH_W=/(تحليل|تقييم|تصميم|تطوير|استراتيجية|هجرة|مراجعة|هندسة|معمارية|أمان|ثغرات|شامل|تقرير)/;
  const AR_MED_W=/^(اكتب|أنشئ|حلل|اشرح|لخص|ترجم|صمم|طور|أعد|اعمل)\s/;
  function processArabic(text){
    if(/^(ما هو|ما هي|تعريف|ماذا يعني|اشرح معنى)[^,;،]{0,40}[?؟]?$/.test(text))return{cx:'LOW',rule:'AR-DEF: تعريف \u2192 LOW',confidence:84};
    if(AR_HIGH_W.test(text)&&text.length>25)return{cx:'HIGH',rule:'AR-HIGH: مهمة معقدة \u2192 HIGH',confidence:82};
    if(AR_MED_W.test(text))return{cx:'MED',rule:'AR-MED: فعل إنشاء \u2192 MED',confidence:80};
    return null;
  }


  function classify(prompt, uc) {
    if (!prompt || typeof prompt !== 'string') {
      return { cx: 'MED', rule: 'Default: empty prompt', tok: 0, modal: 'text', lang: 'EN', confidence: 0 };
    }

    // Strip markdown code fences — measure instruction complexity, not code
    const stripped4 = /```/.test(prompt)
      ? (prompt.replace(/```[\s\S]*?```/g, '[CODE]').trim() || prompt)
      : prompt;

    const lang = detectLanguage(stripped4);
    const modal = detectModal(prompt);
    const tok = estTokens(stripped4);
    let workingText = stripped4;
    let noiseType = null;

    // ── P1: Semantic cache ─────────────────────────────────────
    // Fragment pre-check: naked fragments must not be cached
    const _pnl = prompt.toLowerCase().trim().replace(/['']/g,"'");
    const isNakedFrag =
      /^(好了嗎|怎麼辦|換一個|什麼情況|幫我搞定|這樣行嗎|然後勒|那是哪一個|懂我意思吧?|就照之前的?|這是什麼意思|還有其他的?嗎?|順便|還有|另外|接著|然後|再幫我|承上|以及|同時|對了|另一方面|除此之外|基於上述|繼續|幫我把它|再補充一點|還有就是)[？?！!。，,]?$/.test(_pnl) ||
      /^(what.{0,3}s going on|done yet|and then|just do whatever|also|and|plus|then|next|finally|can you also|keep going|one more thing|and another thing)[？?!.,]?$/i.test(_pnl) ||
      /^(ついでに|あと|ほかに|続いて|それから|さらに|承前|最後に|および|同時に|以上を|続けて|補足として|それと)[、。！!？?]?$/.test(_pnl) ||
      /^(그리고|또한|이어서|마지막으로|동시에|어떻게 해|다 뤌어)[??！!.,]?$/.test(_pnl) ||
      /^(वैसे|इसके अलावा|साथ ही|फिर|और भी|जारी रखें)[??！!.,।]?$/.test(_pnl) ||
      /^(بالمناسبة|بالإضافة|كذلك|ثم|هل انتهيت|ما رأيك)[?;؟!،.]?$/.test(_pnl) ||
      /^(顺便|还有|另外|接着|帮我搞定|好了吗|这样行吗)[，,。!！？?]?$/.test(_pnl) ||
      /^(au fait|et aussi|de plus|ensuite|puis|tu peux aussi|enfin|ainsi que|continue|encore une chose|et autre chose)[？?!.,]?$/i.test(_pnl) ||
      /[.…]{2,}$/.test(prompt.trim());
    if (!isNakedFrag && checkCache(prompt)) {
      return { cx: 'LOW', rule: 'R9: 語義快取命中 → $0', tok, modal, lang, confidence: 99, isCache: true };
    }

    // ── P2: Modal routing ──────────────────────────────────────
    if (modal === 'video') {
      return { cx: 'HIGH', rule: 'R-MODAL-4: 影片 → HIGH', tok, modal, lang, confidence: 99 };
    }
    if (modal === 'medical_image') {
      return { cx: 'HIGH', rule: 'R-MODAL-2: 醫療影像 → HIGH forced', tok, modal, lang, confidence: 99 };
    }
    if (modal === 'legal_doc') {
      return { cx: 'HIGH', rule: 'R-MODAL-1+R6: 法律文件掃描 → HIGH', tok, modal, lang, confidence: 99 };
    }
    if (modal === 'image' || modal === 'doc') {
      if (/法律|legal|medical|contract|compliance|gdpr|hipaa|defect|weld|security|vulnerability/i.test(prompt)) {
        return { cx: 'HIGH', rule: 'R-MODAL-2/3: 高風險影像 → HIGH', tok, modal, lang, confidence: 97 };
      }
      if (/analyze|assess|evaluate|diagnose|compare|strategy|judge|determine|should we/i.test(prompt.toLowerCase())) {
        return { cx: 'HIGH', rule: 'R-MODAL-1+R5: 影像+分析 → HIGH', tok, modal, lang, confidence: 95 };
      }
      return { cx: 'MED', rule: 'R-MODAL-1: 影像請求 → 最低 MED', tok, modal, lang, confidence: 88 };
    }
    if (modal === 'chart') {
      if (/why|root cause|should|recommend|strategy|forecast|signal|indicate/i.test(prompt.toLowerCase())) {
        return { cx: 'HIGH', rule: 'R-MODAL-1+R5: 圖表+推論 → HIGH', tok, modal, lang, confidence: 92 };
      }
      return { cx: 'MED', rule: 'R-MODAL-5: 圖表讀取 → MED', tok, modal, lang, confidence: 85 };
    }

    // ── P0-DE: German ───────────────────────────────────────────
    if (lang === 'DE') {
      const dt = Math.ceil(wordCount(prompt) * EU_TOK);
      const de = processGerman(prompt);
      if (de) return { cx:de.cx, rule:de.rule, tok:dt, modal, lang, noiseType:null, confidence:de.confidence };
      const dc = classifyCore(prompt, uc, dt);
      return { cx:dc.cx, rule:dc.rule, tok:dt, modal, lang, noiseType:dc.noiseType||null, confidence:dc.confidence };
    }
    // ── P0-ES: Spanish ──────────────────────────────────────────
    if (lang === 'ES') {
      const et = Math.ceil(wordCount(prompt) * EU_TOK);
      const es = processSpanish(prompt);
      if (es) return { cx:es.cx, rule:es.rule, tok:et, modal, lang, noiseType:null, confidence:es.confidence };
      const ec = classifyCore(prompt, uc, et);
      return { cx:ec.cx, rule:ec.rule, tok:et, modal, lang, noiseType:ec.noiseType||null, confidence:ec.confidence };
    }
    if (lang === 'IT') {
      const it = processItalian(prompt);
      if (it) return {cx:it.cx, rule:it.rule, tok, modal, lang, noiseType:it.noiseType||null, confidence:it.confidence};
      const ic = classifyCore(prompt, uc, tok);
      return {cx:ic.cx, rule:ic.rule, tok, modal, lang, noiseType:ic.noiseType||null, confidence:ic.confidence};
    }
    if (lang === 'KO') {
      const ko = processKorean(prompt);
      if (ko) return {cx:ko.cx, rule:ko.rule, tok, modal, lang, noiseType:null, confidence:ko.confidence};
      const kc = classifyCore(prompt, uc, tok);
      return {cx:kc.cx, rule:kc.rule, tok, modal, lang, noiseType:kc.noiseType||null, confidence:kc.confidence};
    }
    if (lang === 'HI') {
      const hi = processHindi(prompt);
      if (hi) return {cx:hi.cx, rule:hi.rule, tok, modal, lang, noiseType:null, confidence:hi.confidence};
      const hc = classifyCore(prompt, uc, tok);
      return {cx:hc.cx, rule:hc.rule, tok, modal, lang, noiseType:hc.noiseType||null, confidence:hc.confidence};
    }
    if (lang === 'AR') {
      const ar = processArabic(prompt);
      if (ar) return {cx:ar.cx, rule:ar.rule, tok, modal, lang, noiseType:null, confidence:ar.confidence};
      const ac = classifyCore(prompt, uc, tok);
      return {cx:ac.cx, rule:ac.rule, tok, modal, lang, noiseType:ac.noiseType||null, confidence:ac.confidence};
    }
    // ── P0-FR: French pre-processing ──────────────────────────
    if (lang === 'FR') {
      // Check FRAGMENT before FR rules
      const _frFrag = classifyCore(workingText, uc, tok);
      if (_frFrag.noiseType === 'FRAGMENT') {
        return { cx: _frFrag.cx, rule: _frFrag.rule, tok, modal, lang: 'FR',
                 noiseType: 'FRAGMENT', confidence: _frFrag.confidence };
      }
      const frTok = Math.ceil(wordCount(prompt) * FR_TOKEN_FACTOR);
      const frResult = processFrench(prompt, frTok);
      if (frResult) {
        return {
          cx: frResult.cx,
          rule: frResult.rule,
          tok: frTok,
          modal, lang,
          noiseType: frResult.noiseType,
          confidence: frResult.confidence,
        };
      }
      // No FR rule matched — fall through to core with corrected token count
      const core = classifyCore(prompt, uc, frTok);
      return { cx: core.cx, rule: core.rule, tok: frTok,
               modal, lang, noiseType: core.noiseType || null, confidence: core.confidence };
    }

    // ── P0-JA: Japanese pre-processing ────────────────────────
    if (lang === 'JA') {
      // Check for JA FRAGMENT phrases first (they bypass processJapanese)
      const jaFragCore = classifyCore(workingText, uc, tok);
      if (jaFragCore.noiseType === 'FRAGMENT') {
        return { cx: jaFragCore.cx, rule: jaFragCore.rule, tok, modal, lang,
                 noiseType: 'FRAGMENT', confidence: jaFragCore.confidence };
      }
      const jaResult = processJapanese(prompt);
      workingText = jaResult.normalizedText;
      noiseType = jaResult.earlyResult ? jaResult.earlyResult.noiseType : null;

      if (jaResult.earlyResult) {
        const er = jaResult.earlyResult;
        // AMBIG from J-POLY → conservative MED escalation
        const finalCx = er.cx === 'AMBIG' ? 'AMBIG' : er.cx;
        return {
          cx: finalCx,
          rule: er.rule,
          tok, modal, lang,
          noiseType: er.noiseType,
          confidence: er.confidence,
        };
      }

      // JR-4: Multi-task → split at connectors, classify each, take highest cx
      if (jaResult.isMultiTask) {
        const segs = workingText.split(/ついでに|それから|と、?あと|同時に|それと|また、/).map(s=>s.trim()).filter(s=>s.length>3);
        const ord={HIGH:3,MED:2,LOW:1,AMBIG:2}; let top='MED';
        segs.forEach(seg=>{const sr=classifyCore(seg,uc,tok);const scx=sr.cx==='AMBIG'?'MED':sr.cx;if((ord[scx]||0)>(ord[top]||0))top=scx;});
        const fCx=jaResult.abbrCx==='HIGH'?'HIGH':top;
        return{cx:fCx,rule:'JR-4: J-MULTI → '+fCx+' ('+segs.length+'segs)',tok,modal,lang,noiseType:'J-MULTI',confidence:80};
      }

      // JR-7 MED abbreviation forced
      if (jaResult.abbrCx === 'MED') {
        return {
          cx: 'MED',
          rule: 'JR-7: J-ABR 略語展開 → MED',
          tok, modal, lang,
          noiseType: 'J-ABR',
          confidence: 85,
        };
      }
    }

    // ── P3–P7: Core classification ─────────────────────────────
    const core = classifyCore(workingText, uc, tok);
    return {
      cx: core.cx,
      rule: core.rule,
      tok, modal, lang,
      noiseType: core.noiseType || noiseType || null,
      confidence: core.confidence,
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  MODEL SELECTION
  // ══════════════════════════════════════════════════════════════

  function selectModel(cx, modal, qualityTier) {
    // Modal-specific models take priority
    if (modal && modal !== 'text' && MODAL_MODELS[modal]) {
      return MODAL_MODELS[modal];
    }
    const tier = TIER_MODELS[cx] || TIER_MODELS.MED;
    if (qualityTier === 'high') return tier.high_q;
    if (qualityTier === 'low')  return tier.low_q;
    return tier.default;
  }

  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC: route(prompt, uc, qualityTier)
  //  Returns full routing result including cost, savings, model.
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  //  CONTEXT-AWARE ROUTING — Backreference Detection
  //
  //  When a prompt references previous conversation output
  //  ("把上面的分析翻成英文", "compress it", "承上，幫我..."),
  //  the classification FLOOR is raised to match the prior context tier.
  //
  //  This prevents routing "compress this" to Gemini Flash when
  //  "this" refers to a complex HIGH-tier analysis that GPT-4o produced.
  //
  //  Usage:
  //    CascaClassifier.route(prompt, uc, qualityTier, { lastTier: 'HIGH', lastTok: 480 })
  //
  //  ZH-MINIMAL noiseType:
  //    Extremely short ambiguous sentences (好了嗎/下一個/快一點).
  //    With context  → inherit lastTier (same model, session continues)
  //    Without context → AMBIG → MED (conservative fallback)
  //
  //  Decision (2026-03): Situation A (independent simple requests) still
  //  routes independently — only prompts with explicit backreference tokens
  //  inherit context floor. This preserves cost savings on truly new questions.
  // ══════════════════════════════════════════════════════════════

  const BACKREF_ZH = /(上(面|述|方)的|剛才的|前面的|之前(提到|說的|那個|的分析|的內容)|承上|根據(以上|上述|剛才)|把(它|這個|那個|上面)(再|幫我|翻|縮|改|整理|擴|精簡)|幫我(再)?縮短(一下)?$|幫我(再)?翻譯(一下)?$|針對(以上|上述)|依照(以上|上述)|用(上面|剛才)(說的|提到的))/;
  const BACKREF_EN = /(the above|the previous|the last|compress (it|this|that)|summarize (it|this|that)|translate (it|this|that)|shorten (it|this|that)|the analysis above|based on (the above|what (i|you) (said|mentioned|wrote))|rewrite (it|this)|revise (it|this)|expand (on )?(it|this|that)|from (the above|above)|per (the above|our discussion)|following (up|the above))/i;
  const BACKREF_JA = /(上記の|上述の|先ほどの|前述の|それを(翻訳|要約|短く|まとめ)|上の(分析|内容|結果)を|承前|以上を踏まえて)/;

  const BACKREF_FR = /(d['"']apr[eè]s ce que|prends ce qui pr[eé]c[eè]de|compte tenu de ce qui|pour faire suite|au fait[^a-z]|et aussi[^a-z]|de plus[^a-z]|en outre[^a-z]|en m[eê]me temps[^a-z]|[àa] propos[^a-z]|d['"']un autre c[oô]t[eé][^a-z]|en dehors de [çca][^a-z]|encore une chose[^a-z]|rends.le[^a-z]|r[eè]gle [çca][^a-z])/i;

  const BACKREF_ZH_SC=/(上(面|述|方)的|刚才的|前面的|之前(提到|说的)|承上|根据(以上|上述|刚才)|基于上述|根据刚刚的|把上面的)/;
  const BACKREF_KO=/(위의 내용|방금 말한|앞에서 언급한|이전에 말한|이를 바탕으로|위를 기반으로|앞서 말했듯이)/;
  const BACKREF_HI=/(ऊपर के आधार पर|जो अभी कहा|पहले बताया|इसके आधार पर|उपरोक्त के अनुसार)/;
  const BACKREF_AR=/(بناءً على ما سبق|ما قلته للتو|كما ذكرت|بناءً على هذا|وفقاً لما سبق)/;

  function detectBackreference(text) {
    return BACKREF_ZH.test(text)||BACKREF_ZH_SC.test(text)||BACKREF_EN.test(text)||
           BACKREF_JA.test(text)||BACKREF_FR.test(text)||
           BACKREF_KO.test(text)||BACKREF_HI.test(text)||BACKREF_AR.test(text);
  }

  /**
   * Compute the context floor:
   * If backref detected, the minimum cx is one tier below the lastTier.
   * HIGH context → minimum MED (never drop to LOW on backreference)
   * MED  context → minimum MED
   * LOW  context → no floor (normal routing)
   */
  function contextFloor(cx, lastTier) {
    if (!lastTier) return cx;
    const order = { LOW: 1, MED: 2, HIGH: 3 };
    const floor = lastTier === 'HIGH' ? 'MED' : lastTier === 'MED' ? 'MED' : 'LOW';
    return (order[cx] || 0) >= (order[floor] || 0) ? cx : floor;
  }

  function route(prompt, uc, qualityTier, conversationContext) {
    uc = uc || 'general';
    qualityTier = qualityTier || 'default';
    // conversationContext: { lastTier: 'HIGH'|'MED'|'LOW', lastTok: number } | null

    const classified = classify(prompt, uc);
    let cx = classified.cx;

    // Cache hit → free
    if (classified.isCache) {
      const baseCost = (classified.tok / 1000) * 5.0 / 1000;
      return {
        model: 'Cache hit',
        cx: 'LOW',
        originalCx: 'LOW',
        rule: classified.rule,
        tok: classified.tok,
        cost: 0,
        base: baseCost,
        pct: 100,
        modal: classified.modal,
        lang: classified.lang,
        noiseType: classified.noiseType || null,
        confidence: 99,
        isCache: true,
        autoLearn: false,
      };
    }

    // AMBIG handling
    let autoLearn = false;
    if (cx === 'AMBIG') {
      // ZH-MINIMAL: 極短模糊句（好了嗎/下一個/快一點）
      // → if already in a conversation, inherit last tier (keep same model, don't disrupt session)
      // → if first message (no context), fall back to MED
      if ((classified.noiseType === 'ZH-MINIMAL' || classified.noiseType === 'FRAGMENT') &&
          conversationContext && conversationContext.lastTier) {
        cx = conversationContext.lastTier;
        // note: NOT pushing to autoLearn — this is expected conversational behavior
      } else {
        // All other AMBIG → push to Auto-Learn, escalate to MED
        cx = 'MED';
        autoLearn = true;
      }
    }

    // Quality tier adjustments
    if (qualityTier === 'high' && cx === 'LOW') cx = 'MED';
    if (qualityTier === 'low'  && cx === 'HIGH') cx = 'MED';

    // Context-aware routing:
    // 1. Strip backreference phrase → re-classify the actual action
    // 2. Apply floor: if backreference present, never go below MED (needs context to answer)
    let contextApplied = false;
    if (detectBackreference(prompt)) {
      // Strip the backreference phrase, isolate the actual action being requested
      const stripped = prompt
        .replace(/把(它|這個|那個|上面的\S+|上面的分析|上述的?\S*)\s*/g, '')
        .replace(/根據(以上|上述|剛才的?)(分析|內容|討論|結果)[\s，,]*/g, '')
        .replace(/(上面的|上述的?|前面的|之前的?)(分析|內容|報告|結果|討論)\s*/g, '')
        .replace(/以上を踏まえて\s*/g, '')
        .trim();

      // Re-classify the action after stripping the backreference phrase
      if (stripped.length > 3 && stripped !== prompt) {
        // Remaining text has substance — re-classify it
        const reClassified = classify(stripped, uc);
        const reCx = reClassified.cx === 'AMBIG' ? 'MED' : reClassified.cx;
        if (reCx !== cx) {
          cx = reCx;
          contextApplied = true;
        }
      } else {
        // Stripped is empty/too short: the whole prompt is a backreference phrase
        // with an embedded action verb (e.g. "把上面的分析翻成英文" → verb=翻)
        // Extract and classify just the action verb + object
        const verbMatch = prompt.match(/(翻成|翻譯成?|改寫|縮短|精簡|整理|擴充|摘要|總結|翻譯|compress|translate|summarize|shorten|rewrite|expand)\s*(.{0,20})$/i);
        if (verbMatch) {
          const actionPrompt = verbMatch[0];
          const reClassified = classify(actionPrompt, uc);
          const reCx = reClassified.cx === 'AMBIG' ? 'MED' : reClassified.cx;
          if (reCx !== cx) {
            cx = reCx;
            contextApplied = true;
          }
        }
      }

      // Floor: any backreference needs prior context to answer → never route to LOW
      if (cx === 'LOW' && conversationContext && conversationContext.lastTier !== 'LOW') {
        cx = 'MED';
        contextApplied = true;
      }
    }

    const model = selectModel(cx, classified.modal, qualityTier);
    const outputTok = Math.floor(Math.random() * 60 + 20);
    const totalTok = classified.tok + outputTok;
    const costPerM = MODEL_COSTS[model] || 0.15;
    const cost = (totalTok / 1000) * costPerM / 1000;
    const base = (totalTok / 1000) * 5.0 / 1000;
    const pct = Math.max(0, Math.round(((base - cost) / base) * 100));

    return {
      model,
      cx,
      originalCx: classified.cx,
      rule: classified.rule + (contextApplied ? ' [CTX-FLOOR]' : ''),
      tok: totalTok,
      cost,
      base,
      pct,
      modal: classified.modal,
      lang: classified.lang,
      noiseType: classified.noiseType || null,
      confidence: classified.confidence,
      isCache: false,
      autoLearn,
      contextApplied,
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════

  /**
   * setConfig(dynamicModels, dynamicTiers)
   *
   * Called once at server startup to inject DB-sourced model configs,
   * replacing the static compile-time defaults above.
   *
   * @param {Object} dynamicModels  - { modelName: costPer1MTokens, … }
   *   Built from llm_providers rows: { [model_name]: cost_per_1m_tokens }
   *
   * @param {Object} dynamicTiers   - { LOW: { default, high_q, low_q }, MED: …, HIGH: …, AMBIG: … }
   *   Built from llm_providers rows grouped by tier_capability.
   *   The server picks the cheapest active model per tier for each quality slot.
   *
   * @example
   *   import { setConfig } from './casca-classifier.js';
   *   // After loading llm_providers from Supabase:
   *   setConfig(
   *     { 'gpt-4o': 5.00, 'gemini-flash': 0.10 },
   *     {
   *       LOW:   { default: 'gemini-flash', high_q: 'gpt-4o-mini', low_q: 'gemini-flash' },
   *       MED:   { default: 'gpt-4o-mini',  high_q: 'gpt-4o-mini', low_q: 'gemini-flash' },
   *       HIGH:  { default: 'gpt-4o',       high_q: 'gpt-4o',      low_q: 'gpt-4o-mini'  },
   *       AMBIG: { default: 'gpt-4o-mini',  high_q: 'gpt-4o',      low_q: 'gpt-4o-mini'  },
   *     }
   *   );
   */
  function setConfig(dynamicModels, dynamicTiers) {
    if (dynamicModels && typeof dynamicModels === 'object' && Object.keys(dynamicModels).length > 0) {
      // Merge: DB values override static defaults, static fallbacks remain for unlisted models
      MODEL_COSTS = { ...MODEL_COSTS, ...dynamicModels };
    }
    if (dynamicTiers && typeof dynamicTiers === 'object' && Object.keys(dynamicTiers).length > 0) {
      // Only override tiers that are fully specified (must have default/high_q/low_q)
      for (const [tier, spec] of Object.entries(dynamicTiers)) {
        if (spec && spec.default) {
          TIER_MODELS[tier] = { ...TIER_MODELS[tier], ...spec };
        }
      }
    }
  }

export {
  VERSION,
  STATS,
  MODEL_COSTS,
  MODAL_MODELS,
  TIER_MODELS,
  setConfig,
  route,
  detectBackreference,
  classify,
  detectLanguage,
};
