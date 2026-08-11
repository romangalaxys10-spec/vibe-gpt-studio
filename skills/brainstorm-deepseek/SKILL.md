---
name: brainstorm-deepseek
description: Consult DeepSeek (chat.deepseek.com) as a brainstorming second opinion via the local vibe-gpt-studio backend. Supports 3 modes — instant (DeepSeek V3, fast), expert (DeepSeek R1 reasoning), vision (image upload). Use whenever the user asks to "ask DeepSeek", "consult DeepSeek", "get DeepSeek's take", "use R1", or wants a brainstorming cross-check from DeepSeek.
---

# Brainstorm with DeepSeek

Send a brainstorming prompt to **DeepSeek** (chat.deepseek.com, via the local vibe-gpt-studio backend at :3099) and return its full response. DeepSeek offers 3 modes you can route between:

| `mode` value | DeepSeek UI name | Model | Use when |
|---|---|---|---|
| `instant` | Default | DeepSeek V3 | Fast general answers (~30s) |
| `expert` | DeepThink | DeepSeek R1 | Hard reasoning, multi-step problems (60-180s, shows reasoning) |
| `vision` | Vision | V3 + image | When the user provides an image (image upload path) |

## When to use

The user says things like:
- "ask deepseek …" / "consult deepseek …" / "deepseek's take on …"
- "use r1" / "ask deepthink" / "use the reasoning model"
- "second opinion from deepseek"
- "what does deepseek think"

**Pick the mode from intent:** if the user says "reason"/"think hard"/"R1"/"DeepThink" → `expert`. If they attach an image → `vision`. Otherwise default to `instant`.

## How to use

Run the backend `/api/ask` endpoint with `provider: "deepseek"` and the chosen `mode`.

```bash
# Write the JSON body to a temp file (safe escaping for quotes/newlines).
cat > /tmp/_ask_deepseek.json <<'JSON'
{
  "provider": "deepseek",
  "mode": "instant",
  "prompt": "REPLACE_WITH_THE_USER_QUESTION"
}
JSON

curl -s -X POST http://localhost:3099/api/ask \
  -H 'Content-Type: application/json' \
  -d @/tmp/_ask_deepseek.json \
  --max-time 300
```

The response is JSON:
- `{"ok": true, "response": "<deepseek answer>", "sessionId": "ask_..."}` → success. Quote/summarize `response`.
- `{"ok": false, "error": "..."}` → failure. Surface the error verbatim.

## Critical rules

1. **Escape the prompt safely.** Always write the JSON body to a temp file and pass `-d @file`. Never inline the prompt — quotes and newlines will break it.
2. **Use long timeouts.** Instant mode: 60-120s. Expert/R1 mode: up to 300s (reasoning is slow). Always pass `--max-time 300` to curl.
3. **Backend must be running** on :3099. If connection refused:
   ```bash
   cd ~/vibe-gpt-studio && setsid node server.js > /tmp/vibe-backend.log 2>&1 < /dev/null &
   ```
4. **Login can lapse.** If the error mentions "session may be logged out" or "WAF token expired", the user must re-authenticate at chat.deepseek.com in Firefox, then retry.
5. **Sanitize the prompt.** Strip PII/secrets — the prompt goes to a third-party web service.
6. **Expert mode may show reasoning.** R1 sometimes emits a chain-of-thought prefix in the response. If the user asked for "just the answer", you may summarize past the reasoning. If they asked for "the reasoning", preserve it.
7. **Vision mode is wired but image-upload path is not yet CLI-complete.** If the user wants vision mode with an actual image, tell them it requires the desktop UI (not the skill CLI) for now.

## Example session

User: *"ask deepseek R1 to analyze the trade-offs of microservices vs monolith for a 5-person team"*

You:
1. Recognize "R1" → use `mode: "expert"`
2. Write the prompt to `/tmp/_ask_deepseek.json` with `mode: "expert"`
3. Run curl with `--max-time 300`
4. Present the response:
   > **DeepSeek R1's take:** [quote or summarize, preserving the key reasoning steps]
