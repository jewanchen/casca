// cascaio.com 語言切換 / 記住選擇的 jsdom 測試(2026-11-02 全站預設英文)。用法:NODE_PATH=<有 jsdom 的 node_modules> node tools/site-lang-test.cjs .
const {JSDOM}=require('jsdom'); const fs=require('fs'); const js=fs.readFileSync(process.argv[2]+'/site.js','utf8').split('location.replace(').join('window.__replace(').split('location.href=').join('window.__href=');
function run(path,lang,saved,click){ const dom=new JSDOM('<!doctype html><html data-lang="'+lang+'"><head><title>x</title></head><body><nav id="site-nav"></nav><h1 data-s="h">a</h1><footer id="site-footer"></footer></body></html>',{runScripts:'outside-only',url:'https://cascaio.com'+path});
  const w=dom.window; const store={}; if(saved) store['casca.lang']=saved;
  Object.defineProperty(w,'localStorage',{value:{getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=v;}}});
  let replaced=null, href=null; w.__replace=u=>{replaced=u;}; Object.defineProperty(w,'__href',{set:v=>{href=v;},get:()=>null}); 
  w.eval(js); w.CascaSite.init({str:{'zh-TW':{h:'中'},en:{h:'E'}}});
  if(click){ w.document.getElementById('site-lang').onclick(); }
  return {replaced,href,lang:w.CascaSite.lang(),h:w.document.querySelector('h1').textContent,btn:(w.document.getElementById('site-lang')||{}).textContent,nav:[...w.document.querySelectorAll('#site-nav a')].map(a=>a.getAttribute('href')).slice(0,4).join(' ')}; }
let pass=0,fail=0; const ok=(c,m,x)=>{ if(c)pass++; else{fail++; console.log('✗',m,JSON.stringify(x)); } };
let r=run('/','en',null,false); ok(!r.replaced&&r.lang==='en'&&r.h==='E'&&r.btn==='中文'&&r.nav.indexOf('/zh')<0,'T1 根頁無記憶 → 英文、按鈕「中文」、連結無前綴',r);
r=run('/','en','zh-TW',false); ok(r.replaced==='/zh/','T2 根頁記過中文 → replace 到 /zh/',r);
r=run('/aishutter/','en','zh-TW',false); ok(r.replaced==='/zh/aishutter/','T3 子頁記過中文 → /zh/aishutter/',r);
r=run('/zh/aishutter/','zh-TW','en',false); ok(!r.replaced&&r.lang==='zh-TW'&&r.h==='中'&&r.btn==='EN'&&r.nav.split(' ').every(h=>h.indexOf('/zh/')===0||h==='/gate/'),'T4 /zh/ 頁記過英文 → 不跳、中文、連結帶 /zh',r);
r=run('/zh/aishutter/','zh-TW',null,true); ok(r.href==='/aishutter/','T5 /zh/ 按 EN → /aishutter/',r);
r=run('/aishutter/support/','en',null,true); ok(r.href==='/zh/aishutter/support/','T6 根頁按中文 → /zh/aishutter/support/',r);
r=run('/gate/','zh-TW','zh-TW',false); ok(!r.replaced&&r.lang==='zh-TW','T7 gate(非 TWINS)不跳',r);
console.log('site-lang-test: PASS '+pass+' / FAIL '+fail);
