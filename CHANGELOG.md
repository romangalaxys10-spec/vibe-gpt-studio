# Changelog

All notable changes to **Vibe GPT Studio** are documented here.
Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## [1.1.0] — 2026-08-10

### 🐛 Fixed
- **`/preview?session=` route ignored the session id and served a stale static
  file** (`server.js`). The route read `client/dist/preview.html` (last written
  by the `SERVE_AND_OPEN_FIREFOX` agentic action) regardless of the `?session=`
  query parameter, so every `preview.html?session=<id>` URL rendered the *same*
  ancient artifact (in production: a 951-byte truncated CSS fragment from an
  old broken session). Rewrote the route to be session-aware: it now looks up
  the session, walks its messages in reverse, and serves the latest assistant
  `extractedCode` (with trailing-prompt-leak truncation and bare-fragment
  wrapping). Returns HTTP 404 for unknown session ids and a helpful placeholder
  for sessions with no generated code yet.

- **Vite dev server did not proxy `/preview` or `/preview.html` to the
  backend** (`client/vite.config.ts`). With no proxy configured,
  `http://localhost:5173/preview.html?session=<id>` hit Vite's SPA fallback and
  returned the React shell instead of the rendered HTML. Added a `server.proxy`
  block forwarding `/preview`, `/preview.html` (with rewrite), and `/api` to
  `http://localhost:3099`.

- **Truncated-HTML false-positive in the integrity verifier** (`server.js`).
  The closing-tag check used a *lexical* regex (`/<\/html\s*>/i`) that matched
  the literal `</html>` substring inside Qwen's own truncation notice
  (`[TRUNCATED: generation stopped before closing </html>]`). As a result a
  truncated, partial HTML document was silently marked `integrityOk: true` and
  shipped to the live-preview iframe, producing a blank/broken preview.

  Root cause + fix detail:
  1. **Strip injected marker text** before matching closing tags. Added a
     defensive pipeline (`extractGeneratedCode`, block 3c) that removes
     `[TRUNCATED …]`, `generation stopped …`, and `[CONTINUE …]` substrings.
  2. **Structural closing-tag tests.** `hasClosingHtml` / `hasClosingBody` now
     require the tag to be the *terminal* token (`/<\/html\s*>\s*$/i`),
     not merely present anywhere in the text.
  3. **`</body>` now also required.** New truncation reason
     `missing-closing-tags` fires when an HTML document is missing either
     `</html>` or `</body>`, and the Qwen auto-continue recovery path is now
     gated on both `missing-closing-html` **and** `missing-closing-tags`.

  Verified end-to-end against both providers with fresh generations
  (qwen: 3970 chars / chatgpt: 14369 chars, both `integrityOk: true`, both
  ending in a complete `</body></html>`).

- **Qwen composer selector collision** (`qwen_service.js`). The composer
  matcher used a bare `textarea` selector that matched the **readonly Monaco
  code-editor textarea** (aria-label `"Editor content"`) from artifact / vibe-
  coding conversations ahead of the real chat composer. Tightened to
  `textarea.message-input-textarea` with safe fallbacks
  (`div[class*="input"] textarea:not([readonly])`, then
  `div[contenteditable="true"]`).

### ✨ Added
- `verification` object now persisted on every assistant message in the session
  JSON, surfacing `integrityOk`, `truncated`, `truncationReason`, `issues`,
  `extractionSource`, and structural tag flags for debugging.
- Auto-continue recovery path emits explicit issue markers:
  `RECOVERED: auto-continue completed the HTML` (success) or
  `TRUNCATED_RESPONSE: still incomplete after auto-continue` (failure).

### 🎨 UI
- Hide the raw streaming `text` for `vibe_code` assistant messages when
  `extractedCode` is present — the code block + preview buttons are the
  source of truth, the raw stream was visual noise.

---

## [1.0.0] — 2026-08-10

### ✨ Added
- Initial release: visual chat IDE powered by browser-automated ChatGPT
  (chatgpt.com) and Qwen (chat.qwen.ai) — no API keys.
- Express + WebSocket backend (`server.js`, port 3099), Vite + React frontend
  (port 5173), Electron desktop wrapper.
- Session manager persisted to `~/.vibe-gpt-studio/sessions/`.
- Agentic tools: sub-agent orchestration, app-focus engine, terminal stream.
- Merged `chatgpt-firefox-automation` automation submodule (v1.1.0).
