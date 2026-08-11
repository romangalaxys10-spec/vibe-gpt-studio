// deepseek_service.js — Playwright Firefox controller for chat.deepseek.com.
//
// Mirrors the qwen_service.js pattern: copy the live Firefox profile (cookies
// + localStorage so the WAF + auth session survive), launch a persistent
// context, drive the chat composer, select a mode, submit, poll the response.
//
// DeepSeek exposes 3 modes via [data-model-type="..."] radio toggles:
//   - "default" = Instant (DeepSeek V3 — fast, non-reasoning)
//   - "expert"  = Expert  (DeepSeek R1 — reasoning / "DeepThink")
//   - "vision"  = Vision  (image upload capable)
//
// Anti-bot: chat.deepseek.com 403s anonymous requests and uses AWS WAF
// (aws-waf-token cookie). The profile-copy approach carries the WAF token
// the same way it does for Qwen's localStorage session.

import { firefox } from 'playwright';
import fs from 'fs';
import path from 'path';
import os from 'os';
import child_process from 'child_process';

const FIREFOX_BIN = '/home/roman/.cache/ms-playwright/firefox-1538/firefox/firefox';
const LIVE_PROFILE = '/home/roman/snap/firefox/common/.mozilla/firefox/14n5fjgr.default';
const COMPOSER_SEL = 'textarea[placeholder="Message DeepSeek"]';
const MODE_SEL = (mode) => `[data-model-type="${mode}"]`;

export class DeepSeekAutomationController {
  constructor() {
    this.context = null;
    this.page = null;
    this.profileCopyDir = null;
    this.requestQueue = Promise.resolve();
    this.lastRequestTime = 0;
  }

