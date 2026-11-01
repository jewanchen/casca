#!/usr/bin/env node
// cascaio.com 預先渲染(SEO / GEO 包 1 + 包 2,2026-11-01)
// 問題:每頁正文都靠 /site.js 在瀏覽器裡把字串表填進 [data-s],不跑 JS 的爬蟲(GPTBot / ClaudeBot / PerplexityBot、LINE / Slack 預覽)看到空頁;
//       英文版只存在瀏覽器裡(同一個網址切換),搜尋引擎抓不到。
// 做法:用 jsdom 跑同一支 site.js,把 nav / footer / [data-s] 填好後寫回 HTML(zh-TW 寫回原檔;en 寫到 /en/ 下同路徑),
//       <html data-lang> 鎖定語言(site.js 配合),互相 hreflang;另補 canonical / og / twitter / JSON-LD。
// 可重複執行(idempotent)。用法:node tools/prerender.cjs [--check]   (需要 jsdom:NODE_PATH 指向裝了 jsdom 的 node_modules)
'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://cascaio.com';
const siteJs = fs.readFileSync(path.join(ROOT, 'site.js'), 'utf8');
const STORE = 'https://chromewebstore.google.com/detail/mhiefneljgjlecablgleapdpklpacehc';
const ORG = { '@type': 'Organization', name: 'Vast Intelligence Limited', alternateName: '皓品智慧有限公司', url: SITE + '/', logo: SITE + '/FullLogo_Transparent_NoBuffer.png', email: 'casca@vastitw.com', sameAs: ['https://github.com/jewanchen/casca'] };

// 每頁:路徑、og 圖、有沒有英文版、(可選)標題 / 描述覆寫、JSON-LD 種類
const PAGES = [
  { file: 'index.html', url: '/', og: '/og/home.png', en: true, ld: 'org' },
  { file: 'aishutter/index.html', url: '/aishutter/', og: '/og/aishutter.png', en: true, ld: 'app',
    title: { 'zh-TW': 'Casca AIShutter — 送出之前,先遮住。AI 的隱私快門', en: 'Casca AIShutter — Mask before you send. The privacy shutter for AI' } },
  { file: 'aishutter/support/index.html', url: '/aishutter/support/', og: '/og/aishutter.png', en: true },
  { file: 'aishutter/privacy/index.html', url: '/aishutter/privacy/', og: '/og/aishutter.png', en: false,
    desc: { 'zh-TW': 'Casca AIShutter 隱私權政策:所有偵測、遮蔽與還原都在你的電腦上完成;沒有伺服器、沒有帳號、不收集對話內容,對照表以你的金鑰加密保存在本機。' } },
  { file: 'gate/index.html', url: '/gate/', og: '/og/gate.png', en: false },   // gate 正文是寫死的中文 HTML,沒有英文版可出
  { file: 'airoute/index.html', url: '/airoute/', og: '/og/airoute.png', en: true },
];
const TWINS = PAGES.filter(p => p.en).map(p => p.url);   // 與 site.js 的 TWINS 一致

function balanced(src, start, open, close) { // 取平衡括號區段(跳過字串字面值)
  let depth = 0, q = null; for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === open) depth++; else if (c === close) { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced from ' + start);
}
function initArgs(html, win) { // 從頁內 <script> 找 var STR={…} 與 CascaSite.init({…}) 的參數
  for (const m of html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const s = m[1], ci = s.indexOf('CascaSite.init('); if (ci < 0) continue;
    const argText = balanced(s, s.indexOf('(', ci), '(', ')').slice(1, -1);
    let pre = ''; const si = s.indexOf('var STR='); if (si >= 0) pre = 'var STR=' + balanced(s, s.indexOf('{', si), '{', '}') + ';';
    return win.eval('(function(){' + pre + 'return (' + argText + ');})()');
  }
  return null;
}
function setMeta(doc, sel, attrs) { let el = doc.head.querySelector(sel); if (!el) { el = doc.createElement(attrs.tag || 'meta'); doc.head.appendChild(el); } for (const [k, v] of Object.entries(attrs)) if (k !== 'tag') el.setAttribute(k, v); return el; }
function getMeta(doc, sel) { const el = doc.head.querySelector(sel); return el ? el.getAttribute('content') : ''; }
const text = el => (el ? el.textContent : '').replace(/\s+/g, ' ').trim();

