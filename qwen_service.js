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
    // Use the specific composer selector - a Monaco code-editor textarea may also
    // exist on the page from artifact/vibe-coding conversations.
    try {
      await this.page.waitForSelector('textarea.message-input-textarea', { timeout: 20000 });
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
      // NOTE: must target the chat composer specifically - the page may also contain
      // a Monaco code-editor textarea (aria-label="Editor content", class "inputarea
      // monaco-mouse-cursor-text") from artifact/vibe-coding conversations, which is
      // readonly and would match a bare `textarea` selector first.
      const inputSelector = 'textarea.message-input-textarea';
      let inputFound = false;
      try {
        await page.waitForSelector(inputSelector, { timeout: 15000 });
        inputFound = true;
      } catch (e) {
        // Fallbacks: composer inside the chat input container, then contenteditable
        for (const alt of ['div[class*="input"] textarea:not([readonly])', 'div[contenteditable="true"]']) {
          try {
            if (await page.locator(alt).count() > 0) { inputFound = true; break; }
          } catch (e2) {}
        }
      }
      if (!inputFound) {
        throw new Error('Qwen chat composer not found (check login state)');
      }

      // Focus the composer, clear it, and type with real keystrokes
      await page.focus(inputSelector);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');

      if (prompt.length < 300) {
        await page.type(inputSelector, prompt, { delay: 20 + Math.floor(Math.random() * 30) });
      } else {
        const chunks = prompt.match(/[\s\S]{1,120}/g) || [prompt];
        for (const chunk of chunks) {
          await page.type(inputSelector, chunk, { delay: 10 + Math.floor(Math.random() * 15) });
          await page.waitForTimeout(100 + Math.floor(Math.random() * 200));
        }
      }
      await page.waitForTimeout(500);

      // Count assistant messages BEFORE submitting - the new response is a NEW element.
      // (Reading it after the send click races: a fast response is already counted.)
      const assistantSel = '.qwen-chat-message-assistant, .chat-response-message';
      let countBefore = 0;
      try {
        countBefore = await page.locator(assistantSel).count();
      } catch (e) {}

      // Submit via the send button if present, else Enter
      let sent = false;
      try {
        const sendBtn = page.locator('button.send-button, button[aria-label*="send" i], button[data-testid*="send"]').first();
        if (await sendBtn.isVisible().catch(() => false)) {
          await sendBtn.click();
          sent = true;
        }
      } catch (e) {}
      if (!sent) {
        await page.keyboard.press('Enter');
      }
      this.lastRequestTime = Date.now();

      // Wait for the new assistant message to appear (count increases)
      const appearDeadline = Date.now() + 60000;
      let diagnosticDumped = false;
      while (Date.now() < appearDeadline) {
        let count = 0;
        try { count = await page.locator(assistantSel).count(); } catch (e) {}
        if (count > countBefore) break;
        // Quota / service-gate detection: if 8s pass with no new assistant message,
        // check whether qwen.ai is refusing to generate (free-tier daily limit,
        // login wall, captcha, maintenance). Bail fast with a clear error instead
        // of hanging the full 60s+ appear window.
        if (!diagnosticDumped && Date.now() - this.lastRequestTime > 8000) {
          diagnosticDumped = true;
          try {
            const bodyText = (await page.locator('body').innerText().catch(() => ''));
            // "Rules: 3/3" / "Rules: N/N" is qwen's free-tier quota indicator
            const quotaMatch = bodyText.match(/Rules:\s*\d+\s*\/\s*\d+/i);
            const loginWall = /Log in|Sign up/i.test(bodyText) && !/Log out/i.test(bodyText)
              && await page.locator('textarea.message-input-textarea').count() === 0;
            if (quotaMatch) {
              console.warn('[Qwen Automator] Quota exhausted detected:', quotaMatch[0]);
              throw new Error(`Qwen free-tier quota exhausted (${quotaMatch[0]}). The message was sent but qwen.ai refused to generate. Quota resets daily; use a paid account or wait for reset.`);
            }
            if (loginWall) {
              console.warn('[Qwen Automator] Login wall detected');
              throw new Error('Qwen session is logged out (login wall visible). Re-authenticate in Firefox, then restart the backend.');
            }
            // No quota/login gate but still no response — log a short diagnostic
            console.warn('[Qwen Automator] No assistant response after 8s. Body tail:', bodyText.slice(-200).replace(/\s+/g, ' '));
          } catch (diagErr) {
            if (diagErr.message && diagErr.message.includes('quota exhausted')) throw diagErr;
            if (diagErr.message && diagErr.message.includes('logged out')) throw diagErr;
            // other diagnostic errors are non-fatal
          }
        }
        await page.waitForTimeout(800);
      }

      // Poll the LAST assistant message text until the response is TRULY complete.
      // Qwen pauses mid-generation (long HTML/code), so a short stability window
      // captures truncated output. Two independent completion signals:
      //   1. Stop button disappears (generation ended) - primary
      //   2. Text stable for a LONG window (30s) - backup for responses without stop button
      let lastText = '';
      let stableRounds = 0;
      let sawStopButton = false;
      const streamDeadline = Date.now() + 240000; // up to 4 min for long code
      let generatedSome = false;

      // Qwen stop/regenerate button selectors (shown while the model is generating)
      const stopSelectors = [
        'button[aria-label*="stop" i]',
        'button[aria-label*="Stop" i]',
        'button[class*="stop" i]',
        'button[data-testid*="stop"]'
      ];

      while (Date.now() < streamDeadline) {
        let current = '';
        try {
          const els = await page.locator(assistantSel).all();
          if (els.length > 0) {
            current = (await els[els.length - 1].innerText()).trim();
          }
        } catch (e) {}

        if (current.length > 0) generatedSome = true;

        // Fast-fail: if 30s pass and NOTHING was ever generated, the provider is
        // refusing (quota/rate-limit/login wall). Bail instead of waiting 4 min.
        if (!generatedSome && Date.now() - this.lastRequestTime > 30000) {
          console.warn('[Qwen Automator] No generation after 30s — provider not responding (quota/rate-limit/login). Aborting.');
          break;
        }

        if (current.length > lastText.length) {
          const newChunk = current.slice(lastText.length);
          lastText = current;
          stableRounds = 0;
          if (onToken) onToken(newChunk, current);
        }

        // Check if generation is still in progress (stop button present)
        let stopVisible = false;
        for (const sel of stopSelectors) {
          try {
            if (await page.locator(sel).first().isVisible().catch(() => false)) {
              stopVisible = true;
              break;
            }
          } catch (e) {}
        }
        if (stopVisible) {
          sawStopButton = true;
          stableRounds = 0; // still generating - reset stability
        } else {
          // No stop button visible
          if (generatedSome && sawStopButton) {
            // We SAW generation and now it's done => complete
            break;
          }
          // Never saw a stop button: use long stability window as backup
          if (current === lastText && current.length > 0) {
            stableRounds += 1;
            if (stableRounds >= 60) break; // ~30s stable => done
          } else {
            stableRounds = 0;
          }
        }

        await page.waitForTimeout(500);
      }

      let cleanResponse = lastText.trim();

      // Do NOT append marker text to the response - any injected text becomes part
      // of the extracted code and can fool integrity checks (e.g. a "</html>"
      // substring inside the marker text). Truncation is detected structurally in
      // server.js (missing closing tags), not by annotating the payload.

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
