// ==UserScript==
// @name         Translate to Chinese with AI
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Translate selected text to Chinese using AI with a hover button
// @author       You
// @match        *://*/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // CONFIGURATION
    // Replace with your actual API key
    const DEFAULT_API_KEY = "<** replace with your openAI API key **>";
    // The prompt that instructs the AI how to translate
    const DEFAULT_PROMPT = "请将以下科技文本译为中文，遵循：1) 精准传递原意，保留专业术语（核心概念附英文），解析指代关系；2) 符合中文技术文献规范，主动语态优先，拆分长句，适配中文数字/量词格式；3) 保留公式/代码/图表及排版结构；4) 采用正式技术文体，使用领域通用译法:";

    // Initialize API key from storage or default
    let apiKey = GM_getValue('ai_translate_api_key', DEFAULT_API_KEY);
    let prompt = GM_getValue('ai_translate_prompt', DEFAULT_PROMPT);

    // Track original text styles
    let originalTextStyles = {};

    // Add styles for the popup and hover button
    GM_addStyle(`
        #ai-translate-popup {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(240, 240, 250, 0.75);
            border: none;
            box-shadow: 0 2px 15px rgba(0, 0, 0, 0.08);
            padding: 4px 8px;
            z-index: 10000;
            max-width: 80%;
            width: auto;
            max-height: 80%;
            overflow: auto;
            border-radius: 4px;
            font-family: inherit;
            backdrop-filter: blur(2px);
        }
        #ai-translate-popup-close {
            position: absolute;
            top: 0;
            right: 0;
            cursor: pointer;
            font-size: 14px;
            color: #888;
            opacity: 0.5;
            transition: opacity 0.2s ease;
            padding: 2px;
            line-height: 0.5;
        }
        #ai-translate-popup-close:hover {
            opacity: 1;
        }
        #ai-translate-loading {
            text-align: center;
            padding: 16px 0;
            color: #666;
            font-size: 14px;
            letter-spacing: 0.3px;
        }
        .ai-translate-content {
            margin: 0;
            white-space: pre-wrap;
            padding: 0;
        }
        .ai-translate-original {
            margin-bottom: 12px;
            padding-bottom: 12px;
            border-bottom: 1px solid #eaeaea;
            opacity: 0.7;
        }
        .ai-translate-translated {
            margin: 0;
            padding: 0;
        }
        @keyframes gentle-pulse {
            0% { opacity: 0.6; }
            50% { opacity: 1; }
            100% { opacity: 0.6; }
        }
        .loading-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            background-color: #ccc;
            border-radius: 50%;
            margin: 0 3px;
            animation: gentle-pulse 1.5s infinite ease-in-out;
        }
        .loading-indicator:nth-child(2) {
            animation-delay: 0.2s;
        }
        .loading-indicator:nth-child(3) {
            animation-delay: 0.4s;
        }
        /* Translation hover button */
        #ai-translate-button {
            position: absolute;
            background: rgba(255, 255, 255, 0.95);
            border: 1px solid #eaeaea;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 9999;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            opacity: 0;
            transform: scale(0.9);
            transition: all 0.2s ease;
            font-size: 16px;
        }
        #ai-translate-button:hover {
            transform: scale(1.1);
            box-shadow: 0 2px 5px rgba(0,0,0,0.15);
        }
        #ai-translate-button.visible {
            opacity: 1;
            transform: scale(1);
        }
    `);

    // Track selection state
    let lastSelection = '';
    let selectionTimeout;
    let translateButton = null;

    // Listen for text selection
    document.addEventListener('mouseup', handleTextSelection);
    document.addEventListener('keyup', handleTextSelection);

    function handleTextSelection(e) {
        // Clear any existing timeout
        if (selectionTimeout) {
            clearTimeout(selectionTimeout);
        }

        // Set a small delay to ensure selection is complete
        selectionTimeout = setTimeout(() => {
            const selection = window.getSelection();
            const selectedText = selection.toString().trim();

            // Remove existing button if no text is selected
            if (!selectedText) {
                removeTranslateButton();
                return;
            }

            // Don't show button if selection hasn't changed
            if (selectedText === lastSelection && document.getElementById('ai-translate-button')) {
                return;
            }

            lastSelection = selectedText;

            // Get selection coordinates
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                const rect = range.getBoundingClientRect();

                // Store original text styles
                try {
                    const selectedNode = range.startContainer.parentNode;
                    const computedStyle = window.getComputedStyle(selectedNode);
                    originalTextStyles = {
                        fontFamily: computedStyle.fontFamily,
                        fontSize: computedStyle.fontSize,
                        lineHeight: computedStyle.lineHeight,
                        fontWeight: computedStyle.fontWeight,
                        color: computedStyle.color,
                        textAlign: computedStyle.textAlign
                    };
                } catch (e) {
                    // Default styles if we can't get the original
                    originalTextStyles = {
                        fontFamily: 'inherit',
                        fontSize: '16px',
                        lineHeight: '1.5',
                        fontWeight: 'normal',
                        color: '#333',
                        textAlign: 'left'
                    };
                }

                // Position the button near the end of selection
                showTranslateButton(
                    rect.right + window.scrollX,
                    rect.top + window.scrollY - 30,
                    selectedText
                );
            }
        }, 200);
    }

    function showTranslateButton(x, y, selectedText) {
        // Remove any existing button
        removeTranslateButton();

        // Create new button
        translateButton = document.createElement('div');
        translateButton.id = 'ai-translate-button';
        translateButton.innerHTML = '🇨🇳';
        translateButton.title = 'Translate to Chinese';

        // Position the button
        translateButton.style.left = `${x}px`;
        translateButton.style.top = `${y}px`;

        // Add click handler
        translateButton.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            translateText(selectedText);
            removeTranslateButton();
        });

        // Add to document
        document.body.appendChild(translateButton);

        // Animate in
        setTimeout(() => {
            translateButton.classList.add('visible');
        }, 10);

        // Hide button when clicking elsewhere
        document.addEventListener('mousedown', function hideOnClick(e) {
            if (e.target !== translateButton) {
                removeTranslateButton();
                document.removeEventListener('mousedown', hideOnClick);
            }
        });
    }

    function removeTranslateButton() {
        if (translateButton) {
            translateButton.remove();
            translateButton = null;
        }
    }

    // Keep the context menu functionality as a fallback
    document.addEventListener('contextmenu', function (e) {
        const selectedText = window.getSelection().toString().trim();
        if (selectedText) {
            // Add our own item to the menu on next tick (after the native menu is created)
            setTimeout(() => {
                addCustomMenuItem(e.clientX, e.clientY, selectedText);
            }, 0);
        }
    });

    function addCustomMenuItem(x, y, selectedText) {
        // Remove any existing custom menu
        removeCustomMenu();

        // Create our custom menu item
        const menuItem = document.createElement('div');
        menuItem.id = 'ai-translate-menu-item';
        menuItem.innerHTML = '🇨🇳 翻译成中文';
        menuItem.style.cssText = `
            position: absolute;
            left: ${x}px;
            top: ${y}px;
            background: rgb(250, 250, 250);
            border: 1px solid #eaeaea;
            padding: 8px 12px;
            cursor: pointer;
            z-index: 10000;
            box-shadow: 0 1px 4px rgba(0,0,0,0.05);
            border-radius: 4px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            font-size: 14px;
            color: #333;
            transition: background 0.15s ease;
        `;

        menuItem.addEventListener('mouseover', function () {
            this.style.background = '#f2f2f2';
        });

        menuItem.addEventListener('mouseout', function () {
            this.style.background = 'rgb(250, 250, 250)';
        });

        menuItem.addEventListener('click', function () {
            translateText(selectedText);
            removeCustomMenu();
        });

        document.body.appendChild(menuItem);

        // Remove menu when clicking elsewhere
        document.addEventListener('click', removeCustomMenu);
    }

    function removeCustomMenu() {
        const menuItem = document.getElementById('ai-translate-menu-item');
        if (menuItem) {
            menuItem.remove();
        }
        document.removeEventListener('click', removeCustomMenu);
    }

    function translateText(text) {
        // Show loading popup with gentle animation
        showPopup(`
            <div id="ai-translate-loading">
                <div class="loading-indicator"></div>
                <div class="loading-indicator"></div>
                <div class="loading-indicator"></div>
            </div>
        `);

        // Prepare the API request
        GM_xmlhttpRequest({
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            data: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: prompt
                    },
                    {
                        role: "user",
                        content: text
                    }
                ]
            }),
            onload: function (response) {
                try {
                    const result = JSON.parse(response.responseText);
                    if (result.error) {
                        showTranslationError(result.error.message);
                        return;
                    }

                    const translation = result.choices[0].message.content;
                    updatePopupWithTranslation(text, translation);
                } catch (e) {
                    showTranslationError("Failed to parse response: " + e.message);
                }
            },
            onerror: function (error) {
                showTranslationError("Request failed: " + error.statusText);
            }
        });
    }

    function showPopup(content) {
        // Remove existing popup if any
        removePopup();

        // Create popup
        const popup = document.createElement('div');
        popup.id = 'ai-translate-popup';
        popup.innerHTML = `
            <div id="ai-translate-popup-close">×</div>
            <div id="ai-translate-popup-content">${content}</div>
        `;

        // Add close button handler
        document.body.appendChild(popup);
        document.getElementById('ai-translate-popup-close').addEventListener('click', removePopup);

        // Add subtle entrance animation
        popup.style.opacity = '0';
        popup.style.transform = 'translate(-50%, -50%) scale(0.98)';
        popup.style.transition = 'opacity 0.2s ease, transform 0.2s ease';

        // Trigger animation
        setTimeout(() => {
            popup.style.opacity = '1';
            popup.style.transform = 'translate(-50%, -50%) scale(1)';
        }, 10);

        // Close when ESC is pressed
        document.addEventListener('keydown', function closeOnEsc(e) {
            if (e.key === 'Escape') {
                removePopup();
                document.removeEventListener('keydown', closeOnEsc);
            }
        });
    }

    function updatePopupWithTranslation(original, translated) {
        // Apply the original text styles to the translated content
        const styleAttrs = Object.entries(originalTextStyles)
            .map(([key, value]) => `${key}: ${value}`)
            .join('; ');

        const content = `<div class="ai-translate-content"><div class="ai-translate-translated" style="${styleAttrs}">${translated}</div></div>`;

        document.getElementById('ai-translate-popup-content').innerHTML = content;

        // Adjust popup size to fit content
        setTimeout(() => {
            const popup = document.getElementById('ai-translate-popup');
            const content = document.getElementById('ai-translate-popup-content');
            if (popup && content) {
                // Add a small buffer to prevent text wrapping
                popup.style.width = 'auto';
                popup.style.height = 'auto';

                // Ensure the close button doesn't overlap with text
                const closeBtn = document.getElementById('ai-translate-popup-close');
                if (closeBtn) {
                    closeBtn.style.zIndex = '2';
                }
            }
        }, 10);
    }

    function showTranslationError(message) {
        const content = `<div class="ai-translate-content"><div style="color: #d35a5a; font-size: 14px; margin-bottom: 8px;">Error</div><div style="color: #666; font-size: 14px; margin-bottom: 8px;">${message}</div><div style="text-align: center; margin-top: 8px;"><button id="ai-translate-open-settings" style="padding: 4px 8px; background: #f2f2f2; color: #333; border: 1px solid #eaeaea; border-radius: 2px; cursor: pointer; font-size: 13px;">Check API Key</button></div></div>`;

        document.getElementById('ai-translate-popup-content').innerHTML = content;

        // Add event listener for the settings button
        document.getElementById('ai-translate-open-settings').addEventListener('click', function () {
            showSettings();
        });
    }

    function removePopup() {
        const popup = document.getElementById('ai-translate-popup');
        if (popup) {
            // Add exit animation
            popup.style.opacity = '0';
            popup.style.transform = 'translate(-50%, -50%) scale(0.98)';

            // Remove after animation completes
            setTimeout(() => {
                popup.remove();
            }, 200);
        }
    }

    // Add settings command to Tampermonkey menu
    GM_registerMenuCommand('AI Translate Settings', showSettings);

    function showSettings() {
        const currentApiKey = GM_getValue('ai_translate_api_key', DEFAULT_API_KEY);
        const currentPrompt = GM_getValue('ai_translate_prompt', DEFAULT_PROMPT);

        showPopup(`
            <h3 style="color: #333; margin-bottom: 20px; font-weight: normal; font-size: 18px; letter-spacing: 0.3px;">Settings</h3>
            <div style="margin: 16px 0;">
                <label for="ai-translate-api-key" style="color: #555; font-size: 14px; display: block; margin-bottom: 6px;">API Key</label>
                <input type="text" id="ai-translate-api-key" value="${currentApiKey}" style="width: 100%; padding: 10px; background: #fafafa; border: 1px solid #eaeaea; border-radius: 2px; font-size: 14px; color: #333; box-sizing: border-box;">
            </div>
            <div style="margin: 16px 0;">
                <label for="ai-translate-prompt" style="color: #555; font-size: 14px; display: block; margin-bottom: 6px;">Translation Prompt</label>
                <textarea id="ai-translate-prompt" style="width: 100%; height: 100px; padding: 10px; background: #fafafa; border: 1px solid #eaeaea; border-radius: 2px; font-size: 14px; color: #333; resize: vertical; box-sizing: border-box; line-height: 1.5;">${currentPrompt}</textarea>
            </div>
            <div style="margin: 24px 0 0; text-align: right;">
                <button id="ai-translate-save-settings" style="padding: 10px 20px; background: #333; color: white; border: none; border-radius: 2px; cursor: pointer; font-size: 14px; letter-spacing: 0.3px; transition: background 0.2s ease;">Save</button>
            </div>
        `);

        // Add hover effect to button
        const saveButton = document.getElementById('ai-translate-save-settings');
        saveButton.addEventListener('mouseover', function () {
            this.style.background = '#555';
        });

        saveButton.addEventListener('mouseout', function () {
            this.style.background = '#333';
        });

        saveButton.addEventListener('click', function () {
            const newApiKey = document.getElementById('ai-translate-api-key').value;
            const newPrompt = document.getElementById('ai-translate-prompt').value;

            GM_setValue('ai_translate_api_key', newApiKey);
            GM_setValue('ai_translate_prompt', newPrompt);

            apiKey = newApiKey;
            prompt = newPrompt;

            // Show subtle saved indicator instead of alert
            this.textContent = 'Saved';
            this.style.background = '#4d8c4a';

            setTimeout(() => {
                removePopup();
            }, 800);
        });
    }

})();
