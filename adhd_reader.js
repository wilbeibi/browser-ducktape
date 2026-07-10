// ==UserScript==
// @name         ADHD Reading Ruler
// @namespace    wilbeibi
// @version      7.0
// @description  Highlights the text line under your cursor — but only inside the main body of genuinely long articles. Feeds, dashboards, and short pages are left alone.
// @author       wilbeibi
// @match        *://*/*
// @exclude      *://*.bilibili.com/*
// @exclude      *://bilibili.com/*
// @exclude      *://*.youtube.com/*
// @exclude      *://*.reddit.com/*
// @exclude      *://*.twitter.com/*
// @exclude      *://*.x.com/*
// @exclude      *://*.facebook.com/*
// @exclude      *://*.instagram.com/*
// @exclude      *://*.discord.com/*
// @exclude      *://*.netflix.com/*
// @exclude      *://*.spotify.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @noframes
// ==/UserScript==

// ---------------------------------------------------------------------------
// The pure core (no GM_* / no live-DOM assumptions) is extracted into `core`
// and exercised by misc/test_adhd_reader.js — same layout as hover_verdict.js.
//
// Detection idea: collect visible long paragraphs (outside nav/header/footer/
// aside), credit each paragraph's length to every ancestor, then descend from
// <body> along the child that holds most of the text. That lands on the
// article body. The page qualifies only if that one container holds enough
// long paragraphs — so a short post with a busy sidebar, a feed, or a
// dashboard never activates, and the highlight is confined to the article.
// ---------------------------------------------------------------------------

