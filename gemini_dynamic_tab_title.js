// ==UserScript==
// @name         Gemini - Dynamic Tab Title
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Updates the tab title to the active conversation title
// @match        *://gemini.google.com/*
// @grant        none
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';

  const CHAT_PAGE_REGEX = /^\/app\/[\w-]+$/;
  const ORIGINAL_TITLE = document.title || 'Google Gemini';

  let timer = null;
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
      stopPolling();
    }
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function startPolling() {
    if (timer) clearInterval(timer);
    timer = setInterval(applyTitle, 500);
    applyTitle();
  }

  const pushState = history.pushState;
  history.pushState = function (...args) {
    const ret = pushState.apply(this, args);
    startPolling();
    return ret;
  };
  const replaceState = history.replaceState;
  history.replaceState = function (...args) {
    const ret = replaceState.apply(this, args);
    startPolling();
    return ret;
  };
  window.addEventListener('popstate', startPolling);

  startPolling();
})();
