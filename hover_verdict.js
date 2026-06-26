// ==UserScript==
// @name         Hover Link Verdict
// @namespace    wilbeibi
// @version      0.3.1
// @description  Hover a link, get a fast "should I click this?" verdict. Instant URL layer -> head fetch -> gated LLM one-liner. No screenshots. LLM via any OpenAI-compatible endpoint (DeepSeek by default), configured the same way as the inline translator.
// @author       wilbeibi
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // ---- config ------------------------------------------------------------
  const T_FETCH   = 300;   // ms dwell before kicking the head fetch
  const T_SHOW    = 600;   // ms dwell before revealing the card
  const T_VERDICT = 1500;  // ms dwell before summarizing weak/missing metadata
  const T_DEEPER  = 2400;  // ms dwell before replacing decent metadata with a summary
  const T_HIDE    = 180;   // grace period on leave
  const WEAK_DESC = 55;    // descriptions shorter than this are "weak" -> verdict eligible
  const BODY_CAP  = 6000;  // chars of body text sent to the model

  // LLM endpoint. Same model/keys mechanism as the inline translator: the URL
  // is the full OpenAI-compatible /chat/completions endpoint, the key is a
  // bearer token. Configure via the Tampermonkey menu (or point API_URL at
  // your `toll` proxy). With no key set, Tiers 0+1 still work; Tier 2 is off.
  const DEFAULT_URL   = 'https://api.deepseek.com/v1/chat/completions';
  const DEFAULT_MODEL = 'deepseek-chat';   // DeepSeek's fast non-reasoning model

  function getConfig() {
    return {
      key:   String(GM_getValue('API_KEY', '') || '').trim(),
      url:   String(GM_getValue('API_URL', DEFAULT_URL) || '').trim(),
      model: String(GM_getValue('MODEL', DEFAULT_MODEL) || '').trim(),
    };
  }
  function llmEnabled() { return !!getConfig().key; }

  const REDIRECTORS = new Set(['t.co','bit.ly','lnkd.in','buff.ly','ow.ly','goo.gl','tinyurl.com','dlvr.it']);
  const PAYWALLS    = new Set(['nytimes.com','wsj.com','ft.com','bloomberg.com','economist.com','medium.com','theinformation.com']);

  const mem = new Map(); // url -> {tier1?, verdict?}

  // ---- persistent verdict cache (GM storage, TTL + capped) ---------------
  const V_TTL = 14 * 864e5; // 14 days
  const V_CAP = 600;        // max persisted verdicts before pruning

  function vGet(url) {
    try {
      const raw = GM_getValue('v:' + url, null);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (Date.now() - (o.ts || 0) > V_TTL) { GM_deleteValue('v:' + url); return null; }
      return o.v || null;
    } catch (e) { return null; }
  }
  function vPut(url, v) {
    try { GM_setValue('v:' + url, JSON.stringify({ v, ts: Date.now() })); } catch (e) {}
    if (Math.random() < 0.05) vPrune();
  }
  function vPrune() {
    try {
      const keys = GM_listValues().filter(k => k.startsWith('v:'));
      if (keys.length <= V_CAP) return;
      const items = keys.map(k => {
        let ts = 0;
        try { ts = JSON.parse(GM_getValue(k, '{}')).ts || 0; } catch (e) {}
        return [k, ts];
      }).sort((a, b) => a[1] - b[1]);
      const keep = Math.floor(V_CAP * 0.8);
      for (let i = 0; i < items.length - keep; i++) GM_deleteValue(items[i][0]);
    } catch (e) {}
  }

  // ---- styles ------------------------------------------------------------
  GM_addStyle(`
    #hlv { --hlv-bg:#23262b; --hlv-fg:#e9edf2; --hlv-title:#fff; --hlv-muted:#a4adb8;
      --hlv-desc:#c7cdd6; --hlv-ai:#d5deec; --hlv-ai-label:#93a4c4; --hlv-border:#3a4049;
      --hlv-shadow:0 10px 22px rgba(0,0,0,.36); --hlv-tag-bg:#303640; --hlv-tag-fg:#c5ccd6;
      --hlv-wall-bg:#45282c; --hlv-wall-fg:#f0adb6; --hlv-redirect:#d7d66f;
      position:fixed; z-index:2147483646; max-width:min(340px, calc(100vw - 16px)); width:max-content;
      background:var(--hlv-bg); color:var(--hlv-fg); border:1px solid var(--hlv-border); border-radius:9px;
      box-shadow:var(--hlv-shadow); font:13px/1.45 system-ui,-apple-system,sans-serif;
      opacity:0; transform:translateY(3px); transition:opacity .1s,transform .1s; pointer-events:none; }
    #hlv.hlv-light { --hlv-bg:#fff; --hlv-fg:#202328; --hlv-title:#111318; --hlv-muted:#5b6470;
      --hlv-desc:#343a43; --hlv-ai:#25334b; --hlv-ai-label:#526a9c; --hlv-border:#d8dde5;
      --hlv-shadow:0 8px 18px rgba(15,23,42,.16); --hlv-tag-bg:#edf1f7; --hlv-tag-fg:#4b5563;
      --hlv-wall-bg:#fff0f2; --hlv-wall-fg:#9f2636; --hlv-redirect:#747200; }
    #hlv.on { opacity:1; transform:none; }
    #hlv.updating .row { opacity:.38; }
    #hlv .row { display:flex; gap:8px; padding:9px 11px; transition:opacity .12s ease; }
    #hlv .ico { width:16px; height:16px; border-radius:3px; flex:0 0 auto; margin-top:1px; }
    #hlv .col { min-width:0; }
    #hlv .ttl, #hlv .meta, #hlv .desc { overflow-wrap:anywhere; }
    #hlv .ttl { font-weight:600; color:var(--hlv-title); }
    #hlv .meta { color:var(--hlv-muted); font-size:12px; margin-top:1px; }
    #hlv .meta b { color:var(--hlv-redirect); font-weight:600; }       /* redirect target */
    #hlv .desc { color:var(--hlv-desc); margin-top:5px; }
    #hlv .desc.ai { color:var(--hlv-ai); }
    #hlv .desc.ai::before { content:"verdict · "; color:var(--hlv-ai-label); }
    #hlv .thumb { width:54px; height:54px; object-fit:cover; border-radius:5px; flex:0 0 auto; background:#000; }
    #hlv .tag { display:inline-block; font-size:11px; padding:0 5px; border-radius:4px; background:var(--hlv-tag-bg); color:var(--hlv-tag-fg); margin-left:6px; }
    #hlv .tag.wall { background:var(--hlv-wall-bg); color:var(--hlv-wall-fg); }

    .hlv-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:2147483647;
      display:flex; align-items:center; justify-content:center; }
    .hlv-modal { background:#1e1e1e; color:#ddd; border-radius:10px; padding:24px; width:380px;
      max-width:90vw; box-shadow:0 8px 32px rgba(0,0,0,.4);
      font:13px/1.45 system-ui,-apple-system,sans-serif; }
    .hlv-modal h3 { margin:0 0 16px; font-size:15px; font-weight:600; }
    .hlv-modal label { display:block; font-size:12px; color:#aaa; margin-bottom:4px; }
    .hlv-modal input { width:100%; box-sizing:border-box; padding:7px 10px; border:1px solid #444;
      border-radius:6px; font-size:13px; margin-bottom:12px; background:#2a2a2a; color:#ddd; }
    .hlv-modal input:focus { outline:none; border-color:#8f8fff; }
    .hlv-modal input:focus-visible { box-shadow:0 0 0 3px rgba(124,124,255,.28); }
    .hlv-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
    .hlv-actions button { padding:7px 16px; border-radius:6px; font-size:13px; cursor:pointer;
      border:1px solid #444; background:#2a2a2a; color:#ddd; }
    .hlv-actions button:focus-visible { outline:none; box-shadow:0 0 0 3px rgba(124,124,255,.32); border-color:#8f8fff; }
    .hlv-actions button.primary { background:#5c5cff; border-color:#5c5cff; color:#fff; }
    .hlv-status { font-size:12px; margin-top:8px; min-height:18px; padding:4px 8px; border-radius:4px; }
    .hlv-status.ok  { background:rgba(46,125,50,.18);  color:#7fd089; }
    .hlv-status.err { background:rgba(211,47,47,.18);  color:#e0888f; }
    @media (prefers-reduced-motion: reduce) {
      #hlv { transition:opacity .01s; transform:none; }
      #hlv .row { transition:none; }
    }
  `);

  const card = document.createElement('div'); card.id = 'hlv';
  document.documentElement.appendChild(card);

  let tFetch=null, tShow=null, tVerdict=null, tDeep=null, tHide=null, active=null, paintSeq=0;

  function rgbaParts(value) {
    const m = String(value || '').match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const p = m[1].split(',').map(v => parseFloat(v.trim()));
    if (p.length < 3 || p.slice(0, 3).some(Number.isNaN)) return null;
    return { r:p[0], g:p[1], b:p[2], a:p.length > 3 && !Number.isNaN(p[3]) ? p[3] : 1 };
  }

  function luminance({ r, g, b }) {
    const lin = v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function linkTheme(a) {
    for (let el = a; el && el.nodeType === 1; el = el.parentElement) {
      const bg = rgbaParts(getComputedStyle(el).backgroundColor);
      if (bg && bg.a > 0.6) return luminance(bg) > 0.45 ? 'hlv-light' : 'hlv-dark';
    }
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'hlv-light' : 'hlv-dark';
  }

  // ---- tier 0: instant, from the URL alone --------------------------------
  function instant(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./,'');
    const base = host.split('.').slice(-2).join('.');
    const ext = (u.pathname.match(/\.(\w{2,4})$/)||[])[1]?.toLowerCase();
    const typeTag = ext && /^(pdf|zip|dmg|exe|mp4|mp3|csv|docx?|xlsx?)$/.test(ext) ? ext.toUpperCase() : null;
    return {
      host, base,
      favicon: `https://www.google.com/s2/favicons?domain=${host}&sz=32`,
      redirect: REDIRECTORS.has(base),
      wall: PAYWALLS.has(base),
      typeTag,
    };
  }

  // ---- render ------------------------------------------------------------
  function paint(s) {
    card.innerHTML = '';
    const row = document.createElement('div'); row.className='row';
    const fav = document.createElement('img'); fav.className='ico'; fav.src=s.favicon; fav.onerror=()=>fav.remove();
    const col = document.createElement('div'); col.className='col';

    const ttl = document.createElement('div'); ttl.className='ttl';
    ttl.textContent = s.title || s.host;
    if (s.typeTag){ const t=document.createElement('span'); t.className='tag'; t.textContent=s.typeTag; ttl.appendChild(t); }
    if (s.wall){ const t=document.createElement('span'); t.className='tag wall'; t.textContent='paywall'; ttl.appendChild(t); }
    col.appendChild(ttl);

    const meta = document.createElement('div'); meta.className='meta';
    if (s.redirect) meta.textContent = s.host + ' · redirector';
    else if (s.finalHost && s.finalHost !== s.host){ meta.append(s.host+' → '); const b=document.createElement('b'); b.textContent=s.finalHost; meta.appendChild(b); }
    else meta.textContent = s.host;
    col.appendChild(meta);

    if (s.desc){ const d=document.createElement('div'); d.className='desc'+(s.descAI?' ai':''); d.textContent=s.desc; col.appendChild(d); }

    row.appendChild(fav); row.appendChild(col);
    if (s.image){ const im=document.createElement('img'); im.className='thumb'; im.src=s.image; im.onerror=()=>im.remove(); row.appendChild(im); }
    card.appendChild(row);
  }

  function place(x,y){
    const r=card.getBoundingClientRect(), p=14;
    let l=x+p, t=y+p;
    if (l+r.width>innerWidth) l=x-r.width-p;
    if (t+r.height>innerHeight) t=y-r.height-p;
    card.style.left=Math.max(4,l)+'px'; card.style.top=Math.max(4,t)+'px';
  }

  function repaint(s, x, y) {
    if(!card.classList.contains('on')){ paint(s); place(x,y); return; }
    const seq = ++paintSeq;
    card.classList.add('updating');
    setTimeout(()=>{
      if(seq !== paintSeq || !card.classList.contains('on')) return;
      paint(s); place(x,y);
      requestAnimationFrame(()=>card.classList.remove('updating'));
    }, 90);
  }

  // ---- tier 1: head fetch -------------------------------------------------
  function headFetch(url){
    return new Promise((res,rej)=>{
      GM_xmlhttpRequest({
        method:'GET', url, timeout:7000,
        headers:{ 'Accept':'text/html', 'Range':'bytes=0-65535' },  // head usually lives here
        onload:r=>{
          const ct=(r.responseHeaders.match(/content-type:\s*([^\r\n]+)/i)||[])[1]||'';
          if(!/text\/html/i.test(ct)) return rej(new Error('not html'));
          const doc=new DOMParser().parseFromString(r.responseText,'text/html');
          const pick=s=>doc.querySelector(s)?.getAttribute('content')?.trim()||null;
          const finalUrl=r.finalUrl||url;
          const abs=v=>{ try{return new URL(v,finalUrl).href}catch{return null} };
          let desc = pick('meta[property="og:description"]')||pick('meta[name="twitter:description"]')||pick('meta[name="description"]');
          if(desc&&desc.length>240) desc=desc.slice(0,240)+'…';
          const img = pick('meta[property="og:image"]')||pick('meta[name="twitter:image"]');
          let finalHost;
          try { finalHost = new URL(finalUrl).hostname.replace(/^www\./,''); } catch { finalHost = null; }
          res({
            title: pick('meta[property="og:title"]')||doc.querySelector('title')?.textContent?.trim()||null,
            desc, finalHost,
            image: img?abs(img):null,
            html: r.responseText,
          });
        },
        onerror:()=>rej(new Error('network')), ontimeout:()=>rej(new Error('timeout')),
      });
    });
  }

  // ---- tier 2: gated verdict ---------------------------------------------
  function bodyText(html){
    const doc=new DOMParser().parseFromString(html,'text/html');
    doc.querySelectorAll('script,style,nav,footer,header,aside').forEach(n=>n.remove());
    const root=doc.querySelector('article,main')||doc.body;
    return (root?.textContent||'').replace(/\s+/g,' ').trim().slice(0,BODY_CAP);
  }

  function verdict(url, html){
    const cfg=getConfig();
    const text=bodyText(html);
    if(!text || !cfg.key) return Promise.reject(new Error('no body / no key'));
    return new Promise((res,rej)=>{
      GM_xmlhttpRequest({
        method:'POST', url:cfg.url, timeout:9000,
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+cfg.key },
        data: JSON.stringify({
          model: cfg.model, max_tokens: 70, temperature: 0,
          messages:[
            {role:'system', content:"Someone is deciding whether to click a link while reading something else. In ONE sentence (<=25 words), say concretely what this page is and what it covers — enough to decide. No filler, don't start with 'This page'. If it's thin/listicle/SEO-bait or paywalled, say so plainly."},
            {role:'user', content:`URL: ${url}\n\n${text}`},
          ],
        }),
        onload:r=>{
          try{
            const d=JSON.parse(r.responseText);
            if(r.status<200||r.status>=300) return rej(new Error(d?.error?.message||('HTTP '+r.status)));
            res(d.choices[0].message.content.trim());
          }catch(e){ rej(new Error('bad response')); }
        },
        onerror:()=>rej(new Error('network')), ontimeout:()=>rej(new Error('timeout')),
      });
    });
  }

  // ---- orchestration ------------------------------------------------------
  async function run(a, x, y, hoverAt){
    let url=a.href; active=url;
    let s;
    try { s=instant(url); } catch { return; }
    const theme = linkTheme(a);
    card.classList.toggle('hlv-light', theme === 'hlv-light');
    card.classList.toggle('hlv-dark', theme === 'hlv-dark');
    const cached=mem.get(url)||{};
    Object.assign(s, cached.tier1||{});
    if(cached.verdict){ s.desc=cached.verdict; s.descAI=true; }
    const schedule = (ms, fn) => setTimeout(fn, Math.max(0, ms - (Date.now() - hoverAt)));

    // paint instant layer immediately, then enrich in place — no spinner
    tShow=schedule(T_SHOW, ()=>{ if(active===url){ paint(s); place(x,y); card.classList.add('on'); } });

    if(!cached.tier1 && !s.redirect){
      try{
        const t1=await headFetch(url);
        if(active!==url) return;
        Object.assign(s, t1);
        mem.set(url,{...mem.get(url),tier1:t1});
        repaint(s, x, y);
      }catch{ /* blocked / non-html / timeout: keep tier 0 */ }
    }

    // tier 2: summarize on deliberate dwell; strong metadata waits longer.
    const weak = !s.descAI && (!s.desc || s.desc.length < WEAK_DESC);
    if(weak && llmEnabled() && s.html && !mem.get(url)?.verdict){
      tVerdict=schedule(T_VERDICT, async()=>{
        if(active!==url) return;
        const oldDesc = s.desc;
        if(!oldDesc){ s.desc='reading…'; s.descAI=true; repaint(s, x, y); }
        try{
          const v=await verdict(url, s.html);
          mem.set(url,{...mem.get(url),verdict:v});
          vPut(url, v);
          if(active===url){ s.desc=v; s.descAI=true; repaint(s, x, y); }
        }catch{ if(active===url && !oldDesc){ s.desc=null; s.descAI=false; repaint(s, x, y); } }
      });
    } else if(!s.descAI && s.desc && llmEnabled() && s.html && !mem.get(url)?.verdict){
      tDeep=schedule(T_DEEPER, async()=>{
        if(active!==url) return;
        const oldDesc = s.desc;
        try{
          const v=await verdict(url, s.html);
          mem.set(url,{...mem.get(url),verdict:v});
          vPut(url, v);
          if(active===url){ s.desc=v; s.descAI=true; repaint(s, x, y); }
        }catch{ if(active===url){ s.desc=oldDesc; s.descAI=false; paint(s); } }
      });
    }
  }

  function hide(){ card.classList.remove('on','updating'); active=null; paintSeq++; [tFetch,tShow,tVerdict,tDeep].forEach(clearTimeout); }

  function eligible(a){
    if(!a||a.tagName!=='A'||!a.href||!/^https?:/.test(a.href)) return false;
    if(a.href===location.href) return false;
    if(a.closest('.hlv-overlay')) return false;
    return true;
  }

  document.addEventListener('mouseover', e=>{
    const a=e.target.closest('a'); if(!eligible(a)) return;
    clearTimeout(tHide); [tFetch,tShow,tVerdict,tDeep].forEach(clearTimeout);
    const {clientX:x, clientY:y}=e;
    // warm persisted verdict cache
    const pv=vGet(a.href);
    if(pv){ const c=mem.get(a.href)||{}; c.verdict=pv; mem.set(a.href,c); }
    const hoverAt=Date.now();
    tFetch=setTimeout(()=>run(a,x,y,hoverAt), T_FETCH);
  });

  document.addEventListener('mouseout', e=>{
    const a=e.target.closest('a');
    if(!a) return;
    if(e.relatedTarget && a.contains(e.relatedTarget)) return;
    clearTimeout(tFetch);
    tHide=setTimeout(hide, T_HIDE);
  });
  document.addEventListener('scroll', hide, {passive:true});

  // ---- settings ----------------------------------------------------------
  function showSettings(){
    if(document.querySelector('.hlv-overlay')) return;
    const overlay=document.createElement('div'); overlay.className='hlv-overlay';
    const modal=document.createElement('div'); modal.className='hlv-modal';

    const h3=document.createElement('h3'); h3.textContent='Hover Link Verdict — Setup'; modal.appendChild(h3);

    function field(labelText, type, placeholder){
      const label=document.createElement('label'); label.textContent=labelText; modal.appendChild(label);
      const input=document.createElement('input'); input.type=type; input.placeholder=placeholder; modal.appendChild(input);
      return input;
    }
    const keyInput   = field('API Key (leave blank to disable the LLM verdict)', 'password', 'sk-...');
    const urlInput   = field('API URL', 'text', DEFAULT_URL);
    const modelInput = field('Model', 'text', DEFAULT_MODEL);

    const status=document.createElement('div'); status.className='hlv-status'; modal.appendChild(status);

    const actions=document.createElement('div'); actions.className='hlv-actions';
    function btn(text, cls){ const b=document.createElement('button'); b.textContent=text; if(cls) b.className=cls; actions.appendChild(b); return b; }
    const cancelBtn=btn('Cancel'); const testBtn=btn('Test'); const saveBtn=btn('Save','primary');
    modal.appendChild(actions);
    overlay.appendChild(modal); document.body.appendChild(overlay);

    keyInput.value   = GM_getValue('API_KEY', '');
    urlInput.value   = GM_getValue('API_URL', '');
    modelInput.value = GM_getValue('MODEL', '');
    keyInput.focus();

    const vals=()=>({
      key:   keyInput.value.trim(),
      url:   urlInput.value.trim() || DEFAULT_URL,
      model: modelInput.value.trim() || DEFAULT_MODEL,
    });

    cancelBtn.onclick=()=>overlay.remove();

    testBtn.onclick=()=>{
      const v=vals();
      if(!v.key){ keyInput.style.borderColor='#d32f2f'; return; }
      testBtn.textContent='Testing…'; testBtn.disabled=true;
      status.className='hlv-status'; status.textContent='';
      GM_xmlhttpRequest({
        method:'POST', url:v.url, timeout:15000,
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+v.key },
        data: JSON.stringify({ model:v.model, max_tokens:8, messages:[{role:'user',content:'hi'}] }),
        onload:r=>{
          let ok=r.status>=200&&r.status<300, msg='HTTP '+r.status;
          try{ const d=JSON.parse(r.responseText); if(!ok) msg=d?.error?.message||msg; }catch(e){}
          status.className='hlv-status '+(ok?'ok':'err');
          status.textContent=ok?'✓ Connection successful':'✗ '+msg;
          testBtn.textContent='Test'; testBtn.disabled=false;
        },
        onerror:()=>{ status.className='hlv-status err'; status.textContent='✗ network error'; testBtn.textContent='Test'; testBtn.disabled=false; },
        ontimeout:()=>{ status.className='hlv-status err'; status.textContent='✗ timed out'; testBtn.textContent='Test'; testBtn.disabled=false; },
      });
    };

    saveBtn.onclick=()=>{
      const v=vals();
      GM_setValue('API_KEY', v.key);
      GM_setValue('API_URL', v.url);
      GM_setValue('MODEL', v.model);
      overlay.remove();
    };

    overlay.addEventListener('keydown', e=>{ if(e.key==='Escape') overlay.remove(); });
  }

  if(typeof GM_registerMenuCommand==='function'){
    GM_registerMenuCommand('Hover Verdict — Settings', showSettings);
  }
})();