const core = (() => {
  'use strict';

  const PARA_CHARS  = 80;    // a "long paragraph" has at least this many chars
  const MIN_PARAS   = 4;     // long paragraphs required inside the content root
  const MIN_CHARS   = 4500;  // long-paragraph chars required inside the root
  const TRUNK_SHARE = 0.8;   // descend while one child holds this share of text

  const CHROME_SEL = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';

  // Visible long paragraphs, leaves only (a blockquote wrapping <p>s counts
  // its children, not itself). isVisible is injectable so jsdom tests work.
  function longParagraphs(doc, isVisible) {
    const out = [];
    for (const el of doc.querySelectorAll('p, blockquote')) {
      if (el.querySelector('p, blockquote')) continue;
      if (el.closest(CHROME_SEL)) continue;
      const len = (el.textContent || '').trim().length;
      if (len < PARA_CHARS) continue;
      if (!isVisible(el)) continue;
      out.push({ el, len });
    }
    return out;
  }

  function defaultVisible(el) {
    return el.getClientRects().length > 0;
  }

  // The element that contains the article body, or null when the page
  // doesn't look like a long article.
  function findContentRoot(doc, isVisible = defaultVisible, opts = {}) {
    const minParas = opts.minParas ?? MIN_PARAS;
    const minChars = opts.minChars ?? MIN_CHARS;
    if (!doc.body) return null;

    const paras = longParagraphs(doc, isVisible);
    const total = new Map();
    for (const { el, len } of paras) {
      for (let a = el.parentElement; a; a = a.parentElement) {
        total.set(a, (total.get(a) || 0) + len);
        if (a === doc.body) break;
      }
    }
    if ((total.get(doc.body) || 0) < minChars) return null;

    // Follow the trunk: while one child holds most of the text, descend.
    // Stops where the text splits (e.g. article vs. comments), which keeps
    // both readable regions in scope.
    let root = doc.body;
    for (;;) {
      const share = TRUNK_SHARE * (total.get(root) || 0);
      const next = Array.from(root.children).find(c => (total.get(c) || 0) >= share);
      if (!next || next.matches('p, blockquote')) break;
      root = next;
    }

    const inRoot = paras.filter(p => root.contains(p.el));
    const chars = inRoot.reduce((n, p) => n + p.len, 0);
    if (inRoot.length < minParas || chars < minChars) return null;
    return root;
  }

  return { PARA_CHARS, MIN_PARAS, MIN_CHARS, TRUNK_SHARE, CHROME_SEL,
           longParagraphs, findContentRoot, defaultVisible };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = core;
  return;
}

// ---------------------------------------------------------------------------
// Browser glue. Everything below touches GM_* / live DOM / timers.
// ---------------------------------------------------------------------------

(() => {
  'use strict';

  // ---- tune here ----------------------------------------------------------
  const COLOR       = 'rgba(135, 206, 250, 0.30)';
  const PAD         = 2;              // extra px above/below the line
  const THROTTLE_MS = 30;
  const RECHECK_MS  = [2500, 7000];   // late-render second chances, then stop
  // --------------------------------------------------------------------------

  const host = location.hostname.toLowerCase();

  function excludedSites() {
    try {
      const v = JSON.parse(GM_getValue('excluded', '[]'));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function hostMatches(h, pattern) {
    const p = String(pattern || '').toLowerCase().trim().replace(/^\*?\./, '');
    return !!p && (h === p || h.endsWith('.' + p));
  }
  const siteExcluded = () => excludedSites().some(p => hostMatches(host, p));

  let enabled = GM_getValue('enabled', true);
  let root = null, hl = null, btn = null, lastLine = null;
  let lastX = 0, lastY = 0, rafId = null;

  // ---- small UI helpers ----------------------------------------------------

  GM_addStyle(`
    .rr-line { position:absolute; pointer-events:none; z-index:2147483640;
      border-radius:2px; display:none; transition:all 140ms ease-out; }
    .rr-btn { position:fixed; right:16px; bottom:16px; width:34px; height:34px;
      border-radius:50%; border:1px solid rgba(128,128,128,.35);
      background:rgba(255,255,255,.9); cursor:pointer; z-index:2147483641;
      font-size:15px; line-height:1; padding:0; opacity:.55;
      box-shadow:0 2px 8px rgba(0,0,0,.18); transition:opacity .15s, transform .15s; }
    .rr-btn:hover { opacity:1; transform:scale(1.08); }
    @media (prefers-color-scheme: dark) {
      .rr-btn { background:rgba(50,50,50,.9); border-color:rgba(110,110,110,.5); }
    }
    .rr-toast { position:fixed; right:16px; bottom:60px; z-index:2147483642;
      background:rgba(30,30,30,.92); color:#fff; padding:7px 13px; border-radius:6px;
      font:13px/1.4 system-ui, sans-serif; max-width:min(320px,80vw);
      opacity:0; transition:opacity .2s; pointer-events:none; }
    .rr-toast.on { opacity:1; }
    @media (prefers-reduced-motion: reduce) {
      .rr-line, .rr-btn, .rr-toast { transition:none; }
    }
  `);

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'rr-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2000);
  }

  function pageDark() {
    for (const el of [document.body, document.documentElement]) {
      const m = getComputedStyle(el).backgroundColor
        .match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!m) continue;
      if (m[4] !== undefined && parseFloat(m[4]) < 0.1) continue;
      return (+m[1] * 299 + +m[2] * 587 + +m[3] * 114) / 1000 < 128;
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  // ---- line geometry --------------------------------------------------------

  const SKIP_TAGS = /^(INPUT|TEXTAREA|BUTTON|SELECT|IMG|VIDEO|AUDIO|CANVAS|IFRAME|SVG)$/i;

  function hasDirectText(el) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    }
    return false;
  }

  // The block-level element under the cursor that directly carries text.
  // Climbs past inline wrappers (links, spans); refuses layout containers so
  // the gap between paragraphs stays unhighlighted.
  function textElAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !root.contains(el)) return null;
    for (let cur = el; cur && root.contains(cur); cur = cur.parentElement) {
      if (SKIP_TAGS.test(cur.tagName)) return null;
      if (cur !== root && getComputedStyle(cur).display.startsWith('inline')) continue;
      const text = (cur.textContent || '').trim();
      if (!text) return null;
      if (hasDirectText(cur) || text.length <= 600) return cur;
      return null;
    }
    return null;
  }

  // Client-coordinate box of the text line at height y inside el, or null
  // when that band holds no actual text.
  function lineAt(el, y) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let lh = parseFloat(cs.lineHeight);
    if (!isFinite(lh)) lh = (parseFloat(cs.fontSize) || 16) * 1.5;
    const idx = Math.floor((y - rect.top) / lh);
    if (idx < 0) return null;
    const top = rect.top + idx * lh;
    const bottom = top + lh;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    const range = document.createRange();
    for (let n; (n = walker.nextNode()); ) {
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      if (r.top < bottom && r.bottom > top) {
        return { top: top - PAD, left: rect.left, width: rect.width, height: lh + PAD * 2 };
      }
    }
    return null;
  }

  function show(line) {
    lastLine = {
      docTop: line.top + scrollY, docLeft: line.left + scrollX,
      width: line.width, height: line.height,
    };
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      hl.style.display = 'block';
      hl.style.top = lastLine.docTop + 'px';
      hl.style.left = lastLine.docLeft + 'px';
      hl.style.width = lastLine.width + 'px';
      hl.style.height = lastLine.height + 'px';
    });
  }

  function hide() {
    cancelAnimationFrame(rafId);
    if (hl) hl.style.display = 'none';
  }

  function update(x, y) {
    if (!enabled || !hl) return;
    if (!root.isConnected) { unmount(); scheduleDecide(); return; }
    const el = textElAt(x, y);
    const line = el && lineAt(el, y);
    if (line) show(line); else hide();
  }

  // ---- J/K stepping ----------------------------------------------------------

  function step(dir) {
    if (tryStep(dir)) return;
    window.scrollBy({ top: dir * innerHeight * 0.4, behavior: 'auto' });
    tryStep(dir);
  }

  function tryStep(dir) {
    let probeX, startY;
    const haveLine = lastLine && hl.style.display === 'block';
    if (haveLine) {
      probeX = lastLine.docLeft - scrollX + Math.min(24, lastLine.width / 2);
      const viewTop = lastLine.docTop - scrollY;
      startY = dir > 0 ? viewTop + lastLine.height + 2 : viewTop - 2;
    } else {
      const r = root.getBoundingClientRect();
      probeX = Math.max(8, r.left + Math.min(24, r.width / 2));
      startY = innerHeight * 0.3;
      dir = 1;
    }
    const centerX = (() => {
      const r = root.getBoundingClientRect();
      return Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2));
    })();

    for (let i = 0; i < 40; i++) {
      const y = startY + dir * i * 10;
      if (y < 0 || y > innerHeight) break;
      for (const x of [probeX, centerX]) {
        const el = textElAt(x, y);
        const pos = el && lineAt(el, y);
        if (!pos) continue;
        if (haveLine && Math.abs(pos.top + scrollY - lastLine.docTop) < 3) continue;
        show(pos);
        keepInView(pos);
        return true;
      }
    }
    return false;
  }

  function keepInView(pos) {
    const margin = 80;
    if (pos.top >= margin && pos.top + pos.height <= innerHeight - margin) return;
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.scrollTo({ top: pos.top + scrollY - innerHeight * 0.4, behavior });
  }

  // ---- events ---------------------------------------------------------------

  let throttleAt = 0, throttleTimer = null;
  function onMove(e) {
    lastX = e.clientX; lastY = e.clientY;
    const now = Date.now();
    if (now - throttleAt >= THROTTLE_MS) {
      throttleAt = now;
      update(lastX, lastY);
    } else if (!throttleTimer) {
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        throttleAt = Date.now();
        update(lastX, lastY);
      }, THROTTLE_MS);
    }
  }

  function onScroll() { if (enabled) update(lastX, lastY); }
  function onLeave() { hide(); }

  function onKey(e) {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyH') {
      e.preventDefault();
      toggleEnabled();
      return;
    }
    if (!enabled || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === 'j' || e.key === 'k') {
      e.preventDefault();
      step(e.key === 'j' ? 1 : -1);
    }
  }

  // ---- mount / unmount --------------------------------------------------------

  function refreshBtn() {
    if (!btn) return;
    btn.textContent = enabled ? '🔆' : '📖';
    btn.title = (enabled ? 'Reading ruler on' : 'Reading ruler off')
      + ' — click or Alt+H to toggle, right-click to disable on this site';
  }

  function toggleEnabled() {
    if (!root) { toast('No article detected here — menu → “Force enable on this page”'); return; }
    enabled = !enabled;
    GM_setValue('enabled', enabled);
    if (!enabled) hide();
    refreshBtn();
    toast(enabled ? 'Ruler on — J/K step lines' : 'Ruler off');
  }

  function mount(r) {
    if (root) return;
    root = r;

    hl = document.createElement('div');
    hl.className = 'rr-line';
    hl.style.background = COLOR;
    hl.style.mixBlendMode = pageDark() ? 'screen' : 'multiply';
    document.body.appendChild(hl);

    btn = document.createElement('button');
    btn.className = 'rr-btn';
    btn.addEventListener('click', toggleEnabled);
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      GM_setValue('excluded', JSON.stringify([...excludedSites(), host]));
      toast(`Disabled on ${host} — re-enable via the userscript menu`);
      unmount();
    });
    refreshBtn();
    document.body.appendChild(btn);

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.documentElement.addEventListener('mouseleave', onLeave, { passive: true });
    document.addEventListener('keydown', onKey);
  }

  function unmount() {
    if (!root) return;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('scroll', onScroll, { capture: true });
    document.documentElement.removeEventListener('mouseleave', onLeave);
    document.removeEventListener('keydown', onKey);
    hl?.remove(); btn?.remove();
    root = hl = btn = lastLine = null;
  }

  // ---- activation policy -------------------------------------------------------
  // Decide on load, retry twice for late-rendering pages, then stop. A page
  // that becomes text-dense later (lazy comments on a feed) will NOT grab the
  // ruler mid-session — that surprise was the old version's worst behavior.

  function decide() {
    if (root) return;
    const r = core.findContentRoot(document, core.defaultVisible);
    if (r) mount(r);
  }

  function scheduleDecide() {
    decide();
    for (const ms of RECHECK_MS) setTimeout(decide, ms);
  }

  // ---- menu + init ---------------------------------------------------------------

  if (siteExcluded()) {
    GM_registerMenuCommand(`Enable reading ruler on ${host}`, () => {
      GM_setValue('excluded', JSON.stringify(excludedSites().filter(p => !hostMatches(host, p))));
      location.reload();
    });
    return;
  }

  GM_registerMenuCommand('Toggle reading ruler (Alt+H)', toggleEnabled);
  GM_registerMenuCommand(`Disable on ${host}`, () => {
    GM_setValue('excluded', JSON.stringify([...excludedSites(), host]));
    unmount();
    toast(`Disabled on ${host}`);
  });
  GM_registerMenuCommand('Force enable on this page', () => {
    if (root) { toast('Already active'); return; }
    mount(document.body);
    toast('Forced on for this page');
  });

  scheduleDecide();

  // SPA navigation: re-decide per URL. Cheap 1s poll beats fragile
  // pushState hooks across script managers.
  let href = location.href;
  setInterval(() => {
    if (location.href === href) return;
    href = location.href;
    unmount();
    setTimeout(scheduleDecide, 400);
  }, 1000);
})();