function render(p, lang) {
  const src = path.join(ROOT, p.file), html = fs.readFileSync(src, 'utf8');
  const url = (lang === 'en' ? '/en' : '') + p.url, outFile = lang === 'en' ? path.join(ROOT, 'en', p.file) : src;
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: SITE + p.url, pretendToBeVisual: true });
  const { window: win } = dom, doc = win.document, de = doc.documentElement;
  de.setAttribute('data-lang', lang);                      // site.js 讀這個鎖語言(也決定 nav 連結前綴)
  const args = initArgs(html, win);
  if (args) { win.eval(siteJs); win.CascaSite.init(args); } // 跑真的 site.js:nav / footer / [data-s] / <html lang> / pageTitle
  else if (doc.getElementById('site-nav')) throw new Error(p.file + ': 找不到 CascaSite.init');
  de.lang = lang === 'en' ? 'en' : 'zh-Hant';
  // 英文版:相對路徑補成絕對(gate 的 sdk/…)、站內連結指到 /en/ 對應頁
  if (lang === 'en') {
    const dir = p.url;
    doc.querySelectorAll('[src],[href]').forEach(el => {
      const attr = el.hasAttribute('src') ? 'src' : 'href', v = el.getAttribute(attr) || '';
      if (/^(https?:|\/|#|mailto:|tel:|data:|javascript:)/i.test(v) || v === '') return;
      el.setAttribute(attr, dir + v);
    });
    doc.body.querySelectorAll('a[href]').forEach(a => {
      const v = a.getAttribute('href'), m = v.match(/^(\/[a-z/-]*)(#.*)?$/); if (!m) return;
      if (TWINS.includes(m[1])) a.setAttribute('href', '/en' + m[1] + (m[2] || ''));
    });
  }
  // 標題 / 描述:指定覆寫 > site.js 的 pageTitle/pageDesc > 原檔;英文版沒有 pageDesc 時用英文 heroLead
  if (p.title && p.title[lang]) doc.title = p.title[lang];
  if (p.desc && p.desc[lang]) setMeta(doc, 'meta[name="description"]', { name: 'description', content: p.desc[lang] });
  if (lang === 'en' && args && args.str && args.str.en) {
    const en = args.str.en;
    if (!en.pageDesc && en.heroLead) setMeta(doc, 'meta[name="description"]', { name: 'description', content: en.heroLead });
    if (!en.pageTitle && !(p.title && p.title.en)) { const h1 = text(doc.body.querySelector('h1')); if (/[\u4e00-\u9fff]/.test(doc.title) && h1 && !/[\u4e00-\u9fff]/.test(h1)) doc.title = h1 + ' — Casca'; }
    if (/[\u4e00-\u9fff]/.test(getMeta(doc, 'meta[name="description"]'))) { const para = [...doc.body.querySelectorAll('p')].map(text).find(t => t.length >= 60 && !/[\u4e00-\u9fff]/.test(t)); if (para) setMeta(doc, 'meta[name="description"]', { name: 'description', content: para.slice(0, 180) }); }
  }
  const title = doc.title, desc = getMeta(doc, 'meta[name="description"]');
  // 社群 / 搜尋標籤
  setMeta(doc, 'link[rel="canonical"]', { tag: 'link', rel: 'canonical', href: SITE + url });
  doc.head.querySelectorAll('link[rel="alternate"][hreflang]').forEach(l => l.remove());
  if (p.en) { // 互指:zh-Hant / en / x-default(= en;site內對非中文瀏覽器的預設就是英文)
    for (const [hl, href] of [['zh-Hant', SITE + p.url], ['en', SITE + '/en' + p.url], ['x-default', SITE + '/en' + p.url]]) {
      const l = doc.createElement('link'); l.setAttribute('rel', 'alternate'); l.setAttribute('hreflang', hl); l.setAttribute('href', href); doc.head.appendChild(l);
    }
  }
  const ogT = lang === 'en' ? title : (getMeta(doc, 'meta[property="og:title"]') || title);
  const ogD = lang === 'en' ? desc : (getMeta(doc, 'meta[property="og:description"]') || desc);
  setMeta(doc, 'meta[property="og:title"]', { property: 'og:title', content: ogT });
  setMeta(doc, 'meta[property="og:description"]', { property: 'og:description', content: ogD });
  setMeta(doc, 'meta[property="og:type"]', { property: 'og:type', content: 'website' });
  setMeta(doc, 'meta[property="og:url"]', { property: 'og:url', content: SITE + url });
  setMeta(doc, 'meta[property="og:site_name"]', { property: 'og:site_name', content: 'Casca' });
  setMeta(doc, 'meta[property="og:locale"]', { property: 'og:locale', content: lang === 'en' ? 'en_US' : 'zh_TW' });
  setMeta(doc, 'meta[property="og:image"]', { property: 'og:image', content: SITE + p.og });
  setMeta(doc, 'meta[property="og:image:width"]', { property: 'og:image:width', content: '1200' });
  setMeta(doc, 'meta[property="og:image:height"]', { property: 'og:image:height', content: '630' });
  setMeta(doc, 'meta[name="twitter:card"]', { name: 'twitter:card', content: 'summary_large_image' });
  setMeta(doc, 'meta[name="twitter:title"]', { name: 'twitter:title', content: ogT });
  setMeta(doc, 'meta[name="twitter:description"]', { name: 'twitter:description', content: ogD });
  setMeta(doc, 'meta[name="twitter:image"]', { name: 'twitter:image', content: SITE + p.og });
  // JSON-LD(文字全取自頁面本身;先清掉舊的再放)
  doc.head.querySelectorAll('script[type="application/ld+json"][data-prerender]').forEach(s => s.remove());
  const lds = [];
  if (p.ld === 'org') lds.push({ '@context': 'https://schema.org', ...ORG, description: desc });
  if (p.ld === 'app') {
    lds.push({ '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Casca AIShutter', url: SITE + url, description: desc,
      applicationCategory: 'SecurityApplication', operatingSystem: 'Windows, Chrome', inLanguage: lang === 'en' ? 'en' : 'zh-Hant',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }, downloadUrl: STORE, installUrl: STORE, publisher: ORG, image: SITE + p.og });
    const faq = []; doc.querySelectorAll('[data-s^="q"]').forEach(q => { const k = q.getAttribute('data-s'), a = doc.querySelector('[data-s="a' + k.slice(1) + '"]'); if (/^q\d+$/.test(k) && a && text(q) && text(a)) faq.push({ '@type': 'Question', name: text(q), acceptedAnswer: { '@type': 'Answer', text: text(a) } }); });
    if (faq.length) lds.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq });
  }
  for (const ld of lds) { const s = doc.createElement('script'); s.type = 'application/ld+json'; s.setAttribute('data-prerender', '1'); s.textContent = JSON.stringify(ld); doc.head.appendChild(s); }
  const out = '<!doctype html>\n' + de.outerHTML;   // 不加尾端換行:重跑時 parser 會把它塞進 body,就不 idempotent 了
  const body = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
  const han = (body.match(/[一-鿿]/g) || []).length, words = (body.match(/[A-Za-z]{3,}/g) || []).length, h1 = text(doc.body.querySelector('h1'));
  const prev = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null, same = out === prev;
  console.log(`${same ? '=' : '*'} ${(url).padEnd(24)} han ${String(han).padStart(5)} words ${String(words).padStart(5)} ld ${lds.length} h1 "${h1.slice(0, 36)}" title "${title.slice(0, 64)}"`);
  return { out, outFile, same };
}

const check = process.argv.includes('--check'); let changed = 0;
const jobs = [];
for (const p of PAGES) { jobs.push([p, 'zh-TW']); if (p.en) jobs.push([p, 'en']); }
// zh 先算(原檔),en 從原檔算;兩者都以「原檔目前內容」為輸入,所以 zh 寫回後再跑一次結果相同
const results = jobs.map(([p, lang]) => render(p, lang));
for (const r of results) if (!r.same) { changed++; if (!check) { fs.mkdirSync(path.dirname(r.outFile), { recursive: true }); fs.writeFileSync(r.outFile, r.out); } }
console.log(check ? `check: ${changed} file(s) would change` : `wrote ${changed} file(s)`);
