const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '..', 'deepwiki_on_github.user.js'), 'utf8');
const selector = '[aria-label="View on DeepWiki"]';

function run(html, url = 'https://github.com/owner/first') {
    const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
    dom.window.eval(script);
    return dom;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

test('adds a DeepWiki link to the current repository navigation', async () => {
    const dom = run('<nav aria-label="Repository"><ul><li><a href="/owner/first">Code</a></li></ul></nav>');
    try {
        await wait(550);
        const link = dom.window.document.querySelector(selector);
        assert.equal(link?.href, 'https://deepwiki.com/owner/first');
        assert.equal(link?.closest('nav')?.getAttribute('aria-label'), 'Repository');
        assert.equal(dom.window.document.querySelectorAll(selector).length, 1);
    } finally {
        dom.window.close();
    }
});

test('replaces a removed link and updates its target after GitHub navigation', async () => {
    const dom = run('<nav aria-label="Repository"><ul><li>Code</li></ul></nav>');
    let mutations;
    try {
        await wait(550);
        dom.window.history.pushState({}, '', '/owner/second');
        dom.window.document.querySelector('nav').outerHTML =
            '<nav aria-label="Repository"><ul><li>Code</li></ul></nav>';
        mutations = setInterval(() => {
            const node = dom.window.document.createElement('span');
            dom.window.document.body.appendChild(node);
            node.remove();
        }, 40);
        await wait(350);
        const links = dom.window.document.querySelectorAll(selector);
        assert.equal(links.length, 1);
        assert.equal(links[0].href, 'https://deepwiki.com/owner/second');
    } finally {
        clearInterval(mutations);
        dom.window.close();
    }
});

test('keeps support for GitHub’s older repository navigation', async () => {
    const dom = run('<ul class="UnderlineNav-body"><li>Code</li></ul>');
    try {
        await wait(550);
        assert.equal(dom.window.document.querySelector(selector)?.href,
            'https://deepwiki.com/owner/first');
    } finally {
        dom.window.close();
    }
});
