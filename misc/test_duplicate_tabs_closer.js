#!/usr/bin/env node
'use strict';

// Tests for duplicate_tabs_closer core. Uses the real extracted core, not a
// reimplementation. Run: cd misc && node --test test_duplicate_tabs_closer.js

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../duplicate_tabs_closer.user.js');

const key = (href, mode = 'hash') => core.normalizeKey(href, mode);

// -- normalizeKey ------------------------------------------------------------

test('hash mode: fragment is ignored, path and query are not', () => {
  assert.equal(key('https://a.com/p?x=1#top'), key('https://a.com/p?x=1#bottom'));
  assert.notEqual(key('https://a.com/p?x=1'), key('https://a.com/p?x=2'));
  assert.notEqual(key('https://a.com/p'), key('https://a.com/q'));
});

test('hash mode: host case and a trailing slash are normalized away', () => {
  assert.equal(key('https://A.com/Foo/'), key('https://a.com/Foo'));
  assert.equal(key('https://a.com'), key('https://a.com/'));
  // Path case is meaningful on most servers; do not fold it.
  assert.notEqual(key('https://a.com/Foo'), key('https://a.com/foo'));
});

test('exact mode keeps the fragment', () => {
  assert.notEqual(key('https://a.com/p#a', 'exact'), key('https://a.com/p#b', 'exact'));
});

test('tracking mode strips utm_* and friends but keeps real params', () => {
  assert.equal(
    key('https://a.com/p?id=7&utm_source=x&fbclid=y&ref=z', 'tracking'),
    key('https://a.com/p?id=7', 'tracking'),
  );
  assert.notEqual(
    key('https://a.com/p?id=7', 'tracking'),
    key('https://a.com/p?id=8', 'tracking'),
  );
  // hash mode must NOT strip them
  assert.notEqual(key('https://a.com/p?utm_source=x'), key('https://a.com/p'));
});

test('non-http(s) and unparseable URLs have no key', () => {
  for (const href of ['about:blank', 'file:///tmp/x.html', 'chrome://extensions', 'nonsense']) {
    assert.equal(key(href), null, href);
  }
});

// -- ordering ----------------------------------------------------------------

const tab = (birth, id, k = 'https://a.com/p') => ({ key: k, id, birth });

test('older birth wins; equal births are broken by id, consistently', () => {
  assert.equal(core.compareTuple(tab(1, 'b'), tab(2, 'a')), -1);
  assert.equal(core.compareTuple(tab(2, 'a'), tab(2, 'b')), -1);
  assert.equal(core.compareTuple(tab(2, 'b'), tab(2, 'a')), 1);
  assert.equal(core.compareTuple(tab(2, 'a'), tab(2, 'a')), 0);
});

test('exactly one of N duplicates survives, and it is the oldest', () => {
  const tabs = [tab(100, 'x'), tab(100, 'a'), tab(50, 'q'), tab(300, 'm')];
  const closing = tabs.filter((t) => core.decideClose(t, tabs) !== null);
  const surviving = tabs.filter((t) => core.decideClose(t, tabs) === null);
  assert.equal(surviving.length, 1);
  assert.equal(surviving[0].id, 'q');
  assert.equal(closing.length, 3);
});

test('two tabs can never close each other', () => {
  // Every unordered pair, including the equal-birth case that a duplicated tab
  // (sessionStorage is copied, clocks agree) can produce.
  const births = [10, 10, 20];
  const ids = ['a', 'b', 'c'];
  for (const b1 of births) for (const b2 of births) for (const i1 of ids) for (const i2 of ids) {
    if (b1 === b2 && i1 === i2) continue;
    const t1 = tab(b1, i1);
    const t2 = tab(b2, i2);
    const both = core.decideClose(t1, [t2]) && core.decideClose(t2, [t1]);
    assert.equal(!!both, false, `${b1}/${i1} vs ${b2}/${i2}`);
  }
});

test('a peer on a different key is not a duplicate', () => {
  const me = tab(100, 'me');
  assert.equal(core.decideClose(me, [tab(1, 'old', 'https://a.com/other')]), null);
});

test('our own echo never closes us', () => {
  const me = tab(100, 'me');
  assert.equal(core.decideClose(me, [{ ...me }]), null);
});

test('the surrender target is the oldest peer, not just any older one', () => {
  const me = tab(100, 'me');
  assert.equal(core.decideClose(me, [tab(90, 'b'), tab(10, 'a'), tab(50, 'c')]).id, 'a');
});

// -- exclusions --------------------------------------------------------------

test('host exclusions cover subdomains, not sibling domains', () => {
  const list = ['example.com'];
  assert.equal(core.isExcluded('https://example.com/x', list), true);
  assert.equal(core.isExcluded('https://mail.example.com/x', list), true);
  assert.equal(core.isExcluded('https://notexample.com/x', list), false);
  assert.equal(core.isExcluded('https://example.com.evil.net/x', list), false);
});

test('path exclusions match a prefix boundary, not a substring', () => {
  const list = ['example.com/inbox'];
  assert.equal(core.isExcluded('https://example.com/inbox', list), true);
  assert.equal(core.isExcluded('https://example.com/inbox/42', list), true);
  assert.equal(core.isExcluded('https://example.com/inboxes', list), false);
  assert.equal(core.isExcluded('https://example.com/other', list), false);
});

test('exclusion entries tolerate scheme, case and trailing slash', () => {
  assert.equal(core.isExcluded('https://example.com/x', ['https://Example.com/']), true);
  assert.equal(core.isExcluded('https://example.com/x', ['  ', '']), false);
});

// -- eligibility -------------------------------------------------------------

