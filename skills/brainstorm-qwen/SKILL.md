---
name: brainstorm-qwen
description: Consult Qwen (chat.qwen.ai) as a brainstorming second opinion via the local vibe-gpt-studio backend. Use whenever the user asks for a Qwen perspective, wants to "ask Qwen", "consult Qwen", "get Qwen's take", or wants a brainstorming cross-check from a different model.
---

# Brainstorm with Qwen

Send a brainstorming prompt to **Qwen** (chat.qwen.ai, via the local vibe-gpt-studio backend at :3099) and return its full response. Use this when the user wants a Qwen perspective or a second-model cross-check on a question, design, or plan.

## When to use

The user says things like:
- "ask qwen …" / "consult qwen …" / "what does qwen think about …"
- "get qwen's take on …"
- "brainstorm this with qwen"
- "second opinion from qwen"

## How to use

Run the backend `/api/ask` endpoint with `provider: "qwen"` and `mode: "brainstorm"`. The endpoint is synchronous — it returns the full response when ready (typically 30–90s; Qwen is slow).

```bash
# Pass the user's question as JSON. Use a temp file to avoid shell-escaping issues.
cat > /tmp/_ask_qwen.json <<'JSON'
{
  "provider": "qwen",
  "mode": "brainstorm",
  "prompt": "REPLACE_WITH_THE_USER_QUESTION"
}
JSON

curl -s -X POST http://localhost:3099/api/ask \
  -H 'Content-Type: application/json' \
  -d @/tmp/_ask_qwen.json \
  --max-time 180
```

The response is JSON:
- `{"ok": true, "response": "<qwen's answer>", "sessionId": "ask_..."}` → success. Quote/summarize `response`.
- `{"ok": false, "error": "..."}` → failure. Surface the error to the user verbatim.

## Critical rules

1. **Escape the prompt safely.** Always write the JSON body to a temp file (`/tmp/_ask_qwen.json`) and pass it with `-d @file`. Never inline the prompt in the curl command — quotes and newlines will break it.
2. **Use a long timeout.** Qwen takes 30–90s per turn. Always pass `--max-time 180` (3 minutes) to curl.
3. **Backend must be running.** If you get a connection refused, tell the user to start it:
   ```bash
   cd ~/vibe-gpt-studio && setsid node server.js > /tmp/vibe-backend.log 2>&1 < /dev/null &
   ```
4. **Quota can block you.** If the response says "Qwen free-tier quota exhausted", that's a daily limit on the user's account — wait for reset or use `brainstorm-chatgpt` instead.
5. **Sanitize the prompt.** Strip any user PII / secrets before sending — the prompt goes to a third-party web service.
6. **Report honestly.** If Qwen returns a junk acknowledgement or empty response, tell the user it failed — do not fabricate a Qwen answer.

## Example session

User: *"ask qwen whether I should use Postgres or MongoDB for a multi-tenant SaaS"*

You:
1. Write the prompt to `/tmp/_ask_qwen.json`
2. Run the curl
3. If `ok: true`, present Qwen's response clearly attributed:
   > **Qwen's take:** [summarize or quote the response]
4. Optionally add your own commentary after.
