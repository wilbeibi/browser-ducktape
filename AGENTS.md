# AGENTS.md

Guidance for AI agents working in this repo.

## What this repo is

A flat collection of standalone userscripts. Each `*.user.js` at the repo root is a complete,
self-contained script — no build step, no bundler, no shared runtime. A user installs one
without installing any of the others.

Consequences worth internalizing:

- **Do not introduce a build step or a shared `lib/`.** The distribution format *is* the source
  file. If two scripts need the same helper, duplicate it. Duplication is cheaper here than a
  build pipeline, and the raw GitHub URL must stay directly installable.
- **The filename suffix `.user.js` is load-bearing.** Userscript managers only offer a one-click
  install for URLs ending in `.user.js`. Never rename a script to plain `.js`.
- **Classic scripts only.** No `import`/`export` at top level, no ESM. The whole script body lives
  in one IIFE.

## Shipping a change

`@downloadURL`/`@updateURL` in each header point at the raw `main` URL, so installed copies
auto-update. **A user only receives your fix if you bump `@version`.** Managers compare versions
and do nothing when it is unchanged. Bump it in the same commit as the change.

Keep the header's `@license MIT`, `@homepageURL`, and `@supportURL` intact — Greasy Fork reads them.

## Cross-manager compatibility

Target **Tampermonkey** and **Violentmonkey** as first-class. Safari's
[Userscripts](https://github.com/quoid/userscripts) is best-effort. The APIs are *mostly* shared,
and the differences below are where scripts actually break.

### Grants

Declare exactly the `@grant`s you use, and no more. `@grant none` is not "no grants" — it changes
the execution sandbox (the script runs in the page context, and no `GM_*` function exists at all).
Adding the first `@grant` to a `@grant none` script silently moves it into an isolated world, which
can break any code that touched page globals.

### `GM_registerMenuCommand` is not universal

Safari's Userscripts extension does not implement it. Every script here that uses it for settings
(`inline_translate`, `hover_verdict`, `prompt_rewrite`, `worth_watching`) also exposes an in-page
affordance — right-clicking the floating button. **Keep it that way.** The menu command is a
convenience, never the only route to configuration.

### Sync vs async storage

`GM_getValue`/`GM_setValue` are synchronous in Tampermonkey and Violentmonkey. Safari Userscripts
and Greasemonkey 4 only provide the Promise-based `GM.getValue`/`GM.setValue`. Code that does
`const cfg = GM_getValue('cfg')` at module scope is therefore Chromium/Firefox-only by
construction. That is an accepted trade-off today — just don't deepen it, and if you touch config
loading, prefer making the call site `await`-tolerant.

### Network requests

`GM_xmlhttpRequest` is the only way to reach a cross-origin API from a userscript, and it requires
`@connect`. The AI scripts use `@connect *` because the user supplies an arbitrary
OpenAI-compatible endpoint. Violentmonkey enforces `@connect` strictly; Tampermonkey prompts the
user on a miss. Never fall back to bare `fetch` for the LLM call — it will be blocked by the
page's CSP on most sites.

### Page context vs content context

`@inject-into content` (used by `deepwiki_on_github` and `gemini_dynamic_tab_title`) is a
**Violentmonkey** key; Tampermonkey ignores it and uses `@sandbox` instead. The comment at
`gemini_dynamic_tab_title.user.js:61` explains why that script must not run in the page context:
Google's CSP blocks it on Firefox. Respect these choices — they encode a bug that was already
found and fixed once.

### CSP and Trusted Types

Strict sites — GitHub is the one that bites here, and `deepwiki_on_github` runs on it — enforce
Trusted Types, which makes `element.innerHTML = '...'` throw. Build DOM with
`document.createElement` and `textContent`. Inject CSS via `GM_addStyle`, not by appending a
`<style>` tag with inline content.

## Testing

Three layers, cheapest first. Prefer the cheapest one that can catch the bug you care about.

### 1. Extracted core + jsdom (fast, the default)

The established pattern: pull pure logic into a `core` object and expose it under a guard at the
bottom of the file, so Node can require the very same file the browser runs.

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = core;
}
```

See `adhd_reader.user.js:111` and `hover_verdict.user.js:288`. Tests live in `misc/`:

```bash
cd misc && npm install
node --test test_hover_verdict.js test_adhd_reader.js
```

**Write tests at this layer whenever the change has extractable logic.** It is the only layer that
runs in CI-like time.

### 2. Playwright with a GM shim (real page, no extension)

For DOM behavior against a real site without the extension overhead: launch Playwright, stub the
`GM_*` functions you grant, and inject the script source with `page.addInitScript`. This catches
selector rot and layout assumptions. It does *not* validate grants, `@match`, `@connect`, or the
manager's sandbox — those are exactly what layer 3 is for.

### 3. Real manager in Playwright (slow, rare)

Extensions load only in **Chromium**, only via `chromium.launchPersistentContext` with
`--disable-extensions-except=<path> --load-extension=<path>` pointing at an unpacked
Tampermonkey/Violentmonkey build, and only with `channel: 'chromium'` (the plain `--headless`
flag cannot load extensions). Firefox and WebKit cannot load extensions this way at all.

Reserve this for changes to header metadata, grants, or injection context.

### Manual matrix

Anything touching the header or the injection context should be smoke-tested by hand in at least:

| Browser | Manager | Why it matters |
| --- | --- | --- |
| Chrome or Brave | Tampermonkey | The MV3 sandbox; needs "Allow user scripts" enabled |
| Firefox | Violentmonkey | Stricter CSP behavior; different `@inject-into` handling |

Say plainly which of these you actually ran. Do not describe an untested script as verified.
