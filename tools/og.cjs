#!/usr/bin/env node
// 產生分享用 og:image(1200×630)→ /og/*.png。用法:node tools/og.cjs(需要本機 Google Chrome)
// 文案全部取自各頁既有的標題 / 副標,不另寫新口徑。
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'og'); fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CARDS = {
  home: { k: 'Casca', h: 'Your Stack. Your data.\nAny LLM.', p: 'AI 路由基礎設施:AI Route 省 30–75%、Gate 讓 AI 進得了銀行稽核、AIShutter 把機密留在你的電腦。', u: 'cascaio.com', c: '#2563AD' },
  aishutter: { k: 'Casca AIShutter', h: '送出之前,\n先遮住。', p: 'AI 的隱私快門。在你的電腦上偵測、確認、遮蔽;回答在本機還原。零後端、零遙測。', u: 'cascaio.com/aishutter', c: '#E6322B' },
  gate: { k: 'Casca Gate', h: '讓 AI 進得了銀行,\n先讓它進得了稽核。', p: '銀行機房 LLM 管制閘道:個資進閘前當場遮罩、每筆調用留下可匯出的稽核軌跡。', u: 'cascaio.com/gate', c: '#2563AD' },
  airoute: { k: 'Casca AI Route', h: '省 30–75% LLM 費用,\n改一行程式碼。', p: '研究背書的路由引擎,每個請求 1 毫秒內分級送到合適的模型,品質 SLA 寫在合約裡。', u: 'cascaio.com/airoute', c: '#2563AD' },
};
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
for (const [name, c] of Object.entries(CARDS)) {
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><style>
html,body{margin:0;width:1200px;height:630px;overflow:hidden}
body{font-family:'Noto Sans TC','PingFang TC','Microsoft JhengHei','Inter',-apple-system,sans-serif;background:#16242E;color:#F7F8FA;position:relative}
.bar{position:absolute;left:0;top:0;bottom:0;width:18px;background:${c.c}}
.k{position:absolute;left:84px;top:72px;font-size:28px;letter-spacing:.14em;text-transform:uppercase;color:#BFD0EA;font-weight:700}
.h{position:absolute;left:84px;top:150px;width:1040px;font-size:84px;line-height:1.12;font-weight:900;letter-spacing:-.01em;white-space:pre-line}
.p{position:absolute;left:84px;top:392px;width:980px;font-size:30px;line-height:1.5;color:#DCE5F3}
.u{position:absolute;left:84px;bottom:56px;font-size:26px;color:#8FA3C4;font-family:Menlo,Consolas,monospace}
.m{position:absolute;right:84px;bottom:48px;width:56px;height:56px;border-radius:50%;background:${c.c}}
.m::after{content:"";position:absolute;left:18px;top:18px;width:20px;height:20px;border-radius:50%;background:#fff}
</style></head><body><div class="bar"></div><div class="k">${esc(c.k)}</div><div class="h">${esc(c.h)}</div><div class="p">${esc(c.p)}</div><div class="u">${c.u}</div><div class="m"></div></body></html>`;
  const tmp = path.join(require('os').tmpdir(), `og-${name}.html`); fs.writeFileSync(tmp, html);
  const png = path.join(OUT, `${name}.png`);
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1200,630', '--force-device-scale-factor=1', `--screenshot=${png}`, 'file://' + tmp], { stdio: 'ignore' });
  console.log(name, Math.round(fs.statSync(png).size / 1024) + ' KB');
}
