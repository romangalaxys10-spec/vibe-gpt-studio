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
          const cmd = targetBrowser === 'chrome' ? `google-chrome-stable "${url}" & || google-chrome "${url}" &` : `firefox "${url}" &`;
          exec(cmd, (err) => {
            if (err) exec(`google-chrome-stable "${url}" &`);
            resolve({ ok: true, message: `Opened ${url} in ${targetBrowser}` });
          });
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
    return `
Available Agentic Action Tools:
1. \`TOOL: open_application {"appName": "chrome"}\` - Open any desktop app (chrome, firefox, vscode, terminal).
2. \`TOOL: exec_command {"command": "npm test"}\` - Run bash commands on local terminal.
3. \`TOOL: navigate_url {"url": "https://google.com", "browser": "chrome"}\` - Open URL in browser.
4. \`TOOL: write_file {"filePath": "src/app.js", "content": "..."}\` - Write file content.
5. \`TOOL: read_file {"filePath": "package.json"}\` - Read file content.
6. \`TOOL: take_screenshot {}\` - Take Linux desktop screenshot.
7. \`TOOL: click_mouse {"x": 500, "y": 300}\` - Click desktop mouse coordinates.
8. \`TOOL: type_keyboard {"text": "hello", "pressEnter": true}\` - Type keyboard input.

To invoke any tool, output a line starting with: \`TOOL: <tool_name> <json_args>\`
Or output a standard shell code block:
\`\`\`bash
google-chrome-stable &
\`\`\`
`;
  }

  async parseAndExecuteTools(text) {
    const regex = /TOOL:\s*(\w+)\s*(\{[\s\S]*?\})/g;
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
        }
      } catch (e) {
        results.push({ tool: toolName, error: `Invalid JSON args: ${e.message}` });
      }
    }

    return results;
  }
}

export const agenticTools = new AgenticToolExecutor();
