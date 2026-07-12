// ==UserScript==
// @name         Inline Article Translator (LLM)
// @version      1.5.1
// @description  Immersive-Translate-style bilingual inline translation powered by any OpenAI-compatible LLM API. Streams results, prioritizes the paragraph you're reading, prefetches the rest of the article, select-to-translate (划词翻译), caches locally. Supports ChatGPT / Claude / Gemini answers and deep-research reports, translating each paragraph as it settles.
// @author       wilbeibi
// @namespace    https://github.com/wilbeibi/browser-ducktape
// @license      MIT
// @homepageURL  https://github.com/wilbeibi/browser-ducktape
// @supportURL   https://github.com/wilbeibi/browser-ducktape/issues
// @downloadURL  https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/inline_translate.user.js
// @updateURL    https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/inline_translate.user.js
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_URL   = 'https://api.deepseek.com/v1/chat/completions';
    const DEFAULT_MODEL = 'deepseek-chat';
    const DEFAULT_LANG  = 'Simplified Chinese (简体中文)';

    const MIN_TEXT_LEN       = 4;     // skip blocks shorter than this
    const MAX_SEGMENT_CHARS  = 4000;  // hard cap per block
    const BATCH_CHAR_LIMIT   = 1800;  // chars of source text per API call
    const BATCH_MAX_SEGMENTS = 12;    // blocks per API call
    const COLD_MAX_SEGMENTS  = 3;     // first batch is tiny: fastest time-to-first-translation
    const COLD_CHAR_LIMIT    = 500;
    const CONCURRENCY        = 3;     // parallel API calls
    const VIEWPORT_MARGIN    = '1500px'; // translate this far ahead of the viewport
    const CACHE_MAX_ENTRIES  = 1500;  // localStorage cache cap (per origin)
    const CACHE_KEEP_ENTRIES = 1000;
    const PREFETCH_CHUNK_CHARS = 6000;  // idle prefetch: chars enqueued per idle period
    const PREFETCH_MAX_CHARS   = 30000; // idle prefetch: per-page cap, IO stays lazy beyond it
    const MAX_RETRIES          = 2;     // auto-retry attempts before showing manual retry UI
    const RETRY_BASE_DELAY_MS  = 2000;  // base delay before first retry (doubles each attempt)

    function getConfig() {
        return {
            key:   String(GM_getValue('API_KEY', '') || '').trim(),
            url:   String(GM_getValue('API_URL', DEFAULT_URL) || '').trim(),
            model: String(GM_getValue('MODEL', DEFAULT_MODEL) || '').trim(),
            lang:  String(GM_getValue('TARGET_LANG', DEFAULT_LANG) || '').trim(),
        };
    }

    // ==========================================
    // Translation cache (localStorage, per origin)
    // Re-opening a page renders instantly with zero API calls.
    // ==========================================
    function djb2(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    function cacheKey(src, cfg) {
        return 'llmtr:' + djb2(cfg.model + '\x00' + cfg.lang + '\x00' + src) + ':' + src.length;
    }

    function cacheGet(src, cfg) {
        try {
            const v = localStorage.getItem(cacheKey(src, cfg));
            return v ? JSON.parse(v).t : null;
        } catch (e) { return null; }
    }

    function cachePut(src, text, cfg) {
        try {
            localStorage.setItem(cacheKey(src, cfg), JSON.stringify({ t: text, ts: Date.now() }));
        } catch (e) {
            pruneCache(true);
        }
        if (Math.random() < 0.02) pruneCache(false);
    }

    function pruneCache(aggressive) {
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith('llmtr:')) keys.push(k);
            }
            if (!aggressive && keys.length <= CACHE_MAX_ENTRIES) return;
            const entries = keys.map(k => {
                let ts = 0;
                try { ts = JSON.parse(localStorage.getItem(k)).ts || 0; } catch (e) {}
                return [k, ts];
            }).sort((a, b) => a[1] - b[1]);
            const drop = aggressive ? entries.length : entries.length - CACHE_KEEP_ENTRIES;
            for (let i = 0; i < drop; i++) localStorage.removeItem(entries[i][0]);
        } catch (e) {}
    }

    function systemPrompt(lang) {
        return `You are a professional translation engine. Translate each numbered segment into ${lang}.

Input format: each segment starts with a marker line "@@N@@" followed by its text.
Output format: for EVERY input segment, output its marker "@@N@@" on its own line followed by the translation. Same order, same count.

Rules:
- Translate naturally and fluently, preserving meaning, tone, and register.
- Keep inline code, commands, URLs, file paths, math, and brand/product names as-is inside the translation.
- Do NOT merge, split, renumber, or drop segments.
- Do NOT add explanations, notes, or anything besides markers and translations.
- If a segment is already in ${lang} or has nothing translatable, output it unchanged.`;
    }

    // ==========================================
    // CSS
    // ==========================================
    const STYLE = `
.llmtr {
    display: block;
    margin-top: 0.4em;
    font: inherit;
    line-height: inherit;
    white-space: normal;
    opacity: 0.94;
}
/* one wrapper per <br><br>-separated paragraph on old-web pages */
.llmtr-seg {
    display: block;
    margin: 0 0 1em;
}
.llmtr-loading {
    opacity: 0.45;
    animation: llmtr-pulse 1.2s ease-in-out infinite;
}
@keyframes llmtr-pulse {
    0%, 100% { opacity: 0.45; }
    50% { opacity: 0.15; }
}
.llmtr-error {
    color: #d32f2f;
    cursor: pointer;
    font-size: 0.85em;
}
html.llmtr-hide .llmtr { display: none; }

.llmtr-fab {
    position: fixed;
    right: 14px;
    top: 55%;
    width: 38px;
    height: 38px;
    border-radius: 50%;
    border: 1px solid rgba(128,128,128,0.35);
    background: rgba(255,255,255,0.92);
    color: #444;
    font-size: 16px;
    font-family: system-ui, sans-serif;
    cursor: pointer;
    z-index: 2147483646;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    opacity: 0.55;
    transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
}
.llmtr-fab:hover { opacity: 1; transform: scale(1.08); }
.llmtr-fab.on {
    background: #5c5cff;
    border-color: #5c5cff;
    color: #fff;
    opacity: 0.9;
}
.llmtr-fab.busy { animation: llmtr-pulse 1.2s ease-in-out infinite; }
.llmtr-fab .llmtr-fab-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: #d32f2f;
    color: #fff;
    font-size: 10px;
    line-height: 16px;
    text-align: center;
    display: none;
}
@media (prefers-color-scheme: dark) {
    .llmtr-fab {
        background: rgba(50,50,50,0.92);
        border-color: rgba(110,110,110,0.5);
        color: #ccc;
    }
    .llmtr-fab.on { background: #5c5cff; color: #fff; }
}

.llmtr-toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 10px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-family: system-ui, sans-serif;
    z-index: 2147483647;
    color: white;
    opacity: 0;
    transform: translateY(8px);
    transition: all 0.2s ease;
    pointer-events: none;
}
.llmtr-toast.visible { opacity: 1; transform: translateY(0); }
.llmtr-toast.success { background: #2e7d32; }
.llmtr-toast.error { background: #d32f2f; }
.llmtr-toast.info { background: #1565c0; }

.llmtr-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.5);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
}
.llmtr-modal {
    background: #fff;
    border-radius: 10px;
    padding: 24px;
    width: 380px;
    max-width: 90vw;
    box-shadow: 0 8px 32px rgba(0,0,0,0.18);
    font-family: system-ui, sans-serif;
}
.llmtr-modal h3 {
    margin: 0 0 16px;
    font-size: 15px;
    font-weight: 600;
}
.llmtr-modal label {
    display: block;
    font-size: 12px;
    color: #555;
    margin-bottom: 4px;
}
.llmtr-modal input {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    border: 1px solid #ccc;
    border-radius: 6px;
    font-size: 13px;
    margin-bottom: 12px;
}
.llmtr-modal input:focus { outline: none; border-color: #7c7cff; }
.llmtr-modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
}
.llmtr-modal-actions button {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    border: 1px solid #ccc;
    background: #f5f5f5;
}
.llmtr-modal-actions button.primary {
    background: #5c5cff;
    color: #fff;
    border-color: #5c5cff;
}
.llmtr-test-status {
    font-size: 12px;
    margin-top: 8px;
    min-height: 18px;
    padding: 4px 8px;
    border-radius: 4px;
}
.llmtr-test-status.ok  { background: rgba(46,125,50,0.12);  color: #2e7d32; }
.llmtr-test-status.err { background: rgba(211,47,47,0.12);  color: #d32f2f; }
@media (prefers-color-scheme: dark) {
    .llmtr-modal { background: #1e1e1e; color: #ddd; }
    .llmtr-modal label { color: #aaa; }
    .llmtr-modal input {
        background: #2a2a2a;
        border-color: #444;
        color: #ddd;
    }
    .llmtr-modal-actions button {
        background: #2a2a2a;
        border-color: #444;
        color: #ddd;
    }
    .llmtr-modal-actions button.primary {
        background: #5c5cff;
        border-color: #5c5cff;
        color: #fff;
    }
}

/* 划词翻译 — selection translation */
.llmtr-sel-btn {
    position: fixed;
    z-index: 2147483646;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    border: 1px solid rgba(255,255,255,0.25);
    background: #5c5cff;
    color: #fff;
    font: 13px/1 system-ui, sans-serif;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}
.llmtr-sel-btn:hover { background: #4a4aff; }
.llmtr-sel-pop {
    position: fixed;
    z-index: 2147483647;
    min-width: 80px;
    max-width: 360px;
    max-height: 45vh;
    overflow-y: auto;
    background: #fff;
    color: #222;
    border: 1px solid rgba(0,0,0,0.12);
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0,0,0,0.2);
    padding: 10px 12px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
}
.llmtr-sel-pop.llmtr-sel-wide { max-width: min(520px, 80vw); }
.llmtr-sel-pop-body { white-space: pre-wrap; word-break: break-word; }
.llmtr-sel-title {
    margin-bottom: 6px;
    font-size: 16px;
    font-weight: 650;
    line-height: 1.3;
    color: #111;
}
.llmtr-sel-detail { color: #333; }
.llmtr-sel-pos {
    display: inline;
    margin-left: 7px;
    font-size: 12px;
    font-weight: 400;
    font-style: italic;
    color: #8a8a8e;
}
.llmtr-sel-row { margin-top: 8px; }
.llmtr-sel-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #9a9aa0;
    margin-bottom: 1px;
}
.llmtr-sel-content { color: #333; }
.llmtr-sel-ex-src {
    font-family: Georgia, "Times New Roman", serif;
    font-style: italic;
    color: #444;
}
.llmtr-sel-ex-tr { color: #777; font-size: 13px; margin-top: 1px; }
.llmtr-sel-pop-body.llmtr-sel-loading {
    opacity: 0.5;
    animation: llmtr-pulse 1.2s ease-in-out infinite;
}
.llmtr-sel-pop-body.llmtr-sel-error { color: #d32f2f; }
@media (prefers-color-scheme: dark) {
    .llmtr-sel-pop { background: #1e1e1e; color: #ddd; border-color: #444; }
    .llmtr-sel-title { color: #fff; }
    .llmtr-sel-detail { color: #d0d0d0; }
    .llmtr-sel-pos { color: #98989d; }
    .llmtr-sel-label { color: #7f7f86; }
    .llmtr-sel-content { color: #d0d0d0; }
    .llmtr-sel-ex-src { color: #c8c8cc; }
    .llmtr-sel-ex-tr { color: #97979d; }
}`;

    // ==========================================
    // State
    // ==========================================
    let enabled = false;      // bilingual mode on
    let booted = false;       // observers built
    let io = null;            // IntersectionObserver
    let mo = null;            // MutationObserver
    let queue = [];           // blocks waiting for an API slot
    let inFlight = 0;         // active API calls
    let pendingCount = 0;     // blocks queued or loading (for badge)
    let dispatchTimer = null;
    let fab = null;
    let badge = null;
    let allBlocks = [];       // every qualified block (for whole-article prefetch)
    let eagerScheduled = false;

    // ==========================================
    // Block detection
    // ==========================================
    const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI',
        'BLOCKQUOTE', 'DD', 'DT', 'FIGCAPTION', 'TD', 'TH', 'CAPTION', 'SUMMARY']);
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'CODE', 'PRE',
        'TEXTAREA', 'INPUT', 'SELECT', 'BUTTON', 'IFRAME', 'CANVAS', 'VIDEO',
        'AUDIO', 'MATH', 'NAV', 'ASIDE', 'FORM', 'KBD', 'SAMP', 'TIME']);
    const BLOCKY_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,ul,ol,dl,blockquote,div,section,article,table,figure,pre';

    function hasBlockChild(el) {
        return el.querySelector(BLOCKY_SELECTOR) !== null;
    }

    // True when the element carries its own text directly (not only via child
    // elements) — lets a <font>/<center>/bare wrapper that holds prose count as
    // a translatable leaf even though its tag isn't in the block whitelist.
    function hasDirectText(el) {
        for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3 && /\p{L}/u.test(n.nodeValue)) return true;
        }
        return false;
    }

    function targetIsChinese() {
        const lang = getConfig().lang.toLowerCase();
        return lang.includes('chinese') || lang.includes('中文') || lang.includes('zh');
    }

    // True for text that is predominantly Han with no kana (i.e. Chinese, not
    // Japanese) — those blocks don't need translating when the target is Chinese.
    function looksLikeChinese(text) {
        let han = 0, kana = 0, letters = 0;
        for (const ch of text) {
            const c = ch.codePointAt(0);
            if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
                (c >= 0xF900 && c <= 0xFAFF)) han++;
            else if (c >= 0x3040 && c <= 0x30FF) kana++;
            else if (/\p{L}/u.test(ch)) letters++;
        }
        const total = han + kana + letters;
        if (!total) return false;
        return kana / total < 0.05 && han / total > 0.5;
    }

    // innerText reflects what's actually rendered — it already omits the source
    // of inline <script>/<style> and hidden nodes. Only fall back to textContent
    // for un-rendered elements that carry NO such nodes, so we never harvest a
    // script's body as if it were prose (Reddit's inline `SML.load([...])`
    // module manifests were otherwise "translated" and injected as visible text).
    function renderedText(el) {
        const t = (el.innerText || '').trim();
        if (t) return t;
        if (el.querySelector('script, style, noscript')) return '';
        return (el.textContent || '').trim();
    }

    function qualifies(el) {
        if (el.closest('[contenteditable="true"]')) return false;
        const text = renderedText(el);
        if (text.length < MIN_TEXT_LEN) return false;
        const letters = (text.match(/\p{L}/gu) || []).length;
        if (letters < 2) return false;
        if (letters / text.length < 0.3) return false; // mostly numbers/symbols
        if (targetIsChinese() && looksLikeChinese(text)) return false;
        el._llmtrSrc = text.slice(0, MAX_SEGMENT_CHARS);
        return true;
    }

    function collect(el, out) {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName;
        if (SKIP_TAGS.has(tag)) return;
        if (el.classList.contains('llmtr') || el.classList.contains('llmtr-ui')) return;
        if (el.isContentEditable) return;
        if ((tag === 'HEADER' || tag === 'FOOTER') && !el.closest('article, main')) return;

        // A leaf is any element with no block-level descendant that carries its
        // own text — not just whitelisted tags. This covers old-web pages that
        // keep paragraphs in <font>/<center>/bare wrappers with no semantic tags
        // (paulgraham.com, antirez's old blog, mailing-list archives, ...).
        const isLeafCandidate = !hasBlockChild(el) &&
            (BLOCK_TAGS.has(tag) || tag === 'DIV' || hasDirectText(el));

        if (isLeafCandidate) {
            // A single leaf may pack several paragraphs separated by <br><br>.
            // Split those into one <div> per paragraph (kept inside `el`, so the
            // wrappers become ordinary leaves the rest of the pipeline handles);
            // then fall through to collect them via the normal recursion.
            if (!el.dataset.llmtrSplit && splitBrParagraphs(el)) {
                // fall through to child recursion below
            } else {
                if (!el.dataset.llmtrSeen) {
                    el.dataset.llmtrSeen = '1';
                    if (qualifies(el)) out.push(el);
                }
                return;
            }
        }
        for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
            collect(c, out);
        }
    }

    // Within a text leaf (all-inline subtree), find the element that actually
    // holds the <br><br> paragraph breaks — which may be a descendant, e.g.
    // <td> wraps a single <font> that carries the whole essay (paulgraham.com).
    // Returns the element with the most direct <br> children that also bears
    // its own text, or null when there's no real paragraph structure.
    function brParagraphHost(el) {
        let best = null, bestBr = 0;
        (function scan(node) {
            let directBr = 0;
            for (let c = node.firstChild; c; c = c.nextSibling)
                if (c.nodeType === 1 && c.tagName === 'BR') directBr++;
            if (directBr > bestBr && hasDirectText(node)) { best = node; bestBr = directBr; }
            for (let c = node.firstElementChild; c; c = c.nextElementSibling)
                if (!SKIP_TAGS.has(c.tagName)) scan(c);
        })(el);
        return bestBr >= 2 ? best : null;
    }

    // Split a text leaf whose paragraphs are separated by "<br><br>" runs into
    // one <div class="llmtr-seg"> per paragraph. The wrappers stay inside their
    // host so inherited styling (e.g. <font face/size>) still applies, and
    // because they are <div>s the unchanged DIV-leaf path collects them next.
    // Returns true when it produced 2+ paragraphs; flags `el` so it runs once.
    function splitBrParagraphs(el) {
        el.dataset.llmtrSplit = '1';
        const host = brParagraphHost(el);
        if (!host) return false;
        const kids = Array.from(host.childNodes);
        const runs = [];
        let cur = [];
        for (let i = 0; i < kids.length; i++) {
            const n = kids[i];
            if (!(n.nodeType === 1 && n.tagName === 'BR')) { cur.push(n); continue; }
            // measure a run of <br>s, hopping over blank text nodes between them
            let j = i + 1, brs = 1;
            while (j < kids.length) {
                const k = kids[j];
                if (k.nodeType === 1 && k.tagName === 'BR') { brs++; j++; }
                else if (k.nodeType === 3 && !/\S/.test(k.nodeValue)) j++;
                else break;
            }
            if (brs >= 2) {                       // paragraph boundary
                if (cur.length) { runs.push(cur); cur = []; }
                i = j - 1;                        // consume the whole separator run
            } else {
                cur.push(n);                      // lone <br> stays in the paragraph
            }
        }
        if (cur.length) runs.push(cur);

        const textRuns = runs.filter(run => run.some(n =>
            /\p{L}/u.test(n.nodeType === 3 ? n.nodeValue : (n.textContent || ''))));
        if (textRuns.length < 2) return false;

        for (const run of textRuns) {
            const seg = document.createElement('div');
            seg.className = 'llmtr-seg';
            host.insertBefore(seg, run[0]);
            for (const n of run) seg.appendChild(n);
        }
        // drop the now-orphaned separator <br>s / whitespace left between segs
        for (const n of Array.from(host.childNodes)) {
            if (n.nodeType === 1 && n.tagName === 'BR') host.removeChild(n);
            else if (n.nodeType === 3 && !/\S/.test(n.nodeValue)) host.removeChild(n);
        }
        return true;
    }

    // ==========================================
    // Translation rendering
    // ==========================================
    function ensureSpan(el) {
        let s = el._llmtrSpan;
        if (!s || !s.isConnected) {
            s = document.createElement('span');
            s.className = 'llmtr';
            el.appendChild(s);
            el._llmtrSpan = s;
        }
        return s;
    }

    function setLoading(el) {
        const s = ensureSpan(el);
        s.classList.remove('llmtr-error');
        s.classList.add('llmtr-loading');
        s.onclick = null;
        s.textContent = '· · ·';
        el.dataset.llmtrState = 'loading';
    }

    // a block leaves the pending count exactly once, on queued/loading → done/error
    function settle(el) {
        const st = el.dataset.llmtrState;
        if (st === 'queued' || st === 'loading') {
            pendingCount = Math.max(0, pendingCount - 1);
        }
    }

    // partial fill while the response is still streaming in
    function setStreaming(el, text) {
        const s = ensureSpan(el);
        s.classList.remove('llmtr-loading', 'llmtr-error');
        s.textContent = text;
    }

    function setDone(el, text, cfg) {
        const s = ensureSpan(el);
        s.classList.remove('llmtr-loading', 'llmtr-error');
        s.onclick = null;
        s.textContent = text;
        settle(el);
        el.dataset.llmtrState = 'done';
        if (cfg) cachePut(el._llmtrSrc, text, cfg);
        updateFab();
    }

    function retryOrError(el) {
        const retries = parseInt(el.dataset.llmtrRetries || '0', 10);
        if (retries < MAX_RETRIES) {
            el.dataset.llmtrRetries = String(retries + 1);
            delete el.dataset.llmtrState;
            const delay = RETRY_BASE_DELAY_MS * (retries + 1);
            setTimeout(() => {
                if (el.isConnected && enabled) {
                    enqueue(el);
                    scheduleDispatch();
                }
            }, delay);
        } else {
            setError(el);
        }
    }

    function setError(el) {
        const s = ensureSpan(el);
        s.classList.remove('llmtr-loading');
        s.classList.add('llmtr-error');
        s.textContent = '⚠ 翻译失败 — 点击重试';
        settle(el);
        el.dataset.llmtrState = 'error';
        s.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            delete el.dataset.llmtrRetries;
            enqueue(el);
            scheduleDispatch();
        };
        updateFab();
    }

    // ==========================================
    // API
    // ==========================================
    function sendRequest({ key, url, model, messages, max_tokens = 2048, timeout = 60000 }) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url,
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
                timeout,
                data: JSON.stringify({ model, max_tokens, temperature: 0.3, messages }),
                onload(resp) {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (resp.status < 200 || resp.status >= 300) {
                            reject(new Error(data?.error?.message || `HTTP ${resp.status}`));
                            return;
                        }
                        resolve(data);
                    } catch (e) {
                        reject(new Error('Failed to parse response'));
                    }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Request timed out'))
            });
        });
    }

    // Concatenate delta content out of an SSE ("data: {...}") response body.
    // Recomputed over the full buffer each time — partial trailing lines just
    // fail JSON.parse and get picked up on the next pass.
    function extractSSE(text) {
        let out = '';
        for (const line of text.split('\n')) {
            const m = line.match(/^data:\s*(.+)$/);
            if (!m || m[1] === '[DONE]') continue;
            try {
                const j = JSON.parse(m[1]);
                out += j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '';
            } catch (e) { /* incomplete line, next pass */ }
        }
        return out;
    }

    // Streaming chat completion. onText receives the growing content; falls
    // back transparently when the endpoint ignores stream:true or the script
    // manager never fires onprogress.
    function streamChat({ key, url, model, messages, max_tokens, timeout = 90000, onText }) {
        return new Promise((resolve, reject) => {
            let seen = 0;
            GM_xmlhttpRequest({
                method: 'POST', url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + key,
                    'Accept': 'text/event-stream'
                },
                timeout,
                data: JSON.stringify({ model, max_tokens, temperature: 0.3, messages, stream: true }),
                onprogress(resp) {
                    if (!onText) return;
                    try {
                        const t = resp.responseText || '';
                        if (!t || t.trimStart()[0] === '{') return; // non-stream JSON body
                        const content = extractSSE(t);
                        if (content.length > seen) {
                            seen = content.length;
                            onText(content);
                        }
                    } catch (e) {}
                },
                onload(resp) {
                    const t = resp.responseText || '';
                    if (resp.status < 200 || resp.status >= 300) {
                        let msg = `HTTP ${resp.status}`;
                        try { msg = JSON.parse(t)?.error?.message || msg; } catch (e) {}
                        reject(new Error(msg));
                        return;
                    }
                    try {
                        if (t.trimStart()[0] === '{') {
                            const data = JSON.parse(t);
                            resolve(data.choices?.[0]?.message?.content || '');
                        } else {
                            resolve(extractSSE(t));
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse response'));
                    }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Request timed out'))
            });
        });
    }

    function parseSegments(resp) {
        const out = {};
        // tolerate markers wrapped in markdown emphasis or code fences
        const cleaned = resp.replace(/^```[a-z]*\n?|```\s*$/g, '');
        const parts = cleaned.split(/\*{0,2}@@\s*(\d+)\s*@@\*{0,2}/);
        for (let i = 1; i < parts.length; i += 2) {
            const idx = parseInt(parts[i], 10);
            const text = (parts[i + 1] || '').trim();
            if (idx >= 1 && text) out[idx] = text;
        }
        return out;
    }

    // the stream may end mid-marker (e.g. a dangling "@@3") — hide that tail
    function stripPartialMarker(t) {
        return t.replace(/\n?\*{0,2}@{1,2}\d{0,4}\*{0,2}$/, '').trimEnd();
    }

    async function sendBatch(batch) {
        inFlight++;
        updateFab();
        for (const el of batch) setLoading(el);

        const cfg = getConfig();
        const chars = batch.reduce((n, el) => n + el._llmtrSrc.length, 0);
        const body = batch.map((el, i) => `@@${i + 1}@@\n${el._llmtrSrc}`).join('\n\n');
        try {
            const content = await streamChat({
                ...cfg,
                max_tokens: Math.min(8000, 500 + chars * 2),
                messages: [
                    { role: 'system', content: systemPrompt(cfg.lang) },
                    { role: 'user', content: body }
                ],
                onText(partial) {
                    const map = parseSegments(partial);
                    batch.forEach((el, i) => {
                        if (el.dataset.llmtrState !== 'loading') return;
                        const t = map[i + 1];
                        if (t) setStreaming(el, stripPartialMarker(t));
                    });
                }
            });
            const map = parseSegments(content);
            batch.forEach((el, i) => {
                if (map[i + 1]) setDone(el, map[i + 1], cfg);
                else setError(el);
            });
        } catch (err) {
            batch.forEach(el => retryOrError(el));
            showToast('翻译失败: ' + err.message, 'error');
        } finally {
            inFlight--;
            updateFab();
            dispatch();
        }
    }

    // ==========================================
    // Queue / dispatch
    // ==========================================
    let coldStart = true; // first batch of the page is kept tiny for fast first paint

    function enqueue(el) {
        const st = el.dataset.llmtrState;
        if (st === 'queued' || st === 'loading' || st === 'done') return;
        el.dataset.llmtrState = 'queued';
        pendingCount++;
        const cached = cacheGet(el._llmtrSrc, getConfig());
        if (cached) {
            setDone(el, cached, null);
            return;
        }
        queue.push(el);
        updateFab();
    }

    function scheduleDispatch() {
        if (dispatchTimer) return;
        dispatchTimer = setTimeout(() => { dispatchTimer = null; dispatch(); }, 150);
    }

    // Lower score = translate sooner. On-screen blocks first (topmost wins),
    // then blocks below the viewport by distance, then blocks scrolled past.
    function priorityScore(el) {
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight || 800;
        if (r.bottom > 0 && r.top < vh) return Math.max(0, r.top);
        if (r.top >= vh) return vh + (r.top - vh);
        return vh * 10 + (0 - r.bottom);
    }

    function dispatch() {
        if (!enabled) return;
        if (queue.length && inFlight < CONCURRENCY) {
            const score = new Map(queue.map(el => [el, priorityScore(el)]));
            queue.sort((a, b) => score.get(a) - score.get(b));
            while (inFlight < CONCURRENCY && queue.length) {
                const maxSegs = coldStart ? COLD_MAX_SEGMENTS : BATCH_MAX_SEGMENTS;
                const maxChars = coldStart ? COLD_CHAR_LIMIT : BATCH_CHAR_LIMIT;
                const batch = [];
                let chars = 0;
                while (queue.length && batch.length < maxSegs) {
                    const len = queue[0]._llmtrSrc.length;
                    if (batch.length && chars + len > maxChars) break;
                    batch.push(queue.shift());
                    chars += len;
                }
                if (batch.length) {
                    coldStart = false;
                    sendBatch(batch);
                }
            }
        }
        maybeScheduleEager();
    }

    // Once the visible region is translated and we go idle, prefetch the rest
    // of the article ahead of the reader — one chunk per idle period, capped
    // per page so comment threads and infinite feeds don't burn tokens (the
    // IntersectionObserver keeps translating lazily beyond the cap).
    // priorityScore keeps on-screen blocks ahead, so scrolling still preempts.
    let prefetchedChars = 0;

    function eagerPrefetch() {
        allBlocks = allBlocks.filter(el => el.isConnected);
        let chunk = 0;
        for (const el of allBlocks) {
            if (el.dataset.llmtrState) continue; // queued/loading/done/error already
            if (io) io.unobserve(el);
            enqueue(el);
            if (el.dataset.llmtrState === 'queued') { // not served from cache
                chunk += el._llmtrSrc.length;
                prefetchedChars += el._llmtrSrc.length;
            }
            if (chunk >= PREFETCH_CHUNK_CHARS || prefetchedChars >= PREFETCH_MAX_CHARS) break;
        }
        if (chunk) scheduleDispatch();
    }

    function maybeScheduleEager() {
        if (CHAT) return; // chat hosts translate lazily via the settle gate, never bulk-prefetch
        if (!enabled || eagerScheduled || document.hidden) return;
        if (queue.length || inFlight > 0) return;
        if (prefetchedChars >= PREFETCH_MAX_CHARS) return;
        eagerScheduled = true;
        setTimeout(() => {
            eagerScheduled = false;
            // conditions may have changed during the wait — re-check idleness
            if (!enabled || document.hidden) return;
            if (queue.length || inFlight > 0) return;
            eagerPrefetch();
        }, 1200);
    }

    // ==========================================
    // Chat-app support (ChatGPT / Claude / Gemini)
    // These are streaming React SPAs: scope detection to assistant turns, and
    // hold each block back until its text stops changing (so we never translate
    // a half-written paragraph). A finished deep-research report settles on the
    // first tick; the tail of a live answer settles ~SETTLE_MS after it stops.
    // ==========================================
    const CHAT_PROFILES = [
        {
            test: /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/,
            roots: '[data-message-author-role="assistant"], .markdown.prose',
            busy: () => !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"i]'),
        },
        {
            test: /(^|\.)claude\.ai$/,
            roots: '.font-claude-message, [class*="artifact"] .prose',
            busy: () => !!document.querySelector('button[aria-label*="Stop"i]'),
        },
        {
            test: /(^|\.)gemini\.google\.com$/,
            roots: 'message-content, .model-response-text, deep-research-immersive-panel',
            busy: () => !!document.querySelector('button[aria-label*="Stop"i], .stop-icon'),
        },
    ];
    const CHAT = CHAT_PROFILES.find(p => p.test.test(location.hostname)) || null;

    const SETTLE_MS = 1200;
    const settleWatch = new Map(); // el -> { len, ts }
    let settleTimer = null;

    function watchSettle(el) {
        if (el.dataset.llmtrState || settleWatch.has(el)) return;
        settleWatch.set(el, { len: (el.innerText || '').length, ts: Date.now() });
        if (!settleTimer) settleTimer = setInterval(settleTick, 400);
    }

    function settleTick() {
        const now = Date.now();
        const busy = CHAT && CHAT.busy ? CHAT.busy() : false;
        let any = false;
        for (const [el, s] of settleWatch) {
            if (!el.isConnected) { settleWatch.delete(el); continue; }
            const len = (el.innerText || '').length;
            if (len !== s.len) { s.len = len; s.ts = now; continue; } // still growing
            // stable: translate once the model is idle, or after a quiet period
            if (!busy || now - s.ts >= SETTLE_MS) {
                settleWatch.delete(el);
                enqueue(el);
                any = true;
            }
        }
        if (any) scheduleDispatch();
        if (!settleWatch.size && settleTimer) { clearInterval(settleTimer); settleTimer = null; }
    }

    // Route a freshly-visible block: chat hosts wait for it to settle first.
    function admit(el) {
        if (CHAT) watchSettle(el);
        else enqueue(el);
    }

    // ==========================================
    // Observers
    // ==========================================
    function scan() {
        const found = [];
        // On chat hosts, scope to assistant turns — but if those selectors find
        // nothing (the app renamed its classes, or no answer has rendered yet),
        // fall back to the whole page so a selector change degrades to the
        // generic behavior instead of a dead button.
        const roots = CHAT ? document.querySelectorAll(CHAT.roots) : [];
        const targets = roots.length ? roots : [document.body];
        for (const root of targets) collect(root, found);
        for (const el of found) { allBlocks.push(el); io.observe(el); }
    }

    function boot() {
        booted = true;
        io = new IntersectionObserver((entries) => {
            let any = false;
            for (const en of entries) {
                if (!en.isIntersecting) continue;
                io.unobserve(en.target);
                admit(en.target);
                any = true;
            }
            // skip the debounce when nothing is in flight — first visible
            // paragraph goes out immediately
            if (any) {
                if (inFlight === 0) dispatch();
                else scheduleDispatch();
            }
        }, { rootMargin: VIEWPORT_MARGIN });

        let moTimer = null;
        mo = new MutationObserver(() => {
            if (!enabled || moTimer) return;
            moTimer = setTimeout(() => {
                moTimer = null;
                if (enabled) { scan(); scheduleDispatch(); }
            }, 600);
        });
        mo.observe(document.body, { childList: true, subtree: true });

        // prefetch pauses while the tab is hidden — pick it back up on return
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) dispatch();
        });

        scan();
        scheduleDispatch();
    }

    // ==========================================
    // Toggle
    // ==========================================
    function enable() {
        const cfg = getConfig();
        if (!cfg.key) {
            showSettingsModal(() => enable());
            return;
        }
        enabled = true;
        document.documentElement.classList.remove('llmtr-hide');
        if (!booted) boot();
        else { scan(); scheduleDispatch(); }
        updateFab();
    }

    function disable() {
        enabled = false;
        document.documentElement.classList.add('llmtr-hide');
        updateFab();
    }

    function toggle() {
        if (enabled) disable();
        else enable();
    }

    // ==========================================
    // Floating button
    // ==========================================
    function updateFab() {
        if (!fab) return;
        fab.classList.toggle('on', enabled);
        fab.classList.toggle('busy', enabled && (inFlight > 0 || queue.length > 0));
        const n = pendingCount;
        if (enabled && n > 0) {
            badge.style.display = 'block';
            badge.textContent = n > 99 ? '99+' : String(n);
        } else {
            badge.style.display = 'none';
        }
        fab.title = enabled
            ? 'Hide translation (Ctrl+T) · right-click for settings'
            : 'Translate page (Ctrl+T) · right-click for settings';
    }

    function makeFab() {
        fab = document.createElement('button');
        fab.className = 'llmtr-fab llmtr-ui';
        fab.textContent = '译';
        badge = document.createElement('span');
        badge.className = 'llmtr-fab-badge';
        fab.appendChild(badge);
        fab.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggle(); };
        fab.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); showSettingsModal(() => {}); };
        document.body.appendChild(fab);
        updateFab();
    }

    // Only surface the button on pages with a meaningful amount of
    // foreign-language article text; the hotkey/menu always work.
    function pageLooksTranslatable() {
        let chars = 0, blocks = 0;
        for (const p of document.querySelectorAll('article p, main p, p, h1, h2')) {
            const t = (p.textContent || '').trim();
            if (t.length < 30 || looksLikeChinese(t)) continue;
            chars += t.length;
            blocks++;
            if (chars > 600 && blocks >= 3) return true;
        }
        // Old-web fallback: a text container whose paragraphs are <br><br> runs
        // with no semantic <p> (paulgraham.com, ...). Still requires real
        // paragraph structure, so app UIs without prose stay button-free.
        for (const c of document.querySelectorAll('font, td, div, blockquote')) {
            const t = (c.textContent || '').trim();
            if (t.length < 600 || looksLikeChinese(t)) continue;
            if (c.querySelector(BLOCKY_SELECTOR)) continue; // only leaf text containers
            if ((c.innerHTML.match(/(?:<br\s*\/?>\s*){2,}/gi) || []).length >= 2) return true;
        }
        return false;
    }

    // ==========================================
    // Toast
    // ==========================================
    function showToast(msg, type = 'success') {
        const old = document.querySelector('.llmtr-toast');
        if (old) old.remove();
        const toast = document.createElement('div');
        toast.className = `llmtr-toast llmtr-ui ${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 200);
        }, 2500);
    }

    // ==========================================
    // Settings modal
    // ==========================================
    function showSettingsModal(onSave) {
        if (document.querySelector('.llmtr-overlay')) return;
        const overlay = document.createElement('div');
        overlay.className = 'llmtr-overlay llmtr-ui';

        const modal = document.createElement('div');
        modal.className = 'llmtr-modal';

        const h3 = document.createElement('h3');
        h3.textContent = 'Inline Translator — Setup';
        modal.appendChild(h3);

        function addField(labelText, type, placeholder) {
            const label = document.createElement('label');
            label.textContent = labelText;
            modal.appendChild(label);
            const input = document.createElement('input');
            input.type = type;
            input.placeholder = placeholder;
            modal.appendChild(input);
            return input;
        }

        const keyInput   = addField('API Key *', 'password', 'sk-...');
        const urlInput   = addField('API URL', 'text', DEFAULT_URL);
        const modelInput = addField('Model', 'text', DEFAULT_MODEL);
        const langInput  = addField('Target language', 'text', DEFAULT_LANG);

        const status = document.createElement('div');
        status.className = 'llmtr-test-status';
        modal.appendChild(status);

        const actions = document.createElement('div');
        actions.className = 'llmtr-modal-actions';

        function addBtn(text, cls) {
            const b = document.createElement('button');
            b.textContent = text;
            if (cls) b.className = cls;
            actions.appendChild(b);
            return b;
        }

        const cancelBtn = addBtn('Cancel');
        const testBtn   = addBtn('Test');
        const saveBtn   = addBtn('Save', 'primary');

        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        keyInput.value   = GM_getValue('API_KEY', '');
        urlInput.value   = GM_getValue('API_URL', '');
        modelInput.value = GM_getValue('MODEL', '');
        langInput.value  = GM_getValue('TARGET_LANG', '');
        keyInput.focus();

        function getModalValues() {
            return {
                key:   keyInput.value.trim(),
                url:   urlInput.value.trim() || DEFAULT_URL,
                model: modelInput.value.trim() || DEFAULT_MODEL,
                lang:  langInput.value.trim() || DEFAULT_LANG,
            };
        }

        cancelBtn.onclick = () => overlay.remove();

        testBtn.onclick = async () => {
            const vals = getModalValues();
            if (!vals.key) { keyInput.style.borderColor = '#d32f2f'; return; }
            testBtn.textContent = 'Testing…';
            testBtn.disabled = true;
            status.className = 'llmtr-test-status';
            status.textContent = '';
            try {
                await sendRequest({
                    ...vals, max_tokens: 8, timeout: 15000,
                    messages: [{ role: 'user', content: 'hi' }]
                });
                status.className = 'llmtr-test-status ok';
                status.textContent = '✓ Connection successful';
            } catch (err) {
                status.className = 'llmtr-test-status err';
                status.textContent = '✗ ' + err.message;
            } finally {
                testBtn.textContent = 'Test';
                testBtn.disabled = false;
            }
        };

        saveBtn.onclick = () => {
            const vals = getModalValues();
            if (!vals.key) { keyInput.style.borderColor = '#d32f2f'; return; }
            GM_setValue('API_KEY', vals.key);
            GM_setValue('API_URL', vals.url);
            GM_setValue('MODEL', vals.model);
            GM_setValue('TARGET_LANG', vals.lang);
            overlay.remove();
            onSave();
        };

        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') overlay.remove(); });
    }

    // ==========================================
    // Selection translation (划词翻译)
    // A small "译" button appears next to any text selection; clicking it
    // streams the translation into a floating bubble. Independent of the
    // page-wide bilingual mode, and shares the same local cache.
    // ==========================================
    let selBtn = null;
    let selPop = null;
    let selAnchor = null; // Range the button/bubble stay glued to while scrolling
    let selRaf = null;

    function removeSelBtn() {
        if (selBtn) { selBtn.remove(); selBtn = null; }
        if (!selPop) selAnchor = null;
    }
    function removeSelPop() {
        if (selPop) { selPop.remove(); selPop = null; }
        if (!selBtn) selAnchor = null;
    }

    function placeSelBtn(rect) {
        if (!selBtn) return;
        selBtn.style.left = Math.min(rect.right + 6, window.innerWidth - 34) + 'px';
        selBtn.style.top  = Math.min(rect.bottom + 6, window.innerHeight - 34) + 'px';
    }

    function placeSelPop(rect) {
        if (!selPop) return;
        const w = selPop.offsetWidth, h = selPop.offsetHeight;
        selPop.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - w - 10)) + 'px';
        let top = rect.bottom + 8;
        if (top + h > window.innerHeight - 10) top = Math.max(10, rect.top - h - 8);
        selPop.style.top = top + 'px';
    }

    function repositionSelUI() {
        if (!selAnchor || (!selBtn && !selPop)) return;
        let rect;
        try { rect = selAnchor.getBoundingClientRect(); } catch (e) { return; }
        placeSelBtn(rect);
        placeSelPop(rect);
    }

    function onSelScroll() {
        if (!selBtn && !selPop) return;
        if (selRaf) return;
        selRaf = requestAnimationFrame(() => { selRaf = null; repositionSelUI(); });
    }

    // Short, punctuation-free selections are dictionary lookups; anything
    // sentence-like gets a plain translation instead of the dictionary card.
    function isDictionaryQuery(text) {
        if (text.length > 60) return false;
        if (/[.!?;,:。！？；，：\n]/.test(text)) return false;
        return text.split(/\s+/).length <= 8;
    }

    function selectionTranslatePrompt(lang) {
        return `You are a professional translation engine. Translate the user's text into ${lang}.

Rules:
- Translate naturally and fluently, preserving meaning, tone, and register.
- Keep inline code, commands, URLs, file paths, math, and brand/product names as-is.
- Output ONLY the translation — no explanations, notes, or quotes.`;
    }

    function selectionPrompt(lang) {
        return `You are a concise bilingual learner's dictionary. Explain the user's selected text in ${lang}.

Output only the answer, using this compact plain-text format:
翻译: ...
词性: ... (only for a single word, omit if not applicable)
释义: ...
例句: ... -> ...
用法: ... (omit if there is no useful nuance)

Rules:
- Be concise and practical.
- For phrases and idioms, explain the whole expression instead of word-by-word translation.
- Keep inline code, URLs, file paths, and proper nouns as-is.
- Do not add greetings, quotes, labels other than the format above, or unrelated notes.`;
    }

    function getSelectionInfo() {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
        const text = sel.toString().trim();
        if (text.length < 1 || !/\p{L}/u.test(text)) return null;
        if (targetIsChinese() && looksLikeChinese(text)) return null;
        const node = sel.anchorNode;
        const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
        if (!el || el.isContentEditable || el.closest('input, textarea, .llmtr-ui')) return null;
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) return null;
        return { text, rect, range: range.cloneRange() };
    }

    function showSelButton(info) {
        removeSelBtn();
        const b = document.createElement('button');
        b.className = 'llmtr-sel-btn llmtr-ui';
        b.textContent = '译';
        b.title = 'Translate selection';
        // keep the selection alive when the button is pressed
        b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
        b.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            translateSelection(info.text, info.rect, info.range);
        });
        document.body.appendChild(b);
        selBtn = b;
        selAnchor = info.range;
        placeSelBtn(info.rect);
    }

    function showSelPopup(rect, wide) {
        removeSelPop();
        const p = document.createElement('div');
        p.className = 'llmtr-sel-pop llmtr-ui' + (wide ? ' llmtr-sel-wide' : '');
        const body = document.createElement('div');
        body.className = 'llmtr-sel-pop-body llmtr-sel-loading';
        body.textContent = '· · ·';
        p.appendChild(body);
        p._body = body;
        p.style.left = rect.left + 'px';
        p.style.top  = (rect.bottom + 8) + 'px';
        p.addEventListener('mousedown', (e) => e.stopPropagation());
        document.body.appendChild(p);
        selPop = p;
        // clamp into the viewport once we know the bubble's size
        requestAnimationFrame(() => { if (selPop === p) placeSelPop(rect); });
    }

    function appendText(parent, className, text) {
        const el = document.createElement('div');
        el.className = className;
        el.textContent = text;
        parent.appendChild(el);
        return el;
    }

    // Typeset the dictionary-style answer (macOS 词典-look): bold headword,
    // italic gray part-of-speech beside it, captioned sections, serif italics
    // for example sentences. Falls back to plain text for free-form replies.
    function renderSelectionPopup(body, text) {
        const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length < 2 && !/^翻译\s*[:：]/.test(lines[0] || '')) {
            body.textContent = text;
            return;
        }
        body.replaceChildren();
        const title = appendText(body, 'llmtr-sel-title', lines[0].replace(/^翻译\s*[:：]\s*/, ''));
        let lastContent = null;
        for (const line of lines.slice(1)) {
            const m = line.match(/^(词性|释义|例句|用法)\s*[:：]\s*(.*)$/);
            if (!m) {
                // continuation of the previous field, or free-form extra text
                if (lastContent) lastContent.append('\n' + line);
                else appendText(body, 'llmtr-sel-detail', line);
                continue;
            }
            const label = m[1], val = m[2];
            if (label === '词性') {
                appendText(title, 'llmtr-sel-pos', val);
                continue;
            }
            const row = appendText(body, 'llmtr-sel-row', '');
            appendText(row, 'llmtr-sel-label', label);
            const content = appendText(row, 'llmtr-sel-content', '');
            if (label === '例句') {
                const arrow = val.split(/\s*(?:->|→)\s*/);
                appendText(content, 'llmtr-sel-ex-src', arrow[0]);
                if (arrow.length > 1) appendText(content, 'llmtr-sel-ex-tr', arrow.slice(1).join(' '));
            } else {
                content.textContent = val;
            }
            lastContent = content;
        }
    }

    function setPopupText(text, loading, error, plain) {
        if (!selPop) return;
        const body = selPop._body;
        if (error || plain) body.textContent = text;
        else renderSelectionPopup(body, text);
        body.classList.toggle('llmtr-sel-loading', !!loading);
        body.classList.toggle('llmtr-sel-error', !!error);
        repositionSelUI(); // streamed text grows the bubble — keep it in view
    }

    function translateSelection(text, rect, range) {
        removeSelBtn();
        const cfg = getConfig();
        if (!cfg.key) { showSettingsModal(() => {}); return; }

        const src = text.slice(0, MAX_SEGMENT_CHARS);
        const dict = isDictionaryQuery(src);
        showSelPopup(rect, !dict);
        selAnchor = range; // removeSelBtn cleared it while no popup existed

        const cacheSrc = (dict ? 'selection-dictionary-v1' : 'selection-translate-v1') + '\x00' + src;
        const cached = cacheGet(cacheSrc, cfg);
        if (cached) { setPopupText(cached, false, false, !dict); return; }

        streamChat({
            ...cfg,
            max_tokens: Math.min(4000, 200 + src.length * 2),
            messages: [
                { role: 'system', content: dict ? selectionPrompt(cfg.lang) : selectionTranslatePrompt(cfg.lang) },
                { role: 'user', content: src }
            ],
            onText(partial) { setPopupText(partial, true, false, !dict); }
        }).then((full) => {
            const out = (full || '').trim();
            setPopupText(out || '(no translation)', false, false, !dict);
            if (out) cachePut(cacheSrc, out, cfg);
        }).catch((err) => {
            setPopupText('⚠ ' + err.message, false, true);
        });
    }

    function initSelectionTranslate() {
        document.addEventListener('mouseup', (e) => {
            if (e.target.closest && e.target.closest('.llmtr-ui')) return;
            setTimeout(() => {
                const info = getSelectionInfo();
                if (info) showSelButton(info); else removeSelBtn();
            }, 10);
        });
        document.addEventListener('mousedown', (e) => {
            if (e.target.closest && e.target.closest('.llmtr-ui')) return;
            removeSelBtn();
            removeSelPop();
        });
        document.addEventListener('selectionchange', () => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) removeSelBtn();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { removeSelBtn(); removeSelPop(); }
        });
        window.addEventListener('scroll', onSelScroll, true);
        window.addEventListener('resize', onSelScroll);
    }

    // ==========================================
    // Init
    // ==========================================
    function init() {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyT') {
                const t = e.target;
                if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
                e.preventDefault();
                toggle();
            }
        });

        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('Translate / toggle (Ctrl+T)', toggle);
            GM_registerMenuCommand('Settings', () => showSettingsModal(() => {}));
        }

        initSelectionTranslate();

        // Show the floating button once the page looks like an article.
        // Keep watching for ~2 minutes with a decaying cadence: slow SPAs and
        // late-loading readers used to fall outside the old 15s window, leaving
        // the feature looking broken (Ctrl+T worked, but nothing showed it).
        let attempts = 0;
        const tryShowFab = () => {
            if (fab) return;
            if (CHAT || pageLooksTranslatable()) { makeFab(); return; }
            if (++attempts < 40) setTimeout(tryShowFab, attempts < 10 ? 1500 : 4000);
        };
        tryShowFab();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
