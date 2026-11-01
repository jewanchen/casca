#!/usr/bin/env node
// cascaio.com 預先渲染(SEO / GEO 包 1,2026-11-01)
// 問題:每頁正文都靠 /site.js 在瀏覽器裡把字串表填進 [data-s],不跑 JS 的爬蟲(GPTBot / ClaudeBot / PerplexityBot、LINE / Slack 預覽)看到空頁。
// 做法:用 jsdom 跑同一支 site.js(語言鎖 zh-TW),把 nav / footer / [data-s] 填好後寫回 HTML;瀏覽器端 site.js 照常執行,
//       同樣的字再套一次(無副作用),使用者切 EN 仍然可用。另補 canonical / og:image / twitter card / og:locale。
// 可重複執行(idempotent)。用法:node tools/prerender.cjs [--check]   (需要 jsdom:NODE_PATH 指向裝了 jsdom 的 node_modules)
'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://cascaio.com';
const siteJs = fs.readFileSync(path.join(ROOT, 'site.js'), 'utf8');

// 每頁:路徑、og 圖、(可選)標題 / 描述覆寫
const PAGES = [
  { file: 'index.html', url: '/', og: '/og/home.png' },
  { file: 'aishutter/index.html', url: '/aishutter/', og: '/og/aishutter.png', title: 'Casca AIShutter — 送出之前,先遮住。AI 的隱私快門' },
  { file: 'aishutter/support/index.html', url: '/aishutter/support/', og: '/og/aishutter.png' },
  { file: 'aishutter/privacy/index.html', url: '/aishutter/privacy/', og: '/og/aishutter.png',
    desc: 'Casca AIShutter 隱私權政策:所有偵測、遮蔽與還原都在你的電腦上完成;沒有伺服器、沒有帳號、不收集對話內容,對照表以你的金鑰加密保存在本機。' },
  { file: 'gate/index.html', url: '/gate/', og: '/og/gate.png' },
  { file: 'airoute/index.html', url: '/airoute/', og: '/og/airoute.png' },
];

// 取平衡括號區段(跳過字串字面值),從 src[start] 的開括號起
function balanced(src, start, open, close) {
  let depth = 0, q = null; for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === open) depth++; else if (c === close) { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced from ' + start);
}
// 從頁內 <script> 找 var STR={…} 與 CascaSite.init({…}) 的參數
function initArgs(html, win) {
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const s of scripts) {
    const ci = s.indexOf('CascaSite.init('); if (ci < 0) continue;
    const argText = balanced(s, s.indexOf('(', ci), '(', ')').slice(1, -1);
    let pre = '';
    const si = s.indexOf('var STR='); if (si >= 0) pre = 'var STR=' + balanced(s, s.indexOf('{', si), '{', '}') + ';';
    return win.eval('(function(){' + pre + 'return (' + argText + ');})()');
  }
  return null;
}
function setMeta(doc, sel, attrs) { let el = doc.head.querySelector(sel); if (!el) { el = doc.createElement(attrs.tag || 'meta'); doc.head.appendChild(el); } for (const [k, v] of Object.entries(attrs)) if (k !== 'tag') el.setAttribute(k, v); return el; }

const check = process.argv.includes('--check'); let changed = 0;
for (const p of PAGES) {
  const fp = path.join(ROOT, p.file); const html = fs.readFileSync(fp, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: SITE + p.url, pretendToBeVisual: true });
  const { window: win } = dom, doc = win.document;
  try { win.localStorage.setItem('casca.lang', 'zh-TW'); } catch (e) {}
  const args = initArgs(html, win);
  if (args) { win.eval(siteJs); win.CascaSite.init(args); }   // 跑真的 site.js:nav / footer / [data-s] / <html lang>
  else if (doc.getElementById('site-nav')) throw new Error(p.file + ': 找不到 CascaSite.init');
  // head 補強(有就不動,沒有才加;title / desc 覆寫只在指定頁)
  if (p.title) doc.title = p.title;
  if (p.desc) setMeta(doc, 'meta[name="description"]', { name: 'description', content: p.desc });
  const title = doc.title, desc = (doc.head.querySelector('meta[name="description"]') || {}).getAttribute?.('content') || '';
  setMeta(doc, 'link[rel="canonical"]', { tag: 'link', rel: 'canonical', href: SITE + p.url });
  setMeta(doc, 'meta[property="og:title"]', { property: 'og:title', content: doc.head.querySelector('meta[property="og:title"]')?.getAttribute('content') || title });
  setMeta(doc, 'meta[property="og:description"]', { property: 'og:description', content: doc.head.querySelector('meta[property="og:description"]')?.getAttribute('content') || desc });
  setMeta(doc, 'meta[property="og:type"]', { property: 'og:type', content: 'website' });
  setMeta(doc, 'meta[property="og:url"]', { property: 'og:url', content: SITE + p.url });
  setMeta(doc, 'meta[property="og:site_name"]', { property: 'og:site_name', content: 'Casca' });
  setMeta(doc, 'meta[property="og:locale"]', { property: 'og:locale', content: 'zh_TW' });
  setMeta(doc, 'meta[property="og:image"]', { property: 'og:image', content: SITE + p.og });
  setMeta(doc, 'meta[property="og:image:width"]', { property: 'og:image:width', content: '1200' });
  setMeta(doc, 'meta[property="og:image:height"]', { property: 'og:image:height', content: '630' });
  setMeta(doc, 'meta[name="twitter:card"]', { name: 'twitter:card', content: 'summary_large_image' });
  setMeta(doc, 'meta[name="twitter:title"]', { name: 'twitter:title', content: doc.head.querySelector('meta[property="og:title"]').getAttribute('content') });
  setMeta(doc, 'meta[name="twitter:description"]', { name: 'twitter:description', content: doc.head.querySelector('meta[property="og:description"]').getAttribute('content') });
  setMeta(doc, 'meta[name="twitter:image"]', { name: 'twitter:image', content: SITE + p.og });
  const out = '<!doctype html>\n' + doc.documentElement.outerHTML;   // 不加尾端換行:重跑時 parser 會把它塞進 body,就不 idempotent 了
  // 統計:爬蟲看得到的正文字數(去 script / style)
  const body = out.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ');
  const han = (body.match(/[一-鿿]/g) || []).length, h1 = (doc.body.querySelector('h1') || {}).textContent || '';
  const same = out === html;
  console.log(`${same ? '=' : '*'} ${p.file.padEnd(32)} han ${String(han).padStart(5)}  h1 "${h1.replace(/\s+/g, ' ').trim().slice(0, 40)}"  title "${title.slice(0, 60)}"`);
  if (!same) { changed++; if (!check) fs.writeFileSync(fp, out); }
}
console.log(check ? `check: ${changed} page(s) would change` : `wrote ${changed} page(s)`);
