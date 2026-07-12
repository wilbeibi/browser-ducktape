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

Safari's Userscripts extension does not implement it at all, so calling it bare is a
`ReferenceError` that kills the script at load. Always call it through a
`typeof GM_registerMenuCommand === 'function'` guard.

Guarding stops the crash but not the loss of function. Where the menu is the *only* route to a
feature, that feature is simply gone on Safari — today that is `hover_verdict`'s settings and
per-site toggle, and `worth_watching`'s watch-later list, neither of which has an in-page
affordance. `inline_translate` and `adhd_reader` are fine (right-click the floating button; Alt+H).
When you add a feature, give it an in-page route and treat the menu command as a shortcut.

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

### CSP

The hazard is `script-src`, not Trusted Types. GitHub — where `deepwiki_on_github` runs — serves
`default-src 'none'; script-src github.githubassets.com; style-src 'unsafe-inline' ...`. It does
**not** set `require-trusted-types-for`, so `innerHTML` does not throw there. Don't chase Trusted
Types on GitHub; check the site's real CSP header before assuming.

A strict `script-src` is the thing to worry about with `@grant none`. Historically Tampermonkey
implemented `@grant none` by injecting a `<script>` tag into the page, which a strict `script-src`
blocks outright — the script simply never runs. **This may no longer hold:** a direct test against
Tampermonkey 5.5.0 (MV3) in Chromium showed a `@grant none` script running fine on github.com,
apparently because MV3 injects via `chrome.userScripts` into a world the page CSP does not govern.

Treat this as unsettled. The repo's stance is to sidestep the question entirely: **no script uses
`@grant none`.** The three that used to (`deepwiki_on_github`, `gemini_dynamic_tab_title`,
`claude_usage_pace`) now declare `@grant GM_info` — a deliberate no-op grant whose only job is to
keep the script out of raw page-context injection. It is correct under the old model and harmless
under the new one, and it costs nothing because none of them touch page globals. `lint_headers.js`
enforces this. If you ever need page-context access, that is the moment to actually re-test.

For CSS, prefer `GM_addStyle` over appending a hand-built `<style>` element: the manager mediates it
and it is not subject to the page's `style-src`.

## Testing

CI (`.github/workflows/ci.yml`) runs exactly two things: the header lint and the jsdom tests. Both
run locally in seconds via `cd misc && npm run check`.

### 0. Header lint (`misc/lint_headers.js`)

Zero-dependency. It encodes the repo invariants no off-the-shelf linter knows: `@grant` must match
the `GM_*` functions actually called (both directions), `GM_xmlhttpRequest` requires `@connect`,
`@downloadURL` must point at the file's own name, `GM_registerMenuCommand` must be `typeof`-guarded,
CSS must go through `GM_addStyle`, and — the one that matters most — **`@version` must be bumped
when a script changes**, because without it no installed copy ever receives the fix.

Be honest about its reach: it checks headers and call sites, not behavior. Most real bugs are not
here.

### 1. Extracted core + jsdom (fast, the default — and where the bugs actually are)

The established pattern: pull pure logic into a `core` object and expose it under a guard at the
bottom of the file, so Node can require the very same file the browser runs.

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = core;
}
```

See `adhd_reader.user.js:112` and `hover_verdict.user.js:314`. Tests live in `misc/`:

```bash
cd misc && npm install
npm run check     # header lint + tests, exactly what CI runs
npm test          # tests only
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
