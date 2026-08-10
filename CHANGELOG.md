# Changelog

All notable changes to **Vibe GPT Studio** are documented here.
Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## [1.3.0] — 2026-08-10

### 🐛 Fixed
- **Qwen automation hung for 4+ minutes when the provider refused to generate**
  (`qwen_service.js`). When qwen.ai hit its free-tier daily quota (`Rules: 3/3`),
  the message was typed and submitted, but no assistant message ever appeared.
  The stability-loop then polled the DOM for the full 240s deadline before
  giving up — making every qwen turn look like a permanent hang. Now:
  1. **8s no-response detector**: after 8s with no new assistant message, scan
     the body for the `Rules: N/N` quota indicator or a login wall. If found,
     throw a clear error immediately ("Qwen free-tier quota exhausted — resets
     daily").
  2. **30s fast-fail in stability loop**: if 30s pass and zero text was ever
     generated, abort instead of waiting 4 minutes.

- **Agent-mode system prompt contradicted the TOOL: contract** (`server.js`).
  The prompt said "Output ONLY JSON or executable command blocks", which made
  ChatGPT respond with `{"status":"ready"}` JSON acks instead of `TOOL:` lines.
  Rewrote the contract to explicitly forbid JSON status objects and require the
  exact `TOOL: <name> <json>` format.

- **ChatGPT hedged with `TOOL: noop {}` for unfamiliar tools** (`server.js`,
  `agentic_tools.js`). When asked to take a screenshot / write a file /
  navigate, ChatGPT emitted `noop` (a hallucinated tool name) instead of the
  real one. Two mitigations:
  1. Tool catalog now explicitly enumerates the 8 valid names and forbids
     invented names like `noop`, `ack`, `respond`.
  2. Server-side auto-retry: when `parseAndExecuteTools` reports an unknown
     tool, the server re-dispatches one correction prompt ("use one of these 8
     names") and accepts the corrected result.

### ✅ Verified
- ChatGPT `exec_command` end-to-end: model emits `TOOL: exec_command`, executor
  runs `ls -la /tmp`, stdout returned.
- ChatGPT `read_file` end-to-end: model emits `TOOL: read_file`, reads
  `/etc/hostname` → `roman-WUJIE-Series`.
- All 8 tool wrappers (Layer 1 unit suite): correct behavior on direct
  invocation.

### ⚠️ Known limitations (honest)
- **Qwen free-tier quota**: the daily message limit blocks live qwen tool-
  calling tests until reset. The automation is correct (verified earlier: qwen
  emitted `TOOL: exec_command` and returned `QWEN-E2E-MARKER`); the block is
  the account quota, not code.
- **ChatGPT model non-cooperation**: when driven headlessly through chatgpt.com,
  the model intermittently refuses to follow the TOOL: protocol — returning
  short ack strings (`CHATGPT_OK`, `{"status":"ready"}`) instead of tool calls,
  especially for less-common tools (screenshot, write_file, navigate).
  `exec_command` and `read_file` are reliable; the others work sometimes. A
  native function-calling API integration (instead of web-UI prompting) would
  be substantially more robust.
- **Browser automation is heavy**: launching headless Firefox while the user's
  desktop Firefox + Discord are loaded (21GB/30GB RAM used) can OOM-kill the
  playwright process. The backend reuses one persistent context per provider to
  mitigate this; spawning additional concurrent contexts is not supported.

---

## [1.2.0] — 2026-08-10

### 🐛 Fixed
- **Empty provider responses were silently saved as junk messages** (`server.js`).
  When the browser automation raced (e.g. SPA not hydrated, or concurrent
  contexts overwhelming the provider) and read an empty DOM, the server saved
  a 0-byte assistant message with `integrityOk: false` and no explanation,
  leaving the user staring at a blank turn. Added an empty-response guard:
  if `responseText` is empty after sanitization, the turn is aborted with a
  clear terminal warning + a `PROMPT_COMPLETE` carrying
  `issues: ['EMPTY_PROVIDER_RESPONSE']` and a human-readable retry message,
  instead of persisting a junk botMsg.

- **Cross-session message bleed from a shared `activeSessionId` global**
  (`server.js`, `client/src/App.tsx`). The PROMPT handler read the module-level
  `activeSessionId` global again at response-save time (after a long
  `await sendPrompt`), so any concurrent `CREATE_SESSION` / `SELECT_SESSION` /
  `DELETE_SESSION` from another client (e.g. another browser tab, or a parallel
  test harness) re-pointed the global mid-flight and the assistant response was
  pushed into the WRONG session — corrupting the user's open conversation with
  foreign messages. Forensics confirmed via two parallel audit agents.

  Fix:
  1. Snapshot `originSessionId` once at PROMPT-handler entry (prefer
     `msg.sessionId` from the client; fall back to the global only for legacy
     callers).
  2. Thread `originSessionId` through every async reference (response save,
     broadcasts).
  3. Tag `PROMPT_COMPLETE`, `STREAM_TOKEN`, and `STATUS` broadcasts with
     `sessionId`.
  4. Client now filters incoming events on `sessionId === activeSessionId`,
     so cross-session activity no longer overwrites the focused conversation.
  5. Client now sends `sessionId` in every PROMPT message.
  6. Stopped mutating the global `activeSessionId` from inside the PROMPT
     handler (UI focus state must not change because a background prompt ran).

  Verified via a 3-way concurrent stress test: no foreign markers appeared in
  any session's assistant responses.

- **Per-session `headful` flag ignored** (`server.js`). The PROMPT closure read
  `activeSession.headful` (a static global) instead of the originating
  session's headful flag. Now uses `s.headful` with fallback to the global
  default.

### 🔧 Agentic tools overhaul (`agentic_tools.js`, `server.js`)

Computer-use / terminal / browser-control layer made production-usable. The
executor plumbing already worked; the bugs were in the tool-calling contract,
shell construction, and mode gating.

- **Tools now available in `vibe_code` mode too** (`server.js`). Previously the
  tool catalog was injected only in `agent` mode, so users in the default
  `vibe_code` mode could never invoke desktop/terminal/file actions. The
  catalog is now appended in both modes (CODE_GUARD stays dominant — tools
  activate only when the user asks for a system action, not code).
- **Crisp tool-calling contract** (`agentic_tools.js`). Rewrote
  `getToolDefinitions()` to give an unambiguous one-line-per-tool spec with a
  strict `TOOL: <name> <json>` format. ChatGPT previously copied the catalog's
  ```bash example block verbatim instead of emitting a tool call; the new
  contract + rules ("do NOT wrap in fences, do NOT add prose") fixed that —
  ChatGPT now emits valid `TOOL:` lines when phrased imperatively.
- **`navigate_url` invalid shell syntax** (`agentic_tools.js`). The chrome
  branch built `google-chrome-stable URL & || google-chrome URL &` — the
  `& ||` sequence is a shell syntax error (background operator immediately
  followed by OR). Replaced with a per-binary launcher ladder
  (`google-chrome-stable` → `google-chrome` → `chromium` → `chromium-browser`)
  that tries each in turn and reports failure if none exist.
- **`open_application` false-success on unknown apps** (`agentic_tools.js`).
  Returned `ok: true` before exec completed with no existence check, so
  `open_application({appName:'nonexistent'})` claimed success. Now verifies the
  binary exists in PATH/common locations before launching; returns
  `ok: false, error: "Application … not found"` otherwise.
- **Missing `/screenshot.png` route** (`server.js`). The `take_screenshot`
  tool returns `http://localhost:3099/screenshot.png`, but no route served it
  → 404. Added a static route serving `client/dist/screenshot.png`.
- **Tolerant tool parser** (`agentic_tools.js`). Regex now handles multi-line
  JSON args and tool calls wrapped in markdown fences, and reports unknown tool
  names instead of silently dropping them.

### ✅ Verified
- Layer 1 unit suite: **8/8 tools correct behavior** (exec_command, read_file,
  write_file, navigate_url, take_screenshot, click_mouse, type_keyboard,
  open_application-rejects-unknown).
- Layer 2 integration: Qwen emits `TOOL: exec_command{…}` end-to-end, executor
  fires, command output returned. ChatGPT emits valid tool calls when phrased
  imperatively.
- Concurrency stress test: 3 parallel sessions, zero cross-session bleed.

### ⚠️ Known limitation
- ChatGPT is more sensitive to prompt phrasing than Qwen for the prompt-based
  tool protocol. Imperative phrasing ("You MUST output a TOOL: line") works;
  vague phrasing sometimes returns a status JSON. A native function-calling
  API integration would be more robust (out of scope for this release).
- `CREATE_SESSION` still broadcasts `SESSION_LOADED` to ALL clients (not just
  the requester), so concurrent session creation can race. PROMPT isolation is
  fixed; CREATE_SESSION scoping is a follow-up.

---

## [1.1.0] — 2026-08-10

### 🐛 Fixed
- **Auto-continue recovery leaked the provider's ack text as a ghost assistant
  message** (`server.js`). The internal "continue the truncated code" follow-up
  prompt broadcast its response via `STREAM_TOKEN`, which the client rendered as
  a visible turn — most visibly as a junk `"Ready."` message between real turns.
  The continue-callback now no-ops on the stream (the continuation is an
  internal merge, never a user-visible turn).

- **Auto-continue only ran for Qwen, never ChatGPT** (`server.js`). The gate
  was hard-coded `provider === 'qwen'`, so truncated ChatGPT responses stayed
  broken with no recovery attempt. Gate is now provider-agnostic — any provider
  that returns `missing-closing-html` / `missing-closing-tags` triggers the
  silent continue-merge.

- **ChatGPT mixed prose into the code block** (`server.js`). The model emitted
  its code, then continued writing commentary ("Key Design Features
  Implemented:…", "How to use:…"), then a stray `</html>`, leaving the document
  without `</body>`. Two mitigations:
  1. Strengthened the `[VIBE CODING MODE]` `CODE_GUARD` to explicitly forbid
     prose / explanations / commentary and require the file to end with
     `</body></html>`.
  2. Added prose-leak truncation in `extractGeneratedCode` (block 3d): if
     `</html>` appears, everything after the FIRST occurrence is discarded, so
     trailing commentary cannot corrupt the document.


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
