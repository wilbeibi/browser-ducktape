#!/usr/bin/env node
'use strict';

// Tests for hover_verdict.js core. Uses the real extracted core, not a parallel
// reimplementation. DOM-based functions use jsdom; pure predicates are plain.
//
// Run:  cd misc && npm install && npm test
// Or:   node --test test_hover_verdict.js   (after `npm install`)

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// jsdom provides DOMParser, document, etc. on the global scope.
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://example.com/' });
global.DOMParser = dom.window.DOMParser;
global.URL = URL;
global.window = dom.window;
global.document = dom.window.document;

// Load the core from the userscript. The IIFE exports via module.exports.
const path = require('node:path');
const fs = require('node:fs');
const src = fs.readFileSync(
  path.join(__dirname, '..', 'hover_verdict.js'),
  'utf8'
);
// Evaluate the script in a function scope so `module` is defined for the export guard.
const moduleObj = { exports: {} };
const fn = new Function('module', 'exports', 'DOMParser', 'URL', src);
fn(moduleObj, moduleObj.exports, dom.window.DOMParser, URL);
const core = moduleObj.exports;

// ---- golden URL examples -------------------------------------------------
const GOLDEN = {
  githubRepo:      'https://github.com/burntsushi/regex',
  nytimesArticle:  'https://www.nytimes.com/2024/01/15/us/politics/something.html',
  tcoShortener:    'https://t.co/abc123',
  stratechery:      'https://stratechery.com/2024/01/15/article-about-tech/',
  shopifyRiver:     'https://shopify.engineering/under-the-river',
  pdfFile:          'https://example.com/spec.pdf',
  mediumPost:       'https://medium.com/@someone/some-post-123abc',
  unknownBlog:      'https://blog.someblog.example.com/2024/01/15/hello',
};

test('instant() classifies golden URLs correctly', () => {
  const gh = core.instant(GOLDEN.githubRepo);
  assert.equal(gh.host, 'github.com');
  assert.equal(gh.base, 'github.com');
  assert.equal(gh.redirect, false);
  assert.equal(gh.wall, false);
  assert.equal(gh.typeTag, null);
  assert.ok(gh.favicon.includes('github.com'));

  const nyt = core.instant(GOLDEN.nytimesArticle);
  assert.equal(nyt.wall, true, 'nytimes.com should be marked as paywall');
  assert.equal(nyt.redirect, false);

  const tco = core.instant(GOLDEN.tcoShortener);
  assert.equal(tco.redirect, true, 't.co should be marked as redirector');
  assert.equal(tco.host, 't.co');

  const pdf = core.instant(GOLDEN.pdfFile);
  assert.equal(pdf.typeTag, 'PDF', '.pdf files should get a type tag');
  assert.equal(pdf.wall, false);

  const med = core.instant(GOLDEN.mediumPost);
  assert.equal(med.wall, true, 'medium.com should be marked as paywall');
});

test('instant() strips www and extracts base domain', () => {
  const s = core.instant('https://www.example.co.uk/path');
  assert.equal(s.host, 'example.co.uk');
  // base = last two labels: co.uk is not ideal, but this is the documented behavior
  assert.equal(s.base, 'co.uk');
});

test('instant() favicon URL includes the host', () => {
  const s = core.instant('https://blog.example.com/post');
  assert.ok(s.favicon.includes('domain=blog.example.com'));
});

test('looksLikeShell detects JS-wall and login-wall pages', () => {
  assert.equal(core.looksLikeShell('Please enable JavaScript to continue.'), true);
  assert.equal(core.looksLikeShell('Log in to continue to Twitter'), true);
  assert.equal(core.looksLikeShell("Don't miss what's happening"), true);
  assert.equal(core.looksLikeShell('Your request originates from an undeclared automated tool'), true);
});

test('looksLikeShell returns false for real article text', () => {
  const real = 'The company announced a new product today, featuring improved battery life and a redesigned interface.';
  assert.equal(core.looksLikeShell(real), false);
});

test('looksLikeShell returns true for empty input', () => {
  assert.equal(core.looksLikeShell(''), true);
  assert.equal(core.looksLikeShell(null), true);
  assert.equal(core.looksLikeShell(undefined), true);
});

