// Full QA suite — covers every subsystem of vibe-gpt-studio.
// Runs against the live backend (:3099), vite (:5173), ollama (:11434).
// No live provider calls (qwen/chatgpt) — those are quota-blocked.
// Reports a per-category pass/fail matrix.
import fs from 'fs';

const results = [];
const log = (cat, name, pass, detail='') => {
  results.push({ cat, name, pass, detail: String(detail).slice(0,120) });
  console.log(`${pass?'✓':'✗'} [${cat}] ${name}${detail?' :: '+String(detail).slice(0,80):''}`);
};

// ============================================================
// 1. SERVICE HEALTH
// ============================================================
console.log('\n=== 1. SERVICE HEALTH ===');
try {
  const r = await fetch('http://localhost:3099/api/status', { signal: AbortSignal.timeout(3000) });
  const d = await r.json();
  log('health', 'backend :3099 up', r.ok);
  log('health', 'backend ok=true', d.ok === true);
  log('health', 'cookies extracted', typeof d.cookies === 'number' && d.cookies > 0, `${d.cookies} cookies`);
  log('health', 'subAgents present', typeof d.subAgents === 'number');
} catch (e) { log('health', 'backend reachable', false, e.message); }

try {
  const r = await fetch('http://localhost:5173/', { signal: AbortSignal.timeout(3000) });
  log('health', 'vite :5173 up', r.ok);
} catch (e) { log('health', 'vite reachable', false, e.message); }

try {
  const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
  const d = await r.json();
  const models = (d.models||[]).map(m => m.name);
  log('health', 'ollama :11434 up', r.ok);
  log('health', 'qwen2.5-coder:7b installed', models.includes('qwen2.5-coder:7b'));
  log('health', 'qwen2.5-coder:1.5b installed', models.includes('qwen2.5-coder:1.5b'));
} catch (e) { log('health', 'ollama reachable', false, e.message); }

// ============================================================
// 2. HTTP ROUTES (the preview + screenshot + sessions APIs)
// ============================================================
console.log('\n=== 2. HTTP ROUTES ===');
const checkRoute = async (name, url, expectStatus=200, expectContains=null) => {
  try {
    const r = await fetch('http://localhost:3099' + url, { signal: AbortSignal.timeout(5000) });
    const ok = r.status === expectStatus;
    let bodyOk = true;
    if (expectContains !== null) {
      const t = await r.text();
      bodyOk = t.includes(expectContains);
    }
    log('route', name, ok && bodyOk, `status=${r.status}${expectContains ? (bodyOk?'':' body-miss') : ''}`);
  } catch (e) { log('route', name, false, e.message); }
};
await checkRoute('GET /api/sessions → JSON array', '/api/sessions', 200, '[');
await checkRoute('GET /api/status → ok:true', '/api/status', 200, '"ok":true');
await checkRoute('GET /preview (no session) → fallback', '/preview');
await checkRoute('GET /preview?session=nonexistent → 404', '/preview?session=nonexistent-qa-test', 404);
await checkRoute('GET /screenshot.png → image', '/screenshot.png');
await checkRoute('GET /api/nonexistent → 404', '/api/nonexistent-route-xyz', 404);
await checkRoute('GET /project/nonexistent → 404', '/project/nonexistent-qa-test', 404);
await checkRoute('GET /api/project/nonexistent/tree → 404', '/api/project/nonexistent-qa-test/tree', 404);

// ============================================================
// 3. SESSIONS API (CRUD)
// ============================================================
console.log('\n=== 3. SESSIONS API ===');
let testSid = null;
try {
  // CREATE
  const cr = await fetch('http://localhost:3099/api/sessions', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ id: `qa_test_${Date.now()}`, title: 'QA Test Session', mode: 'vibe_code', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] })
  });
  const cd = await cr.json();
  testSid = cd.id;
  log('session', 'POST create', !!testSid, testSid);
  // READ
  const gr = await fetch(`http://localhost:3099/api/sessions/${testSid}`);
  const gd = await gr.json();
  log('session', 'GET by id', gd.id === testSid);
  // LIST contains it
  const lr = await fetch('http://localhost:3099/api/sessions');
  const ld = await lr.json();
  log('session', 'GET list contains new', ld.some(s => s.id === testSid));
  // DELETE
  const dr = await fetch(`http://localhost:3099/api/sessions/${testSid}`, { method: 'DELETE' });
  const dd = await dr.json();
  log('session', 'DELETE', dd.ok === true);
  // Confirm gone
  const lr2 = await fetch('http://localhost:3099/api/sessions');
  const ld2 = await lr2.json();
  log('session', 'deleted gone from list', !ld2.some(s => s.id === testSid));
} catch (e) { log('session', 'CRUD', false, e.message); }

