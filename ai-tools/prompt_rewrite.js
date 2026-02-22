// ==UserScript==
// @name         Prompt Rewriter
// @namespace    http://tampermonkey.net/
// @version      3.2.0
// @description  Rewrite prompts using AI - 7 Question Form Types
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

    // Configuration
    const API_KEY = String(GM_getValue('DEEPSEEK_API_KEY', '') || '').trim();
    const API_URL = 'https://api.deepseek.com/chat/completions';
    const MODEL = 'deepseek-chat';

    // ==========================================
    // 7 QUESTION FORM TYPES - TAXONOMY
    // ==========================================
    const MODES = [
        {
            key: 'clarify_intent',
            label: '🧭 Clarify',
            desc: 'Intent Check, Ask 1-3 Qs',
            signals: ['clarify', 'clarification', 'intent', 'intention', 'what do you mean', '澄清', '意图', '意向', '先问'],
            prompt: `Rewrite this prompt into a 2-phase interaction that clarifies intent before answering.

**Phase 1: Clarify intent (mandatory)**
- Ask **1 to 3** short multiple-choice questions (Q1, Q2, Q3).
- Each question must include **2-4 options** labeled A/B/C(/D).
- Options should represent **plausible interpretations or constraints** of the user's request.
- Keep options **mutually exclusive** and **actionable**.
- If uncertainty remains, include an **"Other"** option with a short free-text fill-in.

**User reply format:**
Ask the user to reply with **letters only** in order (e.g., "ABA" or "A B A").

**Phase 2: Answer**
After the user replies, **rest the selected options briefly** and answer the original request based on those choices.

**Important:** Do NOT answer the original question in Phase 1. Only ask clarifying questions.

DO NOT answer. ONLY rewrite.`
        },
        {
            key: 'concept_explain',
            label: '📖 Explain',
            desc: 'Concept + Teaching, Clear Mental Model',
            signals: ['是啥', 'what is', '什么是', '背景', 'define', '定义', '讲讲', '解释', 'explain', 'teach', 'how does', 'why does', 'first principles'],
            prompt: `Rewrite this prompt to combine conceptual clarity with a structured teaching explanation.

**Output Structure (non-negotiable):**
1. **One-sentence definition** (no jargon; conclusion first)
2. **Intuitive analogy** (map to a known mental model)
3. **Key mechanism** (how it actually works - the "engine")
4. **Minimal example** (walk through smallest case, then generalize)
5. **Typical use cases** (2-3 concrete scenarios)
6. **Common misconceptions** (what it's NOT)
7. **Trade-offs & when NOT to use** (failure modes, alternatives)

**If term is ambiguous:** List 2-3 possible meanings, then ask the model to identify which is most likely OR explain all in parallel.

**If user mentions "I don't understand X":** Add: "Use the smallest possible example to demonstrate, then abstract the pattern."

**Context to request (if missing):**
- Why are you asking? (debugging, learning, evaluating)
- Depth needed: surface-level vs deep dive
- Background level: beginner vs advanced

DO NOT answer. ONLY rewrite.`
        },
        {
            key: 'comparison',
            label: '⚖️ Compare',
            desc: 'A vs B, When to Use',
            signals: ['vs', '区别', 'difference', 'compare', 'when to use', 'which', '选择', '优缺点'],
            prompt: `Rewrite this prompt to demand a rigorous comparison analysis:

**Force this comparison matrix:**
| Dimension | Option A | Option B | Winner & Why |
|-----------|----------|----------|--------------|
| Consistency Model | ... | ... | ... |
| Performance (latency/throughput) | ... | ... | ... |
| Complexity (code/ops) | ... | ... | ... |
| Observability | ... | ... | ... |
| Failure modes | ... | ... | ... |
| Migration cost | ... | ... | ... |

**If constraints are missing:** Auto-add: "Give recommendations for 2-3 archetypal scenarios (e.g., startup, enterprise, high-scale)."

**Bias check:** Explicitly request: "Ignore marketing hype. Use objective metrics where possible."

DO NOT answer. ONLY rewrite.`
        },
        {
            key: 'design_review',
            label: '🔍 Review',
            desc: 'Code/Arch Review, Gaps',
            signals: ['review', 'does this make sense', '分析', 'check', '看看', 'feedback', '欠缺'],
            prompt: `Rewrite this prompt to request a production-grade design review:

**Fixed output order:**
1. **Top 3 Risks** (failure modes, scalability bottlenecks, security holes)
2. **Missing requirements** (what's not specified: error handling, idempotency, pagination, auth, versioning, backpressure)
3. **Concrete improvements** (not "consider X" - give actual code/schema changes)
4. **Verification plan** (how to test/measure this - metrics, load tests, chaos scenarios)

**If target metrics are missing:** Request model to ask: "What are your latency/consistency/cost requirements?"

**Auto-complete to production-ready:** Ask model to fill in: error codes, retry logic, circuit breakers, monitoring hooks, graceful degradation.

DO NOT answer. ONLY rewrite.`
        },
        {
            key: 'debug',
            label: '🐛 Debug',
            desc: 'Why Broken, How to Fix',
            signals: ['为什么', 'why', '不理解', "doesn't work", 'error', 'bug', 'fix', '修', '问题'],
            prompt: `Rewrite this prompt to structure a systematic debugging process:

**Auto-generate minimal repro checklist:**
- Reproduction steps
- Expected vs actual behavior
- Environment (versions, config, OS, runtime)

**Required output format:**
1. **Likely causes** (ranked by probability)
2. **Verification method** for each cause (how to confirm it's THIS issue)
3. **Fix paths** (specific code/config changes, not vague suggestions)

**If repro is unclear:** Request model to ask: "What exactly happens vs what you expected? Can you provide a minimal test case?"

DO NOT answer. ONLY rewrite.`
        },
        {
            key: 'research',
            label: '🔬 Research',
            desc: 'Gather Evidence, N+ refs',
            signals: ['搜集', 'research', 'gather', '至少', 'survey', 'analysis', '分析活跃度', 'refer'],
            prompt: `Rewrite this prompt to enforce evidence-based research:

**Screening criteria (auto-add):**
- High engagement (stars, comments, decision-making discussions)
- Key counter-arguments (not just cheerleading)
- Recency bias: prioritize last 30/90 days for "current state" queries

**Mandatory output format:**
- Every claim MUST bind to evidence (link, issue ID, commit SHA, paper citation)
- Organize as: Finding → Evidence → Confidence level

**If scope is vague:** Request model to ask: "What's the time range? Which sources are trusted (e.g., GitHub, academic papers, official docs)? Output format: table vs bullet points?"

**For "activity analysis":** Force metrics: commit frequency, contributor growth/decline, issue resolution time, breaking changes.

DO NOT answer. ONLY rewrite.`
        },
        {
            key: 'document_interpret',
            label: '📄 Doc',
            desc: 'Based on URL/Doc, Explain',
            signals: ['根据', 'based on', 'this link', 'this url', 'this doc', '这个链接', 'according to'],
            prompt: `Rewrite this prompt to dissect document-based content:

**Fixed output structure:**
1. **Author's original claim** (verbatim key quotes)
2. **Restated in your words** (paraphrase for clarity)
3. **Design motivation** (why did they make this choice?)
4. **Implicit assumptions** (what constraints/beliefs are baked in?)
5. **Alternative approaches** (what else could work? trade-offs?)

**Uncertainty marking:** Anything NOT explicitly stated in the doc must be labeled "INFERENCE" or "IMPLIED".

**If request is vague:** Ask model: "Do you want: summary, critical analysis, framework abstraction, or faithful retelling?"

DO NOT answer. ONLY rewrite.`
        }
    ];

    const SYSTEM_SUFFIX = `

Return ONLY the rewritten prompt. No explanation, no preamble.

Original prompt:
`;

    // CSS - clean and polished
    const STYLE = `
.pr-btn {
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
}
.pr-btn:hover {
    background: rgba(240,240,255,0.95);
    border-color: rgba(100,100,255,0.4);
    transform: scale(1.05);
}
.pr-btn.loading { opacity: 0.5; pointer-events: none; }
.pr-menu {
    position: fixed;
    background: #fff;
    border: 1px solid rgba(128,128,128,0.15);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.12);
    z-index: 99999;
    min-width: 240px;
    opacity: 0;
    transform: translateY(-4px);
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
}
.pr-menu.open {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
}
.pr-menu-item {
    padding: 10px 14px;
    cursor: pointer;
    border-bottom: 1px solid rgba(128,128,128,0.1);
    transition: background 0.1s ease;
}
.pr-menu-item:first-child { border-radius: 10px 10px 0 0; }
.pr-menu-item:last-child { border-bottom: none; border-radius: 0 0 10px 10px; }
.pr-menu-item:hover { background: rgba(100,100,255,0.06); }
.pr-menu-item.suggested {
    background: rgba(100,200,100,0.08);
    border-left: 3px solid rgba(100,200,100,0.5);
}
.pr-menu-label {
    font-size: 13px;
    font-weight: 600;
    color: #333;
    display: flex;
    align-items: center;
    gap: 6px;
}
.pr-menu-desc {
    font-size: 11px;
    color: #888;
    margin-top: 2px;
    margin-left: 0;
}
.pr-menu-header {
    padding: 8px 14px;
    font-size: 10px;
    color: #666;
    font-weight: 600;
    text-transform: uppercase;
    background: rgba(128,128,128,0.05);
    border-bottom: 1px solid rgba(128,128,128,0.1);
    border-radius: 10px 10px 0 0;
}
@media (prefers-color-scheme: dark) {
    .pr-btn {
        background: rgba(50,50,50,0.95);
        border-color: rgba(100,100,100,0.4);
        color: #aaa;
    }
    .pr-btn:hover { background: rgba(60,60,80,0.95); }
    .pr-menu {
        background: #2a2a2a;
        border-color: rgba(100,100,100,0.2);
    }
    .pr-menu-item { border-color: rgba(100,100,100,0.15); }
    .pr-menu-item:hover { background: rgba(100,100,255,0.1); }
    .pr-menu-item.suggested {
        background: rgba(100,200,100,0.12);
        border-left-color: rgba(100,200,100,0.6);
    }
    .pr-menu-label { color: #eee; }
    .pr-menu-desc { color: #777; }
    .pr-menu-header {
        background: rgba(100,100,100,0.1);
        color: #999;
    }
}`;

    // State
    let initialized = false;
    let activeTextarea = null;

    // -------------------------------------------
    // Core functions
    // -------------------------------------------

    function getTextarea() {
        const selectors = [
            'div.ProseMirror[contenteditable="true"]', // Claude
            'textarea#prompt-textarea', // ChatGPT
            'div#prompt-textarea[contenteditable="true"]', // ChatGPT Alternative
            '.ql-editor.textarea.new-input-ui[contenteditable="true"]', // Gemini
            '.ql-editor[contenteditable="true"][role="textbox"]', // Gemini
            '[contenteditable="true"][role="textbox"]', // Generic
            'rich-textarea [contenteditable]', // Gemini Shadow DOM wrapper
            '[contenteditable="true"][aria-label]'
        ];

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }

        // Shadow DOM fallback
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

            const allElements = root.querySelectorAll('*');
            for (const element of allElements) {
                if (element.shadowRoot) {
                    const found = findInShadowDOM(element.shadowRoot, selector);
                    if (found) return found;
                }
            }
        } catch (e) {
            // Silently fail
        }
        return null;
    }

    function getText(el) {
        if (el.tagName === 'TEXTAREA') return el.value;
        return el.innerText;
    }

    function tryExecCommandInsert(el, text) {
        if (typeof document.execCommand !== 'function') return false;
        try {
            el.focus();
            const selection = window.getSelection();
            if (!selection) return false;
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
            return document.execCommand('insertText', false, text);
        } catch (e) {
            return false;
        }
    }

    function setText(el, text) {
        if (el.tagName === 'TEXTAREA') {
            el.value = text;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
            return;
        }

        const usedExec = tryExecCommandInsert(el, text);
        if (!usedExec) {
            el.textContent = '';
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                el.appendChild(document.createTextNode(lines[i]));
                if (i < lines.length - 1) {
                    el.appendChild(document.createElement('br'));
                }
            }
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
    }

    function showToast(msg, isError) {
        const old = document.getElementById('pr-toast');
        if (old) old.remove();

        const toast = document.createElement('div');
        toast.id = 'pr-toast';
        toast.textContent = msg;
        toast.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; padding: 12px 20px;
            background: ${isError ? '#d32f2f' : '#2e7d32'}; color: white;
            border-radius: 8px; font-size: 14px; z-index: 10000;
        `;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }

    // Auto-detect which mode matches the input text
    function detectMode(text) {
        const lower = text.toLowerCase();
        const scores = MODES.map(mode => {
            const matches = mode.signals.filter(sig => lower.includes(sig.toLowerCase()));
            return { mode, score: matches.length };
        });
        scores.sort((a, b) => b.score - a.score);
        return scores[0].score > 0 ? scores[0].mode : null;
    }

    async function rewritePrompt(text, mode) {
        const prompt = mode.prompt + SYSTEM_SUFFIX + text;
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
                    messages: [{ role: 'user', content: prompt }]
                }),
                onload: function(resp) {
                    let data = null;
                    let parseOk = false;
                    try {
                        data = JSON.parse(resp.responseText);
                        parseOk = true;
                    } catch (e) {}

                    if (resp.status && (resp.status < 200 || resp.status >= 300)) {
                        const msg = (parseOk && data?.error?.message) ? data.error.message : `HTTP ${resp.status}`;
                        reject(new Error(msg));
                        return;
                    }

                    if (!parseOk) {
                        reject(new Error('Failed to parse response'));
                        return;
                    }
                    if (data.error) {
                        reject(new Error(data.error.message));
                        return;
                    }
                    const content = data.choices?.[0]?.message?.content;
                    if (content) {
                        resolve(content.trim());
                    } else {
                        reject(new Error('Unexpected API response'));
                    }
                },
                onerror: function() {
                    reject(new Error('Network error'));
                },
                ontimeout: function() {
                    reject(new Error('Request timed out'));
                }
            });
        });
    }

    // -------------------------------------------
    // UI
    // -------------------------------------------

    function findContainer(textarea) {
        if (textarea.getRootNode() instanceof ShadowRoot) return null;

        const wrapper = textarea.closest('.text-input-field_textarea-wrapper')
            || textarea.closest('input-area-v2')
            || textarea.closest('rich-textarea')
            || textarea.closest('.input-area-container')
            || textarea.closest('.ql-container');
        if (wrapper) return wrapper;

        let el = textarea.parentElement;
        for (let i = 0; i < 10 && el && el !== document.body; i++) {
            const pos = getComputedStyle(el).position;
            if (pos !== 'static') return el;
            el = el.parentElement;
        }
        return textarea.parentElement;
    }

    function createMenu(suggestedMode) {
        const menu = document.createElement('div');
        menu.className = 'pr-menu';

        if (suggestedMode) {
            const header = document.createElement('div');
            header.className = 'pr-menu-header';
            header.textContent = '💡 Suggested';
            menu.appendChild(header);
        }

        for (const mode of MODES) {
            const item = document.createElement('div');
            item.className = 'pr-menu-item';
            if (suggestedMode && mode.key === suggestedMode.key) {
                item.classList.add('suggested');
            }
            item.dataset.mode = mode.key;

            const label = document.createElement('div');
            label.className = 'pr-menu-label';
            label.textContent = mode.label;

            const desc = document.createElement('div');
            desc.className = 'pr-menu-desc';
            desc.textContent = mode.desc;

            item.appendChild(label);
            item.appendChild(desc);
            menu.appendChild(item);
        }
        return menu;
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
            if (btn.parentNode) btn.parentNode.removeChild(btn);
        };
    }

    function injectButton(textarea) {
        if (textarea.dataset.prDone) return false;

        const btn = document.createElement('button');
        btn.className = 'pr-btn';
        btn.textContent = '✨';
        btn.title = 'Rewrite prompt (Auto-detect mode)';

        const container = findContainer(textarea);
        const needsFixed = !container || getComputedStyle(container).overflow === 'hidden';
        let cleanup = null;

        if (needsFixed) {
            cleanup = positionButtonFixed(btn, textarea);
        } else {
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }
            container.appendChild(btn);
            cleanup = () => {
                if (btn.parentNode) btn.parentNode.removeChild(btn);
            };
        }

        let currentMenu = null;

        function positionMenu(menu) {
            const rect = btn.getBoundingClientRect();
            let top = rect.bottom + 8;
            let left = rect.right - 240;

            if (top + 300 > window.innerHeight) {
                top = rect.top - 300 - 8;
            }
            if (left < 8) left = 8;

            menu.style.top = top + 'px';
            menu.style.left = left + 'px';
        }

        btn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();

            const text = getText(textarea).trim();
            if (!text) {
                showToast('Nothing to rewrite', true);
                return;
            }
            if (!API_KEY) {
                showToast('Set API key first (see console)', true);
                console.log('Run in console: GM_setValue("DEEPSEEK_API_KEY", "sk-...")');
                return;
            }

            // Close all other menus
            document.querySelectorAll('.pr-menu.open').forEach(m => {
                m.classList.remove('open');
                if (m !== currentMenu) m.remove();
            });

            const isOpen = currentMenu && currentMenu.classList.contains('open');

            if (!isOpen) {
                // Remove old menu if exists
                if (currentMenu) currentMenu.remove();

                // Detect suggested mode
                const suggested = detectMode(text);
                currentMenu = createMenu(suggested);
                btn._prMenu = currentMenu;

                currentMenu.onclick = async function(e) {
                    const item = e.target.closest('.pr-menu-item');
                    if (!item) return;

                    const modeKey = item.dataset.mode;
                    const mode = MODES.find(m => m.key === modeKey);
                    if (!mode) return;

                    currentMenu.classList.remove('open');
                    await handleRewrite(textarea, btn, mode);
                };

                document.body.appendChild(currentMenu);
                positionMenu(currentMenu);
                currentMenu.classList.add('open');
            }
        };

        textarea._prBtn = btn;
        textarea._prCleanup = cleanup;
        btn._prCleanup = cleanup;
        textarea.dataset.prDone = '1';
        return true;
    }

    async function handleRewrite(textarea, btn, mode) {
        const text = getText(textarea).trim();
        if (!text) {
            showToast('Nothing to rewrite', true);
            return;
        }

        btn.classList.add('loading');
        const oldText = btn.textContent;
        btn.textContent = '⏳';

        try {
            const result = await rewritePrompt(text, mode);
            setText(textarea, result);
            showToast(`✓ Rewritten (${mode.label})`, false);
        } catch (err) {
            showToast('Error: ' + err.message, true);
        } finally {
            btn.classList.remove('loading');
            btn.textContent = oldText;
        }
    }

    document.addEventListener('click', function(e) {
        if (!e.target.closest('.pr-btn') && !e.target.closest('.pr-menu')) {
            const menus = document.querySelectorAll('.pr-menu.open');
            menus.forEach(m => m.classList.remove('open'));
        }
    });

    function cleanupTextarea(textarea) {
        if (!textarea) return;
        const btn = textarea._prBtn;
        if (btn && btn._prMenu) btn._prMenu.remove();
        if (btn && btn._prCleanup) btn._prCleanup();
        delete textarea._prBtn;
        delete textarea._prCleanup;
        textarea.removeAttribute('data-pr-done');
    }

    function checkForTextarea() {
        if (document.hidden) return;
        if (activeTextarea && !document.contains(activeTextarea)) {
            cleanupTextarea(activeTextarea);
            activeTextarea = null;
        }
        const textarea = getTextarea();
        if (textarea) {
            try {
                if (activeTextarea && activeTextarea !== textarea) {
                    cleanupTextarea(activeTextarea);
                }
                injectButton(textarea);
                activeTextarea = textarea;
            } catch (err) {
                console.error('Prompt Rewriter error:', err);
            }
        }
    }

    function init() {
        if (initialized) return;
        initialized = true;

        const style = document.createElement('style');
        style.textContent = STYLE;
        document.head.appendChild(style);

        checkForTextarea();

        let timer = null;
        const observer = new MutationObserver(function() {
            if (timer) return;
            timer = setTimeout(function() {
                timer = null;
                checkForTextarea();
            }, 200);
        });

        observer.observe(document.body, { childList: true, subtree: true });

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