test('verdictCacheable rejects verdicts that would poison the cache', () => {
  assert.equal(core.verdictCacheable(null), false);
  assert.equal(core.verdictCacheable(''), false);
  assert.equal(core.verdictCacheable('too short'), false);
  assert.equal(core.verdictCacheable('Unable to summarize this page.'), false);
  assert.equal(core.verdictCacheable('Cannot access content.'), false);
  assert.equal(core.verdictCacheable('Sorry, I cannot help with that.'), false);
  assert.equal(core.verdictCacheable('No content available to summarize here.'), false);
});

test('verdictCacheable accepts real verdicts', () => {
  const good = 'A detailed analysis of Rust regex performance benchmarks comparing DFA and NFA engines across various inputs.';
  assert.equal(core.verdictCacheable(good), true);
});

test('cacheEntryStale detects entries older than V_TTL', () => {
  const now = Date.now();
  assert.equal(core.cacheEntryStale(now - core.V_TTL - 1, now), true, 'entry older than TTL is stale');
  assert.equal(core.cacheEntryStale(now - 1000, now), false, 'recent entry is not stale');
  assert.equal(core.cacheEntryStale(undefined, now), true, 'missing ts is stale');
});

test('selectPruneKeys keeps 80% and prunes oldest when over cap', () => {
  const cap = 600;
  const entries = [];
  for (let i = 0; i < cap + 100; i++) {
    entries.push({ key: 'v:url' + i, ts: i * 1000 });
  }
  const pruneKeys = core.selectPruneKeys(entries, cap);
  assert.ok(pruneKeys.length > 0, 'should prune when over cap');
  // Oldest 100 + 20% slack = 120 pruned (cap*0.8 = 480 kept, 700-480=220 pruned)
  const expectedPruned = entries.length - Math.floor(cap * 0.8);
  assert.equal(pruneKeys.length, expectedPruned);
  // Pruned keys should be the oldest (lowest ts)
  assert.equal(pruneKeys[0], 'v:url0');
  assert.ok(!pruneKeys.includes('v:url' + (entries.length - 1)), 'newest key should be kept');
});

test('selectPruneKeys returns nothing when under cap', () => {
  const entries = [{ key: 'v:a', ts: 1 }, { key: 'v:b', ts: 2 }];
  assert.deepEqual(core.selectPruneKeys(entries, 600), []);
});

test('readerNeeded returns true when desc or text is missing or thin', () => {
  assert.equal(core.readerNeeded({}), true);
  assert.equal(core.readerNeeded({ desc: 'short', text: '' }), true);
  assert.equal(core.readerNeeded({ desc: 'ok', text: 'x'.repeat(100) }), true); // text < 300
});

test('readerNeeded returns true when text looks like a shell', () => {
  assert.equal(core.readerNeeded({ desc: 'ok', text: 'Please enable JavaScript to continue.' }), true);
});

test('readerNeeded returns false when desc and text are decent', () => {
  const goodText = 'x'.repeat(400);
  assert.equal(core.readerNeeded({ desc: 'A good description here', text: goodText }), false);
});

test('verdictEligible returns true when no AI verdict and desc is weak or missing', () => {
  assert.equal(core.verdictEligible({}), true);
  assert.equal(core.verdictEligible({ desc: 'short' }), true);
  assert.equal(core.verdictEligible({ desc: 'x'.repeat(100) }), false, 'long desc is not weak');
  assert.equal(core.verdictEligible({ descAI: true }), false, 'already has AI verdict');
});

test('buildVerdictPrompt includes URL and text in the user message', () => {
  const url = GOLDEN.githubRepo;
  const text = 'A Rust regex library focused on safety and performance.';
  const body = core.buildVerdictPrompt(url, text);
  assert.equal(body.max_tokens, 70);
  assert.equal(body.temperature, 0);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.ok(body.messages[1].content.includes(url));
  assert.ok(body.messages[1].content.includes(text));
});

test('compactText collapses whitespace and trims', () => {
  assert.equal(core.compactText('  hello   world  '), 'hello world');
  assert.equal(core.compactText('\n\n\tfoo\r\nbar'), 'foo bar');
  assert.equal(core.compactText(null), '');
  assert.equal(core.compactText(undefined), '');
});

test('clipSentence clips at a sentence or word boundary', () => {
  const long = 'This is a very long sentence that goes on and on and on and on and on and on and on and on and on and on and on and on.';
  const clipped = core.clipSentence(long, 50);
  assert.ok(clipped.length <= 51, 'clipped should be at most max+1 chars');
  assert.ok(clipped.endsWith('…'));
  assert.equal(core.clipSentence('short', 50), 'short');
});

