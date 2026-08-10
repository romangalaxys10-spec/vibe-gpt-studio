import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);

export class AgenticToolExecutor {
  constructor() {
    this.tools = {
      // 1. TERMINAL & APPLICATION USE TOOLS
      exec_command: async ({ command, cwd }) => {
        try {
          const { stdout, stderr } = await execPromise(command, { cwd: cwd || process.cwd(), maxBuffer: 1024 * 1024 * 10 });
          return { ok: true, output: stdout || stderr || 'Command executed cleanly.' };
        } catch (e) {
          return { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
        }
      },

      open_application: async ({ appName, args }) => {
        try {
          const name = appName.toLowerCase();
          const envPath = `${process.env.HOME}/.local/bin:/snap/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH}`;
          const execOpts = { cwd: process.cwd(), env: { ...process.env, PATH: envPath } };

          const appConfigs = {
            discord: {
              wmMatch: 'discord.Discord',
              launch: 'snap run discord || /snap/bin/discord'
            },
            whatsie: {
              wmMatch: 'whatsie',
              launch: 'whatsie || snap run whatsie || /snap/bin/whatsie'
            },
            chrome: {
              wmMatch: 'google-chrome',
              launch: 'google-chrome-stable || google-chrome'
            },
            firefox: {
              wmMatch: 'firefox',
              launch: 'firefox'
            },
            code: {
              wmMatch: 'code.Code',
              launch: 'code'
            }
          };

          const matchedKey = Object.keys(appConfigs).find(k => name.includes(k));
          if (matchedKey) {
            const config = appConfigs[matchedKey];
            // 1. Try focusing existing window via wmctrl
            try {
              const { stdout } = await execPromise(`wmctrl -x -a "${config.wmMatch}" || wmctrl -a "${matchedKey}"`, execOpts);
              return { ok: true, message: `Focused existing ${matchedKey} window visually.` };
            } catch (e) {
              // 2. Not running or focus failed; launch app
              exec(`${config.launch} &`, execOpts);
              // Wait 2s and request window focus again
              setTimeout(() => {
                exec(`wmctrl -x -a "${config.wmMatch}" || wmctrl -a "${matchedKey}"`, execOpts);
              }, 2500);
              return { ok: true, message: `Launched and focused ${matchedKey} on desktop.` };
            }
          } else {
            // Unknown app — verify the binary exists before claiming success.
            // Returning ok:true without checking misled callers (and users) when the
            // app name was misspelled or not installed.
            const candidateBinaries = [appName, appName.toLowerCase()];
            const checks = candidateBinaries.map(b => {
              const lookupPaths = ['/usr/bin', '/usr/local/bin', '/snap/bin', `${process.env.HOME}/.local/bin`];
              return lookupPaths.some(p => fs.existsSync(`${p}/${b}`));
            });
            const whichCheck = await execPromise(`command -v ${candidateBinaries.join(' ')} 2>/dev/null || which ${candidateBinaries.join(' ')} 2>/dev/null`).then(r => r.stdout.trim().length > 0).catch(() => false);
            const exists = checks.some(Boolean) || whichCheck;
            if (!exists) {
              return { ok: false, error: `Application "${appName}" not found in PATH. Install it or check the name.` };
            }
            const fullCmd = args ? `${appName} ${args} &` : `${appName} &`;
            exec(fullCmd, execOpts);
            return { ok: true, message: `Launched ${appName} on desktop.` };
          }
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },

      read_file: async ({ filePath }) => {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          return { ok: true, content: content.substring(0, 10000) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },

      write_file: async ({ filePath, content }) => {
        try {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, content, 'utf8');
          return { ok: true, message: `File written successfully to ${filePath}` };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },

      // 2. BROWSER USE TOOLS
      navigate_url: async ({ url, browser }) => {
        return new Promise((resolve) => {
          const targetBrowser = browser || 'firefox';
          // NOTE: do NOT chain with "& ||" — that is invalid shell syntax (background
          // operator immediately followed by OR). Use a single foreground-or-background
          // command per browser and rely on the callback to detect failure.
          const launchers = targetBrowser === 'chrome'
            ? ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
            : ['firefox'];
          const tried = [];
          let idx = 0;
          const tryNext = () => {
            if (idx >= launchers.length) {
              return resolve({ ok: false, error: `No ${targetBrowser} binary found. Tried: ${launchers.join(', ')}` });
            }
            const bin = launchers[idx++];
            tried.push(bin);
            exec(`${bin} "${url}" &`, (err) => {
              if (err) tryNext();
              else resolve({ ok: true, message: `Opened ${url} in ${bin}` });
            });
          };
          tryNext();
        });
      },

      // 3. COMPUTER USE & GUI DESKTOP AUTOMATION (Linux X11/Wayland)
      take_screenshot: async () => {
        const shotPath = path.join(process.cwd(), 'client', 'dist', 'screenshot.png');
        try {
          await execPromise(`import -window root "${shotPath}" || gnome-screenshot -f "${shotPath}" || scrot "${shotPath}"`);
          return { ok: true, screenshotUrl: 'http://localhost:3099/screenshot.png' };
        } catch (e) {
          return { ok: false, error: 'Screenshot capture tool not available (install imagemagick or gnome-screenshot)' };
        }
      },

      click_mouse: async ({ x, y }) => {
        try {
          await execPromise(`xdotool mousemove ${x} ${y} click 1`);
          return { ok: true, message: `Clicked mouse at coordinates (${x}, ${y})` };
        } catch (e) {
          return { ok: false, error: 'xdotool not installed for mouse control' };
        }
      },

      type_keyboard: async ({ text, pressEnter }) => {
        try {
          const enterCmd = pressEnter ? ' key Return' : '';
          await execPromise(`xdotool type "${text}"${enterCmd}`);
          return { ok: true, message: `Typed text cleanly onto desktop focused window` };
        } catch (e) {
          return { ok: false, error: 'xdotool not installed for keyboard control' };
        }
      }
    };
  }

  getToolDefinitions() {
    return `You have access to the following LOCAL EXECUTION TOOLS. When the user asks you to DO something on the system (run a command, open an app, read/write a file, take a screenshot, control the mouse/keyboard, open a URL), respond with EXACTLY ONE tool invocation line in this format and nothing else:

TOOL: <tool_name> <json_arguments>

Tool catalog:
- TOOL: exec_command {"command":"ls -la","cwd":"/tmp"}              — run a bash command, return stdout
- TOOL: open_application {"appName":"firefox"}                       — open/focus a desktop app (firefox, chrome, discord, whatsie, code)
- TOOL: navigate_url {"url":"https://example.com","browser":"firefox"} — open a URL in a browser
- TOOL: read_file {"filePath":"/etc/hostname"}                       — read a file's contents
- TOOL: write_file {"filePath":"/tmp/x.txt","content":"hello"}       — write content to a file
- TOOL: take_screenshot {}                                            — capture the desktop to screenshot.png
- TOOL: click_mouse {"x":500,"y":300}                                 — click at screen coordinates
- TOOL: type_keyboard {"text":"hello","pressEnter":true}             — type text into the focused window

RULES:
- Output the TOOL: line on its OWN line, with valid JSON (double-quoted keys).
- Do NOT wrap tool calls in markdown code fences. Do NOT add prose around them.
- If the user wants CODE (not a system action), output pure code as usual — no TOOL: line.
- Emit only ONE tool call per turn. The host executes it and returns the result.`;
  }

  async parseAndExecuteTools(text) {
    // Tolerant parser: matches TOOL: <name> <json> across formatting variants.
    // Handles: single-line, multi-line JSON, leading/trailing whitespace, and
    // tool calls wrapped in markdown fences (some providers add them anyway).
    const regex = /TOOL:\s*([a-zA-Z_]+)\s*(\{[\s\S]*?\})/g;
    let match;
    const results = [];

    while ((match = regex.exec(text)) !== null) {
      const toolName = match[1];
      try {
        const args = JSON.parse(match[2]);
        if (this.tools[toolName]) {
          console.log(`[Agentic Tool Exec] Running ${toolName}...`, args);
          const res = await this.tools[toolName](args);
          results.push({ tool: toolName, args, result: res });
        } else {
          results.push({ tool: toolName, error: `Unknown tool: ${toolName}` });
        }
      } catch (e) {
        results.push({ tool: toolName, error: `Invalid JSON args: ${e.message}` });
      }
    }

    return results;
  }
}

export const agenticTools = new AgenticToolExecutor();
