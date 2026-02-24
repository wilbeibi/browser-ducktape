// ==UserScript==
// @name         ADHD-Friendly Line Highlighter (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      5.6
// @description  Highlights the text line under your cursor for better reading focus.
// @author       Enhanced Version
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
// @require      https://cdn.jsdelivr.net/npm/defuddle@0.6.6/dist/index.js
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // Configuration
    const DEFAULT_CONFIG = {
        enabled: true,
        highlightColor: 'rgba(135, 206, 250, 0.3)',
        lineHeight: 1.5,
        minTotalText: 3000,       // ~2 min read — only highlight articles worth focusing on
        smoothTransition: true,
        verticalPadding: 2,
        showToggleButton: true,
        keyboardShortcut: 'Alt+H',
        persistentHighlight: false,
        debugMode: false,
        excludedSites: [],        // User-managed site exclusions (hostnames or patterns)
        throttleMs: 16,           // ~60fps max
        debounceMs: 100           // Delay before hiding on mouse stop
    };

    const COLOR_PRESETS = {
        'Light Blue (Calming)': 'rgba(135, 206, 250, 0.3)',
        'Light Green (Nature)': 'rgba(144, 238, 144, 0.3)',
        'Light Yellow (Focus)': 'rgba(255, 255, 224, 0.3)',
        'Light Gray (Neutral)': 'rgba(211, 211, 211, 0.3)',
        'Light Pink (Soft)': 'rgba(255, 182, 193, 0.3)',
        'Light Purple (Creative)': 'rgba(221, 160, 221, 0.3)'
    };

    // Performance utilities
    function throttle(func, delay) {
        let timeoutId;
        let lastExecTime = 0;
        return function (...args) {
            const currentTime = Date.now();

            if (currentTime - lastExecTime > delay) {
                func.apply(this, args);
                lastExecTime = currentTime;
            } else {
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                    func.apply(this, args);
                    lastExecTime = Date.now();
                }, delay - (currentTime - lastExecTime));
            }
        };
    }

    function debounce(func, delay) {
        let timeoutId;
        return function (...args) {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func.apply(this, args), delay);
        };
    }

    // State management with performance optimizations
    class State {
        constructor() {
            this.config = this.loadConfig();
            this.highlightDiv = null;
            this.toggleButton = null;
            this.settingsPanel = null;
            this.isActive = false;
            this.articleLike = false;
            this.lastMouseX = 0;
            this.lastMouseY = 0;

            // Performance caches
            this.elementCache = new WeakMap();
            this.rectCache = new Map();
            this.lastCacheTime = 0;
            this.cacheTimeout = 100; // ms
        }

        loadConfig() {
            const config = { ...DEFAULT_CONFIG };
            Object.keys(DEFAULT_CONFIG).forEach(key => {
                const saved = GM_getValue(key);
                if (saved !== undefined) config[key] = saved;
            });
            return config;
        }

        saveConfig(updates) {
            Object.assign(this.config, updates);
            Object.entries(updates).forEach(([key, value]) => GM_setValue(key, value));
        }

        resetConfig() {
            Object.keys(DEFAULT_CONFIG).forEach(key => GM_setValue(key, DEFAULT_CONFIG[key]));
            this.config = { ...DEFAULT_CONFIG };
        }

        clearCaches() {
            this.rectCache.clear();
            this.lastCacheTime = 0;
        }

        getCachedRect(element) {
            const now = Date.now();
            if (now - this.lastCacheTime > this.cacheTimeout) {
                this.rectCache.clear();
                this.lastCacheTime = now;
            }

            if (!this.rectCache.has(element)) {
                this.rectCache.set(element, element.getBoundingClientRect());
            }
            return this.rectCache.get(element);
        }
    }

    // CSS with GPU acceleration hints
    function injectCSS() {
        GM_addStyle(`
            .adhd-line-highlight {
                position: absolute;
                pointer-events: none;
                z-index: 999998;
                mix-blend-mode: multiply;
                border-radius: 2px;
                display: none;
                will-change: transform;
            }
            .adhd-toggle-button {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 36px;
                height: 36px;
                border-radius: 50%;
                background: rgba(70, 130, 180, 0.9);
                backdrop-filter: blur(8px);
                border: 2px solid rgba(255,255,255,0.3);
                cursor: pointer;
                z-index: 999999;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                transition: all 0.3s ease;
                font-size: 14px;
                font-weight: bold;
                color: white;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0.6;
                user-select: none;
                will-change: transform, opacity;
            }
            .adhd-toggle-button:hover {
                opacity: 1;
                transform: scale(1.1);
                box-shadow: 0 3px 15px rgba(0,0,0,0.3);
            }
            .adhd-toggle-button.disabled {
                background: rgba(128,128,128,0.5);
                color: rgba(255,255,255,0.6);
                opacity: 0.4;
            }
            .adhd-toggle-button.active {
                background: rgba(46, 204, 113, 0.9);
                opacity: 0.8;
            }
            .adhd-settings-panel {
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: #fff;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                z-index: 1000000;
                max-width: 400px;
                width: 90%;
                display: none;
                font-family: Arial, sans-serif;
                color: #333;
            }
            .adhd-settings-panel h3 { margin-top: 0; color: #333; }
            .adhd-settings-panel label { display: block; margin: 10px 0; color: #555; }
            .adhd-settings-panel input[type="range"] { width: 100%; }
            .adhd-settings-panel select { width: 100%; padding: 5px; margin-top: 5px; background: #fff; color: #333; border: 1px solid #ccc; }
            .adhd-settings-panel button {
                margin: 5px;
                padding: 8px 16px;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
                color: #fff;
            }
            .adhd-settings-save { background-color: #4CAF50; }
            .adhd-settings-cancel { background-color: #f44336; }
            .adhd-settings-reset { background-color: #ff9800; }
            .adhd-settings-panel .color-preview {
                display: inline-block;
                width: 20px;
                height: 20px;
                border: 1px solid #ccc;
                vertical-align: middle;
                margin-left: 10px;
            }
            @media (prefers-color-scheme: dark) {
                .adhd-settings-panel {
                    background: #1e1e1e;
                    color: #e0e0e0;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.7);
                }
                .adhd-settings-panel h3 { color: #e0e0e0; }
                .adhd-settings-panel label { color: #bbb; }
                .adhd-settings-panel select { background: #2d2d2d; color: #e0e0e0; border-color: #555; }
                .adhd-settings-panel small { color: #888 !important; }
                .adhd-excluded-sites-list { border-color: #555; }
            }
            .adhd-settings-backdrop {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.4);
                z-index: 999999;
                display: none;
            }
            .adhd-settings-backdrop.visible { display: block; }
            .adhd-excluded-sites-list {
                max-height: 100px;
                overflow-y: auto;
                border: 1px solid #ddd;
                border-radius: 4px;
                padding: 4px;
                margin-top: 4px;
                font-size: 13px;
            }
            .adhd-excluded-site-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 2px 4px;
            }
            .adhd-excluded-site-item button {
                margin: 0;
                padding: 1px 6px;
                font-size: 11px;
                background-color: #f44336;
            }
            .adhd-flash-message {
                position: fixed;
                bottom: 65px;
                right: 20px;
                padding: 7px 14px;
                background-color: rgba(30,30,30,0.92);
                color: white;
                border-radius: 6px;
                font-family: Arial, sans-serif;
                font-size: 13px;
                z-index: 1000001;
                opacity: 0;
                transition: opacity 0.2s ease;
                white-space: nowrap;
            }
            .adhd-flash-message.show { opacity: 1; }
        `);
    }

    // UI components
    class UIComponents {
        constructor(state) {
            this.state = state;
        }

        createHighlightDiv() {
            if (this.state.highlightDiv) return;
            const div = document.createElement('div');
            div.className = 'adhd-line-highlight';
            this.updateHighlightStyle(div);
            document.body.appendChild(div);
            this.state.highlightDiv = div;
        }

        updateHighlightStyle(div = this.state.highlightDiv) {
            if (!div) return;
            div.style.backgroundColor = this.state.config.highlightColor;
            div.style.transition = this.state.config.smoothTransition ? 'all 150ms ease-in-out' : 'none';
        }

        createToggleButton() {
            if (this.state.toggleButton) return;
            const button = document.createElement('button');
            button.className = 'adhd-toggle-button';
            button.innerHTML = '📖';
            button.title = 'Toggle ADHD Line Highlighter (Alt+H, Right-click for settings)';
            button.style.display = this.state.config.showToggleButton ? 'flex' : 'none';

            button.addEventListener('click', () => {
                if (!window.adhdHighlighter) return;
                if (!window.adhdHighlighter.state.articleLike) {
                    // On non-article pages, click opens settings instead
                    this.showSettings();
                } else {
                    window.adhdHighlighter.toggle();
                }
            });
            button.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showSettings();
            });

            document.body.appendChild(button);
            this.state.toggleButton = button;
            this.updateToggleButton();
        }

        updateToggleButton() {
            if (!this.state.toggleButton) return;
            const button = this.state.toggleButton;

            // Update classes
            button.classList.toggle('disabled', !this.state.articleLike);
            button.classList.toggle('active', this.state.config.enabled && this.state.articleLike);

            // Update icon and tooltip based on state
            if (!this.state.articleLike) {
                button.innerHTML = '📄';
                button.title = 'ADHD Highlighter (Not available on this page — right-click for settings)';
            } else if (this.state.config.enabled) {
                button.innerHTML = '🔆';
                button.title = 'ADHD Highlighter Active (Click to disable, right-click for settings)';
            } else {
                button.innerHTML = '📖';
                button.title = 'ADHD Highlighter Inactive (Click to enable, right-click for settings)';
            }

            button.style.display = this.state.config.showToggleButton ? 'flex' : 'none';
        }

        createSettingsPanel() {
            if (this.state.settingsPanel) return;

            // Create backdrop
            const backdrop = document.createElement('div');
            backdrop.className = 'adhd-settings-backdrop';
            backdrop.addEventListener('click', () => this.hideSettings());
            document.body.appendChild(backdrop);
            this.state.settingsBackdrop = backdrop;

            const panel = document.createElement('div');
            panel.className = 'adhd-settings-panel';
            panel.innerHTML = this.getSettingsHTML();
            document.body.appendChild(panel);
            this.state.settingsPanel = panel;
            this.bindSettingsEvents();
        }

        getSettingsHTML() {
            return `
                <h3>ADHD Line Highlighter Settings</h3>
                <label>
                    Color Preset:
                    <select id="adhd-color-preset">
                        ${Object.entries(COLOR_PRESETS).map(([name, color]) =>
                `<option value="${color}" ${this.state.config.highlightColor === color ? 'selected' : ''}>${name}</option>`
            ).join('')}
                    </select>
                    <span class="color-preview" id="adhd-color-preview"></span>
                </label>
                <label>
                    Transparency: <span id="adhd-opacity-value">${this.getOpacityPercent()}%</span>
                    <input type="range" id="adhd-opacity" min="10" max="90" value="${this.getOpacityPercent()}">
                </label>
                <label>
                    Line Padding: <span id="adhd-padding-value">${this.state.config.verticalPadding}px</span>
                    <input type="range" id="adhd-padding" min="0" max="10" value="${this.state.config.verticalPadding}">
                </label>
                <label>
                    <input type="checkbox" id="adhd-smooth-transition" ${this.state.config.smoothTransition ? 'checked' : ''}>
                    Smooth transitions
                </label>
                <label>
                    <input type="checkbox" id="adhd-persistent" ${this.state.config.persistentHighlight ? 'checked' : ''}>
                    Keep highlight when mouse stops
                </label>
                <label>
                    <input type="checkbox" id="adhd-show-button" ${this.state.config.showToggleButton ? 'checked' : ''}>
                    Show toggle button
                </label>
                <label>
                    <input type="checkbox" id="adhd-debug-mode" ${this.state.config.debugMode ? 'checked' : ''}>
                    Debug mode (console logs)
                </label>
                <label>
                    Minimum visible text to activate (chars):
                    <input type="number" id="adhd-min-total" min="0" max="5000" value="${this.state.config.minTotalText}">
                    <small style="color: #666;">Set to 0 to activate on every page</small>
                </label>
                <label>
                    Excluded sites:
                    <div class="adhd-excluded-sites-list" id="adhd-excluded-sites">
                        ${this.getExcludedSitesHTML()}
                    </div>
                </label>
                <div style="margin-top:20px;text-align:center;">
                    <button class="adhd-settings-save">Save</button>
                    <button class="adhd-settings-cancel">Cancel</button>
                    <button class="adhd-settings-reset">Reset to Defaults</button>
                </div>
            `;
        }

        getOpacityPercent() {
            const m = this.state.config.highlightColor.match(/rgba?\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/);
            return Math.round((m ? parseFloat(m[1]) : 0.3) * 100);
        }

        getExcludedSitesHTML() {
            const list = Array.isArray(this.state.config.excludedSites) ? this.state.config.excludedSites : [];
            if (list.length === 0) return '<span style="color:#999;font-size:12px;">No excluded sites</span>';
            return list.map((site, i) =>
                `<div class="adhd-excluded-site-item">
                    <span>${escapeHtml(site)}</span>
                    <button class="adhd-remove-site" data-index="${i}">Remove</button>
                </div>`
            ).join('');
        }

        bindSettingsEvents() {
            const panel = this.state.settingsPanel;
            const colorPreset = panel.querySelector('#adhd-color-preset');
            const colorPreview = panel.querySelector('#adhd-color-preview');
            const opacitySlider = panel.querySelector('#adhd-opacity');
            const opacityValue = panel.querySelector('#adhd-opacity-value');
            const paddingSlider = panel.querySelector('#adhd-padding');
            const paddingValue = panel.querySelector('#adhd-padding-value');
            const updateColorPreview = () => {
                const baseColor = colorPreset.value;
                const opacity = opacitySlider.value / 100;
                const match = baseColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                if (match) {
                    colorPreview.style.backgroundColor = `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})`;
                }
            };

            colorPreset.addEventListener('change', updateColorPreview);
            opacitySlider.addEventListener('input', () => {
                opacityValue.textContent = `${opacitySlider.value}%`;
                updateColorPreview();
            });
            paddingSlider.addEventListener('input', () => {
                paddingValue.textContent = `${paddingSlider.value}px`;
            });
            updateColorPreview();

            panel.querySelector('.adhd-settings-save').addEventListener('click', () => this.saveSettings());
            panel.querySelector('.adhd-settings-cancel').addEventListener('click', () => this.hideSettings());
            panel.querySelector('.adhd-settings-reset').addEventListener('click', () => {
                if (confirm('Reset all settings to defaults?')) {
                    this.state.resetConfig();
                    location.reload();
                }
            });

            // Remove excluded site buttons (delegated)
            panel.querySelector('#adhd-excluded-sites').addEventListener('click', (e) => {
                const btn = e.target.closest('.adhd-remove-site');
                if (!btn) return;
                const idx = parseInt(btn.dataset.index, 10);
                const list = Array.isArray(this.state.config.excludedSites) ? [...this.state.config.excludedSites] : [];
                list.splice(idx, 1);
                this.state.saveConfig({ excludedSites: list });
                panel.querySelector('#adhd-excluded-sites').innerHTML = this.getExcludedSitesHTML();
            });
        }

        saveSettings() {
            const panel = this.state.settingsPanel;
            const colorPreset = panel.querySelector('#adhd-color-preset');
            const opacitySlider = panel.querySelector('#adhd-opacity');

            const baseColor = colorPreset.value;
            const opacity = opacitySlider.value / 100;
            const match = baseColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);

            const updates = {
                highlightColor: match ? `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})` : baseColor,
                verticalPadding: parseInt(panel.querySelector('#adhd-padding').value),
                smoothTransition: panel.querySelector('#adhd-smooth-transition').checked,
                persistentHighlight: panel.querySelector('#adhd-persistent').checked,
                showToggleButton: panel.querySelector('#adhd-show-button').checked,
                debugMode: panel.querySelector('#adhd-debug-mode').checked,
                minTotalText: parseInt(panel.querySelector('#adhd-min-total').value)
            };

            this.state.saveConfig(updates);
            this.updateHighlightStyle();
            this.updateToggleButton();
            this.hideSettings();
            this.showFlashMessage('Settings saved!');
        }

        showSettings() {
            // Re-render so panel reflects current config values
            this.state.settingsPanel.innerHTML = this.getSettingsHTML();
            this.bindSettingsEvents();

            if (this.state.settingsBackdrop) {
                this.state.settingsBackdrop.classList.add('visible');
            }
            this.state.settingsPanel.style.display = 'block';

            // Escape key to close
            if (this._escapeHandler) {
                document.removeEventListener('keydown', this._escapeHandler);
            }
            this._escapeHandler = (e) => {
                if (e.key === 'Escape') this.hideSettings();
            };
            document.addEventListener('keydown', this._escapeHandler);
        }

        hideSettings() {
            this.state.settingsPanel.style.display = 'none';
            if (this.state.settingsBackdrop) {
                this.state.settingsBackdrop.classList.remove('visible');
            }
            if (this._escapeHandler) {
                document.removeEventListener('keydown', this._escapeHandler);
                this._escapeHandler = null;
            }
        }

        showFlashMessage(msg) {
            const flash = document.createElement('div');
            flash.className = 'adhd-flash-message';
            flash.textContent = msg;
            document.body.appendChild(flash);

            setTimeout(() => flash.classList.add('show'), 10);
            setTimeout(() => {
                flash.classList.remove('show');
                setTimeout(() => flash.remove(), 300);
            }, 2000);
        }
    }

    // Detect if the page itself renders with a dark background
    function isPageDark() {
        try {
            // Check body first, fall back to html if body is transparent
            for (const el of [document.body, document.documentElement]) {
                const bg = window.getComputedStyle(el).backgroundColor;
                const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
                if (!m) continue;
                const alpha = m[4] !== undefined ? parseFloat(m[4]) : 1;
                if (alpha < 0.1) continue; // transparent, try next element
                const brightness = (parseInt(m[1], 10) * 299 + parseInt(m[2], 10) * 587 + parseInt(m[3], 10) * 114) / 1000;
                return brightness < 128;
            }
        } catch {}
        // Fallback to OS preference only if we can't determine from the page
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    }

    // Helper: escape HTML special characters
    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Helper: hostname pattern match (supports exact, suffix, and "*.domain")
    function matchHostname(hostname, pattern) {
        if (!pattern) return false;
        const h = String(hostname || '').toLowerCase();
        let p = String(pattern || '').toLowerCase().trim();
        if (!p) return false;
        if (p.startsWith('*.')) p = p.slice(2);
        if (p.startsWith('.')) p = p.slice(1);
        return h === p || h.endsWith('.' + p);
    }

    function isSiteExcluded(hostname, config) {
        const list = Array.isArray(config.excludedSites) ? config.excludedSites : [];
        return list.some(p => matchHostname(hostname, p));
    }

    // Detect if the page has meaningful readable content using Defuddle.
    // Defuddle works directly on `document` — no cloneNode needed (no perf cost).
    function isArticleLike(state) {
        const { config } = state;
        const hostname = window.location.hostname.toLowerCase();

        if (isSiteExcluded(hostname, config)) {
            if (config.debugMode) console.log('ADHD Highlighter: Excluded by user list:', hostname);
            return false;
        }

        // Skip pure app/canvas pages immediately
        if (document.querySelector('[role="application"], canvas:only-child')) return false;

        // Use Defuddle if available — no cloneNode, no layout reflow
        if (typeof Defuddle !== 'undefined') {
            try {
                const result = new Defuddle(document).parse();
                const textLen = (result && result.content ? result.content.replace(/<[^>]*>/g, '').length : 0);
                const active = textLen >= config.minTotalText;
                if (config.debugMode) console.log('ADHD Highlighter (Defuddle):', { textLen, threshold: config.minTotalText, active });
                return active;
            } catch (e) {
                if (config.debugMode) console.warn('ADHD Highlighter: Defuddle failed, falling back', e);
            }
        }

        // Fallback: count text in actual paragraphs — short UI snippets don't count
        let total = 0;
        let longParaCount = 0;
        const paragraphs = document.querySelectorAll('p, article, main, [role="main"]');
        for (const el of paragraphs) {
            const len = (el.textContent || '').trim().length;
            total += len;
            if (el.tagName === 'P' && len >= 80) longParaCount++;
        }

        // Need both: enough total text AND at least 3 real paragraphs
        const active = total >= config.minTotalText && longParaCount >= 3;

        if (config.debugMode) {
            console.log('ADHD Highlighter:', active ? 'Active' : 'Inactive', { total, longParaCount, threshold: config.minTotalText });
        }
        return active;
    }

    function getTextElementAt(x, y, state) {
        const el = document.elementFromPoint(x, y);
        if (!el) return null;

        // Skip input elements, buttons, and interactive elements
        const skipTags = new Set(['INPUT', 'TEXTAREA', 'BUTTON', 'SELECT', 'OPTION']);
        if (skipTags.has(el.tagName)) return null;

        // Check cache first
        if (state.elementCache.has(el)) {
            return state.elementCache.get(el);
        }

        const validTags = new Set(['P', 'DIV', 'SPAN', 'LI', 'DD', 'DT', 'TD', 'TH',
            'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            'BLOCKQUOTE', 'PRE', 'CODE', 'ARTICLE', 'SECTION',
            'FIGCAPTION', 'LABEL', 'LEGEND', 'SUMMARY']);
        let current = el;
        let result = null;

        while (current && current !== document.body) {
            // Skip if we hit an input or interactive element
            if (skipTags.has(current.tagName)) {
                result = null;
                break;
            }

            // Check if it's a valid text container
            if (validTags.has(current.tagName) &&
                current.textContent.trim().length > 0 &&
                !current.querySelector('input, textarea, button, select')) {

                // Additional check for actual text content (not just child elements)
                const hasDirectText = Array.from(current.childNodes).some(node =>
                    node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
                );

                if (hasDirectText || current.querySelector('span, em, strong, b, i, u, mark, small')) {
                    result = current;
                    break;
                }
            }
            current = current.parentElement;
        }

        // Cache the result
        state.elementCache.set(el, result);
        return result;
    }

    function getLinePosition(element, mouseY, config, state) {
        const rect = state.getCachedRect(element);
        const cs = getComputedStyle(element);
        let lineHeight = parseFloat(cs.lineHeight);
        const fontSize = parseFloat(cs.fontSize);

        if (isNaN(lineHeight) || cs.lineHeight === 'normal') {
            lineHeight = fontSize * config.lineHeight;
        }

        const relativeY = mouseY - rect.top;
        const lineNumber = Math.floor(relativeY / lineHeight);

        // Check if mouse is actually over text content
        const textNodes = [];
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function (node) {
                    return node.textContent.trim().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            }
        );

        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        // If no text nodes, don't highlight
        if (textNodes.length === 0) return null;

        // Check if mouse Y position corresponds to actual text
        const lineTop = rect.top + (lineNumber * lineHeight);
        const lineBottom = lineTop + lineHeight;

        // More precise check: see if there's actual text at this line
        let hasTextAtLine = false;
        for (const textNode of textNodes) {
            const range = document.createRange();
            range.selectNodeContents(textNode);
            const textRect = range.getBoundingClientRect();

            if (textRect.top <= lineBottom && textRect.bottom >= lineTop) {
                hasTextAtLine = true;
                break;
            }
        }

        if (!hasTextAtLine) return null;

        return {
            top: lineTop - config.verticalPadding,
            left: rect.left,
            width: rect.width,
            height: lineHeight + (config.verticalPadding * 2),
            element
        };
    }

    // Main highlighter logic with performance optimizations
    class Highlighter {
        constructor(state, ui) {
            this.state = state;
            this.ui = ui;
            this.isMoving = false;
            this.moveTimer = null;

            // Create bound event handlers (stored as properties for proper removal)
            this.boundHandleMouseMove = this.handleMouseMove.bind(this);
            this.boundHandleScroll = this.handleScroll.bind(this);
            this.boundHandleKeyboard = this.handleKeyboard.bind(this);
            this.boundHandleMouseLeave = this.handleMouseLeave.bind(this);

            // Create throttled and debounced functions
            this.throttledUpdate = throttle(this.updateHighlight.bind(this), this.state.config.throttleMs);
            this.debouncedHide = debounce(this.hideHighlight.bind(this), this.state.config.debounceMs);
        }

        toggle() {
            if (!this.state.articleLike) {
                this.ui.showFlashMessage('Not available on this page');
                return;
            }

            const enabled = !this.state.config.enabled;
            this.state.saveConfig({ enabled });

            if (enabled) {
                this.activate();
            } else {
                if (this.state.highlightDiv) {
                    this.hideHighlight();
                }
                this.deactivate();
            }

            this.ui.updateToggleButton();
            this.ui.showFlashMessage(enabled ? '✅ Highlighter enabled' : '❌ Highlighter disabled');
        }

        activate() {
            if (this.state.isActive) return;
            this.state.isActive = true;

            this.ui.createHighlightDiv();

            // Set blend mode based on actual page background, not OS preference
            if (this.state.highlightDiv) {
                this.state.highlightDiv.style.mixBlendMode = isPageDark() ? 'screen' : 'multiply';
            }

            // Use passive listeners for performance where possible
            document.addEventListener('mousemove', this.boundHandleMouseMove, { passive: true });
            document.addEventListener('scroll', this.boundHandleScroll, { passive: true });
            document.addEventListener('keydown', this.boundHandleKeyboard);
            document.addEventListener('mouseleave', this.boundHandleMouseLeave, { passive: true });

            if (this.state.config.debugMode) {
                console.log('ADHD Line Highlighter: Activated');
            }
        }

        deactivate() {
            if (!this.state.isActive) return;
            this.state.isActive = false;

            this.hideHighlight();
            this.state.clearCaches();

            // Remove using the same bound function references
            document.removeEventListener('mousemove', this.boundHandleMouseMove);
            document.removeEventListener('scroll', this.boundHandleScroll);
            document.removeEventListener('keydown', this.boundHandleKeyboard);
            document.removeEventListener('mouseleave', this.boundHandleMouseLeave);

            if (this.state.config.debugMode) {
                console.log('ADHD Line Highlighter: Deactivated');
            }
        }

        updateHighlight(x, y) {
            const { config, highlightDiv, articleLike } = this.state;
            if (!config.enabled || !articleLike || !highlightDiv) {
                if (config.debugMode && !config.enabled) {
                    console.log('ADHD Highlighter: Disabled');
                }
                if (config.debugMode && !articleLike) {
                    console.log('ADHD Highlighter: Not an article-like page');
                }
                return;
            }

            const textEl = getTextElementAt(x, y, this.state);
            if (!textEl) {
                // Hide immediately when not over text
                this.hideHighlight();
                return;
            }

            const linePos = getLinePosition(textEl, y, config, this.state);
            if (!linePos) {
                // Hide if no valid line position (no text at cursor position)
                this.hideHighlight();
                return;
            }

            const rect = this.state.getCachedRect(linePos.element);

            if (y < rect.top - config.verticalPadding ||
                y > rect.bottom + config.verticalPadding) {
                this.hideHighlight();
                return;
            }

            // Use requestAnimationFrame for smooth updates
            requestAnimationFrame(() => {
                highlightDiv.style.display = 'block';
                highlightDiv.style.top = (linePos.top + window.scrollY) + 'px';
                highlightDiv.style.left = (linePos.left + window.scrollX) + 'px';
                highlightDiv.style.width = linePos.width + 'px';
                highlightDiv.style.height = linePos.height + 'px';
            });
        }

        hideHighlight() {
            if (this.state.highlightDiv) {
                this.state.highlightDiv.style.display = 'none';
            }
        }

        handleMouseMove(e) {
            if (!this.state.isActive) return;

            this.state.lastMouseX = e.clientX;
            this.state.lastMouseY = e.clientY;
            this.isMoving = true;
            clearTimeout(this.moveTimer);

            // Use throttled update
            this.throttledUpdate(e.clientX, e.clientY);

            // Detect when mouse stops moving
            this.moveTimer = setTimeout(() => {
                this.isMoving = false;
            }, this.state.config.debounceMs);
        }

        handleScroll() {
            // Clear caches on scroll since positions change
            this.state.clearCaches();

            // Only update if mouse was recently moving
            if (this.isMoving && this.state.lastMouseX !== undefined) {
                this.throttledUpdate(this.state.lastMouseX, this.state.lastMouseY);
            }
        }

        handleKeyboard(e) {
            const { keyboardShortcut } = this.state.config;
            const parts = keyboardShortcut.split('+');
            const modifiers = new Set(parts.slice(0, -1).map(p => p.toLowerCase()));
            const key = parts[parts.length - 1].toLowerCase();

            if (e.altKey !== modifiers.has('alt')) return;
            if (e.ctrlKey !== modifiers.has('ctrl')) return;
            if (e.shiftKey !== modifiers.has('shift')) return;
            if (e.metaKey !== (modifiers.has('meta') || modifiers.has('cmd'))) return;
            if (e.key.toLowerCase() !== key) return;

            e.preventDefault();
            this.toggle();
        }

        handleMouseLeave() {
            this.isMoving = false;
            if (!this.state.config.persistentHighlight) {
                this.debouncedHide();
            }
        }

        checkContentType() {
            const isArticle = isArticleLike(this.state);
            if (isArticle !== this.state.articleLike) {
                this.state.articleLike = isArticle;

                if (this.state.config.debugMode) {
                    console.log('ADHD Highlighter: Content type changed -', isArticle ? 'Article detected' : 'Not an article');
                }

                if (isArticle) {
                    this.ui.createToggleButton(); // show button if page became article-like (SPA nav)
                    if (this.state.config.enabled) this.activate();
                } else {
                    this.deactivate();
                }
                this.ui.updateToggleButton();
            }
        }
    }

    // Main initialization
    function init() {
        // Check if already initialized
        if (window.adhdHighlighter) {
            console.warn('ADHD Highlighter already initialized');
            return;
        }

        const state = new State();
        const hostname = window.location.hostname.toLowerCase();
        // If user has excluded this site, only register a simple enable command and exit early
        if (isSiteExcluded(hostname, state.config)) {
            GM_registerMenuCommand('Enable ADHD Highlighter on this site', () => {
                const list = Array.isArray(state.config.excludedSites) ? state.config.excludedSites : [];
                const filtered = list.filter(p => !matchHostname(hostname, p));
                state.saveConfig({ excludedSites: filtered });
                location.reload();
            });
            if (state.config.debugMode) console.log('ADHD Highlighter: Skipping init; site excluded by user list');
            return;
        }

        injectCSS();

        const ui = new UIComponents(state);
        const highlighter = new Highlighter(state, ui);

        // Make globally accessible for UI events
        window.adhdHighlighter = highlighter;
        window.adhdHighlighterState = state;

        // Create UI components — defer button until we know it's article-like
        try {
            ui.createSettingsPanel();
        } catch (e) {
            console.error('ADHD Highlighter: Failed to create UI components:', e);
        }

        // Register menu commands
        GM_registerMenuCommand('ADHD Highlighter Settings', () => ui.showSettings());
        GM_registerMenuCommand('Toggle ADHD Highlighter', () => highlighter.toggle());
        GM_registerMenuCommand('Debug Mode', () => {
            state.saveConfig({ debugMode: !state.config.debugMode });
            console.log('ADHD Highlighter: Debug mode', state.config.debugMode ? 'enabled' : 'disabled');
        });
        GM_registerMenuCommand(`Disable on this site (${hostname})`, () => {
            const list = Array.isArray(state.config.excludedSites) ? state.config.excludedSites : [];
            if (!list.some(p => matchHostname(hostname, p))) {
                state.saveConfig({ excludedSites: [...list, hostname] });
            }
            // Deactivate immediately and hide UI
            window.adhdHighlighter?.deactivate();
            ui.toggleButton?.remove();
            state.highlightDiv?.remove();
            ui.showFlashMessage('🚫 Disabled on this site');
        });
        GM_registerMenuCommand('Force Enable on This Site', () => {
            if (!state.articleLike) {
                state.articleLike = true;
                if (state.config.enabled) {
                    highlighter.activate();
                }
                ui.updateToggleButton();
                ui.showFlashMessage('✅ Forced enabled on this site');
            } else {
                ui.showFlashMessage('Already active on this site');
            }
        });

        // Initial content check — only show button on article-like pages
        state.articleLike = isArticleLike(state);
        if (state.articleLike) {
            ui.createToggleButton();
            if (state.config.enabled) {
                highlighter.activate();
            }
        }
        ui.updateToggleButton();

        // Throttled mutation observer for dynamic content
        const throttledCheck = throttle(() => highlighter.checkContentType(), 1000);

        const observer = new MutationObserver(throttledCheck);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: false,
            characterData: false
        });

        // Success message
        if (state.config.debugMode || state.articleLike) {
            console.log(`ADHD Highlighter: Initialized (Article detected: ${state.articleLike}, Enabled: ${state.config.enabled})`);
        }
    }

    // Initialize with proper timing
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // Small delay to ensure page is fully rendered
        setTimeout(init, 100);
    }
})();
