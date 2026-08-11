import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { exec } from 'child_process';
import util from 'util';
import path from 'path';
import fs from 'fs';

const execPromise = util.promisify(exec);
import { ChatGPTAutomationController, extractChatGPTCookies } from './chatgpt_service.js';
import { QwenAutomationController, extractQwenCookies } from './qwen_service.js';
import { DeepSeekAutomationController } from './deepseek_service.js';
import { agenticTools } from './agentic_tools.js';
import { Orchestrator, PROJECTS_ROOT } from './orchestrator.js';
import { ollama } from './ollama_service.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const chatgpt = new ChatGPTAutomationController();
const qwen = new QwenAutomationController();
const deepseek = new DeepSeekAutomationController();

let activeSession = {
  headful: false,
  status: 'idle',
  history: [],
  artifacts: []
};

import { getAllSessions, getSessionById, saveSession, deleteSession } from './session_manager.js';

// Output Sanitizer Pipeline (Strips System Prompt Tokens & Leaks).
// Defined at module scope so BOTH the WS PROMPT handler and the /api/ask
// HTTP endpoint can use it.
function sanitizeOutput(text) {
  if (!text) return '';
  return text
    .replace(/^\[(VIBE CODING|AGENTIC ORCHESTRATOR) MODE[\s\S]*?\]\n?/gi, '')
    .replace(/CRITICAL INSTRUCTION:[\s\S]*?code blocks \([^\)]*\)\./gi, '')
    .replace(/SYSTEM NOTIFICATION:[\s\S]*?\n/gi, '')
    .replace(/You are Vibe GPT Studio Agent[\s\S]*?USER TASK:\n/gi, '')
    .trim();
}

let activeSessionId = null;