  async _ensureContext(headful = false) {
    if (this.context && this.page && !this.page.isClosed?.()) return this.page;

    // Copy the live profile (cookies + storage so DeepSeek's WAF + session survive)
    this.profileCopyDir = path.join(os.tmpdir(), `ds_profile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(this.profileCopyDir, { recursive: true });
    for (const f of ['cookies.sqlite', 'storage', 'webappsstore.sqlite', 'prefs.js']) {
      try { child_process.execSync(`cp -r ${LIVE_PROFILE}/${f} ${this.profileCopyDir}/ 2>/dev/null`); } catch {}
    }
    console.log(`[DeepSeek Automator] Using profile copy: ${this.profileCopyDir}`);

    this.context = await firefox.launchPersistentContext(this.profileCopyDir, {
      headless: !headful,
      executablePath: FIREFOX_BIN,
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
      ignoreHTTPSErrors: true,
    });
    this.page = this.context.pages[0] || (await this.context.newPage());
    await this.page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Hydrate (React SPA attaches handlers lazily; early typing vanishes)
    await this.page.waitForTimeout(6000);

    // Verify we're logged in (composer present). If not, the WAF token may
    // have expired — surface a clear error rather than hanging.
    try {
      await this.page.waitForSelector(COMPOSER_SEL, { timeout: 15000 });
    } catch {
      throw new Error('DeepSeek composer not found — session may be logged out or WAF token expired. Re-authenticate at chat.deepseek.com in Firefox, then retry.');
    }
    return this.page;
  }

  // Send a prompt and return the COMPLETE assistant response.
  // opts.mode: 'instant' (default) | 'expert' | 'vision'
  // opts.onToken: streaming callback (token, fullText)
  async sendPrompt(prompt, headful = false, onToken = null, opts = {}) {
    return this.requestQueue = this.requestQueue.then(async () => {
      const page = await this._ensureContext(headful);
      const mode = ['instant', 'expert', 'vision'].includes(opts.mode) ? opts.mode : 'instant';
      const modelType = mode === 'instant' ? 'default' : mode; // 'default' | 'expert' | 'vision'

      console.log(`[DeepSeek Automator] Sending prompt (mode=${mode}/${modelType}): ${prompt.slice(0, 50)}...`);

      // 1. Select the mode toggle (click only if not already active)
      try {
        const toggle = page.locator(MODE_SEL(modelType)).first();
        const isChecked = await toggle.getAttribute('aria-checked').catch(() => 'false');
        if (isChecked !== 'true') {
          await toggle.click({ timeout: 3000 });
          await page.waitForTimeout(800);
          console.log(`[DeepSeek Automator] Switched to ${mode} mode`);
        }
      } catch (e) {
        // non-fatal — default mode is usually fine
        console.log(`[DeepSeek Automator] Mode toggle ${mode} not clickable: ${e.message.slice(0, 80)}`);
      }

      // 2. Type into the composer
      await page.waitForSelector(COMPOSER_SEL, { timeout: 15000 });
      await page.focus(COMPOSER_SEL);
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      if (prompt.length < 300) {
        await page.type(COMPOSER_SEL, prompt, { delay: 15 });
      } else {
        const chunks = prompt.match(/[\s\S]{1,120}/g) || [prompt];
        for (const chunk of chunks) {
          await page.type(COMPOSER_SEL, chunk, { delay: 8 });
          await page.waitForTimeout(80);
        }
      }
      await page.waitForTimeout(500);

      // 3. Submit — the send button has role/aria or is the primary ds-button
      //    in the composer. Clicking Enter in the textarea also submits on
      //    DeepSeek (no shift = newline, plain Enter = send).
      let sent = false;
      try {
        // The send button: ds-button--primary + an SVG, near the textarea.
        // It becomes enabled after text is entered. Try aria-label first.
        for (const sel of [
          'button[aria-label*="send" i]',
          'button[aria-label*="Send"]',
          '.ds-button--primary:not(.ds-button--disabled)',
        ]) {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
            await btn.click({ timeout: 2000 });
            sent = true;
            console.log(`[DeepSeek Automator] Sent via ${sel}`);
            break;
          }
        }
      } catch {}
      if (!sent) {
        await page.keyboard.press('Enter');
        console.log('[DeepSeek Automator] Sent via Enter');
      }
      this.lastRequestTime = Date.now();

      // 4. Poll for the assistant response. DeepSeek renders the answer in a
      //    markdown container; we wait for it to appear, then for the streaming
      //    to stabilize (stop button disappears / text stops growing).
      return await this._waitForResponse(page, onToken);
    });
  }

  async _waitForResponse(page, onToken) {
    // Response container: DeepSeek uses a markdown-rendered div for the answer.
    // The most stable selector is the last element with class containing
    // "markdown" inside the chat area, OR the container after the user msg.
    // We wait for ANY new content to appear after submit, then poll until stable.
    const appearDeadline = Date.now() + 60000;
    let prevText = '';
    let stableRounds = 0;
    let sawGrowth = false;
    const streamDeadline = Date.now() + 300000; // up to 5 min for expert/R1

    // Stop-button selectors (shown while DeepThink/R1 is generating)
    const stopSels = ['button[aria-label*="stop" i]', 'button:has-text("Stop")', '.ds-button--primary:has-text("Stop")'];

    while (Date.now() < streamDeadline) {
      // Grab the last assistant markdown block
      let current = '';
      try {
        // markdown body in the most recent assistant turn
        const blocks = await page.locator('[class*="markdown"], .ds-markdown').all();
        if (blocks.length > 0) {
          current = (await blocks[blocks.length - 1].innerText().catch(() => '')).trim();
        }
      } catch {}

      if (current.length > 0) sawGrowth = true;
      if (current.length > prevText.length) {
        const chunk = current.slice(prevText.length);
        prevText = current;
        stableRounds = 0;
        if (onToken) onToken(chunk, current);
      }

      // Stop-button check (primary completion signal for R1/expert)
      let stopVisible = false;
      for (const sel of stopSels) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 500 }).catch(() => false)) {
            stopVisible = true;
            break;
          }
        } catch {}
      }
      if (stopVisible) {
        stableRounds = 0;
      } else if (sawGrowth) {
        // No stop button + we saw text → done
        stableRounds += 1;
        if (stableRounds >= 10) break; // ~5s of stability
      }

      // Fast-fail: if nothing appeared within 30s, the request likely failed
      if (!sawGrowth && Date.now() - this.lastRequestTime > 30000) {
        // check for an error toast / login wall
        const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(-200);
        throw new Error(`DeepSeek produced no response after 30s. Body tail: ${bodyText.replace(/\s+/g, ' ').slice(-150)}`);
      }

      await page.waitForTimeout(500);
    }

    const clean = prevText.trim();
    if (!clean) {
      throw new Error('DeepSeek returned an empty response (no markdown content found).');
    }
    return clean;
  }

  async cleanup() {
    try { if (this.context) await this.context.close(); } catch {}
    if (this.profileCopyDir && fs.existsSync(this.profileCopyDir)) {
      try { fs.rmSync(this.profileCopyDir, { recursive: true, force: true }); } catch {}
    }
    this.context = null;
    this.page = null;
    this.profileCopyDir = null;
  }
}

// Cookie extraction (mirrors qwen pattern — used for /api/status health check)
export function extractDeepSeekCookies() {
  const tmp = path.join(os.tmpdir(), `ds_cookies_${Date.now()}.sqlite`);
  try {
    child_process.execSync(`cp ${LIVE_PROFILE}/cookies.sqlite ${tmp} 2>/dev/null`);
    const Database = require('better-sqlite3');
    const db = new Database(tmp, { readonly: true });
    const rows = db.prepare("SELECT name FROM moz_cookies WHERE host LIKE '%deepseek%'").all();
    db.close();
    fs.unlinkSync(tmp);
    return rows.length;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return 0;
  }
}

export const deepseek = new DeepSeekAutomationController();
