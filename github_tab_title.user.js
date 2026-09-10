// ==UserScript==
// @name         GitHub - Front-Loaded Tab Title
// @version      1.0.0
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
    const path = location.pathname;
    for (const rule of RULES) {
      const match = path.match(rule.path);
      if (!match) continue;

      const badge = document.title.match(UNREAD_PREFIX)?.[0] || '';
      const bare = document.title.replace(UNREAD_PREFIX, '');
      const built = rule.build(match, subjectOf(document.title), bare);
      if (!built || !built[0]) return;

      // Re-entrancy: the subject is read back from a title this script already wrote, so
      // each build() strips its own prefix before re-adding it. That makes apply()
      // idempotent, and the poll a cheap no-op once the title is settled.
      const next = badge + built.filter(Boolean).join(SEPARATOR);
      if (next !== document.title) document.title = next;
      return;
    }
  }

  // Poll rather than hook history.pushState: GitHub's script-src blocks the page-context
  // injection that hooking would need (see AGENTS.md), and Turbo navigation rewrites the
  // title asynchronously after the URL changes anyway. apply() is a cheap no-op once the
  // title is already front-loaded.
  setInterval(apply, 500);
  apply();
})();