// Ensure default session exists
let sessionsList = getAllSessions();
if (sessionsList.length === 0) {
  const defaultSession = {
    id: `session_${Date.now()}`,
    title: 'Vibe Coding Workspace',
    mode: 'vibe_code',
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: []
  };
  saveSession(defaultSession);
  activeSessionId = defaultSession.id;
} else {
  activeSessionId = sessionsList[0].id;
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('[Server] Client connected to WebSocket');

  // Send initial session list and active session state
  ws.send(JSON.stringify({
    type: 'INIT_SESSIONS',
    sessions: getAllSessions(),
    activeSessionId
  }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'SELECT_SESSION') {
        activeSessionId = msg.sessionId;
        const currentSession = getSessionById(activeSessionId);
        broadcast({ type: 'SESSION_LOADED', session: currentSession });
      }

      if (msg.type === 'CREATE_SESSION') {
        const newSession = {
          id: `session_${Date.now()}`,
          title: msg.title || `Vibe Workspace ${new Date().toLocaleTimeString()}`,
          mode: msg.mode || 'vibe_code',
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: []
        };
        saveSession(newSession);
        activeSessionId = newSession.id;
        broadcast({ type: 'SESSIONS_UPDATED', sessions: getAllSessions(), activeSessionId: newSession.id });
        broadcast({ type: 'SESSION_LOADED', session: newSession });
      }

      if (msg.type === 'UPDATE_SESSION') {
        const s = getSessionById(msg.sessionId);
        if (s) {
          if (msg.title !== undefined) s.title = msg.title;
          if (msg.archived !== undefined) s.archived = msg.archived;
          if (msg.mode !== undefined) s.mode = msg.mode;
          saveSession(s);
          broadcast({ type: 'SESSIONS_UPDATED', sessions: getAllSessions(), activeSessionId });
        }
      }

      if (msg.type === 'DELETE_SESSION') {
        deleteSession(msg.sessionId);
        const list = getAllSessions();
        if (list.length > 0) activeSessionId = list[0].id;
        broadcast({ type: 'SESSIONS_UPDATED', sessions: list, activeSessionId });
      }

      if (msg.type === 'PROMPT') {
        const { prompt, mode } = msg;
        // CONCURRENCY FIX: snapshot the originating session id ONCE at entry and
        // use this const throughout the async closure. Previously this handler read
        // the module-level `activeSessionId` global again at response-save time
        // (after a long `await sendPrompt`), so a concurrent CREATE/SELECT/DELETE
        // from another client could re-point the global and the response landed in
        // the WRONG session (cross-session message bleed). Prefer an explicit
        // msg.sessionId from the client; fall back to the global only for legacy
        // callers. Never mutate the global from inside this handler.
        const originSessionId = msg.sessionId || activeSessionId;
        let s = getSessionById(originSessionId);
        if (!s) {
          s = {
            id: `session_${Date.now()}`,
            title: prompt.substring(0, 30),
            mode,
            archived: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: []
          };
          saveSession(s);
          // Do NOT mutate the global activeSessionId here — that is UI focus state
          // belonging to whichever tab is open, not to this async request.
        }

        const userMsg = {
          id: Date.now().toString(),
          sender: 'user',
          text: prompt,
          mode,
          timestamp: new Date().toLocaleTimeString()
        };

        s.messages.push(userMsg);
        // Auto update title if still default
        if (s.title.startsWith('Vibe Workspace') || s.messages.length === 1) {
          s.title = prompt.substring(0, 32);
        }
        saveSession(s);
        broadcast({ type: 'SESSIONS_UPDATED', sessions: getAllSessions(), activeSessionId });

        broadcast({ type: 'STATUS', status: 'thinking' });

        try {
          const CODE_GUARD = "\n\nCRITICAL INSTRUCTION: DO NOT GENERATE IMAGES, MOCKUPS, OR CALL DALL-E. YOU ARE A PURE CODE GENERATOR. Output ONLY valid, complete, production-ready source code enclosed inside standard markdown code blocks (```html, ```css, ```js, etc.). NO prose, NO explanations, NO commentary, NO 'Key features' lists, NO 'How to use' text — ONLY the code block, nothing before or after it. The file MUST end with </body></html>.";

          let fullPrompt = prompt;
          if (mode === 'vibe_code') {
            // Tools are available in vibe_code mode too, but CODE_GUARD stays dominant:
            // if the user asks for code, the model emits pure code; if the user asks
            // the model to DO something on the system, it may emit a TOOL: call instead.
            fullPrompt = `[VIBE CODING MODE - Pure Code Output Required]\n${prompt}${CODE_GUARD}\n\n${agenticTools.getToolDefinitions()}\nIf the user asks you to perform a desktop/terminal/file action (not generate code), respond with a single TOOL: invocation line. Otherwise, output pure code only.`;
          } else if (mode === 'agent') {
            let localSysInfo = '';
            try {
              const { stdout: ramOut } = await execPromise('free -h');
              const { stdout: cpuOut } = await execPromise('lscpu | grep "Model name\\|CPU(s):\\|Architecture"');
              const { stdout: osOut } = await execPromise('uname -a');
              const { stdout: appsOut } = await execPromise('which whatsie discord google-chrome google-chrome-stable firefox code gnome-terminal 2>/dev/null || snap list 2>/dev/null | grep -i "whatsie\\|discord\\|chrome"');
              localSysInfo = `\n[LOCAL UBUNTU SYSTEM HARDWARE & INSTALLED APPS]\nRAM/Memory:\n${ramOut.trim()}\n\nCPU Model & Cores:\n${cpuOut.trim()}\n\nOS Kernel:\n${osOut.trim()}\n\nINSTALLED DESKTOP APPS DETECTED:\n${appsOut.trim()}\n`;
            } catch (e) {}

            // Pre-execution of User Intent (Open App / Focus Window)
            const lowerUserPrompt = prompt.toLowerCase();
            let preExecResult = '';
            
            const targetApp = lowerUserPrompt.includes('discord') ? 'discord' :
                              lowerUserPrompt.includes('whatsie') || lowerUserPrompt.includes('whatsapp') ? 'whatsie' :
                              lowerUserPrompt.includes('chrome') ? 'chrome' :
                              lowerUserPrompt.includes('firefox') ? 'firefox' :
                              lowerUserPrompt.includes('code') || lowerUserPrompt.includes('vscode') ? 'code' : null;

            if (targetApp) {
              const res = await agenticTools.tools.open_application({ appName: targetApp });
              console.log(`[Pre-Turn Agentic Focus Engine] Executed open_application for ${targetApp}:`, res);
              broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🤖 [Pre-Executing App Focus Engine]:\n${res.message}\n` });
              preExecResult = `\n[SYSTEM NOTIFICATION]: The system engine has already executed focus/launch for "${targetApp}" on the user's desktop!\n`;
            }

            fullPrompt = `You are Vibe GPT Studio Agent.
You operate inside a local Ubuntu desktop environment.
You have access to LOCAL EXECUTION TOOLS provided by the host application.

YOUR ONLY JOB: when the user asks you to DO something on the system, respond with EXACTLY ONE tool invocation line in this exact format and NOTHING ELSE:

TOOL: <tool_name> <json_arguments>

Do NOT output JSON status objects like {"status":"ready"}.
Do NOT output prose, acknowledgements, or explanations.
Do NOT wrap tool calls in markdown fences.
The host executes the TOOL: line and returns the result — you do not need to confirm anything.

${localSysInfo}
${agenticTools.getToolDefinitions()}

${preExecResult}
USER TASK:
${prompt}`;
          } else {
            fullPrompt = `${prompt}${CODE_GUARD}`;
          }

          // Output Sanitizer Pipeline — uses the module-level sanitizeOutput()
          // (extracted from here so /api/ask can share it).

          const provider = msg.provider || 'chatgpt';
          console.log(`[Prompt Dispatcher] Executing prompt using provider: ${provider}`);

          const controller = provider === 'qwen' ? qwen : chatgpt;

          // Per-session headful flag (not the static global). Falls back to the
          // global default for sessions that never set one.
          const sessionHeadful = (s && typeof s.headful === 'boolean') ? s.headful : activeSession.headful;

          let responseText = await controller.sendPrompt(fullPrompt, sessionHeadful, (token, fullText) => {
            let cleanStream = sanitizeOutput(fullText);
            broadcast({ type: 'STREAM_TOKEN', token, text: cleanStream, sessionId: originSessionId });
          });

          // === RESPONSE INTEGRITY VERIFICATION ===
          const rawResponse = responseText; // Capture raw before sanitization

          // Sanitize final response text
          responseText = sanitizeOutput(responseText);

          // Empty-response guard: if the provider returned nothing usable, fail
          // loudly instead of silently saving a 0-byte junk assistant message.
          // This happens when the browser automation races (e.g. SPA not hydrated,
          // concurrent contexts overwhelming the provider) and read an empty DOM.
          if (!responseText || responseText.trim().length === 0) {
            const errMsg = `Provider ${provider} returned an empty response (raw bytes: ${rawResponse.length}). The automation may have raced with page hydration, or the conversation context was busy. Please retry.`;
            console.error('[VIBE] Empty provider response — aborting turn to avoid junk message:', errMsg);
            broadcast({ type: 'TERMINAL_OUTPUT', output: `\n⚠️ ${errMsg}\n` });
            broadcast({
              type: 'PROMPT_COMPLETE',
              sessionId: originSessionId,
              response: `⚠️ ${errMsg}`,
              extractedCode: [],
              mode,
              verification: { provider, integrityOk: false, issues: ['EMPTY_PROVIDER_RESPONSE'], rawLength: rawResponse.length },
              sessions: getAllSessions()
            });
            broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
            return;
          }

          // Junk-ack guard: ChatGPT (when driven via web automation) sometimes
          // refuses to follow the tool-calling protocol and returns short ack
          // strings instead of a real answer or TOOL: line. Detect these so the
          // user sees a clear error + gets a retry, rather than a silent fake
          // "success" like "CHATGPT_OK".
          const JUNK_ACK_PATTERNS = [
            /^CHATGPT_OK$/i,
            /^CHATGPT[-_ ]?OK/i,
            /^{"status"\s*:\s*"(ready|ok|done|complete)"}$/i,
            /^\s*OK\s*$/i,
            /^\s*Done\.?\s*$/i,
            /^\s*Ready\.?\s*$/i,
            /^noop(\s*\{\s*\})?$/i,
          ];
          const trimmed = responseText.trim();
          const isJunkAck = trimmed.length <= 40
            && !/^TOOL:/.test(trimmed)
            && !/```/.test(trimmed)
            && !/<!doctype|<html|<body/i.test(trimmed)
            && JUNK_ACK_PATTERNS.some(re => re.test(trimmed));
          if (isJunkAck) {
            const errMsg = `Provider ${provider} returned a junk acknowledgement (${JSON.stringify(trimmed)}) instead of performing the requested action. This happens when the web-automation context confuses the model. Please retry, or rephrase with an explicit imperative (e.g. "You MUST output a TOOL: line").`;
            console.error('[VIBE] Junk ack response — aborting:', errMsg);
            broadcast({ type: 'TERMINAL_OUTPUT', output: `\n⚠️ ${errMsg}\n` });
            broadcast({
              type: 'PROMPT_COMPLETE',
              sessionId: originSessionId,
              response: `⚠️ ${errMsg}`,
              extractedCode: [],
              mode,
              verification: { provider, integrityOk: false, issues: ['JUNK_ACK_RESPONSE'], rawLength: rawResponse.length, junkText: trimmed },
              sessions: getAllSessions()
            });
            broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
            return;
          }

          // ============================================================
          // UNIFIED CODE EXTRACTION - HANDLES CHATGPT (fences) + QWEN (raw)
          // ============================================================
          function extractGeneratedCode(text) {
            if (!text) {
              return { code: "", source: "none", language: null, truncated: false, truncationReason: null };
            }

            let source = "raw";
            let language = null;
            let code = text;

            // 1. Markdown fenced code - ChatGPT / normal providers
            const fencedMatch = text.match(/```([a-zA-Z0-9_+-]*)\s*\n([\s\S]*?)```/);
            if (fencedMatch) {
              language = (fencedMatch[1] || "").toLowerCase() || null;
              code = fencedMatch[2];
              source = "markdown-fence";
            } else {
              // 2. Qwen raw response: language identifier + line numbers + HTML
              const languageMatch = text.match(/^\s*(html|css|js|jsx|ts|tsx|python|json|xml|svg)\s*(?:\r?\n|$)/i);
              if (languageMatch) {
                language = languageMatch[1].toLowerCase();
                code = text.slice(languageMatch[0].length);
                source = "qwen-raw";
              }

              // Find actual source start (DOCTYPE or <html>)
              const htmlStart = code.search(/<!doctype\s+html\b|<html(?:\s[^>]*)?>/i);
              if (htmlStart >= 0) {
                code = code.slice(htmlStart);
              }
            }

            // 3. Remove Qwen / UI line-number prefixes (handles "1 <!DOCTYPE" or standalone "1")
            code = code
              .split(/\r?\n/)
              .map(line => {
                line = line.replace(/^\s*\d+\s+(?=[<"'`])/, "");
                line = line.replace(/^\s*\d+\s*$/, "");
                return line;
              })
              .join("\n")
              .trim();

            // 3b. Strip ANY injected marker text FIRST (defensive) - a literal substring like
            // "</html>" inside a marker string must never fool the closing-tag checks.
            code = code
              .replace(/\[TRUNCATED[^\]]*\]/gi, '')
              .replace(/generation stopped[^\n]*/gi, '')
              .replace(/\[CONTINUE[^\]]*\]/gi, '')
              .trim();

            // 3c. Strip trailing UI artifacts that Qwen appends after the code
            // ("Preview", "Copy code", "Run in browser" buttons rendered as text)
            code = code
              .replace(/\s*Preview\s*$/i, '')
              .replace(/\s*Copy code\s*$/i, '')
              .replace(/\s*Run in browser\s*$/i, '')
              .replace(/\s*Build it\s*$/i, '')
              .trim();

            // 3d. Prose-leak truncation.
            // Some providers (notably ChatGPT) emit the code, then CONTINUE writing
            // prose ("Key Design Features Implemented:…", "How to use:…"), then a
            // stray </html>. Two patterns to handle:
            //   (a) prose AFTER </html>: keep only up to the FIRST </html>.
            //   (b) prose BETWEEN the last structural tag (</style>, </script>,
            //       </body>) and a trailing </html>: strip the prose block.
            const firstCloseHtml = code.search(/<\/html\s*>/i);
            if (firstCloseHtml >= 0) {
              // (a) cut everything after the first </html>
              code = code.slice(0, firstCloseHtml + '</html>'.length).trimEnd();
              // (b) if </body> is missing, look for prose between the last
              //     structural close tag and </html>, and strip it.
              if (!/<\/body\s*>/i.test(code)) {
                // Find the last structural tag before </html>
                const structuralMatch = code.match(/<\/(style|script|head|nav|footer|section|div|main|article|aside|p|ul|ol|table)[^>]*>\s*([\s\S]*?)<\/html>/i);
                if (structuralMatch) {
                  const between = structuralMatch[2].trim();
                  // Heuristic: if the text between contains prose markers (capitalized
                  // words, sentence punctuation, common explanation phrases) and no
                  // HTML tags, it's leaked commentary.
                  if (between.length > 0 && !/<[a-z!]/i.test(between) && /[A-Z][a-z]+ [a-z]+/i.test(between)) {
                    code = code.slice(0, code.lastIndexOf(structuralMatch[1] + '>') + structuralMatch[1].length + 1);
                    code = code.replace(/\s*<\/html>\s*$/i, '') + '\n</body>\n</html>';
                  }
                }
              }
            }

            // 4. Detect truncation - STRUCTURAL, not lexical.
            // A response is only complete when the closing tags are the LAST tokens,
            // not merely present somewhere in the text.
            const hasHtmlDocument = /<!doctype\s+html\b/i.test(code) || /<html(?:\s[^>]*)?>/i.test(code);
            const hasClosingHtml = /<\/html\s*>\s*$/i.test(code);
            const hasClosingBody = /<\/body\s*>\s*$/i.test(code) || /<\/body\s*>[\s\S]*<\/html\s*>/i.test(code);
            const hasClosingHead = /<\/head\s*>/i.test(code);
            const endsAbruptly = /(?:^|\s)(preview)\s*$/i.test(code);

            let truncated = false;
            let truncationReason = null;

            if (hasHtmlDocument && (!hasClosingHtml || !hasClosingBody)) {
              truncated = true;
              truncationReason = "missing-closing-tags";
            }
            if (endsAbruptly) {
              truncated = true;
              truncationReason = "response-ended-at-preview";
            }
            if (hasHtmlDocument && !hasClosingHtml && code.length < 5000 && !truncationReason) {
              truncated = true;
              truncationReason = "incomplete-html-document";
            }

            return { code, source, language, truncated, truncationReason };
          }

          // ============================================================
          // EXTRACTION MUST FINISH BEFORE VERIFICATION
          // ============================================================
          const extraction = extractGeneratedCode(responseText);
          const extractedCode = extraction.code ? [extraction.code] : [];

          // ============================================================
          // VERIFICATION - created AFTER extraction (integrity check)
          // ============================================================
          const verification = {
            provider,
            rawLength: rawResponse.length,
            sanitizedLength: responseText.length,
            cleanLength: responseText.length,
            extractedCodeCount: extractedCode.length,
            extractedCodeLength: extractedCode.length ? extractedCode[0].length : 0,
            extractionSource: extraction.source,
            detectedLanguage: extraction.language,
            hasHtml: /<html(?:\s[^>]*)?>/i.test(extractedCode[0] || ''),
            hasDoctype: /<!doctype\s+html\b/i.test(extractedCode[0] || ''),
            hasClosingHtml: /<\/html\s*>\s*$/i.test(extractedCode[0] || ''),
            hasClosingBody: /<\/body\s*>\s*$/i.test(extractedCode[0] || '') || /<\/body\s*>[\s\S]*<\/html\s*>/i.test(extractedCode[0] || ''),
            hasClosingHead: /<\/head\s*>/i.test(extractedCode[0] || ''),
            truncated: extraction.truncated,
            truncationReason: extraction.truncationReason,
            integrityOk: !extraction.truncated && extractedCode.length > 0,
            issues: []
          };

          if (extraction.truncated) {
            verification.issues.push(`TRUNCATED_RESPONSE: ${extraction.truncationReason}`);
            verification.integrityOk = false;
          }
          if (extractedCode.length === 0 && (responseText.includes('<html') || responseText.includes('<!DOCTYPE'))) {
            verification.issues.push('NO_CODE_EXTRACTED: HTML detected but no code blocks extracted');
            verification.integrityOk = false;
          }

          if (extraction.truncated) {
            console.warn("[VIBE] Generated response appears truncated:", {
              source: verification.extractionSource,
              reason: verification.truncationReason,
              length: verification.extractedCodeLength
            });

            // === AUTO-CONTINUE: ask the provider to complete the truncated code ===
            // Any provider (chatgpt OR qwen) can stop mid-generation; a short follow-up
            // "continue" prompt makes it resume and emit the missing tail (closing tags,
            // rest of the file). The continue-prompt response is an INTERNAL recovery
            // operation — it must NOT be streamed to the client (doing so would create a
            // ghost "Ready." / ack message visible as a fake assistant turn).
            if (verification.truncationReason === 'missing-closing-html' || verification.truncationReason === 'missing-closing-tags') {
              console.warn(`[VIBE] Requesting ${provider} to continue the truncated HTML...`);
              try {
                const continueResp = await controller.sendPrompt(
                  "[CONTINUE OUTPUT] You were generating an HTML file but stopped before the closing </html> tag. Continue EXACTLY where you left off and complete the entire rest of the file, ending with </html>. Output ONLY the remaining code, no explanations, no markdown fences.",
                  sessionHeadful,
                  // Deliberately NO STREAM_TOKEN broadcast here — the continuation is an
                  // internal merge, not a visible turn. Streaming it made the client render
                  // the provider's ack text ("Ready.", "Here is the rest…") as a junk message.
                  () => {}
                );
                const continueSanitized = sanitizeOutput(continueResp);
                const continueExtraction = extractGeneratedCode(continueSanitized);
                const continueCode = continueExtraction.code || '';
                if (continueCode && continueCode.trim().length > 0) {
                  // Merge: original partial + continuation, then rebuild the code block
                  const mergedRaw = (extractedCode[0] || '') + '\n' + continueCode;
                  const mergedExtraction = extractGeneratedCode(mergedRaw);
                  if (mergedExtraction.code && mergedExtraction.code.trim().length > 0) {
                    extractedCode[0] = mergedExtraction.code;
                    responseText = mergedExtraction.code;
                    verification.truncated = mergedExtraction.truncated;
                    verification.truncationReason = mergedExtraction.truncationReason;
                    verification.hasClosingHtml = /<\/html\s*>\s*$/i.test(extractedCode[0]);
                    verification.integrityOk = !mergedExtraction.truncated && extractedCode.length > 0;
                    verification.extractedCodeLength = extractedCode[0].length;
                    verification.issues = verification.issues.filter(i => !i.startsWith('TRUNCATED_RESPONSE'));
                    if (mergedExtraction.truncated) {
                      verification.issues.push('TRUNCATED_RESPONSE: still incomplete after auto-continue');
                    } else {
                      verification.issues.push('RECOVERED: auto-continue completed the HTML');
                    }
                    console.warn("[VIBE] Auto-continue merged. New length:", extractedCode[0].length, "| closing html:", verification.hasClosingHtml);
                  }
                }
              } catch (contErr) {
                console.error('[VIBE] Auto-continue failed:', contErr.message);
              }
            }
          }

          // Auto-execute any explicit agentic tools emitted by ChatGPT.
          // If the model emitted an UNKNOWN tool name (e.g. "noop"), retry ONCE
          // with a correction nudge before giving up — ChatGPT sometimes hedges.
          let toolResults = await agenticTools.parseAndExecuteTools(responseText);
          const hasUnknownTool = toolResults.some(r => r.error && r.error.includes('Unknown tool'));
          if (hasUnknownTool && provider === 'chatgpt') {
            console.warn('[VIBE] Model emitted unknown tool name — retrying with correction');
            try {
              const retryResp = await controller.sendPrompt(
                `Your previous response used an invalid tool name. You MUST use one of: exec_command, open_application, navigate_url, read_file, write_file, take_screenshot, click_mouse, type_keyboard. Re-emit your intended action as a single valid TOOL: line now.`,
                sessionHeadful,
                () => {}
              );
              const retryResults = await agenticTools.parseAndExecuteTools(sanitizeOutput(retryResp));
              if (retryResults.some(r => r.result && r.result.ok)) {
                toolResults = retryResults;
                responseText = sanitizeOutput(retryResp);
              }
            } catch (retryErr) {
              console.warn('[VIBE] Tool-retry failed:', retryErr.message);
            }
          }
          if (toolResults.length > 0) {
            broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🤖 [Agentic Tool Execution Results]:\n${JSON.stringify(toolResults, null, 2)}\n` });
          }

          // Universal Auto-Execution Engine for Terminal & Desktop Commands
          const commandBlockRegex = /```(?:bash|sh|shell|zsh)?\n?([\s\S]*?)```/gi;
          let blockMatch;
          let terminalResultsCombined = '';
          const executedCommands = new Set();

          while ((blockMatch = commandBlockRegex.exec(responseText)) !== null) {
            const rawCmd = blockMatch[1].trim();
            if (!rawCmd || rawCmd.startsWith('<') || rawCmd.startsWith('{') || rawCmd.includes('function ') || rawCmd.includes('import ') || rawCmd.includes('launch_preview.sh')) {
              continue;
            }

            if (executedCommands.has(rawCmd)) continue;
            executedCommands.add(rawCmd);

            const envPath = `${process.env.HOME}/.local/bin:/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH}`;
            const execOptions = { cwd: process.cwd(), env: { ...process.env, PATH: envPath } };

            console.log(`[Universal Auto-Exec Engine] Running Script Block:\n${rawCmd}`);
            broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🤖 [Auto-Executing Script Block]:\n$ ${rawCmd.substring(0, 100)}...\n` });
            
            const isSingleGuiApp = !rawCmd.includes('\n') && (rawCmd.endsWith('&') || rawCmd.includes('whatsie') || rawCmd.includes('discord') || rawCmd.includes('chrome') || rawCmd.includes('firefox') || rawCmd.includes('code') || rawCmd.includes('open '));
            
            if (isSingleGuiApp) {
              exec(rawCmd, execOptions);
              broadcast({ type: 'TERMINAL_OUTPUT', output: `[GUI Desktop App / Command Launched in Background]\n` });
              terminalResultsCombined += `\n\n💻 **[Terminal Output for \`${rawCmd}\`]**:\n\`\`\`\n[Desktop GUI Application Launched Successfully]\n\`\`\``;
            } else {
              try {
                const { stdout, stderr } = await execPromise(rawCmd, { ...execOptions, maxBuffer: 1024 * 1024 * 10 });
                const outText = stdout || stderr || 'Script executed cleanly.';
                broadcast({ type: 'TERMINAL_OUTPUT', output: `${outText}\n` });
                terminalResultsCombined += `\n\n💻 **[Terminal Output Result]**:\n\`\`\`\n${outText.trim()}\n\`\`\``;
              } catch (cmdErr) {
                const errText = cmdErr.stdout || cmdErr.stderr || cmdErr.message;
                broadcast({ type: 'TERMINAL_OUTPUT', output: `Error: ${errText}\n` });
                terminalResultsCombined += `\n\n⚠️ **[Terminal Result]**:\n\`\`\`\n${errText.trim()}\n\`\`\``;
              }
            }
          }

          // Fallback App & Command Intent Auto-Launcher
          const lowerPrompt = prompt.toLowerCase();
          if (mode === 'agent' && (lowerPrompt.includes('open ') || lowerPrompt.includes('launch ') || lowerPrompt.includes('run '))) {
            const targetApp = lowerPrompt.includes('discord') ? 'discord' :
                              lowerPrompt.includes('whatsie') || lowerPrompt.includes('whatsapp') ? 'whatsie' :
                              lowerPrompt.includes('chrome') ? 'google-chrome-stable' :
                              lowerPrompt.includes('firefox') ? 'firefox' :
                              lowerPrompt.includes('code') || lowerPrompt.includes('vscode') ? 'code' : null;

            if (targetApp && !Array.from(executedCommands).some(c => c.includes(targetApp))) {
              const fallbackCmd = `${targetApp} & || snap run ${targetApp} &`;
              console.log(`[Intent Auto-Launcher] Triggering fallback launch: ${fallbackCmd}`);
              broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🤖 [Intent Auto-Launcher Triggered]:\n$ ${fallbackCmd}\n` });
              const envPath = `${process.env.HOME}/.local/bin:/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH}`;
              exec(fallbackCmd, { cwd: process.cwd(), env: { ...process.env, PATH: envPath } });
              terminalResultsCombined += `\n\n💻 **[Intent Auto-Launcher Result for \`${targetApp}\`]**:\n\`\`\`\n[Desktop GUI Application Launched Successfully]\n\`\`\``;
            }
          }

          if (terminalResultsCombined) {
            responseText += terminalResultsCombined;
          }

          const botMsg = {
            id: Date.now().toString(),
            sender: 'chatgpt',
            text: responseText,
            mode,
            timestamp: new Date().toLocaleTimeString(),
            extractedCode,
            verification
          };

          const activeS = getSessionById(originSessionId);
          if (activeS) {
            activeS.messages.push(botMsg);
            saveSession(activeS);
          }

          broadcast({
            type: 'PROMPT_COMPLETE',
            sessionId: originSessionId,
            response: responseText,
            extractedCode,
            mode,
            verification,
            sessions: getAllSessions()
          });
          broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
        } catch (err) {
          console.error('[Server Error]', err);
          broadcast({ type: 'ERROR', error: err.message });
          broadcast({ type: 'STATUS', status: 'idle' });
        }
      }

      if (msg.type === 'EXEC_COMMAND') {
        const { command, cwd } = msg;
        console.log(`[Terminal Exec] Running: ${command} in ${cwd || process.cwd()}`);
        broadcast({ type: 'TERMINAL_OUTPUT', output: `$ ${command}\n` });

        exec(command, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
          if (stdout) broadcast({ type: 'TERMINAL_OUTPUT', output: stdout });
          if (stderr) broadcast({ type: 'TERMINAL_OUTPUT', output: stderr });
          if (error) {
            broadcast({ type: 'TERMINAL_OUTPUT', output: `Process exited with code ${error.code}\n` });
          } else {
            broadcast({ type: 'TERMINAL_OUTPUT', output: `\n[Command Completed Successfully]\n` });
          }
        });
      }

      // === PROJECT MODE: multi-file generation via local orchestrator + workers ===
      // Distinct from single-file vibe_code. The local qwen2.5-coder:7b orchestrator
      // plans the file tree, then per-file prompts go to either the local model
      // (fast, free) or ChatGPT/Qwen via web automation (when workerProvider set).
      if (msg.type === 'BUILD_PROJECT') {
        const { prompt, workerProvider = 'local', draftModel = false } = msg;
        const originSessionId = msg.sessionId || activeSessionId;
        broadcast({ type: 'STATUS', status: 'thinking', sessionId: originSessionId });
        broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🏗️ [Project Mode] Starting multi-file build: ${prompt.slice(0, 80)}...\n` });
        if (draftModel) {
          broadcast({ type: 'TERMINAL_OUTPUT', output: `   ⚡ Draft model (speculative decoding) requested for generation. Note: spec decoding requires a CPU llama-server path; on this GPU-only ollama setup it may fall back to standard generation.\n` });
        }

        (async () => {
          try {
            // Check ollama is up first (the orchestrator depends on it)
            const ok = await ollama.isAvailable().catch(() => false);
            if (!ok) {
              throw new Error('Ollama is not running at http://localhost:11434. Start it with `ollama serve`. The local orchestrator model (qwen2.5-coder:7b) is required for project mode.');
            }

            const sessionId = `proj_${Date.now()}`;
            const orch = new Orchestrator({
              workerModel: workerProvider,
              sessionId,
              draftModel,   // when true, generation passes draft_model option (spec decoding)
              onProgress: (p) => {
                // Stream progress to the client + terminal
                broadcast({ type: 'PROJECT_PROGRESS', sessionId: originSessionId, progress: p });
                if (p.message) {
                  broadcast({ type: 'TERMINAL_OUTPUT', output: `   ${p.message}\n` });
                }
                if (p.phase === 'planned' && p.plan) {
                  broadcast({ type: 'TERMINAL_OUTPUT', output: `   📁 Planned ${p.plan.files.length} files:\n${p.plan.files.map(f => `      • ${f.path} — ${f.purpose}`).join('\n')}\n` });
                }
              },
            });

            // Build the worker dispatch function based on workerProvider
            let workerFn = null;
            if (workerProvider === 'chatgpt' || workerProvider === 'qwen') {
              const controller = workerProvider === 'qwen' ? qwen : chatgpt;
              const sessionHeadful = false;
              workerFn = async (filePrompt) => {
                const resp = await controller.sendPrompt(filePrompt, sessionHeadful, () => {});
                return resp;
              };
              broadcast({ type: 'TERMINAL_OUTPUT', output: `   🔌 Using ${workerProvider} (web automation) as per-file worker — each file may take 30-100s.\n` });
            } else {
              broadcast({ type: 'TERMINAL_OUTPUT', output: `   ⚡ Using local qwen2.5-coder:7b for both planning + per-file generation (fastest).\n` });
            }

            const plan = await orch.plan(prompt);
            const result = await orch.generateAll(workerFn);

            // Save the result into the session as a special botMsg
            const s = getSessionById(originSessionId);
            const botMsg = {
              id: Date.now().toString(),
              sender: 'chatgpt',
              text: `🏗️ Built project "${plan.name}" — ${result.files.length} files\n\n${result.files.map(f => `• ${f.path} (${f.bytes}b)`).join('\n')}${result.errors.length ? `\n\n⚠️ ${result.errors.length} errors: ${result.errors.map(e => e.path).join(', ')}` : ''}`,
              mode: 'project',
              timestamp: new Date().toLocaleTimeString(),
              projectResult: result,
            };
            if (s) {
              if (s.title.startsWith('Vibe Workspace') || s.messages.length === 0) {
                s.title = prompt.substring(0, 32);
              }
              s.messages.push(botMsg);
              s.projectSessionId = sessionId;
              saveSession(s);
            }

            broadcast({
              type: 'PROJECT_COMPLETE',
              sessionId: originSessionId,
              response: botMsg.text,
              projectResult: result,
              sessions: getAllSessions(),
            });
            broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
          } catch (err) {
            console.error('[Server Error / BUILD_PROJECT]', err);
            broadcast({ type: 'TERMINAL_OUTPUT', output: `\n❌ Project build failed: ${err.message}\n` });
            broadcast({ type: 'ERROR', sessionId: originSessionId, error: err.message });
            broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
          }
        })();
      }

      if (msg.type === 'AGENTIC_ACTION') {
        const { action, code, url } = msg;
        if (action === 'OPEN_URL_FIREFOX') {
          const targetUrl = url || 'http://localhost:5173';
          broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🌐 [Agentic Action] Opening IDE at ${targetUrl} in Firefox...\n` });
          exec(`firefox "${targetUrl}" &`, (err) => {
            if (err) exec(`google-chrome-stable "${targetUrl}" &`);
          });
        }

        if (action === 'SERVE_AND_OPEN_FIREFOX') {
          let cleanCode = code;
          
          // Truncate code at end of HTML document or final script tag to strip trailing prompt leaks
          if (cleanCode.includes('</html>')) {
            cleanCode = cleanCode.substring(0, cleanCode.indexOf('</html>') + 7);
          } else if (cleanCode.includes('</script>')) {
            cleanCode = cleanCode.substring(0, cleanCode.lastIndexOf('</script>') + 9);
          }

          let fullCode = cleanCode;
          if (!cleanCode.includes('<html')) {
            fullCode = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Vibe Studio Live Preview</title><style>body{background:#0b0f17;color:#fff;font-family:sans-serif;padding:20px;}</style></head><body>${cleanCode}</body></html>`;
          }
          
          const fs = await import('fs');
          const path = await import('path');
          const previewPath = path.join(process.cwd(), 'client', 'dist', 'preview.html');
          fs.writeFileSync(previewPath, fullCode, 'utf8');

          const previewUrl = 'http://localhost:3099/preview';
          broadcast({ type: 'TERMINAL_OUTPUT', output: `\n🚀 [Agentic Action] Built local mini server env at ${previewUrl}\n🌐 Opening preview in Firefox...\n` });

          exec(`firefox "${previewUrl}" &`, (err) => {
            if (err) {
              exec(`google-chrome-stable "${previewUrl}" &`);
            }
          });
        }
      }

      if (msg.type === 'CHECK_FIREFOX') {
        try {
          const cookies = await extractChatGPTCookies();
          const qwenCookies = await extractQwenCookies();
          ws.send(JSON.stringify({ 
            type: 'FIREFOX_STATUS', 
            ok: true, 
            cookieCount: cookies.length,
            qwenCookieCount: qwenCookies.length 
          }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'FIREFOX_STATUS', ok: false, error: e.message }));
        }
      }
    } catch (e) {
      console.error('[WS Parse Error]', e);
    }
  });
});

