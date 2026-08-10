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
import { agenticTools } from './agentic_tools.js';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const chatgpt = new ChatGPTAutomationController();
const qwen = new QwenAutomationController();

let activeSession = {
  headful: false,
  status: 'idle',
  history: [],
  artifacts: []
};

import { getAllSessions, getSessionById, saveSession, deleteSession } from './session_manager.js';

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
        let s = getSessionById(activeSessionId);
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
          activeSessionId = s.id;
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
          const CODE_GUARD = "\n\nCRITICAL INSTRUCTION: DO NOT GENERATE IMAGES, MOCKUPS, OR CALL DALL-E. YOU ARE A PURE CODE GENERATOR. Output ONLY valid, complete, production-ready source code enclosed inside standard markdown code blocks (```html, ```css, ```js, etc.).";

          let fullPrompt = prompt;
          if (mode === 'vibe_code') {
            fullPrompt = `[VIBE CODING MODE - Pure Code Output Required]\n${prompt}${CODE_GUARD}`;
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
You have access to tools provided by the host application.

Rules:
- When a task requires local execution or opening an app, output a command block or tool call.
- Output ONLY JSON or executable command blocks when requested to perform actions.
- Never claim you cannot control the desktop; the host engine intercepts and executes all your commands automatically.

${localSysInfo}
${agenticTools.getToolDefinitions()}

${preExecResult}
USER TASK:
${prompt}`;
          } else {
            fullPrompt = `${prompt}${CODE_GUARD}`;
          }

          // Output Sanitizer Pipeline (Strips System Prompt Tokens & Leaks)
          function sanitizeOutput(text) {
            if (!text) return '';
            return text
              .replace(/^\[(VIBE CODING|AGENTIC ORCHESTRATOR) MODE[\s\S]*?\]\n?/gi, '')
              .replace(/CRITICAL INSTRUCTION:[\s\S]*?code blocks \([^\)]*\)\./gi, '')
              .replace(/SYSTEM NOTIFICATION:[\s\S]*?\n/gi, '')
              .replace(/You are Vibe GPT Studio Agent[\s\S]*?USER TASK:\n/gi, '')
              .trim();
          }

          const provider = msg.provider || 'chatgpt';
          console.log(`[Prompt Dispatcher] Executing prompt using provider: ${provider}`);

          const controller = provider === 'qwen' ? qwen : chatgpt;

          let responseText = await controller.sendPrompt(fullPrompt, activeSession.headful, (token, fullText) => {
            let cleanStream = sanitizeOutput(fullText);
            broadcast({ type: 'STREAM_TOKEN', token, text: cleanStream });
          });

          // Sanitize final response text
          responseText = sanitizeOutput(responseText);

          const codeBlockRegex = /```(html|css|js|jsx|ts|tsx)?\n?([\s\S]*?)```/gi;
          let match;
          const extractedCode = [];
          while ((match = codeBlockRegex.exec(responseText)) !== null) {
            const lang = (match[1] || '').toLowerCase();
            const code = match[2].trim();
            
            // Skip shell scripts and system prompt echoed text blocks
            if (lang === 'bash' || lang === 'sh' || code.startsWith('#!/') || code.includes('launch_preview.sh') || code.includes('CRITICAL INSTRUCTION: DO NOT GENERATE IMAGES')) {
              continue;
            }
            if (code && !extractedCode.includes(code)) {
              extractedCode.push(code);
            }
          }

          if (extractedCode.length === 0) {
            const lines = responseText.split('\n');
            let currentBlock = [];
            let inBlock = false;
            for (const line of lines) {
              if (line.startsWith('import ') || line.startsWith('export ') || line.startsWith('def ') || line.startsWith('function ') || line.startsWith('<!DOCTYPE') || line.startsWith('<html')) {
                inBlock = true;
              }
              if (inBlock) currentBlock.push(line);
            }
            if (currentBlock.length > 0) {
              const code = currentBlock.join('\n').trim();
              if (!code.includes('launch_preview.sh') && !code.includes('CRITICAL INSTRUCTION')) {
                extractedCode.push(code);
              }
            }
          }

          // Auto-execute any explicit agentic tools emitted by ChatGPT
          const toolResults = await agenticTools.parseAndExecuteTools(responseText);
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
            extractedCode
          };

          const activeS = getSessionById(activeSessionId);
          if (activeS) {
            activeS.messages.push(botMsg);
            saveSession(activeS);
          }

          broadcast({
            type: 'PROMPT_COMPLETE',
            response: responseText,
            extractedCode,
            mode,
            sessions: getAllSessions()
          });
          broadcast({ type: 'STATUS', status: 'idle' });
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
  const previewPath = path.join(process.cwd(), 'client', 'dist', 'preview.html');
  if (fs.existsSync(previewPath)) {
    res.sendFile(previewPath);
  } else {
    res.send('<h1>No code preview built yet</h1><p>Generate code in Vibe GPT Studio to render it live here.</p>');
  }
});

app.get('/api/sessions', (req, res) => res.json(getAllSessions()));
app.get('/api/sessions/:id', (req, res) => res.json(getSessionById(req.params.id)));
app.post('/api/sessions', (req, res) => res.json(saveSession(req.body)));
app.delete('/api/sessions/:id', (req, res) => res.json({ ok: deleteSession(req.params.id) }));

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
