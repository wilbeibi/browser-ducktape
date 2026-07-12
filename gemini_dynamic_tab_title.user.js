// ==UserScript==
// @name         Gemini - Dynamic Tab Title
// @version      1.0.4
// @author       wilbeibi
// @namespace    https://github.com/wilbeibi/browser-ducktape
// @license      MIT
// @homepageURL  https://github.com/wilbeibi/browser-ducktape
// @supportURL   https://github.com/wilbeibi/browser-ducktape/issues
// @downloadURL  https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/gemini_dynamic_tab_title.user.js
// @updateURL    https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/gemini_dynamic_tab_title.user.js
// @description  Updates the tab title to the active conversation title
// @match        *://gemini.google.com/*
// @grant        GM_info
// @run-at       document-start
// @inject-into  content
// ==/UserScript==

(function () {
  'use strict';

  const CHAT_PAGE_REGEX = /^\/app\/[\w-]+$/;
  const ORIGINAL_TITLE = document.title || 'Google Gemini';

  let lastTitle = '';
  let lastPath = '';

  function isChatPage() {
    return CHAT_PAGE_REGEX.test(location.pathname);
  }

  function getActiveConversationTitle() {
    const path = location.pathname;
    const link = document.querySelector(
      `[data-test-id="conversation"][href="${CSS.escape(path)}"]`
    );
    const titleEl = link?.querySelector('.conversation-title');
    return titleEl?.textContent?.trim() || '';
  }

  function applyTitle() {
    const path = location.pathname;

    if (!isChatPage()) {
      lastTitle = '';
      if (document.title !== ORIGINAL_TITLE) document.title = ORIGINAL_TITLE;
      return;
    }

    if (path === lastPath && lastTitle && document.title.includes(lastTitle)) return;
    lastPath = path;

    const title = getActiveConversationTitle();
    if (title && title !== lastTitle) {
      lastTitle = title;
      const newTitle = `${title} - ${ORIGINAL_TITLE}`;
      if (!document.title.includes(title)) document.title = newTitle;
    }
  }

  // Poll instead of hooking history.pushState. Hooking would require
  // @inject-into page, which Google's CSP blocks on Firefox (and hooking the
  // page's history from the content context throws "Permission denied").
  // Polling from the content context works cross-browser; applyTitle
  // early-returns cheaply once the title is set and recomputes on navigation.
  setInterval(applyTitle, 500);
  applyTitle();
})();
