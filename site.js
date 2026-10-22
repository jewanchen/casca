/* cascaio.com 共用導覽 / 頁尾 / 語言切換(2026-10-22 改版 A 段)。
   用法:頁面放 <nav id="site-nav"></nav> 與 <footer id="site-footer"></footer>,載入 /site.js 後呼叫
   CascaSite.init({ str:{ 'zh-TW':{...}, en:{...} }, current:'airoute'|'gate'|'aishutter'|'home', cta:{href,s} })
   → 頁面自己的字句表與站台字句表合併,[data-s] 全部套用;語言存 localStorage 'casca.lang'(與舊 'shutter.lang' 相容)。 */
(function(){
'use strict';
var SITE={
 'zh-TW':{nAiroute:'AI Route',nGate:'Gate',nAishutter:'AIShutter',nEnterprise:'企業',nDocs:'文件',nContact:'聯絡',nLogin:'登入',nStart:'免費開始',
  fTag:'Your Stack. Your data. Any LLM. — AI 路由基礎設施,台北與香港。',fProduct:'產品',fResources:'資源',fCompany:'公司',
  fRoute:'AI Route(路由與省錢)',fGate:'Gate(管制閘道)',fShutter:'AIShutter(隱私快門)',fDocs:'API 文件',fDash:'儀表板',fStatus:'服務狀態',
  fPaper:'技術論文(Zenodo DOI)',fGithub:'GitHub',fIssues:'問題回報',fLinkedin:'創辦人 LinkedIn',fShutterSupport:'AIShutter 支援',
  fContact:'聯絡我們',fPress:'媒體',fPrivacy:'隱私權政策',fTerms:'服務條款',fDpa:'資料處理協議(DPA)',fMade:'台北製作。'},
 en:{nAiroute:'AI Route',nGate:'Gate',nAishutter:'AIShutter',nEnterprise:'Enterprise',nDocs:'Docs',nContact:'Contact',nLogin:'Log in',nStart:'Start free',
  fTag:'Your Stack. Your data. Any LLM. — AI routing infrastructure, Taipei & Hong Kong.',fProduct:'Products',fResources:'Resources',fCompany:'Company',
  fRoute:'AI Route (routing & savings)',fGate:'Gate (governance gateway)',fShutter:'AIShutter (privacy shutter)',fDocs:'API docs',fDash:'Dashboard',fStatus:'Status',
  fPaper:'Technical paper (Zenodo DOI)',fGithub:'GitHub',fIssues:'Issue tracker',fLinkedin:'Founder on LinkedIn',fShutterSupport:'AIShutter support',
  fContact:'Contact',fPress:'Press',fPrivacy:'Privacy policy',fTerms:'Terms of service',fDpa:'Data processing agreement (DPA)',fMade:'Made in Taipei.'}
};
var LOGO='/FullLogo_Transparent_NoBuffer.png';
var S={lang:'zh-TW',str:{},cur:''};
function t(k){ var p=S.str[S.lang]||{}, q=S.str.en||{}; return (p[k]!=null?p[k]:(q[k]!=null?q[k]:(SITE[S.lang]&&SITE[S.lang][k])||SITE.en[k]||'')); }
function esc(s){ return String(s).replace(/[&<>"]/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function navHtml(o){ var on=function(k){ return S.cur===k?' class="on"':''; };
  var cta=o.cta||{href:'/casca-dashboard.html#signup',s:'nStart'};
  return '<div class="wrap"><a class="logo" href="/"><span class="mark" aria-hidden="true">C</span><span>Casca</span></a>'+
   '<div class="links" id="site-links"><a href="/airoute/"'+on('airoute')+' data-s="nAiroute"></a><a href="/gate/"'+on('gate')+' data-s="nGate"></a><a href="/aishutter/"'+on('aishutter')+' data-s="nAishutter"></a><a href="/#enterprise" data-s="nEnterprise"></a><a href="/casca-api-docs.html" data-s="nDocs"></a><a href="/#contact" data-s="nContact"></a></div>'+
   '<div class="cta"><button class="langsw" id="site-lang" type="button">EN</button><button class="navtoggle" id="site-toggle" type="button" aria-label="menu">☰</button><a class="btn ghost small" href="/casca-dashboard.html" data-s="nLogin" style="display:none" id="site-login"></a><a class="btn primary small" href="'+esc(cta.href)+'"'+(cta.target?' target="_blank" rel="noopener"':'')+' data-s="'+esc(cta.s)+'"></a></div></div>'; }
function footHtml(){ return '<div class="wrap">'+
   '<div><a class="logo" href="/" style="margin-bottom:10px"><span class="mark" aria-hidden="true">C</span><span>Casca</span></a><p data-s="fTag"></p><p style="margin-top:10px">Vast Intelligence Limited<br>+886 2 2706 7590<br>casca@vastitw.com</p></div>'+
   '<div><h4 data-s="fProduct"></h4><ul><li><a href="/airoute/" data-s="fRoute"></a></li><li><a href="/gate/" data-s="fGate"></a></li><li><a href="/aishutter/" data-s="fShutter"></a></li><li><a href="/casca-api-docs.html" data-s="fDocs"></a></li><li><a href="/casca-dashboard.html" data-s="fDash"></a></li><li><a href="https://casca-production.up.railway.app/health" target="_blank" rel="noopener" data-s="fStatus"></a></li></ul></div>'+
   '<div><h4 data-s="fResources"></h4><ul><li><a href="https://github.com/jewanchen/casca/blob/main/casca-technical-article.md" target="_blank" rel="noopener" data-s="fPaper"></a></li><li><a href="https://github.com/jewanchen/casca" target="_blank" rel="noopener" data-s="fGithub"></a></li><li><a href="https://github.com/jewanchen/casca/issues" target="_blank" rel="noopener" data-s="fIssues"></a></li><li><a href="/aishutter/support/" data-s="fShutterSupport"></a></li><li><a href="https://www.linkedin.com/in/jeremy-chen-50994760" target="_blank" rel="noopener" data-s="fLinkedin"></a></li></ul></div>'+
   '<div><h4 data-s="fCompany"></h4><ul><li><a href="mailto:casca@vastitw.com" data-s="fContact"></a></li><li><a href="mailto:casca@vastitw.com?subject=Press%20inquiry" data-s="fPress"></a></li><li><a href="/aishutter/privacy/" data-s="fPrivacy"></a></li><li><a href="mailto:casca@vastitw.com?subject=Terms%20of%20Service%20request" data-s="fTerms"></a></li><li><a href="mailto:casca@vastitw.com?subject=DPA%20request" data-s="fDpa"></a></li></ul></div>'+
   '<div class="copy"><span>© 2026 Vast Intelligence Limited(皓品智慧有限公司). All rights reserved.</span><span data-s="fMade"></span></div></div>'; }
function apply(){ document.querySelectorAll('[data-s]').forEach(function(el){ var k=el.getAttribute('data-s'), s=t(k); if(s.indexOf('\n')>=0&&/^H[1-3]$/.test(el.tagName)){ el.innerHTML=''; s.split('\n').forEach(function(line,i){ if(i) el.appendChild(document.createElement('br')); el.appendChild(document.createTextNode(line)); }); } else el.textContent=s; });
  document.documentElement.lang=S.lang==='en'?'en':'zh-Hant'; var b=document.getElementById('site-lang'); if(b) b.textContent=S.lang==='en'?'中文':'EN';
  var tt=t('pageTitle'); if(tt) document.title=tt; var md=document.querySelector('meta[name="description"]'); var dd=t('pageDesc'); if(md&&dd) md.setAttribute('content',dd); }
function init(o){ o=o||{}; S.str=o.str||{}; S.cur=o.current||'';
  try{ S.lang=localStorage.getItem('casca.lang')||localStorage.getItem('shutter.lang')||((navigator.language||'').indexOf('zh')===0?'zh-TW':'en'); }catch(e){}
  var n=document.getElementById('site-nav'), f=document.getElementById('site-footer'); if(n){ n.className='site'; n.innerHTML=navHtml(o); } if(f){ f.className='site'; f.innerHTML=footHtml(); }
  var lb=document.getElementById('site-lang'); if(lb) lb.onclick=function(){ S.lang=S.lang==='en'?'zh-TW':'en'; try{ localStorage.setItem('casca.lang',S.lang); localStorage.setItem('shutter.lang',S.lang); }catch(e){} apply(); };
  var tg=document.getElementById('site-toggle'); if(tg) tg.onclick=function(){ var l=document.getElementById('site-links'); if(l) l.classList.toggle('open'); };
  apply();
  if('IntersectionObserver' in window&&window.matchMedia('(prefers-reduced-motion: no-preference)').matches){ var io=new IntersectionObserver(function(es){ es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.remove('pre'); io.unobserve(e.target); } }); },{threshold:.15}); document.querySelectorAll('[data-reveal]').forEach(function(el){ el.classList.add('reveal','pre'); io.observe(el); }); }
  return {t:t,apply:apply,lang:function(){ return S.lang; }}; }
window.CascaSite={init:init,t:t,apply:apply,lang:function(){ return S.lang; }};
})();
