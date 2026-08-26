#!/usr/bin/env node
'use strict';

// Tests for inline_translate.user.js — specifically pageLooksTranslatable(),
// the gate that decides whether the floating 译 button appears.
//
// inline_translate has no extracted `core` (it is one IIFE of browser glue), so
// instead of reimplementing the gate we run the real file in jsdom behind a GM_*
// shim and assert on the observable outcome: does .llmtr-fab get created?
//
// Run: cd misc && node --test test_inline_translate.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'inline_translate.user.js'), 'utf8');

// Runs the userscript against a document and hands the live window to `probe`.
async function runScript(bodyHtml, { lang = 'Simplified Chinese (简体中文)', mutate,
                                     apiKey = 'sk-test', apiUrl, xhr } = {}, probe) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`,
    { url: 'https://example.test/article' });
  const w = dom.window;
  if (w.document.readyState !== 'complete') {
    await new Promise(res => w.document.addEventListener('DOMContentLoaded', res, { once: true }));
  }
  const gm = { API_KEY: apiKey, TARGET_LANG: lang };
  if (apiUrl !== undefined) gm.API_URL = apiUrl;
  const heartbeats = []; // setInterval callbacks, so tests can tick them directly
  const requests = [];   // every GM_xmlhttpRequest the script issued
  const shim = {
    window: w, document: w.document, location: w.location, navigator: w.navigator,
    localStorage: w.localStorage, MutationObserver: w.MutationObserver,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    setTimeout: (...a) => w.setTimeout(...a), clearTimeout: (...a) => w.clearTimeout(...a),
    setInterval: (fn, ms, ...a) => { heartbeats.push(fn); return w.setInterval(fn, ms, ...a); },
    clearInterval: (...a) => w.clearInterval(...a),
    requestAnimationFrame: (cb) => w.setTimeout(cb, 0),
    GM_getValue: (k, d) => (k in gm ? gm[k] : d),
    GM_setValue: (k, v) => { gm[k] = v; },
    GM_addStyle: () => true,
    GM_registerMenuCommand: () => {},
    GM_xmlhttpRequest: (opts) => { requests.push(opts); if (xhr) xhr(opts); },
  };
  if (mutate) mutate(w); // build shapes the HTML parser refuses to produce
  const keys = Object.keys(shim);
  new Function(...keys, SRC)(...keys.map(k => shim[k]));
  const result = probe(w, { tick: () => heartbeats.forEach(fn => fn()), gm, requests });
  w.close();
  return result;
}

// Does the floating 译 button appear? tryShowFab()'s first attempt is
// synchronous inside init(), so one tick is enough.
const fabAppears = (bodyHtml, opts) =>
  runScript(bodyHtml, opts, w => !!w.document.querySelector('.llmtr-fab'));

// The source text of every block collect() picked up, in document order.
// Driven by the Ctrl+T hotkey rather than the button: the hotkey deliberately
// bypasses pageLooksTranslatable(), so a fixture can stay small enough to read
// while still exercising the collector. The stubbed IntersectionObserver keeps
// anything from being dispatched to the API.
const collectedText = (bodyHtml, opts) => runScript(bodyHtml, opts, (w) => {
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',
    { key: 't', code: 'KeyT', ctrlKey: true, bubbles: true }));
  return [...w.document.querySelectorAll('[data-llmtr-seen]')]
    .filter(el => el._llmtrSrc).map(el => el._llmtrSrc);
});

// ~180 chars — a realistic article paragraph, comfortably over PROSE_MIN_LEAF.
const PARA = 'Reversibility is the property that lets you undo a step without losing the '
  + 'work around it, and data tooling has almost none of it compared to source control today.';
const CN_PARA = '可逆性是指你可以撤销某一步而不丢失周围工作的性质，而今天的数据工具与版本控制相比几乎完全不具备这种性质，这也是团队反复重做实验的原因所在。';

test('semantic <p> article shows the button (unchanged behavior)', async () => {
  assert.equal(await fabAppears(`<article>${`<p>${PARA}</p>`.repeat(4)}</article>`), true);
});

// The regression this gate was rewritten for: Tailwind/MDX sites style <div>s as
// paragraphs and never emit <p>. Translation always worked on them; the button
// did not appear, so the feature looked broken.
test('div-as-paragraph article shows the button', async () => {
  const body = `<article><header><h1>Title</h1></header>
    <section>${`<div class="p1-blog">${PARA}</div>`.repeat(4)}</section></article>`;
  assert.equal(await fabAppears(body), true);
});

test('prose in table cells (old-web layout) shows the button', async () => {
  const body = `<table><tr><td>${PARA}</td></tr><tr><td>${PARA}</td></tr>
    <tr><td>${PARA}</td></tr><tr><td>${PARA}</td></tr></table>`;
  assert.equal(await fabAppears(body), true);
});

test('prose in unsemantic wrappers (<font>/<center>) shows the button', async () => {
  const body = `<center><font size="2">${PARA}</font></center>`.repeat(4);
  assert.equal(await fabAppears(body), true);
});

test('prose in unknown/custom elements shows the button', async () => {
  const body = `<my-post>${`<my-para>${PARA}</my-para>`.repeat(4)}</my-post>`;
  assert.equal(await fabAppears(body), true);
});

// Precision: accepting <div> leaves means tag semantics no longer separate prose
// from chrome, so PROSE_MIN_LEAF has to. These are the shapes that regressed
// when the threshold was too low.
test('link lists and menu items do not show the button', async () => {
  const item = '<div class="story"><a href="/x">A fairly wordy headline about something</a></div>';
  assert.equal(await fabAppears(item.repeat(40)), false);
});

test('app chrome (nav, sidebar, footer) does not show the button', async () => {
  const body = `<nav>${`<div>${PARA}</div>`.repeat(4)}</nav>
    <aside>${`<div>${PARA}</div>`.repeat(4)}</aside>
    <footer>${`<div>${PARA}</div>`.repeat(4)}</footer>`;
  assert.equal(await fabAppears(body), false);
});

test('a page of short labels does not show the button', async () => {
  assert.equal(await fabAppears('<div>Settings</div><div>Profile and account</div>'
    .repeat(60)), false);
});

test('article already in the target language does not show the button', async () => {
  assert.equal(await fabAppears(`<article>${`<div>${CN_PARA}</div>`.repeat(4)}</article>`), false);
});

test('the same Chinese article does show the button when translating to English', async () => {
  const body = `<article>${`<div>${CN_PARA}</div>`.repeat(4)}</article>`;
  assert.equal(await fabAppears(body, { lang: 'English' }), true);
});

// A wrapper and its inner paragraphs must not both count, or three real
// paragraphs inside two nested divs would clear the bar on their own.
test('nested wrappers are not double-counted', async () => {
  const half = PARA.slice(0, 130); // one leaf clears PROSE_MIN_LEAF, two don't clear PROSE_MIN_CHARS
  const body = `<div class="outer"><div class="inner">${`<div>${half}</div>`.repeat(2)}</div></div>`;
  assert.equal(await fabAppears(body), false);
});

// Chat hosts bypass the gate entirely (CHAT profiles), so an empty ChatGPT page
// still gets a button. Guard that the gate rewrite did not disturb it.
test('the gate still runs on ordinary hosts with no prose', async () => {
  assert.equal(await fabAppears('<div id="root"></div>'), false);
});

// Mixed content — an element whose children are both text and block elements —
// is HTML's normal case, but the collector had only two categories: leaf
// (translate whole) and container (recurse into *elements*). Anything in
// between had its text nodes silently dropped. Reported against a Blogger post;
// the same hole swallowed <li>text<ul>..</ul></li> from every Markdown renderer
// and paulgraham.com, where one 82-char <blockquote> disqualified a 66k-char
// essay inside a <font>. The rule now matches CSS: an element that holds text
// beside a block child is already rendering that text as anonymous block boxes,
// so those runs are lifted into real paragraphs no matter what tag holds them.
const BLOGGER_POST = `<div class="post-body entry-content">
  ONE ${PARA}<br /><br />
  TWO ${PARA}<br /><br />
  THREE ${PARA}<br />
  <ul><li>FOUR ${PARA}</li><li>FIVE ${PARA}</li></ul>
  <div>SIX ${PARA}<br /><br />SEVEN ${PARA}</div>
  <div style="clear: both;"></div>