test('parseHeadResponse extracts metadata from a realistic HTML response', () => {
  const html = `
<!DOCTYPE html><html><head>
  <meta property="og:title" content="BurntSushi/regex: A Rust regex library">
  <meta property="og:description" content="A Rust regex library for parsing, compiling, and executing regular expressions.">
  <meta property="og:image" content="/static/og.png">
</head><body>
  <article><p>This is the main body of the README. It describes the regex crate and its features in detail.</p></article>
</body></html>`;
  const r = {
    responseHeaders: 'content-type: text/html; charset=utf-8\n',
    responseText: html,
    finalUrl: GOLDEN.githubRepo,
  };
  const parsed = core.parseHeadResponse(r, GOLDEN.githubRepo);
  assert.equal(parsed.title, 'BurntSushi/regex: A Rust regex library');
  assert.ok(parsed.desc.includes('A Rust regex library'));
  assert.equal(parsed.finalUrl, GOLDEN.githubRepo);
  assert.equal(parsed.finalHost, 'github.com');
  assert.ok(parsed.image.includes('github.com/static/og.png'), 'image should be absolute');
  assert.ok(parsed.text.length > 0, 'body text should be extracted');
});

test('parseHeadResponse throws on non-HTML content-type', () => {
  const r = {
    responseHeaders: 'content-type: application/pdf\n',
    responseText: 'not html',
    finalUrl: GOLDEN.pdfFile,
  };
  assert.throws(() => core.parseHeadResponse(r, GOLDEN.pdfFile), /not html/);
});

test('parseHeadResponse extracts a snippet when no meta description', () => {
  const html = `<!DOCTYPE html><html><body>
    <article><p>This is the first paragraph of the article and it is long enough to be considered a valid snippet.</p></article>
  </body></html>`;
  const r = {
    responseHeaders: 'content-type: text/html\n',
    responseText: html,
    finalUrl: 'https://blog.example.com/post',
  };
  const parsed = core.parseHeadResponse(r, 'https://blog.example.com/post');
  assert.ok(parsed.desc.length > 0, 'should fall back to snippet');
  assert.ok(parsed.desc.includes('first paragraph'), 'snippet should come from <p>');
});

test('parseReaderResponse parses Jina Reader JSON', () => {
  const r = {
    status: 200,
    responseText: JSON.stringify({
      data: {
        title: 'Example Article',
        content: 'This is the readable content of the article, extracted by the Jina Reader service.',
        url: 'https://example.com/article',
      }
    }),
  };
  const parsed = core.parseReaderResponse(r, 'https://example.com/article');
  assert.equal(parsed.title, 'Example Article');
  assert.ok(parsed.desc.length > 0);
  assert.equal(parsed.finalHost, 'example.com');
  assert.equal(parsed.finalUrl, 'https://example.com/article');
});

test('parseReaderResponse throws on HTTP error', () => {
  const r = {
    status: 402,
    responseText: JSON.stringify({ message: 'Payment required' }),
  };
  assert.throws(() => core.parseReaderResponse(r, 'https://example.com'), /Payment required/);
});

test('parseReaderResponse throws on shell content', () => {
  const r = {
    status: 200,
    responseText: JSON.stringify({
      data: { content: 'Please enable JavaScript to continue.', url: 'https://example.com' }
    }),
  };
  assert.throws(() => core.parseReaderResponse(r, 'https://example.com'), /empty reader/);
});

test('parseVerdictResponse extracts the verdict text', () => {
  const r = {
    status: 200,
    responseText: JSON.stringify({
      choices: [{ message: { content: '  A Rust regex library focused on safety and performance.  ' } }]
    }),
  };
  const v = core.parseVerdictResponse(r);
  assert.equal(v, 'A Rust regex library focused on safety and performance.');
});

test('parseVerdictResponse throws on HTTP error with API message', () => {
  const r = {
    status: 401,
    responseText: JSON.stringify({ error: { message: 'Invalid API key' } }),
  };
  assert.throws(() => core.parseVerdictResponse(r), /Invalid API key/);
});

test('parseVerdictResponse throws on malformed JSON', () => {
  const r = { status: 200, responseText: 'not json' };
  assert.throws(() => core.parseVerdictResponse(r));
});

test('mergeRedirect re-derives favicon, wall, typeTag from resolved URL', () => {
  const original = core.instant(GOLDEN.tcoShortener);
  assert.equal(original.redirect, true);
  const merged = core.mergeRedirect(original, GOLDEN.githubRepo);
  assert.equal(merged.redirect, false, 'merged should not be a redirector anymore');
  assert.equal(merged.favicon, core.instant(GOLDEN.githubRepo).favicon);
  assert.equal(merged.wall, false);
  assert.equal(merged.host, 't.co', 'host should be preserved for the arrow display');
});

