# Vibe GPT Studio 🎨🤖

> **v1.1.0** — fixes a truncated-HTML false-positive in the integrity verifier
> and a Qwen composer-selector collision. See [CHANGELOG.md](./CHANGELOG.md).

**Vibe-code in a visual chat IDE** — powered by your **own web-based ChatGPT and Qwen accounts** (no API keys, no billing, no limits). A desktop Electron app + browser app that talks to chatgpt.com and chat.qwen.ai through headless automation and streams the answers into a code-editing workspace.

---

## ✨ What it does

| Feature | Details |
|---|---|
| 🧑💻 **Visual chat IDE** | Chat with an AI while it writes code — prompts stream in, code edits land in a workspace |
| 🔀 **Two providers** | Switch between **ChatGPT** (chatgpt.com) and **Qwen** (chat.qwen.ai) — same UI, either brain |
| 🔐 **Zero API keys** | Uses your live Firefox login. No tokens, no API billing, no account sharing |
| 🕵️ **Headless automation** | Playwright drives the real web UIs — no scraping, no unofficial endpoints |
| 🗂 **Session manager** | Multiple named sessions, persisted to `~/.vibe-gpt-studio/sessions/` |
| 🖥 **Electron + web** | Runs as a desktop app or in a normal browser tab |
| ⚙️ **Agentic tools** | Sub-agent orchestration, app-focus engine, terminal output stream |

---

## 🏗 Architecture

```
vibe-gpt-studio/
├── server.js                  # Express + WebSocket backend (port 3099)
├── session_manager.js         # session persistence (JSON in ~/.vibe-gpt-studio/)
├── subagent_orchestrator.js   # multi-agent task decomposition
├── agentic_tools.js           # tool definitions for the agent
├── chatgpt_service.js         # 🔵 ChatGPT automation (cookie injection + humanized typing)
├── qwen_service.js            # 🟣 Qwen automation (profile-copy + localStorage login)
├── electron_main.js           # Electron shell
├── client/                    # React + Vite frontend (port 5173)
└── automation/
    └── chatgpt-firefox-automation/   # 📦 merged automation project (git submodule → GitHub)
```

### The two automation strategies (hard-won, do not regress)

**ChatGPT** (`chatgpt_service.js`)
- Extracts the 30+ session cookies from the Firefox profile, injects them into Playwright.
- Types with a humanized delay, submits via the composer, waits for `div[data-message-author-role="assistant"]` to finish streaming.

**Qwen** (`qwen_service.js`)
- ⚠️ Cookie injection alone **does not work** for chat.qwen.ai — the session token lives in **localStorage** (the `token` cookie is `httpOnly`, so the SPA cannot read it via `document.cookie`).
- Fix: launch Playwright Firefox with **`launchPersistentContext` on a copy of the live Firefox profile** (`cookies.sqlite` + `storage/` + `webappsstore.sqlite` + `prefs.js`) — this carries cookies **and** localStorage, so the login survives.
- Responses are extracted from `.qwen-chat-message-assistant` with stability polling (stream-aware).

Both providers share: request queueing, humanized rate limiting (5–9s jitter), session persistence, WebSocket streaming.

---

## 🚀 Run it

```bash
# 1. Install backend deps
npm install

# 2. Install + build the client
cd client && npm install && cd ..

# 3. Start the backend (needed by both web and Electron)
npm start            # http://localhost:3099

# 4a. Web app (dev)
cd client && npm run dev     # http://localhost:5173

# 4b. Desktop app
npm run electron
```

### Prerequisites
- **Firefox** with an active login at **chatgpt.com** and **chat.qwen.ai** (snap install auto-detected)
- Playwright browsers: `npx playwright install firefox`
- Node.js 18+

### Pick a provider in the UI
In the agentic chat, select **ChatGPT** or **Qwen** as the provider before sending. The backend dispatches to the matching controller (`server.js` → `provider === 'qwen' ? qwen : chatgpt`).

---

## 🧪 Quick smoke tests

```bash
node -e "import('./chatgpt_service.js').then(m => new m.ChatGPTAutomationController().sendPrompt('Say OK', false).then(r => { console.log(r); process.exit(0); }))"
node -e "import('./qwen_service.js').then(m => new m.QwenAutomationController().sendPrompt('Say OK', false).then(r => { console.log(r); process.exit(0); }))"
```

---

## 🔒 Security

- No API keys, no telemetry. All traffic goes directly to chatgpt.com / chat.qwen.ai from your machine.
- Firefox session data is read locally; the Qwen profile copy lives in a temp dir and is deleted on close.
- Session chat history is stored locally only (`~/.vibe-gpt-studio/sessions/`).
- See `automation/chatgpt-firefox-automation/SECURITY.md` for the automation core's policy.

## 📦 Merged automation project

The browser-automation core is merged as a git submodule at `automation/chatgpt-firefox-automation/`, sourced from [github.com/romangalaxys10-spec/chatgpt-firefox-automation](https://github.com/romangalaxys10-spec/chatgpt-firefox-automation) (Python + Playwright skill with CLI, tests, CI/CD). The JS services in this repo are the app-native implementations of the same automation; the submodule provides the standalone CLI / skill and keeps them in sync.

## 📄 License

MIT © RyzenCode
