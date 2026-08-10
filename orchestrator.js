// orchestrator.js — multi-file project generator.
//
// The orchestrator (local qwen2.5-coder:7b via Ollama) does three jobs:
//   1. PLAN: parse user intent -> file tree (paths + purposes)
//   2. DELEGATE: for each file, build a per-file prompt and send to a
//      generation worker (ChatGPT or Qwen via web automation, OR the local
//      model itself for speed when the user chooses)
//   3. ASSEMBLE: collect all per-file responses, extract via multifile_extractor,
//      write to disk under the project root.
//
// Why this design works where single-file vibe-code can't:
//   - The orchestrator holds the full file tree in context and can plan
//     cross-file consistency (shared function signatures, imports).
//   - Each worker call is a focused single-file generation, which is what the
//     big models are good at — no need for them to understand project structure.
//   - State (plan, progress) is reported via onProgress callbacks so the UI
//     can show the file tree building live.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ollama, DEFAULT_PLANNER_MODEL, DEFAULT_GENERATOR_MODEL } from './ollama_service.js';
import { extractFiles, safeJoinPath, buildFileTree } from './multifile_extractor.js';

// Role-based model selection (settable via env for experimentation):
//   - PLANNER: small/fast (default 1.5b, ~58 tok/s) — planning is lightweight JSON
//   - GENERATOR: larger/better (default 7b) — code quality matters; 1.5b hallucinates deps
const PLANNER_MODEL = process.env.OLLAMA_PLANNER_MODEL || DEFAULT_PLANNER_MODEL;
const GENERATOR_MODEL = process.env.OLLAMA_GENERATOR_MODEL || DEFAULT_GENERATOR_MODEL;

const PROJECTS_ROOT = path.join(os.homedir(), '.vibe-gpt-studio', 'projects');