test('normalizeHost lowercases and strips leading www', () => {
  assert.equal(core.normalizeHost('WWW.Example.COM'), 'example.com');
});

test('parseDisabledHosts returns normalized unique sorted hosts', () => {
  assert.deepEqual(
    core.parseDisabledHosts('["WWW.Example.COM","example.com","blog.example.com",""]'),
    ['blog.example.com', 'example.com']
  );
});

test('parseDisabledHosts tolerates malformed storage', () => {
  assert.deepEqual(core.parseDisabledHosts('not json'), []);
});

test('isHostDisabled compares normalized hostnames', () => {
  assert.equal(core.isHostDisabled('www.example.com', ['example.com']), true);
  assert.equal(core.isHostDisabled('sub.example.com', ['example.com']), false);
});

test('bodyTextFromDoc strips nav/footer/script and extracts article text', () => {
  const doc = new dom.window.DOMParser().parseFromString(`
    <!DOCTYPE html><html><body>
      <nav>Home About Contact</nav>
      <script>alert('hi')</script>
      <article>
        <p>This is the main article content that should be extracted as body text.</p>
      </article>
      <footer>Copyright 2024</footer>
    </body></html>
  `, 'text/html');
  const text = core.bodyTextFromDoc(doc);
  assert.ok(text.includes('main article content'));
  assert.ok(!text.includes('Home About'), 'nav should be stripped');
  assert.ok(!text.includes('Copyright'), 'footer should be stripped');
  assert.ok(!text.includes('alert'), 'script should be stripped');
});

test('snippetFromDoc prefers the first long paragraph', () => {
  const doc = new dom.window.DOMParser().parseFromString(`
    <!DOCTYPE html><html><body>
      <article>
        <p>short</p>
        <p>This is a longer paragraph that should be selected as the snippet because it exceeds the minimum length threshold.</p>
      </article>
    </body></html>
  `, 'text/html');
  const snip = core.snippetFromDoc(doc);
  assert.ok(snip.includes('longer paragraph'));
  assert.ok(!snip.includes('short'));
});

// ---- link scoping: article vs link-list pages ----------------------------

function docWith(html) {
  return new dom.window.DOMParser().parseFromString(
    '<!DOCTYPE html><html><body>' + html + '</body></html>',
    'text/html'
  );
}

const LONG_P = '<p>' + 'x'.repeat(100) + '</p>';

function installUserscript(pageDom) {
  const previous = {
    DOMParser: global.DOMParser,
    document: global.document,
    getComputedStyle: global.getComputedStyle,
    innerHeight: global.innerHeight,
    innerWidth: global.innerWidth,
    location: global.location,
    requestAnimationFrame: global.requestAnimationFrame,
    window: global.window,
  };
  const win = pageDom.window;
  global.DOMParser = win.DOMParser;
  global.document = win.document;
  global.getComputedStyle = win.getComputedStyle.bind(win);
  global.innerHeight = 768;
  global.innerWidth = 1024;
  global.location = win.location;
  global.requestAnimationFrame = cb => setTimeout(cb, 0);
  global.window = win;

  const store = new Map();
  const GM_xmlhttpRequest = () => {};
  const GM_addStyle = css => {
    const style = win.document.createElement('style');
    style.textContent = css;
    win.document.head.appendChild(style);
    return style;
  };
  const GM_getValue = (key, fallback) => store.has(key) ? store.get(key) : fallback;
  const GM_setValue = (key, value) => store.set(key, value);
  const GM_deleteValue = key => store.delete(key);
  const GM_listValues = () => [...store.keys()];
  const GM_registerMenuCommand = () => {};

  new Function(
    'GM_xmlhttpRequest',
    'GM_addStyle',
    'GM_getValue',
    'GM_setValue',
    'GM_deleteValue',
    'GM_listValues',
    'GM_registerMenuCommand',
    'DOMParser',
    'URL',
    src
  )(
    GM_xmlhttpRequest,
    GM_addStyle,
    GM_getValue,
    GM_setValue,
    GM_deleteValue,
    GM_listValues,
    GM_registerMenuCommand,
    win.DOMParser,
    URL
  );

  return () => Object.assign(global, previous);
}

