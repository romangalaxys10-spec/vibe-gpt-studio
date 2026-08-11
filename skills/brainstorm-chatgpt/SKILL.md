---
name: brainstorm-chatgpt
description: Consult ChatGPT (chatgpt.com) as a brainstorming second opinion via the local vibe-gpt-studio backend. Use whenever the user asks for a ChatGPT perspective, wants to "ask ChatGPT", "consult ChatGPT", "get ChatGPT's take", or wants a brainstorming cross-check from a different model.
---

# Brainstorm with ChatGPT

Send a brainstorming prompt to **ChatGPT** (chatgpt.com, via the local vibe-gpt-studio backend at :3099) and return its full response. Use this when the user wants a ChatGPT perspective or a second-model cross-check on a question, design, or plan.

## When to use

The user says things like:
- "ask chatgpt …" / "consult chatgpt …" / "what does chatgpt think about …"
- "get chatgpt's take on …"
- "brainstorm this with chatgpt"
- "second opinion from chatgpt" / "second opinion from gpt"

## How to use

Run the backend `/api/ask` endpoint with `provider: "chatgpt"` and `mode: "brainstorm"`. The endpoint is synchronous — it returns the full response when ready (typically 30–60s).

```bash
# Pass the user's question as JSON. Use a temp file to avoid shell-escaping issues.
cat > /tmp/_ask_chatgpt.json <<'JSON'
{
  "provider": "chatgpt",
  "mode": "brainstorm",
  "prompt": "REPLACE_WITH_THE_USER_QUESTION"
}
JSON

curl -s -X POST http://localhost:3099/api/ask \
  -H 'Content-Type: application/json' \
  -d @/tmp/_ask_chatgpt.json \
  --max-time 180
```

The response is JSON:
- `{"ok": true, "response": "<chatgpt's answer>", "sessionId": "ask_..."}` → success. Quote/summarize `response`.
- `{"ok": false, "error": "..."}` → failure. Surface the error to the user verbatim.

## Critical rules

1. **Escape the prompt safely.** Always write the JSON body to a temp file (`/tmp/_ask_chatgpt.json`) and pass it with `-d @file`. Never inline the prompt in the curl command — quotes and newlines will break it.
2. **Use a long timeout.** ChatGPT takes 30–60s per turn. Always pass `--max-time 180` (3 minutes) to curl.
3. **Backend must be running.** If you get a connection refused, tell the user to start it:
   ```bash
   cd ~/vibe-gpt-studio && setsid node server.js > /tmp/vibe-backend.log 2>&1 < /dev/null &
   ```
4. **Watch for junk acks.** ChatGPT via web automation sometimes returns short non-answers (`CHATGPT_OK`, `{"status":"ready"}`). The endpoint detects and rejects these — if you get `ok: false` with a junk-ack message, retry once or rephrase the question.
5. **Sanitize the prompt.** Strip any user PII / secrets before sending — the prompt goes to a third-party web service.
6. **Report honestly.** If ChatGPT fails, tell the user — do not fabricate a ChatGPT answer.

## Example session

User: *"ask chatgpt whether I should use Postgres or MongoDB for a multi-tenant SaaS"*

You:
1. Write the prompt to `/tmp/_ask_chatgpt.json`
2. Run the curl
3. If `ok: true`, present ChatGPT's response clearly attributed:
   > **ChatGPT's take:** [summarize or quote the response]
4. Optionally add your own commentary after.
