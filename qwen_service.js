import { firefox } from 'playwright';
import { getFirefoxCookiesPath } from './chatgpt_service.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';

/**
 * Locate the real Firefox profile directory (parent of cookies.sqlite)
 */
export function getFirefoxProfileDir() {
  const dbPath = getFirefoxCookiesPath();
  return path.dirname(dbPath);
}

/**
 * Copy the live Firefox profile (cookies + localStorage + prefs) to a temp dir.
 *
 * IMPORTANT: Qwen (chat.qwen.ai) keeps its session token in **localStorage**,
 * not just cookies. Injecting cookies alone leaves the page logged out
 * (the token cookie is httpOnly, so the SPA cannot read it via document.cookie).
 * Launching Playwright Firefox against a COPY of the real profile carries
 * cookies AND localStorage, so the session survives.
 */
export function prepareProfileCopy() {
  const srcDir = getFirefoxProfileDir();
  const copyDir = path.join(os.tmpdir(), `ff_profile_copy_${Date.now()}_${Math.random().toString(36).substring(7)}`);
  fs.mkdirSync(copyDir, { recursive: true });

  const toCopy = ['cookies.sqlite', 'storage', 'webappsstore.sqlite', 'prefs.js'];
  for (const item of toCopy) {
    const src = path.join(srcDir, item);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(copyDir, item), { recursive: true });
    }
  }
  return copyDir;
}

/**
 * Extract Qwen AI session cookies from Firefox cookies.sqlite
 * (kept for CHECK_FIREFOX status + cookie-based fallback)
 */
export async function extractQwenCookies() {
  let profileDb;
  try {
    profileDb = getFirefoxCookiesPath();
  } catch (e) {
    return [];
  }

  const tempDb = path.join(os.tmpdir(), `ff_qwen_cookies_${Date.now()}_${Math.random().toString(36).substring(7)}.sqlite`);
  fs.copyFileSync(profileDb, tempDb);

  return new Promise((resolve) => {
    const db = new sqlite3.Database(tempDb, sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);
        return resolve([]);
      }
    });

    const query = `
      SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
      FROM moz_cookies
      WHERE host LIKE '%qwen%' OR host LIKE '%alibabacloud%' OR host LIKE '%aliyun%'
      ORDER BY host
    `;

    db.all(query, [], (err, rows) => {
      db.close();
      if (fs.existsSync(tempDb)) fs.unlinkSync(tempDb);

      if (err || !rows) return resolve([]);

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

      console.log(`[Qwen Automator] Extracted ${cookies.length} session cookies from Firefox`);
      resolve(cookies);
    });
  });
}

/**
 * Playwright Qwen AI Automation Controller
 *
 * Uses a COPY of the live Firefox profile (persistent context) so the Qwen
 * session token in localStorage is preserved - cookie-only injection does
 * NOT work for chat.qwen.ai (token cookie is httpOnly; SPA reads localStorage).
 */
