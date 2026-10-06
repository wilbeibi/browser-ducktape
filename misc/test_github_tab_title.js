#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const script = fs.readFileSync(path.join(__dirname, '..', 'github_tab_title.user.js'), 'utf8');

function page(url, title) {
  const dom = new JSDOM(`<!doctype html><title>${title}</title><body></body>`, {
    url, runScripts: 'outside-only',
  });
  const { window } = dom;
  let tick;
  window.setInterval = (callback) => { tick = callback; };
  window.GM_addStyle = () => {};
  window.GM_registerMenuCommand = () => {};
  window.eval(script);
  return { window, tick };
}

test('a tab marker survives title rewrites and clears without changing the issue title', () => {
  const { window, tick } = page(
    'https://github.com/acme/repo/issues/123',
    'Fix login by alice · Issue #123 · acme/repo',
  );
  const doc = window.document;
  assert.equal(doc.title, '#123 Fix login · repo');

  doc.querySelector('#gtt-button').click();
  [...doc.querySelectorAll('#gtt-picker button')]
    .find((button) => button.textContent.includes('Waiting for me')).click();
  assert.equal(doc.title, '🟥 #123 Fix login · repo');
  tick();
  assert.equal(doc.title, '🟥 #123 Fix login · repo');

  doc.querySelector('#gtt-button').click();
  [...doc.querySelectorAll('#gtt-picker button')]
    .find((button) => button.textContent === 'Clear marker').click();
  assert.equal(doc.title, '#123 Fix login · repo');
  window.close();
});

test('custom color and meaning apply to the selected tab', () => {
  const { window } = page('https://github.com/acme/repo', 'acme/repo');
  const doc = window.document;
  doc.querySelector('#gtt-button').click();
  [...doc.querySelectorAll('#gtt-picker button')]
    .find((button) => button.textContent.includes('Edit labels')).click();
  const row = doc.querySelectorAll('#gtt-picker .gtt-row')[3];
  row.querySelector('select').value = '🟩';
  row.querySelector('input').value = 'Read on Friday';
  [...doc.querySelectorAll('#gtt-picker button')]
    .find((button) => button.textContent === 'Save').click();

  doc.querySelector('#gtt-button').click();
  [...doc.querySelectorAll('#gtt-picker button')]
    .find((button) => button.textContent.includes('Read on Friday')).click();
  assert.equal(doc.title, '🟩 acme/repo');
  window.close();
});
