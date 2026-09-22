'use strict';
/**
 * 真实链路验证：证明「真实意图 → 真实后端函数 → 数据真实变化并持久化 → 界面真实联动 → 刷新后保留」
 * 用法：先 npm start，再 node scripts/verify-real-chain.js
 *
 * 验证点：
 *  1) 基线数据来自后端实时接口（不是前端写死）
 *  2) 一轮对话后，审计日志与对话记录条数真实增长
 *  3) 数据确实写进了磁盘文件（用独立进程读取，排除"只在内存里"）
 *  4) 模拟"刷新页面"（重新拉 /api/state），状态与对话记录仍在
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'runtime-state.json');

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  ✅ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' — ' + extra : ''}`); }
};
const section = (t) => console.log(`\n【${t}】`);

async function getState() {
  const r = await fetch(BASE + '/api/state');
  return r.json();
}
async function chat(message) {
  const r = await fetch(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '', events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data:'));
      if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { } }
    }
  }
  return events;
}
/** 独立进程读磁盘文件，证明数据真的落盘（而不是只活在服务内存里） */
function readDiskState() {
  const code = 'process.stdout.write(JSON.stringify(require(process.argv[1])))';
  const out = execFileSync(process.execPath, ['-e', code, STATE_FILE], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out;
}

(async () => {
  console.log('真实链路 & 持久化验证');
  console.log('='.repeat(56));

  section('1. 基线数据来自后端实时接口');
  const s0 = await getState();
  ok(typeof s0.totals.totalAssets === 'number' && s0.totals.totalAssets > 0, '账户资产来自接口', `¥${s0.totals.totalAssets}`);
  ok(s0.billStats && s0.billStats.txnCount === s0.totals.txnCount, '账单统计由后端对真实流水现算', `${s0.billStats.txnCount} 笔 / ${s0.billStats.months} 个月 / 异常 ${s0.billStats.anomalyCount} 笔`);
  ok(Array.isArray(s0.products) && s0.products.length === 6, '理财产品列表来自后端数据', `${s0.products.length} 款`);
  ok(Array.isArray(s0.subscriptions) && s0.subscriptions.length === 4, '订阅列表来自后端数据', `${s0.subscriptions.length} 个`);
  ok(Array.isArray(s0.payees) && s0.payees.length === 5, '常用收款人来自后端数据', `${s0.payees.length} 人`);
  const sumOut = s0.billStats.byCategory.reduce((a, c) => a + c.amount, 0);
  ok(Math.abs(sumOut - s0.billStats.totalOut) < 1, '分类金额合计 = 总支出（现算校验通过）', `${sumOut.toFixed(2)} ≈ ${s0.billStats.totalOut}`);

  const audit0 = s0.auditTail ? (await (await fetch(BASE + '/api/audit')).json()).log.length : 0;
  const conv0 = (s0.conversation || []).length;
  console.log(`  · 基线：审计 ${audit0} 条 / 对话记录 ${conv0} 条`);

  section('2. 一轮真实对话 → 数据真实变化');
  const events = await chat('储蓄卡还有多少钱');
  const steps = events.filter((e) => e.type === 'step');
  const answer = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  ok(steps.some((e) => e.kind === 'tool_call' && e.meta && e.meta.tool === 'query_balance'), '真的调用了后端工具 query_balance');
  const digits = (x) => String(x).replace(/[^\d]/g, '');
  ok(digits(answer).includes(digits(s0.totals.totalAssets)), '回答里的余额数字与后端数据一致（非写死）', (answer.match(/¥[\d,\.]+/) || [])[0] || '');
  const uiEvt = events.find((e) => e.type === 'ui');
  ok(Boolean(uiEvt), '产生了界面联动指令', uiEvt ? JSON.stringify(uiEvt.patch).slice(0, 60) : '');

  const s1 = await getState();
  const audit1 = (await (await fetch(BASE + '/api/audit')).json()).log.length;
  const conv1 = (s1.conversation || []).length;
  ok(audit1 > audit0, `审计日志条数真实增长（${audit0} → ${audit1}）`);
  ok(conv1 >= conv0 + 2, `对话记录真实增长（${conv0} → ${conv1}，含用户与 Agent 各一条）`);
  ok(s1.auditTail[0] && s1.auditTail[0].action === 'query_balance', '最新审计记录即为本次操作', s1.auditTail[0] ? s1.auditTail[0].id + ' ' + s1.auditTail[0].action : '');

  section('3. 数据确实落盘（独立进程读取文件）');
  ok(fs.existsSync(STATE_FILE), '状态文件存在', path.relative(ROOT, STATE_FILE));
  await new Promise((r) => setTimeout(r, 350)); // 等一下落盘防抖窗口（默认仅 250ms）
  const disk = readDiskState();
  ok(disk.includes('"auditLog"'), '磁盘文件含完整审计日志字段');
  const diskObj = JSON.parse(disk);
  ok(diskObj.auditLog.length >= audit1 - 1, `磁盘审计条数 ${diskObj.auditLog.length} 与接口一致（±1 为防抖窗口）`);
  ok(diskObj.conversation && diskObj.conversation.length >= conv1 - 1, `磁盘对话记录 ${diskObj.conversation ? diskObj.conversation.length : 0} 条（含本次对话）`);
  ok(diskObj.transactions.length === s1.billStats.txnCount, '磁盘账单条数与接口一致', `${diskObj.transactions.length} 笔`);

  section('4. 模拟刷新页面 → 状态保留');
  const s2 = await getState(); // 等价于浏览器里按 F5 后重新拉数据
  ok(s2.totals.totalAssets === s1.totals.totalAssets, '资产数据刷新后一致');
  ok((s2.conversation || []).length === conv1, '对话记录刷新后保留（前端会重建气泡）');
  ok(s2.billStats.anomalyCount === s1.billStats.anomalyCount, '账单异常识别结果刷新后一致');

  console.log('\n' + '='.repeat(56));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  console.log(`RESULT pass=${pass} fail=${fail}`);
  console.log('提示：服务重启后再执行一次本脚本的第 3、4 节，可验证跨进程重启的持久化。');
  console.log('='.repeat(56));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('验证异常：', e); process.exit(2); });