</div>`;

test('<br><br> prose wrapped around a block child shows the button', async () => {
  assert.equal(await fabAppears(BLOGGER_POST), true);
});

test('<br><br> prose wrapped around a block child is collected, in order', async () => {
  const heads = (await collectedText(BLOGGER_POST)).map(t => t.split(' ')[0]);
  assert.deepEqual(heads, ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN']);
});

// The gate counts a <br><br> run as a paragraph break, which is what lets a
// one-container essay clear PROSE_MIN_BLOCKS. It must not credit breaks to an
// ancestor of the container that holds them.
test('a single <br><br> essay in one <div> shows the button', async () => {
  const essay = `${PARA}<br><br>`.repeat(3) + PARA; // 4 paragraphs clears PROSE_MIN_CHARS
  assert.equal(await fabAppears(`<div>${essay}</div>`), true);
});

test('<br>-separated short labels do not show the button', async () => {
  assert.equal(await fabAppears('<div>Settings<br><br>Profile<br><br>Sign out</div>'), false);
});

// The shape every Markdown renderer emits for a nested bullet, and by far the
// most common mixed-content case on the web.
test('list item text beside a nested list is collected', async () => {
  const body = `<ul><li>OUTER ${PARA}<ul><li>INNER ${PARA}</li></ul></li></ul>`;
  const heads = (await collectedText(body)).map(t => t.split(' ')[0]);
  assert.deepEqual(heads, ['OUTER', 'INNER']);
});

// paulgraham.com: the essay sits in one inline <font> that contains a single
// short <blockquote>. Tag-based guesses at "is this a block container?" get
// this wrong; the block child is what proves the text is already block-laid-out.
test('essay in an inline wrapper with one block child is collected', async () => {
  const body = `<font size="2">${`ESSAY ${PARA}<br><br>`.repeat(3)}`
    + `<blockquote>QUOTE ${PARA}</blockquote>TAIL ${PARA}</font>`;
  const heads = (await collectedText(body)).map(t => t.split(' ')[0]);
  assert.deepEqual(heads, ['ESSAY', 'ESSAY', 'ESSAY', 'QUOTE', 'TAIL']);
});

// ...but not inside table structure, where CSS foster-parenting would move a
// wrapper <div> back out of the table and take the text with it. The HTML
// parser hoists such text out on its own, so this shape only arises when script
// builds it — which is exactly how the fixture has to build it too.
test('loose text in table structure is left alone', async () => {
  const body = `<table></table>`;
  const mutate = (w) => {
    const table = w.document.querySelector('table');
    table.appendChild(w.document.createTextNode(`STRAY ${PARA}`));
    const div = w.document.createElement('div');   // a block child, so the
    div.textContent = `CELL ${PARA}`;              // table is not a leaf
    table.appendChild(div);
  };
  const heads = (await collectedText(body, { mutate })).map(t => t.split(' ')[0]);
  assert.deepEqual(heads, ['CELL']);
});

// A framework that re-renders after the script has run can detach the button.
// It used to stay gone for the life of the page — the module-level `fab` was
// still truthy, so the poll returned early forever. Ctrl+T kept working, which
// is what made it read as "the button just doesn't show on this site".
test('a button detached by a re-render is rebuilt', async () => {
  const body = `<article>${`<p>${PARA}</p>`.repeat(4)}</article>`;
  const rebuilt = await runScript(body, {}, (w, { tick }) => {
    const first = w.document.querySelector('.llmtr-fab');
    assert.ok(first, 'button should appear on a plain article');
    first.remove();                                  // the re-render
    assert.equal(w.document.querySelector('.llmtr-fab'), null);
    tick();                                          // heartbeat notices
    return !!w.document.querySelector('.llmtr-fab');
  });
  assert.equal(rebuilt, true);
});

// Same loop, driven by an SPA route change instead: the poll has long since
// stopped, and the new route is the first one that looks like an article.
test('an SPA route change re-runs the gate after the poll stopped', async () => {
  const shown = await runScript('<div id="root"></div>', {}, (w, { tick }) => {
    assert.equal(w.document.querySelector('.llmtr-fab'), null, 'empty shell: no button');
    w.document.getElementById('root').innerHTML = `<article>${`<p>${PARA}</p>`.repeat(4)}</article>`;
    w.history.pushState({}, '', '/blog/some-article');
    tick();
    return !!w.document.querySelector('.llmtr-fab');
  });
  assert.equal(shown, true);
});

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

// With no key saved, Ctrl+T opens the setup modal instead of translating.
// The picker exists because a working key still fails when the model id does
// not match the endpoint: OpenRouter namespaces its ids and DeepSeek does not.
const openSetup = (opts, probe) => runScript('<div id="root"></div>',
  { apiKey: '', ...opts }, (w, ctx) => {
    w.document.dispatchEvent(new w.KeyboardEvent('keydown',
      { key: 't', code: 'KeyT', ctrlKey: true, bubbles: true }));
    const modal = w.document.querySelector('.llmtr-modal');
    assert.ok(modal, 'setup modal should open when no key is saved');
    const [url, model] = [...modal.querySelectorAll('input')].slice(1, 3);
    return probe({ w, modal, sel: modal.querySelector('select'), url, model, ...ctx });
  });

const suggestions = (modal) =>
  [...modal.querySelectorAll('datalist option')].map(o => o.value);

test('first-run setup offers a provider picker', async () => {
  const ids = await openSetup({}, ({ sel }) => [...sel.options].map(o => o.value));
  assert.deepEqual(ids, ['deepseek', 'openrouter', 'custom']);
});

test('first run opens on the provider the script ships with', async () => {
  const got = await openSetup({}, ({ sel }) => sel.value);
  assert.equal(got, 'deepseek');
});

test('choosing OpenRouter fills the endpoint and suggests namespaced ids', async () => {
  const got = await openSetup({}, ({ modal, sel, url }) => {
    sel.value = 'openrouter';
    sel.onchange();
    return { url: url.value, models: suggestions(modal) };
  });
  assert.equal(got.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(got.models.length, 'OpenRouter should suggest models');
  assert.ok(got.models.every(m => m.includes('/')),
    `OpenRouter ids must be namespaced, got ${got.models}`);
});

test('switching provider drops a model id that belongs to the other one', async () => {
  const got = await openSetup({}, ({ sel, model }) => {
    model.value = 'deepseek-v4-flash';   // valid on DeepSeek, 404s on OpenRouter
    sel.value = 'openrouter';
    sel.onchange();
    return model.value;
  });
  assert.equal(got, '');
});

test('a saved OpenRouter endpoint reopens on OpenRouter', async () => {
  const got = await openSetup(
    { apiUrl: 'https://openrouter.ai/api/v1/chat/completions' },
    ({ sel }) => sel.value);
  assert.equal(got, 'openrouter');
});

// Host match, not string match: a saved URL may differ in path and still be
// the same service.
test('a saved endpoint on the same host still matches its provider', async () => {
  const got = await openSetup(
    { apiUrl: 'https://openrouter.ai/api/v1/chat/completions/' },
    ({ sel }) => sel.value);
  assert.equal(got, 'openrouter');
});

test('typing an unknown endpoint switches the picker to Custom', async () => {
  const got = await openSetup({}, ({ sel, url }) => {
    url.value = 'https://llm.internal.example/v1/chat/completions';
    url.oninput();
    return sel.value;
  });
  assert.equal(got, 'custom');
});

// The picker is a convenience, not a gate — the fields stay free text so an
// endpoint serving ids we have never heard of still works.
test('Custom leaves the endpoint the user typed alone', async () => {
  const got = await openSetup({}, ({ sel, url }) => {
    url.value = 'https://llm.internal.example/v1/chat/completions';
    url.oninput();
    sel.value = 'custom';
    sel.onchange();
    return url.value;
  });
  assert.equal(got, 'https://llm.internal.example/v1/chat/completions');
});

// ---------------------------------------------------------------------------
// Live OpenRouter catalog
// ---------------------------------------------------------------------------

// A hardcoded model list rots — this repo already carries LEGACY_MODELS because
// DeepSeek retired two ids out from under it. OpenRouter serves its catalog
// unauthenticated, so the suggestions can be the real thing.
const catalog = (ids) => (opts) => opts.onload &&
  opts.onload({ responseText: JSON.stringify({ data: ids.map(id => ({ id })) }) });

const LIVE = ['deepseek/deepseek-v4-pro', 'anthropic/claude-opus-4.6', 'zzz/newcomer'];

test('OpenRouter suggestions come from the live catalog', async () => {
  const got = await openSetup({ xhr: catalog(LIVE) }, ({ modal, sel, requests }) => {
    sel.value = 'openrouter';
    sel.onchange();
    return { models: suggestions(modal), urls: requests.map(r => r.url) };
  });
  assert.deepEqual(got.models, [...LIVE].sort());
  assert.ok(got.urls.includes('https://openrouter.ai/api/v1/models'),
    `expected a catalog fetch, got ${got.urls}`);
});

// The catalog is public, so it must not be gated on a key the user has not
// entered yet — the suggestions matter most on a first run.
test('the catalog is fetched without sending the API key', async () => {
  const sent = await openSetup({ xhr: catalog(LIVE) }, ({ sel, requests }) => {
    sel.value = 'openrouter';
    sel.onchange();
    const req = requests.find(r => r.url && r.url.endsWith('/models'));
    return { method: req.method, headers: req.headers };
  });
  assert.equal(sent.method, 'GET');
  assert.ok(!sent.headers || !('Authorization' in sent.headers),
    'catalog fetch must not carry credentials');
});

test('a failed catalog fetch leaves the built-in suggestions in place', async () => {
  const models = await openSetup(
    { xhr: (opts) => opts.onerror && opts.onerror({}) },
    ({ modal, sel }) => { sel.value = 'openrouter'; sel.onchange(); return suggestions(modal); });
  assert.ok(models.length, 'fallback list should survive a dead network');
  assert.ok(models.every(m => m.includes('/')), `expected namespaced ids, got ${models}`);
});

test('a malformed catalog response leaves the built-in suggestions in place', async () => {
  const models = await openSetup(
    { xhr: (opts) => opts.onload && opts.onload({ responseText: 'not json' }) },
    ({ modal, sel }) => { sel.value = 'openrouter'; sel.onchange(); return suggestions(modal); });
  assert.ok(models.length && models.every(m => m.includes('/')));
});

test('the catalog is cached rather than refetched on every open', async () => {
  const got = await openSetup({ xhr: catalog(LIVE) }, ({ sel, gm, requests }) => {
    sel.value = 'openrouter'; sel.onchange();
    sel.value = 'deepseek';   sel.onchange();
    sel.value = 'openrouter'; sel.onchange();
    return { fetches: requests.filter(r => r.url && r.url.endsWith('/models')).length,
             cached: JSON.parse(gm.OR_MODELS_CACHE || '{}').ids };
  });
  assert.deepEqual(got.cached, [...LIVE].sort(), 'catalog should be written to storage');
  assert.equal(got.fetches, 1, 'second visit should be served from cache');
});

// The fetch is async in the browser; the user may have moved on by the time it
// lands, and it must not overwrite the provider now on screen.
let late; // released by the test below once it has switched providers
test('a late catalog response does not clobber another provider', async () => {
  const models = await openSetup(
    { xhr: (opts) => { late = () => opts.onload({ responseText: JSON.stringify({ data: LIVE.map(id => ({ id })) }) }); } },
    ({ modal, sel }) => {
      sel.value = 'openrouter'; sel.onchange();   // fetch starts, held open
      sel.value = 'deepseek';   sel.onchange();   // user moves on
      late();                                     // ...and only now does it land
      return suggestions(modal);
    });
  assert.ok(models.every(m => !m.includes('/')), `expected DeepSeek ids, got ${models}`);
});
