// ==UserScript==
// @name         NeetCode to Jupytext
// @namespace    https://github.com/wilbeibi
// @version      2.7.1
// @description  Export NeetCode problems + Python solutions to Jupytext Markdown. Click button or Ctrl+Shift+E.
// @author       wilbeibi
// @match        https://neetcode.io/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ============ DEBUG MODE ============
    // Set DEBUG = true (line 42) to enable detailed logging for troubleshooting

    // ============ STYLES ============

    GM_addStyle(`
        .nc-export-btn {
            position: fixed;
            top: 12px;
            right: 12px;
            z-index: 9999;
            background: #2d3748;
            color: #e2e8f0;
            border: 1px solid #4a5568;
            border-radius: 6px;
            padding: 8px 14px;
            font: 13px/1 system-ui, sans-serif;
            cursor: pointer;
            transition: background 0.15s;
        }

        .nc-export-btn:hover { background: #4a5568; }
        .nc-export-btn.ok { background: #276749; border-color: #48bb78; }
        .nc-export-btn.err { background: #9b2c2c; border-color: #fc8181; }
    `);

    // ============ UTILS ============

    const DEBUG = false; // Set to true for debugging
    const log = (...args) => DEBUG && console.log('[NC Export]', ...args);

    const getSlug = () => location.pathname.split('/problems/')[1]?.split(/[/?#]/)[0] || 'problem';

    function cleanCode(text) {
        if (!text) return '';
        // Replace non-breaking spaces (U+00A0) with regular spaces
        // Also remove other common non-printable characters
        return text
            .replace(/\u00A0/g, ' ')           // non-breaking space
            .replace(/\u200B/g, '')            // zero-width space
            .replace(/\uFEFF/g, '')            // zero-width no-break space
            .replace(/[\u2000-\u200F]/g, ' ')  // various unicode spaces
            .replace(/[\u202A-\u202E]/g, '');  // text direction marks
    }

    function isValidPythonCode(text) {
        if (!text || text.trim().length < 10) return false;

        // Check for common Python patterns
        const hasClass = /\bclass\s+\w+/.test(text);
        const hasDef = /\bdef\s+\w+/.test(text);
        const hasCommonKeywords = /(import|from|if|for|while|return|self)/.test(text);

        // Should have actual code, not just comments
        const nonCommentLines = text.split('\n').filter(line => {
            const trimmed = line.trim();
            return trimmed && !trimmed.startsWith('#');
        });

        return nonCommentLines.length >= 3 && (hasClass || hasDef || hasCommonKeywords);
    }

    function selectBestEditor(editors) {
        if (!editors || editors.length === 0) return null;

        log('Found', editors.length, 'editors');

        // Score each editor
        const scored = editors.map(ed => {
            const model = ed.getModel();
            if (!model) return { editor: ed, score: -1 };

            const code = model.getValue() || '';
            const language = model.getLanguageId?.() || '';
            const lines = code.split('\n').length;

            log('Editor:', { language, lines, codeLength: code.length });

            let score = 0;

            // Prefer Python
            if (language === 'python') score += 100;

            // Prefer substantial code
            if (code.length > 50) score += 50;
            if (lines > 5) score += 30;

            // Prefer code with valid Python patterns
            if (isValidPythonCode(code)) score += 200;

            // Penalize empty or template code
            if (code.trim().length < 10) score -= 1000;
            if (/^(class Solution:|def |# TODO)/.test(code.trim())) {
                // Template code is okay, just lower priority
                score -= 10;
            }

            return { editor: ed, code, score };
        });

        // Sort by score, pick best
        scored.sort((a, b) => b.score - a.score);
        log('Best editor score:', scored[0]?.score);

        return scored[0]?.score > 0 ? scored[0] : null;
    }

    function getCodeFromMonaco(retryCount = 0) {
        try {
            const m = unsafeWindow.monaco;
            if (!m?.editor) {
                log('Monaco not available');
                return null;
            }

            // Try focused editor first (user is actively editing it)
            const focused = m.editor.getFocusedEditor?.();
            if (focused) {
                const code = focused.getValue();
                if (code && code.trim().length > 0) {
                    log('Got code from focused editor:', code.length, 'chars');
                    return { code: cleanCode(code), method: 'focused', reliable: true };
                }
            }

            // Try all editors, pick the best one
            const editors = m.editor.getEditors();
            if (editors && editors.length > 0) {
                const best = selectBestEditor(editors);
                if (best) {
                    log('Got code from best editor:', best.code.length, 'chars');
                    return { code: cleanCode(best.code), method: 'best-editor', reliable: true };
                }
            }

            // Try all models as fallback
            const models = m.editor.getModels();
            if (models && models.length > 0) {
                log('Trying models:', models.length);
                for (const model of models) {
                    const code = model.getValue();
                    const lang = model.getLanguageId?.() || '';
                    if (code && code.trim().length > 0 && (lang === 'python' || lang === '')) {
                        log('Got code from model:', code.length, 'chars, lang:', lang);
                        return { code: cleanCode(code), method: 'model', reliable: true };
                    }
                }
            }
        } catch (e) {
            console.warn('[NC Export] Monaco access failed:', e);
        }

        // Retry logic for Angular timing issues
        if (retryCount < 2) {
            log('Retrying Monaco access, attempt:', retryCount + 1);
            return null; // Signal retry needed
        }

        return null;
    }

    async function getCode() {
        // Try Monaco API with retries
        for (let i = 0; i < 3; i++) {
            const result = getCodeFromMonaco(i);
            if (result) return result;

            // Wait before retry (Angular may still be initializing)
            if (i < 2) {
                log('Waiting 200ms before retry...');
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        // Fallback to DOM scraping (unreliable!)
        console.warn('[NC Export] Monaco API failed, using DOM fallback - code may be incomplete!');

        const editorContainer = document.querySelector('.monaco-editor .view-lines');
        if (editorContainer) {
            const text = editorContainer.innerText || editorContainer.textContent || '';
            if (text.trim()) {
                log('Got code from DOM:', text.length, 'chars');
                return { code: cleanCode(text), method: 'dom-fallback', reliable: false };
            }
        }

        return { code: '', method: 'none', reliable: false };
    }

    function getDifficulty() {
        const scope = document.querySelector('.question-tab') || document.body;
        const el = scope.querySelector('.difficulty-btn, [class*="difficulty"], .text-green-500, .text-yellow-500, .text-red-500');
        if (el) {
            const text = el.textContent.trim();
            if (/easy/i.test(text)) return 'Easy';
            if (/medium/i.test(text)) return 'Medium';
            if (/hard/i.test(text)) return 'Hard';
        }

        const scopedText = scope.textContent || '';
        if (/\bEasy\b/.test(scopedText)) return 'Easy';
        if (/\bMedium\b/.test(scopedText)) return 'Medium';
        if (/\bHard\b/.test(scopedText)) return 'Hard';

        return '';
    }

    function inlineToMarkdown(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag = node.tagName.toLowerCase();
        const text = [...node.childNodes].map(inlineToMarkdown).join('');

        if (tag === 'br') return '\n';
        if (tag === 'code') return `\`${text.trim()}\``;
        if (tag === 'strong' || tag === 'b') return `**${text.trim()}**`;
        if (tag === 'em' || tag === 'i') return `*${text.trim()}*`;
        if (tag === 'img') return imageToMarkdown(node);

        return text;
    }

    function normalizeCodeBlock(text) {
        if (!text) return '';
        let code = cleanCode(text).replace(/\r\n/g, '\n');
        if (code.startsWith('\n')) code = code.slice(1);
        return code.replace(/\s+$/g, '');
    }

    function imageToMarkdown(img) {
        if (!img) return '';
        const altRaw = img.getAttribute('alt') || 'image';
        const alt = altRaw.replace(/\s+/g, ' ').trim().replace(/]/g, '\\]');
        let src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original');

        if (!src) {
            const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
            if (srcset) {
                src = srcset.split(',')[0]?.trim().split(' ')[0];
            }
        }

        if (!src) return '';

        try {
            src = new URL(src, location.href).toString();
        } catch {
            // Keep original src if URL parsing fails.
        }

        return `![${alt}](${src})`;
    }

    function blockToMarkdown(node) {
        if (!node) return '';
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent || '';
            return text.trim() ? `${text.trim()}\n\n` : '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return '';

        const tag = node.tagName.toLowerCase();
        if (tag === 'pre') {
            const code = normalizeCodeBlock(node.textContent || '');
            return `\n\`\`\`\n${code}\n\`\`\`\n\n`;
        }
        if (tag === 'ul' || tag === 'ol') {
            const items = [...node.querySelectorAll(':scope > li')]
                .map(li => `- ${inlineToMarkdown(li).trim()}`)
                .join('\n');
            return items ? `${items}\n\n` : '';
        }
        if (tag === 'img') {
            const image = imageToMarkdown(node);
            return image ? `${image}\n\n` : '';
        }
        if (tag === 'p') {
            const text = inlineToMarkdown(node).trim();
            return text ? `${text}\n\n` : '';
        }
        if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'figure' || tag === 'blockquote') {
            return [...node.childNodes].map(blockToMarkdown).join('');
        }

        return [...node.childNodes].map(blockToMarkdown).join('');
    }

    function getQuestionBody() {
        const selectors = [
            'app-article .my-article-component-container > div',
            'app-article',
            'article',
            'main'
        ];
        const article = selectors.map(sel => document.querySelector(sel)).find(Boolean);
        if (!article) return '';

        const clone = article.cloneNode(true);
        clone.querySelectorAll('details.hint-accordion, details.company-tags-accordion, .hint-accordion, .company-tags-accordion').forEach(el => el.remove());

        const text = [...clone.childNodes].map(blockToMarkdown).join('');
        return text.replace(/\n{3,}/g, '\n\n').trim();
    }

    function download(text, filename) {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = Object.assign(document.createElement('a'), {
            href: url,
            download: filename,
            style: 'display:none'
        });

        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // ============ GENERATE JUPYTEXT ============

    async function generateJupytext() {
        const slug = getSlug();
        const title = document.querySelector('h1')?.textContent.trim() || slug;
        const difficulty = getDifficulty();
        const questionBody = getQuestionBody();
        const codeResult = await getCode();
        const url = location.href.split('?')[0];
        const date = new Date().toISOString().split('T')[0];

        const code = codeResult.code || '# TODO: paste your solution here';
        const reliable = codeResult.reliable;
        const method = codeResult.method;

        log('Code extraction method:', method, 'reliable:', reliable);

        // Add warning comment if unreliable method was used
        const warningComment = !reliable
            ? `# WARNING: Code extracted using unreliable method (${method}).\n# Please verify completeness and check for syntax errors.\n\n`
            : '';

        const lines = [
            '---',
            'jupyter:',
            '  jupytext:',
            '    formats: md:markdown',
            '  kernelspec:',
            '    display_name: Python 3',
            '    name: python3',
            '---',
            '',
            `# ${title}`,
            '',
            `**Difficulty**: ${difficulty || 'N/A'} | **Language**: python | **Date**: ${date}`,
            '',
            `[NeetCode](${url})`,
            '',
            '## Problem Description',
            '',
            questionBody || '# TODO: Add problem description',
            '',
            '## Solution',
            '',
            '```python',
            warningComment + code,
            '```',
            '',
            '## Complexity',
            '',
            '- **Time**: O(?)',
            '- **Space**: O(?)',
            '',
            '## Tests',
            '',
            '```python',
            '# TODO: add test cases',
            '```',
        ];

        return { content: lines.join('\n'), filename: `${slug}.md`, reliable };
    }

    // ============ UI ============

    let btn = null;

    function createButton() {
        if (btn) return btn;
        btn = document.createElement('button');
        btn.className = 'nc-export-btn';
        btn.textContent = '📓 Export (.md)';
        btn.title = 'Export to Jupytext (Ctrl+Shift+E)';
        btn.addEventListener('click', doExport);
        document.body.appendChild(btn);

        return btn;
    }

    function flashButton(type, msg, duration = 1500) {
        if (!btn) return;
        const orig = btn.textContent;
        btn.textContent = msg;
        btn.classList.add(type);
        setTimeout(() => {
            btn.textContent = orig;
            btn.classList.remove(type);
        }, duration);
    }

    async function doExport() {
        try {
            const { content, filename, reliable } = await generateJupytext();
            download(content, filename);

            if (reliable) {
                flashButton('ok', '✓ Downloaded');
            } else {
                // Show warning for unreliable extraction
                flashButton('ok', '⚠ Downloaded (verify code)', 2500);
                console.warn('[NC Export] Code extracted using unreliable method. Please verify completeness.');
            }
        } catch (e) {
            console.error('[NC Export]', e);
            flashButton('err', '✗ Error');
        }
    }

    // ============ INIT ============

    function init() {
        if (document.querySelector('.nc-export-btn')) return;
        createButton();

        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'e') {
                e.preventDefault();
                doExport();
            }
        });

        console.log('[NC Export] Ready. Click button or Ctrl+Shift+E to export.');
    }

    let lastPath = location.pathname;

    new MutationObserver(() => {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            if (lastPath.includes('/problems/')) {
                btn?.remove();
                btn = null;
                setTimeout(init, 300);
            } else {
                btn?.remove();
                btn = null;
            }
        }
    }).observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
