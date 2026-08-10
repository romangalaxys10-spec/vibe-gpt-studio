import { QwenAutomationController } from './qwen_service.js';

async function inspectQwen() {
  const c = new QwenAutomationController();
  console.log('Opening chat.qwen.ai in headful mode for DOM inspection...');
  const page = await c.ensureBrowser(true);
  await page.waitForTimeout(4000);

  const inputs = await page.$$eval('textarea, input, div[contenteditable="true"]', els => {
    return els.map(e => ({
      tagName: e.tagName,
      id: e.id,
      className: e.className,
      placeholder: e.getAttribute('placeholder') || ''
    }));
  });
  console.log('INPUT ELEMENTS DETECTED:', JSON.stringify(inputs, null, 2));

  const pageText = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('PAGE TEXT SAMPLE:', pageText);

  await c.close();
}

inspectQwen().catch(console.error);
