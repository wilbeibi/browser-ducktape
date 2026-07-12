# Publishing to Greasy Fork

The GitHub raw URLs in the README already work as one-click installs, so this is purely about
**discovery** — Greasy Fork is where people browse for userscripts, and each script gets its own
page, screenshots, and install counter.

Do this once per script, then leave it alone; sync keeps it current.

## One-time setup

1. Sign in at [greasyfork.org](https://greasyfork.org) (GitHub OAuth works).
2. **Post a new script** and paste the contents of one `*.user.js` file.
3. On the script's admin page, open the **Sync** settings and point it at the raw URL, e.g.
   `https://raw.githubusercontent.com/wilbeibi/browser-ducktape/main/adhd_reader.user.js`.
   Set it to sync automatically. Greasy Fork will re-fetch and republish whenever the file changes
   upstream.

Greasy Fork requires a recognizable open-source license, which the `@license MIT` header now
declares. It also reads `@homepageURL` and `@supportURL` to link back here.

## What Greasy Fork does to the header

It overrides `@downloadURL`/`@updateURL` with its own for copies installed from its site. That is
expected — a user who installs from Greasy Fork gets updates from Greasy Fork, and a user who
installs from the GitHub link gets them from GitHub. Both stay current. Leave the headers as they
are; do not strip them for Greasy Fork's benefit.

## Keeping it current

Bump `@version` when you ship a fix. That single field drives updates for **both** channels — the
raw-URL installs and the Greasy Fork listing. Without a bump, neither one updates.

## Which scripts are worth listing

The narrow ones (`claude_usage_pace`, `gemini_dynamic_tab_title`, `deepwiki_on_github`) will find
their audience through Greasy Fork's per-site browse pages, which is exactly the discovery the
GitHub repo cannot give them. The AI scripts need an API key, so lead their descriptions with that
requirement rather than burying it — an install that silently does nothing is worse than no
install.