test('isArticlePage returns true when a page has 3+ long paragraphs', () => {
  const doc = docWith(`<article>${LONG_P}${LONG_P}${LONG_P}</article>`);
  assert.equal(core.isArticlePage(doc), true);
});

test('isArticlePage returns false for link-list pages (few paragraphs)', () => {
  const doc = docWith(`
    <div class="athing"><a href="https://example.com">A link</a></div>
    <div class="athing"><a href="https://example.com">Another link</a></div>
    <p>short text</p>
  `);
  assert.equal(core.isArticlePage(doc), false);
});

test('isArticlePage returns false for app/canvas pages', () => {
  const doc = docWith('<div role="application"><canvas></canvas></div>');
  assert.equal(core.isArticlePage(doc), false);
});

test('Shopify Under the River page shape keeps article links eligible', () => {
  const doc = docWith(`
    <header><a id="shopify-nav" href="https://shopify.engineering/">blog</a></header>
    <main role="main">
      <article>
        ${LONG_P}${LONG_P}${LONG_P}
        <p>Build everything with <a id="shopify-nix" href="https://shopify.engineering/what-is-nix">Nix</a>.</p>
      </article>
    </main>
    <footer><a id="shopify-footer" href="https://shopify.engineering/topics/infrastructure">Infrastructure</a></footer>
  `);
  assert.equal(core.isArticlePage(doc), true);
  assert.equal(core.isLinkInContent(doc.querySelector('#shopify-nix')), true);
  assert.equal(core.isLinkInContent(doc.querySelector('#shopify-nav')), false);
  assert.equal(core.isLinkInContent(doc.querySelector('#shopify-footer')), false);
});

test('isLinkInContent returns true for links inside article/main', () => {
  const doc = docWith(`<article><p><a href="https://example.com">link</a></p></article>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), true);
});

test('isLinkInContent returns true for links inside .entry-content', () => {
  const doc = docWith(`<div class="entry-content"><a href="https://example.com">link</a></div>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), true);
});

test('isLinkInContent returns false for links inside nav', () => {
  const doc = docWith(`<nav><a href="https://example.com">Home</a></nav>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), false);
});

test('isLinkInContent returns false for links inside footer', () => {
  const doc = docWith(`<footer><a href="https://example.com">About</a></footer>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), false);
});

test('isLinkInContent returns false for links in sidebar/aside', () => {
  const doc = docWith(`<aside><a href="https://example.com">Related</a></aside>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), false);
});

test('isLinkInContent returns false for bare links with no content container', () => {
  const doc = docWith(`<div><a href="https://example.com">floating link</a></div>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), false);
});

test('isLinkInContent: chrome wins — a link in nav inside article is excluded', () => {
  const doc = docWith(`<article><nav><a href="https://example.com">nav link</a></nav></article>`);
  const a = doc.querySelector('a');
  assert.equal(core.isLinkInContent(a), false, 'chrome check should take priority');
});

test('countLongParagraphs counts p and blockquote with >= 80 chars', () => {
  const doc = docWith(`
    <p>short</p>
    <p>${'x'.repeat(80)}</p>
    <blockquote>${'y'.repeat(100)}</blockquote>
    <p>${'z'.repeat(50)}</p>
  `);
  assert.equal(core.countLongParagraphs(doc), 2);
});

test('userscript reattaches overlay after Shopify hydration removes injected DOM', () => {
  const pageDom = new JSDOM(`
    <!DOCTYPE html><html><head></head><body>
      <main role="main">
        <article>
          ${LONG_P}${LONG_P}${LONG_P}
          <p>Build everything with <a id="shopify-nix" href="https://shopify.engineering/what-is-nix">Nix</a>.</p>
        </article>
      </main>
    </body></html>
  `, { url: GOLDEN.shopifyRiver, pretendToBeVisual: true });
  const restore = installUserscript(pageDom);
  const doc = pageDom.window.document;
  try {
    assert.ok(doc.querySelector('#hlv'));
    assert.ok(doc.querySelector('#hlv-style'));

    doc.querySelector('#hlv').remove();
    doc.querySelector('#hlv-style').remove();
    doc.querySelector('#shopify-nix').dispatchEvent(new pageDom.window.MouseEvent('mouseover', {
      bubbles: true,
      clientX: 25,
      clientY: 30,
    }));

    assert.ok(doc.querySelector('#hlv'));
    assert.ok(doc.querySelector('#hlv-style'));
    doc.dispatchEvent(new pageDom.window.Event('scroll'));
  } finally {
    restore();
  }
});
