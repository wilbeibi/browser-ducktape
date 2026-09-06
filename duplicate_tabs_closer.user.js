// ==UserScript==
// @name         Duplicate Tabs Closer
// @version      1.3.0
// @description  Opening a page you already have open closes the new tab and jumps you to the old one - automatically, or on demand from a single menu command that sweeps every tab you have open. No extension, no tab API: duplicate tabs find each other over a same-origin BroadcastChannel.
// @author       wilbeibi
// @namespace    https://github.com/wilbeibi/browser-ducktape
// @license      MIT
// @homepageURL  https://github.com/wilbeibi/browser-ducktape
// @supportURL   https://github.com/wilbeibi/browser-ducktape/issues
// @downloadURL  https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/duplicate_tabs_closer.user.js
// @updateURL    https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/duplicate_tabs_closer.user.js
// @match        *://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        window.close
// @grant        window.focus
// @run-at       document-start
// @noframes
// ==/UserScript==

// ---------------------------------------------------------------------------
// Duplicates are same-origin by definition (same URL => same origin), so tabs
// can find each other on a BroadcastChannel without any tab API.
//
// Every tab holds a tuple (key, id, birth). The tuples are TOTALLY ORDERED by
// (birth, id), and a tab closes itself iff it sees a peer on the same key whose
// tuple sorts strictly before its own. That is what makes mutual suicide
// impossible: with N duplicates every tab computes the same order, so exactly
// the minimum survives.
//
// The pure part of that (no DOM, no GM_*, no BroadcastChannel) lives in `core`
// and is exercised by misc/test_duplicate_tabs_closer.js.
// ---------------------------------------------------------------------------