// ============================================================
// 4. EXTRACTOR (the truncation/verification pipeline)
// ============================================================
console.log('\n=== 4. EXTRACTOR PIPELINE ===');
const serverSrc = fs.readFileSync('./server.js','utf8');
const fnMatch = serverSrc.match(/function extractGeneratedCode\(text\) \{[\s\S]*?\n          \}/);
fs.writeFileSync('/tmp/_qa_extract.cjs', fnMatch[0] + '\nmodule.exports = { extractGeneratedCode };\n');
const { extractGeneratedCode } = await import('/tmp/_qa_extract.cjs');
const extTests = [
  ['clean HTML doc', '<!DOCTYPE html><html><head></head><body>hi</body></html>', r => !r.truncated],
  ['truncated no </html>', '<!DOCTYPE html><html><body>x', r => r.truncated],
  ['truncated no </body>', '<!DOCTYPE html><html><head></head><body>x</body>', r => r.truncated],
  ['marker-injection (orig bug)', '<!DOCTYPE html><html><body>x\n[TRUNCATED: before closing </html>]', r => r.truncated],
  ['strips [TRUNCATED] marker', '<!DOCTYPE html><html><head></head><body></body></html>\n[TRUNCATED: x]', r => !r.code.includes('[TRUNCATED')],
  ['strips "Preview" trailer', '<!DOCTYPE html><html><head></head><body></body></html>\nPreview', r => !r.code.includes('Preview')],
  ['qwen-raw line numbers', 'html\n1 <!DOCTYPE html>\n2 <html><head></head><body></body></html>', r => r.code.includes('<!DOCTYPE')],
  ['markdown fence', '```html\n<!DOCTYPE html><html></html>\n```', r => r.source === 'markdown-fence'],
  ['empty input', '', r => r.code === ''],
  ['prose after </html> cut', '<!DOCTYPE html><html><head></head><body></body></html>\nKey Features:\nblah', r => !r.code.includes('Key Features')],
];
for (const [name, input, check] of extTests) {
  try { const r = extractGeneratedCode(input); log('extract', name, !!check(r)); }
  catch (e) { log('extract', name, false, e.message); }
}
fs.unlinkSync('/tmp/_qa_extract.cjs');

// ============================================================
// 5. TOOL WRAPPERS (Layer 1 — direct invocation)
// ============================================================
console.log('\n=== 5. TOOL WRAPPERS ===');
const { agenticTools } = await import('./agentic_tools.js');
const t = agenticTools.tools;
const toolTest = async (name, fn, check) => {
  try { const r = await fn(); log('tool', name, !!check(r), check(r) ? '' : JSON.stringify(r).slice(0,60)); }
  catch (e) { log('tool', name, false, e.message); }
};
await toolTest('exec_command echo', () => t.exec_command({command:'echo QA-OK', cwd:'/tmp'}), r => r.ok && r.output.includes('QA-OK'));
await toolTest('exec_command failing', () => t.exec_command({command:'false'}), r => !r.ok);
await toolTest('read_file /etc/hostname', () => t.read_file({filePath:'/etc/hostname'}), r => r.ok && r.content.length>0);
await toolTest('read_file nonexistent', () => t.read_file({filePath:'/nonexistent'}), r => !r.ok);
await toolTest('write_file basic', async () => { const r = await t.write_file({filePath:'/tmp/qa_wr.txt', content:'x'}); return r; }, r => r.ok && fs.readFileSync('/tmp/qa_wr.txt','utf8')==='x');
await toolTest('write_file nested dirs', async () => { const r = await t.write_file({filePath:'/tmp/qa_nested/sub/f.txt', content:'y'}); return r; }, r => r.ok && fs.existsSync('/tmp/qa_nested/sub/f.txt'));
await toolTest('open_application rejects unknown (Bug 4)', () => t.open_application({appName:'nonexistent-qa-xyz'}), r => !r.ok && r.error.includes('not found'));
await toolTest('take_screenshot', () => t.take_screenshot({}), r => r.ok || (r.error && r.error.includes('GNOME 50/Wayland screenshot blocked')));
await toolTest('click_mouse', () => t.click_mouse({x:1,y:1}), r => r.ok);
await toolTest('type_keyboard', () => t.type_keyboard({text:'', pressEnter:false}), r => r.ok);
await toolTest('navigate_url firefox', () => t.navigate_url({url:'about:blank', browser:'firefox'}), r => r.ok);

// ============================================================
// 6. TOOL PARSER
// ============================================================
console.log('\n=== 6. TOOL PARSER ===');
const parseTests = [
  ['valid exec_command', 'TOOL: exec_command {"command":"echo hi"}', r => r.length===1 && r[0].result],
  ['unknown tool → error', 'TOOL: noop {}', r => r.length===1 && r[0].error],
  ['invalid JSON → error', 'TOOL: exec_command {bad}', r => r.length===1 && r[0].error],
  ['no TOOL line → empty', 'just prose', r => r.length===0],
  ['multi-line JSON args', 'TOOL: write_file {"filePath":"/tmp/p","content":"a\nb"}', r => r.length===1 && r[0].result],
  ['TOOL in markdown fence', '```\nTOOL: exec_command {"command":"echo z"}\n```', r => r.length===1 && r[0].result],
];
for (const [name, text, check] of parseTests) {
  try { const r = await agenticTools.parseAndExecuteTools(text); log('parser', name, !!check(r)); }
  catch (e) { log('parser', name, false, e.message); }
}

