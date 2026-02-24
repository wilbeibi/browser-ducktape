# Browser Ducktape 🦆

Userscripts for patching up daily browsing annoyances.

## Install

1. Get [Violentmonkey](https://violentmonkey.github.io/) — [Chrome](https://chrome.google.com/webstore/detail/violentmonkey/jinjacmigcnfinphajbemlabodjabnV) / [Firefox](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/)
2. Open any `.js` file here, click **Raw**, and Violentmonkey will pick it up.

## Scripts

### 🧠 Focus & Accessibility
- **`adhd_reader.js`** — Highlights the line you're reading. Keeps your eyes from wandering.
  ![Reading Ruler Demo](screenshots/highlight.png)

- **`worth_watching.js`** — During work hours, blurs YouTube/Bilibili and asks a random question like *"Was this video part of your plan today?"* before you can watch. 10-second cooldown to prevent autopilot clicks. Skip the timer for study/learning videos.

### 🤖 AI Tools
- **`prompt_rewrite.js`** — One-click prompt enhancer for Claude, ChatGPT, and Gemini. Hit ✨, get a sharper prompt. Undo if you don't like it. Works with any OpenAI-compatible API.

- **`claude_usage_pace.js`** — Shows a progress bar of your Claude usage against your reset timer, so you know whether to pace yourself or go all-in.
  ![Claude Usage Pace Demo](screenshots/pacer.png)

- **`gemini_dynamic_tab_title.js`** — Names your Gemini tabs after the conversation so you can actually find them.

### 🛠️ Utilities
- **`deepwiki_on_github.js`** — Adds a button on GitHub repos to jump straight to DeepWiki for AI-generated docs and code explanations.
  ![DeepWiki on GitHub Demo](screenshots/deepwiki.png)

- **`youtube_transcript_downloader.js`** — Adds a download button next to any YouTube video to grab its transcript as plain text. Great for feeding into LLMs or note-taking.
