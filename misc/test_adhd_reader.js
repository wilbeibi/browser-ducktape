#!/usr/bin/env node
'use strict';

// Tests for adhd_reader.js core (content-root detection). Uses the real
// extracted core, not a reimplementation. Run: cd misc && node --test test_adhd_reader.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const core = require('../adhd_reader.user.js');

const LONG = 'This paragraph is deliberately padded so that it clears the eighty character floor. '; // 85 chars
const para = (n = 1) => `<p>${LONG.repeat(n)}</p>`;

// jsdom has no layout, so getClientRects() is always empty; tests inject
// visibility. Elements marked class="hidden" count as invisible.
const visible = (el) => !el.closest('.hidden');

function docOf(bodyHtml) {
  return new JSDOM(`<!DOCTYPE html><html><body>${bodyHtml}</body></html>`).window.document;
}

function findRoot(bodyHtml) {
  return core.findContentRoot(docOf(bodyHtml), visible);
}

// MIN_CHARS=4500 → ~11 single-LONG paragraphs. Use 12 paras of LONG×5 for a
// comfortably long article, 2-3 paragraphs for a short page.
const ARTICLE = para(5).repeat(12);

test('short page does not qualify', () => {
  assert.equal(findRoot(`<main>${para(3)}${para(3)}</main>`), null);
});

test('long article qualifies and root is the article container, not body', () => {
  const doc = docOf(`
    <nav><p>${LONG}${LONG}</p></nav>
    <div id="page">
      <div id="sidebar"><p>short teaser</p></div>
      <article id="body">${ARTICLE}</article>
    </div>
    <footer><p>${LONG}${LONG}</p></footer>`);
  const root = core.findContentRoot(doc, visible);
  assert.ok(root, 'should qualify');
  assert.equal(root.id, 'body');
});

test('nav/footer/aside text never counts toward the gate', () => {
  assert.equal(findRoot(`<nav>${ARTICLE}</nav><footer>${ARTICLE}</footer><aside>${ARTICLE}</aside>`), null);
});

test('hidden text never counts toward the gate', () => {
  assert.equal(findRoot(`<div class="hidden">${ARTICLE}</div>${para(2)}`), null);
});

test('link feed with short teasers does not qualify', () => {
  const items = Array.from({ length: 30 }, (_, i) =>
    `<div class="item"><a href="/x${i}">A headline about thing ${i}</a><p>${LONG}</p></div>`).join('');
  // 30 teaser paragraphs spread across items: enough chars overall would be
  // needed — each is exactly one LONG (85 chars), 30×85=2550 < 4500 → rejected.
  assert.equal(findRoot(`<main>${items}</main>`), null);
});

test('article plus comment thread: root covers the article', () => {
  const comments = para(2).repeat(8);
  const doc = docOf(`
    <main>
      <article id="story">${ARTICLE}</article>
      <section id="comments">${comments}</section>
    </main>`);
  const root = core.findContentRoot(doc, visible);
  assert.ok(root, 'should qualify');
  assert.ok(root.contains(doc.getElementById('story')), 'root must contain the article');
});

test('blockquote wrapping paragraphs is not double-counted', () => {
  // 6 paras inside a blockquote: counted once each (leaves), the wrapper adds 0.
  const inner = para(1).repeat(6);
  assert.equal(findRoot(`<main><blockquote>${inner}</blockquote></main>`), null);
});

test('threshold overrides are honored', () => {
  const doc = docOf(`<main id="m">${para(2).repeat(4)}</main>`);
  const root = core.findContentRoot(doc, visible, { minChars: 500, minParas: 3 });
  assert.ok(root, 'lowered threshold should qualify');
});
