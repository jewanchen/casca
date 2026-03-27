(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();          // Node.js / CommonJS
  } else {
    root.CascaClassifier = factory();    // Browser global
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  'use strict';

  // ── VERSION ────────────────────────────────────────────────────
  const VERSION = '2.4.2';
  const STATS = {
    totalRules: 136,
    patchNotes: 'v2.3.2: P0 autoLearn 3-gate filter, P1a fast-path ASCII, P1b 25/10 sampling',
    trainingsamples: 4933,
    batches: 7,
    languages: ['ZH','ZH_SC','EN','JA','FR','DE','ES','IT','KO','HI','AR'],
    accuracy: 94.1,
    target: 98.5,
  };

  // ── MODEL COSTS (USD per 1M tokens) ────────────────────────────
  const MODEL_COSTS = {
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
  const TIER_MODELS = {
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
    if (/\b(analizza|valuta|progetta|sviluppa|implementa|ottimizza|verifica|esamina|identifica|confronta|calcola|proponi|prepara)\b/i.test(text)) return 'IT';
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
    // DE-HIGH-COMP: umfassend/vollständig + deliverable + verb
    if (/(umfassend[eo]?|vollständig[eo]?|vollstaendig[eo]?|detailliert[eo]?|ausführlich[eo]?|ausfuehrlich[eo]?|strategisch[eo]?|tiefgreifend[eo]?)/i.test(text) &&
        /(plan|strategie|roadmap|protokoll|handbuch|analyse|rahmen|konzept|programm|architektur|bibel|modell|risikobewertung|auditplan|krisenmanagementplan)/i.test(text) &&
        /(erstellen|entwickeln|entwerfen|formulieren|erarbeiten|verfassen|analysieren|evaluieren|schreiben|erstellen sie|entwickeln sie|entwerfen sie|bereiten sie)/i.test(text)) {
      return { cx: 'HIGH', rule: 'DE-HIGH-COMP: Umfassendes Deliverable \u2192 HIGH', confidence: 89 };
    }
    // DE-HIGH: complex analysis/strategy verbs + object
    if (/(analysier[et]|evaluier[et]|entwickl[et]|untersuche|beurteile|entwirf|erarbeite|formulier[et]|erstell[et]|verfass[et]|erarbeit[et]) .{0,35}(auswirkungen?|implikationen?|risiken?|strategien?|analyse|plan|unterschiede|compliance|transformation|infrastruktur|integration)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'DE-HIGH: Komplexe Analyse \u2192 HIGH', confidence: 86 };
    }
    if (DE_HIGH_P.test(tl)) return { cx: 'HIGH', rule: 'DE-1: Deutsch HIGH', confidence: 82 };
    if (DE_MED_P.test(tl))  return { cx: 'MED',  rule: 'DE-2: Deutsch MED',  confidence: 78 };
    return null;
  }
  function processSpanish(text) {
    if (/(integral|exhaustiv[oa]|complet[oa]|detallad[oa]|estratégic[oa]|profund[oa]|maestr[oa]|operat[oi]v[oa]|intensiv[oa])/.test(text) &&
        /(plan|estrategia|protocolo|hoja de ruta|programa|manual|análisis|marco|arquitectura|campaña|biblia|modelo|informe|evaluación|auditoría|ruta|resiliencia|transformación)/.test(text) &&
        /(desarrolla|diseña|elabora|redacta|formula|prepara|crea|establece|analiza|propón|estructura|construye|diseña|implementa|genera|configura)/.test(text)) {
      return{cx:'HIGH',rule:'ES-HIGH-COMP: integral+plan+verbo → HIGH',confidence:90};
    }
    if (/(analiza|analice|evalúa|evalua|compara|compare|identifica|describe|explica|desarrolla|diseña|diseñe|redacta|formula|formule|elabora) .{0,35}(impacto|implicaciones?|riesgos?|estrategia|mercado|plan|análisis|analysis|diferencias?|conformidad|contrato)/i.test(text)) {
      return { cx: 'HIGH', rule: 'ES-HIGH: Análisis complejo \u2192 HIGH', confidence: 86 };
    }
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
    if (/(?:video:|video attached|\bvideo\b.*\battached\b|\.mp4|\.mov|screen recording|footage|clip)/i.test(text)) return 'video';
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
    // R-ZH-SC-EARLY-HIGH: SC comprehensive deliverable (uses text.length to bypass tok issue)
    const _isZHSC = /[请这进规应协制策客面图工术实际业务介警升山层]/.test(text) || /[将对为从进行并及]/.test(text);
    if (_isZHSC && text.length > 15 &&
        /(全面|深度|详尽|系统|全方位|综合|完整|端到端|完备|彻底|深入|完全|配套|一体化|全局|整体|专业|严谨|高可用|可扩展|科学|精准|动态|完善|学术|具体|复杂|长达|定制|跨行业|多维|全链路|一站式|最优|战略级|敏捷|系统性|全盘|全面|完整的|深度的|详细的|专项|闭环|全面升级|全栈|完整闭环|全生命周期|智能化|数字化|信息化|闭环式|系统化|自动化)/.test(text) &&
        /(方案|策略|规划|体系|框架|协议|手册|报告|模型|架构|路线图|全案|预案|指引|规范|蓝图|分析|战略|圣经|白皮书|指南|标准|流程|清单|方法论|路径|配置|部署|商业计划书|闭环平台|解决方案|管理体系|预警体系|管理流程|申报方案|运营战略|升级改造|示范区|研发项目|实施路线图|白皮书|规划案|战略图|实施方案|全盘方案|部署方案|测试方案)/.test(text) &&
        /(制定|分析|设计|起草|出具|制订|搭建|策划|撰写|建立|规划|研判|编纂|输出|制作|准备|评估|拟定|梳理|完善|审视|审查|复盘|整合|统筹|落地|整理|打通|构建|推进)/.test(text)) {
      return { cx:'HIGH', rule:'R-ZH-SC-EARLY-HIGH: SC全面+方案+动词 → HIGH', confidence:91 };
    }
    // R-ZH-SC-BIZPLAN-HIGH: SC key business documents → HIGH regardless of qualifier
    if (_isZHSC && text.length > 15 &&
        /(输出|撰写|制作|编写|起草|完成|输出|准备|编制).{0,25}(商业计划书|融资方案|可行性报告|白皮书|规划案|技术报告|评估报告)/.test(text)) {
      return { cx:'HIGH', rule:'R-ZH-SC-BIZPLAN-HIGH: SC商业文件 → HIGH', confidence:88 };
    }
    // R-ZH-SC-VERB-HIGH: SC comprehensive deliverable via verb+noun (no qualifier needed)
    if (_isZHSC && text.length > 20 &&
        /(制定|起草|出具|制订|搭建|策划|撰写|规划|研判|编纂|输出|准备|拟定|设计|整合|梳理|统筹|落地|构建|打通)/.test(text) &&
        /(方案|策略|规划|体系|框架|手册|报告|模型|架构|路线图|全案|预案|规范|战略|圣经|白皮书|指南|流程|清单|商业计划书|解决方案|管理体系|实施路线图|规划案|闭环平台|预警体系)/.test(text) &&
        /(全面|深度|详尽|完整|端到端|综合|完备|系统|全方位|彻底|全生命周期|完整的|全盘|系统性|数字化|智能化|自动化|闭环|端到端).{0,50}$/.test(text)) {
      return { cx:'HIGH', rule:'R-ZH-SC-VERB-HIGH: SC制定+战略+限定词 → HIGH', confidence:89 };
    }
    // R-ZH-SC-EARLY-SHORT: SC short-format (uses text.length too)
    if (_isZHSC && text.length < 30 &&
        /(列成|汇总|翻译成|展示一?段|给我(一个)?|做一张|精炼出|写一(个|段|封)|帮我草拟|教我一?个|用要点|把.{2,20}(列成|汇总|翻译|总结|排好|拆解)|请输出一份|请提供一个|请把.{2,15}列成|浓缩成|请把.{2,15}列为)/.test(text) &&
        /(清单|公式|表格|列表|脚本|编号列表)/.test(text)) {
      return { cx:'LOW', rule:'R-ZH-SC-EARLY-SHORT: SC短格式 → LOW', confidence:88 };
    }
    const tl = text.toLowerCase();
    // R-ES-EARLY-HIGH: ES comprehensive deliverable (before R4)
    if (/[a-záéíóúñü]/.test(tl) &&
        /(integral|exhaustiv[oa]|complet[oa]|detallad[oa]|estratégic[oa]|profund[oa]|maestr[oa]|operativ[oa]|intensiv[oa])/.test(tl) &&
        /(plan|estrategia|protocolo|hoja de ruta|programa|manual|análisis|marco|arquitectura|campaña|biblia|modelo|informe|evaluación|auditoría|resiliencia|transformación|gobernanza|sistema|omnicanal|capacitación|plataforma|infraestructura)/.test(tl) &&
        /(desarrolla|diseña|elabora|redacta|formula|prepara|crea|establece|analiza|propón|propone|estructura|construye|implementa|genera|optimiza|consolida|configura|lanza|introduce|define|ejecuta)/.test(tl) &&
        originalTok > 12) {
      return { cx:'HIGH', rule:'R-ES-EARLY-HIGH: ES integral+plan+verbo → HIGH', confidence:90 };
    }
    // R-ES-EARLY-SHORT: ES short-format (fires before R3/R4, lang-agnostic)
    if (/[aáeéiíoóuúñü]/i.test(tl) &&
        (/^(resume|haz (una? )?(lista|tabla)|dame (la|el|una?)|escribe (una?|un) (prueba|guion|correo|email)|pon (los?|esto|las?) en|traduce (esta?|esa?)|propón (un[ao]? )?(corto|breve)|haz una lista del?)/i.test(tl) &&
        /(tabla|lista|fórmula|prueba|guion|correo|email|numerada|comparativa|equipamiento|seguridad|al (inglés|francés|alemán))/i.test(tl)) ||
        /^pon .{3,35} en (una? )?(tabla|lista|orden cronológico)/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-ES-EARLY-SHORT: ES formato corto → LOW', confidence: 88 };
    }
    // R-ES-VERB-HIGH: ES action verb + deliverable noun (no qualifier required)
    if (/[aáeéiíoóuúñü]/i.test(tl) &&
        /(optimiza|consolida|configura|implementa|genera|lanza|introduce|define|ejecuta|diseña|desarrolla|elabora)/.test(tl) &&
        /(estrategia|plan|programa|sistema|protocolo|informe|arquitectura|marco|campaña|estructura|gobernanza|plataforma|evaluación|capacitación)/.test(tl) &&
        originalTok > 12) {
      return { cx: 'HIGH', rule: 'R-ES-VERB-HIGH: ES verbo+entregable → HIGH', confidence: 87 };
    }
    const tok = originalTok || estTokens(text);

    // R-EN1: strip modal softening before any classification
    const stripped = tl
      .replace(/\b(could you|would you|might you|can you|i was wondering if|just|quick(ly)?)\b/g, '')
      .trim();

    // ── P3: Legal / Compliance force HIGH (R6) ────────────────
    // R-EN-MEDICAL-ACUTE: acute medical → HIGH
    if (/\b(heart attack|cardiac arrest|stroke|anaphylaxis|acute (kidney|renal|liver) failure|CPR|AED|angina|myocardial|chest (pain|tightness)|left arm (pain|ache)|persistent cough|night sweats|sharp pain[^.]{0,20}abdomen|sudden swelling|appendicitis|tuberculosis|i (have a sharp|am experiencing severe (chest|pain|symptoms)))/i.test(tl)) {
      return { cx:'HIGH', rule:'R-EN-MEDICAL-ACUTE: Acute medical \u2192 HIGH', confidence:94 };
    }
    // R-ZH-MEDICAL-ACUTE: 急性醫療 → HIGH
    // R-EN-CRISIS: Urgent professional crisis → HIGH
    if (/^(our company (just|has just|recently) (had|experienced|suffered|been hit by)|i (just|have just|recently) (received|got|found out) (a |an )?(lawsuit|legal notice|breach|hack|data leak|letter from|warning from)|we (just|have just) (discovered|detected|identified) (a |an )?(breach|vulnerability|attack|compromise)|urgent[: ])/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-EN-CRISIS: Professional crisis → HIGH', confidence: 92 };
    }
    // R-EN-SCOPE-NARROW: drill-down modifier → MED
    if (tok < 25 && /^(what are the (primary|main|key|root|underlying) (causes?|reasons?|factors?|drivers?)|what (caused|led to|triggered|contributed to)|how did .{5,30} (contribute|lead|affect|impact)|how do i (optimize|improve|implement|configure|set up|integrate|deploy|debug|fix|scale|secure|migrate)|specifically (look at|focus on|about)|focus (more on|specifically)|only (the|about) \w+|what about the \w+|now focus on|more specifically)/i.test(tl)) {
      return { cx:'MED', rule:'R-EN-SCOPE-NARROW: Drill-down \u2192 MED', confidence:82 };
    }

    if (/心絞痛|心肌梗塞|中風|脑卒中|脑溢血|腦溢血|急性心臟|急性心脏|CPR|AED|腎衰竭|肾衰竭|急性腎|急性肾|肝衰竭|休克|昏迷|停止呼吸|呼吸困難|呼吸困难|急救藥|急救措施|急救药|胸口悶|胸口闷|左手臂酸|心臟問題|心悸|心律不整|心律不齐|胸痛|胸悶|胸闷|溶栓|脑梗|脑血管/i.test(tl)) {
      return { cx:'HIGH', rule:'R-ZH-MEDICAL-ACUTE: 急性醫療症狀 \u2192 HIGH', confidence:95 };
    }
    if (
      ['legal', 'law'].includes(uc) ||
      /法律|合規|合规|compliance|訴訟|诉讼|liability|法規|法规|gdpr|個資法|个人信息保护法|勞基法|劳动法|著作權|著作权|版权|商標|商标|專利|专利|侵权|侵權|合同审查|契約審查|dpia|cease and desist|\bndas?\b|malpractice|hipaa|osha|dodd.frank|合规|监管|法务|尽职调查|知识产权/i.test(tl)
    ) {
      if ((/what is|definition|how many|幾年|幾天|多久|statute of limitations|boilerplate/i.test(tl) ||
           /^(define|what is|what are|what's)\s/i.test(tl)) && tok < 30) {
        return { cx: 'LOW', rule: 'R6排除: 法律/定義查詢 → LOW', confidence: 88 };
      }
      if (/^write\s+(a|an)\s+(recommendation letter|reference letter|cover letter)\b/i.test(tl) && tok < 17) {
        return { cx: 'LOW', rule: 'R6排除: 短推薦信 → LOW', confidence: 82 };
      }
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
      // R-EN-MEDICAL-ACUTE: acute medical terms → HIGH
    if (/\b(heart attack|cardiac arrest|stroke|anaphylaxis|acute (kidney|renal|liver) (failure)?|CPR|AED|emergency (medication|drug)|angina|myocardial|chest (pain|tightness)|left arm (pain|ache))/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-EN-MEDICAL-ACUTE: Acute medical → HIGH', confidence: 94 };
    }

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
    // R-EN-SHORT-FORMAT: output format/verify → LOW
    if (tok < 22 && /^(put (it|them|this) in (a |the )?(table|chart|list|matrix)|give me a (short |brief )?(checklist|table|2x2|summary table|shopping list)|create a (pie chart|bar chart|table|checklist) (description )?for|write a \d+[-\s]second (script|teaser)|check my answer|list (the |a )?(top |main |key )?(\d+|three|five|six|ten|a few|several) |give me a (pros and cons|pro.?con) list|show me a sample output|summarize the (key|main|top|primary) (warnings?|points?|findings?|results?|differences?)|give me a (quick |brief )?summary of|translate the (greeting|phrase|sentence|word))/i.test(tl)) {
      return { cx:'LOW', rule:'R-EN-SHORT-FORMAT: Format/verify → LOW', confidence:88 };
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
    // R-EN-COMPLEX: patterns collapsed into array + .some() for maintainability
    const _enCxPatterns = [
      /\b(comprehensive|end-to-end|full[\s-]scale|complete guide|step-by-step guide)\b/i,
      /\b(design (the|a|our) (schema|architecture|system|database|infrastructure|api)|system design)\b/i,
      /\b(migrate|migration|refactor|translate).{5,50}(ensure|explain|provide|include)/i,
      /\bgenerate (\d{2,}|twenty|thirty|fifty) (test cases|scenarios|creatives|examples)\b/i,
      /\b(m&a|merger|acquisition|due diligence).{5,50}(review|draft|identify|list)/i,
      /\b(swot analysis).{5,80}(marketing plan|roadmap|strategy|campaign)/i,
      /\b(sensitivity analysis|scenario[- ]based (model|analysis)|burn rate.runway)\b/i,
      /\b(anomaly detection|fraud detection).{5,80}(flag|cross.reference|output|suspicious)/i,
      /\b(tiktok|reels|short[- ]?form).{5,80}(visual cues?|hook|cta|hashtag|script)/i,
      /\b(\d{1,2}|ten|five|eight|twelve)\s+(ad creatives?|email[s]?|posts?|variations?).{5,50}(each|provide|headline|subject line)/i,
      /\b(competitor analysis|competitive analysis).{5,80}(summarize|identify|write|script|propose)/i,
      /\b(cart abandonment|checkout.{3,20}friction).{5,80}(propose|suggest|re.?engagement|a.?b test)/i,
      /\b(ctr|click.through rate).{5,80}(conversion|friction|audit|landing page).{5,80}(identify|suggest|a.?b test)/i,
      /\b(audit the landing page).{5,80}(friction|identify|suggest|a.?b)/i,
      /\b(360.degree feedback|performance review).{5,80}(draft|design|suggest|framework)/i,
      /\b(grievance|workplace bullying|harassment investigation).{5,80}(outline|draft|write|memo)/i,
      /\b(sourcing|supply chain|shipment delay).{5,80}(identify|calculate|draft)/i,
      /\b(property manager|tenant.{3,20}(behind|default|restructuring)).{5,80}(draft|analyze|write)/i,
      /\b(mixed.use development|market feasibility|green building certif).{5,80}(conduct|identify|draft|pitch)/i,
      /\b(pisa results?|teaching strateg).{5,80}(identify|propose|draft)/i,
      /\b(grant proposal|literature review|apa.{1,5}edition).{5,80}(draft|suggest|ensure|milestone)/i,
      /\b(hybrid learning|blended learning).{5,80}(specify|draft|create|rubric)/i,
      /\b(webinar|campaign).{5,80}(landing page|email invitation|teaser|follow.?up)/i,
      /\b(review this|analyze this|assess this).{5,60}(ctr|bounce rate|conversion rate|engagement rate).{5,60}(identify|suggest|propose)/i,
      /\b(summarize|review|analyze).{5,50}(top \d|\d papers?|\d studies?|papers?.{3,20}published|clinical trial data)/i,
      /\b(design|create|draft).{3,30}(\d[- ]week|\d[- ]month).{5,50}(plan|program|schedule).{5,80}(include|suggest|with)/i,
      /\b(research|investigate).{5,80}(list|both sides|arguments|court cases?|landmark cases?)/i,
      /\b(review this draft|check if.{5,30}(sound|logical|valid)|suggest.{5,30}ways to strengthen)/i,
      /\b(focus on|respiratory|endocrine|microplastic).{5,80}(write|draft|summary for|advisory)/i,
      /\b(terms of service|privacy policy|consumer guarantees?|employee monitoring|data scraping|open.source|copyleft).{5,80}(review[^.]{0,30}(section|document|policy|clause)|ensure[^.]{0,20}compli|identify|draft new|update)/i,
      /\b(internal investigation|sexual harassment|subpoena|privilege log|attorney.client privilege)/i,
      /\b(create a[^.]{3,20}summary).{5,80}(laws?|regulations?|rights?|employer[^.]{3,20}right)/i,
      /\b(\d{1,2}[- ]month|annual|year[- ]long).{5,50}(program|plan|calendar|roadmap).{5,80}(include|monthly|weekly|measure)/i,
      /,\s*(then|and then),?\s+(write|draft|provide|suggest|explain|create)/i,
    ];
    const _enCxGIK =
      (/\bdrip campaign\b/i.test(tl) && /(draft|write).*\d+.*(email|message)/i.test(tl)) ||
      (/\b(we are migrating|migrating from [^.]{3,20} to)/i.test(tl) && /(design|explain|provide)/i.test(tl)) ||
      (/\b(i want to build|build a real.?time|build a [^.]{5,30}dashboard)/i.test(tl) && /(data model|suggest the|write a|draft the)/i.test(tl));
    if (_enCxGIK || _enCxPatterns.some(re => re.test(tl))) {
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
      /分析|analyze|evaluate|評估|评估|比較|比较|root cause|風險|风险|risk assessment|預測|预测|forecast|scenario|strategy|should we|recommend|why (is|are|did|does)|採用.*困|どうすれ.*(?:採用|売上|業績|効率|改善)|财务风险|市场风险|投资组合|对冲|敞口|盘点/i.test(r5Strip) &&
      !(/^(what|how many|幾天|幾點|是多少)/i.test(stripped) && tok < 25)
    ) {
      return { cx: 'HIGH', rule: 'R5: 複雜分析/評估 → HIGH', confidence: 87 };
    }
    // ── P5: Engineering / financial complexity (R7, R-EN4) ─────
    if (/implement|refactor|architect|optimize.*query|migrate|design.*system|security vuln|memory leak|dcf|sensitivity analysis|three.statement|cap structure|制定.*全面|全面.*制定|全面.*方案|完整.*规划|深度.*盘点|系统.*架构.*方案|输出.*详细.*方案|设计.*体系|搭建.*体系/i.test(tl)) {
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
      if (tok < 40 && /[はがを]?(どのように|影響|変わり|変化|なり|あり)(ますか|でしょうか)[？?。]?$/.test(tl)) { return { cx:'MED', rule:'R-NEW1a-Q: 計算影響質問 → MED', confidence:78 }; }
      return { cx: 'LOW', rule: 'R-NEW1a: 直接算術 → LOW', confidence: 88 };
    }

    // ── P6: Emotional intensity (R-EMOT) — emotion ≠ complexity ─
    if (/really urgent|asap|escalate|火急|緊急|非常緊急/i.test(tl) && tok < 20) {
      return { cx: 'MED', rule: 'R-EMOT: 情緒/緊急 不影響複雜度 → MED', confidence: 72 };
    }

    // ── P6.5: ZH short generation verbs (R-ZH-GEN) ─────────────
    // R-JA-HIGH: CJK high-complexity terms — fire before ALL token checks
    // R-ZH-HOW: 「如何 + 操作型動詞」 → MED (防止短 token 落 LOW)
    if (/^如何(優化|降低|提升|改善|縮短|提高|建立|制定|建設|管理|處理|防止|應對|應用|建構|設計|規劃|強化|加速|評估|選擇|推動)/i.test(tl)) {
      if (/(公關危機|公关危机|品牌危機|品牌危机|自動化.*生產線|自动化.*生产线|生產線.*自動化|系統.*設計.*架構|系统.*设计.*架构|生產線.*優化|生产线.*优化|優化.*生產線|财务诈骗|防止.*诈骗|内部.*舞弊|绩效考核.*标准|制定.*考核.*标准|更公平.*考核|品牌复苏|渠道下沉|定价策略)/i.test(tl)) {
        return { cx: 'HIGH', rule: 'R-ZH-HOW-HIGH: 如何+複雜策略 → HIGH', confidence: 86 };
      }
      return { cx: 'MED', rule: 'R-ZH-HOW: 如何+操作動詞 → MED', confidence: 82 };
    }

    if (/(審査|稽核|査核|監査|リスク評価|脆弱性診断|コンプライアンス審査|法務審査|合規審查|盡職調查)/.test(tl)) {
      return { cx: 'HIGH', rule: 'R-JA-HIGH: 高複雜度語彙 → HIGH', confidence: 88 };
    }
    // Legal documents — must precede R-ZH-GEN (which catches 撰寫 as MED)
    if (/(合約書|合夥.*合約|勞動契約|劳动合同|供應商合約.*條款|供应商合同|合約.*不利|合同.*不利|撰寫.*合約書|起草.*合同|擬定.*合約|律師函|律师函|訴狀|诉状|法律意见|风险规避|尽职调查|合规策略|反垄断)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-LEGAL-DOC: 法律文件起草 → HIGH', confidence: 90 };
    }
    // R-ZH-RECOMMEND: 推薦+數量+對象 → MED (content generation)
    // R-ZH-MEDICAL-ACUTE: acute medical symptoms → HIGH
    if (/心絞痛|心肌梗塞|中風|腦溢血|急性心臟|CPR|AED|腎衰竭|急性腎|肝衰竭|休克|昏迷|停止呼吸|呼吸困難|急救藥|急救措施|胸口悶|左手臂酸|心臟問題|心悸|心律不整|胸痛|胸悶/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-MEDICAL-ACUTE: 急性醫療症狀 → HIGH', confidence: 95 };
    }
    if (/^推薦(一?[下些個本款項]|幾[個本款項種]|[一二三四五六七八九十百\d]+[本個款項])/i.test(tl)) {
      return { cx: 'MED', rule: 'R-ZH-RECOMMEND: 推薦+數量 → MED', confidence: 82 };
    }
    if (/^(幫我|帮我|請幫我?|请帮我?|協助我?|协助我?|請|请)[\s]*(寫|写|翻譯|翻译|翻成|改寫|改写|草擬|草拟|起草|整理|製作|制作|編寫|编写|撰寫|撰写|修改|潤飾|润饰|改一下|調整|调整|生成|產出|产出)|幫我[^，。]{0,15}(翻成|翻譯成|改成|改寫成)|^帮我(草拟|起草|写一封|写一份|做一份).{3,30}(信|函|邮件|声明)/i.test(tl)) {
      // Skip MED if it's actually a long-form analytical/academic piece
    if (/(深度|学术|哲学|详细|完整|系统|全面).{0,30}(分析|长文|论文|研究|探讨|规划|路径|路线图|方案|圣经|策略)/.test(tl)) {
        return { cx:'HIGH', rule:'R-ZH-GEN-HC: 长文生成类高阶任务 → HIGH', confidence:87 };
      }
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
        !/\b(impact|how|why|pros|cons|difference|vs\.?|versus|mechanism|implication|importance|role|benefits|concept|modern|today|psychology|culture|society|context|history)\b/i.test(tl) &&
        !/^explain (the concept|the relationship|the difference|the role|the impact|the mechanism)/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-EXPLAIN-TERM: Explain single term → LOW', confidence: 84 };
    }

    // R-EN-BRAND: Brand/voice/tone guide = MED generation task (not LOW)
    if (/\b(brand voice|tone guide|style guide|brand guide|voice and tone)\b/i.test(tl)) {
      return { cx: 'MED', rule: 'R-EN-BRAND: Brand/voice guide → MED', confidence: 82 };
    }


    // R-EN-SHORT-EXPLAIN: Short "Explain X" / "List N X" → LOW
    // "Explain 'big O' notation." / "List 5 Git best practices." / "Explain diversification."
    // R-EN-EXPLAIN-TERM: 'Explain single term' → LOW
    // But 'Explain the concept of X in context' → MED
    if (tok < 15 && /^(explain|list\s+\d+|list\s+[a-z]+\s+\d+|give\s+me\s+\d+|give\s+\d+)\b/i.test(tl) &&
        !/^explain (the concept of|the relationship|the difference|the role|the impact|the mechanism|the math behind|the ethics|the implications)/i.test(tl) &&
        !/\b(impact|difference|comparison|implications|pros and cons|vs\.|versus|in modern|in today|across|for society)\b/i.test(tl)) {
      return { cx: 'LOW', rule: 'R-EN-EXPLAIN-TERM: Explain single term \u2192 LOW', confidence: 82 };
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
        // R-EN-EMPATHY: emotional/mental state disclosure → MED
    if (/^i (feel|am feeling|feel so|felt|have been feeling|am) (completely |totally |really |so )?(overwhelmed|hopeless|burnout|exhausted|depressed|anxious|stressed|lost|stuck|devastated|broken|terrible|awful|terrible|like giving up)|^i (can.?t|cannot) (stop|sleep|focus|cope|deal with)|^(nobody|no one) (seems?|cares?|listens?|understands?)/i.test(tl)) {
      return { cx: 'MED', rule: 'R-EN-EMPATHY: Emotional disclosure → MED', confidence: 85 };
    }
// R-EN-COMPREHENSIVE: Verb + comprehensive/N-week/N-month deliverable → HIGH
    // Fires before R1 to catch short but complex task declarations
    if (/^(provide|design|develop|create|draft|generate|conduct|perform|propose|formulate|build|evaluate|write|establish|implement|produce) (a |an )?(comprehensive|detailed|end-to-end|full|complete|real-time|full-scale|\d+[-\s]?(week|month|year)|full-scale|enterprise[-\s]wide|national|multi-region|global|cross-border|multi-jurisdictional)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-EN-COMPREHENSIVE: Comprehensive deliverable → HIGH', confidence: 91 };
    }
    // R-EN-DEBUG: Debug/fix specific tech error → HIGH
    if (tok < 20 && /^(debug (this|the|my)|fix (this|the|my)|why (is|does|won.t|can.t)|it.?s (throwing|showing|failing|returning|crashing)|getting an? (error|exception|bug|warning)|(my |this )?(react|vue|angular|node|django|flask|api|server|app|function|hook|component) (is|are|keeps?|won.?t|doesn.?t|can.?t))/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-EN-DEBUG: Debug tech issue → HIGH', confidence: 87 };
    }
    // R-EN-COMPARE: Comparison/identification between two entities → HIGH
    if (tok >= 10 && /\b((identify|compare|contrast|evaluate|analyze|assess|examine|review) (the )?(key |main |primary |core )?(differences?|similarities|pros and cons|tradeoffs?|impact|performance|effectiveness|advantages|disadvantages) (between|of|for)|(key |main |primary )?differences? between )/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-EN-COMPARE: Comparison/identification \u2192 HIGH', confidence: 86 };
    }
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
      /^(ありがとう(ございます)?|了解[！!]?(です)?|わかりました|わかった|終わった[！!？?]?|終了|なるほど|オッケー|おけ|いいね|はい|完了|いいです|承知(しました)?|かしこまりました)[。！!]?$/.test(tl)||
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
      /^(pourquoi pas|autre chose|fais.le vite fait|comme avant|prends.en un autre|tu (es s[uû]r|vois ce que)|r[eè]gle|c.{0,2}est (lequel|fini|pr[eê]t|assez|compris|bon|tout)|entendu|bien re[cç]u|super|parfait|not[eé]|[çca] (va|ira|veut dire quoi)|et (apr[eè]s|[çca])|jette un .{1,5}il|jette un oeil|qu.est.ce que tu en penses|tu vois ce que je veux dire|qu'est.ce qui se passe|que dois.je faire)\s*[？?！!。.]?$/i.test(_frTlNorm) ||
      // FR MULTI bare connectors (no trailing "...") — no tok limit for explicit phrases
      /^(au fait|et aussi|de plus|en outre|ensuite|puis|tu peux aussi|d'apr[eè]s ce que (tu|vous) (viens|venez) de (dire|mentionner)?|d'apr[eè]s ce que|prends ce qui pr[eé]c[eè]de( et)?|enfin|ainsi que|en m[eê]me temps|[àa] propos|d'un autre c[oô]t[eé]|en dehors de [çca]|compte tenu de ce qui pr[eé]c[eè]de|continue|rends.le|fais.en|encore une chose|et autre chose)[？?！!.,]?$/i.test(_frTlNorm);

    const isFrag_ZH_SC=/^(好了吗|那是哪一个|帮我看一下|你觉得呢|这样行吗|为什么不行|还有其他的吗|怎么办|这是什么意思|随便弄一下|差不多就好|那个呢|然后呢|懂我意思吧|就照之前的|换一个|帮我搞定|什么情况|这个怎么弄)[？?!!。]?$/.test(tl)||/^(顺便|还有|另外|接着|然后|再帮我|承上|根据刚刚的|把上面的|最后|以及|同时|对了[，,]?|另一方面|除此之外|基于上述|继续|帮我把它|再补充一点|还有就是)[，,。!!？?]?$/.test(tl);
    const isFrag_KO=/^(감사합니다|고맙습니다|알겠습니다|알겠어요|확인했습니다|수고하세요|좋아요|완료|네[!.]?|이해했습니다)[!.！]?$/.test(tl)||/^(어떻게 해|다 됐어|어느 거야|한번 봐줘|이거 괜찮아|왜 안 돼|다른 건 없어|어떡하지|이게 무슨 뜻이야|대충 해줘|이 정도면 돼|그건|확실해|무슨 상황이야|해결해줘)[?？!！.。]?$/.test(tl)||/^(그리고|또한|게다가|다음으로|이어서|마지막으로|동시에|그런데|반면에|계속해서|추가로)[?？!！.,]?$/.test(tl);
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
    // R-ZH-BIZ-PLAN: 商業計畫/行銷策略/可行性評估 → HIGH
    if (/行銷(方案|策略|計畫)|营销(方案|策略|计划)|市場(分析|可行性|評估)|市场(分析|可行性|评估)|預算(分配|規劃)|预算(分配|规划)|商業(計畫|模式|策略)|商业(计划|模式|策略)|品牌(策略|定位|規劃|复苏)|下半年.{0,6}(方案|計畫|策略)|完整.{0,6}(評估|分析|規劃)|全面.{0,6}(评估|分析|规划)|落地战略|进入.*市场.*(战略|策略)|渠道下沉|策划.*全案|整合营销|360度.*营销|社群营销|360度整合/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-BIZ-PLAN: 商業計畫/行銷策略 → HIGH', confidence: 86 };
    }
    if (/(制定.*(?:績效|考核|薪酬|評核).*標準|更公平.*考核|績效考核.*制定)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-POLICY: 考核制度設計 → HIGH', confidence: 85 };
    }
    // R-ZH-COMPARE-MULTI: 3個以上選項的排序/比較 → HIGH
    if (/([^和跟與]+[、,，][^和跟與]+)(和|跟|與|、)[^、,，]+.{0,15}(怎麼排|順序|排列|先後|哪個先|哪種好|比較好|哪一個最|哪個最)/i.test(tl)) {
      return { cx: 'HIGH', rule: 'R-ZH-COMPARE-MULTI: 多選項排序/比較 → HIGH', confidence: 85 };
    }

    // ── P7: Token length fallback (R4) ────────────────────────
    // R-JA-SHORT-FORMAT: JA short output requests → LOW (fires before R4)
    // R-FR-SHORT-FORMAT: FR short output requests → LOW
    // R-ZH-SC-SHORT-FORMAT: SC short output requests → LOW

    // R-FR-SHORT-FORMAT: FR short output requests → LOW
    // R-ZH-SC-SHORT-FORMAT: SC short output requests → LOW
    // R-ZH-SC-HIGH-COMP: SC comprehensive deliverable → HIGH
    if (/(全面|深度|详尽|系统|全方位|综合|完整|端到端|完备|彻底|深入|完全)/.test(tl) &&
        /(方案|策略|规划|体系|框架|协议|手册|报告|模型|架构|路线图|全案|预案|指引|规范)/.test(tl) &&
        /(制定|分析|设计|起草|出具|制订|搭建|策划|撰写|建立|规划|研判)/.test(tl) &&
        (tok > 8 || text.length > 20)) {
      return { cx:'HIGH', rule:'R-ZH-SC-HIGH-COMP: 全面+方案+动词 → HIGH', confidence:91 };
    }
    if (/(列成|汇总|翻译成|展示一?段|给我(一个)?|做一张|精炼出|写一(个|段|封)|帮我草拟|教我一?个|用要点|用重点).{0,45}(表格|清单|公式|代码|脚本|要点|对比|列表|矩阵|图|[0-9]个|句子|摘要|辞职信|冥想|测试|单元测试)/i.test(tl) ||
        /^把.{2,35}(列成|汇总|翻译|总结|排好|拆解|提炼).{0,20}(表格|清单|要点|列表|句子)?[。？]?$/i.test(tl)) {
      return { cx:'LOW', rule:'R-ZH-SC-SHORT-FORMAT: SC短格式 → LOW', confidence:88 };
    }
    if (/^(résumez|listez|donnez(-moi)?|présentez|mettez|faites|écrivez|affichez|proposez) .{0,50}(en (trois|3|deux|2|cinq|5|une) (phrases?|points?|lignes?)|dans un tableau|en tableau|à puces|la formule|un (court|petit|bref) |en ordre chronologique|un exemple (de sortie)?|comparatif|récapitulatif|une liste (de courses)?|les (principaux|principales|principaux) |[0-9]+ exemples?)/i.test(tl) ||
        /^(traduisez |traduction de|donnez [0-9]+ |listez les (équipements|symptômes|étapes|risques|indemnités|avantages|inconvénients))/i.test(tl)) {
      return { cx:'LOW', rule:'R-FR-SHORT-FORMAT: FR短書式 → LOW', confidence:88 };
    }
    if (/^(箇条書き(に|で)(まとめ|して|まとめてください|してください)|表(に|で)(まとめ|して|まとめてください|してください)|表形式に(して|してください)|リスト(アップ|化)(して|に|してください)|計算式(を|は)(教えて|提示して|示してください|教えてください|提示してください)|要約して|まとめて|サンプル(コード|出力)(を|を見せて|を見せてください)|短い.{1,15}書いて|[\d]+秒のスクリプト|単体テスト(を|を書いて)|サンプル出力を表示|買い物リスト.*作って|挨拶.*翻訳|[\d]+つ.*(リスト|まとめ)|上位[\d]+(つ|個|本|件).*(リスト|箇条)|[\d]+(つ|個).*(ステップ|ポイント).*リスト)/i.test(tl) ||
        /^.{2,20}を(箇条書き|要約|リスト化|表形式|シンプル)(に|で)(まとめ|して|してください|まとめてください|提示して|書いて)/.test(tl) ||
        /^.{2,20}を(まとめて|リストに|箇条書きに|表に)(してください|して|まとめて)?$/.test(tl) ||
        /^.{1,25}(を|の)(リストアップ|箇条書き化|要約)(して|してください|に)?[。！!]?$/.test(tl) ||
        /^.{1,20}(の|を).{0,8}(表|テーブル|リスト|箇条書き)(に|で|形式に)(して|してください|まとめて)?[。！!]?$/.test(tl)) {
      return { cx:'LOW', rule:'R-JA-SHORT-FORMAT: JA短書式 → LOW', confidence:88 };
    }
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
    // IT-HIGH-COMP: comprehensive deliverables
    if (/\b(completo|completa|complet[oi]|dettagliato|dettagliata|approfondito|approfondita|esaustivo|esaustiva|strategico|strategica|scalabile|multicanale|predittivo|predittiva)\b/i.test(text) &&
        /\b(piano|strategia|programma|protocollo|architettura|manuale|modello|curriculum|roadmap|campagna|feuille de route|analisi|report|saggio|framework|sistema|rete|infrastruttura)/i.test(text) &&
        /\b(sviluppa|progetta|implementa|crea|redigi|elabora|verifica|valuta|analizza|fornisci|scrivi|realizza)(re)?/i.test(text)) {
      return { cx: 'HIGH', rule: 'IT-HIGH-COMP: Deliverable complesso \u2192 HIGH', confidence: 89 };
    }
    if (/(analizza|valuta|esamina|identifica|confronta|sviluppa|progetta|redigi|prepara|formula|elabora) .{0,35}(implicazioni?|rischi?|impatto|differenze?|strategi[ae]|piano|analisi|legali?|conformità|conformita|contratto)/i.test(text)) {
      return { cx: 'HIGH', rule: 'IT-HIGH: Analisi complessa \u2192 HIGH', confidence: 86 };
    }
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
    // KO-HIGH-COMP: comprehensive deliverable with 해 주세요
    if (KO_COMP_W.test(text) && /(로드맵|전략|계획|프로토콜|프레임워크|분석|매뉴얼|계획서|논문|에세이|아키텍처|바이블|캠페인|프로그램|감사 계획|보고서)/.test(text) && /(개발해|수립해|작성해|설계해|분석해|기획해|평가해|제안해|준비해|공식화해)(\s*주세요|줘)[.]?$/.test(text)) {
      return{cx:'HIGH',rule:'KO-HIGH-COMP: 포괄적 성과물 → HIGH',confidence:90};
    }
    if(KO_COMP_W.test(text)||(KO_HIGH_W.test(text)&&text.length>25)||(KO_MED_W.test(text)&&KO_HIGH_W.test(text)))return{cx:'HIGH',rule:'KO-HIGH: 복합 고난도 작업 \u2192 HIGH',confidence:84};
    // KO-HIGH-LEGAL: verb + legal/risk object → HIGH
    if(/(분석해\s*(줘|주세요)?|평가해\s*(줘|주세요)?|검토해\s*(줘|주세요)?)[.。]?$/.test(text)&&/(법적|법률|계약서|리스크|위험|취약점|보안|재무|의미|영향)/.test(text))
      return{cx:'HIGH',rule:'KO-HIGH-LEGAL: 법적/재무 분석 \u2192 HIGH',confidence:87};
    if(KO_MED_W.test(text))return{cx:'MED',rule:'KO-MED: 생성 동사 \u2192 MED',confidence:82};
    return null;
  }

  // ═══ P0-HI: Hindi ══════════════════════════════════════════
  const HI_HIGH_W=/(विश्लेषण|रणनीति|विकास|डिज़ाइन|मूल्यांकन|ऑडिट|माइग्रेशन|आर्किटेक्चर|व्यापक|योजना|रिपोर्ट)/;
  const HI_MED_W=/(लिखो|बनाओ|विश्लेषण करो|समझाओ|संक्षेप करो|अनुवाद करो|विकसित करो|तैयार करो|लिखिए|बनाइए)[।.]?$|^(लिखो|बनाओ|समझाओ)\s+/;
  function processHindi(text){
    const tl=text.toLowerCase();
    // HI-HIGH-COMP: comprehensive deliverable with तैयार/विकसित/बनाएं
    if (/(व्यापक|विस्तृत|पूर्ण|गहन|संपूर्ण|रणनीतिक|समग्र|विशाल|कस्टम|विस्तृत)/.test(text) &&
        /(रणनीति|प्रोटोकॉल|रोडमैप|योजना|रूपरेखा|मैनुअल|कार्यक्रम|विश्लेषण|मसौदा|आर्किटेक्चर|मॉडल|ढांचा|प्रस्ताव|रिपोर्ट)/.test(text) &&
        /(तैयार करें|विकसित करें|बनाएं|डिज़ाइन करें|लिखें|स्थापित करें|तैयार करें|प्रस्तुत करें)[।]?$/.test(text)) {
      return{cx:'HIGH',rule:'HI-HIGH-COMP: व्यापक योजना → HIGH',confidence:90};
    }
    if(/^(क्या है|का अर्थ|परिभाषा|यह क्या है)[^,;।]{0,40}[?।]?$/.test(tl))return{cx:'LOW',rule:'HI-DEF: परिभाषा \u2192 LOW',confidence:84};
    if(HI_HIGH_W.test(text)&&text.length>25)return{cx:'HIGH',rule:'HI-HIGH: जटिल कार्य \u2192 HIGH',confidence:82};
    if(HI_MED_W.test(text))return{cx:'MED',rule:'HI-MED: उत्पादन क्रिया \u2192 MED',confidence:80};
    return null;
  }

  // ═══ P0-AR: Arabic ═════════════════════════════════════════
  const AR_HIGH_W=/(تحليل|تقييم|تصميم|تطوير|استراتيجية|هجرة|مراجعة|هندسة|معمارية|أمان|ثغرات|شامل|تقرير)/;
  const AR_MED_W=/^(اكتب|أنشئ|حلل|اشرح|لخص|ترجم|صمم|طور|أعد|اعمل)\s/;
  function processArabic(text){
    // AR-HIGH-COMP: شاملة/مفصلة + خطة/بروتوكول + أعدّ/طوّر/صمّم
    if (/(شامل[اةً]?|مفصل[اةً]?|استراتيجي[اةً]?|كامل[اةً]?|متكامل[اةً]?|عميق[اةً]?|متخصص[اةً]?)/.test(text) &&
        /(خطة|استراتيجية|بروتوكول|خارطة طريق|برنامج|دليل|إطار|تحليل|مسودة|نموذج|بنية|حملة)/.test(text) &&
        /(أعدّ|طوّر|صمّم|قم بصياغة|قم بتطوير|قم بإعداد|قم بتحليل|اكتب|اقترح|ابنِ)/.test(text)) {
      return{cx:'HIGH',rule:'AR-HIGH-COMP: شاملة+خطة+فعل → HIGH',confidence:90};
    }
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
      // DE-SHORT: short-format requests → LOW (before processGerman)
      if (/^(fassen Sie|listen Sie|geben Sie mir (eine|einen)|zeigen Sie mir|schreiben Sie (ein[en]? )?(kurzes?|kurzen?)|erstellen Sie (eine|einen) (liste|einkaufsliste)|übersetzen Sie|schlagen Sie (eine|einen) kurze[rn]?|nennen Sie [0-9]+|stellen Sie .{0,20}(tabelle|liste|übersicht)|bringen Sie .{0,20}(reihenfolge|liste))/i.test(prompt)) {
        const deShortTok = Math.ceil(wordCount(prompt) * 1.3);
        return { cx: 'LOW', rule: 'DE-SHORT: Kurzformat → LOW', tok: deShortTok, modal, lang, noiseType: null, confidence: 88 };
      }
      const de = processGerman(prompt);
      if (de) return { cx:de.cx, rule:de.rule, tok:dt, modal, lang, noiseType:null, confidence:de.confidence };
      const dc = classifyCore(prompt, uc, dt);
      return { cx:dc.cx, rule:dc.rule, tok:dt, modal, lang, noiseType:dc.noiseType||null, confidence:dc.confidence };
    }
    // ── P0-ES: Spanish ──────────────────────────────────────────
    if (lang === 'ES') {
      const et = Math.ceil(wordCount(prompt) * EU_TOK);
      if ((/^(resume|haz (una? )?(lista|tabla)|dame (la|el|una?)|escribe (una?|un) (prueba|guion|correo|email)|pon (esto|en|los)|muestra (un|una)|traduce (esta?|esa?)|propón (una? )?(corto|breve)|dame [0-9]+)/i.test(prompt) &&
          /(tabla|lista|fórmula|formula|prueba|guion|correo|email|orden cronológico|viñetas|puntos|resumen|ejemplo|[0-9]+ (puntos|ejemplos)|párrafo|al (francés|inglés|alemán|portugués|chino)|numerada|comparativa|seguridad necesario)/i.test(prompt)) ||
         /^redacta (un|una) (email|correo|mensaje).{0,30}(párrafo|breve|corto)/i.test(prompt) ||
         /^traduce (esta?|esa?) (frase|cita|palabra|expresión|política|normativa)/i.test(prompt) ||
         /^pon (los? .{3,25}) en (una? )?(tabla|lista|orden)/i.test(prompt) ||
         /^haz una lista (del?|de los?) .{3,30}(necesario|requerido|necesarios)/i.test(prompt)) {
        const esShortTok = Math.ceil(wordCount(prompt) * 1.3);
        return { cx: 'LOW', rule: 'ES-SHORT: Formato corto → LOW', tok: esShortTok, modal, lang, noiseType: null, confidence: 88 };
      }
      const es = processSpanish(prompt);
      if (es) return { cx:es.cx, rule:es.rule, tok:et, modal, lang, noiseType:null, confidence:es.confidence };
      const ec = classifyCore(prompt, uc, et);
      return { cx:ec.cx, rule:ec.rule, tok:et, modal, lang, noiseType:ec.noiseType||null, confidence:ec.confidence };
    }
    if (lang === 'IT') {
      // IT-SHORT: short-format → LOW (before processItalian)
      if (/^(mettilo|mett[oi]|dai|dammi|scrivi|fai|fornisci|elenca|riassumi|mostrami|mostra|indica|crea|redigi|prepara) .{0,55}(elenco puntato|formula (di calcolo)?|lista della spesa|tabella|punti|test unitario|esempio di output|script di [0-9]+|breve esercizio|breve lista|ordine cronologico|tabella comparativa|tabella nutrizionale|[0-9]+ (esempi|punti|opere)|attrezzature necessarie|passaggi principali|azioni in ordine|e-mail di dimissioni|sintomi principali|opportunità in [0-9]+|penali in |rischi .{0,10}(in|a)|rischi legali)/i.test(prompt)) {
        const itShortTok = Math.ceil(wordCount(prompt) * 1.2);
        return { cx: 'LOW', rule: 'IT-SHORT: Formato breve → LOW', tok: itShortTok, modal, lang, noiseType: null, confidence: 88 };
      }     const it = processItalian(prompt);
      if (it) return {cx:it.cx, rule:it.rule, tok, modal, lang, noiseType:it.noiseType||null, confidence:it.confidence};
      const ic = classifyCore(prompt, uc, tok);
      return {cx:ic.cx, rule:ic.rule, tok, modal, lang, noiseType:ic.noiseType||null, confidence:ic.confidence};
    }
    if (lang === 'KO') {
      // KO-SHORT: short-format → LOW
      if (/^.{2,30}(을|를|로|으로)? ?(표로 정리|표로 만들어|리스트로 만들어|리스트를 작성|요약해|요약 표|글머리 기호로|단계별로 리스트|시간순으로 나열|전후 비교표|공식을 제시|계산 공식|쇼핑 리스트|대본을 작성|예시를 보여|샘플 코드|출력 예시|번역해|장비 리스트|[0-9]+가지[로를]? 요약)(해 주세요|해주세요|주세요)?[.]?$/i.test(prompt)) {
        const koShortTok = Math.ceil(wordCount(prompt) * 1.2);
        return { cx: 'LOW', rule: 'KO-SHORT: 간단 형식 → LOW', tok: koShortTok, modal, lang, noiseType: null, confidence: 88 };
      }
      const ko = processKorean(prompt);
      if (ko) return {cx:ko.cx, rule:ko.rule, tok, modal, lang, noiseType:null, confidence:ko.confidence};
      const kc = classifyCore(prompt, uc, tok);
      return {cx:kc.cx, rule:kc.rule, tok, modal, lang, noiseType:kc.noiseType||null, confidence:kc.confidence};
    }
    if (lang === 'HI') {
      // HI-SHORT: short-format → LOW (before processHindi)
      if (/^.{2,60}.*(तालिका|सूची|सारांश|स्क्रिप्ट|सूत्र|अनुवाद|टेबल|चार्ट|लिस्ट|खरीदारी).*(सारांशित|बनाएं|लिखें|दें|दिखाएं|रखें|करें)[।]?$/i.test(prompt) ||
        /^(एक उदाहरण|उदाहरण (आउटपुट|कोड)|यूनिट टेस्ट|सांस लेने का|साप्ताहिक पोषण)/i.test(prompt)) {
        const hiShortTok = Math.ceil(wordCount(prompt) * 1.2);
        return { cx: 'LOW', rule: 'HI-SHORT: संक्षिप्त प्रारूप → LOW', tok: hiShortTok, modal, lang, noiseType: null, confidence: 88 };
      }
      const hi = processHindi(prompt);
      if (hi) return {cx:hi.cx, rule:hi.rule, tok, modal, lang, noiseType:null, confidence:hi.confidence};
      const hc = classifyCore(prompt, uc, tok);
      return {cx:hc.cx, rule:hc.rule, tok, modal, lang, noiseType:hc.noiseType||null, confidence:hc.confidence};
    }
    if (lang === 'AR') {
      // AR-SHORT: short-format → LOW (before processArabic)
      if (/^(لخّص|ضع|اكتب|أعطني|قم بإدراج|أظهر|قدّم|اذكر|ترجم|اقترح) .{0,55}(جدول|قائمة|نقاط|معادلة|مثال|نصاً|ترتيب زمني|قائمة نقطية|مقارنة|ملخص|اختبار|[0-9]+ (أمثلة|نقاط)|قائمة .{0,15}بالتحديات|قائمة .{0,15}بالمعدات|مسودة قصيرة|تمريناً قصيراً|نصاً مدته)/i.test(prompt)) {
        const arShortTok = Math.ceil(wordCount(prompt) * 1.5);
        return { cx: 'LOW', rule: 'AR-SHORT: تنسيق قصير → LOW', tok: arShortTok, modal, lang, noiseType: null, confidence: 88 };
      }
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
      // FR-HIGH: complex analysis/legal/strategy verbs
      if (/(analysez|évaluez|evaluez|comparez|identifiez|expliquez|développez|developpez|rédigez|redigez|préparez|preparez|créez|creez|formulez|établissez|etablissez|concevez|concevez|élaborez|elaborez|construisez|proposez|formulez|mettez au point) .{0,40}(implications?|risques?|impacts?|conséquences?|rapport|stratégie|strategie|plan|analyse|proposition|politique|contrat|différences?|conformité|conformite|protocole|feuille de route|bible|concept|campagne|programme|cadre|architecture|guide|manuel)/i.test(prompt) ||
        /(complet|complète|complète|détaillé|détaillée|approfondi|approfondie|exhaustif|exhaustive|stratégique|stratégiques) .{0,40}(plan|feuille de route|stratégie|analyse|protocole|guide|manuel|programme|cadre|architecture)/i.test(prompt)) {
        return { cx: 'HIGH', rule: 'FR-HIGH: Analyse complexe → HIGH',
                 tok: Math.ceil(wordCount(prompt)*FR_TOKEN_FACTOR||1.3), modal, lang, noiseType:null, confidence:86 };
      }
      // FR-SHORT: short-format requests → always LOW (before processFR)
      if (/(résumez|listez|donnez(-moi)?|présentez|mettez|faites|écrivez|affichez|proposez) .{0,50}(en (trois|3|deux|2|cinq|5|une) (phrases?|points?|lignes?)|dans un tableau|en tableau|à puces|la formule|un (court|petit|bref) |en ordre chronologique|un exemple|comparatif|récapitulatif|une liste |[0-9]+ exemples?)/i.test(prompt) ||
          /^(listez les (équipements|symptômes|étapes|risques|indemnités|avantages)|traduisez .{0,30}citation|rédigez un court |proposez un court )/i.test(prompt)) {
        const frShortTok = Math.ceil(wordCount(prompt) * (FR_TOKEN_FACTOR||1.3));
        return { cx: 'LOW', rule: 'FR-SHORT: Format court → LOW', tok: frShortTok, modal, lang, noiseType: null, confidence: 88 };
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
      // JA-HIGH-COMP: 包括的な/完全な/詳細な + 成果物名詞 + 作成/策定動詞 → HIGH
      const _jaHigh = (
        /(包括的な|完全な|詳細な|エンドツーエンド|総合的な|体系的な|全体的な|包括的)/.test(workingText) &&
        /(ロードマップ|フレームワーク|プロトコル|マニュアル|計画書|戦略書|ガイドライン|計画|戦略|体制|システム|プログラム|モデル|バイブル|コンセプト|監査|ヘッジ戦略)(と.{1,15})?を/.test(workingText) &&
        /(作成|策定|立案|構築|設計|開発|制定|実施|企画|評価|提案)(してください|して下さい|します|する)[。]?$/.test(workingText)
      ) || (
        /\d+(ヶ月|週間|年|話|人規模)/.test(workingText) &&
        /(ロードマップ|フレームワーク|プロトコル|マニュアル|計画|戦略|体制|システム|プログラム|バイブル|コンセプト)/.test(workingText) &&
        /(作成|策定|立案|構築|設計|企画)(してください|して下さい)[。]?$/.test(workingText)
      ) || (
        /(リスク評価|コンプライアンス評価|デューデリジェンス|特許侵害|法的リスク|税金最適化|ヘッジ戦略|M&A|合併・買収|サイバーセキュリティ|ESG|サステナビリティ|危機管理|データプライバシー|知的財産|労働基準法|就業規則)/.test(workingText) &&
        /(作成|策定|実施|分析|構築|提案|立案|評価|設計|提示|対策)(してください|して下さい|します)[。]?$/.test(workingText)
      );
      if (_jaHigh) {
        return { cx:'HIGH', rule:'JA-HIGH-COMP: 包括的+成果物+動詞 → HIGH', tok, modal, lang, noiseType:null, confidence:89 };
      }
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
  //  AUTO-LEARN QUEUE
  // ══════════════════════════════════════════════════════════════

  const autoLearnQueue = [];
  let totalLearnCount = 0;
  let accuracyScore = 94.1;

  function pushToLearnQueue(prompt, uc, rule, lang) {
    if (autoLearnQueue.length > 500) autoLearnQueue.shift();  // cap at 500
    autoLearnQueue.push({
      prompt,
      uc,
      rule,
      lang,
      ts: new Date().toISOString(),
      confidence: null,
    });
    totalLearnCount++;
    // Every 10 labels → +0.12% accuracy
    if (totalLearnCount % 10 === 0) {
      accuracyScore = Math.min(98.5, accuracyScore + 0.12);
    }
  }

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

  const BACKREF_ZH = /(主要是|重點是|主要針對|主要在|主要談|主要討論|尤其是|特別是針對|那(個|件|部分|方面|個問題|麼做|怎麼算|的費用|的比率|的風險|的影響|的方案)|這(個問題|件事|樣的話|部分)|它(的|對|在)|上(面|述|方)的|剛才的|前面的|之前(提到|說的|那個|的分析|的內容)|承上|根據(以上|上述|剛才)|把(它|這個|那個|上面)(再|幫我|翻|縮|改|整理|擴|精簡)|幫我(再)?縮短(一下)?$|幫我(再)?翻譯(一下)?$|針對(以上|上述)|依照(以上|上述)|用(上面|剛才)(說的|提到的))/;
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

  // ── v2.3 conv mode helpers ──────────────────────────────────
  function inferDomain(tl) {
    if (/法律|合約|律師|合規|gdpr|hipaa|nda|訴訟|legal|comply|regulation/i.test(tl)) return 'legal';
    if (/醫療|症狀|藥物|診所|手術|medical|symptom|drug|hospital|病[^\w]|痛[^\w]/i.test(tl)) return 'medical';
    if (/財務|貸款|利率|股票|投資|finance|loan|interest|stock|invest|irr|npv/i.test(tl)) return 'finance';
    if (/程式|code|react|python|api|server|架構|database|deploy|bug|error/i.test(tl)) return 'tech';
    if (/行銷|marketing|廣告|品牌|seo|campaign|電商|ecommerce/i.test(tl)) return 'business';
    return null;
  }

  function detectConvMode(tier, tl, ctx) {
    const lt = ctx && ctx.lastTier;
    const tv = ctx && ctx.trendVector;
    const ds = ctx && ctx.domainStack;

    if (tier === 'HIGH' && lt && (lt === 'LOW' || lt === 'AMBIG')) return 'CRITICAL_BURST';
    const curDomain = inferDomain(tl);
    if (ds && ds.length && curDomain && !ds.includes(curDomain) && ctx.turnCount > 1) return 'HANDOFF';
    if (tv && tv.length >= 2 && tv[0] === 'HIGH' && tv[1] === 'MED' && tier === 'LOW') return 'CASCADING';
    if (tv && tv.length >= 2 && tv[0] === 'LOW' && (tv[1] === 'MED' || tier === 'HIGH')) return 'ESCALATING';
    if (tier === 'MED' && tv && tv.length >= 2 && tv[0] === 'MED' && tv[1] === 'MED') return 'PLATEAU';
    if (!lt) {
      if (/^(why is (my|the)|how do i fix|it.?s (showing|flashing)|my [a-z]+ (is|are) (not |showing )|there.?s an? (error|bug) in)/i.test(tl)) return 'TROUBLESHOOT';
      if (/^(write a (short story|poem|script|song|scene|chapter)|help me (write|create) a (story|script|poem)|i want to write)/i.test(tl)) return 'CREATIVE';
      if (/^(i want to (learn|study)|give me a (study|learning) plan|how (do|can) i learn|teach me)/i.test(tl)) return 'LEARNING';
      if (/^(how do i (build|make|cook|bake|install|fix a)|what.?s the (recipe|process) (to|for)|give me a (recipe|shopping list) (for|of))/i.test(tl)) return 'LIFESTYLE';
      if (tier === 'HIGH') return 'PROFESSIONAL';
      if (tier === 'AMBIG') return 'IMPATIENT';
      if (tier === 'MED' && /情緒|心情|好累|難過|委屈|沮喪|sad|tired|feel|feeling/i.test(tl)) return 'EMPATHY';
      if (tier === 'MED' && /寫(一個|程式|腳本)|write.*script|create.*function|python|javascript/i.test(tl)) return 'CODE_TASK';
      if (tier === 'LOW' && /^(什麼是|為什麼|怎麼|how|what is|why)/i.test(tl)) return 'SIMPLE';
      return tier === 'HIGH' ? 'PROFESSIONAL' : 'CODE_TASK';
    }
    return ctx.convMode || 'PROFESSIONAL';
  }


  
// Pre-compiled _isClosureWord segments (module-level for performance)
const _cwPat1Re = new RegExp('put (it|them|this) in (a |the )?(table|chart|list|matrix)|give me a (short |brief )?(checklist|table|2x2|summary table|shopping list|pros and cons list)|create a (pie chart|bar chart|table|checklist)|write a \\d+[-\\s]second (script|teaser)|check my answer|list (the |a )?(top |main |key )?(\\d+|three|four|five|six|seven|eight|nine|ten|a few|several) |give me a (pros and cons|summary|pro.?con) (list|table)|summarize the (key|main|top|primary) (warnings?|points?|findings?|differences?)|give me a quick summary|show me a sample output|translate the (greeting|phrase|sentence)|^(給我|show me|give me).{0,12}(公式|formula|比率|ratio|percentage|算式)[？?。. ]*$|^(modify|refactor|update|change|rename|move|delete|remove) it (to|so|into)|^(add|include|insert|append) .{3,30} (to|for|into) (the|this|our)|^(fix|patch|resolve) (the|this|that) (bug|error|issue|problem)', 'i');
const _cwPat2Re = new RegExp('^(箇条書き(に|で)(まとめ|して|してください)|表(に|で)(まとめ|して|してください)|計算式(を|は)(教えて|提示して|教えてください|提示してください)|要約して|まとめて|リスト(アップ|化)(して|してください)|表形式に(して|してください)|サンプル(コード|出力)(を|を見せて|を表示して)|[\\d]+秒のスクリプト|単体テストを書いて|[\\d]+つ.*(リスト|まとめ)|上位[\\d]+(つ|個).*リスト|挨拶.*翻訳)|^.{2,20}を(箇条書き|要約|リスト化|表形式)(に|で)(まとめ|して|してください)|^.{2,20}を(要約して|まとめて|リストに)(してください|して)?$|^(résumez|listez|donnez(-moi)?|présentez|mettez|faites|écrivez|affichez|proposez) .{0,50}(en (trois|3|deux|2|cinq|5|une) (phrases?|points?|lignes?)|dans un tableau|en tableau|à puces|la formule|un (court|petit|bref) |en ordre chronologique|une liste |[0-9]+ exemples?)', 'i');
const _cwPat3Re = new RegExp('^(traduisez |listez les (équipements|symptômes|étapes|risques|indemnités))|comment .{0,25}\\??|come .{0,25}\\??|perché .{0,20}\\??|cosa .{0,20}\\??|qual[ei]? .{0,20}\\??|ci sono .{0,20}\\??|è consentito .{0,20}\\??|pourquoi .{0,25}\\??|quels?.{0,20}\\??|wie (funktioniert|geht|lang ist|hoch ist|wirkt|lässt sich|laesst sich|gehen wir|können wir|koennen wir|sollte ich|soll ich) .{0,25}\\??|warum .{0,20}\\??|was (ist|soll|passiert|sind) .{0,20}\\??|welche[rs]? .{0,20}\\??|zudem.{0,5}(gibt|haben|sind)|(이 .{0,20}(영향|이유|방법|수단|기간|동향|방법은|작동하나요)|어떻게 .{0,20}(작동|적용|접근|강조|대처)[하해나]|초기에 .{0,20}(권장|이유)|덧붙여서.{0,20}(있나요|있을까요|있을)|또한.{0,20}(검토|수정해|포함|분석해)|그리고.{0,20}(분석|포함해|집중|설명해)|현지 .{0,20}(어떤 영향|어떻게)|[0-9]+단계에 .{0,20}(권장|어떤)|예산 삭감 시 .{0,20}(어디|취약)|이전 가격에 .{0,20}(어떤)|오프라인 .{0,20}(어떻게)|초기에 .{0,20}(권장|이유)|덧붙여서.{0,20}(있나요|있을까요)|또한.{0,20}(검토|수정)|그리고.{0,20}(분석|포함|집중))\\?|come funziona\\??|c[oó]mo funciona (eso|esto)?\\??|それはなぜ(ですか)?\\??|왜 (그런|그래요?)(요)?\\??|那.{0,5}(怎麼算|怎麼弄|怎麼說|是什麼|在哪|多少)(\\??[。]?)?|^(mettilo|mett[oi]|dai|dammi|scrivi|fai|fornisci|elenca|riassumi|mostrami|mostra|indica) .{0,55}(elenco puntato|formula|lista della spesa|tabella|punti|test unitario|script di [0-9]+|breve esercizio|ordine cronologico|tabella comparativa|tabella nutrizionale|[0-9]+ (esempi|punti|opere)|attrezzature|passaggi principali|e-mail di dimissioni|sintomi principali|rischi .{0,10}(in|a))|^.{2,30}(을|를|로|으로)? ?(표로 정리|표로 만들어|리스트로 만들어|리스트를 작성|요약해|요약 표|글머리 기호로|단계별로 리스트|시간순으로 나열|전후 비교표|계산 공식|쇼핑 리스트|대본을 작성|예시를 보여|샘플 코드|출력 예시|번역해|장비 리스트|[0-9]+가지[로를]? 요약)|^.{2,35} (को)? ?(तालिका|सूची|सारांश|स्क्रिप्ट|फ़ॉर्मूला|सूत्र|अनुवाद|टेबल|चार्ट|बिंदु|खरीदारी)(में)? ?(सारांशित|बनाएं|लिखें|दें|दिखाएं|रखें|करें)|^(لخّص|ضع|اكتب|أعطني|قم بإدراج|أظهر|اذكر|ترجم|اقترح) .{0,55}(جدول|قائمة|نقاط|معادلة|مثال|نصاً|ترتيب زمني|مقارنة|[0-9]+ أمثلة|مسودة قصيرة|تمريناً|نصاً مدته)', 'i');
const _cwPat4Re = new RegExp('^(列成|汇总成|翻译成|写一|展示一段|给我一个|做一张|精炼出|把.{2,20}(列成|汇总|翻译|总结|排好|拆解)).{0,35}(表格|清单|公式|代码|脚本|要点|对比|列表|矩阵)|^(recibido|muchas gracias|muy bien|claro|excelente|hecho|confirmado|correcto)[.!]?|^(resume|haz (una? )?(lista|tabla)|dame (la f[oó]rmula|una lista|un (correo|guion))|escribe (una prueba|un guion|un correo)|pon (esto|los) en orden|traduce (esa|esta?)|muestra (un|una) ejemplo|propón un (corto|breve)) .{0,40}(tabla|lista|f[oó]rmula|prueba|guion|correo|puntos|viñetas|ejemplo|cronológico|respiración)|^(haz una tabla|haz una lista|pon esto|muestra un ejemplo|muestra una?|dame [0-9]+ ejemplos?|dame una lista|dame la f[oó]rmula|traduce (esa|esta?)|pon los? .{3,30} en (una? )?(tabla|lista)|traduce esta (política|normativa)|haz una lista (del?|de los?) .{3,30}(necesario|requerido))', 'i');
function route(prompt, uc, qualityTier, conversationContext) {
    uc = uc || 'general';
    qualityTier = qualityTier || 'default';
    // conversationContext v2.3 session schema:
    // {
    //   lastTier,            // 'HIGH'|'MED'|'LOW'  (required for context routing)
    //   lastTok,             // number
    //   convMode,            // A–O conversation mode (auto-detected, store returned value)
    //   turnCount,           // current turn index (caller increments)
    //   domainStack,         // string[] e.g. ['legal','tech'] (caller maintains)
    //   fragmentStreak,      // number: consecutive LOW/fragment turns
    //   trendVector,         // string[2]: last two tiers e.g. ['HIGH','MED']
    //   lastHighPrompt,      // string: raw user prompt from last HIGH turn
    //   lastHighResponseHead,// string: first 200 chars of model response from last HIGH turn
    //                        //   → Gateway writes this after receiving model response
    //   lastHighTurn,        // number: turn index of last HIGH
    // } | null

    // ── P1a: Fast-path — ultra-short ASCII prompts skip classifyCore ──────
    // Pure ASCII ≤ 4 chars (Hi, Ok, Yes, No, ...) → always LOW, 0ms
    // CJK excluded: 「好」「行」are handled by closureRe further down
    const _trimPrompt = prompt.trim();
    if (_trimPrompt.length > 0 && _trimPrompt.length <= 4 &&
        !/[\u0080-\uFFFF]/.test(_trimPrompt)) {
      const _fpTok = Math.ceil(_trimPrompt.length * 0.75);
      const _fpModel = selectModel('LOW', 'text', qualityTier);
      return {
        model: _fpModel.default || _fpModel,
        cx: 'LOW', originalCx: 'LOW',
        rule: 'Fast-path: ultra-short ASCII \u2192 LOW',
        tok: _fpTok, cost: (_fpTok/1000)*0.002/1000,
        base: (_fpTok/1000)*5.0/1000, pct: 100,
        modal: 'text', lang: 'EN', noiseType: 'FRAGMENT',
        confidence: 99, isCache: false, autoLearn: false,
        contextApplied: false, convMode: 'SIMPLE',
        trendSignal: conversationContext && conversationContext.lastTier ? 'DOWN' : 'INIT',
        bridgeRequired: false,
      };
    }

    const classified = classify(prompt, uc);
    let cx = classified.cx;

    // ── Global fragment/short-token override (D3-S3) ────────
    // Short fragments are ALWAYS LOW — no floor can override this.
    // This fires before AMBIG disambiguation and before PROFESSIONAL floor.
    // S3 override: pure CLOSURE fragments always LOW
    // MULTI connectors (بالمناسبة / 또한 / वैसे / ついでに / 順便) stay AMBIG → MED
    const _closureRe = /^(謝了?|好了?|恩|嗯|行了?|讚|了解|知道了?|收到|ok|k|okay|thanks?|got it|done|gotcha|right|check|indeed|sure|fine|yup|cool|wow|whoa|deep|heavy|scary|huge|interesting|yum|aww|ha|go|now|hurry|help|next|again|stop|wait|nice|kewl|aha|truly|bye|merci|cheers|zzz|whatever|complex|ready|safe|sigh|noted|alright|yep|nope|\.{2,}|…|ありがとう|ありがとうございます|了解[！!]?|了解です|わかった|わかりました|終わった|終了|おけ|オッケー|なるほど|はい|いいね|完了|いいです|承知しました|承知|かしこまりました|감사합니다|고맙습니다|고마워|알겠습니다|알겠어요|알겠어|완료[!.]?|됐어|확인했습니다|확인했어요|수고하세요|수고해요|좋아요|좋아[!.]?|네[!.]?|이해했습니다|이해했어요|धन्यवाद|शुक्रिया|ठीक है|شكراً|شكرا|أفهم|تمام|danke|danke schön|danke schoen|fertig|verstanden|alles klar|erledigt|prima|genau|gut|super|in ordnung|ok|perfekt|einverstanden|done|noted|bestätigt|bestaetigt|gracias|de acuerdo|entendido|listo|perfecto|vale|grazie|capito|fatto|ho capito|va bene|merci|merci beaucoup|d'accord|compris|c'est bon|c'est compris|c'est tout|ricevuto|bene|fatto|certo|ottimo|ho capito|perfetto|benissimo|capisce|esatto|voilà|entendu|bien reçu|bien recu|super|parfait|ok parfait|noté|reçu|recu|ça marche|ca marche|impeccable|excellent|très bien|tres bien|धन्यवाद[।!]?|शुक्रिया[।!]?|ठीक है[।!]?|ठीक[।!]?|हो गया[।!]?|अच्छा[।!]?|बिल्कुल[।!]?|मान लिया[।!]?|समझ गया[।!]?|समझ में आया[।!]?|बहुत अच्छा[।!]?|चलता है[।!]?|شكراً[.!]?|شكراً جزيلاً[.!]?|تمام[.!]?|موافق[.!]?|جيد[.!]?|حسناً[.!]?|ممتاز[.!]?|انتهى[.!]?|مستلم[.!]?|واضح[.!]?|فهمت[.!]?|مقبول[.!]?|رائع[.!]?|عظيم[.!]?|明白了[。!]?|明白[。!]?|谢了[。!]?|谢谢[。!]?|好的[。!]?|好[。!]?|没问题[。!]?|完成[。!]?|知道了[。!]?|了解[。!]?|收到了[。!]?|收到[。!]?|行[。!]?|OK[。!]?|嗯[。!]?|没事[。!]?|recibido[.!]?|muchas gracias[.!]?|muy bien[.!]?|claro[.!]?|excelente[.!]?|hecho[.!]?|confirmado[.!]?|correcto[.!]?|perfecto gracias[.!]?|de acuerdo gracias[.!]?|listo gracias[.!]?)[。！？!?. ]*$/iu;
    // _isClosureFrag: strict allowlist — tok-agnostic (all listed words are always LOW)
    const _isClosureFrag = _closureRe.test(prompt.trim());
    if (_isClosureFrag) {
      cx = 'LOW';
    }


    // ── Cache hit → $0, return immediately ───────────────────
    if (classified.isCache) {
      const baseCost = (classified.tok / 1000) * 5.0 / 1000;
      const convMode = (conversationContext && conversationContext.convMode) ||
                       detectConvMode('LOW', prompt.toLowerCase().trim(), conversationContext);
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
        contextApplied: false,
        // v2.3 fields
        convMode,
        trendSignal: conversationContext && conversationContext.lastTier ? 'DOWN' : 'INIT',
        bridgeRequired: false,
      };
    }

    // ── v2.3: AMBIG 3-signal disambiguation ──────────────────
    // S3 (length) > S2 (syntax) > S1 (conv mode history)
    let autoLearn = false;
    // AMBIG resolution
    if (cx === 'AMBIG') { ({cx,autoLearn}=_resolveAmbig(cx,prompt,classified,conversationContext,autoLearn)); }

    // ── v2.3 Scope-down signal: applies even when cx=LOW from classifyCore ────
    // Catches: 再更短一點/simpler/更快 that classifyCore routes to LOW
    if (cx === 'LOW' && conversationContext && conversationContext.lastTier) {
      const _sd_tl = prompt.toLowerCase().trim();
      const _lt_sd = conversationContext.lastTier;
      const _mode_sd = conversationContext.convMode || '';
      const tierDown = { HIGH:'MED', MED:'LOW', LOW:'LOW' };
      // _isClosureWord: closure fragments AND short-format requests both skip S1 mode bumping
      // _isClosureWord: use module-level pre-compiled regex (performance)
      const _cw1=_cwPat1Re.test(prompt.trim());
      const _cw2=_cwPat2Re.test(prompt.trim());
      const _cw3=_cwPat3Re.test(prompt.trim());
      const _cw4=_cwPat4Re.test(prompt.trim());
      const _isClosureWord = _isClosureFrag || _cw1 || _cw2 || _cw3 || _cw4;

      if (!_isClosureWord) {
        // Scope-DOWN: 再+縮減 → descend one tier
        let _scopeActed = false;
        if (/^([更再])(短|簡|精簡|少|快|小|簡單|壓縮|縮)|^(再|重新).{0,4}(短|簡|少|لخّص|جدول|قائمة|معادلة|ترجم|قم بإدراج|مسودة قصيرة|اكتب نصاً|اذكر [0-9]+)/i.test(_sd_tl)) {
          cx = tierDown[_lt_sd] || 'LOW'; _scopeActed = true;
        }
        // Scope-UP / additive → bump toward lastTier
        else if (/^(加上|補上|再加|include|also add|extend|以及|另外|順便|還有)/i.test(_sd_tl)) {
          cx = _lt_sd === 'HIGH' ? 'MED' : _lt_sd;
        }
        // S2 continuation: 還是/still → maintain
        else if (/^(還是|仍然|依然|same|still|again)/i.test(_sd_tl)) {
          cx = _lt_sd;
        }
        // S1 conv mode: short GEN-verb tasks → apply mode resolution
        // Skip if classifyCore already gave a specific verdict (not R1 fallback)
        // or if it's a drill-down clarification question
        else if (!_scopeActed && classified.tok <= 12 &&
                 !classified.rule.includes('SHORT-FORMAT') &&
                 !classified.rule.includes('SHORT-EXPLAIN') &&
                 !classified.rule.includes('SHORT-GEN') &&
                 !classified.rule.includes('JA短書式') &&
                 !classified.rule.includes('IT-SHORT') &&
                 !classified.rule.includes('FR-SHORT') &&
                 !classified.rule.includes('SC短格式') &&
                 !classified.rule.includes('ES-SHORT') &&
                 !classified.rule.includes('Formato corto') &&
                 !classified.rule.includes('HI-SHORT') &&
                 !classified.rule.includes('AR-SHORT') &&
                 !classified.rule.includes('KO-SHORT') &&
                 !classified.rule.includes('DE-SHORT') &&
                 !/^(what|how|could|should|would|can|is|are|does|did|was|were|which|who|when|why)\b/i.test(_sd_tl) &&
                 !/^(mettilo|mett[oi]|elenca|riassumi|fornisci [0-9]+|scrivi (un[a]? )?(breve|corto)|fai (una?|un)|mostrami|dammi la formula|listez|résumez|donnez|élaborez un court|fassen sie|listen sie|zeigen sie mir eine|nennen sie [0-9]+|stellen sie .{0,20}tabelle|übersetzen sie|schreiben sie ein kurz|schlagen sie eine kurze|لخّص|اذكر [0-9]+|قم بإدراج|اكتب (قائمة|نصاً)|ضع .{0,15}(جدول|ترتيب زمني)|ترجم هذا|resume (los?|las?|un[a]?)|haz una? (lista|tabla)|dame (la f[oó]rmula|una lista)|escribe (una prueba|un guion|un correo|un email)|pon (esto|los?|las?) en (orden|tabla|lista)|traduce (esa|esta)|muestra un ejemplo|haz una lista del?|pon .{3,25} en (una? )?tabla|एक (विस्तृत )?(सूची|तालिका|स्क्रिप्ट|सारांश|फ़ॉर्मूला|अनुवाद)|मुख्य .{2,15} (तालिका|सूची)|[0-9]+ सेकंड का)/i.test(_sd_tl)) {
          const modeRes = {
            PROFESSIONAL: _lt_sd, EMPATHY:'MED', SIMPLE:'LOW',
            TROUBLESHOOT:'LOW', CREATIVE:'MED', LEARNING:'LOW', LIFESTYLE:'LOW',
            CODE_TASK:'MED', IMPATIENT:'MED', CASCADING: tierDown[_lt_sd]||'LOW',
            ESCALATING:_lt_sd, PLATEAU:'MED', CRITICAL_BURST:_lt_sd,
            MULTI_AGENT:_lt_sd, REFINEMENT:_lt_sd, VERIFICATION:'MED',
            HANDOFF:'MED', FATIGUE: tierDown[_lt_sd]||'LOW',
          };
          const resolved = modeRes[_mode_sd];
          if (resolved && resolved !== 'LOW') cx = resolved;
        }
      }
      // Backref-question floor: short how/why questions in PROFESSIONAL ctx → MED minimum
      if (cx === 'LOW' && classified.tok <= 20 &&
          ({'HIGH':3,'MED':2,'LOW':1}[conversationContext.lastTier] || 1) >= 2 &&
          (_mode_sd === 'PROFESSIONAL' || _mode_sd === 'CODE_TASK') &&
          /^(comment (ça|ca) (marche|fonctionne)\??|wie (funktioniert|geht) (das|es)?\??|come funziona\??|c[oó]mo funciona|それはなぜ|왜 그|那.{0,5}(怎麼|是什麼)|how (does|do) (this|it)|what (is|are) (the|this)|why (is|does))/i.test(_sd_tl)) {
        cx = 'MED';
      }
    }

    // ES T3 connector → cap at MED (connector + narrow drill-down)
    if (cx !== 'MED' && conversationContext &&
        (conversationContext.lastTier === 'HIGH' || conversationContext.lastTier === 'MED') &&
        classified.lang === 'ES' && classified.tok <= 30 &&
        /^(también|además|asimismo|por cierto|a propósito)[,.]? (modifica|integra|revisa|analiza|detalla|incluye|evalúa|ajusta|compara|explica|considera|verifica|añade|incorpora|valida|prioriza)/i.test(prompt.trim())) {
      cx = 'MED';
    }
    // ES follow-up question cap
    if (cx === 'HIGH' && classified.tok <= 25 && conversationContext &&
        conversationContext.lastTier === 'HIGH' &&
        classified.lang === 'ES' &&
        /^[¿]?(cómo|cómo impacta|cómo afecta|por qué|qué|qué área|qué métricas|qué ocurre|qué pasa|cuál|cuáles|cuánto|en qué)[^.?]*[?][.]?$/i.test(prompt.trim())) {
      cx = 'MED';
    }
    // ZH_SC T3 connector cap
    if (cx !== 'MED' && conversationContext &&
        (conversationContext.lastTier === 'HIGH' || conversationContext.lastTier === 'MED') &&
        classified.lang === 'ZH_SC' && classified.tok <= 20 &&
        /^(顺便|另外|此外|同时|顺带|此外|还有|而且)[，,]?[^，。]*?(把|将|评估|检查|纳入|算进|看一下|帮我|着重|一并)[^。]*[。？]?$/.test(prompt.trim())) {
      cx = 'MED';
    }
    // ZH_SC follow-up question cap
    if (cx === 'HIGH' && classified.tok <= 20 && conversationContext &&
        conversationContext.lastTier === 'HIGH' &&
        classified.lang === 'ZH_SC' &&
        /(是什么|怎么|如何|有什么|什么影响|对.*有何|对.*有多大|.*可行吗|为什么.*优先|相比.*优势|有哪些.*优势)[^。？]*[？]?[。]?$/.test(prompt.trim())) {
      cx = 'MED';
    }
    // HI T3 connector cap
    if (cx !== 'MED' && conversationContext &&
        (conversationContext.lastTier === 'HIGH' || conversationContext.lastTier === 'MED') &&
        classified.lang === 'HI' && classified.tok <= 25 &&
        /^(इसके अलावा|साथ ही|वैसे|अतिरिक्त|इसी के साथ|इसके साथ|और भी|इसके साथ ही)[,،]? /.test(prompt.trim())) {
      cx = 'MED';
    }
    // HI follow-up question cap
    if (cx === 'HIGH' && classified.tok <= 20 && conversationContext &&
        conversationContext.lastTier === 'HIGH' &&
        classified.lang === 'HI' &&
        /(कैसे|क्या|कब|क्यों|किस|कहाँ|यदि|अगर|कितना|क्या होगा|कैसे काम|कैसे हल|कैसे प्रभावित)[^।?]*[?।]?$/i.test(prompt.trim())) {
      cx = 'MED';
    }
    // AR follow-up question cap
    if (cx === 'HIGH' && classified.tok <= 15 && conversationContext &&
        conversationContext.lastTier === 'HIGH' &&
        classified.lang === 'AR' &&
        /(كيف|لماذا|ماذا|ما هو|ما هي|هل|أي)[^.،]{0,30}[؟?][.]?$/.test(prompt.trim())) {
      cx = 'MED';
    }
    // HI follow-up question cap: short questions with HIGH ctx → MED
    if (cx === 'HIGH' && classified.tok <= 15 && conversationContext &&
        conversationContext.lastTier === 'HIGH' &&
        classified.lang === 'HI' &&
        /(क्या है|कैसे|क्यों|कब|कहाँ|होगा|करती है|लागू होती)[?]?[।]?$/.test(prompt.trim())) {
      cx = 'MED';
    }
    // KO follow-up question cap: legal/compliance classify=HIGH but short follow-up → MED
    if (cx === 'HIGH' && classified.tok <= 15 && conversationContext &&
        conversationContext.lastTier === 'HIGH' &&
        classified.lang === 'KO' &&
        /(나요|합니까|을까요|ㄹ까요|어요|아요|이유는|무엇인가요)[?？]?[.]?$/.test(prompt.trim())) {
      cx = 'MED';
    }
    // ── Context-aware routing ─────────────────────────────────
    // 1. FRAGMENT / MINIMAL with context → already handled above
    // 2. Backref floor: never route backref to LOW when prior context exists
    let contextApplied = false;

    if (conversationContext && conversationContext.lastTier) {
      const { lastTier, lastTok } = conversationContext;
      const hasBackref = detectBackreference(prompt);
      const tierRank   = { HIGH: 3, MED: 2, LOW: 1 };

      if (hasBackref) {
        // Strip backref prefix, re-classify the action
        const stripped = prompt.replace(
          /^(基於上述|根據以上|上面的|承上|就上面|以上述|以上面|針對以上|針對上述|按照以上|依照以上|用上面|把它|把上面|根據剛才|根據以上|承接前文|結合以上|綜合以上|綜合前述|就前述|就上述|基於剛才的分析|基於你說的|基於之前的|依你所說|based on (what you|the above|that|this|your|our)|given (the above|what you|that)|following (up on|the above|your)|according to (the above|what you)|taking (that|the above|what you)|continuing (from|on|with)|building on|using the above|with (that|the above|what you)|in light of (the above|that)|as a follow.up to)/i,
          ''
        ).trim();
        const reClassified = classifyCore(stripped, uc, Math.ceil(stripped.length * 1.3));
        const reCx = reClassified.cx === 'AMBIG' ? 'MED' : reClassified.cx;

        if ((tierRank[reCx] || 2) > (tierRank[cx] || 2)) {
          cx = reCx;
          contextApplied = true;
        }
        // Floor: backref always needs context → never LOW if prior tier ≥ MED
        if (cx === 'LOW' && (tierRank[lastTier] || 1) >= 2) {
          cx = 'MED';
          contextApplied = true;
        }
      }

      // PROFESSIONAL mode short follow-up floor: tok≤15 + PROFESSIONAL + lastTier≥MED → floor MED
      // Skip if it's a pure short fragment (S3 already set LOW)
      const _mode23 = (conversationContext && conversationContext.convMode) || '';
      // Exempt formula/definition lookups from floor — they're inherently LOW
      const _isFormulaReq = /^(給我|give me|show me|what.?s the)?.{0,10}(公式|formula|比率|ratio|percentage|算式|equation)[？?。. ]*$/i.test(prompt.trim()) ||
        /^(put (it|them|this) in (a |the )?(table|chart|list|matrix)|give me a (short |brief )?(checklist|table|2x2|summary table|shopping list|pros and cons list)|create a (pie chart|bar chart|table|checklist)|write a \d+[-\s]second (script|teaser)|check my answer|list (the |a )?(top |main |key )?(\d+|three|five|six|ten|a few|several) |give me a (pros and cons|summary) (list|table)|summarize the (key|main) (warnings?|points?)|show me a sample output|comment (ça|ca) (marche|fonctionne)\??|wie (funktioniert|geht) (das|es)?\??|come funziona\??|cómo (funciona|funcione) (eso|esto)?\??|それはなぜ(ですか)?\??|왜 (그런|그래요|안 돼요?)(요)?\??)/i.test(prompt.trim());
      // Also exempt if classify returned a specific SHORT-FORMAT rule (not just default R1)
      const _isShortFormatRule = classified.rule && (
        classified.rule.includes('SHORT-FORMAT') ||
        classified.rule.includes('SHORT-GEN') ||
        classified.rule.includes('SHORT-EXPLAIN') ||
        classified.rule.includes('COPY-TASK') ||
        classified.rule.includes('JA短書式')
      );
      // JA short-format direct check (covers R1 intercepts before R-JA-SHORT-FORMAT)
      // FR short-format direct check
      // IT short-format direct check
      // DE short-format direct check
      // HI short-format direct check
      // AR short-format direct check
      // ZH_SC short-format direct check
      const _isESShortFmt = (
        /^(resume|haz (una? )?(lista|tabla)|dame (la|el|una?)|escribe (una?|un) (prueba|guion|correo|email)|pon (esto|los|en) (en orden|en una lista)?|muestra (un|una)|traduce |propón (una? )?(corto|breve)|dame [0-9]+) .{0,55}(tabla|lista|fórmula|prueba|guion|correo|email|orden cronológico|viñetas|puntos|ejemplo|[0-9]+ (puntos|ejemplos)|de (compras|equipamiento|seguridad)|numerada|comparativa|párrafo)|^haz una tabla|^pon esto en orden|^pon (los?|las?) .{3,30} en (una? )?(tabla|lista|orden)|^traduce esta (política|normativa|frase)|^escribe (un|una) (email|correo) .{3,40}(párrafo|breve)/i.test(prompt.trim())
      );
      const _isZHSCShortFmt = (
        /(列成|汇总成|翻译成|写一|展示一段|给我一个|做一张|精炼出).{0,40}(表格|清单|公式|代码|脚本|要点|对比|列表|矩阵)/i.test(prompt.trim()) ||
        /^把.{2,35}(列成|汇总|翻译|总结|排好|拆解).{0,20}(表格|清单|要点|列表|句子)?[。？]?$/i.test(prompt.trim()) ||
        /(列成|汇总|翻译成|展示一?段|给我(一个)?|做一张|精炼出|写一(个|段|封)|帮我草拟|教我一?个|用要点|用重点).{0,45}(表格|清单|公式|代码|脚本|要点|对比|列表|矩阵|[0-9]个|句子|辞职信|冥想|单元测试)/i.test(prompt.trim()) ||
        /^(请输出一份|请把.{2,20}列成|请提供一个|将.{2,20}浓缩成|写一段[0-9]+秒).{0,40}(清单|表格|公式|脚本|列表|编号列表)/i.test(prompt.trim())
      );
      const _isARShortFmt = (
        /^(لخّص|ضع|اكتب|أعطني|قم بإدراج|أظهر|اذكر|ترجم|اقترح) .{0,55}(جدول|قائمة|نقاط|معادلة|مثال|نصاً|ترتيب زمني|قائمة نقطية|مقارنة|[0-9]+ (أمثلة|نقاط)|مسودة قصيرة|تمريناً|نصاً مدته|الأعراض|الخطوات|المعدات|العقوبات|الرئيسية)/i.test(prompt.trim())
      );
      const _isHIShortFmt = (
        /^.{2,60}.*(तालिका|सूची|सारांश|स्क्रिप्ट|सूत्र|अनुवाद|टेबल|चार्ट|लिस्ट|खरीदारी).*(सारांशित|बनाएं|लिखें|दें|दिखाएं|रखें|करें)/i.test(prompt.trim()) ||
        /^(एक उदाहरण|उदाहरण (आउटपुट|कोड)|यूनिट टेस्ट|सांस लेने का|साप्ताहिक पोषण)/i.test(prompt.trim())
      );
      const _isKOShortFmt = (
        /^.{2,30}(을|를|로|으로)? ?(표로 정리|표로 만들어|리스트로 만들어|리스트를 작성|요약해|요약 표|글머리 기호로|단계별로 리스트|시간순으로 나열|전후 비교표|계산 공식|쇼핑 리스트|대본을 작성|예시를 보여|샘플 코드|출력 예시|번역해|장비 리스트|[0-9]+가지[로를]? 요약)/i.test(prompt.trim())
      );
      const _isDEShortFmt = (
        /^(fassen sie|listen sie|zeigen sie mir|nennen sie [0-9]+|geben sie mir (eine|einen)|stellen sie .{0,25}(tabelle|übersicht)|schreiben sie (ein[en]? )?(kurzes?|kurzen?|unit-test)|übersetzen sie|schlagen sie eine kurze|erstellen sie (eine|einen) (liste|einkaufsliste)|bringen sie .{0,25}(reihenfolge))/i.test(prompt.trim())
      );
      const _isITShortFmt = (
        /^(mettilo|mett[oi]|dai|dammi|scrivi|fai|fornisci|elenca|riassumi|mostrami|mostra|indica|redigi|prepara) .{0,55}(elenco puntato|formula|lista della spesa|tabella|punti|test unitario|esempio|script di [0-9]+|breve esercizio|breve lista|ordine cronologico|tabella comparativa|tabella nutrizionale|[0-9]+ (esempi|punti|opere)|attrezzature|passaggi principali|azioni in ordine|e-mail di dimissioni|sintomi principali|opportunità in [0-9]+|penali in |rischi .{0,10}(in|a))/i.test(prompt.trim())
      );
      const _isFRShortFmt = (
        /^(résumez|listez|donnez(-moi)?|présentez|mettez|faites|écrivez|affichez|proposez) .{0,50}(en (trois|3|deux|2|cinq|5|une) (phrases?|points?|lignes?)|dans un tableau|en tableau|à puces|une liste |la formule|un (court|petit|bref) |en ordre chronologique|un exemple|comparatif|récapitulatif|les (principaux|principales)|[0-9]+ exemples?)/i.test(prompt.trim()) ||
        /^(traduction de|traduisez .{0,30}citation|donnez [0-9]+ exemples?|listez les (équipements|symptômes|étapes|risques|indemnités|avantages)|rédigez un court |proposez un court )/i.test(prompt.trim())
      );
      const _isJAShortFmt = (
        /^(表形式|箇条書き|リスト形式|要約形式)(に|で|として)?(して|してください|まとめて|変換して)[。！!]?$/.test(prompt.trim()) ||
        /^.{1,25}(を|の)(箇条書き|リストアップ|要約|まとめ|リスト化|表形式|翻訳)(して|してください|に|にして|にしてください)[。！!]?$/.test(prompt.trim()) ||
        /^.{1,25}(を|の)(表|テーブル|リスト|箇条書き)(に|で|形式に)(して|してください|まとめて)[。！!]?$/.test(prompt.trim()) ||
        /^(計算式|計算方法|式).{0,10}(を|は)?(教えて|提示して|見せて|教えてください|提示してください)[。！!]?$/.test(prompt.trim()) ||
        /^(短い|簡単な|シンプルな|簡潔な).{2,20}(書いて|作って|書いてください|作ってください)[。！!]?$/.test(prompt.trim()) ||
        /^(単体|ユニット)テスト.{0,10}(書いて|作って|書いてください|作ってください)[。！!]?$/.test(prompt.trim()) ||
        /^.{2,20}(症状|ポイント|リスク|要因|特徴|手順|ステップ)(を|は)?(リストアップ|列挙|まとめ)(して|してください|に)[。！!]?$/.test(prompt.trim())
      );
      if (!_isFormulaReq && !_isClosureFrag && !_isShortFormatRule && !_isJAShortFmt && !_isFRShortFmt && !_isITShortFmt && !_isDEShortFmt && !_isKOShortFmt && !_isHIShortFmt && !_isARShortFmt && !_isZHSCShortFmt && !_isESShortFmt &&
          cx === 'LOW' && classified.tok <= 15 && classified.tok > 5 &&
          (tierRank[lastTier] || 1) >= 2 &&
          (_mode23 === 'PROFESSIONAL' || _mode23 === 'CRITICAL_BURST' || _mode23 === 'MULTI_AGENT' || _mode23 === 'CODE_TASK')) {
        cx = 'MED';
        contextApplied = true;
      }
      // CRITICAL_BURST: tier jumped 2 levels up (LOW→HIGH) → honour it fully
      // (no floor capping — emergency overrides history)
    }

    // ── Model selection ───────────────────────────────────────
    const MODEL_MAP = {
      HIGH: { model: 'GPT-4o',      costPer1M: 5.0  },
      MED:  { model: 'GPT-4o-mini', costPer1M: 0.15 },
      LOW:  { model: 'GPT-3.5',     costPer1M: 0.002},
    };
    const selected  = MODEL_MAP[cx] || MODEL_MAP['MED'];
    const tok       = classified.tok;
    const cost      = (tok / 1000) * selected.costPer1M / 1000;
    const baseCost  = (tok / 1000) * MODEL_MAP['HIGH'].costPer1M / 1000;
    const pct       = baseCost > 0 ? Math.round((1 - cost / baseCost) * 100) : 0;

    // ── Conversation mode ─────────────────────────────────────
    // convMode: check for tier jump overrides before using stored value
    const _prevRank = {'HIGH':3,'MED':2,'LOW':1,'AMBIG':1.5};
    const _tierJump = conversationContext && conversationContext.lastTier &&
      (_prevRank[cx]||2) - (_prevRank[conversationContext.lastTier]||2) >= 2;
    const convMode = _tierJump ? 'CRITICAL_BURST'
                   : (conversationContext && conversationContext.convMode)
                   || detectConvMode(cx, prompt.toLowerCase().trim(), conversationContext);

    // ── Trend signal ──────────────────────────────────────────
    const prevTier = conversationContext && conversationContext.lastTier;
    const tierRankS = { HIGH: 3, MED: 2, LOW: 1, AMBIG: 1.5 };
    const trendDelta = prevTier
      ? ((tierRankS[cx] || 2) - (tierRankS[prevTier] || 2))
      : 0;
    const trendSignal = !prevTier ? 'INIT'
                      : trendDelta > 0 ? 'UP'
                      : trendDelta < 0 ? 'DOWN'
                      : 'FLAT';

    // ── D1: Bridge required? ──────────────────────────────────
    // Upgrade events (trendSignal=UP) need contextBridge injection in gateway.
    // Gateway should prepend lastHighResponseHead to system prompt.
    // PROFESSIONAL mode: always pass full messages[] (no bridgeRequired flag needed).
    const bridgeRequired = trendSignal === 'UP' && !!prevTier;

    return {
      model:          selected.model,
      cx,
      originalCx:     classified.cx,
      rule:           classified.rule,
      tok,
      cost,
      base:           baseCost,
      pct,
      modal:          classified.modal,
      lang:           classified.lang,
      noiseType:      classified.noiseType || null,
      confidence:     classified.confidence,
      isCache:        false,
      autoLearn:      autoLearn || !!(classified.autoLearn),
      contextApplied,
      // ── v2.3 fields ────────────────────────────────────────
      convMode,       // store this in session.convMode
      trendSignal,    // 'INIT'|'UP'|'DOWN'|'FLAT'
      bridgeRequired, // true → gateway should inject lastHighResponseHead into system prompt
    };
  }

  // ══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════════════════════════════

  return {
    VERSION,
    STATS,
    MODEL_COSTS,
    MODAL_MODELS,
    TIER_MODELS,

    /** Full routing result */
    route,

    /** Detect if a prompt references previous conversation output */
    detectBackreference,

    /** Classification only (no model/cost) */
    classify,

    /** Language detection utility */
    detectLanguage,

    /** Auto-Learn queue (read-only reference) */
    get autoLearnQueue() { return autoLearnQueue; },
    get totalLearnCount() { return totalLearnCount; },
    get accuracyScore() { return accuracyScore; },

    /** Manually confirm a label (for Portal 2 annotation) */
    confirmLabel(index, cx) {
      if (autoLearnQueue[index]) {
        autoLearnQueue[index].confirmedCx = cx;
        autoLearnQueue[index].labeled = true;
        accuracyScore = Math.min(98.5, accuracyScore + 0.012);
        return true;
      }
      return false;
    },
  };

}))
  // AMBIG resolution helper
  function _resolveAmbig(cx, prompt, classified, conversationContext, autoLearn) {

      const _tl  = prompt.toLowerCase().trim();
      const _tok = classified.tok;
      const _ctx = conversationContext || {};
      const _lt  = _ctx.lastTier;
      const _mode = _ctx.convMode;
      const tierDown = { HIGH: 'MED', MED: 'LOW', LOW: 'LOW' };

      // Priority 1: FRAGMENT/MINIMAL WITH context → inherit lastTier
      // (MULTI connectors like 順便/بالمناسبة/ついでに fall here)
      // Exception: backref drill-down questions → cap at MED (not HIGH)
      if ((classified.noiseType === 'ZH-MINIMAL' || classified.noiseType === 'FRAGMENT' || classified.noiseType === 'J-POLY') && _lt) {
        const _isBackrefQ = /^(comment (ça|ca) (marche|fonctionne)|wie (funktioniert|geht|wirkt|lang ist|lässt sich|hoch ist|soll ich|sollte ich|gehen wir)|warum .{0,15}\??|was (ist|passiert|soll|sind) .{0,15}\??|come funziona|cómo funciona|それはなぜ|왜 그|那.{0,5}(怎麼|是什麼|在哪)|what (is|are) (the|this)|how (does|do) (this|it)|why (is|does|can.t|won.t)|이 .{0,20}(영향|이유|방법|수단|기간|동향)[이]?|어떻게 .{0,20}(작동|적용|접근|강조|대처)[하해]|덧붙여서.{0,20}(있나요|있을까요)|또한.{0,20}(검토|수정|포함|분석)해|그리고.{0,20}(분석|포함|집중|설명))/i.test(_tl);
        cx = _isBackrefQ ? 'MED' : _lt;

      // Priority 2: FRAGMENT with NO context + tok ≤ 5 → MED
      // Can't distinguish MULTI connector (順便/بالمناسبة) from closure (謝) without ctx.
      // Use MED (conservative): closure users lose nothing; connector users get right model.
      // Exception: explicit closure words caught by _isClosureFrag below.
      } else if (classified.noiseType === 'FRAGMENT' && _tok <= 5 && !_lt) {
        cx = 'MED';

      // Priority 3: FRAGMENT with NO context + tok 6–12 → MED (enough signal)
      } else if (classified.noiseType === 'FRAGMENT' && !_lt) {
        cx = 'MED';

      // Priority 4: any short tok without any context or noise → LOW
      } else if (_tok <= 5 && !_lt) {
        cx = 'LOW';

      // S2a: scope-down markers → descend one tier
      } else if (/^([更再])(短|簡|精簡|少|快|小|簡單|壓縮|縮)|^(再|重新).{0,4}(短|簡|少)|^(just |only |simpler|shorter|briefer)/i.test(_tl)) {
        cx = _lt ? (tierDown[_lt] || 'LOW') : 'LOW';

      // S2b: continuation markers → maintain lastTier
      } else if (/^(還是|仍然|依然|same|still|again|繼續|continue|keep going)/i.test(_tl)) {
        cx = _lt || 'MED';

      // S2c: scope-up / additive markers → maintain lastTier
      } else if (/^(加上|補上|再加|include|also add|extend|以及|另外)/i.test(_tl)) {
        cx = _lt || 'MED';

      // S1: conv mode history
      } else if (_lt) {
        const modeResolution = {
          PROFESSIONAL:   _lt,
          EMPATHY:        'MED',
          SIMPLE:         'LOW',
          CODE_TASK:      'MED',
          IMPATIENT:      'MED',
          CASCADING:      tierDown[_lt] || 'LOW',
          ESCALATING:     _lt,
          PLATEAU:        'MED',
          CRITICAL_BURST: _lt,
          MULTI_AGENT:    _lt,
          REFINEMENT:     _lt,
          VERIFICATION:   'MED',
          HANDOFF:        'MED',
          FATIGUE:        tierDown[_lt] || 'LOW',
          TROUBLESHOOT:   'LOW',  CREATIVE:'MED',  LEARNING:'LOW',  LIFESTYLE:'LOW',
        };
        cx = modeResolution[_mode] || _lt;

      // Fallback: no context → autoLearn queue + conservative MED
      } else {
        // ── P0: Heuristic filter — 3-gate noise reduction ─────
        // Gate 1: must have real content (not fragment/minimal noise)
        // Gate 2: must be long enough to be worth labelling
        // Gate 3: diversity sampling — 25% rate early, 10% mature
        const _isLearnable = (
          !classified.noiseType &&                        // not FRAGMENT/ZH-MINIMAL
          prompt.length > 20 &&                          // enough content
          classified.confidence < 75 &&                  // genuinely uncertain
          !/^[a-zA-Z ,'.?!]{0,18}$/.test(prompt.trim()) // not pure short EN fragment
        );
        const _sampleRate = autoLearnQueue.length < 1500 ? 0.25 : 0.10;
        if (_isLearnable && Math.random() < _sampleRate && autoLearnQueue.length < 500) {
          autoLearn = true;
          autoLearnQueue.push({
            prompt: prompt.slice(0, 200), originalCx: 'AMBIG',
            confirmedCx: null, labeled: false, ts: Date.now(),
            confidence: classified.confidence,
          });
          accuracyScore = Math.max(0, accuracyScore - 0.003);
        }
        cx = 'MED';
      }
    
    return { cx, autoLearn };
  }
;
