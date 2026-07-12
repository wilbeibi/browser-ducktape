#!/usr/bin/env node
'use strict';

// Userscript repo invariants. Pure Node, zero deps. Run from the repo root:
//
//   node misc/lint_headers.js
//   BASE_REF=origin/main node misc/lint_headers.js   # also enforce the @version bump
//
// This exists because the author only ever runs Violentmonkey on Firefox. Every rule
// below encodes something that is INVISIBLE from that one configuration: a Tampermonkey
// CSP death, a Safari API that does not exist, an auto-update that silently never fires.
//
// Rules, in order of what a regression actually costs a user:
//   1. classic-script syntax      - the file must parse the way a manager evaluates it.
//   2. TM injection world         - @grant none is a CSP death sentence on Tampermonkey.
//   3. @version bump              - without it, nobody receives the fix. Ever.
//   4. self-referential URLs      - a copy-pasted header hijacks another script's updates.
//   5. required keys              - what Greasy Fork and auto-update depend on.
//   6. @grant <-> GM_* usage      - in BOTH directions.
//   7. @connect                   - required iff GM_xmlhttpRequest is used.
//   8. Safari reachability        - menu-command-only config is unreachable on Safari.
//   9. GM_addStyle                - hand-rolled <style> dies under a strict style-src.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW = 'https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/';

const REQUIRED_KEYS = [
  'name', 'version', 'description', 'namespace', 'license',
  'homepageURL', 'supportURL', 'downloadURL', 'updateURL', 'grant',
];

// Sites whose script-src is strict enough to kill Tampermonkey's `@grant none`
// <script>-tag injection. Verified by curl. Extend when you add a @match.
const STRICT_SCRIPT_SRC = ['github.com', 'claude.ai', 'gemini.google.com', 'chatgpt.com'];

// ---- Debt ledgers -----------------------------------------------------------
// These are known, accepted breakages. The point of a ledger is that it is a RATCHET:
// existing entries do not fail the build, but a NEW script joining the list does.
// Shrink these lists. Never extend them without a deliberate decision.

// Safari Userscripts (quoid) exposes no GM_registerMenuCommand. A script whose ONLY
// route to settings is the menu command is permanently unconfigurable there.
// An in-page affordance (a `contextmenu` listener on the script's own button) fixes it.
const NO_INPAGE_AFFORDANCE = [
  'hover_verdict.user.js',   // 5 menu commands, 0 contextmenu listeners
  'worth_watching.user.js',  // 3 menu commands, 0 contextmenu listeners
];

// Safari Userscripts ships only the async GM.* namespace: bare synchronous
// GM_getValue/GM_setValue throw ReferenceError.
const SYNC_GM_STORAGE = [
  'adhd_reader.user.js', 'hover_verdict.user.js',
  'inline_translate.user.js', 'prompt_rewrite.user.js',
];

const problems = [];
const fail = (file, msg) => problems.push(`${file}: ${msg}`);

function parseHeader(src) {
  const m = src.match(/\/\/ ==UserScript==\r?\n([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!m) return null;
  const keys = new Map();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\/\/\s*@(\S+)\s*(.*?)\s*$/);
    if (!kv) continue;
    if (!keys.has(kv[1])) keys.set(kv[1], []);
    keys.get(kv[1]).push(kv[2]);
  }
  return keys;
}

function changedFiles() {
  const base = process.env.BASE_REF;
  if (!base) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: ROOT, encoding: 'utf8',
    }).split('\n').filter((f) => f.endsWith('.user.js'));
  } catch {
    return null;
  }
}

