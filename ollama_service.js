// ollama_service.js — local LLM provider via Ollama HTTP API.
//
// Why this exists: ChatGPT/Qwen via web automation is slow (30-100s/turn) and
// flaky for structured tool calls (CHATGPT_OK, noop, {status:ready}). A local
// coder model (qwen2.5-coder:7b) is faster, free, offline, and more reliable
// for structured output because we control the API directly.
//
// Used as the ORCHESTRATOR in project mode: it plans file trees and decomposes
// per-file sub-prompts, which then go to ChatGPT/Qwen as generation workers.
//
// API: simple HTTP to http://localhost:11434/api/generate (no streaming for the
// orchestrator — it needs the full response before parsing).
//
// Uses Node's built-in fetch (Node 18+) — no external HTTP dependency.

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

// Two-role model defaults, chosen by head-to-head benchmark:
//   - PLANNER: qwen2.5-coder:1.5b — 58 tok/s, valid JSON plans, 986MB RAM
//   - GENERATOR: qwen2.5-coder:7b — proper PHP (htmlspecialchars + filter_var),
//     no hallucinated deps; 17 tok/s but quality matters for code
const DEFAULT_PLANNER_MODEL = process.env.OLLAMA_PLANNER_MODEL || 'qwen2.5-coder:1.5b';
const DEFAULT_GENERATOR_MODEL = process.env.OLLAMA_GENERATOR_MODEL || 'qwen2.5-coder:7b';

class OllamaService {
  // model is the default role for generate()/generateStream(). Override per-call
  // by passing { model } in options.
  constructor(model = DEFAULT_PLANNER_MODEL) {
    this.model = model;
  }

  async isAvailable() {
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { timeout: 3000 });
      return r.ok;
    } catch { return false; }
  }

  async listModels() {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const d = await r.json();
    return (d.models || []).map(m => ({ name: m.name, size: m.size }));
  }

  // Generate a completion (non-streaming). Returns the full response text.
  // Options: { temperature, num_predict, system, format (json|text), stop,
  //            model (override the default model for this call),
  //            draft_model, draft_num_predict (speculative decoding —
  //            ollama accepts these but only engages spec decoding on MLX/Apple) }
  async generate(prompt, options = {}) {
    const body = {
      model: options.model || this.model,
      prompt,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.num_predict ?? 1024,
        stop: options.stop,
      },
    };
    if (options.system) body.system = options.system;
    if (options.format) body.format = options.format; // 'json' forces valid JSON
    // Speculative-decoding fields (top-level in ollama's API, not under options).
    // Silently ignored by non-MLX ollama backends — safe to always include.
    if (options.draft_model) body.draft_model = options.draft_model;
    if (options.draft_num_predict) body.draft_num_predict = options.draft_num_predict;

    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`Ollama generate failed (${r.status}): ${txt.slice(0, 200)}`);
    }
    const d = await r.json();
    return {
      text: d.response || '',
      model: d.model,
      tokensGenerated: d.eval_count,
      durationSec: (d.total_duration || 0) / 1e9,
      tokensPerSec: d.eval_count ? d.eval_count / ((d.eval_duration || 1) / 1e9) : 0,
    };
  }

  // Streaming generate — calls onToken(token) as tokens arrive. Returns final text.
  async generateStream(prompt, options, onToken) {
    const body = {
      model: this.model,
      prompt,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.3,
        num_predict: options.num_predict ?? 1024,
      },
    };
    if (options.system) body.system = options.system;

    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Ollama stream failed (${r.status})`);

    let full = '';
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.response) {
            full += d.response;
            if (onToken) onToken(d.response, full);
          }
          if (d.done) return full;
        } catch {}
      }
    }
    return full;
  }
}

export const ollama = new OllamaService();
export { OllamaService, DEFAULT_PLANNER_MODEL, DEFAULT_GENERATOR_MODEL };
