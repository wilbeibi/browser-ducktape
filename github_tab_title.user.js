// ==UserScript==
// @name         GitHub - Front-Loaded Tab Title
// @version      1.1.1
// @author       wilbeibi
// @namespace    https://github.com/wilbeibi/browser-ducktape
// @license      MIT
// @homepageURL  https://github.com/wilbeibi/browser-ducktape
// @supportURL   https://github.com/wilbeibi/browser-ducktape/issues
// @downloadURL  https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/github_tab_title.user.js
// @updateURL    https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/github_tab_title.user.js
// @description  Puts the identifying part of a GitHub page - issue or PR number, file name - at the front of the tab title
// @match        *://github.com/*
// @grant        GM_info
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // A Chrome tab shows roughly 15-25 characters and truncates from the right, so the
  // budget is the design constraint. GitHub spends it on boilerplate and puts the one
  // identifying token in the middle:
  //
  //   "Title by author · Pull Request #123 · owner/repo"
  //   "repo/deep/dir/NOTES.md at main · owner/repo"
  //   "History for deep/dir/NOTES.md - owner/repo"
  //
  // Rebuild each title as "<identity> · <context>": identity is what distinguishes this
  // tab from its neighbours and goes first; context is grouping information that is fine
  // to lose to truncation. The favicon already says "GitHub" (and, for issues and PRs,
  // its colour says open/merged/closed), so none of that is worth a character.
  //
  //   "#123 Title · repo"
  //   "NOTES.md · repo"
  //   "NOTES.md · repo@some-branch"      (a non-default ref IS identifying; "main" is not)
  //   "NOTES.md · repo history"
  //
  // Dropped as never-identifying: the owner, "by <author>", "Pull Request"/"Issue"
  // (the number's "#" already says it), and "History for" as a leading phrase.

  const SEPARATOR = ' · ';
  const UNREAD_PREFIX = /^\(\d+\)\s*/;   // GitHub's unread-notification badge
  const BY_AUTHOR = / by [\w.-]+$/;      // trails PR titles; logins never contain spaces
  const DEFAULT_REF = /^(?:main|master|HEAD|[0-9a-f]{7,40})$/;
  const COLORS = ['🟥', '🟧', '🟨', '🟩', '🟦', '🟪'];
  const DEFAULT_MARKS = [
    { label: 'Pending Review', color: '🟨' },
    { label: 'WIP', color: '🟦' },
    { label: 'Waiting for me', color: '🟥' },
    { label: 'Read later', color: '🟪' },
  ];
  const CONFIG_KEY = 'github-tab-title:marks';
  const TAB_KEY = 'github-tab-title:mark';
  let marks = readMarks();
  let selected = sessionStorage.getItem(TAB_KEY);
  let lastMarker = '';
  let picker;
  let button;

  function readMarks() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY));
      if (Array.isArray(saved) && saved.length === DEFAULT_MARKS.length
          && saved.every((item) => typeof item.label === 'string' && item.label.trim()
            && COLORS.includes(item.color))) return saved;
    } catch { /* Use the defaults if storage was cleared or damaged. */ }
    return DEFAULT_MARKS.map((item) => ({ ...item }));
  }

  function marker() {
    const mark = marks[Number(selected)];
    return selected !== null && mark ? `${mark.color} ` : '';
  }

  function unmarkTitle(title) {
    const badge = title.match(UNREAD_PREFIX)?.[0] || '';
    const rest = title.slice(badge.length);
    return badge + (lastMarker && rest.startsWith(lastMarker)
      ? rest.slice(lastMarker.length) : rest);
  }

  function selectMark(index) {
    selected = index === null ? null : String(index);
    if (selected === null) sessionStorage.removeItem(TAB_KEY);
    else sessionStorage.setItem(TAB_KEY, selected);
    if (button) button.textContent = marker().trim() || '□';
    if (picker) picker.remove();
    picker = null;
    apply();
  }

  const RULES = [
    // Issues, pull requests, discussions -> "#123 Title · repo"
    {
      path: /^\/([^/]+)\/([^/]+)\/(?:issues|pull|discussions)\/(\d+)(?:\/(files|checks|commits))?/,
      build: (m, subject) => {
        const bare = subject.replace(new RegExp(`^#${m[3]} `), '').replace(BY_AUTHOR, '');
        // A PR's conversation, Files, and Checks tabs all carry the SAME GitHub title.
        // Open two of them and the strip shows two identical rows, which is exactly the
        // "which tab is which" problem this script exists to solve. The sub-tab goes in
        // the trailing context, where it is the first thing truncation drops.
        return [`#${m[3]} ${bare}`, m[4] ? `${m[2]} ${m[4]}` : m[2]];
      },
    },
    // A single commit -> "0ad1e0b Message · repo"
    {
      path: /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{7,40})/,
      build: (m, subject) => {
        const sha = m[3].slice(0, 7);
        return [`${sha} ${subject.replace(new RegExp(`^${sha} `), '')}`, m[2]];
      },
    },
    // Files and directories -> "NOTES.md · repo[@ref]", plus " history" for a file log.
    // Built from the URL, not from GitHub's title, so a directory path or an odd branch
    // name cannot confuse the parse.
    {
      path: /^\/([^/]+)\/([^/]+)\/(blob|blame|tree|edit|raw|commits)\/([^/]+)\/(.+)/,
      build: (m, subject, title) => {
        const name = decode(m[5]).replace(/[?#].*$/, '').split('/').filter(Boolean).pop();
        if (!name) return null;
        const ref = refOf(title, m);
        return [name, m[2] + (DEFAULT_REF.test(ref) ? '' : `@${ref}`)
          + (m[3] === 'commits' ? ' history' : '')];
      },
    },
  ];

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // The URL cannot tell a ref from a path: /blob/feature/foo/a/b.md splits ambiguously,
  // and guessing "feature" would label the tab with the wrong branch. GitHub's own title
  // resolved it already ("repo/a/b.md at feature/foo"), so read the ref from there while
  // it is still present, from this script's own tail once it is not, and only then fall
  // back to the URL guess.
  function refOf(title, m) {
    const segments = title.replace(UNREAD_PREFIX, '').split(SEPARATOR);
    const repo = m[2];

    if (segments[0].startsWith(`${repo}/`)) {
      const at = segments[0].lastIndexOf(' at ');
      if (at !== -1) return segments[0].slice(at + 4).trim();
    }
    const own = (segments[1] || '').match(new RegExp(`^${escapeRe(repo)}@(.+?)(?: history)?$`));
    if (own) return own[1];

    return decode(m[4]);
  }

  function decode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s; // malformed %-escape: the raw segment still identifies the tab
    }
  }

  // GitHub's own title, minus the badge, is the only place the human-written subject of an
  // issue, PR, or commit exists in the DOM at document-start. Its first segment is that
  // subject; the rest is boilerplate this script is replacing.
  function subjectOf(title) {
    return title.replace(UNREAD_PREFIX, '').split(SEPARATOR)[0].trim();
  }

  function apply() {
    if (document.body && (!button || !button.isConnected)) addControl();
    const path = location.pathname;
    for (const rule of RULES) {
      const match = path.match(rule.path);
      if (!match) continue;

      const unmarked = unmarkTitle(document.title);
      const badge = unmarked.match(UNREAD_PREFIX)?.[0] || '';
      const bare = unmarked.replace(UNREAD_PREFIX, '');
      const built = rule.build(match, subjectOf(unmarked), bare);
      if (!built || !built[0]) return;

      // Re-entrancy: the subject is read back from a title this script already wrote, so
      // each build() strips its own prefix before re-adding it. That makes apply()
      // idempotent, and the poll a cheap no-op once the title is settled.
      const prefix = marker();
      const next = badge + prefix + built.filter(Boolean).join(SEPARATOR);
      if (next !== document.title) document.title = next;
      lastMarker = prefix;
      return;
    }
    // The marker belongs to the tab, including GitHub pages without a title rule.
    const unmarked = unmarkTitle(document.title);
    const badge = unmarked.match(UNREAD_PREFIX)?.[0] || '';
    const next = badge + marker() + unmarked.slice(badge.length);
    if (next !== document.title) document.title = next;
    lastMarker = marker();
  }

  function showPicker(source) {
    if (picker && !picker.isConnected) picker = null;
    if (picker) { picker.remove(); picker = null; return; }
    picker = document.createElement('div');
    picker.id = 'gtt-picker';
    picker.className = source === 'menu' ? 'gtt-from-menu' : 'gtt-from-button';
    picker.setAttribute('role', 'dialog');
    picker.setAttribute('aria-label', 'GitHub tab marker');
    const heading = document.createElement('strong');
    heading.textContent = 'Mark this tab';
    picker.append(heading);

    marks.forEach((mark, index) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.textContent = `${mark.color} ${mark.label}${selected === String(index) ? ' ✓' : ''}`;
      option.addEventListener('click', () => selectMark(index));
      picker.append(option);
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear marker';
    clear.addEventListener('click', () => selectMark(null));
    picker.append(clear);
    const configure = document.createElement('button');
    configure.type = 'button';
    configure.textContent = 'Edit labels and colors…';
    configure.addEventListener('click', showEditor);
    picker.append(configure);
    document.body.append(picker);
  }

  function showEditor() {
    picker.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = 'Edit marker meanings';
    picker.append(heading);
    const rows = marks.map((mark) => {
      const row = document.createElement('div');
      row.className = 'gtt-row';
      const color = document.createElement('select');
      color.setAttribute('aria-label', `Color for ${mark.label}`);
      for (const choice of COLORS) {
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = choice;
        color.append(option);
      }
      color.value = mark.color;
      const label = document.createElement('input');
      label.type = 'text';
      label.maxLength = 40;
      label.setAttribute('aria-label', `Label for ${mark.label}`);
      label.value = mark.label;
      row.append(color, label);
      picker.append(row);
      return { color, label };
    });
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      if (rows.some(({ label }) => !label.value.trim())) return;
      marks = rows.map(({ color, label }) => ({ color: color.value, label: label.value.trim() }));
      localStorage.setItem(CONFIG_KEY, JSON.stringify(marks));
      picker.remove();
      picker = null;
      if (button) button.textContent = marker().trim() || '□';
      apply();
    });
    picker.append(save);
  }

  function addControl() {
    if (!document.body || (button && button.isConnected)) return;
    button = document.createElement('button');
    button.id = 'gtt-button';
    button.type = 'button';
    button.title = 'Mark this GitHub tab';
    button.setAttribute('aria-label', 'Mark this GitHub tab');
    button.textContent = marker().trim() || '□';
    button.addEventListener('click', () => showPicker('button'));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showPicker('button');
    });
    document.body.append(button);
  }

  GM_addStyle(`
    #gtt-button { position:fixed; left:12px; top:72px; z-index:2147483646;
      width:28px; height:28px; padding:0; border:1px solid #777; border-radius:6px;
      background:#fff; color:#333; cursor:pointer; font-size:17px; }
    #gtt-picker { position:fixed; z-index:2147483647;
      min-width:215px; padding:10px; border:1px solid #777; border-radius:8px;
      background:#fff; color:#222; box-shadow:0 4px 16px #0004; font:14px sans-serif; }
    #gtt-picker.gtt-from-button { left:46px; top:72px; }
    #gtt-picker.gtt-from-menu { right:12px; top:12px; }
    #gtt-picker strong { display:block; margin-bottom:6px; }
    #gtt-picker button { display:block; width:100%; margin:3px 0; padding:5px;
      text-align:left; color:#222; background:#fff; border:0; border-radius:4px; cursor:pointer; }
    #gtt-picker button:hover { background:#eee; }
    #gtt-picker .gtt-row { display:flex; gap:5px; margin:5px 0; }
    #gtt-picker select { width:48px; }
    #gtt-picker input { flex:1; min-width:0; }
  `);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Mark this GitHub tab', () => showPicker('menu'));
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== CONFIG_KEY) return;
    marks = readMarks();
    if (button) button.textContent = marker().trim() || '□';
    if (picker) { picker.remove(); picker = null; }
    apply();
  });
  if (document.body) addControl();
  else document.addEventListener('DOMContentLoaded', addControl, { once: true });

  // Poll rather than hook history.pushState: GitHub's script-src blocks the page-context
  // injection that hooking would need (see AGENTS.md), and Turbo navigation rewrites the
  // title asynchronously after the URL changes anyway. apply() is a cheap no-op once the
  // title is already front-loaded.
  setInterval(apply, 500);
  apply();
})();