function versionAt(ref, file) {
  try {
    const src = execFileSync('git', ['show', `${ref}:${file}`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseHeader(src)?.get('version')?.[0] ?? null;
  } catch {
    return null; // new file; nothing to bump against
  }
}

const scripts = fs.readdirSync(ROOT).filter((f) => f.endsWith('.user.js')).sort();
if (scripts.length === 0) fail('repo', 'no *.user.js files found');

const changed = changedFiles();

for (const file of scripts) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const h = parseHeader(src);
  if (!h) { fail(file, 'no ==UserScript== metadata block'); continue; }

  const grants = h.get('grant') || [];
  const grantNone = grants.includes('none') || grants.length === 0;
  const declared = new Set(grants.filter((g) => g !== 'none'));

  const body = src.slice(src.indexOf('==/UserScript=='));
  const used = new Set();
  for (const m of body.matchAll(/\bGM_[A-Za-z_]+/g)) used.add(m[0]);
  if (/(^|[^.\w])window\.close\s*\(/.test(body)) used.add('window.close');

  // -- 1. Must parse the way a manager evaluates it. ---------------------------
  // `node --check` is a FALSE FRIEND: it parses .js as CommonJS, which function-wraps
  // the file and therefore permits top-level `return`. A real classic script does not.
  //
  // Managers function-wrap the body of a GRANTED script, so top-level `return` (the
  // test-export escape hatch in adhd_reader / hover_verdict) is fine there. Under
  // `@grant none` Tampermonkey injects a raw <script> tag with NO wrapper, where the
  // same code is a hard SyntaxError. So the rule is conditional on the grant.
  try {
    new vm.Script(src, { filename: file });
  } catch (e) {
    const topLevelReturn = /Illegal return statement/.test(e.message);
    if (!topLevelReturn) {
      fail(file, `not a valid classic script: ${e.message}`);
      continue;
    }
    if (grantNone) {
      fail(file, 'top-level `return` under @grant none - Tampermonkey injects this as a raw '
        + '<script> tag with no function wrapper, where top-level return is a SyntaxError.');
    }
    // else: granted => the manager wraps the body in a function. Legal. Carry on.
  }

  // -- 2. Tampermonkey injection world. ---------------------------------------
  // THE bug class this repo cannot see from Firefox. `@grant none` means "page context".
  // Tampermonkey implements page context by injecting a <script> tag, which a strict
  // script-src refuses -- the script simply never runs, with no error anywhere.
  // Violentmonkey's `auto` fallback silently rescues the author, which is exactly why
  // this has survived. `@inject-into` is a VIOLENTMONKEY-ONLY key; TM ignores it.
  if (grantNone) {
    const matches = (h.get('match') || []).concat(h.get('include') || []);
    const hit = STRICT_SCRIPT_SRC.filter((host) => matches.some((m) => m.includes(host)));
    const injectInto = h.get('inject-into')?.[0];

    if (hit.length) {
      fail(file, `@grant none + @match ${hit.join(', ')} (strict script-src). Tampermonkey `
        + 'injects @grant none as a page <script> tag, which that CSP blocks: the script never '
        + 'runs on Chrome/Brave/Edge. Fix: declare any real grant (e.g. `@grant GM_info`), which '
        + 'moves TM into its isolated, CSP-immune sandbox.'
        + (injectInto ? ` @inject-into ${injectInto} does NOT help - it is Violentmonkey-only.` : ''));
    } else if (injectInto) {
      fail(file, `@inject-into ${injectInto} is a Violentmonkey-only key; Tampermonkey ignores it `
        + 'and injects @grant none into the page context. If the isolated world is load-bearing, '
        + 'declare a real @grant instead of relying on this key.');
    }
  }

  // -- 3. @version bump. AGENTS.md: without it, the fix reaches nobody. --------
  if (changed && changed.includes(file)) {
    const before = versionAt(process.env.BASE_REF, file);
    const after = h.get('version')?.[0];
    if (before && before === after) {
      fail(file, `changed but @version is still ${after} - bump it or no installed copy updates`);
    }
  }

  // -- 4. Self-referential update URLs. ---------------------------------------
  for (const k of ['downloadURL', 'updateURL']) {
    const got = h.get(k)?.[0];
    const want = RAW + file;
    if (got && got !== want) fail(file, `@${k} is "${got}", expected "${want}"`);
  }

  // -- 5. Required keys. ------------------------------------------------------
  for (const k of REQUIRED_KEYS) if (!h.has(k)) fail(file, `missing @${k}`);
  if (!h.has('match') && !h.has('include')) fail(file, 'missing @match');

  // -- 6 + 7. Grants vs usage, both directions. -------------------------------
  if (grantNone && used.size > 0) {
    fail(file, `@grant none but calls ${[...used].join(', ')} - undefined in page context`);
  }
  if (!grantNone) {
    for (const u of used) {
      if (!declared.has(u)) fail(file, `calls ${u} but does not @grant it (TypeError at runtime)`);
    }
    for (const d of declared) {
      // GM_info is the canonical no-op grant: you declare it precisely so the script
      // stops being `@grant none`, which is what moves Tampermonkey out of raw
      // page-context injection. Being unused is the whole point.
      if (d === 'GM_info') continue;
      if (!used.has(d)) fail(file, `@grant ${d} is never used - drop it`);
    }
  }
  if (used.has('GM_xmlhttpRequest') && !h.has('connect')) {
    fail(file, 'uses GM_xmlhttpRequest without @connect - Violentmonkey blocks the request');
  }
  if (h.has('connect') && !used.has('GM_xmlhttpRequest')) {
    fail(file, '@connect declared but GM_xmlhttpRequest is never used');
  }

  // -- 8. Safari reachability. ------------------------------------------------
  // AGENTS.md states the invariant: "Every script here that uses [GM_registerMenuCommand]
  // for settings also exposes an in-page affordance - right-clicking the floating button.
  // Keep it that way." Two scripts violate it today. This rule makes the claim true or
  // makes the ledger honest.
  if (used.has('GM_registerMenuCommand')) {
    const hasAffordance = /contextmenu/.test(body);
    const listed = NO_INPAGE_AFFORDANCE.includes(file);
    if (!hasAffordance && !listed) {
      fail(file, 'uses GM_registerMenuCommand with no in-page affordance (no `contextmenu` '
        + 'listener). Safari Userscripts does not implement menu commands, so this config is '
        + 'unreachable there. Add a right-click handler, or add the file to NO_INPAGE_AFFORDANCE.');
    }
    if (hasAffordance && listed) {
      fail(file, 'has an in-page affordance now - remove it from NO_INPAGE_AFFORDANCE. '
        + '(This ledger is a ratchet; it only moves one way.)');
    }
    // Unguarded call => ReferenceError on Safari before anything renders.
    if (!/typeof\s+GM_registerMenuCommand/.test(body)) {
      fail(file, 'calls GM_registerMenuCommand without a `typeof` guard - on Safari '
        + 'Userscripts this is a ReferenceError that kills the script at load.');
    }
  }

  // Sync GM storage: Safari has only async GM.*. Ratchet, do not extend.
  if ((used.has('GM_getValue') || used.has('GM_setValue')) && !SYNC_GM_STORAGE.includes(file)) {
    fail(file, 'uses synchronous GM_getValue/GM_setValue, which Safari Userscripts does not '
      + 'expose (async GM.* only). Prefer an await-tolerant call site, or add to SYNC_GM_STORAGE.');
  }

  // -- 9. GM_addStyle. --------------------------------------------------------
  // A hand-rolled <style> element lands in the page DOM and is subject to the page's
  // style-src. GM_addStyle is manager-mediated and is not. For a `*://*/*` script this
  // is the difference between "styled" and "completely unstyled UI on some sites".
  if (/createElement\(\s*['"]style['"]\s*\)/.test(body) && !declared.has('GM_addStyle')) {
    fail(file, "hand-rolls document.createElement('style') without granting GM_addStyle. That "
      + "<style> is subject to the page's style-src; on a site without 'unsafe-inline' the UI is "
      + 'unstyled. Use GM_addStyle (with the createElement path as a fallback, as hover_verdict does).');
  }
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log(`ok - ${scripts.length} userscripts pass header lint`);
