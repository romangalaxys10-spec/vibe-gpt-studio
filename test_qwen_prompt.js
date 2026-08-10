import { QwenAutomationController } from './qwen_service.js';

async function testSubmit() {
  const c = new QwenAutomationController();
  console.log('Sending test prompt turn to chat.qwen.ai...');
  const res = await c.sendPrompt('Hello Qwen! Reply with OK if you receive this prompt.', true, (token) => {
    console.log('QWEN STREAM TOKEN:', token);
  });
  console.log('--- FINAL RESPONSE FROM QWEN ---');
  console.log(res);
  await c.close();
}

testSubmit().catch(console.error);