const core = (() => {
  'use strict';

  const CHANNEL = 'ducktape-dupes-v1';
  const HOLD_WINDOW_MS = 350;   // how long a fresh tab waits for `hold` replies
  const CLOSE_FALLBACK_MS = 600; // still alive after this => window.close() was refused
  const TOAST_MS = 4000;

  const MAX_PEERS = 32;
  const MODES = ['auto', 'manual'];

  const DEFAULTS = {
    mode: 'auto',        // 'auto' closes duplicates as they appear; 'manual' waits
                         // for the sweep command. Off is the manager's job.
    matchMode: 'hash',   // 'exact' | 'hash' | 'tracking'
    exclusions: [],      // 'example.com' or 'example.com/some/path'
    showToast: true,
  };

  const TRACKING_PARAMS = new Set([
    'fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mkt_tok',
    'ref', 'ref_src', 'ref_url', 'referrer', 'source',
    'mc_cid', 'mc_eid', 'oly_enc_id', 'oly_anon_id', '_hsenc', '_hsmi',
    'spm', 'scm', 'share_source', 'share_medium',
  ]);

  const isTrackingParam = (name) => {
    const n = String(name).toLowerCase();
    return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
  };

  // The comparison key for "is this the same page?". Returns null for anything
  // this script must not act on (non-http(s), unparseable).
  function normalizeKey(href, mode) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (mode === 'exact') return u.href;

    u.hash = '';
    u.hostname = u.hostname.toLowerCase();

    if (mode === 'tracking') {
      const p = u.searchParams;
      for (const name of [...p.keys()]) if (isTrackingParam(name)) p.delete(name);
      const q = p.toString();
      u.search = q ? `?${q}` : '';
    }

    // /foo/ and /foo are the same page on virtually every server. The root is
    // already normalized to "/" by URL, so only deeper paths need this.
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    return u.href;
  }

  // Total order. Older wins; the id breaks exact-millisecond ties the same way
  // in every tab, which is the property the whole protocol rests on.
  function compareTuple(a, b) {
    if (a.birth !== b.birth) return a.birth < b.birth ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  }

  // The peer this tab should surrender to, or null to stay open.
  function decideClose(self, peers) {
    let best = null;
    for (const p of peers || []) {
      if (!p || p.key !== self.key || p.id === self.id) continue;
      if (compareTuple(p, self) >= 0) continue;
      if (!best || compareTuple(p, best) < 0) best = p;
    }
    return best;
  }

  function isExcluded(href, list) {
    let u;
    try { u = new URL(href); } catch { return false; }
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    return (list || []).some((raw) => {
      const entry = String(raw || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!entry) return false;
      const slash = entry.indexOf('/');
      const eHost = slash === -1 ? entry : entry.slice(0, slash);
      const ePath = slash === -1 ? '' : entry.slice(slash);
      if (host !== eHost && !host.endsWith(`.${eHost}`)) return false;
      if (!ePath) return true;
      return path === ePath || path.startsWith(`${ePath}/`);
    });
  }

  // May this tab close ITSELF? A tab that answers "no" still joins the channel
  // and still answers other tabs' claims - it is a holder, just not a candidate.
  //
  // `reload` and `back_forward` are excluded on purpose. Reloading the tab you
  // are looking at must never hand your session to a background copy, and a
  // session restore reports one of those two for every tab it brings back -
  // without this guard a restore would mass-close.
  function isEligible(href, navType, cfg) {
    if (navType === 'reload' || navType === 'back_forward') return false;
    return isSweepable(href, cfg);
  }

  // A sweep is an explicit request, so it skips the reload/restore guard: those
  // exist to stop SURPRISE closures, and nothing here is a surprise. The oldest
  // tab still survives, so an explicit sweep can never cost you the page.
  function isSweepable(href, cfg) {
    const c = { ...DEFAULTS, ...(cfg || {}) };
    if (!normalizeKey(href, c.matchMode)) return false;
    if (isExcluded(href, c.exclusions)) return false;
    return true;
  }

  // A tab hears a claim every time another tab opens its URL, so the peer list
  // has to stay bounded and free of stale entries for a tab that already left.
  function addPeer(peers, msg, max = MAX_PEERS) {
    const out = peers.filter((p) => p.id !== msg.id);
    out.push(msg);
    return out.length > max ? out.slice(out.length - max) : out;
  }

  // A page shares its origin's BroadcastChannel with the content script, so
  // everything arriving here is untrusted input. Same-origin only, but still.
  function parseMessage(data) {
    if (!data || typeof data !== 'object') return null;
    const { t, key, id } = data;
    if (typeof key !== 'string' || !key) return null;
    if (typeof id !== 'string' || !id) return null;
    if (t === 'claim' || t === 'hold') {
      if (typeof data.birth !== 'number' || !Number.isFinite(data.birth)) return null;
      return { t, key, id, birth: data.birth };
    }
    if (t === 'focus') {
      if (typeof data.target !== 'string' || !data.target) return null;
      return { t, key, id, target: data.target };
    }
    return null;
  }

  function normalizeConfig(raw) {
    const c = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    if (!['exact', 'hash', 'tracking'].includes(c.matchMode)) c.matchMode = DEFAULTS.matchMode;
    if (!MODES.includes(c.mode)) c.mode = DEFAULTS.mode;
    c.showToast = c.showToast !== false;
    c.exclusions = Array.isArray(c.exclusions)
      ? [...new Set(c.exclusions.map((e) => String(e || '').trim()).filter(Boolean))]
      : [];
    return c;
  }

  return {
    CHANNEL, HOLD_WINDOW_MS, CLOSE_FALLBACK_MS, TOAST_MS, MAX_PEERS, MODES, DEFAULTS,
    isTrackingParam, normalizeKey, compareTuple, decideClose, addPeer,
    isExcluded, isEligible, isSweepable, parseMessage, normalizeConfig,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = core;
  return;
}

// ---------------------------------------------------------------------------
// Browser glue.
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  const STORE_KEY = 'dtc_config';
  const SWEEP_KEY = 'dtc_sweep';
  const SWEEP_WINDOW_MS = 4000;
  const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
  const REOPEN_HINT = IS_MAC ? '⌘⇧T' : 'Ctrl+Shift+T';

  let cfg = loadConfig();

  const state = {
    id: newId(),
    birth: Date.now() - performance.now(), // document creation, in wall-clock terms
    self: null,        // {key, id, birth} - our identity on the current URL
    canClose: false,   // may we close ourselves on this URL?
    peers: [],
    decided: false,
    sweeping: false,
    winner: null,
    lastHref: '',
    channel: null,
  };

  function newId() {
    try {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch { /* randomUUID needs a secure context; fall through */ }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function loadConfig() {
    let raw = null;
    try { raw = JSON.parse(GM_getValue(STORE_KEY, '{}')); } catch { raw = null; }
    return core.normalizeConfig(raw);
  }

  function saveConfig(next) {
    cfg = core.normalizeConfig({ ...cfg, ...next });
    GM_setValue(STORE_KEY, JSON.stringify(cfg));
  }

  function navType() {
    try {
      return performance.getEntriesByType('navigation')[0]?.type || '';
    } catch {
      return '';
    }
  }

  function post(msg) {
    try { state.channel.postMessage(msg); } catch { /* channel closed */ }
  }

  // -- protocol -------------------------------------------------------------

  function claim(href, nav) {
    const key = core.normalizeKey(href, cfg.matchMode);
    state.lastHref = href;
    state.peers = [];
    state.decided = false;
    state.winner = null;

    if (!key) { state.self = null; state.canClose = false; return; }

    state.self = { key, id: state.id, birth: state.birth };
    state.canClose = core.isEligible(href, nav, cfg);
    post({ t: 'claim', ...state.self });
    if (state.canClose) setTimeout(resolve, core.HOLD_WINDOW_MS);
  }

  function onMessage(ev) {
    const msg = core.parseMessage(ev.data);
    if (!msg || !state.self || msg.id === state.self.id) return;

    if (msg.t === 'focus') {
      if (msg.target !== state.self.id || msg.key !== state.self.key) return;
      try { window.focus(); } catch { /* grant unsupported */ }
      if (cfg.showToast) showToast(`Closed a duplicate tab · ${REOPEN_HINT} to reopen`);
      return;
    }

    if (msg.key !== state.self.key) return;
    if (msg.t === 'claim') post({ t: 'hold', ...state.self });

    state.peers = core.addPeer(state.peers, msg);
    resolve();
  }

  function resolve() {
    if (state.decided || !state.self) return;
    if (!state.canClose && !state.sweeping) return;
    const winner = core.decideClose(state.self, state.peers);
    if (!winner) return; // nobody older yet; a later claim can still decide this
    state.winner = winner;
    // Manual mode stops here on an ordinary load: it only remembers that this
    // tab is a duplicate. A sweep is an explicit request, so it goes through.
    if (cfg.mode !== 'auto' && !state.sweeping) return;
    state.decided = true;
    state.sweeping = false;
    surrender();
  }

  // Hand the session to the older tab and get out of the way.
  function surrender() {
    post({ t: 'focus', key: state.self.key, id: state.self.id, target: state.winner.id });
    closeSelf();
  }

  // -- the sweep ------------------------------------------------------------
  // A BroadcastChannel only reaches tabs of ONE origin, so it cannot carry a
  // "dedupe everything" command. GM storage can: every tab the manager is
  // running, in every window of the profile, gets the value-change callback.
  // So the sweep travels over GM storage, and each tab that hears it re-runs
  // the ordinary same-origin claim on its own channel.
  function requestSweep() {
    GM_setValue(SWEEP_KEY, `${Date.now()}:${state.id}`);
    runSweep(true);
  }

  // The tabs a sweep is FOR are background tabs, and Chrome throttles their
  // timers - so the decision must not depend on one. `sweeping` just arms this
  // tab; the actual close happens in resolve(), the moment an older peer speaks,
  // which runs off a channel message and is not throttled. The timer below only
  // ends the sweep and reports the negative case, where being late is harmless.
  function runSweep(local) {
    if (!state.self || state.decided) return;
    if (!core.isSweepable(location.href, cfg)) return;
    state.sweeping = true;
    state.peers = [];
    post({ t: 'claim', ...state.self });
    resolve(); // a peer may have claimed us already
    setTimeout(() => {
      state.sweeping = false;
      if (local && !state.decided) showToast('No duplicate of this tab is open');
    }, SWEEP_WINDOW_MS);
  }

  function closeSelf() {
    try { window.close(); } catch { /* fall through to the banner */ }
    // window.close() is a silent no-op wherever the grant is unsupported
    // (Safari's Userscripts extension has neither grant). If we are still here,
    // say so instead of pretending.
    setTimeout(showBanner, core.CLOSE_FALLBACK_MS);
  }

  function softNav() {
    if (location.href === state.lastHref) return;
    if (state.decided) return;
    claim(location.href, ''); // nav type only describes the original load
  }

  function start() {
    if (typeof BroadcastChannel !== 'function') return;
    try {
      state.channel = new BroadcastChannel(core.CHANNEL);
    } catch {
      return;
    }
    state.channel.onmessage = onMessage;
    window.addEventListener('pagehide', () => {
      try { state.channel.close(); } catch { /* already closed */ }
    });

    claim(location.href, navType());

    // Cross-window, cross-origin: this is the only channel that reaches every
    // tab the manager runs in, so it is what makes the sweep global.
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(SWEEP_KEY, (name, oldValue, newValue, remote) => {
        if (remote) runSweep(false);
      });
    }

    // Soft navigations, without a permanent poll running on every site.
    window.addEventListener('hashchange', softNav);
    window.addEventListener('popstate', softNav);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) softNav();
    });
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyD') {
        e.preventDefault();
        openSettings();
      }
    }, true);
  }

  // -- UI -------------------------------------------------------------------

  let stylesInjected = false;

  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    GM_addStyle(`
    .dtc-layer { position: fixed; z-index: 2147483647; font: 13px/1.45 -apple-system,
      BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #f5f5f5;
      background: #1f2023; border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.35); padding: 10px 12px; box-sizing: border-box; }
    .dtc-toast { left: 50%; transform: translateX(-50%); top: 16px; opacity: 0;
      transition: opacity .18s ease; }
    .dtc-toast.dtc-on { opacity: 1; }
    .dtc-banner { left: 50%; transform: translateX(-50%); top: 16px;
      display: flex; gap: 10px; align-items: center; }
    .dtc-btn { all: unset; cursor: pointer; padding: 4px 10px; border-radius: 6px;
      background: rgba(255,255,255,.12); color: #f5f5f5; font-size: 12px; }
    .dtc-btn:hover { background: rgba(255,255,255,.22); }
    .dtc-panel { left: 50%; top: 12%; transform: translateX(-50%); width: 360px;
      max-width: calc(100vw - 32px); padding: 16px; }
    .dtc-panel h2 { all: unset; display: block; font-size: 14px; font-weight: 600;
      margin-bottom: 10px; }
    .dtc-row { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .dtc-row label { flex: 1; }
    .dtc-panel select, .dtc-panel textarea { font: inherit; color: #f5f5f5;
      background: #2b2d31; border: 1px solid rgba(255,255,255,.16); border-radius: 6px;
      padding: 4px 6px; box-sizing: border-box; }
    .dtc-panel textarea { width: 100%; height: 84px; resize: vertical; margin-top: 4px; }
    .dtc-hint { opacity: .6; font-size: 11px; margin-top: 2px; }
    .dtc-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    `);
  }

  function whenBody(fn) {
    if (document.body) { fn(); return; }
    document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  function layer(cls) {
    injectStyles(); // nothing is styled - or injected - until something is shown
    const el = document.createElement('div');
    el.className = `dtc-layer ${cls}`;
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openSettings(); });
    return el;
  }

  function button(label, onClick) {
    const b = document.createElement('button');
    b.className = 'dtc-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  let activeToast = null;

  // A sweep can hand a dozen tabs to the same survivor, so toasts refresh in
  // place instead of stacking up the side of the page.
  function showToast(text) {
    whenBody(() => {
      if (activeToast && activeToast.el.isConnected) {
        clearTimeout(activeToast.timer);
        activeToast.el.textContent = text;
      } else {
        const el = layer('dtc-toast');
        el.append(document.createTextNode(text));
        document.body.appendChild(el);
        requestAnimationFrame(() => el.classList.add('dtc-on'));
        activeToast = { el, timer: null };
      }
      const { el } = activeToast;
      activeToast.timer = setTimeout(() => {
        el.classList.remove('dtc-on');
        setTimeout(() => el.remove(), 250);
        activeToast = null;
      }, core.TOAST_MS);
    });
  }

  function showBanner() {
    if (!state.winner || document.querySelector('.dtc-banner')) return;
    whenBody(() => {
      const el = layer('dtc-banner');
      el.append(document.createTextNode('Already open in another tab'));
      el.append(button('Switch', () => {
        post({ t: 'focus', key: state.self.key, id: state.self.id, target: state.winner.id });
        try { window.close(); } catch { /* nothing else to try */ }
      }));
      el.append(button('Keep both', () => {
        state.decided = true;
        state.canClose = false;
        el.remove();
      }));
      document.body.appendChild(el);
    });
  }

  function openSettings() {
    const existing = document.querySelector('.dtc-panel');
    if (existing) { existing.remove(); return; }

    whenBody(() => {
      const el = layer('dtc-panel');

      const title = document.createElement('h2');
      title.textContent = 'Duplicate Tabs Closer';
      el.append(title);

      const toast = checkbox('Notify the surviving tab', cfg.showToast);

      const modeRowTop = document.createElement('div');
      modeRowTop.className = 'dtc-row';
      const modeTopLabel = document.createElement('label');
      modeTopLabel.textContent = 'Duplicate tabs';
      const modeSel = document.createElement('select');
      for (const [value, text] of [
        ['auto', 'close automatically'],
        ['manual', 'close only when I sweep'],
      ]) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        if (cfg.mode === value) o.selected = true;
        modeSel.append(o);
      }
      modeRowTop.append(modeTopLabel, modeSel);

      const modeRow = document.createElement('div');
      modeRow.className = 'dtc-row';
      const modeLabel = document.createElement('label');
      modeLabel.textContent = 'Same page means';
      const mode = document.createElement('select');
      for (const [value, text] of [
        ['exact', 'exact URL'],
        ['hash', 'ignore #hash'],
        ['tracking', 'ignore #hash + tracking'],
      ]) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        if (cfg.matchMode === value) o.selected = true;
        mode.append(o);
      }
      modeRow.append(modeLabel, mode);

      const exLabel = document.createElement('div');
      exLabel.textContent = 'Never dedupe (one per line)';
      const exList = document.createElement('textarea');
      exList.value = cfg.exclusions.join('\n');
      const hint = document.createElement('div');
      hint.className = 'dtc-hint';
      hint.textContent = 'example.com or example.com/inbox · subdomains included';

      const actions = document.createElement('div');
      actions.className = 'dtc-actions';
      actions.append(
        button('Exclude this site', () => {
          const host = location.hostname;
          const lines = exList.value.split('\n').map((s) => s.trim()).filter(Boolean);
          if (!lines.includes(host)) lines.push(host);
          exList.value = lines.join('\n');
        }),
        button('Save', () => {
          saveConfig({
            mode: modeSel.value,
            showToast: toast.input.checked,
            matchMode: mode.value,
            exclusions: exList.value.split('\n'),
          });
          el.remove();
        }),
        button('Close', () => el.remove()),
      );

      el.append(modeRowTop, toast.row, modeRow, exLabel, exList, hint, actions);
      document.body.appendChild(el);
    });
  }

  function checkbox(text, checked) {
    const row = document.createElement('div');
    row.className = 'dtc-row';
    const label = document.createElement('label');
    label.textContent = text;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!checked;
    row.append(label, input);
    return { row, input };
  }

  // Two commands, in the order you reach for them: the sweep, then settings.
  // Turning the script off is the manager's job, not ours.
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Close duplicate tabs everywhere', requestSweep);
    GM_registerMenuCommand('Duplicate Tabs Closer: settings', openSettings);
  }

  start();
})();
