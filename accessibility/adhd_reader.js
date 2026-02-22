// ==UserScript==
// @name         ADHD-Friendly Line Highlighter (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      5.1
// @description  Highlights the text line under your cursor for better reading focus. Smart detection, performance optimized.
// @author       Enhanced Version
// @match        *://*/*
// @exclude      *://*.bilibili.com/*
// @exclude      *://bilibili.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-end
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.5.0/Readability.min.js
// ==/UserScript==

(function () {
    'use strict';

    // Configuration
    const DEFAULT_CONFIG = {
        enabled: true,
        highlightColor: 'rgba(135, 206, 250, 0.3)',
        lineHeight: 1.5,
        minParagraphLength: 50,  // Lowered for better detection
        minParagraphCount: 2,     // Lowered for better detection
        minTotalText: 500,        // Lowered for better detection
        smoothTransition: true,
        verticalPadding: 2,
        showToggleButton: true,
        keyboardShortcut: 'Alt+H',
        persistentHighlight: false,
        debugMode: false,         // New debug mode
        detectionSensitivity: 50, // Article detection threshold (0-100)
        excludedSites: [],        // User-managed site exclusions (hostnames or patterns)
        // Performance settings
        throttleMs: 16, // ~60fps max
        debounceMs: 100 // Delay before hiding on mouse stop
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

            // Readability caching to avoid heavy recomputation
            this.readabilityCache = null;
            this.readabilityCacheTime = 0;
            this.readabilityCacheTTL = 5000; // ms
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

        invalidateReadability() {
            this.readabilityCache = null;
            this.readabilityCacheTime = 0;
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
                background: white;
                padding: 20px;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                z-index: 1000000;
                max-width: 400px;
                display: none;
                font-family: Arial, sans-serif;
                color: #333;
            }
            .adhd-settings-panel h3 { margin-top: 0; }
            .adhd-settings-panel label { display: block; margin: 10px 0; color: #555; }
            .adhd-settings-panel input[type="range"] { width: 100%; }
            .adhd-settings-panel select { width: 100%; padding: 5px; margin-top: 5px; }
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
            .adhd-flash-message {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 10px 20px;
                background-color: #333;
                color: white;
                border-radius: 4px;
                font-family: Arial, sans-serif;
                z-index: 1000000;
                opacity: 0;
                transition: opacity 0.3s ease;
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
                if (window.adhdHighlighter) {
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

            // Update tooltip
            if (!this.state.articleLike) {
                button.title = 'ADHD Highlighter (Not available on this page)';
            } else if (this.state.config.enabled) {
                button.title = 'ADHD Highlighter Active (Click to disable, Right-click for settings)';
            } else {
                button.title = 'ADHD Highlighter Inactive (Click to enable, Right-click for settings)';
            }

            button.style.display = this.state.config.showToggleButton ? 'flex' : 'none';
        }

        createSettingsPanel() {
            if (this.state.settingsPanel) return;
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
                    Minimum paragraphs to activate:
                    <input type="number" id="adhd-min-paragraphs" min="1" max="10" value="${this.state.config.minParagraphCount}">
                </label>
                <label>
                    Minimum total text chars:
                    <input type="number" id="adhd-min-total" min="200" max="20000" value="${this.state.config.minTotalText}">
                </label>
                <label>
                    Article detection sensitivity: <span id="adhd-sensitivity-value">${this.state.config.detectionSensitivity}</span>
                    <input type="range" id="adhd-sensitivity" min="10" max="90" value="${this.state.config.detectionSensitivity}">
                    <small style="color: #666;">Lower = more sites, Higher = only clear articles</small>
                </label>
                <div style="margin-top:20px;text-align:center;">
                    <button class="adhd-settings-save">Save</button>
                    <button class="adhd-settings-cancel">Cancel</button>
                    <button class="adhd-settings-reset">Reset to Defaults</button>
                </div>
            `;
        }

        getOpacityPercent() {
            return Math.round((parseFloat(this.state.config.highlightColor.split(',')[3]) || 0.3) * 100);
        }

        bindSettingsEvents() {
            const panel = this.state.settingsPanel;
            const colorPreset = panel.querySelector('#adhd-color-preset');
            const colorPreview = panel.querySelector('#adhd-color-preview');
            const opacitySlider = panel.querySelector('#adhd-opacity');
            const opacityValue = panel.querySelector('#adhd-opacity-value');
            const paddingSlider = panel.querySelector('#adhd-padding');
            const paddingValue = panel.querySelector('#adhd-padding-value');
            const sensitivitySlider = panel.querySelector('#adhd-sensitivity');
            const sensitivityValue = panel.querySelector('#adhd-sensitivity-value');

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
            sensitivitySlider.addEventListener('input', () => {
                sensitivityValue.textContent = sensitivitySlider.value;
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
                minParagraphCount: parseInt(panel.querySelector('#adhd-min-paragraphs').value),
                minTotalText: parseInt(panel.querySelector('#adhd-min-total').value),
                detectionSensitivity: parseInt(panel.querySelector('#adhd-sensitivity').value)
            };

            this.state.saveConfig(updates);
            this.updateHighlightStyle();
            this.updateToggleButton();
            this.hideSettings();
            this.showFlashMessage('Settings saved!');
        }

        showSettings() {
            this.state.settingsPanel.style.display = 'block';
        }

        hideSettings() {
            this.state.settingsPanel.style.display = 'none';
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

    // Parse JSON-LD looking for Article-like objects
    function hasJsonLdArticle() {
        try {
            const scripts = document.querySelectorAll('script[type="application/ld+json"]');
            const types = new Set(['Article', 'NewsArticle', 'BlogPosting', 'TechArticle', 'Report', 'HowTo']);

            const seen = new WeakSet();
            const checkNode = (node) => {
                if (!node || typeof node !== 'object') return false;
                if (seen.has(node)) return false;
                seen.add(node);

                if (Array.isArray(node)) {
                    for (const item of node) {
                        if (checkNode(item)) return true;
                    }
                    return false;
                }

                const t = node['@type'];
                if (typeof t === 'string' && types.has(t)) return true;
                if (Array.isArray(t) && t.some(v => types.has(v))) return true;

                for (const key of Object.keys(node)) {
                    const val = node[key];
                    if (val && typeof val === 'object') {
                        if (checkNode(val)) return true;
                    }
                }
                return false;
            };

            for (const s of scripts) {
                const text = s.textContent || '';
                if (!text.trim()) continue;
                try {
                    const data = JSON.parse(text);
                    if (checkNode(data)) return true;
                } catch { }
            }
        } catch { }
        return false;
    }

    // Identify a main content container to scope queries
    function getMainContainer() {
        return (
            document.querySelector('article, main, [role="main"], .post-content, .entry-content, .ArticleBody, .post, .content, #content, #main') ||
            document.body
        );
    }

    // Compute simple content metrics within a container
    function computeContentMetrics(container, config) {
        const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6');
        const paragraphs = container.querySelectorAll('p');

        let longParagraphs = 0;
        let totalTextLength = 0;
        let maxParagraphLength = 0;
        let linkText = 0;

        for (const p of paragraphs) {
            const text = p.textContent.trim();
            const length = text.length;
            totalTextLength += length;
            if (length > maxParagraphLength) maxParagraphLength = length;
            if (length >= config.minParagraphLength) longParagraphs++;

            const links = p.querySelectorAll('a');
            for (const a of links) linkText += (a.textContent || '').trim().length;
        }

        // Find a candidate large text block for density checks
        const candidates = container.querySelectorAll('article, .post-content, .entry-content, .ArticleBody, .content, section, div');
        let maxBlockText = 0;
        let maxBlockLinks = 0;
        for (const el of candidates) {
            const role = (el.getAttribute('role') || '').toLowerCase();
            if (role === 'navigation' || role === 'banner' || role === 'complementary') continue;
            if (el.tagName === 'NAV' || el.tagName === 'ASIDE' || el.closest('nav, aside')) continue;

            const txt = (el.innerText || '').trim();
            const len = txt.length;
            if (len > maxBlockText) {
                maxBlockText = len;
                maxBlockLinks = Array.from(el.querySelectorAll('a')).reduce((n, a) => n + ((a.innerText || '').trim().length), 0);
            }
        }

        const linkDensity = totalTextLength > 0 ? (linkText / totalTextLength) : 1;
        const maxBlockLinkDensity = maxBlockText > 0 ? (maxBlockLinks / maxBlockText) : 1;

        return { headings, paragraphs, longParagraphs, totalTextLength, maxParagraphLength, linkDensity, maxBlockText, maxBlockLinkDensity };
    }

    function getReadabilityInsights(state) {
        if (typeof window.Readability !== 'function') {
            return null;
        }

        const now = Date.now();
        if (state.readabilityCache && (now - state.readabilityCacheTime) < state.readabilityCacheTTL) {
            return state.readabilityCache;
        }

        const result = { probable: true, success: false };
        const checker = typeof window.isProbablyReaderable === 'function'
            ? window.isProbablyReaderable
            : (typeof window.Readability.isProbablyReaderable === 'function'
                ? window.Readability.isProbablyReaderable.bind(window.Readability)
                : null);

        try {
            if (checker) {
                const probable = checker(document, {
                    minContentLength: Math.max(200, state.config.minTotalText * 0.5),
                    minScore: 45
                });
                result.probable = !!probable;
                if (!probable) {
                    result.success = false;
                    state.readabilityCache = result;
                    state.readabilityCacheTime = now;
                    return result;
                }
            }

            const clone = document.cloneNode(true);
            const reader = new window.Readability(clone, { keepClasses: false });
            const article = reader.parse();

            if (!article) {
                result.success = false;
                state.readabilityCache = result;
                state.readabilityCacheTime = now;
                return result;
            }

            const textContent = (article.textContent || '').trim();
            const textLength = textContent.length;

            const insights = {
                probable: result.probable !== undefined ? result.probable : true,
                success: true,
                textLength,
                title: article.title || '',
                byline: article.byline || '',
                siteName: article.siteName || '',
                quality: {
                    paragraphs: 0,
                    longParagraphs: 0,
                    listItems: 0,
                    codeBlocks: 0,
                    linkCount: 0,
                    sentenceCount: 0,
                    averageParagraphLength: textLength
                }
            };

            try {
                const parser = new DOMParser();
                const fragment = parser.parseFromString(article.content || '', 'text/html');
                const paragraphs = Array.from(fragment.querySelectorAll('p'));
                const longParagraphs = paragraphs.filter(p => p.textContent.trim().length >= state.config.minParagraphLength);
                const sentences = textContent.split(/[.!?]+\s/).filter(s => s.trim().length > 3);

                insights.quality.paragraphs = paragraphs.length;
                insights.quality.longParagraphs = longParagraphs.length;
                insights.quality.listItems = fragment.querySelectorAll('li').length;
                insights.quality.codeBlocks = fragment.querySelectorAll('pre, code').length;
                insights.quality.linkCount = fragment.querySelectorAll('a').length;
                insights.quality.sentenceCount = sentences.length;
                insights.quality.averageParagraphLength = paragraphs.length ? (textLength / paragraphs.length) : textLength;

            } catch (parserError) {
                if (state.config.debugMode) {
                    console.log('ADHD Highlighter: Readability quality parse failed', parserError);
                }
            }

            state.readabilityCache = insights;
            state.readabilityCacheTime = now;
            return insights;
        } catch (error) {
            if (state.config.debugMode) {
                console.log('ADHD Highlighter: Readability analysis failed', error);
            }
            result.error = error;
            state.readabilityCache = result;
            state.readabilityCacheTime = now;
            return result;
        }
    }

    // Smart article detection - only activate on actual articles/documents
    function isArticleLike(state) {
        const { config } = state;
        const url = window.location.href.toLowerCase();
        const hostname = window.location.hostname.toLowerCase();

        if (isSiteExcluded(hostname, config)) {
            if (config.debugMode) console.log('ADHD Highlighter: Excluded by user list:', hostname);
            return false;
        }

        const blacklistedSites = [
            'reddit.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
            'youtube.com', 'tiktok.com', 'linkedin.com', 'pinterest.com',
            'discord.com', 'slack.com', 'teams.microsoft.com',
            'gmail.com', 'outlook.com', 'mail.google.com',
            'amazon.com', 'ebay.com', 'alibaba.com', 'etsy.com',
            'netflix.com', 'hulu.com', 'disney.com', 'spotify.com',
            'bilibili.com', 'b23.tv',
            'github.com/search', 'stackoverflow.com/questions',
            'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com'
        ];

        for (const site of blacklistedSites) {
            if (hostname.includes(site)) {
                if (config.debugMode) console.log('ADHD Highlighter: Blacklisted site:', site);
                return false;
            }
        }

        const articleUrlPatterns = [
            '/article/', '/post/', '/blog/', '/news/', '/story/', '/read/',
            '/documentation/', '/docs/', '/wiki/', '/guide/', '/tutorial/',
            '/help/', '/support/', '/manual/', '/reference/', '/learn/'
        ];
        const dateSlug = /(19|20)\d{2}[\/\-](0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12][0-9]|3[01])|\/(19|20)\d{2}\//;
        const hasArticleUrl = articleUrlPatterns.some(pattern => url.includes(pattern)) || dateSlug.test(url);

        const articleSites = [
            'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
            'ghost.io', 'hashnode.com', 'dev.to', 'hackernoon.com',
            'wikipedia.org', 'wikimedia.org', 'wikibooks.org',
            'mozilla.org', 'developer.mozilla.org', 'w3schools.com',
            'stackoverflow.com/a/',
            'github.com/blob', 'github.io', 'gitlab.com/blob', 'bitbucket.org',
            'readthedocs.io', 'gitbook.io', 'notion.so',
            'nytimes.com', 'washingtonpost.com', 'theguardian.com', 'bbc.com',
            'reuters.com', 'ap.org', 'cnn.com', 'npr.org', 'pbs.org',
            'techcrunch.com', 'arstechnica.com', 'wired.com', 'engadget.com',
            'theverge.com', 'mashable.com', 'venturebeat.com'
        ];
        const isWhitelistedSite = articleSites.some(site => hostname.includes(site) || url.includes(site));

        const readability = getReadabilityInsights(state);
        if (readability && readability.probable === false) {
            if (config.debugMode) console.log('ADHD Highlighter: Readability ruled out article');
            return false;
        }

        const articleElements = document.querySelectorAll('article, [role="article"], .article, .post-content, .entry-content');
        const hasSemanticArticle = articleElements.length > 0;

        const hasAmp = !!document.querySelector('link[rel="amphtml"]');
        const hasArticleMeta = (
            document.querySelector('meta[property="og:type"][content*="article"]') ||
            document.querySelector('meta[property^="article:"]') ||
            document.querySelector('meta[name="article:author"]') ||
            document.querySelector('meta[property="article:published_time"], meta[itemprop="datePublished"], time[datetime]') ||
            hasJsonLdArticle()
        );

        const mainContent = getMainContainer();
        const { headings, paragraphs, longParagraphs, totalTextLength, maxParagraphLength, linkDensity, maxBlockText, maxBlockLinkDensity } = computeContentMetrics(mainContent, config);

        let score = 0;

        if (readability) {
            if (readability.success) {
                const quality = readability.quality || {};
                const paragraphsCount = quality.paragraphs || 0;
                const longParagraphCount = quality.longParagraphs || 0;
                const listItems = quality.listItems || 0;
                const codeBlocks = quality.codeBlocks || 0;
                const sentenceCount = quality.sentenceCount || 0;
                const averageParagraphLength = quality.averageParagraphLength || 0;

                const listRatio = paragraphsCount ? (listItems / paragraphsCount) : listItems;
                const codeRatio = Math.max(longParagraphCount, paragraphsCount) ? (codeBlocks / Math.max(longParagraphCount, paragraphsCount)) : codeBlocks;

                if (readability.textLength >= config.minTotalText) score += 35;
                else if (readability.textLength >= config.minTotalText * 0.8) score += 20;

                if (longParagraphCount >= Math.max(2, config.minParagraphCount)) score += 20;
                if (sentenceCount >= Math.max(8, config.minParagraphCount * 3)) score += 10;
                if (averageParagraphLength >= 80) score += 5;

                if (listRatio > 5) score -= 15;
                else if (listRatio > 3) score -= 8;

                if (codeRatio > 4) score -= 15;
                else if (codeRatio > 2.5) score -= 8;
            } else {
                score -= 5;
            }
        }

        if (isWhitelistedSite) score += 25;
        if (hasArticleUrl) score += 25;

        if (hasSemanticArticle) score += 25;
        if (hasArticleMeta) score += 25;
        if (hasAmp) score += 10;

        if (headings.length >= 2) score += 10;
        if (headings.length >= 4) score += 10;

        if (totalTextLength >= config.minTotalText) score += 20;
        if (totalTextLength >= config.minTotalText * 2) score += 10;
        if (longParagraphs >= config.minParagraphCount) score += 15;
        if (maxParagraphLength >= 200) score += 10;

        const hasReadingTime = document.querySelector('[class*="reading-time"], [data-reading-time], time[datetime]');
        const hasAuthor = document.querySelector('.author, [class*="author"], [rel="author"], meta[name="author"]');
        const hasDate = document.querySelector('time, .date, [class*="date"], [datetime], meta[property="article:published_time"], meta[itemprop="datePublished"]');

        if (hasReadingTime) score += 10;
        if (hasAuthor) score += 10;
        if (hasDate) score += 5;

        if (maxBlockText >= Math.max(800, config.minTotalText * 0.8)) score += 10;
        if (linkDensity < 0.6) score += 5;
        if (maxBlockLinkDensity < 0.5) score += 5;

        const hasSocialElements = document.querySelectorAll('.vote, .upvote, .downvote, .like, .share, .retweet, .comment-count').length > 0;
        if (hasSocialElements) score -= 15;

        const hasListIndicators = mainContent.querySelectorAll('ul li a, .list-item, .search-result, .feed-item').length > 10;
        if (hasListIndicators) score -= 20;

        const isApplicationLike = !!document.querySelector('[role="application"], canvas, [data-reactroot], [data-nextjs]');
        if (isApplicationLike) score -= 15;

        const isArticle = score >= config.detectionSensitivity;

        if (config.debugMode) {
            console.log('ADHD Highlighter: Article detection analysis:', {
                url: url.substring(0, 100),
                hostname,
                score,
                isArticle,
                factors: {
                    isWhitelistedSite,
                    hasArticleUrl,
                    hasSemanticArticle,
                    hasArticleMeta: !!hasArticleMeta,
                    hasAmp,
                    headings: headings.length,
                    paragraphs: paragraphs.length,
                    longParagraphs,
                    totalTextLength,
                    maxParagraphLength,
                    linkDensity,
                    maxBlockText,
                    maxBlockLinkDensity,
                    readability,
                    hasReadingTime: !!hasReadingTime,
                    hasAuthor: !!hasAuthor,
                    hasDate: !!hasDate,
                    hasSocialElements,
                    hasListIndicators,
                    isApplicationLike
                }
            });
        }

        return isArticle;
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
            const altRequired = parts.includes('Alt');
            const ctrlRequired = parts.includes('Ctrl');
            const shiftRequired = parts.includes('Shift');
            const key = parts[parts.length - 1].toLowerCase();

            if (e.altKey === altRequired &&
                e.ctrlKey === ctrlRequired &&
                e.shiftKey === shiftRequired &&
                e.key.toLowerCase() === key) {
                e.preventDefault();
                this.toggle();
            }
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

                if (isArticle && this.state.config.enabled) {
                    this.activate();
                } else if (!isArticle) {
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

        // Create UI components
        try {
            ui.createToggleButton();
            ui.createSettingsPanel();
        } catch (e) {
            console.error('ADHD Highlighter: Failed to create UI components:', e);
        }

        // Register menu commands
        GM_registerMenuCommand('ADHD Highlighter Settings', () => ui.showSettings());
        GM_registerMenuCommand('Toggle ADHD Highlighter', () => highlighter.toggle());
        GM_registerMenuCommand('Debug Mode', () => {
            state.config.debugMode = !state.config.debugMode;
            console.log('ADHD Highlighter: Debug mode', state.config.debugMode ? 'enabled' : 'disabled');
        });
        GM_registerMenuCommand(`Disable on this site (${hostname})`, () => {
            const list = Array.isArray(state.config.excludedSites) ? state.config.excludedSites : [];
            if (!list.some(p => matchHostname(hostname, p))) {
                state.saveConfig({ excludedSites: [...list, hostname] });
            }
            // Deactivate immediately and hide UI
            if (window.adhdHighlighter) {
                try { window.adhdHighlighter.deactivate(); } catch {}
            }
            try { ui.toggleButton?.remove(); } catch {}
            try { state.highlightDiv?.remove(); } catch {}
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

        // Initial content check
        state.articleLike = isArticleLike(state);
        if (state.articleLike && state.config.enabled) {
            highlighter.activate();
        }
        ui.updateToggleButton();

        // Throttled mutation observer for dynamic content
        const throttledCheck = throttle(() => {
            state.invalidateReadability();
            highlighter.checkContentType();
        }, 1000);

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
