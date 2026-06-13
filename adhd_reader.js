// ==UserScript==
// @name         ADHD-Friendly Line Highlighter (Enhanced)
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Highlights the text line under your cursor on text-dense article pages.
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
        keyboardNav: true,        // J/K step the highlight line by line
        buttonPosition: 'bottom-right',
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
            this.settingsBackdrop = null;
            this.isActive = false;
            this.articleLike = false;
            this.lastCheckedUrl = location.href;
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
            .adhd-corner-br { bottom: 20px; right: 20px; top: auto; left: auto; }
            .adhd-corner-bl { bottom: 20px; left: 20px; top: auto; right: auto; }
            .adhd-corner-tr { top: 20px; right: 20px; bottom: auto; left: auto; }
            .adhd-corner-tl { top: 20px; left: 20px; bottom: auto; right: auto; }
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
                max-height: 85vh;
                overflow-y: auto;
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
            .adhd-preview-line {
                margin: 8px 0 2px;
                padding: 2px 6px;
                border-radius: 2px;
                font-size: 14px;
                line-height: 1.5;
            }
            .adhd-exclude-row { display: flex; gap: 4px; margin-top: 6px; }
            .adhd-exclude-row input[type="text"] {
                flex: 1;
                min-width: 0;
                padding: 4px 6px;
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #fff;
                color: #333;
            }
            .adhd-exclude-row button {
                margin: 0;
                padding: 4px 8px;
                font-size: 12px;
                background-color: #607d8b;
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
                .adhd-exclude-row input[type="text"] { background: #2d2d2d; color: #e0e0e0; border-color: #555; }
            }
            @media (prefers-reduced-motion: reduce) {
                .adhd-line-highlight,
                .adhd-toggle-button,
                .adhd-flash-message,
                .adhd-preview-line { transition: none !important; }
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
                max-width: min(320px, 80vw);
                line-height: 1.4;
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
                if (this._suppressClick) {
                    this._suppressClick = false;
                    return;
                }
                window.adhdHighlighter?.toggle();
            });
            button.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.showSettings();
            });

            // Long-press opens settings on touch devices, where right-click doesn't exist
            let pressTimer = null;
            button.addEventListener('touchstart', () => {
                pressTimer = setTimeout(() => {
                    pressTimer = null;
                    this._suppressClick = true;
                    this.showSettings();
                }, 550);
            }, { passive: true });
            const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
            button.addEventListener('touchend', cancelPress, { passive: true });
            button.addEventListener('touchmove', cancelPress, { passive: true });

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
                button.title = 'ADHD Highlighter (Not available on this page — right-click or long-press for settings)';
            } else if (this.state.config.enabled) {
                button.innerHTML = '🔆';
                button.title = 'ADHD Highlighter Active (Click to disable, right-click or long-press for settings)';
            } else {
                button.innerHTML = '📖';
                button.title = 'ADHD Highlighter Inactive (Click to enable, right-click or long-press for settings)';
            }

            const corners = {
                'bottom-right': 'adhd-corner-br',
                'bottom-left': 'adhd-corner-bl',
                'top-right': 'adhd-corner-tr',
                'top-left': 'adhd-corner-tl'
            };
            button.classList.remove(...Object.values(corners));
            button.classList.add(corners[this.state.config.buttonPosition] || 'adhd-corner-br');

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
            const cfg = this.state.config;
            const activationPresets = [
                [3000, 'Long articles only (default)'],
                [800, 'Most pages with text'],
                [0, 'Every page']
            ];
            const hasCustomMin = !activationPresets.some(([v]) => v === cfg.minTotalText);
            const positions = {
                'bottom-right': 'Bottom right',
                'bottom-left': 'Bottom left',
                'top-right': 'Top right',
                'top-left': 'Top left'
            };
            return `
                <h3>ADHD Line Highlighter Settings</h3>
                <div class="adhd-preview-line" id="adhd-preview-line">The quick brown fox jumps over the lazy dog.</div>
                <label>
                    Color Preset:
                    <select id="adhd-color-preset">
                        ${Object.entries(COLOR_PRESETS).map(([name, color]) =>
                `<option value="${color}" ${cfg.highlightColor === color ? 'selected' : ''}>${name}</option>`
            ).join('')}
                    </select>
                </label>
                <label>
                    Transparency: <span id="adhd-opacity-value">${this.getOpacityPercent()}%</span>
                    <input type="range" id="adhd-opacity" min="10" max="90" value="${this.getOpacityPercent()}">
                </label>
                <label>
                    Line Padding: <span id="adhd-padding-value">${cfg.verticalPadding}px</span>
                    <input type="range" id="adhd-padding" min="0" max="10" value="${cfg.verticalPadding}">
                </label>
                <label>
                    <input type="checkbox" id="adhd-smooth-transition" ${cfg.smoothTransition ? 'checked' : ''}>
                    Smooth transitions
                </label>
                <label>
                    <input type="checkbox" id="adhd-persistent" ${cfg.persistentHighlight ? 'checked' : ''}>
                    Keep highlight when mouse leaves the page
                </label>
                <label>
                    <input type="checkbox" id="adhd-keyboard-nav" ${cfg.keyboardNav ? 'checked' : ''}>
                    Step lines with J / K keys
                </label>
                <label>
                    <input type="checkbox" id="adhd-show-button" ${cfg.showToggleButton ? 'checked' : ''}>
                    Show toggle button
                </label>
                <label>
                    Button position:
                    <select id="adhd-button-pos">
                        ${Object.entries(positions).map(([value, name]) =>
                `<option value="${value}" ${cfg.buttonPosition === value ? 'selected' : ''}>${name}</option>`
            ).join('')}
                    </select>
                </label>
                <label>
                    Activate on:
                    <select id="adhd-min-total">
                        ${activationPresets.map(([value, name]) =>
                `<option value="${value}" ${cfg.minTotalText === value ? 'selected' : ''}>${name}</option>`
            ).join('')}
                        ${hasCustomMin ? `<option value="${cfg.minTotalText}" selected>Custom (${cfg.minTotalText} chars)</option>` : ''}
                    </select>
                </label>
                <label>
                    Excluded sites:
                    <div class="adhd-excluded-sites-list" id="adhd-excluded-sites">
                        ${this.getExcludedSitesHTML()}
                    </div>
                    <div class="adhd-exclude-row">
                        <input type="text" id="adhd-exclude-input" placeholder="example.com">
                        <button type="button" class="adhd-exclude-add">Add site</button>
                        <button type="button" class="adhd-exclude-current">Exclude this site</button>
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
            const cfg = this.state.config;
            const colorPreset = panel.querySelector('#adhd-color-preset');
            const opacitySlider = panel.querySelector('#adhd-opacity');
            const opacityValue = panel.querySelector('#adhd-opacity-value');
            const paddingSlider = panel.querySelector('#adhd-padding');
            const paddingValue = panel.querySelector('#adhd-padding-value');
            const smoothBox = panel.querySelector('#adhd-smooth-transition');
            const previewLine = panel.querySelector('#adhd-preview-line');

            const currentColor = () => {
                const m = colorPreset.value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${opacitySlider.value / 100})` : colorPreset.value;
            };

            // Live preview: apply to both the sample line and the real highlight.
            // Mutates config in memory only — hideSettings restores the snapshot on cancel.
            const applyPreview = () => {
                cfg.highlightColor = currentColor();
                cfg.verticalPadding = parseInt(paddingSlider.value, 10);
                cfg.smoothTransition = smoothBox.checked;
                this.updateHighlightStyle();
                previewLine.style.backgroundColor = cfg.highlightColor;
                previewLine.style.paddingTop = previewLine.style.paddingBottom = cfg.verticalPadding + 'px';
                previewLine.style.transition = cfg.smoothTransition ? 'all 150ms ease-in-out' : 'none';
            };

            colorPreset.addEventListener('change', applyPreview);
            opacitySlider.addEventListener('input', () => {
                opacityValue.textContent = `${opacitySlider.value}%`;
                applyPreview();
            });
            paddingSlider.addEventListener('input', () => {
                paddingValue.textContent = `${paddingSlider.value}px`;
                applyPreview();
            });
            smoothBox.addEventListener('change', applyPreview);
            applyPreview();

            panel.querySelector('.adhd-settings-save').addEventListener('click', () => this.saveSettings());
            panel.querySelector('.adhd-settings-cancel').addEventListener('click', () => this.hideSettings());
            panel.querySelector('.adhd-settings-reset').addEventListener('click', () => {
                if (!confirm('Reset all settings to defaults?')) return;
                this.state.resetConfig();
                // resetConfig replaces the config object — re-read it, don't use cfg
                const fresh = this.state.config;
                // Re-snapshot so a later Cancel doesn't restore pre-reset values
                this._snapshot = {
                    highlightColor: fresh.highlightColor,
                    verticalPadding: fresh.verticalPadding,
                    smoothTransition: fresh.smoothTransition
                };
                panel.innerHTML = this.getSettingsHTML();
                this.bindSettingsEvents();
                this.updateHighlightStyle();
                this.updateToggleButton();
                const hl = window.adhdHighlighter;
                if (hl && this.state.articleLike && this.state.config.enabled) hl.activate();
                this.showFlashMessage('Settings reset to defaults');
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

            // Add exclusions
            const excludeInput = panel.querySelector('#adhd-exclude-input');
            const addExclusion = (raw) => {
                let site = String(raw || '').trim().toLowerCase();
                site = site.replace(/^[a-z]+:\/\//, '').split('/')[0]; // accept pasted URLs
                if (!site) return;
                const list = Array.isArray(this.state.config.excludedSites) ? this.state.config.excludedSites : [];
                if (list.includes(site)) {
                    this.showFlashMessage('Already excluded');
                    return;
                }
                this.state.saveConfig({ excludedSites: [...list, site] });
                panel.querySelector('#adhd-excluded-sites').innerHTML = this.getExcludedSitesHTML();
                this.showFlashMessage(matchHostname(location.hostname, site)
                    ? `Excluded ${site} — takes effect on reload`
                    : `Excluded ${site}`);
            };
            panel.querySelector('.adhd-exclude-add').addEventListener('click', () => {
                addExclusion(excludeInput.value);
                excludeInput.value = '';
            });
            excludeInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addExclusion(excludeInput.value);
                    excludeInput.value = '';
                }
            });
            panel.querySelector('.adhd-exclude-current').addEventListener('click', () => {
                addExclusion(location.hostname);
            });
        }

        saveSettings() {
            const panel = this.state.settingsPanel;
            const colorPreset = panel.querySelector('#adhd-color-preset');
            const opacitySlider = panel.querySelector('#adhd-opacity');

            const baseColor = colorPreset.value;
            const opacity = opacitySlider.value / 100;
            const match = baseColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);

            // Empty/invalid number inputs parse to NaN — fall back to current config
            const intOr = (value, fallback) => {
                const n = parseInt(value, 10);
                return Number.isFinite(n) ? n : fallback;
            };

            const updates = {
                highlightColor: match ? `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${opacity})` : baseColor,
                verticalPadding: intOr(panel.querySelector('#adhd-padding').value, this.state.config.verticalPadding),
                smoothTransition: panel.querySelector('#adhd-smooth-transition').checked,
                persistentHighlight: panel.querySelector('#adhd-persistent').checked,
                keyboardNav: panel.querySelector('#adhd-keyboard-nav').checked,
                showToggleButton: panel.querySelector('#adhd-show-button').checked,
                buttonPosition: panel.querySelector('#adhd-button-pos').value,
                minTotalText: Math.max(0, intOr(panel.querySelector('#adhd-min-total').value, this.state.config.minTotalText))
            };

            this._snapshot = null; // committed — nothing to revert on close
            this.state.saveConfig(updates);
            this.updateHighlightStyle();
            this.updateToggleButton();
            this.hideSettings();
            this.showFlashMessage('Settings saved');

            // A lowered activation threshold may make this page qualify now
            const hl = window.adhdHighlighter;
            if (hl && !this.state.articleLike) {
                this.state.lastCheckedUrl = '';
                hl.recheckCount = 0;
                hl.checkContentType();
            }
        }

        showSettings() {
            const panel = this.state.settingsPanel;

            // Snapshot the live-previewed values so Cancel can revert them
            this._snapshot = {
                highlightColor: this.state.config.highlightColor,
                verticalPadding: this.state.config.verticalPadding,
                smoothTransition: this.state.config.smoothTransition
            };

            // Re-render so panel reflects current config values
            panel.innerHTML = this.getSettingsHTML();
            this.bindSettingsEvents();

            if (this.state.settingsBackdrop) {
                this.state.settingsBackdrop.classList.add('visible');
            }
            panel.style.display = 'block';

            // Move focus into the dialog; remember where it came from
            this._prevFocus = document.activeElement;
            const focusables = () => Array.from(panel.querySelectorAll('input, select, button'))
                .filter(el => el.offsetParent !== null);
            focusables()[0]?.focus();

            // Escape closes; Tab is trapped inside the panel
            if (this._escapeHandler) {
                document.removeEventListener('keydown', this._escapeHandler);
            }
            this._escapeHandler = (e) => {
                if (e.key === 'Escape') {
                    this.hideSettings();
                    return;
                }
                if (e.key !== 'Tab') return;
                const els = focusables();
                if (!els.length) return;
                const first = els[0];
                const last = els[els.length - 1];
                if (!panel.contains(document.activeElement)) {
                    e.preventDefault();
                    first.focus();
                } else if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            };
            document.addEventListener('keydown', this._escapeHandler);
        }

        hideSettings() {
            // Revert un-saved live preview changes (saveSettings clears the snapshot first)
            if (this._snapshot) {
                Object.assign(this.state.config, this._snapshot);
                this._snapshot = null;
                this.updateHighlightStyle();
            }
            this.state.settingsPanel.style.display = 'none';
            if (this.state.settingsBackdrop) {
                this.state.settingsBackdrop.classList.remove('visible');
            }
            if (this._escapeHandler) {
                document.removeEventListener('keydown', this._escapeHandler);
                this._escapeHandler = null;
            }
            if (this._prevFocus && typeof this._prevFocus.focus === 'function') {
                this._prevFocus.focus();
            }
            this._prevFocus = null;
        }

        showFlashMessage(msg, duration = 2000) {
            const flash = document.createElement('div');
            flash.className = 'adhd-flash-message';
            flash.textContent = msg;

            // Anchor near the toggle button's corner
            const pos = this.state.config.buttonPosition || 'bottom-right';
            flash.style.top = pos.startsWith('top') ? '65px' : 'auto';
            flash.style.bottom = pos.startsWith('bottom') ? '65px' : 'auto';
            flash.style.left = pos.endsWith('left') ? '20px' : 'auto';
            flash.style.right = pos.endsWith('right') ? '20px' : 'auto';

            document.body.appendChild(flash);
            setTimeout(() => flash.classList.add('show'), 10);
            setTimeout(() => {
                flash.classList.remove('show');
                setTimeout(() => flash.remove(), 300);
            }, duration);
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
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

    // A page only qualifies if it's text-dense: several real paragraphs
    // AND enough total readable text. Feeds, dashboards, and app UIs fail
    // the paragraph gate even when their scattered text adds up.
    const MIN_LONG_PARAGRAPHS = 3;
    const LONG_PARAGRAPH_CHARS = 80;

    function countLongParagraphs() {
        let count = 0;
        for (const el of document.querySelectorAll('p, blockquote')) {
            if ((el.textContent || '').trim().length >= LONG_PARAGRAPH_CHARS) count++;
        }
        return count;
    }

    function isArticleLike(state) {
        const { config } = state;
        const hostname = window.location.hostname.toLowerCase();

        if (isSiteExcluded(hostname, config)) {
            if (config.debugMode) console.log('ADHD Highlighter: Excluded by user list:', hostname);
            return false;
        }

        // Skip pure app/canvas pages immediately
        if (document.querySelector('[role="application"], canvas:only-child')) return false;

        // minTotalText of 0 means "activate on every page" — skip all gates
        if (config.minTotalText === 0) return true;

        // Cheap gate first: a real article has several long paragraphs
        const longParaCount = countLongParagraphs();
        if (longParaCount < MIN_LONG_PARAGRAPHS) {
            if (config.debugMode) console.log('ADHD Highlighter: Too few paragraphs', { longParaCount, required: MIN_LONG_PARAGRAPHS });
            return false;
        }

        // Measure readable text — Defuddle strips nav/comments/boilerplate.
        // It works directly on `document`, no cloneNode needed.
        let textLen = 0;
        if (typeof Defuddle !== 'undefined') {
            try {
                const result = new Defuddle(document).parse();
                textLen = result && result.content ? result.content.replace(/<[^>]*>/g, '').length : 0;
            } catch (e) {
                if (config.debugMode) console.warn('ADHD Highlighter: Defuddle failed, falling back', e);
            }
        }
        if (!textLen) {
            // Fallback: count text in content containers
            for (const el of document.querySelectorAll('p, article, main, [role="main"]')) {
                textLen += (el.textContent || '').trim().length;
            }
        }

        const active = textLen >= config.minTotalText;
        if (config.debugMode) {
            console.log('ADHD Highlighter:', active ? 'Active' : 'Inactive', { textLen, longParaCount, threshold: config.minTotalText });
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
        static MAX_RECHECKS_PER_URL = 5;

        constructor(state, ui) {
            this.state = state;
            this.ui = ui;
            this.isMoving = false;
            this.moveTimer = null;
            this.rafId = null;
            this.recheckCount = 0;
            this.lastLine = null; // last applied line, in document coordinates
            this._keyboardAttached = false;
            this.reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;

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
                this.ui.showFlashMessage('Not an article page — right-click the button for settings');
                return;
            }

            const enabled = !this.state.config.enabled;
            this.state.saveConfig({ enabled });

            if (enabled) {
                this.activate();
            } else {
                this.deactivate();
            }

            this.ui.updateToggleButton();
            this.ui.showFlashMessage(enabled ? '✅ Highlighter enabled' : '❌ Highlighter disabled');
        }

        activate() {
            if (this.state.isActive) return;
            this.state.isActive = true;

            this.ui.createHighlightDiv();
            this.updateBlendMode();

            // Use passive listeners for performance where possible
            document.addEventListener('mousemove', this.boundHandleMouseMove, { passive: true });
            // Capture phase: 'scroll' doesn't bubble, so this is the only way to
            // hear inner scroll containers and invalidate the rect cache
            document.addEventListener('scroll', this.boundHandleScroll, { passive: true, capture: true });
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

            // Remove using the same bound function references.
            // Keyboard stays attached (see attachKeyboard) so the toggle
            // shortcut can re-enable after a keyboard disable.
            document.removeEventListener('mousemove', this.boundHandleMouseMove);
            document.removeEventListener('scroll', this.boundHandleScroll, { capture: true });
            document.removeEventListener('mouseleave', this.boundHandleMouseLeave);

            if (this.state.config.debugMode) {
                console.log('ADHD Line Highlighter: Deactivated');
            }
        }

        attachKeyboard() {
            if (this._keyboardAttached) return;
            this._keyboardAttached = true;
            document.addEventListener('keydown', this.boundHandleKeyboard);
        }

        detachKeyboard() {
            if (!this._keyboardAttached) return;
            this._keyboardAttached = false;
            document.removeEventListener('keydown', this.boundHandleKeyboard);
        }

        // Blend mode follows the actual page background; re-run when the
        // site flips its theme mid-session
        updateBlendMode() {
            if (this.state.highlightDiv) {
                this.state.highlightDiv.style.mixBlendMode = isPageDark() ? 'screen' : 'multiply';
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

            this.applyLine(linePos);
        }

        applyLine(linePos) {
            const { highlightDiv } = this.state;
            if (!highlightDiv) return;

            // Document coordinates: scroll-invariant, so J/K can resume from here
            this.lastLine = {
                docTop: linePos.top + window.scrollY,
                docLeft: linePos.left + window.scrollX,
                width: linePos.width,
                height: linePos.height
            };

            // Use requestAnimationFrame for smooth updates
            cancelAnimationFrame(this.rafId);
            this.rafId = requestAnimationFrame(() => {
                highlightDiv.style.display = 'block';
                highlightDiv.style.top = this.lastLine.docTop + 'px';
                highlightDiv.style.left = this.lastLine.docLeft + 'px';
                highlightDiv.style.width = this.lastLine.width + 'px';
                highlightDiv.style.height = this.lastLine.height + 'px';
            });
        }

        scrollBehavior() {
            return this.reducedMotionQuery?.matches ? 'auto' : 'smooth';
        }

        // Keyboard line stepping (J/K): move the highlight to the adjacent
        // text line so the highlight can lead the eyes instead of trailing
        // the mouse.
        stepLine(direction) {
            if (!this.state.isActive || !this.state.config.enabled) return;
            this.state.clearCaches();

            if (this.tryStep(direction)) return;

            // No further line in the viewport — bring more page in and retry
            window.scrollBy({ top: direction * window.innerHeight * 0.4, behavior: 'auto' });
            this.state.clearCaches();
            this.tryStep(direction);
        }

        tryStep(direction) {
            const { config, highlightDiv } = this.state;
            const hasLine = this.lastLine && highlightDiv && highlightDiv.style.display === 'block';

            let x, startY;
            if (hasLine) {
                const viewTop = this.lastLine.docTop - window.scrollY;
                x = this.lastLine.docLeft - window.scrollX + Math.min(24, this.lastLine.width / 2);
                startY = direction > 0 ? viewTop + this.lastLine.height + 2 : viewTop - 2;
            } else {
                // No current line: pick up from the first readable line in view
                x = window.innerWidth / 2;
                startY = window.innerHeight * 0.3;
                direction = 1;
            }

            const stepPx = 10;
            for (let i = 0; i < 40; i++) {
                const y = startY + direction * i * stepPx;
                if (y < 0 || y > window.innerHeight) break;
                // Probe at the text's left edge first, then the viewport center
                // (catches indented blocks like blockquotes)
                for (const px of [x, window.innerWidth / 2]) {
                    const el = getTextElementAt(px, y, this.state);
                    if (!el) continue;
                    const pos = getLinePosition(el, y, config, this.state);
                    if (!pos) continue;
                    if (hasLine && Math.abs((pos.top + window.scrollY) - this.lastLine.docTop) < 3) continue;
                    this.applyLine(pos);
                    this.keepLineInView(pos);
                    return true;
                }
            }
            return false;
        }

        keepLineInView(linePos) {
            const margin = 80;
            if (linePos.top >= margin && linePos.top + linePos.height <= window.innerHeight - margin) return;
            window.scrollTo({
                top: linePos.top + window.scrollY - window.innerHeight * 0.4,
                behavior: this.scrollBehavior()
            });
        }

        hideHighlight() {
            // Cancel any pending frame so it can't re-show the highlight after this
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
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
            // Don't hijack keys while the user is typing
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

            const { keyboardShortcut, keyboardNav } = this.state.config;
            const parts = keyboardShortcut.split('+');
            const modifiers = new Set(parts.slice(0, -1).map(p => p.toLowerCase()));
            const key = parts[parts.length - 1].toLowerCase();

            const matchesToggle =
                e.altKey === modifiers.has('alt') &&
                e.ctrlKey === modifiers.has('ctrl') &&
                e.shiftKey === modifiers.has('shift') &&
                e.metaKey === (modifiers.has('meta') || modifiers.has('cmd')) &&
                e.key.toLowerCase() === key;

            if (matchesToggle) {
                e.preventDefault();
                this.toggle();
                return;
            }

            // J/K step the highlight line by line (no modifiers)
            if (keyboardNav && this.state.isActive &&
                !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                const k = e.key.toLowerCase();
                if (k === 'j' || k === 'k') {
                    e.preventDefault();
                    this.stepLine(k === 'j' ? 1 : -1);
                }
            }
        }

        handleMouseLeave() {
            this.isMoving = false;
            if (!this.state.config.persistentHighlight) {
                this.debouncedHide();
            }
        }

        checkContentType() {
            // Once a page qualifies, don't keep re-parsing on every DOM change
            // (comments loading, ads rotating) — only re-evaluate after SPA navigation.
            const url = location.href;
            if (url === this.state.lastCheckedUrl) {
                if (this.state.articleLike) return;
                // Non-article page that keeps mutating (feed, dashboard): give late-loading
                // content a few chances to qualify, then stop re-parsing entirely.
                if (++this.recheckCount > Highlighter.MAX_RECHECKS_PER_URL) return;
            } else {
                this.recheckCount = 0;
            }
            this.state.lastCheckedUrl = url;

            const isArticle = isArticleLike(this.state);
            if (isArticle !== this.state.articleLike) {
                this.state.articleLike = isArticle;

                if (this.state.config.debugMode) {
                    console.log('ADHD Highlighter: Content type changed -', isArticle ? 'Article detected' : 'Not an article');
                }

                if (isArticle) {
                    this.ui.createToggleButton(); // show button if page became article-like (SPA nav)
                    this.attachKeyboard();
                    if (this.state.config.enabled) this.activate();
                    this.updateBlendMode();
                } else {
                    this.deactivate();
                    this.detachKeyboard();
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
                ui.createToggleButton();
                highlighter.attachKeyboard();
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
            highlighter.attachKeyboard();
            if (state.config.enabled) {
                highlighter.activate();

                // One-time hint so the shortcuts are discoverable
                if (!GM_getValue('adhd_intro_shown')) {
                    GM_setValue('adhd_intro_shown', true);
                    ui.showFlashMessage(
                        `Line highlighter is on — ${state.config.keyboardShortcut} toggles it, J/K step lines, right-click the button for settings`,
                        6000
                    );
                }
            }
        }
        ui.updateToggleButton();

        // Re-check the blend mode when the site or OS flips its theme:
        // OS-level preference changes...
        window.matchMedia?.('(prefers-color-scheme: dark)')
            .addEventListener?.('change', () => highlighter.updateBlendMode());
        // ...and site-level toggles, which typically swap a class on <html>/<body>
        const themeObserver = new MutationObserver(throttle(() => highlighter.updateBlendMode(), 500));
        for (const el of [document.documentElement, document.body]) {
            themeObserver.observe(el, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        }

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
