// ==UserScript==
// @name         Prompt Enhancer
// @namespace    http://tampermonkey.net/
// @version      4.0.0
// @description  One-click prompt enhancement for AI chat interfaces
// @author       You
// @match        https://claude.ai/*
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.deepseek.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const API_KEY = String(GM_getValue('DEEPSEEK_API_KEY', '') || '').trim();
    const API_URL = 'https://api.deepseek.com/chat/completions';
    const MODEL = 'deepseek-chat';

    // ==========================================
    // ENHANCEMENT SYSTEM PROMPT
    // The AI decides the strategy — not the user.
    // ==========================================
    const SYSTEM_PROMPT = `You are a prompt enhancement engine. Your job is to take a user's draft prompt and return a strictly better version.

**Analysis (internal, do NOT output):**
1. Detect the user's intent category: explain, compare, debug, review, research, document-analysis, or general.
2. Detect what's missing: context, constraints, output format, examples, success criteria.
3. Detect language: respond in the same language as the input.

**Enhancement rules — apply ALL that are relevant:**

- **Add structure:** If the prompt is vague, add a clear output format (bullets, table, steps, etc.)
- **Add constraints:** Word limits, depth level, audience, scope boundaries
- **Add context scaffolding:** "Given that I am [role] working on [task]..." when inferrable
- **Add specificity:** Replace vague words ("good", "best", "explain") with precise asks
- **Add output format:** Request the format that best fits the intent (table for comparisons, steps for how-to, etc.)
- **Add success criteria:** What would make the answer "done" or "good enough"
- **Preserve voice:** Keep the user's tone and intent. Don't over-formalize casual prompts.
- **Keep it concise:** The enhanced prompt should be tighter, not longer for the sake of length.

**Category-specific enhancements (apply when detected):**

For EXPLAIN prompts: Request definition → analogy → mechanism → example → misconceptions
For COMPARE prompts: Request comparison table with dimensions, winner per dimension, recommendation by scenario
For DEBUG prompts: Add repro steps structure, ranked causes, verification method per cause
For REVIEW prompts: Request top risks, missing requirements, concrete fixes (not vague suggestions), verification plan
For RESEARCH prompts: Require evidence-binding (every claim → source), confidence levels, recency preference
For DOCUMENT prompts: Request original claim → restatement → design motivation → assumptions → alternatives

**Reflection suffix (only for DEBUG, REVIEW, RESEARCH prompts):**
For these categories only, append to the enhanced prompt:
"Before answering, generate at least two objections to your initial reasoning, then respond to those objections."

**What NOT to do:**
- Do NOT answer the original question
- Do NOT add preamble like "Here's your enhanced prompt:"
- Do NOT wrap in quotes or markdown code blocks
- Do NOT change the fundamental ask — only make it clearer and more likely to get a great answer

Return ONLY the enhanced prompt, nothing else.`;

    // ==========================================
    // CSS
    // ==========================================
    const STYLE = `
.pe-btn {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 1px solid rgba(128,128,128,0.3);
    background: rgba(255,255,255,0.95);
    cursor: pointer;
    font-size: 14px;
    z-index: 999;
    transition: all 0.15s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    line-height: 1;
}
.pe-btn:hover {
    background: rgba(240,240,255,0.95);
    border-color: rgba(100,100,255,0.4);
    transform: scale(1.05);
}
.pe-btn.loading {
    pointer-events: none;
    animation: pe-pulse 1s ease-in-out infinite;
}
@keyframes pe-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
}
.pe-btn.has-undo {
    background: rgba(100,200,100,0.15);
    border-color: rgba(100,200,100,0.4);
}
.pe-toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 10px 16px;
    border-radius: 8px;
    font-size: 13px;
    z-index: 100000;
    color: white;
    opacity: 0;
    transform: translateY(8px);
    transition: all 0.2s ease;
    pointer-events: none;
}
.pe-toast.visible {
    opacity: 1;
    transform: translateY(0);
}
.pe-toast.success { background: #2e7d32; }
.pe-toast.error { background: #d32f2f; }
.pe-toast.info { background: #1565c0; }
@media (prefers-color-scheme: dark) {
    .pe-btn {
        background: rgba(50,50,50,0.95);
        border-color: rgba(100,100,100,0.4);
        color: #aaa;
    }
    .pe-btn:hover {
        background: rgba(60,60,80,0.95);
        border-color: rgba(120,120,255,0.4);
    }
    .pe-btn.has-undo {
        background: rgba(100,200,100,0.12);
        border-color: rgba(100,200,100,0.3);
    }
}`;

    // ==========================================
    // State
    // ==========================================
    let initialized = false;
    let activeTextarea = null;
    let undoStack = []; // { el, text } — last original text before enhance

    // ==========================================
    // Textarea detection (kept from v3, it works)
    // ==========================================
    function getTextarea() {
        const selectors = [
            'div.ProseMirror[contenteditable="true"]',
            'textarea#prompt-textarea',
            'div#prompt-textarea[contenteditable="true"]',
            '.ql-editor.textarea.new-input-ui[contenteditable="true"]',
            '.ql-editor[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"][role="textbox"]',
            'rich-textarea [contenteditable]',
            '[contenteditable="true"][aria-label]'
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        const shadow = findInShadowDOM(document.body, '[contenteditable="true"]');
        if (shadow) return shadow;
        const active = document.activeElement;
        if (active?.isContentEditable) return active;
        if (active?.shadowRoot) {
            const el = active.shadowRoot.querySelector('[contenteditable="true"]');
            if (el) return el;
        }
        return null;
    }

    function findInShadowDOM(root, selector) {
        try {
            const el = root.querySelector(selector);
            if (el) return el;
            for (const element of root.querySelectorAll('*')) {
                if (element.shadowRoot) {
                    const found = findInShadowDOM(element.shadowRoot, selector);
                    if (found) return found;
                }
            }
        } catch (e) {}
        return null;
    }

    function getText(el) {
        return el.tagName === 'TEXTAREA' ? el.value : el.innerText;
    }

    function setText(el, text) {
        if (el.tagName === 'TEXTAREA') {
            el.value = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            return;
        }
        // Try execCommand for undo-friendly insertion
        try {
            el.focus();
            const sel = window.getSelection();
            if (sel) {
                const range = document.createRange();
                range.selectNodeContents(el);
                sel.removeAllRanges();
                sel.addRange(range);
                if (document.execCommand('insertText', false, text)) return;
            }
        } catch (e) {}
        // Fallback
        el.textContent = '';
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            el.appendChild(document.createTextNode(lines[i]));
            if (i < lines.length - 1) el.appendChild(document.createElement('br'));
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }

    // ==========================================
    // Toast
    // ==========================================
    function showToast(msg, type = 'success') {
        const old = document.querySelector('.pe-toast');
        if (old) old.remove();
        const toast = document.createElement('div');
        toast.className = `pe-toast ${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('visible'));
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 200);
        }, 2500);
    }

    // ==========================================
    // API call
    // ==========================================
    function callAPI(userPrompt) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: API_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + API_KEY
                },
                timeout: 30000,
                data: JSON.stringify({
                    model: MODEL,
                    max_tokens: 2048,
                    messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: userPrompt }
                    ]
                }),
                onload(resp) {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (resp.status < 200 || resp.status >= 300) {
                            reject(new Error(data?.error?.message || `HTTP ${resp.status}`));
                            return;
                        }
                        const content = data.choices?.[0]?.message?.content?.trim();
                        if (content) resolve(content);
                        else reject(new Error('Empty response'));
                    } catch (e) {
                        reject(new Error('Failed to parse response'));
                    }
                },
                onerror: () => reject(new Error('Network error')),
                ontimeout: () => reject(new Error('Request timed out'))
            });
        });
    }

    // ==========================================
    // Core: enhance or undo
    // ==========================================
    async function handleClick(textarea, btn) {
        // If we have undo available, undo instead
        const lastUndo = undoStack.find(u => u.el === textarea);
        if (lastUndo && btn.classList.contains('has-undo')) {
            setText(textarea, lastUndo.text);
            undoStack = undoStack.filter(u => u.el !== textarea);
            btn.classList.remove('has-undo');
            btn.textContent = '✨';
            btn.title = 'Enhance prompt (Ctrl+Shift+E)';
            showToast('Reverted to original', 'info');
            return;
        }

        const text = getText(textarea).trim();
        if (!text) {
            showToast('Nothing to enhance', 'error');
            return;
        }
        if (!API_KEY) {
            showToast('Set API key: see console', 'error');
            console.log('Run: GM_setValue("DEEPSEEK_API_KEY", "sk-...")');
            return;
        }

        // Save for undo
        undoStack = undoStack.filter(u => u.el !== textarea);
        undoStack.push({ el: textarea, text });

        btn.classList.add('loading');
        btn.textContent = '⏳';

        try {
            const result = await callAPI(text);
            setText(textarea, result);
            btn.classList.add('has-undo');
            btn.textContent = '↩';
            btn.title = 'Undo — restore original prompt';
            showToast('Prompt enhanced');
        } catch (err) {
            // Remove failed undo entry
            undoStack = undoStack.filter(u => u.el !== textarea);
            showToast('Error: ' + err.message, 'error');
        } finally {
            btn.classList.remove('loading');
            if (!btn.classList.contains('has-undo')) {
                btn.textContent = '✨';
            }
        }
    }

    // ==========================================
    // UI injection
    // ==========================================
    function findContainer(textarea) {
        if (textarea.getRootNode() instanceof ShadowRoot) return null;
        // Prefer positioned containers that aren't clipped
        const candidates = [
            'rich-textarea',                       // Gemini: position:relative, overflow:visible
            '.ql-container',                       // Gemini fallback
            'input-area-v2',
            '.input-area-container',
            '.text-input-field_textarea-wrapper',   // Gemini outer (overflow:hidden — last resort)
        ];
        for (const sel of candidates) {
            const el = textarea.closest(sel);
            if (el) {
                const style = getComputedStyle(el);
                // Skip containers that clip — we'll try fixed positioning instead
                if (style.overflow === 'hidden' || style.overflow === 'clip') continue;
                return el;
            }
        }
        // Walk up to find first positioned ancestor
        let el = textarea.parentElement;
        for (let i = 0; i < 10 && el && el !== document.body; i++) {
            if (getComputedStyle(el).position !== 'static') return el;
            el = el.parentElement;
        }
        return textarea.parentElement;
    }

    function positionButtonFixed(btn, textarea) {
        btn.style.position = 'fixed';
        const update = () => {
            const rect = textarea.getBoundingClientRect();
            btn.style.top = (rect.top + 4) + 'px';
            btn.style.left = (rect.right - 36) + 'px';
        };
        update();
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        document.body.appendChild(btn);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
            if (btn.parentNode) btn.remove();
        };
    }

    function injectButton(textarea) {
        if (textarea.dataset.peDone) return;

        const btn = document.createElement('button');
        btn.className = 'pe-btn';
        btn.textContent = '✨';
        btn.title = 'Enhance prompt (Ctrl+Shift+E)';

        const container = findContainer(textarea);
        const needsFixed = !container || getComputedStyle(container).overflow === 'hidden';
        let cleanup;

        if (needsFixed) {
            cleanup = positionButtonFixed(btn, textarea);
        } else {
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
            container.appendChild(btn);
            cleanup = () => { if (btn.parentNode) btn.remove(); };
        }

        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            handleClick(textarea, btn);
        };

        textarea._peBtn = btn;
        textarea._peCleanup = cleanup;
        textarea.dataset.peDone = '1';
    }

    function cleanupTextarea(textarea) {
        if (!textarea) return;
        if (textarea._peCleanup) textarea._peCleanup();
        delete textarea._peBtn;
        delete textarea._peCleanup;
        textarea.removeAttribute('data-pe-done');
    }

    // ==========================================
    // Keyboard shortcut: Ctrl+Shift+E
    // ==========================================
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.shiftKey && e.key === 'E') {
            e.preventDefault();
            const textarea = getTextarea();
            if (textarea && textarea._peBtn) {
                handleClick(textarea, textarea._peBtn);
            }
        }
    });

    // ==========================================
    // Observer loop
    // ==========================================
    function checkForTextarea() {
        if (document.hidden) return;
        if (activeTextarea && !document.contains(activeTextarea)) {
            cleanupTextarea(activeTextarea);
            activeTextarea = null;
        }
        const textarea = getTextarea();
        if (!textarea) return;
        if (activeTextarea && activeTextarea !== textarea) {
            cleanupTextarea(activeTextarea);
        }
        injectButton(textarea);
        activeTextarea = textarea;
    }

    function init() {
        if (initialized) return;
        initialized = true;

        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);

        checkForTextarea();

        let timer = null;
        new MutationObserver(() => {
            if (timer) return;
            timer = setTimeout(() => { timer = null; checkForTextarea(); }, 200);
        }).observe(document.body, { childList: true, subtree: true });

        if (window.location.hostname.includes('gemini.google.com')) {
            setInterval(checkForTextarea, 1000);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