test('a reload or a session restore never closes the tab', () => {
  assert.equal(core.isEligible('https://a.com/p', 'navigate', {}), true);
  assert.equal(core.isEligible('https://a.com/p', 'reload', {}), false);
  assert.equal(core.isEligible('https://a.com/p', 'back_forward', {}), false);
});

test('excluded and non-http tabs are not candidates', () => {
  assert.equal(core.isEligible('https://a.com/p', '', { exclusions: ['a.com'] }), false);
  assert.equal(core.isEligible('about:blank', '', {}), false);
});

// -- message validation ------------------------------------------------------

test('well-formed messages survive parsing', () => {
  assert.deepEqual(
    core.parseMessage({ t: 'claim', key: 'k', id: 'i', birth: 5 }),
    { t: 'claim', key: 'k', id: 'i', birth: 5 },
  );
  assert.deepEqual(
    core.parseMessage({ t: 'focus', key: 'k', id: 'i', target: 'j' }),
    { t: 'focus', key: 'k', id: 'i', target: 'j' },
  );
});

test('anything a hostile same-origin page could throw at us is rejected', () => {
  const bad = [
    null, undefined, 'claim', 42, [],
    { t: 'claim', key: 'k', id: 'i' },                       // no birth
    { t: 'claim', key: 'k', id: 'i', birth: '5' },           // birth not a number
    { t: 'claim', key: 'k', id: 'i', birth: NaN },
    { t: 'claim', key: '', id: 'i', birth: 5 },
    { t: 'claim', key: 'k', id: '', birth: 5 },
    { t: 'hold', key: 'k', birth: 5 },                       // no id
    { t: 'focus', key: 'k', id: 'i' },                       // no target
    { t: 'evict', key: 'k', id: 'i', birth: 5 },             // unknown verb
  ];
  for (const data of bad) assert.equal(core.parseMessage(data), null, JSON.stringify(data));
});

test('parsed messages carry no extra fields through', () => {
  const parsed = core.parseMessage({ t: 'claim', key: 'k', id: 'i', birth: 5, evil: 'x' });
  assert.equal('evil' in parsed, false);
});

// -- config ------------------------------------------------------------------

test('config normalization repairs junk and dedupes exclusions', () => {
  const c = core.normalizeConfig({ matchMode: 'bogus', mode: 'off', exclusions: ['a.com', ' a.com ', ''] });
  assert.equal(c.matchMode, core.DEFAULTS.matchMode);
  assert.equal(c.mode, 'auto');
  assert.deepEqual(c.exclusions, ['a.com']);
  assert.equal(c.showToast, true);
});

test('config normalization keeps explicit opt-outs', () => {
  const c = core.normalizeConfig({ mode: 'manual', showToast: false, matchMode: 'exact' });
  assert.equal(c.mode, 'manual');
  assert.equal(c.showToast, false);
  assert.equal(c.matchMode, 'exact');
});

// -- manual mode -------------------------------------------------------------

test('manual mode is still a candidate - the decision is deferred, not disabled', () => {
  // Manual tabs must keep claiming, or the sweep has no original to hand you to.
  assert.equal(core.isEligible('https://a.com/p', 'navigate', { mode: 'manual' }), true);
  assert.equal(core.isEligible('https://a.com/p', 'navigate', { mode: 'auto' }), true);
});

test('a manual tab still refuses to act on a reload', () => {
  assert.equal(core.isEligible('https://a.com/p', 'reload', { mode: 'manual' }), false);
});

// -- the sweep ---------------------------------------------------------------

test('an explicit sweep ignores the reload and restore guard', () => {
  // Those guards exist to prevent surprise. A sweep is not a surprise, and the
  // oldest tab survives either way.
  assert.equal(core.isSweepable('https://a.com/p', {}), true);
  assert.equal(core.isEligible('https://a.com/p', 'reload', {}), false);
});

test('a sweep still respects exclusions and non-http tabs', () => {
  assert.equal(core.isSweepable('https://a.com/p', { exclusions: ['a.com'] }), false);
  assert.equal(core.isSweepable('about:blank', {}), false);
});

test('a sweep runs in both modes - mode only governs what happens on load', () => {
  assert.equal(core.isSweepable('https://a.com/p', { mode: 'manual' }), true);
  assert.equal(core.isSweepable('https://a.com/p', { mode: 'auto' }), true);
});

// -- peer bookkeeping --------------------------------------------------------

test('a peer that speaks twice is stored once, at its newest value', () => {
  const peers = core.addPeer(core.addPeer([], tab(5, 'a')), { ...tab(7, 'a'), t: 'hold' });
  assert.equal(peers.length, 1);
  assert.equal(peers[0].birth, 7);
});

test('the peer list stays bounded however long a tab lives', () => {
  let peers = [];
  for (let i = 0; i < core.MAX_PEERS * 3; i++) peers = core.addPeer(peers, tab(i, `id-${i}`));
  assert.equal(peers.length, core.MAX_PEERS);
  // the survivors are the most recent ones
  assert.equal(peers[peers.length - 1].id, `id-${core.MAX_PEERS * 3 - 1}`);
});

test('eviction never drops the oldest peer while it is still talking', () => {
  // The winner keeps replying to our claims, so it re-enters at the end of the
  // list every round and cannot be aged out from under us.
  let peers = [core.DEFAULTS && tab(1, 'winner')];
  for (let i = 0; i < core.MAX_PEERS * 2; i++) {
    peers = core.addPeer(peers, tab(100 + i, `noise-${i}`));
    peers = core.addPeer(peers, tab(1, 'winner'));
  }
  assert.equal(core.decideClose(tab(500, 'me'), peers).id, 'winner');
});

test('a corrupt stored config falls back to defaults', () => {
  assert.deepEqual(core.normalizeConfig(null), core.DEFAULTS);
  assert.deepEqual(core.normalizeConfig('nonsense'), core.DEFAULTS);
});