function ensureProjectsRoot() {
  if (!fs.existsSync(PROJECTS_ROOT)) fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

export class Orchestrator {
  constructor({ workerModel = 'local', sessionId, onProgress, draftModel = false } = {}) {
    // workerModel: 'local' = use ollama for everything (fast, free, offline)
    //              'chatgpt' / 'qwen' = use web automation for per-file gen
    // draftModel: when true, generation requests speculative decoding (draft model
    //             alongside the target). Whether it actually engages depends on the
    //             backend — ollama silently ignores draft_model on most setups, so
    //             this is a no-op there; a llamacpp backend would honor it.
    this.workerModel = workerModel;
    this.draftModel = draftModel;
    this.sessionId = sessionId || `proj_${Date.now()}`;
    this.projectRoot = path.join(PROJECTS_ROOT, this.sessionId);
    this.onProgress = onProgress || (() => {});
  }

  // Step 1: PLAN — ask the local orchestrator to design the file tree.
  async plan(userPrompt) {
    this.onProgress({ phase: 'planning', message: 'Designing file tree...' });
    const planPrompt = `You are a software architect. The user wants to build:
"""
${userPrompt}
"""

Design the MINIMAL file set needed. Output ONLY a JSON object (no markdown fences, no prose):
{
  "name": "<short project name>",
  "description": "<one-line description>",
  "entryPoint": "<relative path of the main file to preview/run, e.g. index.php or index.html>",
  "files": [
    { "path": "<relative/path>", "purpose": "<one-line purpose>" }
  ]
}

Rules:
- Use realistic project structure (e.g. app/Controllers, public/, src/, etc.).
- Include ALL files needed to make it work — no placeholders like "...".
- For PHP: include the entry-point php file + any includes.
- For static sites: index.html + css + js as needed.
- Keep it minimal: 3-8 files typically. Avoid over-engineering.`;

    const result = await ollama.generate(planPrompt, {
      model: PLANNER_MODEL,   // fast/small (1.5b) — planning is lightweight structured JSON
      temperature: 0.2,
      num_predict: 800,
      format: 'json', // forces valid JSON
    });

    let plan;
    try {
      plan = JSON.parse(result.text);
    } catch (e) {
      // Some models wrap JSON in fences despite format:json — extract
      const m = result.text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error(`Orchestrator plan did not produce valid JSON: ${result.text.slice(0, 200)}`);
      plan = JSON.parse(m[0]);
    }
    if (!plan.files || !Array.isArray(plan.files) || plan.files.length === 0) {
      throw new Error(`Orchestrator plan has no files: ${JSON.stringify(plan).slice(0, 200)}`);
    }
    this.plan = plan;
    this.onProgress({ phase: 'planned', plan, message: `Planned ${plan.files.length} files` });
    return plan;
  }

  // Step 2: DELEGATE — generate each file. Returns { files, errors }.
  async generateAll(workerSendFn) {
    if (!this.plan) throw new Error('must call plan() first');
    ensureProjectsRoot();
    if (!fs.existsSync(this.projectRoot)) fs.mkdirSync(this.projectRoot, { recursive: true });

    const generated = [];
    const errors = [];
    const plan = this.plan;

    for (let i = 0; i < plan.files.length; i++) {
      const f = plan.files[i];
      this.onProgress({
        phase: 'generating',
        file: f.path,
        index: i + 1,
        total: plan.files.length,
        message: `Generating ${f.path} (${i + 1}/${plan.files.length})...`,
      });

      const prompt = this._buildFilePrompt(f, plan);
      let responseText;
      try {
        // workerSendFn is an injected dependency so this module doesn't hard-couple
        // to chatgpt_service/qwen_service. Signature: async (prompt, opts) => text
        if (workerSendFn) {
          responseText = await workerSendFn(prompt, { file: f, plan });
        } else {
          // default: local generator (7b — better code quality; 1.5b hallucinates deps)
          // When draftModel is toggled on, pass draft_model + draft_num_predict so a
          // spec-decoding-capable backend can engage it. (Ollama currently ignores
          // these fields for non-MLX backends — see CHANGELOG — but the option is
          // threaded through so a future llamacpp_service backend honors it.)
          const genOpts = { model: GENERATOR_MODEL, temperature: 0.2, num_predict: 1500 };
          if (this.draftModel) {
            genOpts.draft_model = PLANNER_MODEL; // small/fast draft
            genOpts.draft_num_predict = 6;
          }
          const r = await ollama.generate(prompt, genOpts);
          responseText = r.text;
        }
      } catch (e) {
        errors.push({ path: f.path, error: `worker failed: ${e.message}` });
        continue;
      }

      // Extract the file content from the response (path-tagged fence)
      const { files: extracted, errors: extErrs } = extractFiles(responseText);
      if (extracted.length === 1) {
        generated.push({ ...extracted[0], purpose: f.purpose });
      } else if (extracted.length > 1) {
        // worker emitted multiple — take the one matching the requested path
        const match = extracted.find(x => x.path === f.path) || extracted[0];
        generated.push({ ...match, purpose: f.purpose });
      } else {
        // No fenced path-tagged block. Maybe the worker emitted bare code.
        // Fallback: treat the whole response as the file content.
        const stripped = responseText.trim();
        if (stripped.length > 0 && !stripped.startsWith('Error')) {
          generated.push({ path: f.path, content: stripped + '\n', language: f.purpose, purpose: f.purpose });
        } else {
          errors.push({ path: f.path, error: 'worker produced no usable content', raw: stripped.slice(0, 100) });
        }
      }
      this.onProgress({ phase: 'file-done', file: f.path, index: i + 1, total: plan.files.length });
    }

    this.onProgress({ phase: 'assembling', message: 'Writing files to disk...' });

    // Step 3: ASSEMBLE — write all files to disk under projectRoot
    const written = [];
    for (const f of generated) {
      const absPath = safeJoinPath(this.projectRoot, f.path);
      if (!absPath) {
        errors.push({ path: f.path, error: 'unsafe path (traversal/absolute rejected)' });
        continue;
      }
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, f.content, 'utf8');
      written.push({ path: f.path, absPath, bytes: f.content.length });
    }

    const tree = buildFileTree(generated);
    const result = {
      sessionId: this.sessionId,
      projectRoot: this.projectRoot,
      plan,
      files: written,
      tree,
      errors,
      entryPoint: plan.entryPoint,
    };
    this.onProgress({ phase: 'complete', result, message: `Done. ${written.length} files written.` });
    return result;
  }

  // Build the per-file prompt for a worker.
  _buildFilePrompt(file, plan) {
    const otherPaths = plan.files.filter(f => f.path !== file.path).map(f => `- ${f.path}: ${f.purpose}`).join('\n');
    const ext = path.extname(file.path).toLowerCase().replace('.', '');
    const langHint = ext || 'text';
    return `You are generating ONE file in a larger project.

PROJECT: ${plan.name} — ${plan.description}
PROJECT FILE TREE (for context — match signatures/imports across files):
${otherPaths}

GENERATE THIS FILE: ${file.path}
PURPOSE: ${file.purpose}

Output ONLY this file's contents inside a fenced block tagged with the path:
\`\`\`${langHint} path=${file.path}
<the file contents here>
\`\`\`

Rules:
- Output ONLY the tagged code block, no prose before or after.
- Make the file complete and production-ready.
- Match the signatures/names referenced by other files in the tree.`;
  }
}

export { PROJECTS_ROOT };