function broadcast(msgObj) {
  const json = JSON.stringify(msgObj);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  });
}

import { subAgentManager } from './subagent_orchestrator.js';

// REST Session & Sub-Agent Endpoints
app.get('/preview', (req, res) => {
  // Session-aware live preview.
  // Priority:
  //   1. ?session=<id>  -> serve that session's most recent assistant extractedCode
  //   2. (fallback)     -> serve the static client/dist/preview.html written by
  //                        the SERVE_AND_OPEN_FIREFOX agentic action, if any
  //   3. (else)         -> helpful placeholder
  const sessionId = req.query.session;
  if (sessionId) {
    const session = getSessionById(sessionId);
    if (session && Array.isArray(session.messages)) {
      // Walk messages in reverse to find the latest assistant message with extracted code
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m && m.sender === 'chatgpt' && Array.isArray(m.extractedCode) && m.extractedCode.length > 0) {
          let code = m.extractedCode[0] || '';
          // Truncate at end of HTML document to strip any trailing prompt leaks
          if (code.includes('</html>')) {
            code = code.substring(0, code.indexOf('</html>') + 7);
          }
          // Wrap bare fragments in a full document so the iframe renders them
          if (!/<html[\s>]/i.test(code)) {
            code = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Vibe Studio Live Preview</title></head><body>${code}</body></html>`;
          }
          res.type('html').send(code);
          return;
        }
      }
      // Session exists but has no extractable code yet
      return res.status(200).type('html').send(
        '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>No preview</title>' +
        '<style>body{background:#0b0f17;color:#94A3B8;font-family:system-ui;padding:40px;text-align:center}</style></head>' +
        '<body><h2>No generated code in this session yet</h2>' +
        `<p>Session: <code>${sessionId}</code></p>` +
        '<p>Send a prompt in Vibe GPT Studio to generate a preview.</p></body></html>'
      );
    }
    // Unknown session id
    return res.status(404).type('html').send(
      '<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Session not found</title>' +
      '<style>body{background:#0b0f17;color:#ef4444;font-family:system-ui;padding:40px;text-align:center}</style></head>' +
      `<body><h2>Session not found</h2><p><code>${sessionId}</code></p></body></html>`
    );
  }

  // No session specified — fall back to the static preview file if the agentic
  // SERVE_AND_OPEN_FIREFOX action wrote one.
  const previewPath = path.join(process.cwd(), 'client', 'dist', 'preview.html');
  if (fs.existsSync(previewPath)) {
    return res.sendFile(previewPath);
  }
  res.type('html').send('<h1>No code preview built yet</h1><p>Generate code in Vibe GPT Studio, or open <code>/preview?session=&lt;id&gt;</code> to render a specific session.</p>');
});

app.get('/api/sessions', (req, res) => res.json(getAllSessions()));

// Project file server: serves files from a project session's directory.
// Two modes:
//   /project/<sessionId>/<relative-path>  → specific file
//   /project/<sessionId>                  → the project entry point (index.html / index.php-as-html)
// All paths are sandboxed under PROJECTS_ROOT/<sessionId>/ via path.resolve check.
// Bare project route — serve the entry point when no specific file requested.
app.get('/project/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const projectDir = path.join(PROJECTS_ROOT, sessionId);
  if (!fs.existsSync(projectDir)) {
    return res.status(404).type('text').send(`Project session not found: ${sessionId}`);
  }
  // prefer index.html, then index.php (served as static text since no PHP runtime)
  for (const idx of ['index.html', 'index.php', 'public/index.html']) {
    const candidate = path.join(projectDir, idx);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const ext = path.extname(candidate).toLowerCase();
      // Serve PHP source as text/html for preview (no PHP runtime)
      if (ext === '.php') res.type('text/html');
      else res.type(ext === '.css' ? 'text/css' : (ext === '.js' ? 'text/javascript' : 'text/html'));
      return res.send(fs.readFileSync(candidate, 'utf8'));
    }
  }
  res.status(404).type('text').send(`No index.html or index.php in project ${sessionId}`);
});

app.get('/project/:sessionId/*filePath', (req, res) => {
  const { sessionId } = req.params;
  // Express 5's *filePath returns an ARRAY of path segments — join them back.
  const filePathParts = req.params.filePath;
  const rel = Array.isArray(filePathParts) ? filePathParts.join('/') : filePathParts;
  const projectDir = path.join(PROJECTS_ROOT, sessionId);
  if (!fs.existsSync(projectDir)) {
    return res.status(404).type('text').send(`Project session not found: ${sessionId}`);
  }
  if (!rel) return res.redirect(`/project/${sessionId}`);
  const candidate = path.resolve(projectDir, rel);
  const rootResolved = path.resolve(projectDir);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + path.sep) && candidate !== rootResolved) {
    return res.status(400).type('text').send('Invalid path (sandbox violation rejected)');
  }
  if (!fs.existsSync(candidate)) {
    return res.status(404).type('text').send(`File not found: ${rel}`);
  }
  // Directory? serve index.html inside it
  if (fs.statSync(candidate).isDirectory()) {
    const idx = path.join(candidate, 'index.html');
    if (fs.existsSync(idx)) {
      res.type('text/html');
      return res.send(fs.readFileSync(idx, 'utf8'));
    }
    return res.status(404).type('text').send(`No index.html in ${rel}/`);
  }
  // Serve the file with appropriate content-type (avoid sendFile's finicky send lib)
  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.php') res.type('text/html');
  else if (ext === '.css') res.type('text/css');
  else if (ext === '.js') res.type('text/javascript');
  else if (ext === '.json') res.type('application/json');
  else res.type('text/html');
  res.send(fs.readFileSync(candidate, 'utf8'));
});

// Project file-tree API: returns the tree for a project session (for the UI).
app.get('/api/project/:sessionId/tree', (req, res) => {
  const projectDir = path.join(PROJECTS_ROOT, req.params.sessionId);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'not found' });
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.map(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return { name: e.name, type: 'dir', children: walk(p) };
      return { name: e.name, type: 'file', size: fs.statSync(p).size };
    }).sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  };
  res.json({ root: req.params.sessionId, tree: walk(projectDir) });
});
// Static route for desktop screenshots captured by the take_screenshot tool.
// The tool writes to client/dist/screenshot.png and returns this URL — without
// a route here, the URL would 404.
app.get('/screenshot.png', (req, res) => {
  const shotPath = path.join(process.cwd(), 'client', 'dist', 'screenshot.png');
  if (fs.existsSync(shotPath)) {
    res.type('png').sendFile(shotPath);
  } else {
    res.status(404).type('png').send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  }
});
app.get('/api/sessions/:id', (req, res) => res.json(getSessionById(req.params.id)));
app.post('/api/sessions', (req, res) => res.json(saveSession(req.body)));
app.delete('/api/sessions/:id', (req, res) => res.json({ ok: deleteSession(req.params.id) }));

// CLI-friendly one-shot prompt endpoint. Used by the brainstorm-qwen /
// brainstorm-chatgpt skills (and any external script) to consult a provider
// without speaking the full WebSocket protocol.
//
// POST /api/ask
//   { "prompt": "...", "provider": "qwen"|"chatgpt", "mode": "brainstorm"|... }
// Returns: { "ok": true, "response": "...", "sessionId": "..." } on success,
//          { "ok": false, "error": "..." } on failure.
//
// Creates an ephemeral session, dispatches the prompt through the same PROMPT
// handler logic the WS uses (sanitize, verify, auto-continue), and returns the
// final assistant text. No streaming — caller waits for the complete response.
app.post('/api/ask', async (req, res) => {
  const { prompt, provider = 'chatgpt', mode = 'brainstorm' } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'prompt (string) required' });
  }
  if (!['chatgpt', 'qwen', 'deepseek'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'provider must be "chatgpt", "qwen", or "deepseek"' });
  }
  // DeepSeek mode mapping: /api/ask caller can pass mode='instant'|'expert'|'vision'
  // to pick DeepSeek's model. For other providers 'mode' is the session mode label.
  const dsMode = ['instant', 'expert', 'vision'].includes(mode) ? mode : 'instant';

  // Create an ephemeral session for this consult
  const sid = `ask_${Date.now()}`;
  const session = {
    id: sid, title: `consult-${provider}-${prompt.slice(0,20)}`, mode, archived: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: []
  };
  saveSession(session);
  const originSessionId = sid;
  broadcast({ type: 'STATUS', status: 'thinking', sessionId: originSessionId });

  try {
    let controller;
    let sendOpts = {};
    if (provider === 'qwen') controller = qwen;
    else if (provider === 'deepseek') { controller = deepseek; sendOpts = { mode: dsMode }; }
    else controller = chatgpt;
    const sessionHeadful = false;

    // Build the prompt the same way the PROMPT handler does for the chosen mode.
    const CODE_GUARD = "\n\nCRITICAL INSTRUCTION: Output ONLY your brainstorming response. No code unless explicitly requested.";
    let fullPrompt = prompt;
    // Only apply the brainstorm wrapper when mode IS 'brainstorm' (not when it's
    // a DeepSeek mode like 'instant'/'expert'/'vision').
    if (mode === 'brainstorm') {
      fullPrompt = `[BRAINSTORMING MODE - consultative reasoning]\nYou are being consulted as ${provider}. Give a thoughtful, structured response with multiple perspectives, tradeoffs, and concrete recommendations.\n${prompt}${CODE_GUARD}`;
    } else if (provider !== 'deepseek') {
      fullPrompt = `${prompt}${CODE_GUARD}`;
    }

    let responseText = await controller.sendPrompt(fullPrompt, sessionHeadful, () => {}, sendOpts);
    responseText = sanitizeOutput(responseText);

    // Empty/junk guards (same as the WS path)
    if (!responseText || responseText.trim().length === 0) {
      return res.json({ ok: false, error: 'Provider returned an empty response. Retry or check quota/login.', sessionId: sid });
    }
    const trimmed = responseText.trim();
    const isJunkAck = trimmed.length <= 40
      && !/```/.test(trimmed)
      && /^(CHATGPT_OK|{"status"\s*:\s*"(ready|ok|done)"}$|OK|Done\.?|Ready\.?|noop)/i.test(trimmed);
    if (isJunkAck) {
      return res.json({ ok: false, error: `Provider returned a junk acknowledgement (${JSON.stringify(trimmed)}). Retry or rephrase.`, sessionId: sid });
    }

    // Save and return
    session.messages.push({ id: Date.now().toString(), sender: 'user', text: prompt, mode, timestamp: new Date().toLocaleTimeString() });
    session.messages.push({ id: (Date.now()+1).toString(), sender: 'chatgpt', text: responseText, mode, timestamp: new Date().toLocaleTimeString() });
    saveSession(session);
    broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
    res.json({ ok: true, response: responseText, sessionId: sid, provider });
  } catch (err) {
    console.error('[/api/ask error]', err);
    broadcast({ type: 'STATUS', status: 'idle', sessionId: originSessionId });
    res.json({ ok: false, error: err.message, sessionId: sid });
  }
});

app.get('/api/subagents', (req, res) => res.json(subAgentManager.listAgents()));
app.post('/api/subagents', (req, res) => {
  const { name, role, systemPrompt } = req.body;
  const agent = subAgentManager.createAgent(name, role, systemPrompt);
  broadcast({ type: 'SUBAGENTS_UPDATED', agents: subAgentManager.listAgents() });
  res.json(agent);
});

app.post('/api/subagents/task', async (req, res) => {
  const { agentId, taskDescription, parentSessionId } = req.body;
  try {
    const agent = subAgentManager.getAgent(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const task = subAgentManager.assignTask(agentId, taskDescription, parentSessionId);
    broadcast({ type: 'SUBAGENTS_UPDATED', agents: subAgentManager.listAgents() });

    // Execute sub-agent task using Playwright ChatGPT background automation
    const subPrompt = `[SUB-AGENT ROLE: ${agent.name} (${agent.role})]\n${agent.systemPrompt}\n\nTASK:\n${taskDescription}`;
    
    // Process asynchronously in background
    chatgpt.sendPrompt(subPrompt, false).then(response => {
      subAgentManager.completeTask(agentId, task.taskId, response);
      broadcast({ type: 'SUBAGENTS_UPDATED', agents: subAgentManager.listAgents() });

      // Save sub-agent result message into session
      const s = getSessionById(parentSessionId || activeSessionId);
      if (s) {
        s.messages.push({
          id: Date.now().toString(),
          sender: 'chatgpt',
          text: `🤖 [Sub-Agent "${agent.name}" Completed Task]:\n${response}`,
          mode: 'agent',
          timestamp: new Date().toLocaleTimeString()
        });
        saveSession(s);
        broadcast({ type: 'SESSIONS_UPDATED', sessions: getAllSessions(), activeSessionId: s.id });
      }
    }).catch(err => {
      subAgentManager.completeTask(agentId, task.taskId, null, err.message);
      broadcast({ type: 'SUBAGENTS_UPDATED', agents: subAgentManager.listAgents() });
    });

    res.json({ ok: true, task });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const cookies = await extractChatGPTCookies();
    res.json({ ok: true, cookies: cookies.length, activeSessionId, subAgents: subAgentManager.listAgents().length });
  } catch (e) {
    res.json({ ok: false, error: e.message, activeSessionId });
  }
});

const PORT = 3099;
server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🔥 Vibe GPT Studio Backend running at http://localhost:${PORT}`);
  console.log(`⚡ Firefox ChatGPT Automation Ready`);
  console.log(`==================================================\n`);
});
