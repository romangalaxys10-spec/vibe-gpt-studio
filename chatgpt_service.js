import { firefox } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';

/**
 * Locate Firefox snap profile cookies.sqlite
 */
export function getFirefoxCookiesPath() {
  const base = path.join(os.homedir(), 'snap/firefox/common/.mozilla/firefox');
  if (!fs.existsSync(base)) {
    throw new Error(`Firefox snap profile directory not found at ${base}`);
  }

  const dirs = fs.readdirSync(base).filter(d => d.includes('.default'));
  if (dirs.length === 0) {
    throw new Error(`No Firefox default profile directories found in ${base}`);
  }

  let selectedDir = dirs.find(d => d.endsWith('.default-release')) || dirs.find(d => d.endsWith('.default')) || dirs[0];
  const dbPath = path.join(base, selectedDir, 'cookies.sqlite');
  
  if (!fs.existsSync(dbPath)) {
    throw new Error(`cookies.sqlite not found in profile ${selectedDir}`);
  }
  return dbPath;
}

/**
 * Extract ChatGPT session cookies from Firefox cookies.sqlite
 */
export async function extractChatGPTCookies() {
  const profileDb = getFirefoxCookiesPath();
  const tempDb = path.join(os.tmpdir(), `ff_cookies_${Date.now()}_${Math.random().toString(36).substring(7)}.sqlite`);

  fs.copyFileSync(profileDb, tempDb);

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(tempDb, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);
        return reject(err);
      }
    });

    const query = `
      SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
      FROM moz_cookies
      WHERE host LIKE '%chatgpt%' OR host LIKE '%openai%'
      ORDER BY host
    `;

    db.all(query, [], (err, rows) => {
      db.close();
      if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);

      if (err) return reject(err);

      const sameSiteMap = { 0: 'None', 1: 'Lax', 2: 'Strict' };

      const cookies = rows.map(row => {
        const expires = row.expiry > 0 ? row.expiry / 1000.0 : -1;
        const cookie = {
          name: row.name,
          value: row.value,
          domain: row.host.startsWith('.') ? row.host.slice(1) : row.host,
          path: row.path,
          secure: Boolean(row.isSecure),
          httpOnly: Boolean(row.isHttpOnly),
          sameSite: sameSiteMap[row.sameSite] || 'Lax',
        };
        if (expires > 0) {
          cookie.expires = expires;
        }
        return cookie;
      });

      console.log(`[ChatGPT Automator] Extracted ${cookies.length} session cookies from Firefox`);
      resolve(cookies);
    });
  });
}

/**
 * Playwright ChatGPT Browser Automation Controller
 */
export class ChatGPTAutomationController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.lastRequestTime = 0;
    this.minRequestDelayMs = 4000; // Minimum 4s delay between prompt turns to prevent rate limits
    this.requestQueue = Promise.resolve();
  }

  async ensureBrowser(headful = false) {
    if (this.page && !this.page.isClosed()) return this.page;

    const cookies = await extractChatGPTCookies();

    this.browser = await firefox.launch({
      headless: !headful,
      args: ['--no-sandbox']
    });

    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0'
    });

    await this.context.addCookies(cookies);

    this.page = await this.context.newPage();
    await this.page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
    return this.page;
  }

  async sendPrompt(prompt, headful = false, onToken = null) {
    // Queue prompt requests sequentially to enforce rate limits across async tasks & sub-agents
    return this.requestQueue = this.requestQueue.then(async () => {
      const page = await this.ensureBrowser(headful);

      // Humanized Randomized Inter-Request Slow Down Algorithm (5s to 9s random jitter)
      const baseDelay = 5000 + Math.floor(Math.random() * 4000);
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      if (timeSinceLast < baseDelay) {
        const waitTime = baseDelay - timeSinceLast;
        console.log(`[Humanized Slow Down Engine] Pausing ${waitTime}ms with randomized jitter to mimic human typing speed...`);
        await new Promise(r => setTimeout(r, waitTime));
      }

      console.log(`[ChatGPT Automator] Typing prompt with humanized delay algorithm: ${prompt.substring(0, 40)}...`);
      await page.waitForTimeout(800 + Math.floor(Math.random() * 600));

      try {
        await page.focus('div[contenteditable="true"]');
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
        
        // Humanized Typing Simulation (Random delay per keystroke chunk)
        if (prompt.length < 300) {
          await page.type('div[contenteditable="true"]', prompt, { delay: 25 + Math.floor(Math.random() * 35) });
        } else {
          // Paste in chunks with human pause between paragraphs
          const chunks = prompt.match(/[\s\S]{1,120}/g) || [prompt];
          for (const chunk of chunks) {
            await page.type('div[contenteditable="true"]', chunk, { delay: 10 + Math.floor(Math.random() * 20) });
            await page.waitForTimeout(150 + Math.floor(Math.random() * 250));
          }
        }
      } catch (e) {
        await page.click('div[contenteditable="true"]');
        await page.keyboard.type(prompt, { delay: 20 });
      }

      // Pre-Enter Human Pause
      await page.waitForTimeout(400 + Math.floor(Math.random() * 600));
      await page.keyboard.press('Enter');
      this.lastRequestTime = Date.now();

      // Wait for prompt submission to register in DOM
      await page.waitForTimeout(2000);

      let lastText = '';
      const startTime = Date.now();

      while (Date.now() - startTime < 90000) {
        let currentText = '';
        try {
          // Extract specifically the last assistant response turn in ChatGPT DOM
          currentText = await page.$$eval('div[data-message-author-role="assistant"]', els => {
            if (els.length === 0) return '';
            return els[els.length - 1].innerText;
          });
        } catch (e) {
          try {
            currentText = await page.$eval('main', el => el.innerText);
          } catch (e2) {}
        }

        // Check for ChatGPT Rate Limit Warning Banner in DOM
        if (currentText.includes('making requests too quickly') || currentText.includes('too many requests') || currentText.includes('Please slow down')) {
          console.warn('[Rate Limit Warning Detected] ChatGPT requested backoff. Waiting 12 seconds...');
          await page.waitForTimeout(12000);
          this.lastRequestTime = Date.now();
        }

        if (currentText && currentText.length > lastText.length) {
          const newChunk = currentText.slice(lastText.length);
          lastText = currentText;
          if (onToken) onToken(newChunk, currentText);
        }

        // Check streaming button or completion idle state
        const stopBtn = await page.$('button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[data-testid="stop-button"]');
        if (!stopBtn && lastText.length > 0) {
          await page.waitForTimeout(2500);
          try {
            lastText = await page.$$eval('div[data-message-author-role="assistant"]', els => {
              if (els.length === 0) return '';
              return els[els.length - 1].innerText;
            });
          } catch (e) {}
          break;
        }
        await page.waitForTimeout(500);
      }

      let cleanResponse = lastText.trim();
      if (cleanResponse.includes(prompt)) {
        cleanResponse = cleanResponse.split(prompt).pop() || cleanResponse;
      }
      cleanResponse = cleanResponse.replace(/ChatGPT can make mistakes\. Check important info\./g, '').trim();

      this.lastRequestTime = Date.now();
      return cleanResponse;
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