export class QwenAutomationController {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.profileCopyDir = null;
    this.lastRequestTime = 0;
    this.minRequestDelayMs = 4000;
    this.requestQueue = Promise.resolve();
  }

  /**
   * Launch (or reuse) the persistent-context browser built on a copy of the
   * live Firefox profile. If the page was closed/navigated away, re-acquire it.
   */
  async ensureBrowser(headful = false) {
    if (this.page && !this.page.isClosed() && this.context) {
      return this.page;
    }

    // Copy the live profile (cookies + localStorage) so Qwen stays logged in
    this.profileCopyDir = prepareProfileCopy();
    console.log(`[Qwen Automator] Using profile copy: ${this.profileCopyDir}`);

    this.context = await firefox.launchPersistentContext(this.profileCopyDir, {
      headless: !headful,
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0',
      viewport: { width: 1280, height: 800 },
    });

    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.goto('https://chat.qwen.ai', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait for the chat composer to be present (means the SPA rendered)
    try {
      await this.page.waitForSelector('textarea.message-input-textarea, textarea, div[contenteditable="true"]', { timeout: 20000 });
    } catch (e) { /* tolerate */ }

    return this.page;
  }

  async sendPrompt(prompt, headful = false, onToken = null) {
    return this.requestQueue = this.requestQueue.then(async () => {
      const page = await this.ensureBrowser(headful);

      // Humanized Slow Down Algorithm (5s to 9s random jitter)
      const baseDelay = 5000 + Math.floor(Math.random() * 4000);
      const now = Date.now();
      const timeSinceLast = now - this.lastRequestTime;
      if (timeSinceLast < baseDelay) {
        const waitTime = baseDelay - timeSinceLast;
        console.log(`[Qwen Slow Down Engine] Pausing ${waitTime}ms to mimic human typing speed...`);
        await new Promise(r => setTimeout(r, waitTime));
      }

      console.log(`[Qwen Automator] Sending prompt to chat.qwen.ai: ${prompt.substring(0, 40)}...`);

      // If a login/welcome modal is present, dismiss it
      try {
        const modalBtn = page.locator('button:has-text("Stay logged out")').first();
        if (await modalBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          await modalBtn.click();
          console.log('[Qwen Automator] Dismissed welcome/login modal');
          await page.waitForTimeout(2000);
        }
      } catch (e) {}

      // Targeted Qwen Studio Textarea Selector
      const inputSelector = 'textarea.message-input-textarea, textarea, div[contenteditable="true"]';
      try {
        await page.waitForSelector(inputSelector, { timeout: 15000 });
        await page.focus(inputSelector);
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');

        if (prompt.length < 300) {
          await page.type(inputSelector, prompt, { delay: 20 + Math.floor(Math.random() * 30) });
        } else {
          const chunks = prompt.match(/[\s\S]{1,120}/g) || [prompt];
          for (const chunk of chunks) {
            await page.type(inputSelector, chunk, { delay: 10 + Math.floor(Math.random() * 15) });
            try { await page.waitForTimeout(100 + Math.floor(Math.random() * 200)); } catch (e) {}
          }
        }
      } catch (e) {
        console.warn('[Qwen Automator] Primary focus failed, attempting fallback click typing:', e.message);
        try {
          await page.click(inputSelector);
          await page.keyboard.type(prompt, { delay: 20 });
        } catch (e2) {}
      }

      // Submit via the send button if present, else Enter
      try { await page.waitForTimeout(500); } catch (e) {}
      let sent = false;
      try {
        const sendBtn = page.locator('button.send-button, button[aria-label*="send" i], button[data-testid*="send"]').first();
        if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await sendBtn.click();
          sent = true;
        }
      } catch (e) {}
      if (!sent) {
        await page.keyboard.press('Enter');
      }
      this.lastRequestTime = Date.now();

      // Count assistant messages BEFORE sending - the new response is a NEW element
      const assistantSel = '.qwen-chat-message-assistant, .chat-response-message';
      let countBefore = 0;
      try {
        countBefore = await page.locator(assistantSel).count();
      } catch (e) {}

      // Wait for the new assistant message to appear (count increases)
      const appearDeadline = Date.now() + 60000;
      while (Date.now() < appearDeadline) {
        let count = 0;
        try { count = await page.locator(assistantSel).count(); } catch (e) {}
        if (count > countBefore) break;
        await page.waitForTimeout(800);
      }

      // Poll the LAST assistant message text until it stabilizes (streaming complete)
      let lastText = '';
      let stableRounds = 0;
      const streamDeadline = Date.now() + 120000;
      while (Date.now() < streamDeadline) {
        let current = '';
        try {
          const els = await page.locator(assistantSel).all();
          if (els.length > 0) {
            current = (await els[els.length - 1].innerText()).trim();
          }
        } catch (e) {}

        if (current.length > lastText.length) {
          const newChunk = current.slice(lastText.length);
          lastText = current;
          stableRounds = 0;
          if (onToken) onToken(newChunk, current);
        } else if (current === lastText && current.length > 0) {
          stableRounds += 1;
          if (stableRounds >= 6) break; // ~3s stable => done
        }

        await page.waitForTimeout(500);
      }

      let cleanResponse = lastText.trim();
      this.lastRequestTime = Date.now();
      return cleanResponse;
    });
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch (e) {}
      this.browser = null;
      this.context = null;
      this.page = null;
    }
    if (this.profileCopyDir && fs.existsSync(this.profileCopyDir)) {
      try { fs.rmSync(this.profileCopyDir, { recursive: true, force: true }); } catch (e) {}
      this.profileCopyDir = null;
    }
  }
}