// ============================================================
// 7. REGRESSION GUARDS (every bug we fixed this session)
// ============================================================
console.log('\n=== 7. REGRESSION GUARDS ===');
log('regress', 'originSessionId concurrency fix in server.js', serverSrc.includes('originSessionId'));
log('regress', 'empty-response guard present', serverSrc.includes('EMPTY_PROVIDER_RESPONSE'));
log('regress', 'junk-ack guard present', serverSrc.includes('JUNK_ACK_RESPONSE'));
log('regress', 'auto-continue provider-agnostic', !serverSrc.includes("provider === 'qwen' && verification.truncationReason"));
log('regress', '/preview session-aware (reads ?session=)', serverSrc.includes('req.query.session'));
log('regress', '/screenshot.png route exists', serverSrc.includes("app.get('/screenshot.png'"));
log('regress', 'BUILD_PROJECT handler exists', serverSrc.includes("msg.type === 'BUILD_PROJECT'"));
log('regress', 'draftModel threaded in BUILD_PROJECT', serverSrc.includes('draftModel = false'));
log('regress', 'quota detection in qwen_service', fs.readFileSync('./qwen_service.js','utf8').includes('quota exhausted'));
const orchSrc = fs.readFileSync('./orchestrator.js','utf8');
log('regress', 'Orchestrator role-based models', orchSrc.includes('PLANNER_MODEL') && orchSrc.includes('GENERATOR_MODEL'));
log('regress', 'Orchestrator draftModel option', orchSrc.includes('this.draftModel'));
const ollSrc = fs.readFileSync('./ollama_service.js','utf8');
log('regress', 'ollama draft_model forwarding', ollSrc.includes('draft_model'));
// Bug 3 check: the buggy '& ||' COMMAND construction must be gone. The literal
// string still appears in a comment explaining what NOT to do — check the code
// path instead (look for the launcher-ladder, not the old ternary).
const agSrc = fs.readFileSync('./agentic_tools.js','utf8');
log('regress', 'navigate_url launcher-ladder (Bug 3 fix)', agSrc.includes('const launchers =') && !agSrc.includes('google-chrome-stable \"${url}\" & ||'));

// ============================================================
// 8. PROJECT MODE (multi-file orchestrator)
// ============================================================
console.log('\n=== 8. PROJECT MODE (live, local-only) ===');
try {
  const { Orchestrator } = await import('./orchestrator.js');
  const sid = `qa_proj_${Date.now()}`;
  const orch = new Orchestrator({ workerModel: 'local', sessionId: sid, draftModel: false });
  const plan = await orch.plan('A 2-file PHP hello world: index.php and styles.css.');
  log('project', 'plan produces 2 files', plan.files.length === 2, `got ${plan.files.length}`);
  const result = await orch.generateAll(null);
  log('project', 'files written to disk', result.files.length === 2, `${result.files.length} files`);
  const idx = result.files.find(f => f.path.includes('index'));
  log('project', 'index file generated', !!idx);
  if (idx) {
    const content = fs.readFileSync(idx.absPath, 'utf8');
    log('project', 'index starts with <?php or <!DOCTYPE', content.startsWith('<?php') || content.startsWith('<!DOCTYPE'));
  }
  // cleanup
  fs.rmSync(orch.projectRoot, { recursive: true, force: true });
} catch (e) { log('project', 'orchestrator E2E', false, e.message); }

// ============================================================
// SUMMARY
// ============================================================
const cats = {};
for (const r of results) {
  if (!cats[r.cat]) cats[r.cat] = { pass: 0, total: 0 };
  cats[r.cat].total++;
  if (r.pass) cats[r.cat].pass++;
}
const totalPass = results.filter(r => r.pass).length;
console.log('\n========================================');
console.log('QA SUMMARY');
console.log('========================================');
for (const [cat, s] of Object.entries(cats)) {
  console.log(`  ${cat.padEnd(12)} : ${String(s.pass).padStart(2)}/${String(s.total).padStart(2)} ${s.pass===s.total?'✓':'⚠'}`);
}
console.log('----------------------------------------');
console.log(`  TOTAL         : ${totalPass}/${results.length} ${totalPass===results.length?'✓ ALL PASS':'✗ FAILURES'}`);
console.log('========================================');
if (totalPass < results.length) {
  console.log('\nFailures:');
  results.filter(r => !r.pass).forEach(r => console.log(`  [${r.cat}] ${r.name} :: ${r.detail}`));
}
process.exit(totalPass === results.length ? 0 : 1);
